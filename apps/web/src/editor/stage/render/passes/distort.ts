"use client";

import { fbm2, rand01, valueNoise2 } from "@solomotion/core";
import { drawBlurred } from "../canvas-filter";
import { blurTo } from "../gaussian";
import { parseColor } from "@/lib/color";
import { acquireTemp, nextOutput, releaseTemp } from "./buffers";
import { readPixels, remap, sampleBilinear, writePixels, type WarpField } from "./resample";
import type { PassFn } from "./types";

/**
 * DISTORT — the cards that move pixels.
 *
 * Four of the six are one line of maths each, plugged into the shared
 * resampler next door. The other two earn their own code honestly: roughen
 * edges rewrites ALPHA rather than position, and glitch moves whole bands with
 * `drawImage` (a per-pixel loop for a hard-edged block displacement would be a
 * hundred times the cost for identical output).
 */

// ── Bulge ────────────────────────────────────────────────────────────────────
function bulgeField(p: Extract<import("./types").LfxPass, { kind: "bulge" }>, w: number, h: number): { field: WarpField; r: number; cx: number; cy: number } {
  const cx = w / 2 + (p.cx * w) / 2;
  const cy = h / 2 + (p.cy * h) / 2;
  const half = Math.min(w, h) / 2;
  const r = Math.max(1, p.radius * half);
  const ax = Math.max(0.05, p.aspect);
  const strength = p.strength;
  const soft = Math.max(0.0001, p.softness);
  const refract = p.refract;
  const field: WarpField = (x, y, out) => {
    const dx = (x - cx) / ax;
    const dy = y - cy;
    const d = Math.hypot(dx, dy);
    if (d >= r) {
      out[0] = x;
      out[1] = y;
      return;
    }
    const t = d / r;
    // A lens magnifies by PULLING FROM CLOSER IN, so the scale below is < 1 for
    // a positive bulge. `1 - t²` is the classic spherical profile; `softness`
    // eases it to nothing at the rim so the lens has no visible seam.
    const dome = 1 - t * t;
    const falloff = Math.pow(dome, 1 / soft);
    // Refraction bends hardest at the rim, where a real lens is steepest —
    // that is what separates glass from a plain magnification.
    const rim = refract * t * dome * strength;
    const scale = 1 - strength * falloff * 0.75 - rim;
    out[0] = cx + (x - cx) * scale;
    out[1] = cy + (y - cy) * scale;
  };
  return { field, r: r * Math.max(1, ax), cx, cy };
}

function bulgePass(p: Extract<import("./types").LfxPass, { kind: "bulge" }>, src: CanvasImageSource, w: number, h: number): CanvasImageSource {
  if (Math.abs(p.strength) < 0.001 || p.radius <= 0) return src;
  const { field, r, cx, cy } = bulgeField(p, w, h);
  // Bounded: a lens only touches its own disc, so the rest of the layer is one
  // `drawImage` and the loop runs over a few hundred rows.
  return remap(src, w, h, field, { x0: cx - r - 2, y0: cy - r - 2, x1: cx + r + 2, y1: cy + r + 2 });
}

// ── Wave warp ────────────────────────────────────────────────────────────────
function waveProfile(shape: string, t: number, seed: number): number {
  const u = t - Math.floor(t);
  switch (shape) {
    case "triangle":
      return 4 * Math.abs(u - 0.5) - 1;
    case "square":
      return u < 0.5 ? 1 : -1;
    case "noise":
      // A noise "wave" has no period, so it is sampled along the axis rather
      // than folded — which is what makes it read as heat haze and not as a
      // very fast sine.
      return valueNoise2(t * 1.7, seed * 0.013, seed) * 2 - 1;
    default:
      return Math.sin(u * Math.PI * 2);
  }
}

