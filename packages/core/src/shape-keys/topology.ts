import type { MeshData, PathPoint, ShapeKey, Subpath } from "../schema";
import { meshEdges } from "../world/mesh";
import { deltaOf, PATH_EPS, PATH_STRIDE, sparsifyMesh } from "./delta";

/**
 * KEYS FOLLOW TOPOLOGY — the one helper every point-adding / point-removing
 * edit passes through, so no op has to know shape keys exist.
 *
 * It runs at the two geometry write seams (`editPathGeometry` for paths,
 * `setMeshData` for meshes) with the outline BEFORE and AFTER the edit, and
 * re-derives every key's delta for the new points by CORRESPONDENCE rather
 * than by replaying the op (replay is wrong for every op that reads positions:
 * a knife, Simplify, a weld, a precomputed result):
 *
 *  1. A contour with the same id and count is the same run — index for index
 *     (a move), or mirrored when its anchors read back-to-front (Reverse; the
 *     handle terms swap sides).
 *  2. Otherwise a point that sits exactly where an old anchor sat IS that
 *     anchor (a break duplicates it; a join, a delete, a rotate all keep it):
 *     its delta travels with it. A handle the edit shortened along itself (a
 *     split's neighbours) scales its delta by the same ratio — exact for a
 *     de Casteljau split.
 *  3. A NEW point lying on an old segment (insert, knife) is placed by
 *     splitting each key's OWN curve at the same t, so every key's shape is
 *     unchanged by the insert — Blender's subdivide, not "insert zero".
 *  4. Anything else (a refit, a drawn extension) takes its run's neighbours'
 *     anchor deltas, interpolated; a run with no known neighbour is zero.
 *
 * Meshes: same idea per vertex — a vertex where an old one was copies it
 * (extrude/duplicate copy their source, BMesh's custom-data rule), a vertex on
 * an old edge lerps its ends (loop cut, subdivide, knife), else the nearest old
 * vertex's delta (inset, poke). Equal counts are index-aligned (a move, an
 * origin shift); a linear re-map of the whole object belongs to the caller
 * (`transformShapeKeys`).
 */

// ── Paths ────────────────────────────────────────────────────────────────────

type Row = [number, number, number, number, number, number];

const posKey = (x: number, y: number) => `${x},${y}`;

function rowOf(key: ShapeKey, contourId: string, i: number): Row {
  const d = deltaOf(key);
  const run = d?.kind === "path" ? d.contours[contourId] : undefined;
  const o = i * PATH_STRIDE;
  return [run?.[o] ?? 0, run?.[o + 1] ?? 0, run?.[o + 2] ?? 0, run?.[o + 3] ?? 0, run?.[o + 4] ?? 0, run?.[o + 5] ?? 0];
}

/** Where an after-point's delta comes from. */
type Source =
  | { kind: "same"; sid: string; i: number; swap: boolean; inScale: number; outScale: number }
  | { kind: "split"; sub: Subpath; seg: number; t: number }
  | { kind: "none" };

function cubic(a: PathPoint, b: PathPoint): [number, number, number, number, number, number, number, number] {
  const c1 = a.hOut ?? a;
  const c2 = b.hIn ?? b;
  return [a.x, a.y, c1.x, c1.y, c2.x, c2.y, b.x, b.y];
}

function evalAt(c: readonly number[], t: number): [number, number] {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return [a * c[0]! + b * c[2]! + d * c[4]! + e * c[6]!, a * c[1]! + b * c[3]! + d * c[5]! + e * c[7]!];
}

/** de Casteljau at t → [r0 (new in-handle), s (anchor), r1 (new out-handle)]. */
function splitAt(c: readonly number[], t: number): { r0: [number, number]; s: [number, number]; r1: [number, number] } {
  const lp = (x0: number, y0: number, x1: number, y1: number): [number, number] => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
  const q0 = lp(c[0]!, c[1]!, c[2]!, c[3]!);
  const q1 = lp(c[2]!, c[3]!, c[4]!, c[5]!);
  const q2 = lp(c[4]!, c[5]!, c[6]!, c[7]!);
  const r0 = lp(q0[0], q0[1], q1[0], q1[1]);
  const r1 = lp(q1[0], q1[1], q2[0], q2[1]);
  return { r0, s: lp(r0[0], r0[1], r1[0], r1[1]), r1 };
}

