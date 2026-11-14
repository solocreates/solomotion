import type { GradeDepth, GradeQualifier, KeyInputMode, QualifierBand } from "../schema/grade";

/**
 * THE MATTE MATHS — turning a picture into a selection.
 *
 * The qualifier is the half of grading that a slider cannot do. Everything here
 * is per-pixel and allocation-free on the hot path: the caller owns the output
 * plane, so a scrub can key a 4K frame without handing the collector a new
 * eight-megabyte array sixty times a second.
 *
 * Mattes are `Uint8ClampedArray`, one byte per pixel, 0 = not selected. Bytes
 * rather than floats on purpose — the renderer's next move is to hand it to a
 * canvas as an alpha channel, and a float plane would only be converted.
 */

/**
 * How strongly a value sits inside a soft band, 0..1.
 *
 * A band is centre ± width/2 at full weight, with a shoulder ramping to zero on
 * each side. `wrap` closes the axis (hue is a circle), and the wrap is measured
 * on the SIGNED shortest distance rather than by normalising the value into the
 * band's range — which is the bug that makes a red qualifier at 0° silently
 * ignore everything above 350°.
 */
export function bandWeight(value: number, band: QualifierBand, wrap = 0): number {
  if (!band.enabled) return 1;
  let d = value - band.center;
  if (wrap > 0) {
    d = ((((d + wrap / 2) % wrap) + wrap) % wrap) - wrap / 2;
  }
  const half = band.width / 2;
  const a = Math.abs(d);
  if (a <= half) return 1;
  const soft = d < 0 ? band.softLow : band.softHigh;
  if (soft <= 0) return 0;
  const t = (a - half) / soft;
  if (t >= 1) return 0;
  // Smoothstep rather than linear: a linear shoulder leaves a visible ridge
  // exactly where the eye is most sensitive to one, on a face's falloff.
  return 1 - t * t * (3 - 2 * t);
}

/** HSL from 8-bit RGB. `h` in degrees 0..360, `s`/`l` in 0..1. */
export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = rf > gf ? (rf > bf ? rf : bf) : gf > bf ? gf : bf;
  const min = rf < gf ? (rf < bf ? rf : bf) : gf < bf ? gf : bf;
  const l = (max + min) / 2;
  const c = max - min;
  if (c === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? c / (2 - max - min) : c / (max + min);
  let h: number;
  if (max === rf) h = ((gf - bf) / c) % 6;
  else if (max === gf) h = (bf - rf) / c + 2;
  else h = (rf - gf) / c + 4;
  h *= 60;
  return { h: h < 0 ? h + 360 : h, s, l };
}

/** The qualifier's weight at one pixel, 0..1 — the product of its three bands. */
export function qualifierWeight(r: number, g: number, b: number, q: GradeQualifier): number {
  const { h, s, l } = rgbToHsl(r, g, b);
  let w = bandWeight(h, q.hue, 360);
  if (w === 0) return 0;
  w *= bandWeight(s, q.sat);
  if (w === 0) return 0;
  return w * bandWeight(l, q.lum);
}

/** Where a normalised depth sits in the near/far band, 0..1. */
export function depthWeight(depth: number, band: GradeDepth): number {
  const lo = Math.min(band.near, band.far);
  const hi = Math.max(band.near, band.far);
  const soft = band.softness;
  let w: number;
  if (depth >= lo && depth <= hi) w = 1;
  else {
    const d = depth < lo ? lo - depth : depth - hi;
    if (soft <= 0 || d >= soft) w = 0;
    else {
      const t = d / soft;
      w = 1 - t * t * (3 - 2 * t);
    }
  }
  return band.invert ? 1 - w : w;
}

/**
 * Write the qualifier's matte for a whole frame.
 *
 * `out` must hold `width * height` bytes and is overwritten, not blended — the
 * combine step below is where mattes meet, and doing it in two places is how
 * they end up disagreeing about whether "no qualifier" means opaque or clear.
 */
export function writeQualifierMatte(
  rgba: Uint8ClampedArray,
  out: Uint8ClampedArray,
  q: GradeQualifier,
): void {
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    // The source's own alpha caps the key: you cannot select a pixel that is
    // not there, and a soft edge should key softly rather than as a hard cut.
    const a = rgba[i + 3]!;
    out[p] = a === 0 ? 0 : (qualifierWeight(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!, q) * a) | 0;
  }
}

