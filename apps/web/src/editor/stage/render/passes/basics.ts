"use client";

import { parseColor } from "@/lib/color";
import { drawBlurred, drawFiltered } from "../canvas-filter";
import { blurTo } from "../gaussian";
import { acquireTemp, nextOutput, releaseTemp, shiftClamped, type Buf } from "./buffers";
import { farthestCorner, rotateFamily, scaleFamily, shiftFamily, smear } from "./smear";
import type { PassFn } from "./types";

/**
 * THE BASICS — vignette, sharpen, the three blurs, inner shadow, glow, stroke,
 * long shadow and RGB split.
 *
 * The ONE pass family that is statically imported (see `registry.ts`). These
 * are the effects on screen within a second of opening almost any document, and
 * every one of them is a handful of canvas calls with no engine behind it — so
 * the bytes are small and the latency of fetching them would be the most
 * visible thing about them. Everything heavier is a lazy chunk.
 */

// ── Vignette ─────────────────────────────────────────────────────────────────
function vignettePass(src: CanvasImageSource, w: number, h: number, p: Extract<import("./types").LfxPass, { kind: "vignette" }>): CanvasImageSource {
  const out = nextOutput(w, h);
  out.ctx.drawImage(src, 0, 0);
  const amt = Math.abs(p.amount);
  if (amt < 0.001) return out.canvas;
  const rgb = parseColor(p.color) ?? { r: 0, g: 0, b: 0, a: 1 };
  // amount<0 brightens (paint white), amount>0 darkens (paint the vignette color).
  const [cr, cg, cb] = p.amount < 0 ? [255, 255, 255] : [rgb.r, rgb.g, rgb.b];
  const cx = w / 2;
  const cy = h / 2;
  // Radius: blend between an ellipse fitted to the frame (roundness 0) and a
  // circle covering the corners (roundness 1).
  const ellipse = Math.max(w, h) / 2;
  const circle = Math.hypot(w, h) / 2;
  const outer = ellipse + (circle - ellipse) * p.roundness;
  const inner = outer * (1 - p.softness) * 0.85;
  out.ctx.save();
  out.ctx.translate(cx, cy);
  out.ctx.scale(1, h / w); // circle → frame-aspect ellipse
  const r = outer * (w / Math.max(w, h)); // undo the y-scale on the radius basis
  const grad = out.ctx.createRadialGradient(0, 0, (inner * w) / Math.max(w, h), 0, 0, r);
  grad.addColorStop(0, `rgba(${cr},${cg},${cb},0)`);
  grad.addColorStop(1, `rgba(${cr},${cg},${cb},${amt})`);
  out.ctx.fillStyle = grad;
  out.ctx.fillRect(-w, -h, w * 2, h * 2);
  out.ctx.restore();
  // Keep the vignette inside the layer's own silhouette.
  out.ctx.globalCompositeOperation = "destination-in";
  out.ctx.drawImage(src, 0, 0);
  out.ctx.globalCompositeOperation = "source-over";
  return out.canvas;
}

// ── Sharpen (unsharp mask) ───────────────────────────────────────────────────
function sharpenPass(src: CanvasImageSource, w: number, h: number, p: Extract<import("./types").LfxPass, { kind: "sharpen" }>): CanvasImageSource {
  if (p.amount < 0.001) {
    const passthrough = nextOutput(w, h);
    passthrough.ctx.drawImage(src, 0, 0);
    return passthrough.canvas;
  }
  const base = acquireTemp(w, h);
  base.ctx.drawImage(src, 0, 0);
  const blur = acquireTemp(w, h);
  blurTo(blur.ctx, src, w, h, Math.max(0.3, p.radius));
  const sd = base.ctx.getImageData(0, 0, w, h);
  const bd = blur.ctx.getImageData(0, 0, w, h);
  const s = sd.data;
  const b = bd.data;
  const a = p.amount;
  for (let i = 0; i < s.length; i += 4) {
    // out = src + amount * (src − blur), per channel, alpha untouched.
    s[i] = clamp8(s[i]! + a * (s[i]! - b[i]!));
    s[i + 1] = clamp8(s[i + 1]! + a * (s[i + 1]! - b[i + 1]!));
    s[i + 2] = clamp8(s[i + 2]! + a * (s[i + 2]! - b[i + 2]!));
  }
  const out = nextOutput(w, h);
  out.ctx.putImageData(sd, 0, 0);
  base.busy = false;
  blur.busy = false;
  return out.canvas;
}
function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// ── Directional (motion) blur ────────────────────────────────────────────────
function directionalBlurPass(src: CanvasImageSource, w: number, h: number, p: Extract<import("./types").LfxPass, { kind: "directionalBlur" }>): CanvasImageSource {
  const out = nextOutput(w, h);
  if (p.distance < 0.5) {
    out.ctx.drawImage(src, 0, 0);
    return out.canvas;
  }
  // A symmetric smear, spaced by pixels rather than by a fixed count (`smear`).
  const rad = (p.angle * Math.PI) / 180;
  const sm = smear(src, w, h, shiftFamily(Math.cos(rad) * p.distance, Math.sin(rad) * p.distance), p.distance, -0.5);
  out.ctx.drawImage(sm.canvas, 0, 0);
  releaseTemp(sm);
  return out.canvas;
}