function wavePass(p: Extract<import("./types").LfxPass, { kind: "wave" }>, src: CanvasImageSource, w: number, h: number): CanvasImageSource {
  if (p.amplitude <= 0.01 || p.wavelength <= 0.01) return src;
  const rad = (p.angle * Math.PI) / 180;
  const dirX = Math.cos(rad);
  const dirY = Math.sin(rad);
  // The wave DISPLACES across its direction of travel; the crest pushes along
  // the normal. Displacing along the travel axis would only stretch the layer.
  const nx = -dirY;
  const ny = dirX;
  const phase = p.phase / 360;
  const lambda = p.wavelength;
  const amp = p.amplitude;
  const cross = p.cross;
  const anchor = p.anchor;
  const cx = w / 2;
  const cy = h / 2;
  // The pin runs along the travel axis: 0 at the leading edge, 1 at the far
  // end, so `anchor` ramps the amplitude from nothing to full across the layer.
  const span = Math.abs(dirX) * w + Math.abs(dirY) * h || 1;

  const field: WarpField = (x, y, out) => {
    const px = x - cx;
    const py = y - cy;
    const along = px * dirX + py * dirY;
    const ramp = anchor <= 0 ? 1 : Math.pow(Math.min(1, Math.max(0, along / span + 0.5)), 1 + anchor * 3);
    let d = waveProfile(p.shape, along / lambda + phase, p.seed) * amp * ramp;
    if (cross > 0) {
      const across = px * nx + py * ny;
      d += waveProfile(p.shape, across / (lambda * 0.61) - phase * 1.3, p.seed + 91) * amp * cross * ramp;
    }
    out[0] = x - nx * d;
    out[1] = y - ny * d;
  };
  return remap(src, w, h, field);
}

// ── Twirl ────────────────────────────────────────────────────────────────────
function twirlPass(p: Extract<import("./types").LfxPass, { kind: "twirl" }>, src: CanvasImageSource, w: number, h: number): CanvasImageSource {
  if (Math.abs(p.angle) < 0.01 || p.radius <= 0) return src;
  const cx = w / 2 + (p.cx * w) / 2;
  const cy = h / 2 + (p.cy * h) / 2;
  const r = Math.max(1, p.radius * (Math.min(w, h) / 2));
  const maxA = (p.angle * Math.PI) / 180;
  const soft = Math.max(0.0001, p.softness);
  const field: WarpField = (x, y, out) => {
    const dx = x - cx;
    const dy = y - cy;
    const d = Math.hypot(dx, dy);
    if (d >= r) {
      out[0] = x;
      out[1] = y;
      return;
    }
    const t = 1 - d / r;
    const a = -maxA * Math.pow(t, 1 / soft);
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    out[0] = cx + dx * cos - dy * sin;
    out[1] = cy + dx * sin + dy * cos;
  };
  return remap(src, w, h, field, { x0: cx - r - 2, y0: cy - r - 2, x1: cx + r + 2, y1: cy + r + 2 });
}

