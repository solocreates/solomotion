import type { WeightStroke } from "../schema";
import type { RigPose } from "./pose";
import { distToSegment } from "./pose";
import type { V3 } from "../world/math";

/**
 * WEIGHTS — how much each bone pulls on each point of a piece of art.
 *
 * ## Where they live
 *
 * On a GRAPH: points (in the art's own space, and in the rig's) with their
 * neighbours. A 2D layer's graph is a grid over its silhouette (`support.ts`);
 * a mesh's is its vertices and edges. Weights are never stored — they are
 * DERIVED from the art and the rest bones (automatic), then the painted
 * strokes are replayed on top. Moving a rest bone re-weights; editing a mesh
 * re-weights; nothing ever needs "re-binding" (Blender's Ctrl+P again).
 *
 * ## Automatic: bone heat
 *
 * Baran & Popović's heat diffusion (the "With Automatic Weights" Blender
 * ships): each bone is a heat source on the points it is NEAREST, as strong
 * as `(h / d)²` — h the graph's spacing, d the distance to the bone — and the
 * heat spreads only along the graph's edges. Solved with Gauss–Seidel from a
 * one-hot start (each point fully its nearest bone), so the answer moves only
 * where it must: across a joint it blends over a width that grows with the
 * flesh around it, and it never crosses a GAP — the left leg's heat cannot
 * reach the right leg through air, which is what plain distance (and the
 * envelope prototype) got wrong.
 *
 * Sparse: each point tracks its `SLOTS` nearest deform bones, so the solve
 * costs points × slots × neighbours, not points × every bone.
 *
 * ## Paint
 *
 * Strokes (`schema/rig.ts` `weightStrokeSchema`) replay in order: add,
 * subtract, replace toward a value, smooth. The painted bone is held and the
 * others share what is left (auto-normalise, as Blender's lock-active), so a
 * point always sums to one and never loses its last bone to a subtract.
 */

/** Bones a point can carry (the industry's four, plus room for paint to add). */
export const SLOTS = 6;
/** Bones a deformed point is finally blended from. */
export const INFLUENCES = 4;

export interface WeightGraph {
  /** Changes exactly when the points or edges change. */
  key: string;
  count: number;
  /** Points in the art's own space (where strokes are painted), xyz. */
  local: Float64Array;
  /** The same points in the rig's space at the art's resting placement, xyz. */
  rig: Float64Array;
  /** CSR adjacency: neighbours of i are adj[offsets[i] .. offsets[i+1]). */
  offsets: Int32Array;
  adj: Int32Array;
  /** Typical spacing between neighbours (the grid cell, the mean edge). */
  spacing: number;
}

export interface Weights {
  count: number;
  /** The deform bones, by index (what `bone` slots point at). */
  bones: string[];
  /** count × SLOTS: bone index, −1 = empty. */
  bone: Int16Array;
  /** count × SLOTS: weight. Each point sums to 1 (or has no bones at all). */
  w: Float32Array;
  /** count × 2: each point's nearest and second-nearest deform bone (−1 = none) — who inherits a subtracted last bone. */
  nearest: Int16Array;
}

export interface BoneSegment {
  id: string;
  a: V3;
  b: V3;
}

/** The rest segments of the bones that bend art. */
export function deformSegments(pose: RigPose): BoneSegment[] {
  return pose.bones.filter((s) => s.bone.deform).map((s) => ({ id: s.id, a: s.restHead, b: s.restTail }));
}

/** A place two deform bones meet (a child's head on its parent's tail), and how wide it softens. */
export interface Joint {
  at: V3;
  radius: number;
}

/**
 * The rig's JOINTS — where a deform bone's head sits on its deform parent's
 * tail (within a tenth of the shorter bone) — each softening over `blend` of
 * the shorter of the two bones.
 */