// ── Zoom blur ────────────────────────────────────────────────────────────────
function zoomBlurPass(src: CanvasImageSource, w: number, h: number, p: Extract<import("./types").LfxPass, { kind: "zoomBlur" }>): CanvasImageSource {
  const out = nextOutput(w, h);
  if (p.strength < 0.001) {
    out.ctx.drawImage(src, 0, 0);
    return out.canvas;
  }
  const cx = w / 2 + (p.cx * w) / 2;
  const cy = h / 2 + (p.cy * h) / 2;
  const maxScale = 1 + p.strength * 0.3;
  // Every scale from 1 to maxScale, a pixel apart at the far corner (`smear`).
  const sm = smear(src, w, h, scaleFamily(cx, cy, maxScale), farthestCorner(cx, cy, w, h) * (maxScale - 1));
  out.ctx.drawImage(sm.canvas, 0, 0);
  releaseTemp(sm);
  return out.canvas;
}

// ── Inner shadow ─────────────────────────────────────────────────────────────
// The layer's own alpha is the stencil: build the INVERSE silhouette, cast a
// blurred/offset shadow off its edge (which falls INTO the shape), then clip
// that shadow back inside the silhouette and lay it over the layer.
function innerShadowPass(src: CanvasImageSource, w: number, h: number, p: Extract<import("./types").LfxPass, { kind: "innerShadow" }>): CanvasImageSource {
  const out = nextOutput(w, h);
  out.ctx.drawImage(src, 0, 0);

  // inv = opaque field with the silhouette punched out.
  const inv = acquireTemp(w, h);
  inv.ctx.fillStyle = "#000";
  inv.ctx.fillRect(0, 0, w, h);
  inv.ctx.globalCompositeOperation = "destination-out";
  inv.ctx.drawImage(src, 0, 0);
  inv.ctx.globalCompositeOperation = "source-over";

  // Cast inv's edge shadow (colored) — it blooms into the hole = inside the shape.
  const sh = acquireTemp(w, h);
  sh.ctx.shadowColor = p.color;
  sh.ctx.shadowBlur = Math.max(0, p.blur);
  sh.ctx.shadowOffsetX = p.x;
  sh.ctx.shadowOffsetY = p.y;
  sh.ctx.drawImage(inv.canvas, 0, 0);
  // Keep only the part of the shadow that sits inside the silhouette.
  sh.ctx.shadowColor = "transparent";
  sh.ctx.globalCompositeOperation = "destination-in";
  sh.ctx.drawImage(src, 0, 0);
  sh.ctx.globalCompositeOperation = "source-over";

  out.ctx.drawImage(sh.canvas, 0, 0);
  inv.busy = false;
  sh.busy = false;
  return out.canvas;
}

// ── Glow (outer / inner, auto / solid) ───────────────────────────────────────
/** `glowFalloff: light` — [fraction of size, weight] per bloom octave, core first. */
const LIGHT_FALLOFF: ReadonlyArray<readonly [number, number]> = [
  [0.125, 0.4],
  [0.25, 0.3],
  [0.5, 0.2],
  [1, 0.1],
];
/**
 * The bloom SOURCE is the whole difference between the two modes, and it is one
 * branch: `auto` takes the layer's own pixels and pushes them (saturate then
 * brighten, which is what emitted light does to a surface colour), `solid`
 * floods the silhouette with one colour. Everything after that — blur, clip,
 * composite — is identical, which is the point: there is one Glow.
 */
