import type { MeshData } from "../schema/world";
import {
  cloneMesh,
  flipFaces,
  compactMesh,
  edgeKey,
  faceCenter,
  faceNormal,
  meshEdges,
  remapFaces,
  vertexAt,
  vertexCount,
} from "./mesh";
import { add, cross, dot, normalize3, scale3, sub, transformPoint, type Mat4, type V3 } from "./math";

/**
 * EDIT MODE — the polygon operations behind Blender's edit-mode keys, as pure
 * functions `(mesh, selection) → (mesh, selection)`.
 *
 * Pure for the reason every core op is: the viewport, the API and the tests
 * call the same function, and an op that returns a NEW mesh can be committed
 * as one wholesale replacement (one undo patch) instead of thousands of
 * element writes. Every op that deletes runs through `compactMesh`, so an
 * orphaned vertex can never linger invisible and unclickable.
 */

export type ElementMode = "vertex" | "edge" | "face";

export interface MeshSelection {
  mode: ElementMode;
  verts: number[];
  /** Edges as `edgeKey(a, b)` strings. */
  edges: string[];
  faces: number[];
}

export const EMPTY_SELECTION: MeshSelection = { mode: "vertex", verts: [], edges: [], faces: [] };

export interface EditResult {
  mesh: MeshData;
  selection: MeshSelection;
}

const parseEdge = (k: string): [number, number] => {
  const [a, b] = k.split("_");
  return [Number(a), Number(b)];
};

/** Every vertex the selection touches, whatever the mode. */
export function selectedVerts(mesh: MeshData, sel: MeshSelection): Set<number> {
  const out = new Set<number>();
  if (sel.mode === "vertex") for (const v of sel.verts) out.add(v);
  else if (sel.mode === "edge") for (const e of sel.edges) parseEdge(e).forEach((v) => out.add(v));
  else for (const f of sel.faces) for (const v of mesh.faces[f] ?? []) out.add(v);
  return out;
}

/** Faces whose every vertex is selected (the "region" an extrude or delete acts on). */
export function selectedFaces(mesh: MeshData, sel: MeshSelection): Set<number> {
  if (sel.mode === "face") return new Set(sel.faces.filter((f) => f < mesh.faces.length));
  const vs = selectedVerts(mesh, sel);
  const out = new Set<number>();
  mesh.faces.forEach((f, i) => {
    if (f.length && f.every((v) => vs.has(v))) out.add(i);
  });
  return out;
}

/** Edges whose both ends are selected. */
export function selectedEdges(mesh: MeshData, sel: MeshSelection): Set<string> {
  if (sel.mode === "edge") return new Set(sel.edges);
  const vs = selectedVerts(mesh, sel);
  const out = new Set<string>();
  for (const e of meshEdges(mesh).list) if (vs.has(e.a) && vs.has(e.b)) out.add(edgeKey(e.a, e.b));
  return out;
}

/** Re-express a selection in another element mode (pressing 1/2/3). */
/**
 * The selection with everything the mesh no longer has dropped — after an
 * undo, a redo or an agent's edit swapped the polygons under it. The same
 * object back when nothing was stale, so a store subscriber can compare.
 */
export function validSelection(mesh: MeshData, sel: MeshSelection): MeshSelection {
  const nv = vertexCount(mesh);
  const nf = mesh.faces.length;
  const edges = meshEdges(mesh).byKey;
  const verts = sel.verts.filter((v) => v < nv);
  const faces = sel.faces.filter((f) => f < nf);
  const kept = sel.edges.filter((e) => edges.has(e));
  if (verts.length === sel.verts.length && faces.length === sel.faces.length && kept.length === sel.edges.length) return sel;
  return { mode: sel.mode, verts, edges: kept, faces };
}

export function convertSelection(mesh: MeshData, sel: MeshSelection, mode: ElementMode): MeshSelection {
  if (mode === sel.mode) return sel;
  const verts = [...selectedVerts(mesh, sel)];
  const base: MeshSelection = { mode: "vertex", verts, edges: [], faces: [] };
  if (mode === "vertex") return base;
  if (mode === "edge") return { mode, verts: [], edges: [...selectedEdges(mesh, base)], faces: [] };
  return { mode, verts: [], edges: [], faces: [...selectedFaces(mesh, base)] };
}

export function selectAll(mesh: MeshData, mode: ElementMode): MeshSelection {
  if (mode === "vertex") return { mode, verts: Array.from({ length: vertexCount(mesh) }, (_, i) => i), edges: [], faces: [] };
  if (mode === "edge") return { mode, verts: [], edges: meshEdges(mesh).list.map((e) => edgeKey(e.a, e.b)), faces: [] };
  return { mode, verts: [], edges: [], faces: mesh.faces.map((_, i) => i) };
}

export function invertSelection(mesh: MeshData, sel: MeshSelection): MeshSelection {
  const all = selectAll(mesh, sel.mode);
  if (sel.mode === "vertex") {
    const s = new Set(sel.verts);
    return { ...all, verts: all.verts.filter((v) => !s.has(v)) };
  }
  if (sel.mode === "edge") {
    const s = new Set(sel.edges);
    return { ...all, edges: all.edges.filter((e) => !s.has(e)) };
  }
  const s = new Set(sel.faces);
  return { ...all, faces: all.faces.filter((f) => !s.has(f)) };
}

/** The median of the selected vertices — Blender's default pivot. */
export function selectionMedian(mesh: MeshData, sel: MeshSelection): V3 | null {
  const vs = selectedVerts(mesh, sel);
  if (vs.size === 0) return null;
  let x = 0, y = 0, z = 0;
  for (const v of vs) {
    x += mesh.positions[v * 3]!;
    y += mesh.positions[v * 3 + 1]!;
    z += mesh.positions[v * 3 + 2]!;
  }
  return [x / vs.size, y / vs.size, z / vs.size];
}

