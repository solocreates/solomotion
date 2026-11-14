import { z } from "zod";
import { easingSchema } from "./common";

/**
 * MOTION BLUR — the shutter (v56).
 *
 * The one idea, stated once so nothing downstream has to guess: **motion blur
 * is temporal supersampling of the render we already have.** It is not a pixel
 * effect and it is not a transform hack. A layer's shutter is open across an
 * INTERVAL, so the picture is the weighted integral of that layer over the
 * interval — every instant of it, through the same `withLayer` path a single
 * frame takes.
 *
 * ── Why this is not an effect ──────────────────────────────────────────────
 *
 * An effect is `pixels(t) → pixels`. Motion blur is `render × interval →
 * pixels`: it re-invokes the entire layer render, INCLUDING that layer's own
 * effect stack, once per sample. Nothing that lives inside a stack can re-run
 * the stack. Its position in the stack would also be a lie — it is not "before
 * the glow", it is outside, at the composite, where the finished layer meets
 * time. And you cannot have two of them, while an effect stack exists precisely
 * because you can have five glows.
 *
 * So it is a PROPERTY OF THE LAYER, sitting exactly where `opacity`, `feather`
 * and `blendMode` already sit — the other three things that also had to stay
 * outside the stack, for the same reason.
 *
 * (The artistic smear is still an effect and keeps its job: `directionalBlur`
 * in `LAYER_EFFECT_TYPES`. Motion blur is the camera; directional blur is the
 * paintbrush.)
 *
 * ── Where the values live ─────────────────────────────────────────────────
 *
 *   frame.motionBlur   { enabled } & MotionBlurSettings   the comp master
 *                                                          switch AND the
 *                                                          comp's defaults
 *   clip.motionBlur    { enabled, override }               per layer
 *
 * On the FRAME because a shutter angle is meaningless without a frame interval
 * to be a fraction of — it belongs next to `fps` for the same reason `fps` is
 * per-frame at all. On `clipBase` (not the visual union) for the reason
 * `audioMix` is there: an audio clip carrying an inert `{ enabled, null }`
 * costs nothing, while splitting the union costs a `switch` in nine files.
 *
 * Resolution is three-level — layer switch × comp master × render setting —
 * which is exactly After Effects. A known convention, deliberately not
 * reinvented. `resolveMotionBlur` in `animation/shutter.ts` is the ONE place
 * that performs it.
 */

/**
 * How the shutter's exposure is distributed across the interval — the weight
 * each sub-sample carries. Blender ships this as a raw curve; no 2D tool ships
 * it at all, which is why the useful shapes are named looks here and the raw
 * curve is the escape hatch rather than the interface.
 *
 * This is what folds motion TRAILS into the motion BLUR system instead of
 * leaving them as a second feature that would eventually disagree with it: a
 * trail is not a different algorithm, it is a shutter that weighs the past
 * more heavily than the present.
 */
export const shutterWeightingSchema = z.enum([
  /** Uniform. A real film gate. */
  "box",
  /** Gaussian — soft ends. Hides a low sample count better than anything else. */
  "ease",
  /** Solid at the latest instant, fading into the PAST: a comet tail behind the subject. */
  "trail",
  /** Solid at the earliest instant, fading into the FUTURE: anticipation ahead of the subject. */
  "lead",
  /** An authored curve (`curve`), evaluated over the open shutter. */
  "curve",
]);
export type ShutterWeighting = z.infer<typeof shutterWeightingSchema>;

/**
 * WHAT gets re-sampled — a quality ladder over one model, not three features.
 *
 * `transform` is the default and the interesting one: it renders the layer ONCE
 * and re-composites that bitmap under each sub-sample's pose. That is
 * geometrically EXACT rather than approximate — a spinning layer smears along
 * an arc, which a directional blur physically cannot express — and it costs one
 * render plus N blits. It also covers in/out animations and transitions for
 * free, because both resolve to poses that compose into the same delta matrix.
 *
 * `content` is the only tier that costs N full renders, and it buys the only
 * thing the others cannot: change that is not a pose — typing glyphs, a video's
 * frames, an animating effect field, a modulator.
 */
export const motionBlurSamplingSchema = z.enum([
  /** One render, one directional-blur pass along the measured velocity. */
  "velocity",
  /** One render, N weighted re-composites under the sub-poses. Exact geometry. */
  "transform",
  /** N full layer renders, accumulated. Exact everything. */
  "content",
]);
export type MotionBlurSampling = z.infer<typeof motionBlurSamplingSchema>;

/**
 * How the samples COMBINE. `average` is the physical answer; the others are
 * the reason anyone reaches for motion blur as a look rather than as realism.
 * `add`/`screen` is long-exposure light painting — bright moving things paint
 * light instead of averaging into mush.
 */