function glowPass(src: CanvasImageSource, w: number, h: number, p: Extract<import("./types").LfxPass, { kind: "glow" }>): CanvasImageSource {
  const out = nextOutput(w, h);
  if (p.intensity < 0.001 || p.size < 0.1) {
    out.ctx.drawImage(src, 0, 0);
    return out.canvas;
  }
  const tint = acquireTemp(w, h);
  if (p.mode === "auto") {
    // Its own colours, pushed. A gradient blooms as a gradient; a retint of the
    // layer carries into its light with nothing else to update.
    drawFiltered(tint.ctx, src, [
      { kind: "saturate", amount: Math.max(0, p.saturation) },
      { kind: "brightness", amount: Math.max(0, p.brightness) },
    ]);
  } else {
    // A silhouette flooded with the chosen colour (alpha preserved).
    tint.ctx.drawImage(src, 0, 0);
    tint.ctx.globalCompositeOperation = "source-in";
    tint.ctx.fillStyle = p.color;
    tint.ctx.fillRect(0, 0, w, h);
    tint.ctx.globalCompositeOperation = "source-over";
  }

  // Intensity can pass 1 (a blown-out neon core), and alpha cannot — so the
  // gain is spread over as many additive layers as it takes. At the default
  // 0.8 this is exactly the two passes the effect has always drawn.
  const gain = p.intensity * 2;
  const layers = Math.max(1, Math.min(8, Math.ceil(gain)));
  const alpha = Math.min(1, gain / layers);

  if (p.inner) {
    // Inner glow: blurred bloom clipped to the inside of the silhouette, added
    // over the layer so it reads from the edge inward.
    out.ctx.drawImage(src, 0, 0);
    const g = acquireTemp(w, h);
    blurTo(g.ctx, tint.canvas, w, h, p.size);
    g.ctx.globalCompositeOperation = "destination-in";
    g.ctx.drawImage(src, 0, 0);
    g.ctx.globalCompositeOperation = "source-over";
    out.ctx.save();
    out.ctx.globalCompositeOperation = "lighter";
    out.ctx.globalAlpha = alpha;
    for (let i = 0; i < layers; i++) out.ctx.drawImage(g.canvas, 0, 0);
    out.ctx.restore();
    g.busy = false;
  } else {
    // Outer glow: blurred bloom behind, then the crisp layer on top.
    // Blurred ONCE, laid down `layers` times — the same light, and one blur
    // instead of N on either executor.
    const bloom = acquireTemp(w, h);
    if (p.glowFalloff === "light") {
      // A lens bloom: the same light at four radii, summed core-heavy (weights
      // add to 1, so a big shape keeps the brightness `even` gives it).
      bloom.ctx.save();
      bloom.ctx.globalCompositeOperation = "lighter";
      for (const [k, wgt] of LIGHT_FALLOFF) {
        bloom.ctx.globalAlpha = wgt;
        drawBlurred(bloom.ctx, tint.canvas, p.size * k);
      }
      bloom.ctx.restore();
    } else {
      drawBlurred(bloom.ctx, tint.canvas, p.size);
    }
    out.ctx.save();
    out.ctx.globalAlpha = alpha;
    for (let i = 0; i < layers; i++) out.ctx.drawImage(bloom.canvas, 0, 0);
    out.ctx.restore();
    bloom.busy = false;
    out.ctx.drawImage(src, 0, 0);
  }
  tint.busy = false;
  return out.canvas;
}

// ── Stroke & long shadow (silhouette passes) ─────────────────────────────────
//
// Both were per-GLYPH text effects until v54, drawn with `strokeText` inside
// the type renderer — which is why they existed only on text. As passes over
// the layer's alpha they are the same picture for text (the glyphs ARE the
// silhouette) and now work on a shape, a path or a cut-out image too.

/** How many offset copies approximate a disc of this radius. */
function ringSteps(radius: number): number {
  return Math.max(8, Math.min(64, Math.ceil(radius * 4)));
}

/** The silhouette grown by `radius`, as a union of copies around a circle. */
function dilate(src: CanvasImageSource, w: number, h: number, radius: number): Buf {
  const out = acquireTemp(w, h);
  out.ctx.drawImage(src, 0, 0);
  if (radius <= 0.01) return out;
  const steps = ringSteps(radius);
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    out.ctx.drawImage(src, Math.cos(a) * radius, Math.sin(a) * radius);
  }
  return out;
}

/**
 * The silhouette shrunk by `radius`. Canvas has no erode, but it has the same
 * identity the inner-shadow pass leans on: eroding a shape is dilating its
 * INVERSE and cutting that back out of the original.
 */
function erode(src: CanvasImageSource, w: number, h: number, radius: number): Buf {
  const out = acquireTemp(w, h);
  out.ctx.drawImage(src, 0, 0);
  if (radius <= 0.01) return out;
  const inv = acquireTemp(w, h);
  inv.ctx.fillStyle = "#000";
  inv.ctx.fillRect(0, 0, w, h);
  inv.ctx.globalCompositeOperation = "destination-out";
  inv.ctx.drawImage(src, 0, 0);
  inv.ctx.globalCompositeOperation = "source-over";
  const grown = dilate(inv.canvas, w, h, radius);
  out.ctx.globalCompositeOperation = "destination-out";
  out.ctx.drawImage(grown.canvas, 0, 0);
  out.ctx.globalCompositeOperation = "source-over";
  inv.busy = false;
  grown.busy = false;
  return out;
}

