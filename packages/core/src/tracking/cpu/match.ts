import type { TrackRegion, TrackSolve } from "../../schema/tracking";
import type { Vec2 } from "../../schema/common";
import { clamp, lumaAt, type AnalysisFrame } from "../engine";
import { regionBounds, regionPolylines } from "../contour";
import { posePoint, unposePoint, type RegionPose } from "../pose";

/**
 * NORMALISED CROSS-CORRELATION over a CONTOUR.
 *
 * NCC subtracts each patch's mean and divides by its energy, which is what makes
 * it survive a lighting change — the property that separates a tracker that
 * works on real footage from one that works on a test pattern.
 *
 * What v77 changed is the MASK. The old engine had a boolean for "treat the box
 * as an ellipse", which was a special case bolted on because an ellipse was the
 * only non-rectangular thing the app could draw. Now the template is masked by
 * the REGION'S OWN CONTOUR, whatever it is — a rectangle, a circle, a polygon,
 * a pen path around a face. Background inside the bounding box simply never
 * enters the correlation, and a tight outline is therefore a tighter lock rather
 * than merely a prettier overlay. One code path, four tools, better results.
 */

export interface Template {
  w: number;
  h: number;
  /** Row-major luma, mean-subtracted (0 on masked cells). */
  lum: Float32Array;
  /** 1 where the cell is inside the contour. */
  keep: Uint8Array;
  kept: number;
  /** sqrt(Σ lum²) over kept cells. */
  norm: number;
  /** The region-local half-extent the grid covers, for scaling the sample. */
  halfW: number;
  halfH: number;
}

/** Cap the grid so a correlation costs the same on a 4K plate as on a 720p one. */
const MAX_DIM = 32;

/** Even-odd point-in-polygon over the flattened contour rings. */
export function insideRings(rings: Vec2[][], x: number, y: number): boolean {
  let hit = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!;
      const b = ring[j]!;
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
    }
  }
  return hit;
}

/**
 * Lift a template from a frame at a pose. The grid spans the region's local
 * bounding box; a cell counts only when its centre falls inside the contour.
 */
export function buildTemplate(frame: AnalysisFrame, region: TrackRegion, pose: RegionPose): Template {
  const b = regionBounds(region);
  const sy = pose.scaleY ?? pose.scale;
  const pxW = Math.max(2, b.width * pose.scale);
  const pxH = Math.max(2, b.height * sy);
  const w = Math.max(2, Math.min(MAX_DIM, Math.round(pxW)));
  const h = Math.max(2, Math.min(MAX_DIM, Math.round(pxH)));

  // The mask is taken in region-local space at unit pose, so it is the shape
  // itself and not the shape as it happens to sit this frame.
  const rings = regionPolylines(region, { x: 0, y: 0, scale: 1, scaleY: null, rotation: 0 });
  const halfW = b.width / 2;
  const halfH = b.height / 2;

  const lum = new Float32Array(w * h);
  const keep = new Uint8Array(w * h);
  let mean = 0;
  let kept = 0;
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const i = v * w + u;
      const lx = ((u + 0.5) / w - 0.5) * b.width;
      const ly = ((v + 0.5) / h - 0.5) * b.height;
      if (!insideRings(rings, lx, ly)) continue;
      const p = posePoint({ x: lx, y: ly }, pose);
      lum[i] = lumaAt(frame, Math.round(p.x), Math.round(p.y));
      keep[i] = 1;
      mean += lum[i]!;
      kept++;
    }
  }
  mean /= kept || 1;
  let norm = 0;
  for (let i = 0; i < lum.length; i++) {
    if (!keep[i]) continue;
    lum[i]! -= mean;
    norm += lum[i]! * lum[i]!;
  }
  return { w, h, lum, keep, kept: kept || 1, norm: Math.sqrt(norm) || 1e-6, halfW, halfH };
}

/** NCC of `tpl` placed at a pose. [-1, 1]; higher is better. */
export function nccAt(frame: AnalysisFrame, tpl: Template, pose: RegionPose): number {
  const placed = placeTemplate(tpl, pose);
  return nccPlaced(frame, tpl, placed, pose.x, pose.y);
}

