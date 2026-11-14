"use client";

import { hasCanvasFilter } from "./capabilities";

/**
 * Gaussian blur at ANY radius — the one place that knows the browser's limit.
 *
 * `ctx.filter = "blur(r)"` saturates past roughly 100px in every engine: ask
 * for 700 and you get about 100. So any radius that GROWS — a thick glass rim,
 * a wide feather, a big glow — silently stops growing at the clamp, and the
 * render starts depending on how far the stage happens to be zoomed in. That is
 * the one thing a renderer must never do, and it is why this helper exists
 * rather than a `Math.min(100, r)` at each call site.
 *
 * Past the clamp, blur a DOWNSCALED copy: a Gaussian of radius r on an image
 * scaled by s is a Gaussian of radius r·s, so a cheap small blur upscales back
 * into the large one. The upscale is bilinear, which leaves the field piecewise
 * linear — invisible in a blur you only look at, glaring in one you
 * DIFFERENTIATE (glass reads the gradient of its height field and would render
 * every facet), so a reconstruction blur at the resample scale goes on the way
 * back up. It costs one small blit and makes the result smooth.
 *
 * Downscaling is also why a huge blur gets CHEAPER as it grows instead of
 * quadratically worse.
 */

/** Largest radius browsers actually honour on `ctx.filter = "blur()"`. */
const SAFE_BLUR = 100;

/**
 * A SEPARABLE BOX BLUR, three passes — the fallback for engines without
 * `ctx.filter`.
 *
 * Three box passes approximate a Gaussian closely enough that nobody can tell
 * them apart in a glow or a feather (the central limit theorem doing the work),
 * and a box blur is O(pixels) per pass regardless of radius because it slides a
 * running sum rather than re-summing a kernel. That matters here: this path is
 * for the machines that are ALREADY the slowest, so a naive kernel would turn
 * "the effect is missing" into "the effect takes a second".
 *
 * Premultiplied on the way in and un-premultiplied on the way out, or the blur
 * drags colour out of transparent pixels and every soft edge grows a dark halo.
 */
function boxBlurInto(dst: CanvasRenderingContext2D, src: CanvasImageSource, w: number, h: number, radius: number): void {
  dst.clearRect(0, 0, w, h);
  dst.drawImage(src, 0, 0, w, h);
  const img = dst.getImageData(0, 0, w, h);
  const d = img.data;
  // Premultiply.
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]! / 255;
    d[i] = d[i]! * a;
    d[i + 1] = d[i + 1]! * a;
    d[i + 2] = d[i + 2]! * a;
  }
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float32Array(d.length);
  const cur = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) cur[i] = d[i]!;

  const pass = (from: Float32Array, to: Float32Array, horizontal: boolean) => {
    const major = horizontal ? h : w;
    const minor = horizontal ? w : h;
    const step = horizontal ? 4 : w * 4;
    const lineStep = horizontal ? w * 4 : 4;
    for (let m = 0; m < major; m++) {
      const base = m * lineStep;
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        let count = 0;
        // Seed the window.
        for (let k = 0; k <= r && k < minor; k++) {
          sum += from[base + k * step + c]!;
          count++;
        }
        for (let n = 0; n < minor; n++) {
          to[base + n * step + c] = sum / count;
          const add = n + r + 1;
          const drop = n - r;
          if (add < minor) {
            sum += from[base + add * step + c]!;
            count++;
          }
          if (drop >= 0) {
            sum -= from[base + drop * step + c]!;
            count--;
          }
        }
      }
    }
  };

  for (let i = 0; i < 3; i++) {
    pass(cur, tmp, true);
    pass(tmp, cur, false);
  }
  // Un-premultiply.
  for (let i = 0; i < d.length; i += 4) {
    const a = cur[i + 3]!;
    const inv = a > 0.5 ? 255 / a : 0;
    d[i] = Math.min(255, cur[i]! * inv);
    d[i + 1] = Math.min(255, cur[i + 1]! * inv);
    d[i + 2] = Math.min(255, cur[i + 2]! * inv);
    d[i + 3] = a;
  }
  dst.putImageData(img, 0, 0);
}

interface Scratch {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}
let low: Scratch | null = null;
function lowRes(w: number, h: number): Scratch {
  low ??= (() => {
    const canvas = document.createElement("canvas");
    return { canvas, ctx: canvas.getContext("2d")! };
  })();
  if (low.canvas.width !== w || low.canvas.height !== h) {
    low.canvas.width = w;
    low.canvas.height = h;
  } else {
    low.ctx.setTransform(1, 0, 0, 1, 0, 0);
    low.ctx.filter = "none";
    low.ctx.globalAlpha = 1;
    low.ctx.globalCompositeOperation = "source-over";
    low.ctx.clearRect(0, 0, w, h);
  }
  low.ctx.setTransform(1, 0, 0, 1, 0, 0);
  low.ctx.filter = "none";
  low.ctx.globalAlpha = 1;
  low.ctx.globalCompositeOperation = "source-over";
  low.ctx.imageSmoothingQuality = "high";
  return low;
}

/**
 * Draw `src` blurred by `radius` px into `dst` at (0,0,w,h). `dst` is expected
 * sized and cleared by its owner; its transform and filter are left as found.
 */
export function blurTo(
  dst: CanvasRenderingContext2D,
  src: CanvasImageSource,
  w: number,
  h: number,
  radius: number,
): void {
  dst.save();
  dst.setTransform(1, 0, 0, 1, 0, 0);
  dst.imageSmoothingQuality = "high";
  if (radius > 0.05 && !hasCanvasFilter()) {
    // No `ctx.filter` in this engine — see `canvasFilterWorks`. Downscale first
    // for a large radius exactly as the honoured path does, so the fallback is
    // bounded work rather than a radius-proportional crawl on the slowest
    // machines we have.
    const s = radius <= SAFE_BLUR ? 1 : SAFE_BLUR / radius;
    if (s >= 1) {
      boxBlurInto(dst, src, w, h, radius);
    } else {
      const lw = Math.max(1, Math.round(w * s));
      const lh = Math.max(1, Math.round(h * s));
      const lo = lowRes(lw, lh);
      boxBlurInto(lo.ctx, src, lw, lh, SAFE_BLUR);
      dst.filter = "none";
      dst.drawImage(lo.canvas, 0, 0, w, h);
    }
    dst.filter = "none";
    dst.restore();
    return;
  }
  if (radius <= 0.05) {
    dst.filter = "none";
    dst.drawImage(src, 0, 0, w, h);
  } else if (radius <= SAFE_BLUR) {
    dst.filter = `blur(${radius}px)`;
    dst.drawImage(src, 0, 0, w, h);
  } else {
    const s = SAFE_BLUR / radius;
    const lw = Math.max(1, Math.round(w * s));
    const lh = Math.max(1, Math.round(h * s));
    const lo = lowRes(lw, lh);
    // radius · s == SAFE_BLUR by construction — the whole point of the scale.
    lo.ctx.filter = `blur(${SAFE_BLUR}px)`;
    lo.ctx.drawImage(src, 0, 0, lw, lh);
    lo.ctx.filter = "none";
    dst.filter = `blur(${Math.min(SAFE_BLUR, Math.max(1, 1 / s))}px)`;
    dst.drawImage(lo.canvas, 0, 0, w, h);
  }
  dst.filter = "none";
  dst.restore();
}