/** The closest parameter on a cubic to (x, y), and the distance there. */
function closestT(c: readonly number[], x: number, y: number): { t: number; dist: number } {
  let best = 0, bestD = Infinity;
  const N = 48;
  for (let k = 0; k <= N; k++) {
    const [px, py] = evalAt(c, k / N);
    const d = (px - x) ** 2 + (py - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = k / N;
    }
  }
  // Refine by bisection on the bracket around the best sample.
  let lo = Math.max(0, best - 1 / N), hi = Math.min(1, best + 1 / N);
  for (let it = 0; it < 40; it++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    const [ax, ay] = evalAt(c, m1);
    const [bx, by] = evalAt(c, m2);
    if ((ax - x) ** 2 + (ay - y) ** 2 < (bx - x) ** 2 + (by - y) ** 2) hi = m2;
    else lo = m1;
  }
  const t = (lo + hi) / 2;
  const [px, py] = evalAt(c, t);
  return { t, dist: Math.hypot(px - x, py - y) };
}

const ON_CURVE = 0.05;

/** The old segment a new point lies on, preferring its own contour. */
function findSegment(before: ReadonlyArray<Subpath>, preferId: string, x: number, y: number): { sub: Subpath; seg: number; t: number } | null {
  let best: { sub: Subpath; seg: number; t: number; dist: number } | null = null;
  const ordered = [...before.filter((s) => s.id === preferId), ...before.filter((s) => s.id !== preferId)];
  for (const sub of ordered) {
    const n = sub.points.length;
    const segs = sub.closed ? n : n - 1;
    for (let k = 0; k < segs; k++) {
      const c = cubic(sub.points[k]!, sub.points[(k + 1) % n]!);
      const hit = closestT(c, x, y);
      if (hit.dist <= ON_CURVE && (!best || hit.dist < best.dist - 1e-9)) best = { sub, seg: k, t: hit.t, dist: hit.dist };
    }
    if (best && sub.id === preferId) break;
  }
  return best && best.t > 1e-6 && best.t < 1 - 1e-6 ? best : null;
}

/** How much a handle's offset was scaled along itself (1 when it was re-aimed, grown or dropped). */
function armScale(from: PathPoint, fromSide: "hIn" | "hOut", to: PathPoint, toSide: "hIn" | "hOut"): number {
  const a = from[fromSide], b = to[toSide];
  // An arm the edit dropped (a break's open ends) takes the key's arm with it.
  if (!b) return a ? 0 : 1;
  if (!a) return 1;
  const ax = a.x - from.x, ay = a.y - from.y;
  const bx = b.x - to.x, by = b.y - to.y;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-12 || lb < 1e-12) return 1;
  const cos = (ax * bx + ay * by) / (la * lb);
  return cos > 1 - 1e-9 ? lb / la : 1;
}

function sameSource(from: PathPoint, sid: string, i: number, to: PathPoint, swap: boolean): Source {
  return {
    kind: "same",
    sid,
    i,
    swap,
    inScale: armScale(from, swap ? "hOut" : "hIn", to, "hIn"),
    outScale: armScale(from, swap ? "hIn" : "hOut", to, "hOut"),
  };
}

