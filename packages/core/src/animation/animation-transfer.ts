import { z } from "zod";
import { animationSpecSchema, layerAnimationSpecSchema, type AnimationSpec, type LayerAnimationSpec } from "../schema/animation";
import { easingSchema } from "../schema/common";
import { carryMatchingParams, getPreset, specFromPreset, type AnimationPresetDef } from "./presets";
import { layerSpecFromPreset } from "./layer-animation";

/**
 * ANIMATION TRANSFER — one animation, copied from any edge and pasted onto any
 * other that will take it.
 *
 * The app animates at two grains with one preset library: a text layer's
 * glyphs (an `AnimationSpec`, with a unit and a rhythm) and a whole layer's
 * in/out edges (a `LayerAnimationSpec`, which has neither). A copied animation
 * is the SUPERSET of both — what the preset is and how it is tuned — so it can
 * leave a text phase and land on a layer edge, or the reverse, losing only
 * what the destination cannot express. The destination decides: a paste onto
 * a layer that cannot draw refuses a draw-on; a typewriter refuses to land on
 * a rectangle. `null` is the honest answer, and the surfaces say why.
 *
 * Pure data and pure functions, like the property transfer beside it, so the
 * same capture rides the system clipboard between windows and projects.
 */

export const animationCaptureSchema = z.object({
  kind: z.literal("animation"),
  preset: z.string(),
  durationMs: z.number().min(0),
  easing: easingSchema,
  params: z.record(z.string(), z.number()),
  /** Present when the copy came from a text phase. */
  rhythm: animationSpecSchema.pick({ unit: true, staggerMs: true, delayMs: true, jitterMs: true, scatterPx: true, scatterDeg: true }).partial().optional(),
});
export type AnimationCapture = z.infer<typeof animationCaptureSchema>;

export function captureLayerAnimation(spec: LayerAnimationSpec): AnimationCapture {
  return { kind: "animation", preset: spec.preset, durationMs: spec.durationMs, easing: spec.easing, params: { ...spec.params } };
}

export function captureTextAnimation(spec: AnimationSpec): AnimationCapture {
  const { preset, durationMs, easing, params, unit, staggerMs, delayMs, jitterMs, scatterPx, scatterDeg } = spec;
  return {
    kind: "animation",
    preset,
    durationMs,
    easing,
    params: { ...params },
    rhythm: { unit, staggerMs, delayMs, jitterMs, scatterPx, scatterDeg },
  };
}

/** Parse anything claiming to be a capture; null when it is not one. */
export function parseAnimationCapture(input: unknown): AnimationCapture | null {
  const res = animationCaptureSchema.safeParse(input);
  return res.success ? res.data : null;
}

/**
 * A capture as a whole-layer edge, or null when the destination's gallery
 * does not offer the preset (a draw-on on a photo, a typewriter on a shape).
 * Tuning carries; params the preset does not declare are dropped.
 */
export function toLayerAnimation(cap: AnimationCapture, allowed: readonly AnimationPresetDef[]): LayerAnimationSpec | null {
  if (!allowed.some((p) => p.id === cap.preset)) return null;
  const fresh = layerSpecFromPreset(cap.preset);
  return layerAnimationSpecSchema.parse({
    preset: cap.preset,
    durationMs: cap.durationMs,
    easing: cap.easing,
    params: carryMatchingParams(fresh.params, cap.params),
  });
}

/**
 * A capture as a text phase, or null when the preset is layer-only. A copy
 * that came from a layer edge has no rhythm; it takes the preset's defaults,
 * which is what a fresh pick of the same preset would have done.
 */
export function toTextAnimation(cap: AnimationCapture): AnimationSpec | null {
  const def = getPreset(cap.preset);
  if (!def || def.scope === "layer") return null;
  const fresh = specFromPreset(cap.preset);
  return animationSpecSchema.parse({
    ...fresh,
    ...(cap.rhythm ?? {}),
    preset: cap.preset,
    durationMs: cap.durationMs,
    easing: cap.easing,
    params: carryMatchingParams(fresh.params, cap.params),
  });
}
