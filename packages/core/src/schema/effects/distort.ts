import { z } from "zod";

import { layerEffectBase, ownMotion, temporalClock } from "./shared";

/**
 * DISTORT (v57) — the cards that move pixels rather than recolour them.
 *
 * Four of the five are one machine: a per-pixel DISPLACEMENT — for each output
 * pixel, ask where in the source it came from, and sample there. Bulge, wave,
 * twirl and lens distortion differ only in that one function, which is why the
 * renderer implements the sampler once and the cards supply the field. Writing
 * four bilinear resamplers would have been four chances to disagree about edge
 * clamping, about whether a field is in frame or device px, and about what
 * happens at the exact centre.
 *
 * Roughen edges and glitch break the pattern honestly: one chews the ALPHA
 * boundary rather than the colour, the other displaces whole blocks on a
 * seeded clock. Neither is a resample.
 */
export const DISTORT_EFFECT_ARMS = [
  /**
   * Bulge — a movable lens over one region of the layer. Positive magnifies,
   * negative pinches, and `softness` is the difference between a hard glass
   * marble and a gentle swell.
   *
   * The centre is in layer space and keyframes like anything else, so the
   * classic move — drag the magnifier across a line of text — is two keys.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("bulge"),
    /** Lens centre as a fraction of half-width/height (−1..1, 0 = middle). */
    centerX: z.number().min(-2).max(2).default(0),
    centerY: z.number().min(-2).max(2).default(0),
    /** Lens radius, as a fraction of the layer's half-span. */
    radius: z.number().min(0.01).max(2).default(0.35),
    /** Positive bulges out, negative pinches in. */
    strength: z.number().min(-1).max(1).default(0.55),
    /** 0 = the lens ends abruptly, 1 = it blends away over its whole radius. */
    softness: z.number().min(0).max(1).default(0.5),
    /** Stretches the lens: >1 is a wide oval, <1 a tall one. */
    aspect: z.number().min(0.1).max(10).default(1),
    /** Refract the rim like real glass instead of a pure magnification. */
    refract: z.number().min(0).max(1).default(0.25),
  }),
  /**
   * Wave warp — a travelling wave folded into the layer.
   *
   * `anchor` is the field that turns a wobble into a FLAG: at 0 the whole layer
   * waves uniformly, at 1 the amplitude ramps from nothing at the leading edge,
   * which is what a pinned banner does. Without it every wave effect looks like
   * jelly and nothing looks like cloth.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("wave"),
    ...ownMotion(true),
    shape: z.enum(["sine", "triangle", "square", "noise"]).default("sine"),
    /** Direction the wave travels, in degrees. */
    angle: z.number().min(-180).max(180).default(0),
    /** Distance between crests, in px. */
    wavelength: z.number().min(2).max(4000).default(200),
    /** How far a crest pushes the pixels, in px. */
    amplitude: z.number().min(0).max(1000).default(26),
    /** Wave phase in degrees — keyframe it to animate by hand. */
    phase: z.number().min(-3600).max(3600).default(0),
    /** Cycles per second added to the phase from the clip's own time. */
    speed: z.number().min(-8).max(8).default(0.5),
    /** A second wave across the first, for a cloth-like double fold. */
    cross: z.number().min(0).max(1).default(0),
    /** 0 = the whole layer waves, 1 = it is pinned at the leading edge. */
    anchor: z.number().min(0).max(1).default(0),
  }),
  /**
   * Twirl — a rotation that falls off with distance, so the middle spins and
   * the edge stays put.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("twirl"),
    centerX: z.number().min(-2).max(2).default(0),
    centerY: z.number().min(-2).max(2).default(0),
    /** How far the spin reaches, as a fraction of the layer's half-span. */
    radius: z.number().min(0.01).max(2).default(0.5),
    /** Rotation at the centre, in degrees. */
    angle: z.number().min(-2000).max(2000).default(180),
    /** 0 = the twirl stops dead at the radius, 1 = it eases out over it. */
    softness: z.number().min(0).max(1).default(0.7),
  }),
  /**
   * Lens distortion — barrel and pincushion, plus the lateral chromatic
   * aberration that comes with them.
   *
   * Distinct from RGB split on purpose: that card offsets the channels by a
   * constant, which is a glitch. This one scales them by different amounts
   * about the optical centre, which is what a real lens does — zero fringe in
   * the middle, growing toward the corners.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("lensDistort"),
    /** Positive barrels outward (fisheye), negative pincushions inward. */
    amount: z.number().min(-1).max(1).default(0.3),
    /** The higher-order term — bends the corners without touching mid-frame. */
    cubic: z.number().min(-1).max(1).default(0),
    /** Channel scale difference about the centre. */
    chroma: z.number().min(0).max(1).default(0.18),
    /** Zoom applied after the distortion, to hide the corners it exposes. */
    scale: z.number().min(0.25).max(4).default(1),
    centerX: z.number().min(-2).max(2).default(0),
    centerY: z.number().min(-2).max(2).default(0),
  }),
  /**
   * Roughen edges — chews the layer's ALPHA boundary with fractal noise. The
   * hand-torn poster, the burnt edge, the chalk letter, the rusted plate.
   *
   * It is not a displacement: the interior is untouched and only the boundary
   * moves, which is what keeps text readable while its edges fall apart. That
   * distinction is the whole reason it is its own card rather than the Noise
   * card's `displace` field turned up.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("roughenEdges"),
    ...temporalClock,
    ...ownMotion(false),
    style: z.enum(["rough", "spiky", "torn", "melt", "rusty"]).default("rough"),
    /** How deep the bite goes, in px. */
    amount: z.number().min(0).max(600).default(20),
    /** Feature size of the chewing, in px. Small is chalk, large is torn card. */
    scale: z.number().min(1).max(1000).default(48),
    /** Octaves of detail — 1 is a smooth wobble, 5 is genuinely ragged. */
    complexity: z.number().int().min(1).max(6).default(3),
    /** 0 = the new edge is as soft as a blur, 1 = a clean cut. */
    sharpness: z.number().min(0).max(1).default(0.65),
    /** How fast the edge crawls through its own noise, per step. */
    evolve: z.number().min(0).max(20).default(0),
    /** RUSTY only — the colour bled into the chewed band. */
    color: z.string().default("#8a5a2a"),
    /** RUSTY only — how strongly that colour stains the edge. */
    tint: z.number().min(0).max(1).default(0.6),
  }),
  /**
   * LINE BOIL — the hand-drawn life every traced drawing has: each frame is
   * redrawn slightly differently, so lines shimmer in place on their own
   * clock. Classic cel animation cycles 2–4 drawings "on twos"; that is the
   * default. It warps the layer's RENDERED pixels, so the same card animates a
   * scanned drawing (with or without its paper), a PNG, text, vector artwork,
   * video — anything, identically.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("boil"),
    ...temporalClock,
    ...ownMotion(true),
    /** boil = fine line shimmer · wobble = soft, jelly-like drift · jitter = crisp, nervous chalk. */
    style: z.enum(["boil", "wobble", "jitter"]).default("boil"),
    /** How far a line strays, in px. 1–3 is a gentle boil; 6+ is a sketch coming apart. */
    amount: z.number().min(0).max(200).default(2.5),
    /** Size of each wiggle, in px — small is a nervous pen, large a slow wave. */
    scale: z.number().min(2).max(800).default(22),
    /** Octaves of detail. 1 is smooth, 4 is scratchy. */
    complexity: z.number().int().min(1).max(4).default(2),
    /** Distinct drawings in the loop (2–4 is classic cel boil). 0 never repeats. */
    variants: z.number().int().min(0).max(24).default(3),
    /** Whole-layer hand-held jump per drawing, in px. */
    shake: z.number().min(0).max(100).default(0),
    /** Whole-layer twist per drawing, in degrees. */
    rotate: z.number().min(0).max(30).default(0),
    mix: z.number().min(0).max(1).default(1),
  }),
  /**
   * GOO — the metaball card. Nearby shapes swell toward each other and
   * fuse where they meet, with a bridge that necks like liquid rather than a
   * seam where two outlines cross.
   *
   * It is the oldest trick in motion graphics and the reason nobody uses it: in
   * After Effects it is Fast Blur followed by Levels with the alpha channel
   * crushed, which is two cards, one of which does nothing alone and neither of
   * which says "goo" anywhere. Here it is one card, because the blur is not an
   * ingredient anyone chooses — it IS the merge distance, and splitting it out
   * only lets the two halves drift apart.
   *
   * ## What it actually does
   *
   * Blur the alpha and you get a DISTANCE FIELD: 1 deep inside, ~0.5 on the
   * old edge, falling to 0 outside. Where two shapes are closer than the blur,
   * their fields ADD, so the gap between them crosses 0.5 even though neither
   * shape covers it. Re-thresholding that field at `threshold` turns the sum
   * back into a hard silhouette — and the gap is inside it. That is the whole
   * of the illusion, and it is why the bridge is a smooth fillet: it is a level
   * set of a sum of Gaussians, which is what a meniscus is.
   *
   * COLOUR IS TAKEN FROM THE ORIGINAL wherever the original is opaque, and only
   * the newly-filled bridge takes the blurred blend. Without that rule the card
   * would be a blur with extra steps — a photo inside the group would come out
   * soft. With it, the artwork stays exactly as sharp as it was and only the
   * space BETWEEN shapes is invented.
   *
   * On a group it is the whole point: put it on the group, not on the members.
   * The members are combined into one picture first, so they melt into each
   * other. Per-member it can only melt a layer into itself.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("goo"),
    /**
     * The merge distance, in px — how far a shape reaches toward its
     * neighbours. This is the blur radius of the field, so two shapes fuse at
     * roughly this far apart.
     */
    blur: z.number().min(0).max(400).default(20),
    /**
     * Where the field becomes solid again. 0.5 keeps every silhouette its
     * original size; below that everything fattens and merges sooner, above it
     * everything erodes and the bridges snap.
     */
    threshold: z.number().min(0.05).max(0.95).default(0.5),
    /** Width of the re-thresholded edge. 0 is a razor; turn it up to stay wet. */
    softness: z.number().min(0).max(0.5).default(0.04),
    /** Master wet/dry. */
    mix: z.number().min(0).max(1).default(1),
  }),
  /**
   * Glitch — the signal failing. Horizontal bands tear sideways, channels
   * separate inside the torn bands only, and blocks occasionally swap places.
   *
   * On the temporal clock like the rest of the analog family, because the thing
   * that makes a glitch read as a glitch is that it HOLDS: a fresh displacement
   * every frame is static, while twelve re-rolls a second is a broken feed.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("glitch"),
    ...temporalClock,
    ...ownMotion(true),
    /** Master wet/dry over the whole card. */
    mix: z.number().min(0).max(1).default(1),
    /** How much of the layer is torn at any moment. */
    amount: z.number().min(0).max(1).default(0.5),
    /** How many bands the layer is cut into. */
    blocks: z.number().int().min(1).max(120).default(14),
    /** How far a torn band slides, in px. */
    displace: z.number().min(0).max(1000).default(48),
    /** Channel separation inside torn bands, in px. */
    chroma: z.number().min(0).max(300).default(10),
    /** Chance a band is replaced by another band's pixels entirely. */
    scramble: z.number().min(0).max(1).default(0.15),
    /** Hue jump inside torn bands — the colour-subcarrier failing. */
    colorShift: z.number().min(0).max(1).default(0.3),
    direction: z.enum(["horizontal", "vertical", "both"]).default("horizontal"),
    /** Keep the tearing inside the layer's silhouette. */
    inside: z.boolean().default(true),
  }),
] as const;