// ── Lens distortion ──────────────────────────────────────────────────────────
// The only warp with a per-CHANNEL sample, so it does its own loop rather than
// going through `remap` three times (which would read the source three times
// and cost three full-frame allocations for one picture).
function lensDistortPass(p: Extract<import("./types").LfxPass, { kind: "lensDistort" }>, src: CanvasImageSource, w: number, h: number): CanvasImageSource {
  if (Math.abs(p.amount) < 0.001 && Math.abs(p.cubic) < 0.001 && p.chroma < 0.001 && Math.abs(p.scale - 1) < 0.001) return src;
  const { image, buf } = readPixels(src, w, h);
  const sdata = image.data;
  const out = nextOutput(w, h);
  const target = out.ctx.createImageData(w, h);
  const tdata = target.data;
  const cx = w / 2 + (p.cx * w) / 2;
  const cy = h / 2 + (p.cy * h) / 2;
  const norm = Math.hypot(w, h) / 2 || 1;
  const rgba = new Float64Array(4);
  // Channel scales straddle 1: red pulls from slightly further out, blue from
  // slightly further in. Zero at the centre and growing outward — which is what
  // a real lens does and what an RGB split does not.
  const kR = 1 + p.chroma * 0.02;
  const kB = 1 - p.chroma * 0.02;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - cx) / norm;
      const dy = (y + 0.5 - cy) / norm;
      const r2 = dx * dx + dy * dy;
      const bend = 1 + p.amount * r2 + p.cubic * r2 * r2;
      const s = bend / (p.scale || 1);
      const o = (y * w + x) * 4;
      if (p.chroma < 0.001) {
        sampleBilinear(sdata, w, h, cx + dx * norm * s, cy + dy * norm * s, rgba);
        tdata[o] = rgba[0]!;
        tdata[o + 1] = rgba[1]!;
        tdata[o + 2] = rgba[2]!;
        tdata[o + 3] = rgba[3]!;
        continue;
      }
      sampleBilinear(sdata, w, h, cx + dx * norm * s * kR, cy + dy * norm * s * kR, rgba);
      tdata[o] = rgba[0]!;
      const aR = rgba[3]!;
      sampleBilinear(sdata, w, h, cx + dx * norm * s, cy + dy * norm * s, rgba);
      tdata[o + 1] = rgba[1]!;
      const aG = rgba[3]!;
      sampleBilinear(sdata, w, h, cx + dx * norm * s * kB, cy + dy * norm * s * kB, rgba);
      tdata[o + 2] = rgba[2]!;
      // The widest of the three alphas, so a fringed edge keeps its coverage
      // instead of thinning out where the channels disagree.
      tdata[o + 3] = Math.max(aR, aG, rgba[3]!);
    }
  }
  out.ctx.putImageData(target, 0, 0);
  releaseTemp(buf);
  return out.canvas;
}

// ── Line boil ────────────────────────────────────────────────────────────────
// Each "drawing" is a smooth noise displacement at a fixed place on the noise
// field's third axis, so drawing 0, 1, 2 are three stable redraws the clock
// cycles through. The field is sampled on a coarse grid and interpolated — a
// wiggle is never smaller than a few pixels, and this keeps a 4K layer cheap.
const BOIL_SHAPE: Record<string, { gain: number; shape: "fractal" | "ridged" }> = {
  boil: { gain: 0.5, shape: "fractal" },
  wobble: { gain: 0.3, shape: "fractal" },
  jitter: { gain: 0.72, shape: "ridged" },
};