/** Correspondence for every after-point (contour id → per-point source). */
function correspond(before: ReadonlyArray<Subpath>, after: ReadonlyArray<Subpath>): Map<string, Source[]> {
  const byId = new Map(before.map((s) => [s.id, s]));
  const at = new Map<string, Array<{ sid: string; i: number }>>();
  for (const s of before) s.points.forEach((p, i) => (at.get(posKey(p.x, p.y)) ?? at.set(posKey(p.x, p.y), []).get(posKey(p.x, p.y))!).push({ sid: s.id, i }));
  const out = new Map<string, Source[]>();
  for (const sub of after) {
    const old = byId.get(sub.id);
    const n = sub.points.length;
    if (old && old.points.length === n) {
      const fwd = sub.points.every((p, i) => p.x === old.points[i]!.x && p.y === old.points[i]!.y);
      const rev = !fwd && n > 1 && sub.points.every((p, i) => p.x === old.points[n - 1 - i]!.x && p.y === old.points[n - 1 - i]!.y);
      out.set(sub.id, sub.points.map((p, i) => {
        const j = rev ? n - 1 - i : i;
        return sameSource(old.points[j]!, old.id, j, p, rev);
      }));
      continue;
    }
    const srcs: Source[] = [];
    let last: { sid: string; i: number } | null = null;
    for (const p of sub.points) {
      const cands = at.get(posKey(p.x, p.y));
      if (cands?.length) {
        const own = cands.filter((c) => c.sid === sub.id);
        const pool = own.length ? own : cands;
        const pick: { sid: string; i: number } = last ? pool.reduce((b, c) => (c.sid === last!.sid && Math.abs(c.i - last!.i) < Math.abs(b.i - last!.i) ? c : b), pool[0]!) : pool[0]!;
        srcs.push(sameSource(byId.get(pick.sid)!.points[pick.i]!, pick.sid, pick.i, p, false));
        last = pick;
        continue;
      }
      const seg = findSegment(before, sub.id, p.x, p.y);
      srcs.push(seg ? { kind: "split", ...seg } : { kind: "none" });
    }
    // A run whose matched anchors read back-to-front was reversed (a join flips one side): swap their arms.
    let up = 0, down = 0;
    for (let k = 1; k < srcs.length; k++) {
      const a = srcs[k - 1]!, b = srcs[k]!;
      if (a.kind === "same" && b.kind === "same" && a.sid === b.sid) {
        if (b.i > a.i) up++;
        else if (b.i < a.i) down++;
      }
    }
    if (down > up) {
      srcs.forEach((s, k) => {
        if (s.kind !== "same") return;
        const from = byId.get(s.sid)!.points[s.i]!;
        srcs[k] = sameSource(from, s.sid, s.i, sub.points[k]!, true);
      });
    }
    out.set(sub.id, srcs);
  }
  return out;
}

/** The key's ABSOLUTE point at an old index (base + this key's delta). */
function keyPoint(p: PathPoint, r: Row): PathPoint {
  const x = p.x + r[0], y = p.y + r[1];
  const arm = (h: PathPoint["hIn"], dx: number, dy: number) =>
    h ? { x: x + h.x - p.x + dx, y: y + h.y - p.y + dy } : dx || dy ? { x: x + dx, y: y + dy } : null;
  return { x, y, hIn: arm(p.hIn, r[2], r[3]), hOut: arm(p.hOut, r[4], r[5]) };
}

function rowFor(key: ShapeKey, src: Source, p: PathPoint): Row | null {
  if (src.kind === "same") {
    const r = rowOf(key, src.sid, src.i);
    const [ix, iy, ox, oy] = src.swap ? [r[4], r[5], r[2], r[3]] : [r[2], r[3], r[4], r[5]];
    return [r[0], r[1], ix * src.inScale, iy * src.inScale, ox * src.outScale, oy * src.outScale];
  }
  if (src.kind === "split") {
    const n = src.sub.points.length;
    const a = src.sub.points[src.seg]!, b = src.sub.points[(src.seg + 1) % n]!;
    const ka = keyPoint(a, rowOf(key, src.sub.id, src.seg));
    const kb = keyPoint(b, rowOf(key, src.sub.id, (src.seg + 1) % n));
    const k = splitAt(cubic(ka, kb), src.t);
    const pIn = p.hIn ? [p.hIn.x - p.x, p.hIn.y - p.y] : null;
    const pOut = p.hOut ? [p.hOut.x - p.x, p.hOut.y - p.y] : null;
    return [
      k.s[0] - p.x,
      k.s[1] - p.y,
      pIn ? k.r0[0] - k.s[0] - pIn[0]! : 0,
      pIn ? k.r0[1] - k.s[1] - pIn[1]! : 0,
      pOut ? k.r1[0] - k.s[0] - pOut[0]! : 0,
      pOut ? k.r1[1] - k.s[1] - pOut[1]! : 0,
    ];
  }
  return null;
}

