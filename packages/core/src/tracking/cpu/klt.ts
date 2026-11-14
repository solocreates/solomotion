import type { Vec2 } from "../../schema/common";
import type { AnalysisFrame } from "../engine";
import { bilinear, gradients, pyramidOf, type Level } from "./image";

/**
 * FEATURES — corners worth following, and following them.
 *
 * Shi–Tomasi picks points whose neighbourhood changes in BOTH directions (the
 * smaller eigenvalue of the structure tensor is large): a corner, a speck, a
 * letter — never an edge, which can slide along itself unnoticed. Pyramidal
 * Lucas–Kanade (Bouguet's formulation) then finds where each one went, coarse
 * to fine, so a fast move that would overshoot a small window at full size is
 * a small move at the top of the pyramid.
 *
 * This is the measuring half of the planar tracker. On its own a single
 * feature drifts and lies; the RANSAC fit in `fit.ts` is what turns a crowd of
 * them into one honest answer.
 */

export interface DetectOptions {
  /** Most features to return. */
  max: number;
  /** Minimum distance between two features, px. */
  minDistance: number;
  /** Relative quality: keep corners at least this fraction of the best one (0..1). */
  quality: number;
  /** Structure-tensor window half-size. */
  half: number;
}

/**
 * Corners inside `inside(x, y)`, strongest first, spaced at least
 * `minDistance` apart. Only the bounding box of the region is scanned.
 */
export function detectCorners(
  frame: AnalysisFrame,
  box: { x0: number; y0: number; x1: number; y1: number },
  inside: (x: number, y: number) => boolean,
  opt: DetectOptions,
): Vec2[] {
  const lvl = pyramidOf(frame, 1).levels[0]!;
  const { gx, gy } = gradients(lvl);
  const { w, h } = lvl;
  const m = opt.half + 1;
  const x0 = Math.max(m, Math.floor(box.x0));
  const y0 = Math.max(m, Math.floor(box.y0));
  const x1 = Math.min(w - 1 - m, Math.ceil(box.x1));
  const y1 = Math.min(h - 1 - m, Math.ceil(box.y1));
  if (x1 <= x0 || y1 <= y0) return [];

  // Score every pixel on a stride-1 grid inside the box (boxes are small: a
  // region, not a frame), using running sums per row of the tensor terms.
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const score = new Float32Array(bw * bh);
  let best = 0;
  const r = opt.half;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!inside(x, y)) continue;
      let a = 0;
      let b = 0;
      let c = 0;
      for (let dy = -r; dy <= r; dy++) {
        const row = (y + dy) * w;
        for (let dx = -r; dx <= r; dx++) {
          const i = row + x + dx;
          const ix = gx[i]!;
          const iy = gy[i]!;
          a += ix * ix;
          b += ix * iy;
          c += iy * iy;
        }
      }
      // Smaller eigenvalue of [[a b][b c]].
      const lam = (a + c) / 2 - Math.sqrt(((a - c) * (a - c)) / 4 + b * b);
      score[(y - y0) * bw + (x - x0)] = lam;
      if (lam > best) best = lam;
    }
  }
  if (best <= 0) return [];
  const floor = best * opt.quality;

  // Local maxima (3×3) above the floor, then greedy spacing by strength.
  const cands: Array<{ x: number; y: number; s: number }> = [];
  for (let y = 1; y < bh - 1; y++) {
    for (let x = 1; x < bw - 1; x++) {
      const s = score[y * bw + x]!;
      if (s < floor) continue;
      let peak = true;
      for (let dy = -1; dy <= 1 && peak; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx || dy) && score[(y + dy) * bw + x + dx]! > s) {
            peak = false;
            break;
          }
        }
      if (peak) cands.push({ x: x + x0, y: y + y0, s });
    }
  }
  cands.sort((p, q) => q.s - p.s);
  const out: Vec2[] = [];
  const d2 = opt.minDistance * opt.minDistance;
  for (const c of cands) {
    if (out.length >= opt.max) break;
    let ok = true;
    for (const o of out) {
      const dx = o.x - c.x;
      const dy = o.y - c.y;
      if (dx * dx + dy * dy < d2) {
        ok = false;
        break;
      }
    }
    if (ok) out.push({ x: c.x, y: c.y });
  }
  return out;
}

export interface LkOptions {
  /** Window half-size at every level (7 → a 15×15 window). */
  half: number;
  /** Pyramid levels above full size. */
  levels: number;
  iterations: number;
  /** Stop iterating once an update is smaller than this, px. */
  epsilon: number;
}