/** Average normal of the selection (faces, else faces around the verts) — the extrude direction. */
export function selectionNormal(mesh: MeshData, sel: MeshSelection): V3 {
  let faces = selectedFaces(mesh, sel);
  if (faces.size === 0) {
    const vs = selectedVerts(mesh, sel);
    faces = new Set(mesh.faces.map((f, i) => (f.some((v) => vs.has(v)) ? i : -1)).filter((i) => i >= 0));
  }
  let n: V3 = [0, 0, 0];
  for (const f of faces) n = add(n, faceNormal(mesh, mesh.faces[f]!));
  const l = normalize3(n);
  return l[0] === 0 && l[1] === 0 && l[2] === 0 ? [0, 0, 1] : l;
}

/** Move selected vertices through a matrix (G/R/S already composed about the pivot). */
export function transformVerts(mesh: MeshData, verts: ReadonlySet<number>, m: Mat4): MeshData {
  const pos = mesh.positions.slice();
  for (const v of verts) {
    const p = transformPoint(m, [pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!]);
    pos[v * 3] = p[0];
    pos[v * 3 + 1] = p[1];
    pos[v * 3 + 2] = p[2];
  }
  return { ...mesh, positions: pos };
}

/** Same, with per-vertex weights (proportional editing): p' = lerp(p, M·p, w). */
export function transformVertsWeighted(mesh: MeshData, weights: ReadonlyMap<number, number>, m: Mat4): MeshData {
  const pos = mesh.positions.slice();
  for (const [v, w] of weights) {
    const p0: V3 = [pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!];
    const p = transformPoint(m, p0);
    pos[v * 3] = p0[0] + (p[0] - p0[0]) * w;
    pos[v * 3 + 1] = p0[1] + (p[1] - p0[1]) * w;
    pos[v * 3 + 2] = p0[2] + (p[2] - p0[2]) * w;
  }
  return { ...mesh, positions: pos };
}

export const FALLOFFS = ["smooth", "sphere", "root", "linear", "sharp", "constant"] as const;
export type Falloff = (typeof FALLOFFS)[number];

/** A falloff curve's weight: t = 1 at the selection, 0 at the radius (Blender's curves). */
export function falloff(kind: Falloff, t: number): number {
  switch (kind) {
    case "smooth": return t * t * (3 - 2 * t);
    case "sphere": return Math.sqrt(Math.max(0, 2 * t - t * t));
    case "root": return Math.sqrt(t);
    case "linear": return t;
    case "sharp": return t * t;
    case "constant": return 1;
  }
}

/**
 * PROPORTIONAL EDITING — Blender's O. The selection moves fully; every other
 * vertex within `radius` of it (measured in the space `m` puts the mesh in,
 * so a scaled object's falloff is the size you see) follows by the falloff
 * curve. `connected` limits it to the selection's own islands (Alt+O).
 */
