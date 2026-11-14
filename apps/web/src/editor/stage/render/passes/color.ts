"use client";

import { nextOutput, releaseTemp } from "./buffers";
import { readPixels, writePixels } from "./resample";
import type { PassFn } from "./types";

/**
 * COLOUR — gradient map, posterize, fill & gradient.
 *
 * The first two are pure LOOKUPS: what a pixel becomes depends on that pixel
 * and nothing else. That makes them cheap (a 256-entry table built once, then
 * one index per pixel) and it makes them PER-PIXEL in the renderer's sense, so
 * they may rasterise at device scale like ordinary vector work instead of being
 * pinned to the document. `draw-frame`'s `PER_PIXEL_EFFECTS` is where that is
 * declared; the property is real, and stating it is worth a sharper picture at
 * every zoom above 100%.
 */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexRgb(hex: string): Rgb {
  const s = hex.trim().replace(/^#/, "");
  const wide = s.length <= 4 ? s.split("").map((c) => c + c).join("") : s;
  return {
    r: parseInt(wide.slice(0, 2), 16) || 0,
    g: parseInt(wide.slice(2, 4), 16) || 0,
    b: parseInt(wide.slice(4, 6), 16) || 0,
  };
}

// ── Gradient map ─────────────────────────────────────────────────────────────
function gradientMapPass(p: Extract<import("./types").LfxPass, { kind: "gradientMap" }>, src: CanvasImageSource, w: number, h: number): CanvasImageSource {
  if (p.mix <= 0.001) return src;
  const lo = hexRgb(p.shadowColor);
  const mid = hexRgb(p.midColor);
  const hi = hexRgb(p.highColor);
  // The ramp as a 256-entry table, built once. Interpolating three stops per
  // pixel would be the same picture at forty times the cost.
  const lut = new Uint8ClampedArray(256 * 3);
  const m = Math.min(0.98, Math.max(0.02, p.midpoint));
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a: Rgb;
    let b: Rgb;
    let k: number;
    if (t <= m) {
      a = lo;
      b = mid;
      k = t / m;
    } else {
      a = mid;
      b = hi;
      k = (t - m) / (1 - m);
    }
    const o = i * 3;
    lut[o] = a.r + (b.r - a.r) * k;
    lut[o + 1] = a.g + (b.g - a.g) * k;
    lut[o + 2] = a.b + (b.b - a.b) * k;
  }

  const { image, buf } = readPixels(src, w, h);
  const d = image.data;
  const mix = p.mix;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    let l = (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!) / 255;
    // Contrast pivots on mid-grey, then the offset slides the whole ramp —
    // in that order, so raising contrast does not also darken the picture.
    l = Math.pow(Math.min(1, Math.max(0, (l - 0.5) * p.contrast + 0.5 + p.brightness)), 1);
    const idx = Math.round(Math.min(1, Math.max(0, p.invert ? 1 - l : l)) * 255) * 3;
    d[i] = d[i]! + (lut[idx]! - d[i]!) * mix;
    d[i + 1] = d[i + 1]! + (lut[idx + 1]! - d[i + 1]!) * mix;
    d[i + 2] = d[i + 2]! + (lut[idx + 2]! - d[i + 2]!) * mix;
  }
  const out = writePixels(image, w, h);
  releaseTemp(buf);
  return out;
}

