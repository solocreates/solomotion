"use client";

import { drawFiltered } from "../canvas-filter";
import { acquireTemp, releaseTemp } from "./buffers";
import { readPixels, writePixels } from "./resample";
import type { DepthSampler, LfxPass, PassEnv, PassFn } from "./types";

/**
 * DEPTH — fog, lens blur and "behind", from a footage's depth maps.
 *
 * Each pass asks the env for a SAMPLER (`env.depth(source)`): buffer px →
 * depth, 0 near … 1 far, through the buffer's own transform — so the same
 * code serves the plate itself (fog on the footage) and a layer over it (a
 * title cut where the plate stands in front). No depth yet (the footage has
 * no maps, or they are still loading) leaves the layer untouched: a missing
 * map is a pending picture, never a wrong one.
 */

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function hex(c: string): [number, number, number] {
  const s = c.replace("#", "");
  const w = s.length <= 4 ? s.split("").map((x) => x + x).join("") : s;
  return [parseInt(w.slice(0, 2), 16) || 0, parseInt(w.slice(2, 4), 16) || 0, parseInt(w.slice(4, 6), 16) || 0];
}

/** Depth for every pixel of the buffer (NaN where the footage does not reach), at a stride when the buffer is big. */
function depthField(sampler: DepthSampler, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = sampler(x + 0.5, y + 0.5) ?? NaN;
  return out;
}

const fog: PassFn<"fog"> = (p, src, w, h, env) => {
  const sampler = env.depth?.(p.source);
  if (!sampler) return src;
  const { image, buf } = readPixels(src, w, h);
  const d = image.data;
  const [fr, fg, fb] = hex(p.color);
  const span = p.end - p.start;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0) continue;
      const z = sampler(x + 0.5, y + 0.5);
      if (z === null) continue;
      const k = p.density * p.mix * (Math.abs(span) < 1e-6 ? (z >= p.end ? 1 : 0) : smooth((z - p.start) / span));
      if (k <= 0) continue;
      // Fog is light between the lens and the thing: it fills the pixel, premultiplied by its alpha.
      const a = d[i + 3]! / 255;
      d[i] = d[i]! + (fr * a - d[i]!) * k;
      d[i + 1] = d[i + 1]! + (fg * a - d[i + 1]!) * k;
      d[i + 2] = d[i + 2]! + (fb * a - d[i + 2]!) * k;
    }
  const out = writePixels(image, w, h);
  releaseTemp(buf);
  return out;
};

/** Blur levels a lens blur blends between: sharp, then thirds of the full amount. */
const LEVELS = 4;

const lensBlur: PassFn<"lensBlur"> = (p, src, w, h, env) => {
  const sampler = env.depth?.(p.source);
  if (!sampler) return src;
  const z = depthField(sampler, w, h);
  const { image, buf } = readPixels(src, w, h);
  // The blurred levels through the app's own filter executor (GPU where it works, CPU otherwise).
  const levels: Uint8ClampedArray[] = [image.data];
  const temps: Array<ReturnType<typeof acquireTemp>> = [];
  for (let k = 1; k < LEVELS; k++) {
    const t = acquireTemp(w, h);
    temps.push(t);
    t.ctx.save();
    t.ctx.setTransform(1, 0, 0, 1, 0, 0);
    t.ctx.clearRect(0, 0, w, h);
    drawFiltered(t.ctx, src, [{ kind: "blur", px: (p.amount * k) / (LEVELS - 1) }]);
    t.ctx.restore();
    levels.push(t.ctx.getImageData(0, 0, w, h).data);
  }
  const d = image.data;
  const out = new Uint8ClampedArray(d.length);
  const reach = Math.max(1e-6, 1 - p.range);
  for (let i = 0, px = 0; px < w * h; px++, i += 4) {
    const zz = z[px]!;
    // Circle of confusion: 0 within the sharp band, 1 at the farthest from focus.
    const coc = Number.isNaN(zz) ? 0 : Math.min(1, Math.max(0, (Math.abs(zz - p.focus) - p.range) / reach)) * p.mix;
    const f = coc * (LEVELS - 1);
    const lo = Math.floor(f);
    const hi = Math.min(LEVELS - 1, lo + 1);
    const t = f - lo;
    const A = levels[lo]!;
    const B = levels[hi]!;
    out[i] = A[i]! + (B[i]! - A[i]!) * t;
    out[i + 1] = A[i + 1]! + (B[i + 1]! - A[i + 1]!) * t;
    out[i + 2] = A[i + 2]! + (B[i + 2]! - A[i + 2]!) * t;
    out[i + 3] = A[i + 3]! + (B[i + 3]! - A[i + 3]!) * t;
  }
  image.data.set(out);
  const result = writePixels(image, w, h);
  releaseTemp(buf);
  for (const t of temps) releaseTemp(t);
  return result;
};

const depthMatte: PassFn<"depthMatte"> = (p, src, w, h, env: PassEnv) => {
  const sampler = env.depth?.(p.source);
  if (!sampler) return src;
  const { image, buf } = readPixels(src, w, h);
  const d = image.data;
  const s = Math.max(1e-4, p.softness);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0) continue;
      const z = sampler(x + 0.5, y + 0.5);
      if (z === null) continue;
      // Where the footage is nearer than this layer's depth, the footage is in front: the layer goes.
      let keep = smooth((z - (p.depth - s)) / (2 * s));
      if (p.invert) keep = 1 - keep;
      if (keep >= 1) continue;
      d[i] = d[i]! * keep;
      d[i + 1] = d[i + 1]! * keep;
      d[i + 2] = d[i + 2]! * keep;
      d[i + 3] = d[i + 3]! * keep;
    }
  const out = writePixels(image, w, h);
  releaseTemp(buf);
  return out;
};

export { fog, lensBlur, depthMatte };
export type { LfxPass };