export function proportionalWeights(
  mesh: MeshData,
  verts: ReadonlySet<number>,
  radius: number,
  opts: { falloff?: Falloff; matrix?: Mat4; connected?: boolean } = {},
): Map<number, number> {
  const weights = new Map<number, number>();
  for (const v of verts) weights.set(v, 1);
  if (!(radius > 0)) return weights;
  const n = vertexCount(mesh);
  const at = (i: number): V3 => (opts.matrix ? transformPoint(opts.matrix, vertexAt(mesh, i)) : vertexAt(mesh, i));
  const sel = [...verts].map(at);
  const pool = opts.connected ? linkedVerts(mesh, verts) : null;
  const kind = opts.falloff ?? "smooth";
  for (let i = 0; i < n; i++) {
    if (verts.has(i) || (pool && !pool.has(i))) continue;
    const p = at(i);
    let d = Infinity;
    for (const q of sel) d = Math.min(d, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    if (d >= radius) continue;
    const w = falloff(kind, 1 - d / radius);
    if (w > 1e-4) weights.set(i, w);
  }
  return weights;
}

/**
 * MIRROR — Blender's Ctrl+M: the selection flipped across a plane through
 * `pivot` (object space), perpendicular to `axis`. A mirror turns a surface
 * inside out, so the faces wholly inside the selection reverse their winding
 * and stay facing out.
 */
export function mirrorSelection(mesh: MeshData, sel: MeshSelection, axis: 0 | 1 | 2, pivot: V3): EditResult {
  const verts = selectedVerts(mesh, sel);
  const pos = mesh.positions.slice();
  for (const v of verts) pos[v * 3 + axis] = 2 * pivot[axis] - pos[v * 3 + axis]!;
  const inside = new Set<number>();
  mesh.faces.forEach((f, i) => {
    if (f.every((v) => verts.has(v))) inside.add(i);
  });
  return { mesh: flipFaces({ ...mesh, positions: pos }, inside), selection: sel };
}

/**
 * KNIFE — cut faces along a plane (Blender's Bisect; the viewport's knife is
 * the plane through the eye and a line you draw). Each face the plane crosses
 * is split in two along it; faces that only share a cut edge take the new
 * vertex into their loop, so nothing cracks. `faces` limits the cut (null =
 * every face). The new edges come back selected.
 */
export function bisect(mesh: MeshData, point: V3, normal: V3, faces: ReadonlySet<number> | null = null): EditResult {
  const n = normalize3(normal);
  const eps = 1e-6;
  const nv = vertexCount(mesh);
  const d = Array.from({ length: nv }, (_, i) => dot(sub(vertexAt(mesh, i), point), n));
  const positions = mesh.positions.slice();
  const cut = new Map<string, number>();
  const crossing = (a: number, b: number): number | null => {
    const da = d[a]!, db = d[b]!;
    if (!(da > eps && db < -eps) && !(da < -eps && db > eps)) return null;
    const key = edgeKey(a, b);
    let x = cut.get(key);
    if (x === undefined) {
      const t = da / (da - db);
      const pa = vertexAt(mesh, a), pb = vertexAt(mesh, b);
      positions.push(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t);
      x = positions.length / 3 - 1;
      cut.set(key, x);
    }
    return x;
  };
  // First pass: every crossing edge of every targeted face gets its vertex.
  mesh.faces.forEach((f, fi) => {
    if (faces && !faces.has(fi)) return;
    f.forEach((a, i) => crossing(a, f[(i + 1) % f.length]!));
  });
  const out: number[][] = [];
  const parts: string[] | undefined = mesh.faceParts ? [] : undefined;
  const newEdges: string[] = [];
  mesh.faces.forEach((f, fi) => {
    // The loop with every cut vertex on its edges threaded in.
    const loop: number[] = [];
    const isCut: boolean[] = [];
    f.forEach((a, i) => {
      loop.push(a);
      isCut.push(Math.abs(d[a]!) <= eps);
      const x = cut.get(edgeKey(a, f[(i + 1) % f.length]!));
      if (x !== undefined) {
        loop.push(x);
        isCut.push(true);
      }
    });
    const marks = loop.map((_, i) => i).filter((i) => isCut[i]);
    const targeted = !faces || faces.has(fi);
    if (targeted && marks.length === 2 && (marks[1]! - marks[0]! > 1 && !(marks[0] === 0 && marks[1] === loop.length - 1))) {
      const [i, j] = marks as [number, number];
      const a = loop.slice(i, j + 1);
      const b = [...loop.slice(j), ...loop.slice(0, i + 1)];
      for (const piece of [a, b]) {
        out.push(piece);
        parts?.push(mesh.faceParts?.[fi] ?? "");
      }
      newEdges.push(edgeKey(loop[i]!, loop[j]!));
    } else {
      out.push(loop);
      parts?.push(mesh.faceParts?.[fi] ?? "");
    }
  });
  const result: MeshData = { ...mesh, positions, faces: out, ...(parts && { faceParts: parts }) };
  return { mesh: result, selection: { mode: "edge", verts: [], edges: newEdges, faces: [] } };
}

// ── Extrude ──────────────────────────────────────────────────────────────────

/**
 * Extrude — Blender's E. A face region extrudes as a region (shared edges stay
 * shared, side walls only on the region's border); with no whole face
 * selected, the selected edges extrude into new faces. The result selects what
 * was created, at the same place: the caller then moves it (along the normal,
 * the way E immediately starts a grab).
 */
export function extrude(mesh: MeshData, sel: MeshSelection): EditResult {
  const faces = selectedFaces(mesh, sel);
  if (faces.size > 0) return extrudeRegion(mesh, faces, sel.mode);
  const edges = selectedEdges(mesh, sel);
  if (edges.size > 0) return extrudeEdges(mesh, edges, sel.mode);
  return { mesh, selection: sel };
}

function extrudeRegion(mesh: MeshData, region: Set<number>, mode: ElementMode): EditResult {
  const out = cloneMesh(mesh);
  const { list, byKey } = meshEdges(mesh);
  const dup = new Map<number, number>();
  const nv = (v: number): number => {
    let d = dup.get(v);
    if (d === undefined) {
      d = out.positions.length / 3;
      out.positions.push(...vertexAt(mesh, v));
      dup.set(v, d);
    }
    return d;
  };
  const sideFaces: number[][] = [];
  for (const fi of region) {
    const f = mesh.faces[fi]!;
    for (let i = 0; i < f.length; i++) {
      const a = f[i]!, b = f[(i + 1) % f.length]!;
      const e = list[byKey.get(edgeKey(a, b))!]!;
      // A border edge: no other face of the region shares it.
      const inner = e.faces.some((g) => g !== fi && region.has(g));
      if (!inner) sideFaces.push([a, b, nv(b), nv(a)]);
    }
    out.faces[fi] = f.map(nv);
  }
  const base = out.faces.length;
  out.faces.push(...sideFaces);
  if (out.faceParts) out.faceParts.push(...sideFaces.map(() => ""));
  // Faces of the region that ALSO existed only as the region (a single plane
  // extruded) leave nothing behind; a cap is only kept when the region is open.
  const newVerts = [...dup.values()];
  void base;
  return {
    mesh: out,
    selection:
      mode === "face"
        ? { mode, verts: [], edges: [], faces: [...region] }
        : mode === "edge"
          ? { mode, verts: [], edges: [...selectedEdges(out, { mode: "vertex", verts: newVerts, edges: [], faces: [] })], faces: [] }
          : { mode, verts: newVerts, edges: [], faces: [] },
  };
}

function extrudeEdges(mesh: MeshData, edges: Set<string>, mode: ElementMode): EditResult {
  const out = cloneMesh(mesh);
  const { list, byKey } = meshEdges(mesh);
  const dup = new Map<number, number>();
  const nv = (v: number): number => {
    let d = dup.get(v);
    if (d === undefined) {
      d = out.positions.length / 3;
      out.positions.push(...vertexAt(mesh, v));
      dup.set(v, d);
    }
    return d;
  };
  for (const k of edges) {
    const [a0, b0] = parseEdge(k);
    // Wind the new face opposite to the face already using the edge, so the
    // surface stays consistently oriented.
    const e = list[byKey.get(k) ?? -1];
    let a = a0, b = b0;
    if (e && e.faces.length) {
      const f = mesh.faces[e.faces[0]!]!;
      const i = f.indexOf(a0);
      if (f[(i + 1) % f.length] === b0) [a, b] = [b0, a0];
    }
    out.faces.push([a, b, nv(b), nv(a)]);
    if (out.faceParts) out.faceParts.push("");
  }
  const newVerts = [...dup.values()];
  return {
    mesh: out,
    selection:
      mode === "vertex"
        ? { mode, verts: newVerts, edges: [], faces: [] }
        : { mode: "edge", verts: [], edges: [...edges].map((k) => {
            const [a, b] = parseEdge(k);
            return edgeKey(dup.get(a)!, dup.get(b)!);
          }), faces: [] },
  };
}

// ── Inset ────────────────────────────────────────────────────────────────────

/**
 * Inset — Blender's I, per face: each selected face gets an inner copy
 * `thickness` in from its edges (and lifted `depth` along its normal), joined
 * to the old border by a ring of quads. The inner faces stay selected.
 */
export function insetFaces(mesh: MeshData, sel: MeshSelection, thickness: number, depth = 0): EditResult {
  const faces = selectedFaces(mesh, sel);
  if (!faces.size) return { mesh, selection: sel };
  const out = cloneMesh(mesh);
  const added: number[][] = [];
  const addedParts: string[] = [];
  for (const fi of faces) {
    const f = mesh.faces[fi]!;
    const n = faceNormal(mesh, f);
    const inner: number[] = [];
    for (let i = 0; i < f.length; i++) {
      const p = vertexAt(mesh, f[i]!);
      const prev = vertexAt(mesh, f[(i + f.length - 1) % f.length]!);
      const next = vertexAt(mesh, f[(i + 1) % f.length]!);
      // In-plane inward directions of the two edges meeting here.
      const d1 = normalize3(cross(n, normalize3(sub(p, prev))));
      const d2 = normalize3(cross(n, normalize3(sub(next, p))));
      const bis = normalize3(add(d1, d2));
      const s = Math.max(0.2, dot(bis, d1));
      const q = add(add(p, scale3(bis, thickness / s)), scale3(n, depth));
      inner.push(out.positions.length / 3);
      out.positions.push(...q);
    }
    for (let i = 0; i < f.length; i++) {
      const j = (i + 1) % f.length;
      added.push([f[i]!, f[j]!, inner[j]!, inner[i]!]);
      addedParts.push(mesh.faceParts?.[fi] ?? "");
    }
    out.faces[fi] = inner;
  }
  out.faces.push(...added);
  if (out.faceParts) out.faceParts.push(...addedParts);
  return { mesh: out, selection: { mode: "face", verts: [], edges: [], faces: [...faces] } };
}

// ── Delete / dissolve ────────────────────────────────────────────────────────

export type DeleteKind = "vertices" | "edges" | "faces" | "onlyFaces";

/** Blender's X menu. Vertices take their faces; edges take theirs; faces leave verts only if used elsewhere. */
export function deleteElements(mesh: MeshData, sel: MeshSelection, kind: DeleteKind): EditResult {
  let kill: (f: number[], i: number) => boolean;
  if (kind === "vertices") {
    const vs = selectedVerts(mesh, sel);
    kill = (f) => f.some((v) => vs.has(v));
  } else if (kind === "edges") {
    const es = selectedEdges(mesh, sel);
    kill = (f) => f.some((v, i) => es.has(edgeKey(v, f[(i + 1) % f.length]!)));
  } else {
    const fs = selectedFaces(mesh, sel);
    kill = (_f, i) => fs.has(i);
  }
  const faces: number[][] = [];
  const parts: string[] = [];
  mesh.faces.forEach((f, i) => {
    if (kill(f, i)) return;
    faces.push(f);
    parts.push(mesh.faceParts?.[i] ?? "");
  });
  const next: MeshData = { ...mesh, faces, ...(mesh.faceParts ? { faceParts: parts } : {}) };
  return { mesh: compactMesh(next), selection: { ...EMPTY_SELECTION, mode: sel.mode } };
}

/** Dissolve edges: the two faces either side of each selected edge become one. */
export function dissolveEdges(mesh: MeshData, sel: MeshSelection): EditResult {
  const es = selectedEdges(mesh, sel);
  let out = cloneMesh(mesh);
  for (const k of es) {
    const [a, b] = parseEdge(k);
    const owners = out.faces.map((f, i) => (f.includes(a) && f.includes(b) && adjacentIn(f, a, b) ? i : -1)).filter((i) => i >= 0);
    if (owners.length !== 2) continue;
    const [i, j] = owners as [number, number];
    const merged = mergeLoops(out.faces[i]!, out.faces[j]!, a, b);
    if (!merged) continue;
    out.faces[i] = merged;
    out.faces.splice(j, 1);
    if (out.faceParts) out.faceParts.splice(j, 1);
  }
  out = compactMesh(out);
  return { mesh: out, selection: { ...EMPTY_SELECTION, mode: sel.mode } };
}

function adjacentIn(f: number[], a: number, b: number): boolean {
  const i = f.indexOf(a);
  return f[(i + 1) % f.length] === b || f[(i + f.length - 1) % f.length] === b;
}

/** Join two loops sharing edge a–b into one loop without it. */
function mergeLoops(f: number[], g: number[], a: number, b: number): number[] | null {
  // Rotate f so it runs ... a → b at its end (f ends at a, wraps to b), i.e. start at b.
  const fi = f.indexOf(b);
  const fr = [...f.slice(fi), ...f.slice(0, fi)]; // starts at b
  if (fr[fr.length - 1] !== a) return null;
  const gi = g.indexOf(a);
  const gr = [...g.slice(gi), ...g.slice(0, gi)]; // starts at a
  if (gr[gr.length - 1] !== b) return null;
  // b … a  +  (a) … (b) without the shared ends
  const loop = [...fr, ...gr.slice(1, -1)];
  return new Set(loop).size === loop.length ? loop : null;
}

// ── Merge ────────────────────────────────────────────────────────────────────

export type MergeAt = "center" | "cursor" | "first" | "last";

/** Blender's M: collapse the selected vertices into one point. */
export function mergeVerts(mesh: MeshData, sel: MeshSelection, at: MergeAt, cursor: V3 = [0, 0, 0]): EditResult {
  const vs = [...selectedVerts(mesh, sel)];
  if (vs.length < 2) return { mesh, selection: sel };
  const order = sel.mode === "vertex" ? sel.verts : vs;
  const keep = at === "first" ? order[0]! : at === "last" ? order[order.length - 1]! : vs[0]!;
  let target: V3;
  if (at === "cursor") target = cursor;
  else if (at === "center") {
    target = [0, 0, 0];
    for (const v of vs) target = add(target, vertexAt(mesh, v));
    target = scale3(target, 1 / vs.length);
  } else target = vertexAt(mesh, keep);
  const map = Int32Array.from({ length: vertexCount(mesh) }, (_, i) => i);
  for (const v of vs) map[v] = keep;
  const moved = cloneMesh(mesh);
  moved.positions[keep * 3] = target[0];
  moved.positions[keep * 3 + 1] = target[1];
  moved.positions[keep * 3 + 2] = target[2];
  const remapped = remapFaces(moved, map);
  const compact = compactMesh(remapped, new Set([keep]));
  // Find the kept vertex's new index (compact renumbers by order).
  let idx = 0;
  const used = new Set<number>([keep]);
  for (const f of remapped.faces) for (const v of f) used.add(v);
  for (let i = 0; i < keep; i++) if (used.has(i)) idx++;
  return { mesh: compact, selection: { mode: "vertex", verts: [idx], edges: [], faces: [] } };
}

// ── Fill / subdivide / loop cut ──────────────────────────────────────────────

/**
 * Make a face from the selected vertices (F). Ordered around their centroid in
 * their best-fit plane, then wound to agree with any neighbouring face so the
 * surface stays consistently oriented.
 */
export function fillFace(mesh: MeshData, sel: MeshSelection): EditResult {
  const vs = [...selectedVerts(mesh, sel)];
  if (vs.length < 3) return { mesh, selection: sel };
  const pts = vs.map((v) => vertexAt(mesh, v));
  const c = scale3(pts.reduce((a, p) => add(a, p), [0, 0, 0] as V3), 1 / pts.length);
  // Best-fit normal: Newell over the angle-sorted loop (iterate once to settle).
  let n: V3 = [0, 0, 1];
  for (let pass = 0; pass < 2; pass++) {
    const u0 = Math.abs(n[2]) < 0.9 ? normalize3(cross(n, [0, 0, 1])) : normalize3(cross(n, [1, 0, 0]));
    const v0 = cross(n, u0);
    vs.sort((a, b) => {
      const pa = sub(vertexAt(mesh, a), c), pb = sub(vertexAt(mesh, b), c);
      return Math.atan2(dot(pa, v0), dot(pa, u0)) - Math.atan2(dot(pb, v0), dot(pb, u0));
    });
    const fn = faceNormal(mesh, vs);
    if (fn[0] || fn[1] || fn[2]) n = fn;
  }
  let loop = vs;
  // Agree with a neighbour sharing an edge: it must traverse that edge the other way.
  const { byKey, list } = meshEdges(mesh);
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
    const e = list[byKey.get(edgeKey(a, b)) ?? -1];
    if (!e || !e.faces.length) continue;
    const g = mesh.faces[e.faces[0]!]!;
    const j = g.indexOf(a);
    if (g[(j + 1) % g.length] === b) loop = loop.slice().reverse();
    break;
  }
  const out = cloneMesh(mesh);
  out.faces.push(loop);
  if (out.faceParts) out.faceParts.push("");
  return { mesh: out, selection: { mode: "face", verts: [], edges: [], faces: [out.faces.length - 1] } };
}

