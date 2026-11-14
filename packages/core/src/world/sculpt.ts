import type { MeshData } from "../schema";
import { falloff, type Falloff } from "./edit";
import type { V3 } from "./math";

/**
 * SCULPTING — Blender's sculpt mode as data: a brush DAB moves the vertices of
 * a mesh within a radius of a point, weighted by a falloff curve, and a stroke
 * is dabs laid along the pen's path.
 *
 * Headless on purpose. The viewport turns the pen into dab centres (a ray on
 * the live surface) and a radius (screen px at that depth); everything about
 * what a dab DOES lives here, so the viewport, an agent's `world.sculpt` and a
 * test all move the same vertices. Every coordinate is the object's own space:
 * a scaled object is sculpted as it is stored, and the brush is sized by the
 * caller in that space.
 *
 * Topology never changes — a stroke rewrites `positions` and nothing else, so
 * faces, parts, marks and the unwrap all stay valid, and a stroke is ONE undo
 * step written through the mesh's one writer (`setMeshData`).
 */

export const SCULPT_BRUSHES = [
  { id: "draw", label: "Draw", detail: "Raise the surface" },
  { id: "clay", label: "Clay", detail: "Build up in flat layers" },
  { id: "inflate", label: "Inflate", detail: "Swell along the surface" },
  { id: "crease", label: "Crease", detail: "Cut a sharp fold" },
  { id: "smooth", label: "Smooth", detail: "Relax bumps — or hold ⇧ with any brush" },
  { id: "flatten", label: "Flatten", detail: "Press toward the average plane" },
  { id: "pinch", label: "Pinch", detail: "Pull the surface together" },
  { id: "grab", label: "Grab", detail: "Drag a region of the surface" },
] as const satisfies ReadonlyArray<{ id: string; label: string; detail: string }>;
export type SculptBrush = (typeof SCULPT_BRUSHES)[number]["id"];

export function isSculptBrush(id: string): id is SculptBrush {
  return SCULPT_BRUSHES.some((b) => b.id === id);
}

/**
 * Dabs every this fraction of the radius along the stroke. Close enough that a
 * fast stroke is a ridge and not a row of dents; far enough that a slow one
 * does not pile a hundred dabs onto one spot.
 */
export const SCULPT_SPACING = 0.12;

export interface SculptStroke {
  brush: SculptBrush;
  /** Brush size in the object's own units. */
  radius: number;
  /** 0..1, pressure already folded in by the caller. */
  strength: number;
  /** 1 adds (raises, inflates, pinches), −1 subtracts (Ctrl in the viewport). */
  direction?: 1 | -1;
  falloff?: Falloff;
  /** Mirror every dab across the object's X / Y / Z planes. */
  symmetry?: readonly [boolean, boolean, boolean];
  /**
   * The view direction INTO the screen, object space. Given, vertices whose
   * normal faces away from the eye are left alone — the far side of a thin
   * shape under a big brush (Blender's Front Faces Only).
   */
  view?: V3 | null;
}

interface Mirror {
  flip: V3;
}

/** The mirror copies a symmetry asks for: identity first, then every combination of the enabled axes. */
function mirrorsOf(sym: readonly [boolean, boolean, boolean] | undefined): Mirror[] {
  const out: Mirror[] = [];
  const axes = [0, 1, 2].filter((a) => sym?.[a]);
  for (let mask = 0; mask < 1 << axes.length; mask++) {
    const flip: V3 = [1, 1, 1];
    axes.forEach((a, i) => {
      if (mask & (1 << i)) flip[a] = -1;
    });
    out.push({ flip });
  }
  return out;
}

const mirrored = (v: V3, m: Mirror): V3 => [v[0] * m.flip[0], v[1] * m.flip[1], v[2] * m.flip[2]];

/**
 * One sculpting session on one mesh — the working copy a stroke edits, with
 * the derived data dabs need (normals, neighbours) kept beside it so a dab
 * costs the vertices it touches plus one pass to find them.
 */
