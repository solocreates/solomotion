import { z } from "zod";

import { blendMode, layerEffectBase } from "./shared";
import { gradeGraphSchema } from "../grade";

/**
 * The colour family: the keyer, the full grading node, and the three cards that
 * remap what a pixel is rather than where it lands — gradient map, posterize
 * and the fill/gradient overlay.
 */
export const COLOR_EFFECT_ARMS = [
  // Chroma key — one instance keys ONE color (multiple colors = multiple
  // cards, each with its own sensitivity). Works on image/video/GIF sources;
  // pixels are keyed at source resolution before the layer paints, so shadows
  // and blurs in the stack follow the keyed silhouette.
  z.object({
    ...layerEffectBase,
    type: z.literal("chromaKey"),
    color: z.string(),
    /** Chroma distance below which a pixel is fully removed (0–100). */
    tolerance: z.number().min(0).max(100).default(28),
    /** Extra ramp past tolerance where removal fades out (0–100). */
    softness: z.number().min(0).max(100).default(14),
    /** Key-color spill suppression on kept pixels (0–100). */
    spill: z.number().min(0).max(100).default(40),
    /** Matte blur in source px — softens the cut edge. */
    feather: z.number().min(0).max(40).default(0),
    /** Matte choke after feather: negative grows the keep, positive shrinks it. */
    choke: z.number().min(-20).max(20).default(0),
    /** Photoshop-style: only remove regions connected to the image border. */
    edgesOnly: z.boolean().default(false),
    /** Keep ONLY the key color instead of removing it. */
    invert: z.boolean().default(false),
  }),
  // Color grade — ONE full grading node per card (DaVinci-style primaries):
  // lift/gamma/gain wheels (per-channel + master), white balance, exposure,
  // contrast, saturation, vibrance, hue, and a master intensity mix. Cards
  // stack like nodes — each grades the pixels the previous one produced.
  z.object({
    ...layerEffectBase,
    type: z.literal("colorGrade"),
    /** Warm↔cool white balance, luma-preserving (−100..100). */
    temperature: z.number().min(-100).max(100).default(0),
    /** Green↔magenta balance, luma-preserving (−100..100). */
    tint: z.number().min(-100).max(100).default(0),
    /** Exposure in stops (×2^v). */
    exposure: z.number().min(-4).max(4).default(0),
    /** Contrast around mid-grey pivot; 1 = neutral. */
    contrast: z.number().min(0).max(2).default(1),
    /** Global saturation; 1 = neutral. */
    saturation: z.number().min(0).max(2).default(1),
    /** Smart saturation — boosts muted colors more than saturated ones. */
    vibrance: z.number().min(-1).max(1).default(0),
    /** Hue rotation in degrees. */
    hueDeg: z.number().min(-180).max(180).default(0),
    /** Master mix — blends the graded result over the original (0..1). */
    intensity: z.number().min(0).max(1).default(1),
    // Lift (shadows offset), Gamma (midtone power), Gain (highlight slope) —
    // per-channel trims from the wheels plus a master per wheel.
    liftR: z.number().min(-1).max(1).default(0),
    liftG: z.number().min(-1).max(1).default(0),
    liftB: z.number().min(-1).max(1).default(0),
    liftM: z.number().min(-1).max(1).default(0),
    gammaR: z.number().min(-1).max(1).default(0),
    gammaG: z.number().min(-1).max(1).default(0),
    gammaB: z.number().min(-1).max(1).default(0),
    gammaM: z.number().min(-1).max(1).default(0),
    gainR: z.number().min(-1).max(1).default(0),
    gainG: z.number().min(-1).max(1).default(0),
    gainB: z.number().min(-1).max(1).default(0),
    gainM: z.number().min(-1).max(1).default(0),
  }),
  /**
   * GRADE — the layer's colour node graph, reached from its own effect stack.
   *
   * This card is the answer to the one ordering question a colour page always
   * raises: does the grade happen before or after the layer's effects? Every
   * fixed answer is wrong half the time — a grain pass wants to be graded, a
   * glow wants to be added to an already-graded plate. So the grade takes a
   * POSITION IN THE STACK like everything else. Drag this card above the glow
   * or below it; the list that already owns effect order owns this too.
   *
   * The graph is carried HERE rather than in a document table, so every value
   * inside it is addressable from the clip: `lfx.<cardId>.n.<nodeId>.…`. A table
   * would have put the nodes out of reach of the clip-scoped path resolver, and
   * every animatable thing in a grade — a node's opacity, a qualifier's centre,
   * a window's rotation — would have needed plumbing of its own. It also means
   * the grade travels with its clip through copy, duplicate, slice and merge,
   * and that deleting the card is the whole of deleting the grade.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("grade"),
    /** The node tree this card renders. See `schema/grade.ts`. */
    graph: gradeGraphSchema,
    /** Master wet/dry over the whole graph — the grade's own mix. */
    mix: z.number().min(0).max(1).default(1),
  }),
  /**
   * Gradient map — remaps the layer's LUMINANCE onto a three-stop ramp, so the
   * darks become one colour, the mids another and the lights a third.
   *
   * Three stops rather than an arbitrary stop list, and that is a deliberate
   * limit rather than a missing feature: an id-bearing list inside an effect
   * cannot ride the flat `lfx.<id>.<field>` keyframe path without every stop
   * needing an id that presets then have to reuse positionally — the exact trap
   * the EQ card had to be dug out of. Three stops keyframe, interpolate and
   * preset like every other field, and they cover duotone, tritone, teal-and-
   * orange and every infrared look people actually reach for.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("gradientMap"),
    shadowColor: z.string().default("#12162e"),
    midColor: z.string().default("#7a4fd0"),
    highColor: z.string().default("#ffd28a"),
    /** Where the mid colour sits on the ramp. */
    midpoint: z.number().min(0.02).max(0.98).default(0.5),
    /** Pushes the source luminance toward its extremes before the lookup. */
    contrast: z.number().min(0).max(4).default(1),
    /** Slides the whole ramp along the luminance axis. */
    brightness: z.number().min(-1).max(1).default(0),
    /** Master mix — blends the mapped result over the original. */
    mix: z.number().min(0).max(1).default(1),
    /** Read the ramp backwards. */
    invert: z.boolean().default(false),
  }),
  /**
   * Posterize — quantises the layer to a few levels. `dither` is what makes it
   * usable rather than a novelty: an ordered dither at low level counts is the
   * difference between a print look and a banded mess.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("posterize"),
    /** How many steps each channel is allowed. */
    levels: z.number().int().min(2).max(64).default(6),
    /** Ordered dithering, to break the bands back up. */
    dither: z.number().min(0).max(1).default(0),
    /** Bends where the steps land — lift it to keep detail in the shadows. */
    gamma: z.number().min(0.2).max(4).default(1),
    /** Master wet/dry. */
    mix: z.number().min(0).max(1).default(1),
    /** Quantise luminance only, keeping the original hue. */
    luminanceOnly: z.boolean().default(false),
  }),
  /**
   * Overlay — a fill or a gradient painted INSIDE the layer's silhouette.
   *
   * The one card that makes text metal. `repeat` with `mirror` is the whole
   * chrome trick: a two-colour ramp folded back on itself four times reads as
   * polished steel, and doing it any other way means stacking four gradients by
   * hand and re-doing all four every time the angle changes.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("overlay"),
    mode: z.enum(["solid", "linear", "radial", "conic", "image"]).default("linear"),
    /** `image` mode (v115): the picture painted in, an image asset id ("" = nothing yet). */
    image: z.string().default(""),
    colorA: z.string().default("#ffd166"),
    colorB: z.string().default("#ef476f"),
    /** Ramp direction in degrees (linear/conic). */
    angle: z.number().min(-180).max(180).default(90),
    /** Ramp size relative to the layer. */
    scale: z.number().min(0.05).max(8).default(1),
    /** Ramp centre, as a fraction of half-width/height. */
    offsetX: z.number().min(-2).max(2).default(0),
    offsetY: z.number().min(-2).max(2).default(0),
    /** Where the two colours meet along the ramp. */
    midpoint: z.number().min(0.02).max(0.98).default(0.5),
    /** How many times the ramp repeats across the layer. */
    repeat: z.number().min(1).max(16).default(1),
    opacity: z.number().min(0).max(1).default(1),
    blend: blendMode.default("source-over"),
    /** Fold each repeat back on itself — the chrome ramp. */
    mirror: z.boolean().default(false),
    /** Paint only inside the silhouette (off = a full-region wash). */
    inside: z.boolean().default(true),
  }),
] as const;