function boilPass(p: Extract<import("./types").LfxPass, { kind: "boil" }>, src: CanvasImageSource, w: number, h: number): CanvasImageSource {
  if (p.amount <= 0.01 && p.shake <= 0.01 && p.rotate <= 0.001) return src;
  const look = BOIL_SHAPE[p.style] ?? BOIL_SHAPE.boil!;
  const scale = Math.max(2, p.scale);
  const opts = { octaves: p.complexity, gain: look.gain, lacunarity: 2, shape: look.shape, evolve: p.drawing * 3.7 };
  // Whole-layer hand-held jump and twist for this drawing.
  const r1 = rand01(p.seed * 7919 + p.drawing * 104729) * 2 - 1;
  const r2 = rand01(p.seed * 6271 + p.drawing * 130363) * 2 - 1;
  const r3 = rand01(p.seed * 3571 + p.drawing * 196613) * 2 - 1;
  const ox = r1 * p.shake;
  const oy = r2 * p.shake;
  const ang = (r3 * p.rotate * Math.PI) / 180;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const cx = w / 2;
  const cy = h / 2;

  const cell = Math.max(2, Math.min(12, Math.round(scale / 5)));
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const reach = p.amount * 1.6;
  const wiggles = p.amount > 0.01;
  // The noise grid is filled LAZILY: only cells a sampled pixel touches are
  // ever computed, so the empty paper around a drawing costs nothing.
  const gx = new Float32Array(gw * gh).fill(NaN);
  const gy = new Float32Array(gw * gh);
  const node = (k: number) => {
    if (gx[k] === gx[k]) return; // computed (NaN never equals itself)
    const x = ((k % gw) * cell) / scale;
    const y = (Math.floor(k / gw) * cell) / scale;
    gx[k] = fbm2(x, y, p.seed, opts) * reach;
    gy[k] = fbm2(x + 31.7, y - 17.3, p.seed + 911, opts) * reach;
  };
  const field: WarpField = (x, y, out) => {
    let dx = 0;
    let dy = 0;
    if (wiggles) {
      const fx = x / cell;
      const fy = y / cell;
      const i = Math.min(gw - 2, Math.max(0, Math.floor(fx)));
      const j = Math.min(gh - 2, Math.max(0, Math.floor(fy)));
      const tx = Math.min(1, Math.max(0, fx - i));
      const ty = Math.min(1, Math.max(0, fy - j));
      const k = j * gw + i;
      node(k);
      node(k + 1);
      node(k + gw);
      node(k + gw + 1);
      dx = (gx[k]! * (1 - tx) + gx[k + 1]! * tx) * (1 - ty) + (gx[k + gw]! * (1 - tx) + gx[k + gw + 1]! * tx) * ty;
      dy = (gy[k]! * (1 - tx) + gy[k + 1]! * tx) * (1 - ty) + (gy[k + gw]! * (1 - tx) + gy[k + gw + 1]! * tx) * ty;
    }
    // Inverse of the jump and twist, then the line wobble.
    const px = x - cx - ox;
    const py = y - cy - oy;
    out[0] = cx + px * cos + py * sin + dx;
    out[1] = cy - px * sin + py * cos + dy;
  };
  // Affine (shake + twist) plus a wiggle of at most `reach` px — so tiles far
  // from any ink are skipped (`RemapSparse`).
  const warped = remap(src, w, h, field, undefined, { slack: wiggles ? reach : 0 });
  if (p.mix >= 0.999) return warped;
  const out = nextOutput(w, h);
  out.ctx.drawImage(src, 0, 0);
  out.ctx.globalAlpha = p.mix;
  out.ctx.drawImage(warped, 0, 0);
  out.ctx.globalAlpha = 1;
  return out.canvas;
}

// ── Roughen edges ────────────────────────────────────────────────────────────
// Not a displacement: the interior is untouched and only the ALPHA BOUNDARY
// moves. That is what keeps text readable while its edges fall apart, and why
// this cannot be the Noise card's `displace` field turned up.
const STYLE_SHAPE: Record<string, { octaves: number; gain: number; ridged: boolean; bias: number; skew: number }> = {
  rough: { octaves: 1, gain: 0.5, ridged: false, bias: 0, skew: 0 },
  spiky: { octaves: 1, gain: 0.72, ridged: true, bias: 0.15, skew: 0 },
  torn: { octaves: 1, gain: 0.35, ridged: false, bias: 0.25, skew: 0 },
  melt: { octaves: 1, gain: 0.45, ridged: false, bias: 0.1, skew: 1 },
  rusty: { octaves: 1, gain: 0.62, ridged: true, bias: 0.2, skew: 0 },
};

