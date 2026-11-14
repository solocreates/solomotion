import type { Vec2 } from "../../schema/common";
import { applyHomography, solveLinear, type Homography } from "../pose";

/**
 * ONE MOTION FROM MANY FEATURES — RANSAC over a model whose degrees of freedom
 * are exactly the channels being solved.
 *
 * A crowd of tracked corners is mostly right and partly lying: a hand passes
 * over the sign, a reflection slides across the screen, a corner on the edge of
 * the region was really background. Averaging lets the liars drag the answer.
 * RANSAC asks the crowd which minimal subset most of it agrees with, then fits
 * that majority properly. That is the difference between a planar tracker that
 * survives an occlusion and one that slides off with it.
 *
 * The model is chosen from the channels, from cheapest to richest:
 *
 *   translation   position only                          1 point
 *   zoom          + scale                                2 points
 *   rigid         + rotation (scale held)                2 points
 *   similarity    + rotation + scale                     2 points
 *   affine        + skew (independent axes)              3 points
 *   homography    + perspective                          4 points
 *
 * Asking for less is not a loss of accuracy; it is a constraint. A position-
 * only track of a turning object should NOT rotate, and fitting a homography
 * to it would invent perspective out of noise.
 */

export type MotionModel = "translation" | "zoom" | "rigid" | "similarity" | "affine" | "homography";

export function modelFor(channels: readonly string[]): MotionModel {
  if (channels.includes("perspective")) return "homography";
  if (channels.includes("skew")) return "affine";
  const s = channels.includes("scale");
  const r = channels.includes("rotation");
  if (r && s) return "similarity";
  if (r) return "rigid";
  if (s) return "zoom";
  return "translation";
}

const MIN_POINTS: Record<MotionModel, number> = { translation: 1, zoom: 2, rigid: 2, similarity: 2, affine: 3, homography: 4 };

export function minPointsFor(model: MotionModel): number {
  return MIN_POINTS[model];
}

/** Least-squares fit of `model` mapping `src[i]` → `dst[i]`. Null when degenerate. */
export function fitModel(model: MotionModel, src: Vec2[], dst: Vec2[]): Homography | null {
  const n = src.length;
  if (n < MIN_POINTS[model]) return null;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i]!.x;
    sy += src[i]!.y;
    dx += dst[i]!.x;
    dy += dst[i]!.y;
  }
  sx /= n; sy /= n; dx /= n; dy /= n;
  if (model === "translation") return [1, 0, dx - sx, 0, 1, dy - sy, 0, 0, 1];

  if (model === "zoom" || model === "rigid" || model === "similarity") {
    // Umeyama in 2D: rotation from the cross/dot sums, scale from the spread.
    let a = 0, b = 0, ss = 0;
    for (let i = 0; i < n; i++) {
      const x = src[i]!.x - sx, y = src[i]!.y - sy;
      const u = dst[i]!.x - dx, v = dst[i]!.y - dy;
      a += x * u + y * v;
      b += x * v - y * u;
      ss += x * x + y * y;
    }
    if (ss < 1e-9) return null;
    let cos: number, sin: number, s: number;
    if (model === "zoom") {
      cos = 1;
      sin = 0;
      s = a / ss;
    } else {
      const th = Math.atan2(b, a);
      cos = Math.cos(th);
      sin = Math.sin(th);
      s = model === "rigid" ? 1 : Math.hypot(a, b) / ss;
    }
    if (!(s > 1e-6)) return null;
    const A = s * cos, B = s * sin;
    // dst = s·R·(src − c_s) + c_d
    return [A, -B, dx - (A * sx - B * sy), B, A, dy - (B * sx + A * sy), 0, 0, 1];
  }

  if (model === "affine") {
    // Two 3-unknown least-squares problems sharing one normal matrix.
    let xx = 0, xy = 0, yy = 0, xu = 0, yu = 0, xv = 0, yv = 0;
    for (let i = 0; i < n; i++) {
      const x = src[i]!.x - sx, y = src[i]!.y - sy;
      const u = dst[i]!.x - dx, v = dst[i]!.y - dy;
      xx += x * x; xy += x * y; yy += y * y;
      xu += x * u; yu += y * u; xv += x * v; yv += y * v;
    }
    const det = xx * yy - xy * xy;
    if (Math.abs(det) < 1e-9) return null;
    const a = (xu * yy - yu * xy) / det;
    const c = (yu * xx - xu * xy) / det;
    const b = (xv * yy - yv * xy) / det;
    const d = (yv * xx - xv * xy) / det;
    return [a, c, dx - (a * sx + c * sy), b, d, dy - (b * sx + d * sy), 0, 0, 1];
  }

  return fitHomography(src, dst);
}

/**
 * Normalised DLT (Hartley): move both point sets to zero mean and √2 mean
 * distance first, solve there, map back. Without the normalisation the 8×8
 * system mixes pixel-squared and unit-sized terms and is ill-conditioned
 * exactly when it matters — a small, distant plane.
 */