/**
 * Re-derive every PATH key's delta for `after` from `before`. Mutates the keys
 * (call inside the write). Contours that no longer exist drop out.
 */
export function followPathTopology(keys: ShapeKey[] | undefined, before: ReadonlyArray<Subpath>, after: ReadonlyArray<Subpath>): void {
  const pathKeys = (keys ?? []).filter((k) => deltaOf(k)?.kind === "path");
  if (pathKeys.length === 0) return;
  const map = correspond(before, after);
  for (const key of pathKeys) {
    const contours: Record<string, number[]> = {};
    for (const sub of after) {
      const srcs = map.get(sub.id)!;
      const rows = sub.points.map((p, i) => rowFor(key, srcs[i]!, p));
      // Step 4: what is still unknown leans on its run's known neighbours.
      for (let i = 0; i < rows.length; i++) {
        if (rows[i]) continue;
        let a = i - 1, b = i + 1;
        while (a >= 0 && !rows[a]) a--;
        while (b < rows.length && !rows[b]) b++;
        const ra = a >= 0 ? rows[a] : null, rb = b < rows.length ? rows[b] : null;
        const f = ra && rb ? (i - a) / (b - a) : 0;
        const lerp = (k: number) => (ra && rb ? ra[k]! + (rb[k]! - ra[k]!) * f : (ra ?? rb)?.[k] ?? 0);
        rows[i] = [lerp(0), lerp(1), 0, 0, 0, 0];
      }
      const run = rows.flatMap((r) => r!);
      if (run.some((v) => Math.abs(v) > PATH_EPS)) contours[sub.id] = run;
    }
    key.source = { kind: "delta", delta: { kind: "path", contours } };
  }
}

// ── Meshes ───────────────────────────────────────────────────────────────────

/** A coarse grid over a point set for nearest lookups. */
function nearestIndex(pos: ArrayLike<number>): (x: number, y: number, z: number) => number {
  const n = pos.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < n; v++) {
    const x = pos[v * 3]!, y = pos[v * 3 + 1]!, z = pos[v * 3 + 2]!;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  const cell = span / Math.max(1, Math.cbrt(n));
  const grid = new Map<string, number[]>();
  const keyOf = (x: number, y: number, z: number) => `${Math.floor((x - minX) / cell)},${Math.floor((y - minY) / cell)},${Math.floor((z - minZ) / cell)}`;
  for (let v = 0; v < n; v++) {
    const k = keyOf(pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(v);
  }
  return (x, y, z) => {
    const cx = Math.floor((x - minX) / cell), cy = Math.floor((y - minY) / cell), cz = Math.floor((z - minZ) / cell);
    let best = -1, bestD = Infinity;
    for (let r = 0; r < 64 && (best < 0 || r <= 1); r++) {
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++) {
        if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== r) continue;
        for (const v of grid.get(`${cx + i},${cy + j},${cz + k}`) ?? []) {
          const d = (pos[v * 3]! - x) ** 2 + (pos[v * 3 + 1]! - y) ** 2 + (pos[v * 3 + 2]! - z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = v;
          }
        }
      }
    }
    return best;
  };
}

/** Where each new vertex comes from: an old vertex, or a lerp along an old edge. */
type VSource = { a: number; b: number; t: number } | null;

