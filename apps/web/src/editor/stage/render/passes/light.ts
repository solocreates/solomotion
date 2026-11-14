"use client";

import { lightningStrandsFor, type LightningParams, type LightningStrand } from "@solomotion/core";
import { drawBlurred, drawFiltered, paintFiltered } from "../canvas-filter";
import { acquireTemp, nextOutput, releaseTemp } from "./buffers";
import { traceSilhouette } from "./silhouette";
import { farthestCorner, scaleFamily, smear } from "./smear";
import type { PassFn } from "./types";

/**
 * LIGHT & OPTICS — shine, light rays, lens flare, lightning.
 *
 * Every pass here ADDS light, which in canvas terms means: build the light on
 * its own transparent buffer, then composite that buffer over the layer with
 * the card's blend mode. Painting straight onto the layer's buffer would let
 * the layer's own alpha decide the light's opacity, and the light would go
 * dim exactly where the layer is faint — the opposite of how light works.
 *
 * `inside` is then one line: mask the light buffer with the layer's alpha
 * (`destination-in`) before compositing. One idiom, four cards.
 */

/** Composite a light buffer over the layer with a blend mode and a mask. */
function composite(
  src: CanvasImageSource,
  light: HTMLCanvasElement,
  w: number,
  h: number,
  blend: string,
  inside: boolean,
  behind = false,
): CanvasImageSource {
  if (inside) {
    const ctx = light.getContext("2d")!;
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(src, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }
  const out = nextOutput(w, h);
  if (behind) {
    out.ctx.drawImage(light, 0, 0);
    out.ctx.drawImage(src, 0, 0);
    return out.canvas;
  }
  out.ctx.drawImage(src, 0, 0);
  out.ctx.globalCompositeOperation = blend as GlobalCompositeOperation;
  out.ctx.drawImage(light, 0, 0);
  out.ctx.globalCompositeOperation = "source-over";
  return out.canvas;
}

// ── Shine ────────────────────────────────────────────────────────────────────
function shinePass(p: Extract<import("./types").LfxPass, { kind: "shine" }>, src: CanvasImageSource, w: number, h: number): CanvasImageSource {
  if (p.intensity <= 0.001 || p.width <= 0.01) return src;
  const buf = acquireTemp(w, h);
  const ctx = buf.ctx;
  const rad = (p.angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  // The travel axis has to span the layer's PROJECTION onto it, or a diagonal
  // sweep would start and finish inside the layer instead of clearing it.
  const span = Math.abs(dx) * w + Math.abs(dy) * h;
  const cx = w / 2;
  const cy = h / 2;
  const half = span / 2;
  const bandHalf = Math.max(0.5, p.width / 2);
  // The band travels from fully off one side to fully off the other, so
  // position 0 and 1 both show nothing — which is what makes a loop clean.
  // "Fully off" includes the bloom halo: a blurred band parked at its edge
  // still glows onto the layer, which is how a one-shot sweep left a band
  // lingering after its pass.
  const reach = half + bandHalf + Math.max(0, p.bloom) * 2.5;
  // Position moves the whole TRAIN, not just the lead band: 0 has every band
  // before the layer and 1 has the last one past it. Moving only the lead left
  // the followers parked on the layer at the end of every pass — a stall, then
  // a snap.
  const bands = Math.max(1, Math.round(p.count));
  const train = (bands - 1) * p.gap;

  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < bands; i++) {
    const at = p.position * (1 + train) - i * p.gap;
    const alpha = Math.min(1, p.intensity) * Math.pow(p.falloff, i);
    if (alpha <= 0.002) continue;
    const offset = -reach + at * reach * 2;
    const mx = cx + dx * offset;
    const my = cy + dy * offset;
    const g = ctx.createLinearGradient(mx - dx * bandHalf, my - dy * bandHalf, mx + dx * bandHalf, my + dy * bandHalf);
    // Softness reshapes the ramp rather than blurring it: at 0 the band is a
    // bar with an edge, at 1 a pure falloff with no edge anywhere. Doing it
    // with stops (not a blur) is what keeps a hard chrome edge actually hard.
    const edge = 0.5 * (1 - p.softness);
    g.addColorStop(0, "transparent");
    if (edge > 0.001) g.addColorStop(Math.max(0.001, 0.5 - edge), withAlpha(p.color, alpha));
    g.addColorStop(0.5, withAlpha(p.color, alpha));
    if (edge > 0.001) g.addColorStop(Math.min(0.999, 0.5 + edge), withAlpha(p.color, alpha));
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.globalCompositeOperation = "source-over";

  let light = buf.canvas;
  if (p.bloom > 0.01) {
    const blurred = acquireTemp(w, h);
    drawBlurred(blurred.ctx, buf.canvas, p.bloom);
    // The bloom is ADDED to the crisp band, not swapped for it — a blurred
    // band alone loses the specular core that makes a sweep read as metal.
    blurred.ctx.globalCompositeOperation = "lighter";
    blurred.ctx.globalAlpha = 0.75;
    blurred.ctx.drawImage(buf.canvas, 0, 0);
    blurred.ctx.globalAlpha = 1;
    blurred.ctx.globalCompositeOperation = "source-over";
    light = blurred.canvas;
    releaseTemp(buf);
    const result = composite(src, light, w, h, p.blend, p.inside);
    releaseTemp(blurred);
    return result;
  }
  const result = composite(src, light, w, h, p.blend, p.inside);
  releaseTemp(buf);
  return result;
}

/** `#rrggbb`/`#rrggbbaa` plus a multiplier → an `rgba()` canvas accepts. */
function withAlpha(color: string, alpha: number): string {
  const hex = color.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{3,8}$/.test(hex)) return color;
  const wide = hex.length <= 4 ? hex.split("").map((c) => c + c).join("") : hex;
  const r = parseInt(wide.slice(0, 2), 16);
  const g = parseInt(wide.slice(2, 4), 16);
  const b = parseInt(wide.slice(4, 6), 16);
  const a = wide.length >= 8 ? parseInt(wide.slice(6, 8), 16) / 255 : 1;
  return `rgba(${r},${g},${b},${(a * alpha).toFixed(4)})`;
}

// ── Light rays ───────────────────────────────────────────────────────────────
function lightRaysPass(p: Extract<import("./types").LfxPass, { kind: "lightRays" }>, src: CanvasImageSource, w: number, h: number): CanvasImageSource {
  if (p.intensity <= 0.001 || p.length <= 0.001) return src;
  const cx = w / 2 + (p.cx * w) / 2;
  const cy = h / 2 + (p.cy * h) / 2;

  // THE EMITTER: the layer's bright pixels, thresholded. `brightness/contrast`
  // in one filter string is a threshold done on the GPU — a per-pixel loop here
  // would cost more than the accumulation that follows it.
  const emit = acquireTemp(w, h);
  const lift = Math.max(0.001, 1 - p.threshold);
  drawFiltered(emit.ctx, src, [
    { kind: "brightness", amount: 1 / lift },
    { kind: "contrast", amount: 1 + p.threshold * 4 },
    { kind: "saturate", amount: p.mode === "auto" ? p.saturation : 0 },
  ]);
  if (p.mode === "solid") {
    emit.ctx.globalCompositeOperation = "source-in";
    emit.ctx.fillStyle = p.color;
    emit.ctx.fillRect(0, 0, w, h);
    emit.ctx.globalCompositeOperation = "source-over";
  }

  // THE ACCUMULATION: the emitter drawn repeatedly, scaled about the source.
  // Each step is a little further out and a little dimmer, which is the
  // discrete form of the volumetric integral along a ray.
  //
  // The steps are GEOMETRIC — every one scales the last by the same ratio —
  // so one smear of the emitter across that ratio fills the gap between any
  // two of them exactly (see `smear`). Without it a step is `length / steps`
  // of the distance from the source, which on a big or zoomed buffer is many
  // pixels, and the shafts broke into separate copies: distinct waves of
  // light instead of one falloff, worse the farther the shaft reached.
  const steps = Math.max(4, Math.round(p.samples));
  const ratio = Math.pow(1 + p.length, 1 / steps);
  const reach = farthestCorner(cx, cy, w, h) * (1 + p.length) * (ratio - 1);
  // u0 = −1: each step's smear covers the stretch back to the step before it,
  // so step 1 starts at the emitter itself and the last ends at full length.
  const fill = smear(emit.canvas, w, h, scaleFamily(cx, cy, ratio), reach, -1);
  releaseTemp(emit);
  const rays = acquireTemp(w, h);
  rays.ctx.globalCompositeOperation = "lighter";
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const scale = Math.pow(ratio, i);
    const alpha = (Math.pow(1 - t, p.decay) * p.intensity) / Math.sqrt(steps);
    if (alpha <= 0.001) continue;
    rays.ctx.globalAlpha = Math.min(1, alpha);
    rays.ctx.setTransform(scale, 0, 0, scale, cx * (1 - scale), cy * (1 - scale));
    rays.ctx.drawImage(fill.canvas, 0, 0);
  }
  rays.ctx.setTransform(1, 0, 0, 1, 0, 0);
  rays.ctx.globalAlpha = 1;
  rays.ctx.globalCompositeOperation = "source-over";
  releaseTemp(fill);

  const out = composite(src, rays.canvas, w, h, p.blend, false, p.behind);
  releaseTemp(rays);
  return out;
}