/**
 * A template's kept cells as frame offsets from the pose's centre, at one
 * scale / rotation / skew / perspective. Translation only ADDS to these
 * (`posePoint` is T·(the rest)), so a translation search transforms each cell
 * once instead of once per candidate — the difference between a second and a
 * few milliseconds a frame.
 */
interface Placed {
  dx: Float32Array;
  dy: Float32Array;
  /** The same offsets rounded, and their extent — the integer fast path. */
  ix: Int32Array;
  iy: Int32Array;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Linear offsets for a frame of `rowWidth`, built on first use. */
  linear: Int32Array | null;
  rowWidth: number;
  /** Index into `tpl.lum` for each placed cell. */
  cell: Int32Array;
  /** Mean distance between neighbouring cells, frame px — the coarse step that cannot skip a peak. */
  spacing: number;
}

function placeTemplate(tpl: Template, pose: RegionPose): Placed {
  const { w, h, keep, halfW, halfH } = tpl;
  const at0 = { ...pose, x: 0, y: 0 };
  const dx = new Float32Array(tpl.kept);
  const dy = new Float32Array(tpl.kept);
  const cell = new Int32Array(tpl.kept);
  let k = 0;
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const i = v * w + u;
      if (!keep[i]) continue;
      const p = posePoint({ x: ((u + 0.5) / w - 0.5) * halfW * 2, y: ((v + 0.5) / h - 0.5) * halfH * 2 }, at0);
      dx[k] = p.x;
      dy[k] = p.y;
      cell[k++] = i;
    }
  }
  const sy = pose.scaleY ?? pose.scale;
  const spacing = Math.max(1, Math.min((halfW * 2 * pose.scale) / w, (halfH * 2 * sy) / h));
  const ix = new Int32Array(k);
  const iy = new Int32Array(k);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let j = 0; j < k; j++) {
    ix[j] = Math.round(dx[j]!);
    iy[j] = Math.round(dy[j]!);
    minX = Math.min(minX, ix[j]!);
    maxX = Math.max(maxX, ix[j]!);
    minY = Math.min(minY, iy[j]!);
    maxY = Math.max(maxY, iy[j]!);
  }
  return { dx: dx.subarray(0, k), dy: dy.subarray(0, k), ix, iy, minX, maxX, minY, maxY, linear: null, rowWidth: 0, cell: cell.subarray(0, k), spacing };
}

/**
 * NCC of a placed template centred at (cx, cy), no allocation.
 *
 * ONE pass: the template is mean-subtracted, so Σ(w − w̄)·t = Σ w·t, and the
 * window's energy is Σw² − n·w̄². At an integer centre with the template wholly
 * inside the frame (nearly every candidate of a search), cells are precomputed
 * linear offsets — no rounding, no clamping, one array read each.
 */
function nccPlaced(frame: AnalysisFrame, tpl: Template, placed: Placed, cx: number, cy: number): number {
  const { dx, dy, cell } = placed;
  const { luma, width: fw, height: fh } = frame;
  const n = cell.length;
  if (n === 0) return 0;
  const icx = cx | 0;
  const icy = cy | 0;
  if (icx === cx && icy === cy && icx + placed.minX >= 0 && icx + placed.maxX < fw && icy + placed.minY >= 0 && icy + placed.maxY < fh) {
    if (placed.rowWidth !== fw || !placed.linear) {
      const lin = new Int32Array(n);
      for (let k = 0; k < n; k++) lin[k] = placed.iy[k]! * fw + placed.ix[k]!;
      placed.linear = lin;
      placed.rowWidth = fw;
    }
    const lin = placed.linear;
    const base = icy * fw + icx;
    const lum = tpl.lum;
    let sum = 0;
    let sum2 = 0;
    let dot = 0;
    for (let k = 0; k < n; k++) {
      const v = luma[base + lin[k]!]!;
      sum += v;
      sum2 += v * v;
      dot += v * lum[cell[k]!]!;
    }
    const energy = sum2 - (sum * sum) / n;
    return dot / (tpl.norm * (Math.sqrt(energy > 0 ? energy : 0) || 1e-6));
  }
  let mean = 0;
  for (let k = 0; k < n; k++) {
    let x = Math.round(cx + dx[k]!);
    let y = Math.round(cy + dy[k]!);
    x = x < 0 ? 0 : x >= fw ? fw - 1 : x;
    y = y < 0 ? 0 : y >= fh ? fh - 1 : y;
    mean += luma[y * fw + x]!;
  }
  mean /= n;
  let dot = 0;
  let wnorm = 0;
  const lum = tpl.lum;
  for (let k = 0; k < n; k++) {
    let x = Math.round(cx + dx[k]!);
    let y = Math.round(cy + dy[k]!);
    x = x < 0 ? 0 : x >= fw ? fw - 1 : x;
    y = y < 0 ? 0 : y >= fh ? fh - 1 : y;
    const d = luma[y * fw + x]! - mean;
    dot += d * lum[cell[k]!]!;
    wnorm += d * d;
  }
  return dot / (tpl.norm * (Math.sqrt(wnorm) || 1e-6));
}