function roughenEdgesPass(
  p: Extract<import("./types").LfxPass, { kind: "roughenEdges" }>,
  src: CanvasImageSource,
  w: number,
  h: number,
): CanvasImageSource {
  if (p.amount <= 0.01) return src;
  const style = STYLE_SHAPE[p.style] ?? STYLE_SHAPE.rough!;
  const { image, buf } = readPixels(src, w, h);
  const data = image.data;
  const scale = Math.max(1, p.scale);
  // A blurred copy of the alpha is the DISTANCE FIELD: near the edge it sits
  // around 0.5, deep inside it saturates. Subtracting noise from it and
  // re-thresholding is what chews the boundary without touching the middle.
  const blurRadius = Math.max(0.5, p.amount * 0.5);
  const soft = acquireTemp(w, h);
  drawBlurred(soft.ctx, src, blurRadius);
  const field = soft.ctx.getImageData(0, 0, w, h).data;

  const ink = p.style === "rusty" && p.tint > 0 ? parseColor(p.color) : null;
  const cut = 0.5;
  const sharp = 1 + p.sharpness * 24;
  const fbmOpts = { octaves: Math.max(1, Math.round(p.complexity)), gain: style.gain, lacunarity: 2, shape: (style.ridged ? "ridged" : "fractal") as "ridged" | "fractal" };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const a = data[o + 3]!;
      if (a === 0) continue;
      const dist = field[o + 3]! / 255;
      // `skew` drags the bite downward, so "melt" eats the bottom edge harder
      // than the top — the whole difference between a drip and an even chew.
      const ny = y / scale + (style.skew ? (dist * p.amount) / scale : 0);
      // `fbm2` is centred on 0 across every shape, so the bias is a straight
      // offset: positive eats more, negative leaves a fatter edge.
      const n = fbm2(x / scale, ny, p.seed, { ...fbmOpts, evolve: p.evolve });
      const bite = (n + style.bias) * 0.7;
      const keep = 1 / (1 + Math.exp(-(dist - cut - bite * 0.5) * sharp));
      const na = a * keep;
      data[o + 3] = na;
      if (ink && na > 0) {
        // Stain strongest exactly where the bite is deepest — rust is a fact
        // about the damaged edge, not a wash over the whole layer.
        const stain = Math.min(1, Math.max(0, (1 - keep) * 2)) * p.tint;
        if (stain > 0.002) {
          data[o] = data[o]! + (ink.r - data[o]!) * stain;
          data[o + 1] = data[o + 1]! + (ink.g - data[o + 1]!) * stain;
          data[o + 2] = data[o + 2]! + (ink.b - data[o + 2]!) * stain;
        }
      }
    }
  }
  releaseTemp(soft);
  const outImg = writePixels(image, w, h);
  releaseTemp(buf);
  return outImg;
}

// ── Goo ──────────────────────────────────────────────────────────────────────
/**
 * The metaball pass: blur the alpha into a field, re-threshold it, and keep the
 * original colour everywhere the original was already opaque.
 *
 * That last clause is what makes this a shape operation rather than a blur. The
 * field decides WHERE there is ink; the source decides WHAT that ink looks
 * like, and the blurred blend is used only in the bridge the field invented —
 * so a photo, a gradient or a piece of text inside the group comes out exactly
 * as sharp as it went in, with liquid necking between the layers.
 */
function gooPass(
  p: Extract<import("./types").LfxPass, { kind: "goo" }>,
  src: CanvasImageSource,
  w: number,
  h: number,
): CanvasImageSource {
  if (p.mix <= 0.001 || p.blur <= 0.05) return src;
  const field = acquireTemp(w, h);
  // Through the ONE blur seam, never `ctx.filter` directly: an engine without
  // canvas filters (WebKit) would otherwise leave the field unblurred, which
  // is not "goo looks wrong" but "goo does nothing at all".
  blurTo(field.ctx, src, w, h, p.blur);
  const blurred = field.ctx.getImageData(0, 0, w, h).data;

  const { image, buf } = readPixels(src, w, h);
  const data = image.data;
  // The threshold band in 0–255, with a floor of one alpha step so `softness:
  // 0` is a clean 1px-ish cut rather than a divide by zero and a binary edge
  // that crawls with aliasing.
  const lo = (p.threshold - p.softness) * 255;
  const span = Math.max(1, p.softness * 2 * 255);
  const mix = p.mix;

  for (let i = 0; i < data.length; i += 4) {
    const fa = blurred[i + 3]!;
    let t = (fa - lo) / span;
    if (t <= 0) t = 0;
    else if (t >= 1) t = 1;
    else t = t * t * (3 - 2 * t); // smoothstep — a straight ramp bands visibly
    const gooAlpha = t * 255;
    const srcAlpha = data[i + 3]!;
    if (gooAlpha < 0.5 && srcAlpha < 0.5) continue;
    // `k` is how much of this pixel the ORIGINAL already covered. 1 inside the
    // artwork (keep it verbatim), 0 in the invented bridge (take the melt).
    const k = srcAlpha / 255;
    for (let c = 0; c < 3; c++) {
      const sc = data[i + c]!;
      const melted = blurred[i + c]! + (sc - blurred[i + c]!) * k;
      data[i + c] = sc + (melted - sc) * mix;
    }
    data[i + 3] = srcAlpha + (gooAlpha - srcAlpha) * mix;
  }
  releaseTemp(field);
  const out = writePixels(image, w, h);
  releaseTemp(buf);
  return out;
}

