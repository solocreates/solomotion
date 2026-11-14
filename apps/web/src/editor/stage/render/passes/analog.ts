"use client";

import { blurTo } from "../gaussian";
import { drawFiltered, paintFiltered } from "../canvas-filter";

import {
  makeRng,
  sampleNoiseField,
  type FilmDamageParams,
  type GrainParams,
  type NoiseParams,
  type ScanlineParams,
} from "@solomotion/core";
import { parseColor } from "@/lib/color";
import { acquireTemp, nextOutput, type Buf } from "./buffers";
import type { PassFn } from "./types";

/**
 * FILM & VIDEO — grain, film damage, scanlines and procedural noise.
 *
 * A lazy chunk, and the clearest case for the split: between them these four
 * carry a grain-tile generator, a mask-tile generator with its own
 * supersampler, a barrel warp, a noise-field rasteriser and a displacement
 * sampler. That is real weight, and a document with no film look on it should
 * never see a byte of it.
 *
 * The brains are all in core (`animation/analog.ts`): by the time a pass gets
 * here the temporal step is resolved and a speck of dust is `{x, y, r}`. These
 * functions are deliberately stupid, which is what makes the family testable
 * without a canvas and what makes an export identical to its preview.
 */

// ── The analog family ────────────────────────────────────────────────────────
// Grain, film damage, scanlines and noise. Every number and every speck arrives
// pre-resolved from `@solomotion/core` (see `animation/analog.ts`), including the
// temporal step — so these functions are pure "draw what you were told", and the
// export path cannot produce a different frame from the preview.
//
// Two costs are managed here and nowhere else:
//  · TILE CACHING. A grain tile or a scanline mask is expensive to synthesize
//    and identical for every render inside one gate open, so both are cached
//    against the exact parameters that produced them. That is what makes a
//    24Hz grain cost one tile per 1/24s instead of one per rendered frame.
//  · RESOLUTION. Procedural noise is generated at feature resolution and
//    upscaled bilinearly, never per device pixel — a 2-megapixel fBm in JS
//    would be tens of milliseconds a frame for detail nobody can see.

/** A synthesized tile plus the key that produced it. */
interface CachedTile {
  key: string;
  canvas: HTMLCanvasElement;
}

/** Blend a texture over the buffer, then re-clip it to the layer's silhouette.
 *  Canvas blend modes union their coverage with the backdrop, so every generated
 *  texture would otherwise spill a rectangle past the layer's own edges. */
function blendOver(
  out: Buf,
  texture: CanvasImageSource,
  w: number,
  h: number,
  mode: GlobalCompositeOperation,
  alpha: number,
  silhouette: CanvasImageSource | null,
): void {
  out.ctx.save();
  out.ctx.globalCompositeOperation = mode;
  out.ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  out.ctx.drawImage(texture, 0, 0, w, h);
  out.ctx.restore();
  if (silhouette) {
    out.ctx.globalCompositeOperation = "destination-in";
    out.ctx.drawImage(silhouette, 0, 0);
    out.ctx.globalCompositeOperation = "source-over";
  }
}

// ── Film grain ───────────────────────────────────────────────────────────────
// The tile is one pixel PER GRAIN CELL, drawn unsmoothed and scaled up by the
// cell size — so "chunky 8mm grain" costs exactly as much to generate as fine
// 35mm grain, and only the pattern transform changes.

const GRAIN_TILE = 192; // cells per side; large enough that repeats don't read
let grainTile: CachedTile | null = null;

