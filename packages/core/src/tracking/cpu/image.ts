import type { AnalysisFrame } from "../engine";

/**
 * IMAGE PYRAMIDS for the feature tracker — a frame at full analysis size and
 * each halving above it, smoothed, plus the spatial gradients Lucas–Kanade
 * reads. Float32 throughout: sub-pixel tracking is a sub-pixel interpolation
 * problem, and 8-bit levels quantise the very differences it solves on.
 *
 * Built lazily and kept per frame object (a WeakMap), so the frame that is
 * "next" in one step and "previous" in the following one is built once.
 */

export interface Level {
  w: number;
  h: number;
  img: Float32Array;
  /** Scharr gradients, built on first use (only the PREVIOUS frame of a step needs them). */
  gx: Float32Array | null;
  gy: Float32Array | null;
}

export interface Pyramid {
  levels: Level[];
}

const cache = new WeakMap<AnalysisFrame, Pyramid>();

/** Coarsest level kept at least this size — below it, a window sees the whole frame. */
const MIN_SIDE = 24;

export function pyramidOf(frame: AnalysisFrame, maxLevels: number): Pyramid {
  const hit = cache.get(frame);
  if (hit && hit.levels.length >= Math.min(maxLevels, possibleLevels(frame))) return hit;
  const levels: Level[] = [blurred(frame)];
  while (levels.length < maxLevels) {
    const prev = levels[levels.length - 1]!;
    if (prev.w < MIN_SIDE * 2 || prev.h < MIN_SIDE * 2) break;
    levels.push(downsample(prev));
  }
  const pyr = { levels };
  cache.set(frame, pyr);
  return pyr;
}

function possibleLevels(frame: AnalysisFrame): number {
  let n = 1;
  let w = frame.width;
  let h = frame.height;
  while (w >= MIN_SIDE * 2 && h >= MIN_SIDE * 2) {
    w >>= 1;
    h >>= 1;
    n++;
  }
  return n;
}

/** Level 0: the luma with a [1 2 1]/4 binomial in each direction — noise off, detail kept. */
function blurred(frame: AnalysisFrame): Level {
  const { width: w, height: h, luma } = frame;
  const tmp = new Float32Array(w * h);
  const img = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l = luma[row + (x > 0 ? x - 1 : 0)]!;
      const c = luma[row + x]!;
      const r = luma[row + (x < w - 1 ? x + 1 : x)]!;
      tmp[row + x] = (l + 2 * c + r) * 0.25;
    }
  }
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : 0) * w;
    const row = y * w;
    const dn = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) img[row + x] = (tmp[up + x]! + 2 * tmp[row + x]! + tmp[dn + x]!) * 0.25;
  }
  return { w, h, img, gx: null, gy: null };
}

/** Half size with a 5-tap [1 4 6 4 1]/16 Gaussian — Burt–Adelson's REDUCE. */
function downsample(src: Level): Level {
  const { w, h, img } = src;
  const W = w >> 1;
  const H = h >> 1;
  const tmp = new Float32Array(W * h);
  const at = (x: number, y: number) => img[y * w + (x < 0 ? 0 : x >= w ? w - 1 : x)]!;
  for (let y = 0; y < h; y++) {
    for (let X = 0; X < W; X++) {
      const x = X * 2;
      tmp[y * W + X] = (at(x - 2, y) + 4 * at(x - 1, y) + 6 * at(x, y) + 4 * at(x + 1, y) + at(x + 2, y)) / 16;
    }
  }
  const out = new Float32Array(W * H);
  const tv = (X: number, y: number) => tmp[(y < 0 ? 0 : y >= h ? h - 1 : y) * W + X]!;
  for (let Y = 0; Y < H; Y++) {
    const y = Y * 2;
    for (let X = 0; X < W; X++) out[Y * W + X] = (tv(X, y - 2) + 4 * tv(X, y - 1) + 6 * tv(X, y) + 4 * tv(X, y + 1) + tv(X, y + 2)) / 16;
  }
  return { w: W, h: H, img: out, gx: null, gy: null };
}

/** Scharr gradients (/32) — rotationally better behaved than Sobel, which LK's structure tensor notices. */
export function gradients(level: Level): { gx: Float32Array; gy: Float32Array } {
  if (level.gx && level.gy) return { gx: level.gx, gy: level.gy };
  const { w, h, img } = level;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = img[i - w - 1]!, t = img[i - w]!, tr = img[i - w + 1]!;
      const l = img[i - 1]!, r = img[i + 1]!;
      const bl = img[i + w - 1]!, b = img[i + w]!, br = img[i + w + 1]!;
      gx[i] = (3 * (tr - tl) + 10 * (r - l) + 3 * (br - bl)) / 32;
      gy[i] = (3 * (bl - tl) + 10 * (b - t) + 3 * (br - tr)) / 32;
    }
  }
  level.gx = gx;
  level.gy = gy;
  return { gx, gy };
}

/** Bilinear sample with edge clamping. */
export function bilinear(buf: Float32Array, w: number, h: number, x: number, y: number): number {
  const cx = x < 0 ? 0 : x > w - 1.001 ? w - 1.001 : x;
  const cy = y < 0 ? 0 : y > h - 1.001 ? h - 1.001 : y;
  const x0 = cx | 0;
  const y0 = cy | 0;
  const fx = cx - x0;
  const fy = cy - y0;
  const i = y0 * w + x0;
  const a = buf[i]!;
  const b = buf[i + 1]!;
  const c = buf[i + w]!;
  const d = buf[i + w + 1]!;
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