function strokePass(src: CanvasImageSource, w: number, h: number, p: Extract<import("./types").LfxPass, { kind: "stroke" }>): CanvasImageSource {
  const out = nextOutput(w, h);
  if (p.width <= 0.05) {
    out.ctx.drawImage(src, 0, 0);
    return out.canvas;
  }
  // `position` is just how the band straddles the edge — one expression, three
  // looks, rather than three code paths.
  const outer = p.placement === "outside" ? p.width : p.placement === "center" ? p.width / 2 : 0;
  const inner = p.placement === "inside" ? p.width : p.placement === "center" ? p.width / 2 : 0;

  const band = outer > 0 ? dilate(src, w, h, outer) : acquireTemp(w, h);
  if (outer <= 0) band.ctx.drawImage(src, 0, 0);
  const core = inner > 0 ? erode(src, w, h, inner) : null;
  band.ctx.globalCompositeOperation = "destination-out";
  band.ctx.drawImage(core ? core.canvas : src, 0, 0);
  band.ctx.globalCompositeOperation = "source-in";
  band.ctx.fillStyle = p.color;
  band.ctx.fillRect(0, 0, w, h);
  band.ctx.globalCompositeOperation = "source-over";
  core && (core.busy = false);

  out.ctx.drawImage(src, 0, 0);
  // A stroke paints OVER the layer (Figma's rule), so a soft one reads as a
  // halo hugging the edge rather than a second silhouette behind it.
  const blur = p.softness * p.width * 0.5;
  drawFiltered(out.ctx, band.canvas, blur > 0.1 ? [{ kind: "blur", px: blur }] : []);
  band.busy = false;
  return out.canvas;
}