/** Split each selected face into quads around its centre; neighbours gain the edge midpoints. */
export function subdivideFaces(mesh: MeshData, sel: MeshSelection): EditResult {
  const faces = selectedFaces(mesh, sel);
  if (!faces.size) return { mesh, selection: sel };
  const out = cloneMesh(mesh);
  const mid = new Map<string, number>();
  const midOf = (a: number, b: number): number => {
    const k = edgeKey(a, b);
    let m = mid.get(k);
    if (m === undefined) {
      m = out.positions.length / 3;
      const pa = vertexAt(mesh, a), pb = vertexAt(mesh, b);
      out.positions.push((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2);
      mid.set(k, m);
    }
    return m;
  };
  const newFaces: number[][] = [];
  const newParts: string[] = [];
  const created: number[] = [];
  mesh.faces.forEach((f, fi) => {
    if (!faces.has(fi)) return;
    const c = out.positions.length / 3;
    out.positions.push(...faceCenter(mesh, f));
    for (let i = 0; i < f.length; i++) {
      const v = f[i]!, next = f[(i + 1) % f.length]!, prev = f[(i + f.length - 1) % f.length]!;
      newFaces.push([v, midOf(v, next), c, midOf(prev, v)]);
      newParts.push(mesh.faceParts?.[fi] ?? "");
    }
  });
  // Rebuild: unselected faces keep their loop, with midpoints spliced into shared edges.
  const faces2: number[][] = [];
  const parts2: string[] = [];
  mesh.faces.forEach((f, fi) => {
    if (faces.has(fi)) return;
    const loop: number[] = [];
    for (let i = 0; i < f.length; i++) {
      const a = f[i]!, b = f[(i + 1) % f.length]!;
      loop.push(a);
      const m = mid.get(edgeKey(a, b));
      if (m !== undefined) loop.push(m);
    }
    faces2.push(loop);
    parts2.push(mesh.faceParts?.[fi] ?? "");
  });
  const start = faces2.length;
  out.faces = [...faces2, ...newFaces];
  if (mesh.faceParts) out.faceParts = [...parts2, ...newParts];
  for (let i = start; i < out.faces.length; i++) created.push(i);
  return { mesh: out, selection: { mode: "face", verts: [], edges: [], faces: created } };
}

/**
 * The ring of quads an edge cuts across (Ctrl+R): from the edge, through each
 * quad to its opposite edge, both ways, stopping at non-quads, borders, or
 * where the ring closes. Returns the ring's edges in order.
 */
export function edgeRing(mesh: MeshData, start: string): string[] {
  const { list, byKey } = meshEdges(mesh);
  const e0 = list[byKey.get(start) ?? -1];
  if (!e0) return [start];
  const seen = new Set<string>([start]);
  let closed = false;
  const walkFrom = (face: number | undefined): string[] => {
    const out: string[] = [];
    let cur = start;
    let f = face;
    for (let guard = 0; guard < 100000 && f !== undefined; guard++) {
      const loop = mesh.faces[f]!;
      if (loop.length !== 4) break;
      const i = loop.findIndex((v, k) => edgeKey(v, loop[(k + 1) % 4]!) === cur);
      if (i < 0) break;
      const opp = edgeKey(loop[(i + 2) % 4]!, loop[(i + 3) % 4]!);
      if (seen.has(opp)) {
        closed = true;
        break;
      }
      seen.add(opp);
      out.push(opp);
      const prev = f;
      f = list[byKey.get(opp)!]!.faces.find((g) => g !== prev);
      cur = opp;
    }
    return out;
  };
  const quads = e0.faces.filter((f) => mesh.faces[f]!.length === 4);
  const ahead = walkFrom(quads[0]);
  const behind = !closed && quads[1] !== undefined ? walkFrom(quads[1]) : [];
  return [...behind.reverse(), start, ...ahead];
}

/**
 * Loop cut: split every quad of the ring through `edge` at `factor` along its
 * ring edges. Non-quad faces at the ring's ends gain the new vertex in their
 * loop, so the mesh stays watertight.
 */
export function loopCut(mesh: MeshData, edge: string, factor = 0.5): EditResult {
  const ring = edgeRing(mesh, edge);
  const ringSet = new Set(ring);
  const out = cloneMesh(mesh);
  const cut = new Map<string, number>();
  // Orient each ring edge consistently so the cut is a straight loop, not a zig-zag.
  const cutOf = (a: number, b: number): number => {
    const k = edgeKey(a, b);
    let m = cut.get(k);
    if (m === undefined) {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const pa = vertexAt(mesh, lo), pb = vertexAt(mesh, hi);
      m = out.positions.length / 3;
      out.positions.push(pa[0] + (pb[0] - pa[0]) * factor, pa[1] + (pb[1] - pa[1]) * factor, pa[2] + (pb[2] - pa[2]) * factor);
      cut.set(k, m);
    }
    return m;
  };
  const faces: number[][] = [];
  const parts: string[] = [];
  const newEdges: string[] = [];
  mesh.faces.forEach((f, fi) => {
    const part = mesh.faceParts?.[fi] ?? "";
    const hits = f.map((v, i) => ringSet.has(edgeKey(v, f[(i + 1) % f.length]!)));
    const count = hits.filter(Boolean).length;
    if (f.length === 4 && count === 2 && hits[0] === hits[2]) {
      // Split this quad between the two cut points.
      const i = hits[0] ? 0 : 1;
      const a = f[i]!, b = f[(i + 1) % 4]!, c = f[(i + 2) % 4]!, d = f[(i + 3) % 4]!;
      const m1 = cutOf(a, b), m2 = cutOf(c, d);
      faces.push([a, m1, m2, d], [m1, b, c, m2]);
      parts.push(part, part);
      newEdges.push(edgeKey(m1, m2));
      return;
    }
    if (count === 0) {
      faces.push(f);
      parts.push(part);
      return;
    }
    // Splice cut points into an end face's loop.
    const loop: number[] = [];
    for (let i = 0; i < f.length; i++) {
      const a = f[i]!, b = f[(i + 1) % f.length]!;
      loop.push(a);
      if (hits[i]) loop.push(cutOf(a, b));
    }
    faces.push(loop);
    parts.push(part);
  });
  out.faces = faces;
  if (mesh.faceParts) out.faceParts = parts;
  return { mesh: out, selection: { mode: "edge", verts: [], edges: newEdges, faces: [] } };
}

/**
 * Edge loop (⌥-click): from an edge, continue straight through every vertex
 * with exactly four edges — the edge that shares no face with the one you came
 * in on — until the loop closes or hits a pole or a border.
 */
export function edgeLoop(mesh: MeshData, start: string): string[] {
  const { list, byKey } = meshEdges(mesh);
  const vEdges = new Map<number, number[]>();
  list.forEach((e, i) => {
    (vEdges.get(e.a) ?? vEdges.set(e.a, []).get(e.a)!).push(i);
    (vEdges.get(e.b) ?? vEdges.set(e.b, []).get(e.b)!).push(i);
  });
  const out = new Set<string>([start]);
  const step = (from: string, through: number): void => {
    let cur = from;
    let v = through;
    for (let guard = 0; guard < 100000; guard++) {
      const around = vEdges.get(v) ?? [];
      if (around.length !== 4) return;
      const e = list[byKey.get(cur)!]!;
      const curFaces = new Set(e.faces);
      const nextIdx = around.find((ei) => {
        const c = list[ei]!;
        if (edgeKey(c.a, c.b) === cur) return false;
        return !c.faces.some((f) => curFaces.has(f));
      });
      if (nextIdx === undefined) return;
      const n = list[nextIdx]!;
      const k = edgeKey(n.a, n.b);
      if (out.has(k)) return;
      out.add(k);
      cur = k;
      v = n.a === v ? n.b : n.a;
    }
  };
  const [a, b] = parseEdge(start);
  step(start, b);
  step(start, a);
  return [...out];
}

/** Grow a vertex set to everything connected to it (L / Ctrl+L). */
export function linkedVerts(mesh: MeshData, seeds: Iterable<number>): Set<number> {
  const { list } = meshEdges(mesh);
  const nbr: number[][] = Array.from({ length: vertexCount(mesh) }, () => []);
  for (const e of list) {
    nbr[e.a]!.push(e.b);
    nbr[e.b]!.push(e.a);
  }
  const out = new Set<number>();
  const stack = [...seeds];
  while (stack.length) {
    const v = stack.pop()!;
    if (out.has(v)) continue;
    out.add(v);
    for (const n of nbr[v] ?? []) if (!out.has(n)) stack.push(n);
  }
  return out;
}

/** Select linked, expressed in the selection's own mode. */
export function selectLinked(mesh: MeshData, sel: MeshSelection): MeshSelection {
  const vs = linkedVerts(mesh, selectedVerts(mesh, sel));
  return convertSelection(mesh, { mode: "vertex", verts: [...vs], edges: [], faces: [] }, sel.mode);
}

/** Grow the selection by one ring of neighbours (Ctrl +). */
export function growSelection(mesh: MeshData, sel: MeshSelection): MeshSelection {
  const vs = selectedVerts(mesh, sel);
  const grown = new Set(vs);
  for (const f of mesh.faces) if (f.some((v) => vs.has(v))) f.forEach((v) => grown.add(v));
  return convertSelection(mesh, { mode: "vertex", verts: [...grown], edges: [], faces: [] }, sel.mode);
}

/** Duplicate the selected faces in place (⇧D); the copies are selected. */
export function duplicateFaces(mesh: MeshData, sel: MeshSelection): EditResult {
  const faces = selectedFaces(mesh, sel);
  if (!faces.size) return { mesh, selection: sel };
  const out = cloneMesh(mesh);
  const map = new Map<number, number>();
  const created: number[] = [];
  for (const fi of faces) {
    const f = mesh.faces[fi]!;
    out.faces.push(
      f.map((v) => {
        let d = map.get(v);
        if (d === undefined) {
          d = out.positions.length / 3;
          out.positions.push(...vertexAt(mesh, v));
          map.set(v, d);
        }
        return d;
      }),
    );
    if (out.faceParts) out.faceParts.push(mesh.faceParts?.[fi] ?? "");
    created.push(out.faces.length - 1);
  }
  return { mesh: out, selection: convertSelection(out, { mode: "face", verts: [], edges: [], faces: created }, sel.mode) };
}

/** Separate (P): split the selected faces off into a mesh of their own. */
export function separateFaces(mesh: MeshData, sel: MeshSelection): { kept: MeshData; separated: MeshData } | null {
  const faces = selectedFaces(mesh, sel);
  if (!faces.size || faces.size === mesh.faces.length) return null;
  const pick = (keep: boolean): MeshData => {
    const fs: number[][] = [];
    const ps: string[] = [];
    mesh.faces.forEach((f, i) => {
      if (faces.has(i) !== keep) return;
      fs.push(f);
      ps.push(mesh.faceParts?.[i] ?? "");
    });
    return compactMesh({ positions: mesh.positions, faces: fs, ...(mesh.faceParts ? { faceParts: ps } : {}) });
  };
  return { kept: pick(false), separated: pick(true) };
}

/** Give the selected faces a part ("" = back to the object's own look). */
export function assignPart(mesh: MeshData, sel: MeshSelection, partId: string): MeshData {
  const faces = selectedFaces(mesh, sel);
  const parts = mesh.faceParts?.slice() ?? mesh.faces.map(() => "");
  for (const f of faces) parts[f] = partId;
  const out = { ...mesh, faceParts: parts };
  if (parts.every((p) => p === "")) delete (out as { faceParts?: string[] }).faceParts;
  return out;
}

/** Mark or clear the selected edges for strokes (or as sharp). */
export function markEdges(mesh: MeshData, sel: MeshSelection, field: "marks" | "sharp", on: boolean): MeshData {
  const es = selectedEdges(mesh, sel);
  const current = new Set<string>();
  const src = mesh[field] ?? [];
  for (let i = 0; i + 1 < src.length; i += 2) current.add(edgeKey(src[i]!, src[i + 1]!));
  for (const k of es) {
    if (on) current.add(k);
    else current.delete(k);
  }
  const flat = [...current].flatMap(parseEdge);
  const out = { ...mesh, [field]: flat };
  if (!flat.length) delete (out as Record<string, unknown>)[field];
  return out;
}

export { parseEdge };

// ── Bridge and spin ─────────────────────────────────────────────────────────

/** The selected edges as runs of vertices — each a path or a closed loop — or null if any vertex branches. */
function edgeRuns(edges: Iterable<[number, number]>): Array<{ verts: number[]; closed: boolean }> | null {
  const adj = new Map<number, number[]>();
  for (const [a, b] of edges) {
    adj.set(a, [...(adj.get(a) ?? []), b]);
    adj.set(b, [...(adj.get(b) ?? []), a]);
  }
  if ([...adj.values()].some((n) => n.length > 2)) return null;
  const seen = new Set<number>();
  const runs: Array<{ verts: number[]; closed: boolean }> = [];
  // Paths first (start at an end), then whatever is left is closed loops.
  const starts = [...[...adj.keys()].filter((v) => adj.get(v)!.length === 1), ...adj.keys()];
  for (const s of starts) {
    if (seen.has(s)) continue;
    const verts = [s];
    seen.add(s);
    let prev = -1, at = s;
    for (;;) {
      const next = adj.get(at)!.find((v) => v !== prev && !seen.has(v));
      if (next === undefined) break;
      verts.push(next);
      seen.add(next);
      prev = at;
      at = next;
    }
    const closed = verts.length > 2 && adj.get(verts[verts.length - 1]!)!.includes(s);
    runs.push({ verts, closed });
  }
  return runs;
}

/**
 * BRIDGE EDGE LOOPS — join two edge loops (or two open runs of edges) with a
 * band of faces: the gap between two rings becomes a tube, a hole is spanned.
 * With FACES selected, their two rims are bridged and the faces themselves
 * removed (two caps facing each other become a tunnel). The second run is
 * matched to the first by the start and direction that keep the band from
 * twisting, and the band faces outward, away from the middle of it all.
 * Runs must have the same number of points — a band needs partners.
 */
export function bridgeLoops(mesh: MeshData, sel: MeshSelection): EditResult & { error?: string } {
  let src = mesh;
  let edges: Array<[number, number]>;
  if (sel.mode === "face" && sel.faces.length) {
    const faces = new Set(sel.faces);
    const count = new Map<string, number>();
    for (const f of faces) {
      const loop = mesh.faces[f]!;
      for (let i = 0; i < loop.length; i++) {
        const k = edgeKey(loop[i]!, loop[(i + 1) % loop.length]!);
        count.set(k, (count.get(k) ?? 0) + 1);
      }
    }
    edges = [...count].filter(([, c]) => c === 1).map(([k]) => parseEdge(k));
    src = cloneMesh(mesh);
    const keep = mesh.faces.map((_, i) => !faces.has(i));
    src.faces = mesh.faces.filter((_, i) => keep[i]);
    if (src.faceParts) src.faceParts = src.faceParts.filter((_, i) => keep[i]);
  } else {
    edges = [...selectedEdges(mesh, sel)].map(parseEdge);
  }
  const runs = edgeRuns(edges);
  if (!runs || runs.length !== 2) return { mesh, selection: sel, error: "Select two edge loops (or two groups of faces) to bridge" };
  const [A, B] = runs as [{ verts: number[]; closed: boolean }, { verts: number[]; closed: boolean }];
  if (A.verts.length !== B.verts.length || A.closed !== B.closed) return { mesh, selection: sel, error: "Bridge needs two loops with the same number of points" };
  const n = A.verts.length;
  const at = (v: number) => vertexAt(src, v);
  // Pair B with A: every start (closed) and both directions, the shortest total reach wins.
  let best = { cost: Infinity, order: B.verts };
  for (const dir of [B.verts, B.verts.slice().reverse()]) {
    for (let off = 0; off < (A.closed ? n : 1); off++) {
      const order = dir.map((_, i) => dir[(i + off) % n]!);
      let cost = 0;
      for (let i = 0; i < n; i++) {
        const d = sub(at(A.verts[i]!), at(order[i]!));
        cost += Math.hypot(d[0], d[1], d[2]);
      }
      if (cost < best.cost) best = { cost, order };
    }
  }
  const b = best.order;
  const quads: number[][] = [];
  const segs = A.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    quads.push([A.verts[i]!, A.verts[j]!, b[j]!, b[i]!]);
  }
  // Outward: away from the middle of the two runs.
  const all = [...A.verts, ...b].map(at);
  const mid = scale3(all.reduce((acc, p) => add(acc, p), [0, 0, 0] as V3), 1 / all.length);
  const probe = { ...src, faces: [quads[0]!] };
  const outward = dot(faceNormal(probe, quads[0]!), sub(faceCenter(probe, quads[0]!), mid)) >= 0;
  const out = cloneMesh(src);
  const first = out.faces.length;
  for (const q of quads) out.faces.push(outward ? q : q.slice().reverse());
  if (out.faceParts) for (let i = 0; i < quads.length; i++) out.faceParts.push("");
  return { mesh: out, selection: { mode: "face", verts: [], edges: [], faces: quads.map((_, i) => first + i) } };
}