export function rigJoints(pose: RigPose, blend: number): Joint[] {
  const out: Joint[] = [];
  if (blend <= 0) return out;
  for (const s of pose.bones) {
    if (!s.bone.deform || !s.parent) continue;
    const p = pose.byId.get(s.parent);
    if (!p || !p.bone.deform) continue;
    const short = Math.min(s.bone.rest.length, p.bone.rest.length);
    const gap = Math.hypot(s.restHead[0] - p.restTail[0], s.restHead[1] - p.restTail[1], s.restHead[2] - p.restTail[2]);
    if (gap > short * 0.1 + 1e-6) continue;
    out.push({ at: s.restHead, radius: Math.max(1e-6, short * blend * 0.6) });
  }
  return out;
}

// ── Automatic ────────────────────────────────────────────────────────────────

/**
 * Automatic weights over a graph — the bone-heat solve described above.
 * `sharpness` scales the heat sources: higher holds each region to its own
 * bone longer and blends over a narrower joint (1 = Baran's).
 */
export function autoWeights(graph: WeightGraph, segments: readonly BoneSegment[], opts: { sharpness?: number; iterations?: number; joints?: readonly Joint[] } = {}): Weights {
  const n = graph.count;
  const bones = segments.map((s) => s.id);
  const bone = new Int16Array(n * SLOTS).fill(-1);
  const w = new Float32Array(n * SLOTS);
  const nearest = new Int16Array(n * 2).fill(-1);
  if (!segments.length || !n) return { count: n, bones, bone, w, nearest };
  const k = Math.min(SLOTS, segments.length);
  const H = new Float32Array(n);
  const near = new Int16Array(n);
  const d = new Float64Array(segments.length);
  const order = new Int16Array(segments.length);
  const h = Math.max(1e-6, graph.spacing);
  const sharp = opts.sharpness ?? 1;

  for (let i = 0; i < n; i++) {
    const p: V3 = [graph.rig[i * 3]!, graph.rig[i * 3 + 1]!, graph.rig[i * 3 + 2]!];
    for (let s = 0; s < segments.length; s++) (d[s] = distToSegment(p, segments[s]!.a, segments[s]!.b)), (order[s] = s);
    // The k nearest bones are this point's candidates, nearest first.
    const idx = Array.from(order).sort((x, y) => d[x]! - d[y]!).slice(0, k);
    for (let j = 0; j < k; j++) bone[i * SLOTS + j] = idx[j]!;
    near[i] = idx[0]!;
    nearest[i * 2] = idx[0]!;
    nearest[i * 2 + 1] = idx.length > 1 ? idx[1]! : -1;
    const dn = Math.max(d[idx[0]!]!, h * 0.25);
    H[i] = sharp * (h / dn) * (h / dn);
    w[i * SLOTS] = 1;
  }

  // Gauss–Seidel on (deg + H) w = Σ neighbours + H·[nearest]. A neighbour's
  // weight for a bone it does not track is 0 — such a bone is not among its
  // nearest, so its true weight there is negligible.
  const iterations = opts.iterations ?? Math.min(120, Math.max(24, Math.round(Math.sqrt(n) * 1.5)));
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      const o0 = graph.offsets[i]!, o1 = graph.offsets[i + 1]!;
      const deg = o1 - o0;
      const base = i * SLOTS;
      let total = 0;
      for (let j = 0; j < k; j++) {
        const b = bone[base + j]!;
        let sum = 0;
        for (let e = o0; e < o1; e++) sum += weightOf(bone, w, graph.adj[e]!, b);
        const src = b === near[i] ? H[i]! : 0;
        const v = (sum + src) / (deg + H[i]!);
        w[base + j] = v;
        total += v;
      }
      if (total > 1e-12) for (let j = 0; j < k; j++) w[base + j] = w[base + j]! / total;
    }
  }
  if (opts.joints?.length) softenJoints(graph, bone, w, k, opts.joints);
  for (let i = 0; i < n; i++) settle(bone, w, i);
  return { count: n, bones, bone, w, nearest };
}

/**
 * Bone heat holds a thin limb to its bone right up to the joint, which creases
 * there. Around each joint the weights are averaged with their neighbours —
 * along the graph's edges, so it still never crosses a gap — over a width that
 * fades to nothing at the joint's radius, leaving the rest of each limb whole.
 */
