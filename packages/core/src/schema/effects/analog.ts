import { z } from "zod";

import { blendMode, layerEffectBase, ownMotion, temporalClock } from "./shared";

/**
 * Film and video — the time-driven family. Every card here carries the
 * temporal clock, which is exactly why they are one chunk: they share the
 * seeded-step machinery in `animation/temporal.ts` and nothing else needs it.
 */
export const ANALOG_EFFECT_ARMS = [
  /**
   * Film grain — emulsion noise, re-rolled on a TEMPORAL CLOCK.
   *
   * It used to be one `Math.random()` tile built at module load: frozen in
   * time, and different in every session, so an export never matched the
   * preview it was approved from. Now the tile is a pure function of
   * `(seed, step)`, which makes it both animate and reproduce exactly.
   *
   * `blend` is the real emulsion control and it is why there is no
   * shadow/highlight-response slider here: `overlay` and `soft-light` already
   * concentrate grain in the midtones and let the extremes resist it, exactly
   * as film does, without a per-pixel luminance pass.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("grain"),
    ...temporalClock,
    ...ownMotion(false),
    /** Grain strength (blend opacity). */
    amount: z.number().min(0).max(1).default(0.25),
    /** Grain cell size — 1 = fine, upward = chunkier. */
    size: z.number().min(0.25).max(8).default(1),
    /** Cell aspect: 1 = square, >1 = horizontally stretched (anamorphic). */
    aspect: z.number().min(0.1).max(10).default(1),
    /** Blurs the grain — the dial from crisp digital speckle to soft emulsion. */
    softness: z.number().min(0).max(8).default(0),
    /** 0 = monochrome silver grain, 1 = full colour dye-cloud grain. */
    chroma: z.number().min(0).max(1).default(0),
    blend: blendMode.default("overlay"),
  }),
  /**
   * Film damage (v46) — the "old projector" card: everything that happens to a
   * physical strip of film BETWEEN the emulsion and your eye. Dust and specks
   * caught in the gate, scratches worn down the length of the print, hairs,
   * exposure flicker, gate weave, and the odd bad splice.
   *
   * It deliberately does NOT include grain or a vignette: both already exist as
   * their own cards, and duplicating them here would be two implementations of
   * one concept that disagree the moment one is improved. Stack the three —
   * that's what an ordered effect stack is for.
   *
   * Every sub-block is driven by the SAME clock, because on a real projector
   * they are: the gate opens once and the dust, the weave and the flicker all
   * change together. Two independent rhythms = two cards.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("filmDamage"),
    ...temporalClock,
    ...ownMotion(true),
    /** Master wet/dry over the whole card. */
    mix: z.number().min(0).max(1).default(1),

    // Dust & specks — debris in the gate, re-scattered every step.
    /** How much debris lands per frame (0 = none). */
    dust: z.number().min(0).max(1).default(0.35),
    /** Speck size in frame px. */
    dustSize: z.number().min(0.5).max(40).default(4),
    /** −1 = white/positive specks, +1 = black/negative specks, 0 = both. */
    dustBias: z.number().min(-1).max(1).default(0.4),
    /** Blurs the specks — hard grit vs. out-of-focus motes. */
    dustSoftness: z.number().min(0).max(1).default(0.15),

    // Scratches — vertical wear lines that persist for a step and wander.
    /** How many scratches are on screen at once. */
    scratches: z.number().min(0).max(40).default(3),
    /** Scratch line width in frame px. */
    scratchWidth: z.number().min(0.2).max(20).default(1.4),
    /** How much of the frame height a scratch spans (1 = edge to edge). */
    scratchLength: z.number().min(0.05).max(1).default(0.9),
    /** Feathers the line — a fresh gouge vs. a polished old one. */
    scratchSoftness: z.number().min(0).max(1).default(0.25),
    /** Sideways wander in frame px per second — the scratch breathing. */
    scratchDrift: z.number().min(0).max(400).default(20),
    scratchOpacity: z.number().min(0).max(1).default(0.5),
    scratchColor: z.string().default("#ffffff"),
    /** Tilt off vertical, in degrees. */
    scratchAngle: z.number().min(-45).max(45).default(0),

    // Hairs — a curled fibre stuck in the gate, the signature of a dirty print.
    hairs: z.number().min(0).max(12).default(0),
    hairWidth: z.number().min(0.2).max(10).default(1.6),
    /** Hair length as a fraction of the frame's short side. */
    hairSize: z.number().min(0.02).max(1).default(0.25),
    hairOpacity: z.number().min(0).max(1).default(0.6),

    // Flicker — the lamp/shutter breathing, as an exposure multiplier.
    flicker: z.number().min(0).max(1).default(0.15),
    /** 0 = hard step per gate open, 1 = a continuous breathing glide. */
    flickerSmooth: z.number().min(0).max(1).default(0.4),

    // Gate weave — the strip not sitting perfectly still in the gate.
    weaveX: z.number().min(0).max(200).default(2),
    weaveY: z.number().min(0).max(200).default(3),
    weaveRotate: z.number().min(0).max(10).default(0.15),
    /** 0 = the mechanical snap of a gate, 1 = a smooth float. */
    weaveSmooth: z.number().min(0).max(1).default(0.5),

    // Splices & jumps — the print physically slipping a frame.
    /**
     * Whether the print slips at all. A MODE, apart from the odds, so the
     * chance you dialled survives switching it off — and off by default: a
     * one-frame lurch reads as a broken render to anyone who did not ask for it.
     */
    splices: z.boolean().default(false),
    /** Chance per step that the frame slips vertically. */
    jump: z.number().min(0).max(1).default(0),
    /** How far it slips, as a fraction of frame height. */
    jumpAmount: z.number().min(0).max(1).default(0.3),
    /** Brightness of the splice bar that rides through on a jump. */
    splice: z.number().min(0).max(1).default(0.5),

    /** Keep the damage inside the layer's own silhouette. */
    inside: z.boolean().default(true),
  }),
  /**
   * Scanlines (v46) — the CRT / broadcast card: a periodic mask laid over the
   * layer, plus the things that make a mask read as a SCREEN rather than as
   * stripes (phosphor bleed, tube curvature, interlace, a rolling bar).
   *
   * `shape` is what makes one card cover the whole family instead of four: a
   * CRT's aperture grille, a shadow mask's dot triad and an LCD's subpixel slot
   * are the same periodic function sampled differently, so they are one enum,
   * not one effect each.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("scanlines"),
    ...temporalClock,
    ...ownMotion(true),
    /** Master wet/dry over the whole card. */
    mix: z.number().min(0).max(1).default(1),

    // Pattern.
    shape: z.enum(["line", "dot", "slot", "grille"]).default("line"),
    /** Line direction in degrees (0 = horizontal lines, 90 = vertical). */
    angle: z.number().min(-180).max(180).default(0),
    /** Distance between line centres, in frame px. */
    pitch: z.number().min(1).max(200).default(4),
    /** 0..1 — how much of each period the dark part covers (duty cycle). */
    thickness: z.number().min(0.02).max(0.98).default(0.5),
    /** 0 = hard-edged bars, 1 = a pure sine — the CRT vs. print-mask dial. */
    softness: z.number().min(0).max(1).default(0.6),
    /** Shifts the pattern across the layer, in frame px. */
    offset: z.number().min(-500).max(500).default(0),
    /** Cross-axis pitch ratio for dot/slot masks. */
    aspect: z.number().min(0.1).max(10).default(1),

    // Look.
    amount: z.number().min(0).max(1).default(0.5),
    color: z.string().default("#000000"),
    blend: blendMode.default("multiply"),
    /** Horizontal phosphor smear along the scan direction, in frame px. */
    bleed: z.number().min(0).max(60).default(0),
    /** Brightens the lit part of each period — the phosphor glowing back. */
    boost: z.number().min(0).max(2).default(0),

    // Motion.
    /** Rolls the pattern across the layer, in frame px per second. */
    roll: z.number().min(-2000).max(2000).default(0),
    /** Random exposure flicker per step. */
    flicker: z.number().min(0).max(1).default(0),
    /** Alternates which field is dimmed each step — 60Hz interlace judder. */
    interlace: z.number().min(0).max(1).default(0),

    // Screen geometry.
    /** Barrel curvature of the tube — 0 is flat, 1 is a fishbowl portable. */
    curvature: z.number().min(0).max(1).default(0),

    /** Keep the mask inside the layer's own silhouette. */
    inside: z.boolean().default(true),
  }),
  /**
   * Noise (v46) — a procedural field generator, not a fixed texture. One card
   * spans static, fractal cloud, turbulence and ridged veins because they are
   * the same lattice noise folded differently across octaves.
   *
   * `displace` is what makes it more than an overlay: the SAME generated field
   * can warp the layer instead of (or as well as) tinting it, which is where
   * heat haze, tape wobble and underwater shimmer come from. One field, two
   * consumers — generating it twice would be the bug.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("noise"),
    ...temporalClock,
    ...ownMotion(false),
    /** Master wet/dry over the whole card. */
    mix: z.number().min(0).max(1).default(1),

    // Pattern.
    shape: z.enum(["value", "fractal", "turbulence", "ridged"]).default("fractal"),
    /** Feature size in frame px — how big one blob of noise is. */
    scale: z.number().min(1).max(2000).default(64),
    /** Cell aspect: >1 stretches the field horizontally. */
    aspect: z.number().min(0.1).max(10).default(1),
    /** How many octaves of detail are summed. */
    octaves: z.number().min(1).max(8).default(4),
    /** Amplitude falloff per octave — higher is rougher. */
    roughness: z.number().min(0.05).max(0.95).default(0.5),
    /** Frequency growth per octave. 2 is the classic doubling. */
    lacunarity: z.number().min(1.05).max(4).default(2),
    /** Pushes the field toward its extremes. */
    contrast: z.number().min(0).max(4).default(1),
    brightness: z.number().min(-1).max(1).default(0),

    // Motion.
    /** How far the field travels through its own third dimension per step. */
    evolve: z.number().min(0).max(20).default(1),
    /** Scroll speed in frame px per second. */
    driftX: z.number().min(-2000).max(2000).default(0),
    driftY: z.number().min(-2000).max(2000).default(0),

    // Look.
    amount: z.number().min(0).max(1).default(0.4),
    blend: blendMode.default("overlay"),
    /** 0 = one field for all channels, 1 = three offset fields (colour static). */
    chroma: z.number().min(0).max(1).default(0),
    lowColor: z.string().default("#000000"),
    highColor: z.string().default("#ffffff"),

    // Warp.
    /** Displace the layer along the field's gradient, in frame px. */
    displace: z.number().min(0).max(400).default(0),

    /** Keep the noise inside the layer's own silhouette. */
    inside: z.boolean().default(true),
  }),
] as const;