// ── Glitch ───────────────────────────────────────────────────────────────────
function glitchPass(p: Extract<import("./types").LfxPass, { kind: "glitch" }>, src: CanvasImageSource, w: number, h: number): CanvasImageSource {
  if (p.amount <= 0.001 || p.mix <= 0.001) return src;
  const out = nextOutput(w, h);
  out.ctx.drawImage(src, 0, 0);
  const bands = Math.max(1, Math.round(p.blocks));
  const vertical = p.direction === "vertical";
  const both = p.direction === "both";
  const axis = vertical ? w : h;
  const step = axis / bands;

  const torn = acquireTemp(w, h);
  for (let i = 0; i < bands; i++) {
    if (rand01(p.seed, 11, i) > p.amount) continue;
    const at = i * step;
    const size = Math.max(1, Math.ceil(step));
    // Where the band's pixels come from: itself, or (with `scramble`) another
    // band entirely. Sampling a DIFFERENT band is what makes it read as a
    // corrupt buffer rather than as a wobble.
    const from =
      rand01(p.seed, 12, i) < p.scramble ? Math.floor(rand01(p.seed, 13, i) * bands) * step : at;
    const slide = (rand01(p.seed, 14, i) * 2 - 1) * p.displace;
    const slideY = both ? (rand01(p.seed, 15, i) * 2 - 1) * p.displace : 0;

    torn.ctx.setTransform(1, 0, 0, 1, 0, 0);
    torn.ctx.clearRect(0, 0, w, h);
    if (vertical) {
      torn.ctx.drawImage(src, from, 0, size, h, at + slide, 0, size, h);
    } else {
      torn.ctx.drawImage(src, 0, from, w, size, slide, at + slideY, w, size);
    }

    // Clear the band's original pixels first — a torn band LEAVES a hole, and
    // painting the displaced copy over the intact one just doubles it.
    out.ctx.save();
    out.ctx.beginPath();
    if (vertical) out.ctx.rect(at - Math.abs(slide) - 1, 0, size + Math.abs(slide) * 2 + 2, h);
    else out.ctx.rect(0, at - Math.abs(slideY) - 1, w, size + Math.abs(slideY) * 2 + 2);
    out.ctx.clip();
    if (vertical) out.ctx.clearRect(at, 0, size, h);
    else out.ctx.clearRect(0, at, w, size);

    if (p.chroma > 0.01) {
      const shift = p.chroma * (rand01(p.seed, 16, i) * 2 - 1);
      out.ctx.globalCompositeOperation = "lighter";
      drawTinted(out.ctx, torn.canvas, shift, 0, "#ff0040", w, h);
      drawTinted(out.ctx, torn.canvas, -shift, 0, "#00ffd0", w, h);
      out.ctx.globalCompositeOperation = "source-over";
      out.ctx.globalAlpha = 0.55;
      out.ctx.drawImage(torn.canvas, 0, 0);
      out.ctx.globalAlpha = 1;
    } else {
      out.ctx.drawImage(torn.canvas, 0, 0);
    }

    if (p.colorShift > 0.01) {
      out.ctx.globalCompositeOperation = "hue";
      out.ctx.globalAlpha = p.colorShift * 0.8;
      out.ctx.fillStyle = `hsl(${Math.floor(rand01(p.seed, 17, i) * 360)} 100% 50%)`;
      if (vertical) out.ctx.fillRect(at, 0, size, h);
      else out.ctx.fillRect(0, at, w, size);
      out.ctx.globalAlpha = 1;
      out.ctx.globalCompositeOperation = "source-over";
    }
    out.ctx.restore();
  }
  releaseTemp(torn);

  if (p.inside) {
    // Keep the tearing inside the layer's own shape: the ORIGINAL alpha is the
    // stencil, so a band that slid off the silhouette is cut back to it.
    out.ctx.globalCompositeOperation = "destination-in";
    out.ctx.drawImage(src, 0, 0);
    out.ctx.globalCompositeOperation = "source-over";
  }
  if (p.mix < 0.999) {
    const mixed = nextOutput(w, h);
    mixed.ctx.drawImage(src, 0, 0);
    mixed.ctx.globalAlpha = p.mix;
    mixed.ctx.drawImage(out.canvas, 0, 0);
    mixed.ctx.globalAlpha = 1;
    return mixed.canvas;
  }
  return out.canvas;
}