function correspondMesh(before: MeshData, after: MeshData): VSource[] {
  const bp = before.positions, ap = after.positions;
  const bn = bp.length / 3, an = ap.length / 3;
  const at = new Map<string, number[]>();
  for (let v = 0; v < bn; v++) {
    const k = `${bp[v * 3]},${bp[v * 3 + 1]},${bp[v * 3 + 2]}`;
    (at.get(k) ?? at.set(k, []).get(k)!).push(v);
  }
  const out: VSource[] = new Array(an).fill(null);
  const unknown: number[] = [];
  for (let v = 0; v < an; v++) {
    const c = at.get(`${ap[v * 3]},${ap[v * 3 + 1]},${ap[v * 3 + 2]}`);
    if (c?.length) out[v] = { a: c.includes(v) ? v : c[0]!, b: -1, t: 0 };
    else unknown.push(v);
  }
  if (unknown.length === 0) return out;
  const edges = meshEdges(before).list;
  const budget = unknown.length * edges.length <= 8e6;
  const nearest = nearestIndex(bp);
  for (const v of unknown) {
    const x = ap[v * 3]!, y = ap[v * 3 + 1]!, z = ap[v * 3 + 2]!;
    let found: VSource = null;
    if (budget) {
      let bestD = 1e-3;
      for (const e of edges) {
        const ax = bp[e.a * 3]!, ay = bp[e.a * 3 + 1]!, az = bp[e.a * 3 + 2]!;
        const dx = bp[e.b * 3]! - ax, dy = bp[e.b * 3 + 1]! - ay, dz = bp[e.b * 3 + 2]! - az;
        const len2 = dx * dx + dy * dy + dz * dz;
        if (len2 < 1e-12) continue;
        const t = ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / len2;
        if (t <= 0 || t >= 1) continue;
        const d = Math.hypot(ax + dx * t - x, ay + dy * t - y, az + dz * t - z);
        if (d < bestD) {
          bestD = d;
          found = { a: e.a, b: e.b, t };
        }
      }
    }
    if (!found && bn > 0) {
      const near = nearest(x, y, z);
      if (near >= 0) found = { a: near, b: -1, t: 0 };
    }
    out[v] = found;
  }
  return out;
}

/**
 * Re-derive every MESH key's delta for `after` from `before`. Equal vertex
 * counts are index-aligned (moves keep deltas — the keys ride the base).
 */
export function followMeshTopology(keys: ShapeKey[] | undefined, before: MeshData, after: MeshData): void {
  const meshKeys = (keys ?? []).filter((k) => deltaOf(k)?.kind === "mesh");
  if (meshKeys.length === 0 || before.positions.length === after.positions.length) return;
  const map = correspondMesh(before, after);
  const bn = before.positions.length / 3;
  for (const key of meshKeys) {
    const d = deltaOf(key)!;
    if (d.kind !== "mesh") continue;
    const old = new Float64Array(bn * 3);
    d.verts.forEach((v, k) => {
      if (v >= bn) return;
      old[v * 3] = d.xyz[k * 3] ?? 0;
      old[v * 3 + 1] = d.xyz[k * 3 + 1] ?? 0;
      old[v * 3 + 2] = d.xyz[k * 3 + 2] ?? 0;
    });
    const dense = new Float64Array(map.length * 3);
    map.forEach((s, v) => {
      if (!s) return;
      for (let c = 0; c < 3; c++) {
        const a = old[s.a * 3 + c]!;
        dense[v * 3 + c] = s.b < 0 ? a : a + (old[s.b * 3 + c]! - a) * s.t;
      }
    });
    key.source = { kind: "delta", delta: sparsifyMesh(dense) };
  }
}

/** Mesh positions changed by a LINEAR map (apply rotation/scale): turn every key's offsets with it. `m3` is column-major 3×3. */
export function transformShapeKeys(keys: ShapeKey[] | undefined, m3: readonly number[]): void {
  for (const key of keys ?? []) {
    const d = deltaOf(key);
    if (d?.kind !== "mesh") continue;
    const xyz = d.xyz.slice();
    for (let k = 0; k + 2 < xyz.length; k += 3) {
      const x = d.xyz[k]!, y = d.xyz[k + 1]!, z = d.xyz[k + 2]!;
      xyz[k] = m3[0]! * x + m3[3]! * y + m3[6]! * z;
      xyz[k + 1] = m3[1]! * x + m3[4]! * y + m3[7]! * z;
      xyz[k + 2] = m3[2]! * x + m3[5]! * y + m3[8]! * z;
    }
    key.source = { kind: "delta", delta: { kind: "mesh", verts: d.verts.slice(), xyz } };
  }
}
