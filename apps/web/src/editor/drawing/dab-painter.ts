"use client";

import {
  GRAIN_TILE,
  grainTile,
  tipStencil,
  type BrushPreset,
  type Dab,
  type TipStencil,
} from "@solomotion/core";
import { getAssetBlob } from "../assets/asset-store";

/**
 * The dab painter — rasterizes StrokeEngine dabs. The engine produces pure
 * math (position/size/alpha/angle/colour); this stamps them, and NOTHING else
 * in the app draws brush pixels — the stage stroke, the Brush Studio playground
 * and every thumbnail stamp through here, so a brush can never look different
 * in two places.
 *
 * THE SPEED MODEL, which is the whole design:
 *
 *   One TIP SPRITE per (tip identity, colour), baked once at a reference size
 *   and `drawImage`-scaled per dab. A bristle tip with forty hairs and a hard
 *   round cost exactly the same per dab — one GPU blit — because all the
 *   intricacy is spent at BAKE time, once, and never at stroke time.
 *
 * That is why the tips are math rather than bitmaps (`core/drawing/tips`): a
 * stencil bakes to a crisp sprite at any size, tints to any colour, and needs
 * no asset to load before the first stroke can land.
 *
 * COLOUR JITTER would break that cache — a fresh colour per dab is a fresh
 * sprite per dab. So hue/saturation/lightness shifts are QUANTISED into a small
 * ring of sprite buckets (`TINT_STEPS`): a confetti brush cycles through 24
 * cached sprites instead of baking 400, and the eye cannot tell.
 */

const SPRITE_SIZE = 128; // reference tip resolution; dabs scale from here
const SPRITE_CACHE_MAX = 192;
const spriteCache = new Map<string, HTMLCanvasElement>();

/**
 * How finely a modulated colour is quantised before it earns its own sprite.
 * 24 steps is under 15° of hue — below what reads as a distinct colour on a
 * mark a few pixels wide, and it caps a jittering brush's sprite cost.
 */
const TINT_STEPS = 24;

/**
 * Custom tip and grain bitmaps, streamed once per blob id.
 *
 * Decoded through an `<img>` element rather than `createImageBitmap`, and that
 * is not a style preference: `createImageBitmap` does not accept SVG blobs in
 * Firefox, so every uploaded SVG tip silently fell back to a plain round dot.
 * An object URL into an `HTMLImageElement` decodes PNG, JPEG, WebP and SVG in
 * every browser, and a canvas draws it either way.
 */
const brushImages = new Map<string, CanvasImageSource | "loading" | "missing">();

/** Told when a bitmap lands, so anything showing a stale tip can redraw. */
const imageListeners = new Set<() => void>();

export function onBrushImageLoaded(cb: () => void): () => void {
  imageListeners.add(cb);
  return () => imageListeners.delete(cb);
}

/** SVGs often declare no intrinsic size; rasterise them big enough to stamp. */
const SVG_RASTER_PX = 512;

/**
 * A VIDEO as a brush tip: seek to the first drawable frame and keep it.
 *
 * A stamp is one image, so a moving source contributes a frame — which is the
 * useful reading of "use this footage as my brush", and it means a video, a GIF
 * and a PNG all arrive at the painter as the same thing.
 */
function decodeVideo(blob: Blob): Promise<CanvasImageSource> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    const fail = () => {
      URL.revokeObjectURL(url);
      reject(new Error("video decode failed"));
    };
    video.onerror = fail;
    video.onloadeddata = () => {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, SVG_RASTER_PX / Math.max(video.videoWidth, video.videoHeight, 1));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    video.src = url;
    // Nudge off frame zero: many encodes open on a black or empty first frame.
    video.currentTime = 0.04;
  });
}

function decodeBlob(blob: Blob): Promise<CanvasImageSource> {
  if (blob.type.startsWith("video/")) return decodeVideo(blob);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      // Paint into a canvas at a known size: a sizeless SVG reports 0×0 to
      // `drawImage` on some engines, and a decoded raster costs nothing to keep.
      const w = img.naturalWidth || SVG_RASTER_PX;
      const h = img.naturalHeight || SVG_RASTER_PX;
      const scale = Math.min(1, SVG_RASTER_PX / Math.max(w, h));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode failed"));
    };
    img.src = url;
  });
}