/** How much better (NCC) a changed scale or rotation must score than no change. */
const CHANGE_MARGIN = 0.02;

export interface Hit extends RegionPose {
  score: number;
}

/**
 * Search for the best pose near a prior, coarse to fine.
 *
 * Translation (and scale) first at the prior rotation, then a bounded 1-D
 * rotation refine — so rotation costs a handful of extra correlations rather
 * than a whole extra search dimension. `accuracy` (0..1) widens the search and
 * tightens the final step together, because "more accurate, slower" is the only
 * thing a person can reason about; the three numbers underneath it are not
 * independently meaningful.
 */
export function searchPose(
  frame: AnalysisFrame,
  tpl: Template,
  prior: RegionPose,
  solve: TrackSolve,
  radiusPx: number,
): Hit {
  const solveScale = solve.channels.includes("scale");
  const solveRot = solve.channels.includes("rotation");
  const fine = solve.accuracy >= 0.75 ? 0.5 : 1;

  let best: Hit = { ...prior, score: -Infinity };
  const scales = solveScale
    ? [prior.scale, prior.scale * 0.96, prior.scale * 1.04]
    : [prior.scale];

  // Coarse to fine over translation, each scale's cells placed once. The
  // coarse step is the template's own cell spacing (capped): a correlation
  // peak is at least that wide, so the lattice cannot step over it.
  for (const s of scales) {
    const placed = placeTemplate(tpl, { ...prior, scale: s, scaleY: prior.scaleY == null ? null : (prior.scaleY * s) / prior.scale });
    const coarse = Math.max(1, Math.min(4, Math.floor(placed.spacing)));
    let bx = prior.x;
    let by = prior.y;
    let bs = -Infinity;
    const scan = (cx: number, cy: number, r: number, step: number) => {
      for (let dy = -r; dy <= r; dy += step) {
        for (let dx = -r; dx <= r; dx += step) {
          const score = nccPlaced(frame, tpl, placed, cx + dx, cy + dy);
          if (score > bs) {
            bs = score;
            bx = cx + dx;
            by = cy + dy;
          }
        }
      }
    };
    // The integer lattice is the fast path; the half-pixel pass below stays exact.
    scan(Math.round(prior.x), Math.round(prior.y), radiusPx, coarse);
    for (let step = coarse >> 1; step >= 1; step >>= 1) scan(bx, by, step * 2, step);
    if (fine < 1) scan(bx, by, 1, fine);
    // A different scale must EARN it: on a region that is mostly plain
    // background the score barely moves with scale, and taking the best by a
    // hair let the size random-walk (1.0 → 1.4 in eight frames) until lock was
    // lost. The unchanged scale (tried first) wins unless clearly beaten.
    const margin = s === prior.scale ? 0 : CHANGE_MARGIN;
    if (bs > best.score + margin) best = { ...prior, x: bx, y: by, scale: s, scaleY: prior.scaleY == null ? null : (prior.scaleY * s) / prior.scale, score: bs };
  }

  if (solveRot) {
    for (const step of [3, 1]) {
      const base = best.rotation;
      for (let dr = -6; dr <= 6; dr += step) {
        const pose: RegionPose = { ...best, rotation: base + dr };
        const score = nccAt(frame, tpl, pose);
        // Same rule as scale: a turn has to be clearly better than none.
        if (score > best.score + (dr === 0 ? 0 : CHANGE_MARGIN)) best = { ...pose, score };
      }
    }
  }
  return best;
}