export interface LkResult {
  /** Where each point went (only meaningful where `ok`). */
  points: Vec2[];
  ok: boolean[];
  /** Mean absolute intensity residual over the window, per point. */
  error: number[];
}

/**
 * Track `from` (points in `prev`) into `next`. `guess` seeds each point's
 * displacement — the motion predicted by the previous step — so a steady pan
 * costs one iteration instead of a full search.
 */
export function trackPoints(prev: AnalysisFrame, next: AnalysisFrame, from: Vec2[], guess: Vec2[] | null, opt: LkOptions): LkResult {
  const P = pyramidOf(prev, opt.levels + 1).levels;
  const N = pyramidOf(next, opt.levels + 1).levels;
  const top = Math.min(P.length, N.length) - 1;
  const points: Vec2[] = [];
  const ok: boolean[] = [];
  const error: number[] = [];
  for (let k = 0; k < from.length; k++) {
    const p = from[k]!;
    const g0 = guess?.[k] ?? { x: 0, y: 0 };
    const r = trackOne(P, N, top, p, g0, opt);
    points.push(r ? { x: p.x + r.dx, y: p.y + r.dy } : p);
    ok.push(!!r);
    error.push(r ? r.err : Infinity);
  }
  return { points, ok, error };
}

function trackOne(P: Level[], N: Level[], top: number, p: Vec2, guess: Vec2, opt: LkOptions): { dx: number; dy: number; err: number } | null {
  const half = opt.half;
  const size = (2 * half + 1) * (2 * half + 1);
  const Iw = new Float32Array(size);
  const Gx = new Float32Array(size);
  const Gy = new Float32Array(size);
  // The guess is a full-resolution displacement; carry it down to the top level.
  let gxL = guess.x / (1 << top);
  let gyL = guess.y / (1 << top);
  let err = 0;
  for (let L = top; L >= 0; L--) {
    const I = P[L]!;
    const J = N[L]!;
    const { gx, gy } = gradients(I);
    const px = p.x / (1 << L);
    const py = p.y / (1 << L);
    if (px < half || py < half || px > I.w - 1 - half || py > I.h - 1 - half) {
      if (L === 0) return null;
      gxL *= 2;
      gyL *= 2;
      continue;
    }
    let a = 0;
    let b = 0;
    let c = 0;
    let k = 0;
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++, k++) {
        const x = px + dx;
        const y = py + dy;
        Iw[k] = bilinear(I.img, I.w, I.h, x, y);
        const ix = bilinear(gx, I.w, I.h, x, y);
        const iy = bilinear(gy, I.w, I.h, x, y);
        Gx[k] = ix;
        Gy[k] = iy;
        a += ix * ix;
        b += ix * iy;
        c += iy * iy;
      }
    }
    const det = a * c - b * b;
    const minEig = (a + c) / 2 - Math.sqrt(((a - c) * (a - c)) / 4 + b * b);
    // A flat or edge-only window has no unique answer at this level.
    if (det < 1e-6 || minEig / size < 1e-4) {
      if (L === 0) return null;
      gxL *= 2;
      gyL *= 2;
      continue;
    }
    let vx = 0;
    let vy = 0;
    for (let it = 0; it < opt.iterations; it++) {
      let bx = 0;
      let by = 0;
      let e = 0;
      k = 0;
      const ox = px + gxL + vx;
      const oy = py + gyL + vy;
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++, k++) {
          const diff = Iw[k]! - bilinear(J.img, J.w, J.h, ox + dx, oy + dy);
          bx += diff * Gx[k]!;
          by += diff * Gy[k]!;
          e += Math.abs(diff);
        }
      }
      const ex = (c * bx - b * by) / det;
      const ey = (a * by - b * bx) / det;
      vx += ex;
      vy += ey;
      err = e / size;
      if (ex * ex + ey * ey < opt.epsilon * opt.epsilon) break;
    }
    if (L > 0) {
      gxL = 2 * (gxL + vx);
      gyL = 2 * (gyL + vy);
    } else {
      gxL += vx;
      gyL += vy;
    }
  }
  const fx = p.x + gxL;
  const fy = p.y + gyL;
  const J0 = N[0]!;
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx < 0 || fy < 0 || fx > J0.w - 1 || fy > J0.h - 1) return null;
  return { dx: gxL, dy: gyL, err };
}