function brushImage(imageId: string): CanvasImageSource | null {
  const hit = brushImages.get(imageId);
  if (hit && hit !== "loading" && hit !== "missing") return hit;
  if (!hit) {
    brushImages.set(imageId, "loading");
    void (async () => {
      try {
        const blob = await getAssetBlob(imageId);
        brushImages.set(imageId, blob ? await decodeBlob(blob) : "missing");
      } catch {
        brushImages.set(imageId, "missing");
      }
      // A sprite baked while this was still loading fell back to a round tip and
      // would otherwise stay cached under the same key forever — which is the
      // whole reason an uploaded shape "didn't show up" even after it arrived.
      spriteCache.clear();
      for (const cb of [...imageListeners]) cb();
    })();
  }
  return null;
}

// ── Colour ──────────────────────────────────────────────────────────────────

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseColor(color: string): Rgb {
  if (color.startsWith("#")) {
    const hex =
      color.length === 4
        ? `${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
        : color.slice(1, 7);
    const n = parseInt(hex, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const m = /rgba?\(([^)]+)\)/.exec(color);
  if (m) {
    const [r = 0, g = 0, b = 0] = m[1]!.split(",").map((v) => parseFloat(v));
    return { r, g, b };
  }
  return { r: 255, g: 255, b: 255 };
}

function rgbToHsl({ r, g, b }: Rgb): [number, number, number] {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === R ? ((G - B) / d + (G < B ? 6 : 0)) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}

function hslToCss(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue.toFixed(1)} ${(Math.min(1, Math.max(0, s)) * 100).toFixed(1)}% ${(Math.min(1, Math.max(0, l)) * 100).toFixed(1)}%)`;
}

/** Quantise to `TINT_STEPS` buckets — the sprite cache's whole defence. */
const quantise = (v: number) => Math.round(v * TINT_STEPS) / TINT_STEPS;

/**
 * The colour ONE dab paints in. Returns the base string untouched when the dab
 * carries no shift, so the overwhelming majority of brushes never enter the
 * HSL path or grow a second sprite.
 */
function dabColor(base: string, dab: Dab): string {
  if (dab.hue === 0 && dab.saturation === 0 && dab.lightness === 0) return base;
  const [h, s, l] = rgbToHsl(parseColor(base));
  return hslToCss(
    h + quantise(dab.hue / 360) * 360,
    s + quantise(dab.saturation),
    Math.min(0.97, Math.max(0.03, l + quantise(dab.lightness))),
  );
}

// ── Tip sprites ─────────────────────────────────────────────────────────────

/** The stencil's identity — everything that changes the baked pixels. */
function tipKey(brush: BrushPreset, variant: number): string {
  const s = brush.shape;
  return [
    s.type,
    s.sources[variant]?.assetId ?? "",
    s.hardness.toFixed(3),
    s.density.toFixed(3),
    s.spread.toFixed(3),
    s.irregular.toFixed(3),
    s.sides,
    s.seed,
  ].join(":");
}

/** Paint a stencil's alpha into a square context of side `size`. */
function paintStencil(ctx: CanvasRenderingContext2D, stencil: TipStencil, size: number): void {
  const r = size / 2;
  const toPx = (v: number) => v * r;

  for (const poly of stencil.polys) {
    if (poly.length < 3) continue;
    ctx.beginPath();
    ctx.moveTo(r + toPx(poly[0]!.x), r + toPx(poly[0]!.y));
    for (const p of poly.slice(1)) ctx.lineTo(r + toPx(p.x), r + toPx(p.y));
    ctx.closePath();
    ctx.fill();
  }

  for (const dot of stencil.dots) {
    const cx = r + toPx(dot.x);
    const cy = r + toPx(dot.y);
    const rad = Math.max(0.5, toPx(dot.r));
    ctx.globalAlpha = dot.alpha;
    if (dot.hardness >= 0.98) {
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const grad = ctx.createRadialGradient(cx, cy, rad * Math.max(0, dot.hardness), cx, cy, rad);
      grad.addColorStop(0, "#fff");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      const prev = ctx.fillStyle;
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = prev;
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * Bake one tip: the stencil's alpha, tinted to `color`.
 *
 * Built white-on-transparent first and then tinted through `source-in`, rather
 * than drawn in the colour directly — a radial gradient to a transparent stop
 * of a SATURATED colour darkens toward grey in the middle of the falloff
 * (premultiplication), which is why soft brushes in other engines get a dirty
 * halo. Alpha first, colour second, never dirty.
 */
function tipSprite(brush: BrushPreset, color: string, variant = 0): HTMLCanvasElement {
  const key = `${tipKey(brush, variant)}|${color}`;
  const hit = spriteCache.get(key);
  if (hit) return hit;

  const canvas = document.createElement("canvas");
  canvas.width = SPRITE_SIZE;
  canvas.height = SPRITE_SIZE;
  const ctx = canvas.getContext("2d")!;
  const s = brush.shape;
  const source = s.type === "image" ? s.sources[variant] ?? s.sources[0] : undefined;
  const image = source ? brushImage(source.assetId) : null;

  ctx.fillStyle = "#fff";
  if (image) {
    // A custom tip: the bitmap's own alpha IS the stamp, fitted and centred.
    const iw = "width" in image ? Number(image.width) : SPRITE_SIZE;
    const ih = "height" in image ? Number(image.height) : SPRITE_SIZE;
    const fit = Math.min(SPRITE_SIZE / iw, SPRITE_SIZE / ih);
    ctx.drawImage(image, (SPRITE_SIZE - iw * fit) / 2, (SPRITE_SIZE - ih * fit) / 2, iw * fit, ih * fit);
  } else {
    const stencil = tipStencil(s.type as never, {
      density: s.density,
      spread: s.spread,
      irregular: s.irregular,
      hardness: s.hardness,
      sides: s.sides,
    }, s.seed);
    // A stencil's `polys` and `dots` are its MARKS; `mask` shapes them. When a
    // family describes no marks at all, the mask IS the shape — that is exactly
    // what `round` is, a disc defined purely by its falloff — so there has to be
    // something for it to cut. Filling the tile first and masking it to a disc
    // is that something.
    //
    // Getting this wrong silently emptied every round-tipped brush in the
    // library (pens, airbrushes, monoline, watercolour) while the grit and
    // polygon families, which draw marks before masking, rendered fine.
    if (stencil.polys.length === 0 && stencil.dots.length === 0) {
      ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
    } else {
      paintStencil(ctx, stencil, SPRITE_SIZE);
    }
    if (stencil.mask) applyRadialMask(ctx, stencil.mask.inner);
  }

  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);

  // A tiny cache with a cheap rebuild — never a leak on a long session.
  if (spriteCache.size > SPRITE_CACHE_MAX) spriteCache.clear();
  spriteCache.set(key, canvas);
  return canvas;
}

/** Multiply the sprite's alpha by a radial falloff — the soft-edge pass. */
function applyRadialMask(ctx: CanvasRenderingContext2D, inner: number): void {
  const r = SPRITE_SIZE / 2;
  const grad = ctx.createRadialGradient(r, r, Math.min(0.97, Math.max(0, inner)) * r, r, r, r);
  grad.addColorStop(0, "#fff");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  ctx.globalCompositeOperation = "source-over";
}

/**
 * The baked tip, for anything that wants to SHOW a tip rather than stamp it —
 * the studio's shape gallery and its tip slots. Same bake, same cache, so the
 * glyph in the picker is literally the sprite the stroke will use.
 */
export function tipPreviewCanvas(brush: BrushPreset, color: string, variant = 0): HTMLCanvasElement {
  return tipSprite(brush, color, variant);
}

/** Drop every cached sprite for one brush — the studio's live-edit seam. */
export function invalidateBrushSprites(): void {
  spriteCache.clear();
}

// ── Grain ───────────────────────────────────────────────────────────────────

const grainCache = new Map<string, HTMLCanvasElement>();

/** A baked tile of the brush's paper, cached per (texture, seed). */
function grainCanvas(brush: BrushPreset): CanvasImageSource | null {
  const g = brush.grain;
  if (g.imageId) return brushImage(g.imageId);
  const key = `${g.texture}:${g.seed}`;
  const hit = grainCache.get(key);
  if (hit) return hit;

  const canvas = document.createElement("canvas");
  canvas.width = GRAIN_TILE;
  canvas.height = GRAIN_TILE;
  const ctx = canvas.getContext("2d")!;
  const alpha = grainTile(g.texture, g.seed);
  const img = ctx.createImageData(GRAIN_TILE, GRAIN_TILE);
  for (let i = 0; i < alpha.length; i++) img.data[i * 4 + 3] = alpha[i]!;
  ctx.putImageData(img, 0, 0);
  if (grainCache.size > 24) grainCache.clear();
  grainCache.set(key, canvas);
  return canvas;
}

/**
 * Gate a stroke buffer's alpha through the brush's grain: per-pixel alpha
 * becomes `a·((1−i) + i·g)` — intensity 0 leaves the paint solid, 1 lets the
 * paper fully decide. The pattern is ANCHORED to the buffer (= the layer's
 * surface), so successive strokes reveal the same texture — true paper.
 * Returns a gated COPY; the buffer itself stays intact for live preview.
 */
export function grainGatedBuffer(buffer: HTMLCanvasElement, brush: BrushPreset): HTMLCanvasElement {
  const g = brush.grain;
  if (g.intensity <= 0.001) return buffer;
  const tile = grainCanvas(brush);
  if (!tile) return buffer;

  const out = document.createElement("canvas");
  out.width = buffer.width;
  out.height = buffer.height;
  const ctx = out.getContext("2d")!;
  ctx.drawImage(buffer, 0, 0);

  // The gate: a layer whose alpha is (1−i) + i·grain, multiplied in via
  // destination-in.
  const gate = document.createElement("canvas");
  gate.width = buffer.width;
  gate.height = buffer.height;
  const gctx = gate.getContext("2d")!;
  gctx.globalAlpha = 1 - g.intensity;
  gctx.fillStyle = "#fff";
  gctx.fillRect(0, 0, gate.width, gate.height);
  gctx.globalAlpha = g.intensity;
  const scale = Math.max(0.1, g.scale);
  gctx.save();
  gctx.scale(scale, scale);
  const pattern = gctx.createPattern(tile as CanvasImageSource, "repeat");
  if (pattern) {
    gctx.fillStyle = pattern;
    gctx.fillRect(0, 0, gate.width / scale, gate.height / scale);
  }
  gctx.restore();

  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(gate, 0, 0);
  return out;
}

// ── Stamping ────────────────────────────────────────────────────────────────

export interface StampTarget {
  ctx: CanvasRenderingContext2D;
  /** Erase mode: dabs remove alpha instead of painting color. */
  erase?: boolean;
}

/** Stamp a run of dabs. Returns the dirty rect they touched (or null). */
export function stampDabs(
  target: StampTarget,
  dabs: readonly Dab[],
  brush: BrushPreset,
  color: string,
): { x0: number; y0: number; x1: number; y1: number } | null {
  if (dabs.length === 0) return null;
  const { ctx } = target;
  const erasing = target.erase || brush.rendering.erase;
  ctx.save();
  ctx.globalCompositeOperation = erasing ? "destination-out" : "source-over";

  // The common case by far: one sprite for the whole run. Only a brush that
  // actually modulates colour pays for the per-dab lookup.
  const plain = erasing ? "#ffffff" : color;
  const particles = brush.shape.type === "image" && brush.shape.sources.length > 1;
  const flat = particles ? null : tipSprite(brush, plain);

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const dab of dabs) {
    const tinted = erasing ? plain : dabColor(color, dab);
    const sprite = flat && tinted === plain ? flat : tipSprite(brush, tinted, dab.variant);
    const half = dab.size / 2;
    ctx.globalAlpha = Math.min(1, Math.max(0, dab.alpha));
    const squashed = dab.roundness < 0.999;
    if (dab.angle !== 0 || squashed) {
      ctx.save();
      ctx.translate(dab.x, dab.y);
      ctx.rotate(dab.angle);
      // Roundness squashes the tip on its MINOR axis, after rotation — which
      // is what makes a squashed nib carve a calligraphic edge rather than
      // just drawing a smaller circle.
      if (squashed) ctx.scale(1, Math.max(0.05, dab.roundness));
      ctx.drawImage(sprite, -half, -half, dab.size, dab.size);
      ctx.restore();
    } else {
      ctx.drawImage(sprite, dab.x - half, dab.y - half, dab.size, dab.size);
    }
    x0 = Math.min(x0, dab.x - half - 2);
    y0 = Math.min(y0, dab.y - half - 2);
    x1 = Math.max(x1, dab.x + half + 2);
    y1 = Math.max(y1, dab.y + half + 2);
  }
  ctx.restore();
  return { x0, y0, x1, y1 };
}