// ── Lens flare ───────────────────────────────────────────────────────────────
function lensFlarePass(p: Extract<import("./types").LfxPass, { kind: "lensFlare" }>, src: CanvasImageSource, w: number, h: number): CanvasImageSource {
  if (p.brightness <= 0.001 || p.size <= 0.01) return src;
  const buf = acquireTemp(w, h);
  const ctx = buf.ctx;
  const cx = w / 2 + (p.cx * w) / 2;
  const cy = h / 2 + (p.cy * h) / 2;
  const size = p.size;
  ctx.globalCompositeOperation = "lighter";

  // The core: a tight hot centre inside a broad halo. Two radial stops rather
  // than one, because a single falloff is either a dot or a smudge.
  radial(ctx, cx, cy, size * 0.16, p.color, p.brightness);
  if (p.halo > 0.001) radial(ctx, cx, cy, size * 0.7, p.color, p.brightness * p.halo * 0.55);

  if (p.streak > 0.001) {
    const a = (p.streakAngle * Math.PI) / 180;
    const len = size * 3.4 * p.streak;
    const thick = Math.max(1, size * 0.035);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    const g = ctx.createLinearGradient(-len, 0, len, 0);
    g.addColorStop(0, "transparent");
    g.addColorStop(0.5, withAlpha(p.streakColor, Math.min(1, p.brightness * 0.85)));
    g.addColorStop(1, "transparent");
    // A tapered rectangle, not an ellipse: an anamorphic streak is a thin bar
    // with soft ends, and an ellipse's vertical falloff makes it a lozenge.
    paintFiltered(ctx, [{ kind: "blur", px: thick * 0.9 }], (c) => {
      c.fillStyle = g;
      c.fillRect(-len, -thick / 2, len * 2, thick);
    }, { x: -len, y: -thick / 2, w: len * 2, h: thick });
    ctx.restore();
  }

  // GHOSTS march back through the optical centre: each is the source reflected
  // about the middle of the frame at a fraction of the distance. That is
  // literally what a lens does, and it is why they swing across frame when the
  // source moves — the thing a hand-placed sprite can never do.
  const mx = w / 2;
  const my = h / 2;
  for (let i = 1; i <= Math.round(p.ghosts); i++) {
    const t = (i / (p.ghosts + 1)) * p.ghostSpread * 2;
    const gx = cx + (mx - cx) * (1 + t);
    const gy = cy + (my - cy) * (1 + t);
    const r = size * (0.05 + 0.13 * ((i % 3) + 1) * 0.6);
    const hue = (i / Math.max(1, p.ghosts)) * 300 * p.ghostChroma;
    const tint = p.ghostChroma > 0.01 ? `hsl(${hue.toFixed(0)} 90% 62%)` : p.color;
    radial(ctx, gx, gy, r, tint, p.brightness * 0.22 * (1 - i / (p.ghosts + 2)));
  }

  ctx.globalCompositeOperation = "source-over";
  const out = composite(src, buf.canvas, w, h, p.blend, p.inside);
  releaseTemp(buf);
  return out;
}