/**
 * PER-VERTEX REFINEMENT — the contour stops riding rigidly and starts following
 * the silhouette.
 *
 * Each vertex gets a small local patch, matched independently in a tight window
 * around where the rigid pose predicted it, and the resulting offsets are then
 * SMOOTHED along the contour. The smoothing is not cosmetic: an independent
 * per-vertex search on low-contrast footage produces a spiky mess, and a
 * contour is a curve whose neighbours genuinely constrain each other. This is
 * the cheap, honest version of planar/contour tracking — no mesh, no optical
 * flow field, no per-frame solve that takes a minute.
 *
 * Returns offsets in REGION-LOCAL space, parallel to `vertices`.
 */
export function refineWarp(
  frame: AnalysisFrame,
  reference: AnalysisFrame,
  vertices: Vec2[],
  pose: RegionPose,
  refPose: RegionPose,
  solve: TrackSolve,
): Vec2[] {
  const patch = solve.accuracy >= 0.75 ? 7 : 5;
  const reach = Math.max(2, Math.round(3 + solve.accuracy * 5));
  const raw: Vec2[] = [];

  for (const v of vertices) {
    const ref = posePoint(v, refPose);
    const here = posePoint(v, pose);
    let bestX = 0;
    let bestY = 0;
    let bestScore = -Infinity;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const score = patchNcc(reference, frame, ref, { x: here.x + dx, y: here.y + dy }, patch);
        if (score > bestScore) {
          bestScore = score;
          bestX = dx;
          bestY = dy;
        }
      }
    }
    // Back into region-local through the pose's own inverse.
    const at = unposePoint({ x: here.x + bestX, y: here.y + bestY }, pose);
    raw.push({ x: at.x - v.x, y: at.y - v.y });
  }

  return smoothAlongContour(raw, solve.accuracy);
}

/** NCC of a small square patch between two frames. */
function patchNcc(a: AnalysisFrame, b: AnalysisFrame, pa: Vec2, pb: Vec2, half: number): number {
  let ma = 0;
  let mb = 0;
  let n = 0;
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      ma += lumaAt(a, Math.round(pa.x + dx), Math.round(pa.y + dy));
      mb += lumaAt(b, Math.round(pb.x + dx), Math.round(pb.y + dy));
      n++;
    }
  }
  ma /= n;
  mb /= n;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const va = lumaAt(a, Math.round(pa.x + dx), Math.round(pa.y + dy)) - ma;
      const vb = lumaAt(b, Math.round(pb.x + dx), Math.round(pb.y + dy)) - mb;
      dot += va * vb;
      na += va * va;
      nb += vb * vb;
    }
  }
  return dot / (Math.sqrt(na * nb) || 1e-6);
}

/**
 * Blur the offsets around the ring. Strength falls as accuracy rises — at high
 * accuracy the per-vertex matches are trustworthy enough to keep their detail,
 * at low accuracy they need each other.
 */
function smoothAlongContour(offsets: Vec2[], accuracy: number): Vec2[] {
  const n = offsets.length;
  if (n < 3) return offsets;
  const k = 1 - accuracy * 0.6; // 1 → heavy, 0.4 → light
  return offsets.map((o, i) => {
    const p = offsets[(i - 1 + n) % n]!;
    const q = offsets[(i + 1) % n]!;
    const ax = (p.x + q.x) / 2;
    const ay = (p.y + q.y) / 2;
    return { x: o.x + (ax - o.x) * k, y: o.y + (ay - o.y) * k };
  });
}

/** Search radius in analysis px, from the accuracy dial and the region's size at this pose. */
export function searchRadiusFor(region: TrackRegion, solve: TrackSolve, pose: RegionPose): number {
  const b = regionBounds(region);
  const span = Math.max(b.width, b.height) * pose.scale;
  return clamp(Math.round(span * (0.35 + solve.accuracy * 0.5)), 6, 120);
}