// ── Posterize ────────────────────────────────────────────────────────────────
/** A 4×4 Bayer matrix — the ordered dither that reads as print, not as noise. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function posterizePass(p: Extract<import("./types").LfxPass, { kind: "posterize" }>, src: CanvasImageSource, w: number, h: number): CanvasImageSource {
  if (p.mix <= 0.001 || p.levels >= 64) return src;
  const { image, buf } = readPixels(src, w, h);
  const d = image.data;
  const steps = Math.max(2, Math.round(p.levels));
  const invGamma = 1 / Math.max(0.05, p.gamma);
  const mix = p.mix;
  const dither = p.dither / steps;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0) continue;
      // The dither offset is added BEFORE quantising, which is what pushes a
      // value across a step boundary and breaks the band. Adding it after
      // would just add noise to a banded image.
      const bias = dither > 0 ? (BAYER[(y & 3) * 4 + (x & 3)]! / 16 - 0.5) : 0;
      if (p.luminanceOnly) {
        const l = (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!) / 255;
        const q = quantize(l, steps, invGamma, bias);
        const k = l > 0.001 ? q / l : 0;
        for (let c = 0; c < 3; c++) d[i + c] = d[i + c]! + (Math.min(255, d[i + c]! * k) - d[i + c]!) * mix;
      } else {
        for (let c = 0; c < 3; c++) {
          const q = quantize(d[i + c]! / 255, steps, invGamma, bias) * 255;
          d[i + c] = d[i + c]! + (q - d[i + c]!) * mix;
        }
      }
    }
  }
  const out = writePixels(image, w, h);
  releaseTemp(buf);
  return out;
}

function quantize(v: number, steps: number, invGamma: number, bias: number): number {
  const g = Math.pow(Math.min(1, Math.max(0, v)), invGamma);
  const q = Math.round(Math.min(1, Math.max(0, g + bias)) * (steps - 1)) / (steps - 1);
  return Math.pow(q, 1 / invGamma);
}

// ── Fill & gradient overlay ──────────────────────────────────────────────────
function overlayPass(p: Extract<import("./types").LfxPass, { kind: "overlay" }>, src: CanvasImageSource, w: number, h: number): CanvasImageSource {
  if (p.opacity <= 0.001) return src;
  const paint = nextOutput(w, h);
  const ctx = paint.ctx;
  const cx = w / 2 + (p.offsetX * w) / 2;
  const cy = h / 2 + (p.offsetY * h) / 2;
  const span = (Math.hypot(w, h) / 2) * Math.max(0.05, p.scale);

  if (p.mode === "image") {
    // A picture, tiled: at Scale 1 one copy covers the region, smaller
    // repeats it. Mirror flips every other tile so any picture tiles clean.
    if (!p.image) return src;
    const tile = p.mirror ? mirroredTile(p.image) : p.image;
    const pat = ctx.createPattern(tile, "repeat");
    if (!pat) return src;
    const k = Math.max(w / p.image.width, h / p.image.height) * Math.max(0.05, p.scale);
    // Angle reads like the ramp's: 90° (the default) is upright.
    pat.setTransform(
      new DOMMatrix()
        .translate(cx, cy)
        .rotate(p.angle - 90)
        .scale(k)
        .translate(-p.image.width / 2, -p.image.height / 2),
    );
    ctx.fillStyle = pat;
  } else if (p.mode === "solid") {
    ctx.fillStyle = p.colorA;
  } else {
    let g: CanvasGradient;
    if (p.mode === "radial") {
      g = ctx.createRadialGradient(cx, cy, 0, cx, cy, span);
    } else if (p.mode === "conic") {
      g = ctx.createConicGradient(((p.angle - 90) * Math.PI) / 180, cx, cy);
    } else {
      const rad = (p.angle * Math.PI) / 180;
      const dx = (Math.cos(rad) * span) / 2;
      const dy = (Math.sin(rad) * span) / 2;
      g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
    }
    // Repeats are laid out as stops rather than by tiling the paint, so the
    // ramp is exact at any size. `mirror` alternates the direction of each
    // repeat, which is what stops a chrome ramp from jumping black-to-white
    // at every seam — and chrome is the whole reason `repeat` exists.
    const reps = Math.max(1, Math.round(p.repeat));
    const mid = Math.min(0.98, Math.max(0.02, p.midpoint));
    for (let i = 0; i < reps; i++) {
      const at = i / reps;
      const width = 1 / reps;
      const flip = p.mirror && i % 2 === 1;
      const from = flip ? p.colorB : p.colorA;
      const to = flip ? p.colorA : p.colorB;
      g.addColorStop(at, from);
      g.addColorStop(Math.min(1, at + width * mid), blendHex(from, to, 0.5));
      g.addColorStop(Math.min(1, at + width * 0.999), to);
    }
    ctx.fillStyle = g;
  }
  ctx.globalAlpha = p.opacity;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;

  if (p.inside) {
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(src, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }

  const out = nextOutput(w, h);
  out.ctx.drawImage(src, 0, 0);
  out.ctx.globalCompositeOperation = p.blend as GlobalCompositeOperation;
  out.ctx.drawImage(paint.canvas, 0, 0);
  out.ctx.globalCompositeOperation = "source-over";
  // `source-over` at full opacity would paint outside the silhouette when
  // `inside` is off — which is intended — but must never ADD alpha the layer
  // did not have when it is on.
  return out.canvas;
}

/** Four copies of a picture, flipped about each edge — a 2× tile that repeats without a seam. Kept per picture. */
const mirrored = new WeakMap<object, HTMLCanvasElement>();
function mirroredTile(img: CanvasImageSource & { width: number; height: number }): HTMLCanvasElement {
  const hit = mirrored.get(img);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = img.width * 2;
  c.height = img.height * 2;
  const g = c.getContext("2d")!;
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
    g.setTransform(sx, 0, 0, sy, sx < 0 ? c.width : 0, sy < 0 ? c.height : 0);
    g.drawImage(img, 0, 0);
  }
  mirrored.set(img, c);
  return c;
}

function blendHex(a: string, b: string, t: number): string {
  const ca = hexRgb(a);
  const cb = hexRgb(b);
  const r = Math.round(ca.r + (cb.r - ca.r) * t);
  const g = Math.round(ca.g + (cb.g - ca.g) * t);
  const bl = Math.round(ca.b + (cb.b - ca.b) * t);
  return `rgb(${r},${g},${bl})`;
}

export const gradientMap: PassFn<"gradientMap"> = (p, src, w, h) => gradientMapPass(p, src, w, h);
export const posterize: PassFn<"posterize"> = (p, src, w, h) => posterizePass(p, src, w, h);
export const overlay: PassFn<"overlay"> = (p, src, w, h) => overlayPass(p, src, w, h);
