import { LIGHTNING_WANDER_PX } from "./lightning";
import { resolveTextEffect, textEffectReachPx } from "./text-effects";
import { ENABLED_FIELD, activeAt } from "./activeness";
import { layerEffectPath } from "./layer-effects";
import type { Quad } from "./motion";
import type { ShutterPlan } from "./shutter";
import type { KeyframeValue } from "../schema/animation";
import type { LayerEffect } from "../schema/layer-effects";
import type { Vec2 } from "../schema/common";
import type { StrokeStyle } from "../schema/vector";
import type { TextEffect } from "../schema/text-style";

/**
 * HOW MUCH ROOM DOES A LAYER'S PIXELS NEED?
 *
 * One question, one answer. Every surface that rasterises a layer into a buffer
 * of its own — the isolation buffer, the motion-blur accumulation region, and
 * anything that comes after them — has to size that buffer, and a buffer one
 * pixel too small is not a soft failure: it is a hard straight cut through the
 * artwork, with corners, exactly where nothing in the document says there is an
 * edge. That is the defect class this file exists to end.
 *
 * It had been answered twice, in two different ways, both partial:
 *
 *   the isolation buffer   silhouette + effect bleed
 *   the shutter region     silhouette + effect bleed + |mean corner translation|
 *
 * The second one is the interesting failure. `mean corner translation` is the
 * displacement of the layer's CENTRE, and the centre is precisely the point
 * that does not move under the two transforms people animate most:
 *
 *   a spin about the pivot   four corners sweep out, four deltas cancel → 0
 *   a scale about the pivot  four corners fly apart, four deltas cancel → 0
 *
 * So a rotating rectangle and a scaling one were each integrated inside a
 * region measured for a layer standing perfectly still, and every sample that
 * reached past the frame-time silhouette was sliced off at the buffer wall.
 * Translation was the one motion where the mean happens to equal the excursion,
 * which is why panning never showed it and why "it crops past a certain size"
 * looked like a mysterious ceiling rather than a missing term.
 *
 * The fix is not a bigger fudge factor. A scalar pad added in all four
 * directions can only ever be wrong in three of them, and a spin's excursion is
 * not a scalar at all. So the region is the UNION OF THE QUADS THE RENDERER IS
 * ACTUALLY ABOUT TO DRAW — sampled from the same plan, through the same
 * displacement model the painter uses — outset by the distance the effect stack
 * paints past a silhouette. Exact by construction, for translation, rotation,
 * scale, skew, a pivoted swing, an in/out pose and a transition alike, and it
 * stays exact for motions nobody has built yet.
 *
 * Headless on purpose: it is geometry over quads and a read of the effect
 * stack's own numbers. No canvas, no DOM, no matrices the caller has to own —
 * so the stage, the exporter and a test all size their buffers identically.
 */