/** Write a depth band's matte from a normalised depth plane (0..1 per pixel). */
export function writeDepthMatte(depth: Float32Array, out: Uint8ClampedArray, band: GradeDepth): void {
  for (let p = 0; p < out.length; p++) out[p] = (depthWeight(depth[p]!, band) * 255) | 0;
}

/**
 * Fold `src` into `dst` in place. One function for every place two mattes meet —
 * a window against the windows before it, a wired key against a node's own
 * selection, a depth band against a qualifier — because they are the same four
 * operations and a second copy is a fifth answer waiting to happen.
 */
export function combineMatte(dst: Uint8ClampedArray, src: Uint8ClampedArray, mode: KeyInputMode): void {
  switch (mode) {
    case "ignore":
      return;
    case "replace":
      dst.set(src);
      return;
    case "intersect":
      for (let i = 0; i < dst.length; i++) dst[i] = (dst[i]! * src[i]!) / 255;
      return;
    case "union":
      // Screen rather than max: two soft mattes that each take half a pixel
      // should take all of it, which `max` refuses to do and which is what
      // makes stacked windows look like they have seams.
      for (let i = 0; i < dst.length; i++) dst[i] = 255 - ((255 - dst[i]!) * (255 - src[i]!)) / 255;
      return;
    case "subtract":
      for (let i = 0; i < dst.length; i++) dst[i] = (dst[i]! * (255 - src[i]!)) / 255;
      return;
  }
}

/** Flip a matte in place. */
export function invertMatte(m: Uint8ClampedArray): void {
  for (let i = 0; i < m.length; i++) m[i] = 255 - m[i]!;
}

/**
 * Shrink (+px) or grow (−px) a matte, then blur it. The two refinements every
 * qualifier needs and neither of which a person should have to build from an
 * effect stack.
 *
 * A separable box blur run three times, which is a close enough Gaussian for a
 * matte and is O(n) in the radius rather than O(n·r) — the difference between a
 * live qualifier and a spinner. Erode/dilate reuse the same pass with a
 * threshold, because a thresholded blur IS a morphological operation on a soft
 * matte and writing a second sliding-window kernel for it buys nothing.
 */
export function refineMatte(
  m: Uint8ClampedArray,
  width: number,
  height: number,
  shrinkPx: number,
  blurPx: number,
  scratch?: Uint8ClampedArray,
): void {
  const tmp = scratch && scratch.length >= m.length ? scratch : new Uint8ClampedArray(m.length);
  if (shrinkPx !== 0) {
    const r = Math.min(64, Math.round(Math.abs(shrinkPx)));
    if (r > 0) {
      boxBlur(m, tmp, width, height, r);
      // Threshold above the midpoint erodes, below it dilates — one pass, one
      // number, and the soft edge survives because we rescale rather than clamp.
      const t = shrinkPx > 0 ? 192 : 64;
      for (let i = 0; i < m.length; i++) {
        const v = ((m[i]! - t) * 255) / (255 - t);
        m[i] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
  if (blurPx > 0) {
    const r = Math.min(128, Math.round(blurPx));
    if (r > 0) {
      boxBlur(m, tmp, width, height, r);
      boxBlur(m, tmp, width, height, r);
    }
  }
}

/** Separable box blur, radius `r`, in place through `tmp`. Sliding-window sum. */
function boxBlur(m: Uint8ClampedArray, tmp: Uint8ClampedArray, w: number, h: number, r: number): void {
  const span = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = m[row]! * (r + 1);
    for (let x = 1; x <= r; x++) sum += m[row + Math.min(x, w - 1)]!;
    for (let x = 0; x < w; x++) {
      tmp[row + x] = (sum / span) | 0;
      sum += m[row + Math.min(x + r + 1, w - 1)]! - m[row + Math.max(x - r, 0)]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = tmp[x]! * (r + 1);
    for (let y = 1; y <= r; y++) sum += tmp[Math.min(y, h - 1) * w + x]!;
    for (let y = 0; y < h; y++) {
      m[y * w + x] = (sum / span) | 0;
      sum += tmp[Math.min(y + r + 1, h - 1) * w + x]! - tmp[Math.max(y - r, 0) * w + x]!;
    }
  }
}