function longShadowPass(src: CanvasImageSource, w: number, h: number, p: Extract<import("./types").LfxPass, { kind: "longShadow" }>): CanvasImageSource {
  const out = nextOutput(w, h);
  if (p.length < 0.5) {
    out.ctx.drawImage(src, 0, 0);
    return out.canvas;
  }
  const rad = (p.angle * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  // One step per pixel keeps the trail solid; past the cap the copies still
  // overlap by far more than any feature, so the slab stays gapless.
  const steps = Math.max(1, Math.min(256, Math.round(p.length)));

  const tint = acquireTemp(w, h);
  tint.ctx.drawImage(src, 0, 0);
  tint.ctx.globalCompositeOperation = "source-in";
  tint.ctx.fillStyle = p.color;
  tint.ctx.fillRect(0, 0, w, h);
  tint.ctx.globalCompositeOperation = "source-over";
  // Past 256 steps the copies would sit more than a pixel apart; smear each
  // one back across its own gap so the slab stays solid at any length.
  const gap = p.length / steps;
  const slab = gap > 1 ? smear(tint.canvas, w, h, shiftFamily(ux * gap, uy * gap), gap, -1) : null;
  const unit = slab ?? tint;

  // Far end first, so the near end lands on top and the fade reads as distance.
  const trail = acquireTemp(w, h);
  for (let i = steps; i >= 1; i--) {
    const t = i / steps;
    trail.ctx.globalAlpha = Math.max(0, 1 - t * p.fade);
    trail.ctx.drawImage(unit.canvas, ux * p.length * t, uy * p.length * t);
  }
  releaseTemp(slab);
  trail.ctx.globalAlpha = 1;

  out.ctx.drawImage(trail.canvas, 0, 0);
  out.ctx.drawImage(src, 0, 0);
  tint.busy = false;
  trail.busy = false;
  return out.canvas;
}

// ── RGB split (chromatic aberration) ─────────────────────────────────────────
// Isolate each channel (multiply the silhouette by a pure primary), then
// recombine additively at opposing offsets so R/B fringe apart, G stays fixed.
function rgbSplitPass(src: CanvasImageSource, w: number, h: number, p: Extract<import("./types").LfxPass, { kind: "rgbSplit" }>): CanvasImageSource {
  const out = nextOutput(w, h);
  if (p.distance < 0.25) {
    out.ctx.drawImage(src, 0, 0);
    return out.canvas;
  }
  const rad = (p.angle * Math.PI) / 180;
  const dx = Math.cos(rad) * p.distance;
  const dy = Math.sin(rad) * p.distance;
  const channels = ["#ff0000", "#00ff00", "#0000ff"].map((mask) => {
    const t = acquireTemp(w, h);
    t.ctx.drawImage(src, 0, 0);
    // Zero the other two channels (multiply by a pure primary)…
    t.ctx.globalCompositeOperation = "multiply";
    t.ctx.fillStyle = mask;
    t.ctx.fillRect(0, 0, w, h);
    // …then restore the layer's own alpha (multiply flooded it to opaque).
    t.ctx.globalCompositeOperation = "destination-in";
    t.ctx.drawImage(src, 0, 0);
    t.ctx.globalCompositeOperation = "source-over";
    return t;
  });
  // The shifted channels are moved with their EDGES REPEATED (`shiftClamped`).
  // Moved plainly, a strip `distance` px wide on each side had one channel
  // missing — on a whole frame (a Riso look on the camera, an adjustment
  // layer) that is a thin coloured line down the frame's edge. Repeating the
  // edge is also right for a sprite: its edge pixels are clear, so the strip is.
  const red = shiftClamped(channels[0]!.canvas, w, h, -dx, -dy);
  const blue = shiftClamped(channels[2]!.canvas, w, h, dx, dy);
  out.ctx.globalCompositeOperation = "lighter";
  out.ctx.drawImage(red.canvas, 0, 0); // R
  out.ctx.drawImage(channels[1]!.canvas, 0, 0); // G
  out.ctx.drawImage(blue.canvas, 0, 0); // B
  out.ctx.globalCompositeOperation = "source-over";
  for (const c of [...channels, red, blue]) c.busy = false;
  return out.canvas;
}


// ── Spin blur ────────────────────────────────────────────────────────────────
// Zoom blur's sibling: the same accumulation, rotated about the centre instead
// of scaled about it. Sharing `zoomBlurPass`'s shape rather than its code
// because the transform differs and a `mode` flag through one function would
// be two effects wearing one coat.
function spinBlurPass(src: CanvasImageSource, w: number, h: number, p: Extract<import("./types").LfxPass, { kind: "spinBlur" }>): CanvasImageSource {
  const out = nextOutput(w, h);
  const arc = (Math.max(0, p.angle) * Math.PI) / 180;
  if (arc <= 0.0001) {
    out.ctx.drawImage(src, 0, 0);
    return out.canvas;
  }
  const cx = w / 2 + (p.cx * w) / 2;
  const cy = h / 2 + (p.cy * h) / 2;
  // Continuous at the RIM, where the arc is longest: the samples are a pixel
  // apart there however big the layer (`smear`). It used to cap at 48 copies,
  // so a large layer spun into discrete ghosts — what a spin blur must never be.
  const sm = smear(src, w, h, rotateFamily(cx, cy, arc), arc * farthestCorner(cx, cy, w, h), -0.5);
  out.ctx.drawImage(sm.canvas, 0, 0);
  releaseTemp(sm);
  return out.canvas;
}

// ── The family's exports ─────────────────────────────────────────────────────
// One named export per pass kind, in the registry's argument order. The thin
// wrapper is deliberate: the implementations above read `(src, w, h, params)`
// like every other canvas routine in the app, while the registry needs the pass
// first so it can dispatch generically. Adapting here costs one line each and
// keeps both halves reading naturally.
export const vignette: PassFn<"vignette"> = (p, src, w, h) => vignettePass(src, w, h, p);
export const sharpen: PassFn<"sharpen"> = (p, src, w, h) => sharpenPass(src, w, h, p);
export const directionalBlur: PassFn<"directionalBlur"> = (p, src, w, h) => directionalBlurPass(src, w, h, p);
export const zoomBlur: PassFn<"zoomBlur"> = (p, src, w, h) => zoomBlurPass(src, w, h, p);
export const spinBlur: PassFn<"spinBlur"> = (p, src, w, h) => spinBlurPass(src, w, h, p);
export const innerShadow: PassFn<"innerShadow"> = (p, src, w, h) => innerShadowPass(src, w, h, p);
export const glow: PassFn<"glow"> = (p, src, w, h) => glowPass(src, w, h, p);
export const stroke: PassFn<"stroke"> = (p, src, w, h) => strokePass(src, w, h, p);
export const longShadow: PassFn<"longShadow"> = (p, src, w, h) => longShadowPass(src, w, h, p);
export const rgbSplit: PassFn<"rgbSplit"> = (p, src, w, h) => rgbSplitPass(src, w, h, p);

/** Shared by families that need to darken/lighten a Buf's alpha edge. */
export { dilate, erode };