/** An axis-aligned box in FRAME space. */
export interface RegionBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A buffer's placement in FRAME space, top-left origin. */
export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The axis-aligned box containing every corner of every quad. */
export function quadBounds(quads: readonly Quad[]): RegionBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const q of quads) {
    for (const p of q) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** Longest side — what the few size-relative effects (zoom blur) reach across. */
export function boundsSpan(b: RegionBounds): number {
  return Math.max(b.maxX - b.minX, b.maxY - b.minY);
}

/**
 * Grow a box by `pad` on every side and return the rect a caller hands to
 * `drawImage` — one formula, so a rounded-up buffer and the rect it is drawn
 * into can never disagree about where the layer's pixels start.
 *
 * `origin` is the offset from the box's coordinate space to the frame's
 * top-left, and it is a parameter because the renderer genuinely has two
 * conventions: a clip's own bounds are measured about the frame's CENTRE, while
 * a placement matrix already maps into frame-top-left space. Naming it at the
 * call site is what stops half a frame's worth of offset from being silently
 * added to one of them.
 */
export function regionRect(bounds: RegionBounds, pad: number, origin: Vec2 = { x: 0, y: 0 }): RegionRect {
  return {
    x: origin.x + bounds.minX - pad,
    y: origin.y + bounds.minY - pad,
    width: Math.max(1, bounds.maxX - bounds.minX + pad * 2),
    height: Math.max(1, bounds.maxY - bounds.minY + pad * 2),
  };
}

/** The centre-origin convention a clip's own bounds are measured in. */
export function frameCentre(frame: { width: number; height: number }): Vec2 {
  return { x: frame.width / 2, y: frame.height / 2 };
}

/**
 * The frame-space displacement the `velocity` tier applies to its banked render
 * at one sample.
 *
 * Signed about the FRAME time rather than the shutter's open, so the streak
 * straddles the layer as the shutter phase says it should. It lives here, not
 * in the painter, because the region and the painter have to agree exactly: the
 * moment they compute this differently, the region is measured for a smear that
 * is not the smear that gets drawn, and the difference is a clipped edge.
 */
export function velocityOffsetAt(plan: ShutterPlan, sampleMs: number, localMs: number): Vec2 {
  const span = plan.closeMs - plan.openMs;
  const u = span === 0 ? 0 : (sampleMs - localMs) / span;
  return { x: plan.motion.dx * u, y: plan.motion.dy * u };
}

/**
 * Every quad the shutter will paint, including the crisp frame-time one.
 *
 * The tiers differ only in where a sample's placement comes from — a
 * translation of the banked render, or the layer's real pose re-evaluated — and
 * that is the same split `paintShutter` makes. Asking for the quads through one
 * function is what keeps the region honest about which tier is running: a
 * `velocity` smear that only ever translates must not reserve room for a
 * rotation it will not draw, and a `transform` one must reserve room for every
 * degree it will.
 *
 * `baseQuad` is always included: at `strength < 1` the crisp layer is
 * composited underneath the accumulation, so it is part of what the region has
 * to hold even when no sample lands on it.
 */
export function shutterQuads(
  plan: ShutterPlan,
  localMs: number,
  baseQuad: Quad,
  quadAt: (atMs: number) => Quad,
): Quad[] {
  const sampled: Quad[] = [];
  for (const s of plan.samples) {
    if (plan.tier === "velocity") {
      const d = velocityOffsetAt(plan, s.timeMs, localMs);
      sampled.push(baseQuad.map((p) => ({ x: p.x + d.x, y: p.y + d.y })) as Quad);
    } else {
      sampled.push(quadAt(s.timeMs));
    }
  }
  // Each bin is integrated whole (`shutterSubsteps`), which carries the first
  // and last samples on along their neighbours to the shutter's open and close
  // (half a bin, for a plan sampled at its bins' centres).
  const ends: Quad[] = [];
  const s = plan.samples;
  if (sampled.length >= 2) {
    const along = (a: Quad, b: Quad, k: number) => a.map((p, i) => ({ x: p.x + (p.x - b[i]!.x) * k, y: p.y + (p.y - b[i]!.y) * k })) as Quad;
    const gap = (i: number, j: number) => Math.abs(s[j]!.timeMs - s[i]!.timeMs) || 1;
    const n = s.length;
    ends.push(
      along(sampled[0]!, sampled[1]!, Math.max(0, s[0]!.timeMs - plan.openMs) / gap(0, 1)),
      along(sampled[n - 1]!, sampled[n - 2]!, Math.max(0, plan.closeMs - s[n - 1]!.timeMs) / gap(n - 2, n - 1)),
    );
  }
  return [baseQuad, ...sampled, ...ends];
}

/** A 2D affine in DOMMatrix order `[a, b, c, d, e, f]`: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine2d = readonly [number, number, number, number, number, number];

/** Biggest side, in buffer px, any one layer buffer may have (isolation buffer and shutter region alike). */
export const MAX_LAYER_BUFFER_PX = 4096;

/**
 * THE PART OF A SHUTTER REGION THAT CAN BE SEEN.
 *
 * The shutter integrates a layer in a buffer of its own, sized to everything
 * the layer could paint across the open shutter (`shutterQuads`) and
 * rasterised at the device's scale — capped at `MAX_LAYER_BUFFER_PX` a side.
 * A camera group magnified ×4 is a layer twelve thousand pixels tall, so the
 * cap won and the whole thing was integrated at a third of the output's
 * resolution and drawn back up: every zoom with motion blur on went blocky,
 * then snapped sharp the instant it came to rest (a still layer takes no
 * shutter). The isolation buffer had already learned this ("seen, not whole");
 * the shutter had not.
 *
 * Only the pixels that can LAND on the target matter. `seen` is the target's
 * extent in frame space, grown by the effect pad. A sample displaces the
 * banked picture by D, so the output point p reads banked pixel D⁻¹·p: the
 * region has to hold `seen` (where the sum is read) and every `pullbacks[i]`
 * (= D⁻¹) image of it (where the samples are read from). Anything else in the
 * layer can never reach the frame, at any sample, so cutting it costs nothing
 * and buys back the resolution.
 *
 * Returns `null` when the cut would not be smaller than `whole` — then the
 * caller keeps the whole layer, which is also what keeps every layer under the
 * cap byte-for-byte what it was.
 */
export function shutterSeenRect(whole: RegionRect, seen: RegionRect, pullbacks: readonly Affine2d[]): RegionRect | null {
  let x0 = seen.x;
  let y0 = seen.y;
  let x1 = seen.x + seen.width;
  let y1 = seen.y + seen.height;
  const corners = [
    [seen.x, seen.y],
    [seen.x + seen.width, seen.y],
    [seen.x, seen.y + seen.height],
    [seen.x + seen.width, seen.y + seen.height],
  ] as const;
  for (const [a, b, c, d, e, f] of pullbacks) {
    for (const [px, py] of corners) {
      const x = a * px + c * py + e;
      const y = b * px + d * py + f;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  const x = Math.max(whole.x, x0);
  const y = Math.max(whole.y, y0);
  const r = Math.min(whole.x + whole.width, x1);
  const btm = Math.min(whole.y + whole.height, y1);
  if (!(r > x && btm > y)) return { x: whole.x, y: whole.y, width: 1e-6, height: 1e-6 };
  if (r - x >= whole.width && btm - y >= whole.height) return null;
  return { x, y, width: r - x, height: btm - y };
}

/**
 * Biggest side of a layer's DRAFT — the whole layer at whatever resolution
 * fits, made only when a moving camera needs a layer that has no picture to
 * show at all (`seenWindow`). A quarter of the pixels of a full buffer: it is
 * on screen for the length of a gesture.
 */
export const DRAFT_LAYER_BUFFER_PX = 2048;

/**
 * THE WINDOW OF A LAYER TOO BIG FOR ONE BUFFER — a tile, not a viewport.
 *
 * A layer magnified past `MAX_LAYER_BUFFER_PX` cannot be held whole at the
 * resolution it is seen at, so only the part that can land on the target is
 * rasterised (`need`: the target's extent in frame space, grown by the effect
 * pad). Cut to exactly that, the buffer is a picture of ONE camera position:
 * the smallest pan moves the window, the cache key with it, and every such
 * layer re-renders — effect stack and all — on every frame of a pan and again
 * when it stops. That is why moving around got heavier the further you zoomed
 * in, with nothing in the document changing.
 *
 * So the window is grown by `grow` (frame px) and SNAPPED to a grid of the
 * same pitch: it holds at least `grow` beyond what is needed on every side,
 * at most twice that, and it is the SAME window for every camera position
 * inside its cell. A pan within the margin is a cache hit; only crossing a
 * cell makes a new one. `grow` 0 is the exact cut — for a run of frames, where
 * the layer changes every frame anyway and margin is pure cost.
 *
 * Returns `null` when the window would not be smaller than `whole`.
 */
export function seenWindow(need: RegionRect, whole: RegionRect, grow: number): RegionRect | null {
  let x0 = need.x;
  let y0 = need.y;
  let x1 = need.x + need.width;
  let y1 = need.y + need.height;
  if (grow > 0 && Number.isFinite(grow)) {
    x0 = Math.floor((x0 - grow) / grow) * grow;
    y0 = Math.floor((y0 - grow) / grow) * grow;
    x1 = Math.ceil((x1 + grow) / grow) * grow;
    y1 = Math.ceil((y1 + grow) / grow) * grow;
  }
  const x = Math.max(whole.x, x0);
  const y = Math.max(whole.y, y0);
  const r = Math.min(whole.x + whole.width, x1);
  const b = Math.min(whole.y + whole.height, y1);
  if (!(r > x && b > y)) return { x: whole.x, y: whole.y, width: 1e-6, height: 1e-6 };
  if (r - x >= whole.width && b - y >= whole.height) return null;
  return { x, y, width: r - x, height: b - y };
}

/** Does `outer` hold all of `inner`? With a tolerance: both come out of float matrix maths. */
export function regionCovers(outer: RegionRect, inner: RegionRect, eps = 1e-3): boolean {
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.width <= outer.x + outer.width + eps &&
    inner.y + inner.height <= outer.y + outer.height + eps
  );
}

/** What a layer's outset needs to know about it — a clip, structurally. */
export interface OutsetInput {
  effects?: readonly LayerEffect[];
  strokes?: readonly StrokeStyle[];
  /**
   * The PER-GLYPH text passes, as the resolved stacks that could land on a
   * glyph of this layer: the clip's own, plus one per style range.
   *
   * A list of stacks and not one stack, because a range can carry a glow the
   * base style does not — and the region has to hold the biggest halo any
   * glyph will actually cast, not the one the layer's default style describes.
   */
  textEffects?: readonly (readonly TextEffect[] | undefined)[];
}

/**
 * Outward px the per-glyph passes reach past a glyph's outline.
 *
 * These live on the resolved TEXT STYLE rather than on the layer stack, so they
 * were invisible to an outset that only walked `clip.effects` — and a text
 * layer with a glow, isolated for a blend mode or an in/out animation, had that
 * glow squared off at the buffer wall. Same defect as the layer stack's, one
 * grain down.
 *
 * Each pass's reach is the registry's answer (`textEffectReachPx`), so the
 * region and the renderer agree about a shadow's tail by construction.
 */
export function textEffectOutsetPx(
  stacks: readonly (readonly TextEffect[] | undefined)[] | undefined,
  sampled: Record<string, KeyframeValue>,
): number {
  if (!stacks || stacks.length === 0) return 0;
  let worst = 0;
  for (const stack of stacks) {
    let outset = 0;
    for (const fx of activeAt(stack, (id) => `tfx.${id}.${ENABLED_FIELD}`, sampled)) {
      // Resolved through the registry, so a keyframed radius reserves the
      // radius that will be drawn; the glyph colour is irrelevant to reach.
      const now = resolveTextEffect(fx, sampled, { glyphColor: "#000000" });
      if (now.opacity <= 0.001) continue;
      outset += textEffectReachPx(now);
    }
    worst = Math.max(worst, outset);
  }
  return worst;
}

/**
 * Outward px a layer's effect stack (and thick strokes) push its painted pixels
 * PAST its geometric silhouette — drop shadows, blurs, glows, rgb-split and
 * long shadows all bleed outside the bounds. A region has to grow by this much
 * or those pixels are clipped at the buffer edge, so every kind that paints
 * outward has to be listed here: a kind missing from this list is a visibly
 * cropped effect, not a latent bug.
 *
 * Keyframe-sampled, so an animated radius reserves room for its CURRENT value
 * rather than its authored one. Frame px.
 *
 * `spanPx` is the object's longest side — the few kinds whose reach is relative
 * to what they are applied to (zoom blur) need it.
 */
export function layerEffectOutsetPx(
  clip: OutsetInput,
  sampled: Record<string, KeyframeValue>,
  spanPx: number,
): number {
  let outset = 0;
  // A canvas Gaussian of radius r has σ = r, so it is not visually dead until
  // about 3r. Every blur-shaped reach below is that multiple — the old 1.5×
  // was half a glow short, which nobody could see while the buffer was the
  // whole canvas and which cut a hard corner off every glow the moment it
  // became the layer's own region.
  const BLUR_REACH = 3;
  const num = (k: string, base: number) => (typeof sampled[k] === "number" ? (sampled[k] as number) : base);
  for (const fx of activeAt(clip.effects, (id) => layerEffectPath(id, ENABLED_FIELD), sampled)) {
    const f = (field: string, base: number) => num(`lfx.${fx.id}.${field}`, base);
    if (fx.type === "shadow") outset += Math.hypot(f("x", fx.x), f("y", fx.y)) + f("blur", fx.blur) * BLUR_REACH;
    else if (fx.type === "blur") outset += f("radius", fx.radius) * BLUR_REACH;
    else if (fx.type === "glow" && !fx.inner) outset += f("size", fx.size) * BLUR_REACH;
    else if (fx.type === "rgbSplit") outset += f("distance", fx.distance);
    else if (fx.type === "directionalBlur") outset += f("distance", fx.distance);
    else if (fx.type === "longShadow") outset += f("length", fx.length);
    else if (fx.type === "stroke") {
      const w = Math.max(0, f("width", fx.width));
      const band = fx.placement === "outside" ? w : fx.placement === "center" ? w / 2 : 0;
      outset += band + f("softness", fx.softness) * w * 0.5 * BLUR_REACH;
    } else if (fx.type === "glass") {
      // Glass stays inside the silhouette unless it was GROWN (negative inset).
      // It also REFRACTS: a bezel sample reaches up to a depth inward — and
      // outward for a concave dish — and past the buffer edge that sample
      // clamps into a smear.
      outset += Math.max(0, -f("inset", fx.inset)) + Math.max(0, f("depth", fx.depth));
    } else if (fx.type === "zoomBlur") {
      // The pass scales the image up to 1 + 0.3·strength about its centre, so
      // the reach is a fraction of the object itself.
      outset += (spanPx / 2) * 0.3 * Math.max(0, f("strength", fx.strength));
    } else if (fx.type === "spinBlur") {
      // An arc of θ about the centre sweeps a corner pixel through a chord of
      // r·2·sin(θ/2); half the span stands in for r.
      const theta = (Math.max(0, f("angle", fx.angle)) * Math.PI) / 180;
      outset += spanPx * Math.sin(theta / 2);
    } else if (fx.type === "lightRays") {
      outset += (spanPx / 2) * Math.max(0, f("length", fx.length));
    } else if (fx.type === "lensFlare") {
      // The flare's own centre may sit outside the layer, and its ghosts march
      // past that again — so the reach is the offset plus the flare size.
      const cx = Math.abs(f("centerX", fx.centerX));
      const cy = Math.abs(f("centerY", fx.centerY));
      outset += Math.max(0, f("size", fx.size)) + (spanPx / 2) * Math.max(0, Math.max(cx, cy) - 1);
    } else if (fx.type === "lightning" && !fx.inside && fx.mode !== "fill") {
      // A free bolt reaches wherever its endpoints were placed; an outline arc
      // wanders off the silhouette by its chaos (`LIGHTNING_WANDER_PX`).
      const reach =
        fx.mode === "outline"
          ? 1
          : Math.max(Math.abs(f("ax", fx.ax)), Math.abs(f("ay", fx.ay)), Math.abs(f("bx", fx.bx)), Math.abs(f("by", fx.by)));
      outset +=
        Math.max(0, f("glow", fx.glow)) * BLUR_REACH +
        (spanPx / 2) * Math.max(0, reach - 1) +
        Math.max(0, f("chaos", fx.chaos)) * LIGHTNING_WANDER_PX +
        Math.max(0, f("width", fx.width)) * 4.5;
    } else if (fx.type === "wave") {
      // Both folds displace, and they add at a crest.
      outset += Math.max(0, f("amplitude", fx.amplitude)) * (1 + Math.max(0, f("cross", fx.cross)));
    } else if (fx.type === "bulge") {
      // Magnification pulls content outward past the silhouette it came from.
      outset += (spanPx / 2) * Math.max(0, f("radius", fx.radius)) * Math.max(0, f("strength", fx.strength));
    } else if (fx.type === "lensDistort") {
      outset += (spanPx / 2) * Math.max(0, f("amount", fx.amount)) * 0.5;
    } else if (fx.type === "goo") {
      // The FIELD is a blur, and it has to be built before it can be
      // re-thresholded — so the buffer holds the blur's full reach even though
      // the threshold crops most of it straight back off. Cropping the field at
      // the buffer wall would make the silhouette stop melting near the edge.
      outset += Math.max(0, f("blur", fx.blur)) * BLUR_REACH;
    } else if (fx.type === "roughenEdges") {
      outset += Math.max(0, f("amount", fx.amount));
    } else if (fx.type === "boil") {
      // Lines stray by `amount` and the whole drawing jumps by `shake`; a
      // twist swings the far corners, which the span bounds.
      outset += Math.max(0, f("amount", fx.amount)) * 1.5 + Math.max(0, f("shake", fx.shake)) + (spanPx / 2) * Math.sin((Math.min(30, Math.max(0, f("rotate", fx.rotate))) * Math.PI) / 180);
    } else if (fx.type === "glitch" && !fx.inside) {
      outset += Math.max(0, f("displace", fx.displace)) + Math.max(0, f("chroma", fx.chroma));
    } else if (fx.type === "halftone" && !fx.inside) {
      // Scattered ink leaves the silhouette — which is the whole point of
      // animating `spread`, and would be a hard crop without this line.
      outset += Math.max(0, f("spread", fx.spread)) + Math.max(0, f("jitter", fx.jitter)) + Math.max(0, f("size", fx.size));
    } else if (fx.type === "bevel") {
      if (fx.style === "outer" || fx.style === "pillow") outset += Math.max(0, f("depth", fx.depth));
    } else if (fx.type === "lens") {
      // The bend reaches `reach` Einstein radii from the centre — past it the
      // backdrop is untouched — so the buffer has to hold that disc.
      outset += Math.max(0, f("radius", fx.radius)) * Math.max(1, f("reach", fx.reach)) + Math.max(0, f("shadow", fx.shadow)) * 1.6;
    } else if (fx.type === "shockwave") {
      // The ring and its tails reach past the front by two widths and its push.
      outset += Math.max(0, f("radius", fx.radius)) + 2.5 * Math.max(0, f("width", fx.width)) + Math.abs(f("strength", fx.strength));
    } else if (fx.type === "star") {
      // The corona reaches past the disc, × its radius (half the layer's span).
      outset += (spanPx / 2) * Math.max(0, f("coronaSize", fx.coronaSize)) * 1.15;
    } else if (fx.type === "surface") {
      // A lifted cut-out casts its shadow one lift away, softened by about as
      // much again; felt fibres reach past the edge by the edge's reach.
      outset += Math.max(0, f("lift", fx.lift)) * 2.5 + Math.max(0, f("edge", fx.edge)) * 10 * Math.max(0.25, f("scale", fx.scale));
    } else if (fx.type === "shine" && !fx.inside) {
      outset += Math.max(0, f("bloom", fx.bloom)) * BLUR_REACH;
    }
    // innerShadow, inner glow, adjust, colorGrade, gradientMap, posterize,
    // overlay, vignette, sharpen, chromaKey, twirl, pixelate and the analog
    // family stay inside the silhouette.
  }
  // A thick stroke paints half its width outside the path's geometric bounds
  // (center align) or all of it (outside align); inside strokes stay within.
  let strokeHalf = 0;
  for (const s of clip.strokes ?? []) {
    if (s.opacity <= 0 || s.width <= 0 || s.align === "inside") continue;
    strokeHalf = Math.max(strokeHalf, s.align === "outside" ? s.width : s.width / 2);
  }
  return outset + strokeHalf + textEffectOutsetPx(clip.textEffects, sampled);
}

/**
 * The pad every region shares: soft edges, effect bleed, and a pixel of slack
 * so a rounded-up buffer never lands exactly on the silhouette.
 *
 * One formula, so an isolation buffer and a shutter region can never reserve
 * different amounts of room for the same layer.
 */
export function layerRegionPad(
  clip: OutsetInput,
  sampled: Record<string, KeyframeValue>,
  featherPx: number,
  spanPx: number,
): number {
  return Math.max(0, featherPx) * 2 + layerEffectOutsetPx(clip, sampled, spanPx) + 4;
}