/** One channel's worth of a torn band, offset and tinted. */
function drawTinted(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  dx: number,
  dy: number,
  tint: string,
  w: number,
  h: number,
): void {
  const t = acquireTemp(w, h);
  t.ctx.drawImage(img, dx, dy);
  t.ctx.globalCompositeOperation = "source-in";
  t.ctx.fillStyle = tint;
  t.ctx.fillRect(0, 0, w, h);
  t.ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(t.canvas, 0, 0);
  releaseTemp(t);
}

export const bulge: PassFn<"bulge"> = (p, src, w, h) => bulgePass(p, src, w, h);
export const wave: PassFn<"wave"> = (p, src, w, h) => wavePass(p, src, w, h);
export const twirl: PassFn<"twirl"> = (p, src, w, h) => twirlPass(p, src, w, h);
export const lensDistort: PassFn<"lensDistort"> = (p, src, w, h) => lensDistortPass(p, src, w, h);
export const roughenEdges: PassFn<"roughenEdges"> = (p, src, w, h) => roughenEdgesPass(p, src, w, h);
export const boil: PassFn<"boil"> = (p, src, w, h) => boilPass(p, src, w, h);
/**
 * GOO RUNS ON THE CPU. The GPU path is written, unverified, and OFF.
 *
 * `goo-gl.ts` expresses this pass as three shaders and that is the right shape:
 * a per-pixel loop over two million pixels is 30-60ms by construction, and the
 * readback between it and glass is why the two together feel worse than either
 * alone. But it was switched on without its output ever being compared against
 * this function's, and it caused three faults that are all the same mistake:
 *
 *  - CONTENT LANDED IN THE WRONG PLACE, and a layer inside the group could no
 *    longer be selected by double-clicking it. Painting and hit testing are one
 *    pass here, so anything that moves pixels without moving the rects breaks
 *    both — and the second symptom does not look related to the first.
 *  - THE WRAPPER CLAIMED A RING BUFFER IT DID NOT ALWAYS USE. `nextOutput`
 *    hands out one of eight canvases in rotation, and that rotation is the only
 *    thing stopping one pass overwriting a buffer the next still reads. Taking
 *    one and then falling through to the CPU path — which takes another —
 *    spends the ring twice as fast as the chain assumes it will.
 *  - IT RESIZED A SHARED WebGL CANVAS PER CALL. Goo wants the layer's size,
 *    glass wants its quality-scaled one, so a group carrying both reallocated
 *    the drawing buffer twice a frame. That is how a LOWER preview tier became
 *    slower than a higher one — the exact opposite of the point of a tier.
 *
 * None of that argues against the shader. It argues that a replacement for a
 * pass this visible has to be diffed against the pass it replaces, on a card
 * with a wide radius, before it is trusted. The substrate keeps its place
 * regardless: glass runs on it, which is what it was extracted for.
 */
export const goo: PassFn<"goo"> = (p, src, w, h) => gooPass(p, src, w, h);
export const glitch: PassFn<"glitch"> = (p, src, w, h) => glitchPass(p, src, w, h);