function softenJoints(graph: WeightGraph, bone: Int16Array, w: Float32Array, k: number, joints: readonly Joint[]): void {
  const n = graph.count;
  const mask = new Float32Array(n);
  let widest = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const j of joints) {
      const d = Math.hypot(graph.rig[i * 3]! - j.at[0], graph.rig[i * 3 + 1]! - j.at[1], graph.rig[i * 3 + 2]! - j.at[2]);
      if (d < j.radius) {
        const t = 1 - d / j.radius;
        m = Math.max(m, t * t * (3 - 2 * t));
      }
      widest = Math.max(widest, j.radius);
    }
    mask[i] = m;
  }
  // Diffusion spreads about √iterations edges: enough to span the widest joint.
  const iterations = Math.min(400, Math.max(4, Math.ceil((widest / Math.max(1e-6, graph.spacing)) ** 2 * 0.5)));
  const next = new Float32Array(w.length);
  for (let it = 0; it < iterations; it++) {
    next.set(w);
    for (let i = 0; i < n; i++) {
      const m = mask[i]!;
      if (m <= 0) continue;
      const o0 = graph.offsets[i]!, o1 = graph.offsets[i + 1]!;
      const deg = o1 - o0;
      if (!deg) continue;
      for (let j = 0; j < k; j++) {
        const b = bone[i * SLOTS + j]!;
        if (b < 0) continue;
        let sum = w[i * SLOTS + j]!;
        for (let e = o0; e < o1; e++) sum += weightOf(bone, w, graph.adj[e]!, b);
        next[i * SLOTS + j] = w[i * SLOTS + j]! * (1 - m) + (sum / (deg + 1)) * m;
      }
    }
    w.set(next);
  }
}

function weightOf(bone: Int16Array, w: Float32Array, i: number, b: number): number {
  const base = i * SLOTS;
  for (let j = 0; j < SLOTS; j++) if (bone[base + j] === b) return w[base + j]!;
  return 0;
}

/**
 * Tidy one point: drop weights under 1%, keep the strongest `INFLUENCES`,
 * sum to one, strongest first. A point that would lose everything keeps its
 * strongest bone whole.
 */
function settle(bone: Int16Array, w: Float32Array, i: number): void {
  const base = i * SLOTS;
  const items: Array<[number, number]> = [];
  for (let j = 0; j < SLOTS; j++) {
    const b = bone[base + j]!;
    if (b >= 0 && w[base + j]! > 0) items.push([b, w[base + j]!]);
  }
  items.sort((x, y) => y[1] - x[1]);
  let kept = items.slice(0, INFLUENCES).filter(([, v], idx) => idx === 0 || v >= 0.01);
  const sum = kept.reduce((a, [, v]) => a + v, 0);
  if (sum <= 1e-12) kept = items.length ? [[items[0]![0], 1]] : [];
  for (let j = 0; j < SLOTS; j++) {
    bone[base + j] = j < kept.length ? kept[j]![0] : -1;
    w[base + j] = j < kept.length ? kept[j]![1] / (sum > 1e-12 ? sum : 1) : 0;
  }
}

// ── Paint ────────────────────────────────────────────────────────────────────

/** A dab's reach: 1 at the centre, 0 at the radius, smooth both ends. */
export function brushFalloff(dist: number, radius: number): number {
  if (dist >= radius) return 0;
  const t = 1 - dist / radius;
  return t * t * (3 - 2 * t);
}

/**
 * Replay painted strokes over weights (a copy — the input is a memo's). A
 * stroke whose bone is not a deform bone of this rig paints nothing.
 */
export function paintWeights(base: Weights, graph: WeightGraph, strokes: readonly WeightStroke[]): Weights {
  if (!strokes.length) return base;
  const out: Weights = { count: base.count, bones: base.bones, bone: base.bone.slice(), w: base.w.slice(), nearest: base.nearest };
  const index = new Map(base.bones.map((id, i) => [id, i]));
  const cell = Math.max(1e-6, graph.spacing);
  const buckets = bucketPoints(graph, cell * 4);
  for (const stroke of strokes) {
    const b = index.get(stroke.bone);
    if (b === undefined) continue;
    const pts = stroke.points;
    for (let q = 0; q + 3 < pts.length; q += 4) applyDab(out, graph, buckets, b, stroke, pts[q]!, pts[q + 1]!, pts[q + 2]!, pts[q + 3]!);
  }
  return out;
}