export class SculptSession {
  readonly positions: Float64Array;
  private readonly faces: readonly (readonly number[])[];
  private readonly normals: Float64Array;
  private vertFaces: number[][] | null = null;
  private neighbours: number[][] | null = null;
  private grabbing: { mirrors: Array<{ m: Mirror; idx: number[]; w: number[]; start: number[] }> } | null = null;

  constructor(private readonly source: MeshData) {
    this.positions = Float64Array.from(source.positions);
    this.faces = source.faces;
    this.normals = new Float64Array(this.positions.length);
    this.refreshNormals(null);
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  /** The mesh as it stands now — same faces, parts and unwrap; new positions. */
  mesh(): MeshData {
    return { ...this.source, positions: Array.from(this.positions) };
  }

  /** The vertex normal (area-weighted, unit) — what Inflate pushes along. */
  normalAt(i: number): V3 {
    return [this.normals[i * 3]!, this.normals[i * 3 + 1]!, this.normals[i * 3 + 2]!];
  }

  /**
   * One dab at `center`. Returns how many vertices moved (0: the brush touched
   * nothing — the pen is off the shape, or every vertex there faces away).
   */
  dab(center: V3, s: SculptStroke): number {
    if (s.brush === "grab") return 0;
    const dir = s.direction ?? 1;
    const kind = s.falloff ?? "smooth";
    let moved = 0;
    const touched = new Set<number>();
    for (const m of mirrorsOf(s.symmetry)) {
      const c = mirrored(center, m);
      const view = s.view ? mirrored(s.view, m) : null;
      const hits = this.within(c, s.radius, view);
      if (!hits.idx.length) continue;
      const w = hits.t.map((t) => falloff(kind, t) * s.strength);
      this.apply(s.brush, c, s.radius, dir, hits.idx, w);
      for (const i of hits.idx) touched.add(i);
      moved += hits.idx.length;
    }
    if (touched.size) this.refreshNormals(touched);
    return moved;
  }

  /** Grab: take hold of what is under the brush now (its weights are fixed for the stroke). */
  beginGrab(center: V3, s: SculptStroke): number {
    const kind = s.falloff ?? "smooth";
    const mirrors = mirrorsOf(s.symmetry).map((m) => {
      const hits = this.within(mirrored(center, m), s.radius, s.view ? mirrored(s.view, m) : null);
      return {
        m,
        idx: hits.idx,
        w: hits.t.map((t) => falloff(kind, t) * Math.max(0, Math.min(1, s.strength))),
        start: hits.idx.flatMap((i) => [this.positions[i * 3]!, this.positions[i * 3 + 1]!, this.positions[i * 3 + 2]!]),
      };
    });
    this.grabbing = { mirrors };
    return mirrors.reduce((n, g) => n + g.idx.length, 0);
  }

  /** Grab: the held region follows the pen by `delta` — the TOTAL move since the grab began, never a step. */
  moveGrab(delta: V3): void {
    const g = this.grabbing;
    if (!g) return;
    const touched = new Set<number>();
    for (const { m, idx, w, start } of g.mirrors) {
      const d = mirrored(delta, m);
      idx.forEach((i, k) => {
        this.positions[i * 3] = start[k * 3]! + d[0] * w[k]!;
        this.positions[i * 3 + 1] = start[k * 3 + 1]! + d[1] * w[k]!;
        this.positions[i * 3 + 2] = start[k * 3 + 2]! + d[2] * w[k]!;
        touched.add(i);
      });
    }
    if (touched.size) this.refreshNormals(touched);
  }

  endGrab(): void {
    this.grabbing = null;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Vertices within `r` of `c` (and facing the eye, when a view is given), with t = 1 at the centre, 0 at the rim. */
  private within(c: V3, r: number, view: V3 | null): { idx: number[]; t: number[] } {
    const idx: number[] = [];
    const t: number[] = [];
    if (!(r > 0)) return { idx, t };
    const p = this.positions;
    const r2 = r * r;
    for (let i = 0; i < p.length; i += 3) {
      const dx = p[i]! - c[0], dy = p[i + 1]! - c[1], dz = p[i + 2]! - c[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      if (view) {
        const n = this.normals;
        if (n[i]! * view[0] + n[i + 1]! * view[1] + n[i + 2]! * view[2] > 0.05) continue;
      }
      idx.push(i / 3);
      t.push(1 - Math.sqrt(d2) / r);
    }
    return { idx, t };
  }

  private apply(brush: Exclude<SculptBrush, "grab">, c: V3, r: number, dir: 1 | -1, idx: number[], w: number[]): void {
    const p = this.positions;
    // The AREA under the brush: its weighted normal and centre, which the
    // planar brushes (draw, clay, flatten, crease) move against.
    const N: V3 = [0, 0, 0];
    const C: V3 = [0, 0, 0];
    let ws = 0;
    idx.forEach((i, k) => {
      const wk = Math.max(1e-6, w[k]!);
      N[0] += this.normals[i * 3]! * wk;
      N[1] += this.normals[i * 3 + 1]! * wk;
      N[2] += this.normals[i * 3 + 2]! * wk;
      C[0] += p[i * 3]! * wk;
      C[1] += p[i * 3 + 1]! * wk;
      C[2] += p[i * 3 + 2]! * wk;
      ws += wk;
    });
    const nl = Math.hypot(N[0], N[1], N[2]);
    if (nl < 1e-9 || ws <= 0) return;
    N[0] /= nl, N[1] /= nl, N[2] /= nl;
    C[0] /= ws, C[1] /= ws, C[2] /= ws;
    const move = (i: number, x: number, y: number, z: number) => {
      p[i * 3] = p[i * 3]! + x;
      p[i * 3 + 1] = p[i * 3 + 1]! + y;
      p[i * 3 + 2] = p[i * 3 + 2]! + z;
    };
    switch (brush) {
      case "draw": {
        const k = 0.06 * r * dir;
        idx.forEach((i, j) => move(i, N[0] * k * w[j]!, N[1] * k * w[j]!, N[2] * k * w[j]!));
        return;
      }
      case "inflate": {
        const k = 0.04 * r * dir;
        idx.forEach((i, j) => move(i, this.normals[i * 3]! * k * w[j]!, this.normals[i * 3 + 1]! * k * w[j]!, this.normals[i * 3 + 2]! * k * w[j]!));
        return;
      }
      case "clay": {
        // A plane a little above the area (below, subtracting); what is under
        // it rises toward it — layers that build up flat, not bumps.
        const lift = 0.12 * r * dir * Math.min(1, Math.max(...w));
        const T: V3 = [C[0] + N[0] * lift, C[1] + N[1] * lift, C[2] + N[2] * lift];
        idx.forEach((i, j) => {
          const d = (p[i * 3]! - T[0]) * N[0] + (p[i * 3 + 1]! - T[1]) * N[1] + (p[i * 3 + 2]! - T[2]) * N[2];
          if (d * dir >= 0) return;
          const k = -d * 0.5 * w[j]!;
          move(i, N[0] * k, N[1] * k, N[2] * k);
        });
        return;
      }
      case "flatten": {
        // Toward the area's own plane; subtracting pushes away from it (contrast).
        idx.forEach((i, j) => {
          const d = (p[i * 3]! - C[0]) * N[0] + (p[i * 3 + 1]! - C[1]) * N[1] + (p[i * 3 + 2]! - C[2]) * N[2];
          const k = -d * 0.5 * w[j]! * dir;
          move(i, N[0] * k, N[1] * k, N[2] * k);
        });
        return;
      }
      case "pinch":
      case "crease": {
        // Pinch: pull along the surface toward the centre (the normal part of
        // the pull removed, so it gathers rather than sinks). Crease adds a
        // sharp carve under it — subtracting by default, as Blender's does.
        const pull = brush === "pinch" ? 0.15 * dir : 0.12;
        const carve = brush === "crease" ? -0.05 * r * dir : 0;
        idx.forEach((i, j) => {
          const wj = w[j]!;
          const tx = c[0] - p[i * 3]!, ty = c[1] - p[i * 3 + 1]!, tz = c[2] - p[i * 3 + 2]!;
          const along = tx * N[0] + ty * N[1] + tz * N[2];
          const sx = tx - N[0] * along, sy = ty - N[1] * along, sz = tz - N[2] * along;
          const sharp = brush === "crease" ? wj * wj : wj;
          move(i, sx * pull * wj + N[0] * carve * sharp, sy * pull * wj + N[1] * carve * sharp, sz * pull * wj + N[2] * carve * sharp);
        });
        return;
      }
      case "smooth": {
        // Laplacian, Jacobi-style: every vertex moves toward where its
        // neighbours were BEFORE this dab, so the result does not depend on
        // the order vertices happen to be stored in.
        const nb = this.neighbourList();
        const targets = idx.map((i) => {
          const list = nb[i]!;
          if (!list.length) return null;
          let x = 0, y = 0, z = 0;
          for (const n of list) (x += p[n * 3]!), (y += p[n * 3 + 1]!), (z += p[n * 3 + 2]!);
          return [x / list.length, y / list.length, z / list.length] as V3;
        });
        idx.forEach((i, j) => {
          const t = targets[j];
          if (!t) return;
          const k = Math.min(1, w[j]!);
          move(i, (t[0] - p[i * 3]!) * k, (t[1] - p[i * 3 + 1]!) * k, (t[2] - p[i * 3 + 2]!) * k);
        });
        return;
      }
    }
  }

  private faceList(): number[][] {
    if (this.vertFaces) return this.vertFaces;
    const vf: number[][] = Array.from({ length: this.vertexCount }, () => []);
    this.faces.forEach((f, fi) => {
      for (const v of f) vf[v]?.push(fi);
    });
    return (this.vertFaces = vf);
  }

  private neighbourList(): number[][] {
    if (this.neighbours) return this.neighbours;
    const sets: Array<Set<number>> = Array.from({ length: this.vertexCount }, () => new Set());
    for (const f of this.faces) {
      for (let k = 0; k < f.length; k++) {
        const a = f[k]!, b = f[(k + 1) % f.length]!;
        sets[a]?.add(b);
        sets[b]?.add(a);
      }
    }
    for (let i = 0; i + 1 < (this.source.lines?.length ?? 0); i += 2) {
      const a = this.source.lines![i]!, b = this.source.lines![i + 1]!;
      sets[a]?.add(b);
      sets[b]?.add(a);
    }
    return (this.neighbours = sets.map((s) => [...s]));
  }

  /**
   * Vertex normals, area-weighted (Newell per face), for every vertex — or,
   * after a dab, only for the faces around what moved and their vertices.
   */
  private refreshNormals(touched: ReadonlySet<number> | null): void {
    const p = this.positions;
    const n = this.normals;
    let faces: Iterable<number>;
    let verts: Iterable<number>;
    if (touched) {
      const vf = this.faceList();
      const fs = new Set<number>();
      for (const v of touched) for (const f of vf[v] ?? []) fs.add(f);
      const vs = new Set<number>();
      for (const f of fs) for (const v of this.faces[f]!) vs.add(v);
      faces = fs;
      verts = vs;
    } else {
      faces = this.faces.keys();
      verts = Array.from({ length: this.vertexCount }, (_, i) => i);
    }
    const fn = new Map<number, V3>();
    for (const fi of faces) {
      const f = this.faces[fi]!;
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < f.length; k++) {
        const a = f[k]! * 3, b = f[(k + 1) % f.length]! * 3;
        x += (p[a + 1]! - p[b + 1]!) * (p[a + 2]! + p[b + 2]!);
        y += (p[a + 2]! - p[b + 2]!) * (p[a]! + p[b]!);
        z += (p[a]! - p[b]!) * (p[a + 1]! + p[b + 1]!);
      }
      fn.set(fi, [x, y, z]);
    }
    const vf = touched ? this.faceList() : null;
    const sums = new Map<number, V3>();
    if (!vf) {
      for (const [fi, v] of fn) {
        for (const vi of this.faces[fi]!) {
          const s = sums.get(vi) ?? [0, 0, 0];
          s[0] += v[0], s[1] += v[1], s[2] += v[2];
          sums.set(vi, s);
        }
      }
    }
    for (const vi of verts) {
      let s: V3 = [0, 0, 0];
      if (vf) {
        for (const fi of vf[vi] ?? []) {
          const v = fn.get(fi) ?? this.faceNormalRaw(fi);
          s[0] += v[0], s[1] += v[1], s[2] += v[2];
        }
      } else s = sums.get(vi) ?? s;
      const l = Math.hypot(s[0], s[1], s[2]) || 1;
      n[vi * 3] = s[0] / l;
      n[vi * 3 + 1] = s[1] / l;
      n[vi * 3 + 2] = s[2] / l;
    }
  }

  private faceNormalRaw(fi: number): V3 {
    const p = this.positions;
    const f = this.faces[fi]!;
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < f.length; k++) {
      const a = f[k]! * 3, b = f[(k + 1) % f.length]! * 3;
      x += (p[a + 1]! - p[b + 1]!) * (p[a + 2]! + p[b + 2]!);
      y += (p[a + 2]! - p[b + 2]!) * (p[a]! + p[b]!);
      z += (p[a]! - p[b]!) * (p[a + 1]! + p[b + 1]!);
    }
    return [x, y, z];
  }
}

/**
 * Dab centres along a segment of the stroke, `spacing` apart, carrying the
 * leftover distance between calls so the rhythm survives uneven pointer
 * events. Works in whatever space it is given (the viewport uses screen px).
 */
export function dabsAlong(from: { x: number; y: number }, to: { x: number; y: number }, spacing: number, carry: number): { points: Array<{ x: number; y: number }>; carry: number } {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const step = Math.max(0.5, spacing);
  const points: Array<{ x: number; y: number }> = [];
  let d = step - carry;
  while (d <= len) {
    const t = len > 0 ? d / len : 0;
    points.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    d += step;
  }
  return { points, carry: len - (d - step) };
}

// ── Drawings ────────────────────────────────────────────────────────────────
//
// A stroke drawn in space is a path, not a surface — and EVERY brush means
// something for a line, so every brush reaches it (grease pencil's sculpt
// set, read through our brushes' names):
//
//   grab      drag the points under the brush (in 3D, with the view)
//   smooth    relax kinks: each point toward its neighbours' midpoint
//   pinch     gather points toward the brush centre   (⌃ spreads them)
//   crease    a stronger pinch, for a tight gather
//   inflate   spread points away from the centre      (⌃ gathers)
//   draw      LIFT the line toward you, off its page  (⌃ pushes it away)
//   clay      a gentler lift, built up stroke by stroke
//   flatten   press the line's depth back onto its page
//
// They work in the layer's own coordinates, DEPTH INCLUDED (a point's `z` and
// its handles' `z`): a 3D stroke is sculpted in 3D and never flattened by
// the act of sculpting it. The viewport weighs each point by where it sits
// on SCREEN under the brush, so a line is sculpted as you see it.

export const PATH_SCULPT_BRUSHES = SCULPT_BRUSHES.map((b) => b.id);
export type PathSculptBrush = SculptBrush;

/** Every brush sculpts lines — kept as a question so a brush that cannot still has one place to say so. */
export function sculptsPaths(b: SculptBrush): b is PathSculptBrush {
  return (PATH_SCULPT_BRUSHES as readonly string[]).includes(b);
}

type Pt = { x: number; y: number; z?: number };
type PathPointLike = Pt & { hIn: Pt | null; hOut: Pt | null };
type ContourLike<P extends PathPointLike> = { closed: boolean; points: P[] };

/** A depth written only where there is some — a flat line stays a flat line. */
const depth = (z: number) => (Math.abs(z) > 1e-6 ? z : undefined);

const shift = <P extends PathPointLike>(p: P, dx: number, dy: number, dz = 0): P => {
  const out: P = {
    ...p,
    x: p.x + dx,
    y: p.y + dy,
    hIn: p.hIn && { ...p.hIn, x: p.hIn.x + dx, y: p.hIn.y + dy, ...(p.hIn.z === undefined ? {} : { z: p.hIn.z + dz }) },
    hOut: p.hOut && { ...p.hOut, x: p.hOut.x + dx, y: p.hOut.y + dy, ...(p.hOut.z === undefined ? {} : { z: p.hOut.z + dz }) },
  };
  if (dz !== 0 || p.z !== undefined) {
    const z = depth((p.z ?? 0) + dz);
    if (z === undefined) delete out.z;
    else out.z = z;
  }
  return out;
};

export interface PathSculptOptions {
  /** The brush's reach in layer units (how far a full-strength lift moves a point). */
  radius: number;
  /** Toward the eye, in layer coordinates (x, y, depth) — what Draw and Clay lift along. */
  toward?: Pt;
}

/**
 * One dab of a brush (all but Grab) on a drawing's points. `weight(c, i)` is
 * the brush's weight on point i of contour c (0 = untouched); handles travel
 * with their anchor, so a curve keeps its shape where it moves.
 */
export function sculptContours<P extends PathPointLike, C extends ContourLike<P>>(
  contours: readonly C[],
  brush: Exclude<SculptBrush, "grab">,
  center: Pt,
  weight: (c: number, i: number) => number,
  direction: 1 | -1 = 1,
  opts: PathSculptOptions = { radius: 0 },
): C[] {
  const cz = center.z ?? 0;
  return contours.map((c, ci) => {
    const pts = c.points;
    const n = pts.length;
    return {
      ...c,
      points: pts.map((p, i) => {
        const w = weight(ci, i);
        if (!(w > 0)) return p;
        const pz = p.z ?? 0;
        switch (brush) {
          case "pinch":
          case "crease":
          case "inflate": {
            // Toward the centre (Pinch, Crease) or away from it (Inflate); ⌃ flips.
            const k = (brush === "crease" ? 0.3 : 0.15) * w * direction * (brush === "inflate" ? -1 : 1);
            return shift(p, (center.x - p.x) * k, (center.y - p.y) * k, center.z === undefined ? 0 : (cz - pz) * k);
          }
          case "draw":
          case "clay": {
            const t = opts.toward;
            if (!t || !(opts.radius > 0)) return p;
            const k = opts.radius * (brush === "clay" ? 0.04 : 0.1) * w * direction;
            return shift(p, t.x * k, t.y * k, (t.z ?? 0) * k);
          }
          case "flatten":
            // Back onto the page: depth toward zero, nothing else.
            return p.z === undefined ? p : shift(p, 0, 0, -pz * Math.min(1, w) * 0.5);
          case "smooth": {
            // Toward the midpoint of its neighbours, in 3D; an open line's ends hold.
            const prev = i > 0 ? pts[i - 1] : c.closed ? pts[n - 1] : undefined;
            const next = i < n - 1 ? pts[i + 1] : c.closed ? pts[0] : undefined;
            if (!prev || !next) return p;
            const k = Math.min(1, w) * 0.5;
            const mz = ((prev.z ?? 0) + (next.z ?? 0)) / 2;
            return shift(p, ((prev.x + next.x) / 2 - p.x) * k, ((prev.y + next.y) / 2 - p.y) * k, (mz - pz) * k);
          }
        }
      }),
    };
  });
}

/** Grab: every held point moves by its weight times the TOTAL move since the grab began (depth included). */
export function grabContours<P extends PathPointLike, C extends ContourLike<P>>(start: readonly C[], weights: readonly (readonly number[])[], delta: Pt): C[] {
  return start.map((c, ci) => ({ ...c, points: c.points.map((p, i) => {
    const w = weights[ci]?.[i] ?? 0;
    return w > 0 ? shift(p, delta.x * w, delta.y * w, (delta.z ?? 0) * w) : p;
  }) }));
}