function getGrainTile(p: GrainParams): HTMLCanvasElement {
  const key = `${p.seed}|${p.chroma.toFixed(3)}`;
  if (grainTile && grainTile.key === key) return grainTile.canvas;
  const canvas = grainTile?.canvas ?? document.createElement("canvas");
  canvas.width = GRAIN_TILE;
  canvas.height = GRAIN_TILE;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(GRAIN_TILE, GRAIN_TILE);
  const d = img.data;
  const rng = makeRng(p.seed);
  for (let i = 0; i < d.length; i += 4) {
    const mono = (rng() * 255) | 0;
    if (p.chroma <= 0.001) {
      d[i] = d[i + 1] = d[i + 2] = mono;
    } else {
      // Colour grain is three dye layers with their own noise; `chroma` mixes
      // each channel away from the shared silver value toward its own.
      d[i] = mono + (((rng() * 255) | 0) - mono) * p.chroma;
      d[i + 1] = mono + (((rng() * 255) | 0) - mono) * p.chroma;
      d[i + 2] = mono + (((rng() * 255) | 0) - mono) * p.chroma;
    }
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  grainTile = { key, canvas };
  return canvas;
}

function grainPass(src: CanvasImageSource, w: number, h: number, p: GrainParams): CanvasImageSource {
  const out = nextOutput(w, h);
  out.ctx.drawImage(src, 0, 0);
  if (p.amount < 0.002) return out.canvas;

  const tile = getGrainTile(p);
  const field = acquireTemp(w, h);
  const pat = field.ctx.createPattern(tile, "repeat");
  if (pat) {
    // One cell of the tile becomes `cell` device px; `aspect` stretches it
    // horizontally for anamorphic stocks.
    if (pat.setTransform) pat.setTransform(new DOMMatrix().scale(p.cell * p.aspect, p.cell));
    field.ctx.imageSmoothingEnabled = false;
    field.ctx.fillStyle = pat;
    field.ctx.fillRect(0, 0, w, h);
  }
  if (p.softness > 0.05) {
    const soft = acquireTemp(w, h);
    blurTo(soft.ctx, field.canvas, w, h, p.softness);
    field.ctx.setTransform(1, 0, 0, 1, 0, 0);
    field.ctx.clearRect(0, 0, w, h);
    field.ctx.drawImage(soft.canvas, 0, 0);
    soft.busy = false;
  }

  blendOver(out, field.canvas, w, h, p.blend as GlobalCompositeOperation, p.amount, src);
  field.busy = false;
  return out.canvas;
}

// ── Film damage ──────────────────────────────────────────────────────────────
// Order matters and mirrors the physical chain: the strip MOVES in the gate
// (weave, slip), the lamp brightness varies (flicker), and only then does the
// debris sitting on the print get in the way of the light.

function filmDamagePass(src: CanvasImageSource, w: number, h: number, p: FilmDamageParams): CanvasImageSource {
  const out = nextOutput(w, h);
  out.ctx.drawImage(src, 0, 0);
  if (p.mix < 0.002) return out.canvas;

  // 1. The strip in the gate: weave + slip + lamp flicker.
  const moved = acquireTemp(w, h);
  const dy = p.weaveY + p.jumpOffset * h;
  moved.ctx.save();
  moved.ctx.translate(w / 2 + p.weaveX, h / 2 + dy);
  if (p.weaveRotate !== 0) moved.ctx.rotate(p.weaveRotate);
  moved.ctx.translate(-w / 2, -h / 2);
  drawFiltered(moved.ctx, src, [{ kind: "brightness", amount: p.exposure }]);
  moved.ctx.restore();

  // 2. Debris, on its own buffer so `dustSoftness` can blur the marks without
  //    blurring the picture underneath them.
  const marks = acquireTemp(w, h);
  const mctx = marks.ctx;

  for (const s of p.specks) {
    mctx.beginPath();
    mctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
    mctx.fillStyle = s.dark ? `rgba(0,0,0,${s.alpha})` : `rgba(255,255,255,${s.alpha})`;
    mctx.fill();
  }

  if (p.scratches.length) {
    const rgb = parseColor(p.scratchColor) ?? { r: 255, g: 255, b: 255, a: 1 };
    for (const sc of p.scratches) {
      mctx.save();
      // Softness feathers proportionally to the line's own width, so a hairline
      // scratch never dissolves into a grey smear at high softness.
      const x0 = Math.min(sc.x0, sc.x1) * w - sc.width;
      const y0 = Math.min(sc.y0, sc.y1) * h - sc.width;
      paintFiltered(mctx, sc.softness > 0.01 ? [{ kind: "blur", px: sc.softness * sc.width * 1.6 }] : [], (c) => {
        c.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${sc.alpha})`;
        c.lineWidth = sc.width;
        c.lineCap = "round";
        c.beginPath();
        c.moveTo(sc.x0 * w, sc.y0 * h);
        c.lineTo(sc.x1 * w, sc.y1 * h);
        c.stroke();
      }, { x: x0, y: y0, w: Math.abs(sc.x1 - sc.x0) * w + sc.width * 2, h: Math.abs(sc.y1 - sc.y0) * h + sc.width * 2 });
      mctx.restore();
    }
  }

  for (const hair of p.hairs) {
    if (hair.points.length < 2) continue;
    mctx.save();
    mctx.strokeStyle = `rgba(0,0,0,${hair.alpha})`;
    mctx.lineWidth = hair.width;
    mctx.lineCap = "round";
    mctx.lineJoin = "round";
    mctx.beginPath();
    mctx.moveTo(hair.points[0]!.x * w, hair.points[0]!.y * h);
    // Quadratic through the midpoints: a fibre curves, and a polyline of nine
    // straight segments reads as a bent wire instead.
    for (let i = 1; i < hair.points.length - 1; i++) {
      const a = hair.points[i]!;
      const b = hair.points[i + 1]!;
      mctx.quadraticCurveTo(a.x * w, a.y * h, ((a.x + b.x) / 2) * w, ((a.y + b.y) / 2) * h);
    }
    mctx.stroke();
    mctx.restore();
  }

  // 3. The splice bar riding through on a slip.
  if (p.spliceAt !== null && p.spliceIntensity > 0.002) {
    const y = p.spliceAt * h;
    const band = Math.max(2, h * 0.014);
    const grad = mctx.createLinearGradient(0, y - band, 0, y + band);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.5, `rgba(255,255,255,${p.spliceIntensity})`);
    grad.addColorStop(1, "rgba(255,255,255,0)");
    mctx.fillStyle = grad;
    mctx.fillRect(0, y - band, w, band * 2);
  }

  moved.ctx.setTransform(1, 0, 0, 1, 0, 0);
  moved.ctx.filter = "none";
  moved.ctx.drawImage(marks.canvas, 0, 0);
  if (p.inside) {
    // Clip to the MOVED silhouette, not the original — the damage belongs to
    // where the layer actually is this frame, weave included.
    const stencil = acquireTemp(w, h);
    stencil.ctx.save();
    stencil.ctx.translate(w / 2 + p.weaveX, h / 2 + dy);
    if (p.weaveRotate !== 0) stencil.ctx.rotate(p.weaveRotate);
    stencil.ctx.translate(-w / 2, -h / 2);
    stencil.ctx.drawImage(src, 0, 0);
    stencil.ctx.restore();
    moved.ctx.globalCompositeOperation = "destination-in";
    moved.ctx.drawImage(stencil.canvas, 0, 0);
    moved.ctx.globalCompositeOperation = "source-over";
    stencil.busy = false;
  }

  // 4. Wet/dry. Below 1 the untouched layer shows through, which is the only
  //    honest way to dial a destructive look back.
  if (p.mix < 0.999) {
    out.ctx.save();
    out.ctx.globalAlpha = p.mix;
    out.ctx.drawImage(moved.canvas, 0, 0);
    out.ctx.restore();
  } else {
    out.ctx.setTransform(1, 0, 0, 1, 0, 0);
    out.ctx.clearRect(0, 0, w, h);
    out.ctx.drawImage(moved.canvas, 0, 0);
  }
  marks.busy = false;
  moved.busy = false;
  return out.canvas;
}

// ── Scanlines ────────────────────────────────────────────────────────────────
// One mask generator covers all four shapes because they ARE one function: a
// periodic profile across the scan axis, optionally multiplied by a second
// profile across the other axis, optionally row-staggered.

const MASK_SAMPLES = 4; // supersampling of one period, so soft edges stay smooth
let maskTile: CachedTile | null = null;

/** The mask's dark-value profile across one period, 0 (clear) → 1 (masked). */
function maskProfile(t: number, thickness: number, softness: number): number {
  // A raised cosine when soft, a hard duty-cycle bar when not; `softness`
  // crossfades the two rather than switching, so the slider has no step in it.
  const bar = t < thickness ? 1 : 0;
  const sine = 0.5 - 0.5 * Math.cos((Math.min(t / thickness, 1) * 2 - 0) * Math.PI);
  const smooth = t < thickness ? sine : 0;
  return bar * (1 - softness) + smooth * softness;
}

function getMaskTile(p: ScanlineParams): HTMLCanvasElement {
  const key = [
    p.shape,
    p.pitch.toFixed(2),
    p.aspect.toFixed(3),
    p.thickness.toFixed(3),
    p.softness.toFixed(3),
    p.interlace.toFixed(3),
    p.interlaceOdd,
  ].join("|");
  if (maskTile && maskTile.key === key) return maskTile.canvas;

  // Interlace dims alternate periods, so the tile has to cover TWO of them for
  // the pattern to repeat correctly.
  const periods = p.interlace > 0.002 ? 2 : 1;
  const th = Math.max(2, Math.min(512, Math.round(p.pitch * MASK_SAMPLES))) * periods;
  const tw = p.shape === "dot" || p.shape === "slot"
    ? Math.max(2, Math.min(512, Math.round(p.pitch * p.aspect * MASK_SAMPLES)))
    : 2;

  const canvas = maskTile?.canvas ?? document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(tw, th);
  const d = img.data;
  const periodH = th / periods;

  for (let y = 0; y < th; y++) {
    const which = Math.floor(y / periodH);
    const ty = (y % periodH) / periodH;
    let v = maskProfile(ty, p.thickness, p.softness);
    // The dim field this beat gets the extra attenuation.
    if (periods === 2 && (which === 1) === p.interlaceOdd) v = Math.min(1, v + (1 - v) * p.interlace);
    for (let x = 0; x < tw; x++) {
      let m = v;
      if (p.shape === "dot" || p.shape === "slot") {
        // Slot masks stagger every other row by half a cell — that offset is
        // the entire visual difference between a shadow mask and a slot mask.
        const shift = p.shape === "slot" && which === 1 ? 0.5 : 0;
        const tx = ((x / tw + shift) % 1 + 1) % 1;
        m = Math.max(m, maskProfile(tx, p.thickness, p.softness));
      }
      const i = (y * tw + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = Math.round(Math.max(0, Math.min(1, m)) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  maskTile = { key, canvas };
  return canvas;
}

/**
 * Barrel warp — the tube's bulge. Separable: every COLUMN is stretched
 * vertically by how far it sits from the centre, then every ROW horizontally.
 * That is an approximation of a true radial remap, but it produces the same
 * bowed edges at a fraction of the cost, and a per-pixel remap of a full-res
 * buffer in JS is not affordable per frame.
 */
function barrelWarp(src: CanvasImageSource, w: number, h: number, k: number): HTMLCanvasElement {
  const STRIPS = 192;
  const a = acquireTemp(w, h);
  const stepX = Math.max(1, Math.ceil(w / STRIPS));
  for (let x = 0; x < w; x += stepX) {
    const sw = Math.min(stepX, w - x);
    const u = ((x + sw / 2) / w) * 2 - 1;
    const s = 1 + k * u * u * 0.35;
    a.ctx.drawImage(src, x, 0, sw, h, x, h / 2 - (h * s) / 2, sw, h * s);
  }
  const b = acquireTemp(w, h);
  const stepY = Math.max(1, Math.ceil(h / STRIPS));
  for (let y = 0; y < h; y += stepY) {
    const sh = Math.min(stepY, h - y);
    const v = ((y + sh / 2) / h) * 2 - 1;
    const s = 1 + k * v * v * 0.35;
    b.ctx.drawImage(a.canvas, 0, y, w, sh, w / 2 - (w * s) / 2, y, w * s, sh);
  }
  a.busy = false;
  b.busy = false; // caller draws from it immediately, before any other acquire
  return b.canvas;
}

function scanlinesPass(src: CanvasImageSource, w: number, h: number, p: ScanlineParams): CanvasImageSource {
  const out = nextOutput(w, h);
  out.ctx.drawImage(src, 0, 0);
  if (p.mix < 0.002) return out.canvas;

  // The picture itself first: lamp flicker, then phosphor bleed along the scan.
  const screen = acquireTemp(w, h);
  drawFiltered(screen.ctx, src, [{ kind: "brightness", amount: p.exposure }]);
  if (p.bleed > 0.05) {
    // Smear ALONG the lines (perpendicular to the mask's periodic axis) — that
    // is where a real beam over-runs, and blurring both ways would just be a
    // defocus.
    const dx = Math.cos(p.angleRad) * p.bleed;
    const dy = Math.sin(p.angleRad) * p.bleed;
    const taps = 5;
    const smear = acquireTemp(w, h);
    for (let i = 0; i < taps; i++) {
      const t = i / (taps - 1) - 0.5;
      smear.ctx.globalAlpha = 1 / (i + 1);
      smear.ctx.drawImage(screen.canvas, dx * t, dy * t);
    }
    smear.ctx.globalAlpha = 1;
    screen.ctx.setTransform(1, 0, 0, 1, 0, 0);
    screen.ctx.clearRect(0, 0, w, h);
    screen.ctx.drawImage(smear.canvas, 0, 0);
    smear.busy = false;
  }

  // The mask, laid down rotated and phase-shifted. Drawing it through a pattern
  // (rather than looping lines) means the cost is independent of the pitch.
  const tile = getMaskTile(p);
  const mask = acquireTemp(w, h);
  const pat = mask.ctx.createPattern(tile, "repeat");
  if (pat && pat.setTransform) {
    const periods = p.interlace > 0.002 ? 2 : 1;
    const sy = (p.pitch * periods) / tile.height;
    const sx = p.shape === "dot" || p.shape === "slot" ? (p.pitch * p.aspect) / tile.width : sy;
    pat.setTransform(
      new DOMMatrix()
        .translate(w / 2, h / 2)
        .rotate((p.angleRad * 180) / Math.PI)
        .translate(0, p.offset)
        .scale(sx, sy),
    );
  }
  if (pat) {
    mask.ctx.fillStyle = pat;
    mask.ctx.fillRect(0, 0, w, h);
  }

  if (p.amount > 0.002) {
    const tint = acquireTemp(w, h);
    tint.ctx.drawImage(mask.canvas, 0, 0);
    tint.ctx.globalCompositeOperation = "source-in";
    tint.ctx.fillStyle = p.color;
    tint.ctx.fillRect(0, 0, w, h);
    tint.ctx.globalCompositeOperation = "source-over";
    screen.ctx.save();
    screen.ctx.globalCompositeOperation = p.blend as GlobalCompositeOperation;
    screen.ctx.globalAlpha = p.amount;
    screen.ctx.drawImage(tint.canvas, 0, 0);
    screen.ctx.restore();
    tint.busy = false;
  }

  // Boost lights the GAPS between the lines — the phosphor glowing back at you.
  // Without it a scanline card only ever subtracts, and the picture just gets
  // darker as you raise the amount.
  if (p.boost > 0.002) {
    const gaps = acquireTemp(w, h);
    gaps.ctx.fillStyle = "#ffffff";
    gaps.ctx.fillRect(0, 0, w, h);
    gaps.ctx.globalCompositeOperation = "destination-out";
    gaps.ctx.drawImage(mask.canvas, 0, 0);
    gaps.ctx.globalCompositeOperation = "source-over";
    screen.ctx.save();
    screen.ctx.globalCompositeOperation = "lighter";
    screen.ctx.globalAlpha = Math.min(1, p.boost * 0.5);
    screen.ctx.drawImage(gaps.canvas, 0, 0);
    screen.ctx.restore();
    gaps.busy = false;
  }

  let result: CanvasImageSource = screen.canvas;
  if (p.curvature > 0.002) result = barrelWarp(screen.canvas, w, h, p.curvature);

  if (p.mix < 0.999) {
    out.ctx.save();
    out.ctx.globalAlpha = p.mix;
    out.ctx.drawImage(result, 0, 0);
    out.ctx.restore();
  } else {
    out.ctx.clearRect(0, 0, w, h);
    out.ctx.drawImage(result, 0, 0);
  }
  if (p.inside) {
    out.ctx.globalCompositeOperation = "destination-in";
    // Curvature moves the layer's own edges, so the stencil has to bend too.
    out.ctx.drawImage(p.curvature > 0.002 ? barrelWarp(src, w, h, p.curvature) : src, 0, 0);
    out.ctx.globalCompositeOperation = "source-over";
  }
  mask.busy = false;
  screen.busy = false;
  return out.canvas;
}

// ── Noise ────────────────────────────────────────────────────────────────────

/** Field pixels per feature. Below ~3 the fBm aliases; above ~6 it is free detail nobody sees. */
const FIELD_SAMPLES_PER_FEATURE = 4;
/** Hard ceiling on generated field pixels — fBm is the one genuinely costly loop here. */
const FIELD_MAX = 320;

/**
 * Generate the noise field at FEATURE resolution and let `drawImage` upscale it.
 * `sampleNoiseField` (core) is the single sampler, so the visible overlay and
 * the displacement below read the exact same field.
 */
function buildNoiseField(p: NoiseParams, w: number, h: number): { canvas: HTMLCanvasElement; buf: Buf; fw: number; fh: number } {
  const density = FIELD_SAMPLES_PER_FEATURE / p.scale;
  const fw = Math.max(4, Math.min(FIELD_MAX, Math.round(w * density)));
  const fh = Math.max(4, Math.min(FIELD_MAX, Math.round(h * density)));
  const buf = acquireTemp(fw, fh);
  const img = buf.ctx.createImageData(fw, fh);
  const d = img.data;
  const lo = parseColor(p.lowColor) ?? { r: 0, g: 0, b: 0, a: 1 };
  const hi = parseColor(p.highColor) ?? { r: 255, g: 255, b: 255, a: 1 };
  const colour = p.chroma > 0.001;
  for (let y = 0; y < fh; y++) {
    // Sample in DEVICE space so `scale` stays a real pixel size whatever
    // resolution the field itself ended up at.
    const dy = (y / fh) * h;
    for (let x = 0; x < fw; x++) {
      const dx = (x / fw) * w;
      const i = (y * fw + x) * 4;
      if (colour) {
        d[i] = lo.r + (hi.r - lo.r) * sampleNoiseField(p, dx, dy, 0);
        d[i + 1] = lo.g + (hi.g - lo.g) * sampleNoiseField(p, dx, dy, 1);
        d[i + 2] = lo.b + (hi.b - lo.b) * sampleNoiseField(p, dx, dy, 2);
      } else {
        const v = sampleNoiseField(p, dx, dy, 0);
        d[i] = lo.r + (hi.r - lo.r) * v;
        d[i + 1] = lo.g + (hi.g - lo.g) * v;
        d[i + 2] = lo.b + (hi.b - lo.b) * v;
      }
      d[i + 3] = 255;
    }
  }
  buf.ctx.putImageData(img, 0, 0);
  return { canvas: buf.canvas, buf, fw, fh };
}

/**
 * Warp the layer by the field. Separable, like the barrel: every ROW slides
 * horizontally and every COLUMN vertically, each by its own sample. Row-wise
 * horizontal slip is exactly the artefact a tape head produces, so the cheap
 * decomposition happens to be the physically right one for the main use — but
 * it is an approximation, and a true 2D remap would cost a per-pixel loop.
 */
function displaceByField(src: CanvasImageSource, w: number, h: number, p: NoiseParams): HTMLCanvasElement {
  const STRIPS = 256;
  const a = acquireTemp(w, h);
  const stepY = Math.max(1, Math.ceil(h / STRIPS));
  for (let y = 0; y < h; y += stepY) {
    const sh = Math.min(stepY, h - y);
    const dx = (sampleNoiseField(p, 0, y + sh / 2, 0) - 0.5) * 2 * p.displace;
    a.ctx.drawImage(src, 0, y, w, sh, dx, y, w, sh);
  }
  const b = acquireTemp(w, h);
  const stepX = Math.max(1, Math.ceil(w / STRIPS));
  for (let x = 0; x < w; x += stepX) {
    const sw = Math.min(stepX, w - x);
    const dy = (sampleNoiseField(p, x + sw / 2, 0, 1) - 0.5) * 2 * p.displace;
    b.ctx.drawImage(a.canvas, x, 0, sw, h, x, dy, sw, h);
  }
  a.busy = false;
  b.busy = false;
  return b.canvas;
}

function noisePass(src: CanvasImageSource, w: number, h: number, p: NoiseParams): CanvasImageSource {
  const out = nextOutput(w, h);
  out.ctx.drawImage(src, 0, 0);
  if (p.mix < 0.002) return out.canvas;

  const warped = p.displace > 0.05 ? displaceByField(src, w, h, p) : src;

  const stage = acquireTemp(w, h);
  stage.ctx.drawImage(warped, 0, 0);

  if (p.amount > 0.002) {
    const field = buildNoiseField(p, w, h);
    stage.ctx.save();
    stage.ctx.globalCompositeOperation = p.blend as GlobalCompositeOperation;
    stage.ctx.globalAlpha = p.amount;
    stage.ctx.imageSmoothingEnabled = true;
    stage.ctx.imageSmoothingQuality = "high";
    stage.ctx.drawImage(field.canvas, 0, 0, w, h);
    stage.ctx.restore();
    field.buf.busy = false;
  }
  if (p.inside) {
    stage.ctx.globalCompositeOperation = "destination-in";
    stage.ctx.drawImage(warped, 0, 0);
    stage.ctx.globalCompositeOperation = "source-over";
  }

  if (p.mix < 0.999) {
    out.ctx.save();
    out.ctx.globalAlpha = p.mix;
    out.ctx.drawImage(stage.canvas, 0, 0);
    out.ctx.restore();
  } else {
    out.ctx.clearRect(0, 0, w, h);
    out.ctx.drawImage(stage.canvas, 0, 0);
  }
  stage.busy = false;
  return out.canvas;
}


export const grain: PassFn<"grain"> = (p, src, w, h) => grainPass(src, w, h, p.params);
export const filmDamage: PassFn<"filmDamage"> = (p, src, w, h) => filmDamagePass(src, w, h, p.params);
export const scanlines: PassFn<"scanlines"> = (p, src, w, h) => scanlinesPass(src, w, h, p.params);
export const noise: PassFn<"noise"> = (p, src, w, h) => noisePass(src, w, h, p.params);