/** Apply ONE dab — the live brush calls this per dab; the replay calls it for every stored one. */
export function applyDab(
  weights: Weights,
  graph: WeightGraph,
  buckets: PointBuckets,
  b: number,
  stroke: Pick<WeightStroke, "mode" | "strength" | "radius">,
  x: number,
  y: number,
  z: number,
  pressure: number,
): void {
  const r = stroke.radius;
  const touched: Array<[number, number]> = [];
  buckets.near(x, y, z, r, (i) => {
    const dx = graph.local[i * 3]! - x, dy = graph.local[i * 3 + 1]! - y, dz = graph.local[i * 3 + 2]! - z;
    const f = brushFalloff(Math.hypot(dx, dy, dz), r) * Math.max(0, Math.min(1, pressure));
    if (f > 0) touched.push([i, f]);
  });
  if (!touched.length) return;
  const amount = stroke.strength;
  if (stroke.mode === "smooth") {
    // Against the neighbours as they were before this dab, so the result does
    // not depend on the order points are visited.
    const before = touched.map(([i]) => neighbourMean(weights, graph, i));
    touched.forEach(([i, f], t) => blendToward(weights, i, before[t]!, amount * f));
    return;
  }
  for (const [i, f] of touched) {
    const now = weightOf(weights.bone, weights.w, i, b);
    const next =
      stroke.mode === "add" ? now + amount * f :
      stroke.mode === "subtract" ? now - amount * f :
      now + (amount - now) * f;
    setHeld(weights, graph, i, b, Math.max(0, Math.min(1, next)));
  }
}

/**
 * Set bone `b` to `v` on point `i` and let the others share `1 − v` in the
 * proportions they had. With no others to take it, the remainder goes to the
 * neighbours' strongest other bone — so subtracting a point's only bone hands
 * it to the bone beside it rather than doing nothing (Blender's quirk).
 */
function setHeld(weights: Weights, graph: WeightGraph, i: number, b: number, v: number): void {
  const base = i * SLOTS;
  let slot = -1, others = 0;
  for (let j = 0; j < SLOTS; j++) {
    const x = weights.bone[base + j]!;
    if (x === b) slot = j;
    else if (x >= 0) others += weights.w[base + j]!;
  }
  if (slot < 0) {
    // A bone the point did not carry: take the weakest slot.
    let weakest = 0;
    for (let j = 0; j < SLOTS; j++) {
      if (weights.bone[base + j]! < 0) {
        weakest = j;
        break;
      }
      if (weights.w[base + j]! < weights.w[base + weakest]!) weakest = j;
    }
    if (weights.bone[base + weakest]! >= 0) others -= weights.w[base + weakest]!;
    weights.bone[base + weakest] = b;
    slot = weakest;
  }
  weights.w[base + slot] = v;
  const rest = 1 - v;
  if (others > 1e-9) {
    for (let j = 0; j < SLOTS; j++) if (j !== slot && weights.bone[base + j]! >= 0) weights.w[base + j] = (weights.w[base + j]! / others) * rest;
  } else if (rest > 1e-9) {
    const heir = strongestNearby(weights, graph, i, b);
    if (heir >= 0) {
      let free = -1;
      for (let j = 0; j < SLOTS; j++) if (j !== slot && weights.bone[base + j]! < 0) {
        free = j;
        break;
      }
      if (free >= 0) (weights.bone[base + free] = heir), (weights.w[base + free] = rest);
      else weights.w[base + slot] = 1;
    } else weights.w[base + slot] = 1;
  }
  settle(weights.bone, weights.w, i);
}