/**
 * SPIN — sweep the selected points and edges around an axis (through
 * `center`, along `axis`) in `steps` turns of `angle` degrees: a profile
 * becomes a vase, an edge a ring of faces, a point an arc. A full 360° closes
 * onto where it started. The last ring is left selected, ready to spin again.
 */
export function spinSelection(mesh: MeshData, sel: MeshSelection, center: V3, axis: V3, angle: number, steps: number): EditResult {
  const verts = [...selectedVerts(mesh, sel)];
  if (!verts.length) return { mesh, selection: sel };
  const edges = [...selectedEdges(mesh, sel)].map(parseEdge);
  const k = Math.max(1, Math.round(steps));
  const full = Math.abs(Math.abs(angle) - 360) < 1e-6;
  const rings = full ? k - 1 : k;
  const u = normalize3(axis);
  const out = cloneMesh(mesh);
  // ring[r] maps an original vertex to its copy after r+1 steps.
  const ring: Array<Map<number, number>> = [];
  for (let r = 0; r < rings; r++) {
    const th = (((r + 1) * angle) / k) * (Math.PI / 180);
    const c = Math.cos(th), s = Math.sin(th);
    const m = new Map<number, number>();
    for (const v of verts) {
      const p = sub(vertexAt(mesh, v), center);
      // Rodrigues: p·cos + (u×p)·sin + u(u·p)(1−cos)
      const q = add(add(scale3(p, c), scale3(cross(u, p), s)), scale3(u, dot(u, p) * (1 - c)));
      const w = add(q, center);
      m.set(v, out.positions.length / 3);
      out.positions.push(w[0], w[1], w[2]);
      if (out.uv) out.uv.push(out.uv[v * 2]!, out.uv[v * 2 + 1]!);
    }
    ring.push(m);
  }
  const step = (r: number, v: number) => (r < 0 ? v : r >= rings ? v : ring[r]!.get(v)!);
  const first = out.faces.length;
  for (let r = -1; r < (full ? rings : rings - 1); r++) {
    for (const [a, b] of edges) out.faces.push([step(r, a), step(r, b), step(r + 1, b), step(r + 1, a)]);
  }
  if (out.faceParts) for (let i = first; i < out.faces.length; i++) out.faceParts.push("");
  const last = full ? verts : verts.map((v) => step(rings - 1, v));
  return { mesh: out, selection: { mode: "vertex", verts: last, edges: [], faces: [] } };
}