function radial(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number): void {
  if (r <= 0.5 || alpha <= 0.002) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, withAlpha(color, Math.min(1, alpha)));
  g.addColorStop(0.45, withAlpha(color, Math.min(1, alpha) * 0.35));
  g.addColorStop(1, "transparent");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// ── Lightning ────────────────────────────────────────────────────────────────
// The geometry arrived resolved from core; this only strokes it. Three passes
// over the same polylines — wide corona, mid glow, hot core — is what makes an
// arc read as light rather than as a drawn line.
function lightningPass(params: LightningParams, src: CanvasImageSource, w: number, h: number): CanvasImageSource {
  // A layer with no vector geometry had no outline when the stage list was
  // built — it had not been drawn yet. This is the one moment it does exist,
  // so the spec the brain handed over is finished here, by the same pure
  // function a path layer's resolver already ran.
  let strands: LightningStrand[] = params.strands;
  if (params.deferred) {
    const outline = traceSilhouette(src, w, h);
    if (!outline) return src;
    strands = lightningStrandsFor(params.deferred, outline);
  }
  if (strands.length === 0 || params.intensity <= 0.001) return src;
  const buf = acquireTemp(w, h);
  const ctx = buf.ctx;

  const layers: Array<{ widthMul: number; blur: number; color: string; alpha: number }> = [
    { widthMul: 4.5, blur: params.glow, color: params.color, alpha: 0.35 },
    { widthMul: 2, blur: params.glow * 0.35, color: params.color, alpha: 0.55 },
    { widthMul: 1, blur: 0, color: params.coreColor, alpha: 1 },
  ];

  // ONE BLUR PER GLOW LAYER, through the filter seam. It used to set
  // `ctx.filter` and stroke every strand through it — a separate blur per
  // strand per layer, dozens a frame (23ms of a 33ms budget on a small
  // layer), and on WebKit, which ignores `ctx.filter`, no glow at all. Each
  // glow layer's strands are stroked sharp into one buffer and that buffer is
  // blurred once, GPU where the probe says it works and CPU otherwise.
  const stroke = (g: CanvasRenderingContext2D, layer: (typeof layers)[number]) => {
    g.lineCap = "round";
    g.lineJoin = "round";
    g.globalCompositeOperation = "lighter";
    g.strokeStyle = layer.color;
    for (const strand of strands) {
      const pts = strand.points;
      if (pts.length < 2) continue;
      // `growth` draws the arc ON: only the leading fraction of each strand is
      // stroked, so a strike arrives instead of appearing.
      const upto = Math.max(2, Math.ceil(pts.length * params.growth));
      g.globalAlpha = Math.min(1, strand.alpha * layer.alpha * params.intensity);
      g.lineWidth = Math.max(0.3, strand.width * layer.widthMul);
      g.beginPath();
      g.moveTo(pts[0]!.x * w, pts[0]!.y * h);
      for (let i = 1; i < upto; i++) g.lineTo(pts[i]!.x * w, pts[i]!.y * h);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
  };
  for (const layer of layers) {
    if (layer.blur <= 0.4) {
      stroke(ctx, layer);
      continue;
    }
    const glow = acquireTemp(w, h);
    stroke(glow.ctx, layer);
    ctx.globalCompositeOperation = "lighter";
    drawBlurred(ctx, glow.canvas, layer.blur);
    ctx.globalCompositeOperation = "source-over";
    releaseTemp(glow);
  }

  const out = composite(src, buf.canvas, w, h, params.blend, params.inside);
  releaseTemp(buf);
  return out;
}

export const shine: PassFn<"shine"> = (p, src, w, h) => shinePass(p, src, w, h);
export const lightRays: PassFn<"lightRays"> = (p, src, w, h) => lightRaysPass(p, src, w, h);
export const lensFlare: PassFn<"lensFlare"> = (p, src, w, h) => lensFlarePass(p, src, w, h);
export const lightning: PassFn<"lightning"> = (p, src, w, h) => lightningPass(p.params, src, w, h);