function fitHomography(src: Vec2[], dst: Vec2[]): Homography | null {
  const Ts = normaliser(src);
  const Td = normaliser(dst);
  const s = src.map((p) => applyHomography(Ts, p));
  const d = dst.map((p) => applyHomography(Td, p));
  const AtA: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const Atb = new Array<number>(8).fill(0);
  const add = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] = Atb[i]! + row[i]! * rhs;
      const r = AtA[i]!;
      for (let j = 0; j < 8; j++) r[j] = r[j]! + row[i]! * row[j]!;
    }
  };
  for (let i = 0; i < s.length; i++) {
    const { x, y } = s[i]!;
    const { x: u, y: v } = d[i]!;
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solveLinear(AtA, Atb);
  if (!h) return null;
  const Hn: Homography = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
  // H = Td⁻¹ · Hn · Ts
  const TdInv = invertSimilarity(Td);
  return normalise(mul(TdInv, mul(Hn, Ts)));
}

function normaliser(pts: Vec2[]): Homography {
  let mx = 0, my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p.x - mx, p.y - my);
  d /= pts.length;
  const k = d > 1e-9 ? Math.SQRT2 / d : 1;
  return [k, 0, -k * mx, 0, k, -k * my, 0, 0, 1];
}

function invertSimilarity(T: Homography): Homography {
  const k = T[0];
  return [1 / k, 0, -T[2] / k, 0, 1 / k, -T[5] / k, 0, 0, 1];
}

function mul(A: Homography, B: Homography): Homography {
  const o = new Array(9).fill(0) as Homography;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = A[r * 3]! * B[c]! + A[r * 3 + 1]! * B[3 + c]! + A[r * 3 + 2]! * B[6 + c]!;
  return o;
}

function normalise(H: Homography): Homography | null {
  const k = H[8];
  if (!Number.isFinite(k) || Math.abs(k) < 1e-12) return null;
  return H.map((v) => v / k) as Homography;
}

export interface RansacResult {
  model: Homography;
  inliers: boolean[];
  inlierCount: number;
  /** RMS reprojection error over the inliers, px. */
  rms: number;
}

/**
 * Robust fit. `threshold` is the reprojection distance (px) under which a pair
 * counts as agreeing. Iterations adapt to the inlier ratio found so far (99%
 * confidence), capped, with a seeded generator so a re-solve is reproducible.
 */
export function ransac(model: MotionModel, src: Vec2[], dst: Vec2[], threshold: number, random: () => number, maxIterations = 200): RansacResult | null {
  const n = src.length;
  const k = MIN_POINTS[model];
  if (n < k) return null;
  const t2 = threshold * threshold;
  let bestCount = -1;
  let bestInliers: boolean[] = [];
  let iterations = n === k ? 1 : maxIterations;
  const pick = new Array<number>(k);
  for (let it = 0; it < iterations; it++) {
    for (let j = 0; j < k; j++) {
      let idx: number;
      do idx = Math.floor(random() * n);
      while (pick.slice(0, j).includes(idx));
      pick[j] = idx;
    }
    const H = fitModel(model, pick.map((i) => src[i]!), pick.map((i) => dst[i]!));
    if (!H) continue;
    const inliers = new Array<boolean>(n);
    let count = 0;
    for (let i = 0; i < n; i++) {
      const p = applyHomography(H, src[i]!);
      const ex = p.x - dst[i]!.x;
      const ey = p.y - dst[i]!.y;
      const hit = ex * ex + ey * ey <= t2;
      inliers[i] = hit;
      if (hit) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestInliers = inliers;
      // Adaptive stop: enough iterations to have drawn an all-inlier sample with 99% confidence.
      const w = count / n;
      const denom = Math.log(1 - Math.pow(w, k));
      if (denom < 0) iterations = Math.min(maxIterations, Math.ceil(Math.log(0.01) / denom));
      if (count === n) break;
    }
  }
  if (bestCount < k) return null;
  // Local optimisation (LO-RANSAC): the minimal sample that won is the noisiest
  // estimate in the set. Refit on its inliers, re-select inliers under the
  // refit, and refit again — two passes take a single-frame outlier from a
  // third of a pixel to the noise floor for the price of two least squares.
  let inliers = bestInliers;
  let refined: Homography | null = null;
  for (let pass = 0; pass < 2; pass++) {
    const inSrc: Vec2[] = [];
    const inDst: Vec2[] = [];
    for (let i = 0; i < n; i++)
      if (inliers[i]) {
        inSrc.push(src[i]!);
        inDst.push(dst[i]!);
      }
    const next = fitModel(model, inSrc, inDst);
    if (!next) break;
    refined = next;
    const again = new Array<boolean>(n);
    let count = 0;
    for (let i = 0; i < n; i++) {
      const p = applyHomography(refined, src[i]!);
      const hit = (p.x - dst[i]!.x) ** 2 + (p.y - dst[i]!.y) ** 2 <= t2;
      again[i] = hit;
      if (hit) count++;
    }
    if (count < k) break;
    inliers = again;
  }
  if (!refined) return null;
  let se = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!inliers[i]) continue;
    const p = applyHomography(refined, src[i]!);
    se += (p.x - dst[i]!.x) ** 2 + (p.y - dst[i]!.y) ** 2;
    count++;
  }
  return { model: refined, inliers, inlierCount: count, rms: Math.sqrt(se / Math.max(1, count)) };
}