function strongestNearby(weights: Weights, graph: WeightGraph, i: number, not: number): number {
  const score = new Map<number, number>();
  for (let e = graph.offsets[i]!; e < graph.offsets[i + 1]!; e++) {
    const n = graph.adj[e]!;
    for (let j = 0; j < SLOTS; j++) {
      const x = weights.bone[n * SLOTS + j]!;
      if (x >= 0 && x !== not) score.set(x, (score.get(x) ?? 0) + weights.w[n * SLOTS + j]!);
    }
  }
  let best = -1, top = 0;
  for (const [x, v] of score) if (v > top) (best = x), (top = v);
  if (best >= 0) return best;
  // Nobody around carries another bone: the next-nearest bone takes it.
  const first = weights.nearest[i * 2]!, second = weights.nearest[i * 2 + 1]!;
  return first !== not ? first : second;
}

function neighbourMean(weights: Weights, graph: WeightGraph, i: number): Map<number, number> {
  const acc = new Map<number, number>();
  const o0 = graph.offsets[i]!, o1 = graph.offsets[i + 1]!;
  const n = o1 - o0 + 1;
  const add = (p: number) => {
    for (let j = 0; j < SLOTS; j++) {
      const x = weights.bone[p * SLOTS + j]!;
      if (x >= 0) acc.set(x, (acc.get(x) ?? 0) + weights.w[p * SLOTS + j]! / n);
    }
  };
  add(i);
  for (let e = o0; e < o1; e++) add(graph.adj[e]!);
  return acc;
}

function blendToward(weights: Weights, i: number, target: Map<number, number>, t: number): void {
  const base = i * SLOTS;
  const mix = new Map<number, number>();
  for (let j = 0; j < SLOTS; j++) {
    const x = weights.bone[base + j]!;
    if (x >= 0) mix.set(x, weights.w[base + j]! * (1 - t));
  }
  for (const [x, v] of target) mix.set(x, (mix.get(x) ?? 0) + v * t);
  const items = [...mix.entries()].sort((a, b) => b[1] - a[1]).slice(0, SLOTS);
  for (let j = 0; j < SLOTS; j++) {
    weights.bone[base + j] = j < items.length ? items[j]![0] : -1;
    weights.w[base + j] = j < items.length ? items[j]![1] : 0;
  }
  settle(weights.bone, weights.w, i);
}

// ── Finding points near a dab ────────────────────────────────────────────────

export interface PointBuckets {
  near(x: number, y: number, z: number, r: number, visit: (i: number) => void): void;
}

/** A uniform hash grid over the graph's own-space points. */
export function bucketPoints(graph: WeightGraph, cell: number): PointBuckets {
  const map = new Map<string, number[]>();
  const keyOf = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < graph.count; i++) {
    const k = keyOf(graph.local[i * 3]!, graph.local[i * 3 + 1]!, graph.local[i * 3 + 2]!);
    const list = map.get(k);
    if (list) list.push(i);
    else map.set(k, [i]);
  }
  return {
    near(x, y, z, r, visit) {
      const x0 = Math.floor((x - r) / cell), x1 = Math.floor((x + r) / cell);
      const y0 = Math.floor((y - r) / cell), y1 = Math.floor((y + r) / cell);
      const z0 = Math.floor((z - r) / cell), z1 = Math.floor((z + r) / cell);
      for (let a = x0; a <= x1; a++) for (let b = y0; b <= y1; b++) for (let c = z0; c <= z1; c++) {
        const list = map.get(`${a},${b},${c}`);
        if (list) for (const i of list) visit(i);
      }
    },
  };
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** The weight of bone id `id` on point `i` (0 when it has none). */
export function weightAt(weights: Weights, i: number, id: string): number {
  const b = weights.bones.indexOf(id);
  return b < 0 ? 0 : weightOf(weights.bone, weights.w, i, b);
}

/** Point `i`'s bones and weights, strongest first. */
export function influencesAt(weights: Weights, i: number): Array<{ bone: string; weight: number }> {
  const out: Array<{ bone: string; weight: number }> = [];
  for (let j = 0; j < SLOTS; j++) {
    const b = weights.bone[i * SLOTS + j]!;
    if (b >= 0 && weights.w[i * SLOTS + j]! > 0) out.push({ bone: weights.bones[b]!, weight: weights.w[i * SLOTS + j]! });
  }
  return out;
}
