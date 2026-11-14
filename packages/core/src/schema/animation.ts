import { z } from "zod";
import { contourSchema, type Contour } from "./vector";
import { easingSchema } from "./common";

/** The granularity an animation staggers over. */
export const animationUnitSchema = z.enum(["letter", "word", "line"]);
export type AnimationUnit = z.infer<typeof animationUnitSchema>;

/**
 * How a source-backed clip repeats within its span once its source is exhausted.
 * The SAME contract for nested compositions today and video/audio imports later.
 */
export const loopModeSchema = z.enum(["none", "loop", "pingpong"]);
export type LoopMode = z.infer<typeof loopModeSchema>;

/**
 * Playback of a clip that wraps a source with its own intrinsic duration
 * (a nested comp, a video, an audio file). `speed` scales source time; `loop`
 * decides what happens past the source's end. `sourceTimeAt()` maps a clip-local
 * time through this — one primitive reused across every source-backed clip kind.
 */
export const clipPlaybackSchema = z.object({
  speed: z.number().positive().default(1),
  loop: loopModeSchema.default("none"),
  /** Play the source backwards (frame-seek reverse for video/nested; reverses the time-map). */
  reverse: z.boolean().default(false),
  /** Saved per-clip "ripple timeline on retime" override. Absent = automatic:
   * ripple when the next same-track clip sits attached to this one's end. */
  ripple: z.boolean().optional(),
  /**
   * Explicit loop-cycle length, wall-clock ms from the clip's own start. null
   * (default) = the natural source span (today's behavior). Set = the clip
   * repeats its source on THIS period instead — independent of the source's
   * own duration, so a clip can loop a short slice of a much longer source
   * (or a comp's own pinned length) without changing the source itself. Only
   * meaningful when `loop !== "none"`; see `loopSpanMs` in animation/evaluate.ts.
   */
  loopLengthMs: z.number().positive().nullable().default(null),
});
export type ClipPlayback = z.infer<typeof clipPlaybackSchema>;

/**
 * A resolved animation: which preset, over which unit, with what timing.
 * `params` are preset-specific knobs (distance, intensity, …) declared by the
 * preset registry so host adapters can interpret them.
 */
export const animationSpecSchema = z.object({
  preset: z.string(),
  unit: animationUnitSchema,
  /** How long a single unit takes to complete. */
  durationMs: z.number().min(0),
  /** Delay between consecutive units starting. */
  staggerMs: z.number().min(0),
  /**
   * Distance from the phase's own edge before anything happens: an entrance
   * waits this long after the cohort arrives, an exit finishes this long before
   * its deadline. Symmetric by design, so "delay" always means the same thing
   * (a gap against the edge) in both directions, and dragging the first tick of
   * the rhythm strip is the same edit either way.
   */
  delayMs: z.number().min(0).default(0),
  easing: easingSchema,
  /**
   * Per-unit timing humanisation: each unit's start is pushed later by up to
   * this many ms, deterministically per clip+unit. 0 (the default, and how
   * every pre-v47 document behaves) is a metronome — which is exactly what
   * makes a typewriter read as a machine rather than a person. Universal
   * rather than a per-preset param: rhythm belongs to the STAGGER, not to
   * whichever shape the glyph happens to move in.
   */
  jitterMs: z.number().min(0).default(0),
  /**
   * Per-unit positional scatter, in frame px, applied to the unit's UNSETTLED
   * pose and faded out as it settles — so the final layout is still exact to
   * the pixel. Same reasoning as `jitterMs`: it composes with every preset
   * instead of being re-declared by each one.
   */
  scatterPx: z.number().min(0).default(0),
  /** Per-unit rotational scatter (deg), faded out on settle like `scatterPx`. */
  scatterDeg: z.number().min(0).default(0),
  params: z.record(z.string(), z.number()),
});
export type AnimationSpec = z.infer<typeof animationSpecSchema>;

/**
 * A whole-LAYER in/out animation (v27) — the universal cousin of the text
 * glyph animation. EVERY visual clip (shape, image, video, nested comp,
 * waveform, text) can fade/slide/pop as one unit; the preset library is the
 * SAME registry the text animator uses (animation/presets.ts), evaluated at
 * layer granularity instead of per glyph — one preset vocabulary everywhere.
 * No unit/stagger: the layer is the unit.
 */
export const layerAnimationSpecSchema = z.object({
  preset: z.string(),
  durationMs: z.number().min(0),
  easing: easingSchema,
  params: z.record(z.string(), z.number()),
});
export type LayerAnimationSpec = z.infer<typeof layerAnimationSpecSchema>;