export const motionBlurCombineSchema = z.enum(["average", "add", "screen", "max"]);
export type MotionBlurCombine = z.infer<typeof motionBlurCombineSchema>;

/**
 * The shutter itself. Every numeric field is a keyframe path (`mblur.<field>`),
 * so it animates like any other property and the inspector's ‹ ◆ › clusters
 * render straight from `PROPERTY_DEFS` with no UI written for them — ramping
 * shutter angle up into a whip pan is a shot, and it falls out for free.
 */
export const motionBlurSettingsSchema = z.object({
  /**
   * Exposure as a fraction of one frame interval: `angle / 360`. 180° is the
   * classic film gate; 360° exposes the whole frame; 720° is twice the frame
   * and reads as a smear. Same numbers as After Effects, so nobody has to
   * learn ours. Past 720° it is a TRAIL rather than a blur — up to ten frames
   * of a body's path behind it, which no camera exposes but every
   * "satisfying" physics loop wants (pair with `weighting: "trail"`).
   */
  shutterAngle: z.number().min(0).max(3600).default(180),
  /**
   * Where the shutter OPENS, relative to the frame time, in the same degrees.
   * The default of -90 puts a 180° shutter half before and half after the
   * frame — centred, which is what makes blur read as motion rather than as
   * lag. (AE's own default, and its own convention: phase = -angle/2.)
   *
   * Positive values push the exposure into the future (anticipation); pushing
   * it fully negative gives a pure trailing smear — `-shutterAngle`, which is
   * why the floor matches the angle's ceiling: a 3600° comet trail (ten
   * frames of tail) opens at -3600.
   */
  shutterPhase: z.number().min(-3600).max(360).default(-90),
  weighting: shutterWeightingSchema.default("box"),
  /** The authored weight curve. Only read when `weighting === "curve"`. */
  curve: easingSchema.default({ kind: "linear" }),
  sampling: motionBlurSamplingSchema.default("transform"),
  combine: motionBlurCombineSchema.default("average"),
  /**
   * Mix of blurred against the crisp original, 0..1. AE has no such control;
   * Cavalry does, and it is the difference between "physically correct" and
   * "reads well" — a subject can smear and stay legible at the same time.
   */
  strength: z.number().min(0).max(1).default(1),
  /**
   * An artistic multiplier on the MEASURED motion. 1 = physical. Above 1
   * exaggerates past what the layer actually did, which is a look the physical
   * model cannot reach and motion design asks for constantly.
   */
  amount: z.number().min(0).max(4).default(1),
  /**
   * A CEILING on sample count, never a target. The actual count is DERIVED from
   * measured travel (`animation/shutter.ts`) — spend one sample per ~1.5 frame
   * px and the smears fuse into a continuum; spend fewer and you see discrete
   * ghosts. After Effects makes you guess 16 or 32 and calls the cap an
   * "adaptive sample limit"; measuring the travel is strictly better, so this
   * only ever protects the frame budget.
   */
  maxSamples: z.number().int().min(2).max(64).default(16),
});
export type MotionBlurSettings = z.infer<typeof motionBlurSettingsSchema>;

/** The comp's master switch and the defaults every layer in it inherits. */
export const frameMotionBlurSchema = motionBlurSettingsSchema.extend({
  /**
   * The comp master. Off means no layer in this comp blurs, whatever its own
   * switch says — the middle level of the three-level model.
   *
   * New comps default this ON. Existing documents are migrated to `false`, so
   * opening an old project renders it exactly as it always did: a migration
   * must never silently restyle someone's work.
   */
  enabled: z.boolean().default(true),
});
export type FrameMotionBlur = z.infer<typeof frameMotionBlurSchema>;

/**
 * A layer's shutter. `override: null` = inherit the comp's settings, which is
 * the overwhelmingly common case and the reason this is a nullable OBJECT
 * rather than nine independently-optional fields: partial inheritance would be
 * 2⁹ states to render, migrate and reason about, where this is two. Making
 * illegal states unrepresentable rather than merely unlikely.
 *
 * "Customise" in the inspector simply copies the comp's current values in, so
 * an override always starts as a faithful snapshot of what you were already
 * seeing, and a preset is just something that writes this field.
 */
export const clipMotionBlurSchema = z.object({
  enabled: z.boolean().default(true),
  override: motionBlurSettingsSchema.nullable().default(null),
});
export type ClipMotionBlur = z.infer<typeof clipMotionBlurSchema>;

/** The defaults, as a value — the comp master a NEW frame is created with. */
export const DEFAULT_FRAME_MOTION_BLUR: FrameMotionBlur = frameMotionBlurSchema.parse({});
/** A layer's default shutter: on, inheriting the comp. */
export const DEFAULT_CLIP_MOTION_BLUR: ClipMotionBlur = clipMotionBlurSchema.parse({});