/**
 * Anything can hold a keyframe. Numbers interpolate, color strings blend,
 * everything else (booleans, enum strings) holds until the next key.
 * The animatable-property registry (animation/properties.ts) declares how
 * each property key behaves — host adapters read the same registry.
 */
// Path geometry is a first-class keyframe value — vector MORPHING: two keys
// with matching structure (same contour/point counts) interpolate point-wise.
//
// CONTOURS, not subpaths: a key holds a SHAPE AT AN INSTANT, which has nothing
// to be identified as. Identity belongs to the layer's declared contours, and
// `pathGeometryAt` lends it positionally — the same correspondence the morph
// already requires — so a tweening layer keeps its parts instead of dissolving
// into orphans halfway through.
//
// A NUMBER ARRAY is the third: a sampled curve along something — today a
// stroke's measured width profile, which is how a pressure-drawn line keeps the
// pressure it was drawn with. It is in this union rather than beside it because
// the union is what `ScopeOverlay` stores and what a keyframe holds, and a
// width curve is a legitimate candidate for both.
export const keyframeValueSchema = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.array(z.number()),
  z.array(contourSchema),
]);
export type KeyframeValue = z.infer<typeof keyframeValueSchema>;

/**
 * Narrow a `KeyframeValue` to path geometry.
 *
 * The union has two array arms — an outline and a sampled curve — so
 * `Array.isArray` no longer answers "is this geometry". It stopped being the
 * right question the moment a second kind of array became storable; asking it
 * by shape here is what keeps the answer in one place instead of at each of the
 * sites that used to guess.
 */
export function isGeometryValue(v: KeyframeValue | undefined): v is Contour[] {
  return Array.isArray(v) && (v.length === 0 || typeof v[0] === "object");
}

/** Narrow a `KeyframeValue` to a sampled curve (a stroke's width profile). */
export function isCurveValue(v: KeyframeValue | undefined): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === "number");
}

/** A property key from the animatable-property registry (open set for forward compat). */
export const animatablePropertySchema = z.string();
export type AnimatableProperty = string;

/**
 * Spatial tangents for 2D motion paths (Lottie's ti/to model). Carried by the
 * X-position track's key only — the x/y keyframe pair at one time forms a
 * single 2D motion key, and the x key is its designated carrier. Offsets are
 * relative to the key's own position, in frame pixels, so moving the anchor
 * translates its handles for free. `null` end = no handle (linear on that
 * side). Absent/null on scalar keys — the common case costs nothing.
 */
export const spatialTangentsSchema = z.object({
  in: z.object({ x: z.number(), y: z.number() }).nullable(),
  out: z.object({ x: z.number(), y: z.number() }).nullable(),
});
export type SpatialTangents = z.infer<typeof spatialTangentsSchema>;

export const keyframeSchema = z.object({
  id: z.string(),
  /**
   * Relative to clip start — and allowed to be NEGATIVE, or past the clip's
   * end (v74).
   *
   * A key is a moment in the clip's own animation, not a moment in its window.
   * Trimming the head therefore has to shift every key by the same delta to
   * hold it at the instant it was authored for, and a key that falls before the
   * new head has to be allowed to sit there: clamping it to 0 (which is what
   * `shiftClipInternals` used to do) piles every early key onto the head, where
   * they merge into one and the animation is gone. Nothing can bring it back,
   * so trimming in and out was a destructive edit disguised as a framing one.
   *
   * Out-of-window keys evaluate as you would expect — a clip's first visible
   * frame samples the curve where the curve is, mid-segment if that is where
   * the trim landed — and the timeline draws them past the bar's edge, so they
   * stay grabbable.
   */
  timeMs: z.number(),
  value: keyframeValueSchema,
  /** Easing of the segment leaving this keyframe. */
  easing: easingSchema,
  /** Motion-path curve handles — only meaningful on an `x` track's keys. */
  spatial: spatialTangentsSchema.nullable().optional(),
});
export type Keyframe = z.infer<typeof keyframeSchema>;

/**
 * A grapheme span `[start, end)` a keyframe track is scoped to. `null` (the
 * default) means the track animates the whole clip. When set, the track only
 * animates that slice of the text — so color, weight, size, etc. can be
 * keyframed for one word or letter run independently (range-scoped keyframes).
 */
export const keyframeRangeSchema = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
});
export type KeyframeRange = z.infer<typeof keyframeRangeSchema>;

export const keyframeTrackSchema = z.object({
  id: z.string(),
  property: animatablePropertySchema,
  /** Text slice this track animates; null/absent = the whole clip. */
  range: keyframeRangeSchema.nullable().default(null),
  keys: z.array(keyframeSchema),
});
export type KeyframeTrack = z.infer<typeof keyframeTrackSchema>;
