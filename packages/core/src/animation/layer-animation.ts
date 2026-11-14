import type { LayerAnimationSpec } from "../schema/animation";
import type { VisualClip } from "../schema/clips";
import type { MotionDocument } from "../schema/document";
import { evaluateEasing } from "../easing";
import { clipHasOutline } from "../vector/reveal-strands";
import {
  carryMatchingParams,
  getPreset,
  GLYPH_IDENTITY,
  LAYER_ANIMATION_PRESETS,
  type AnimationPresetDef,
  type GlyphVisual,
} from "./presets";

/**
 * Whole-layer in/out animation — ONE headless brain, mirrored everywhere:
 * the canvas renderer composites the pose at the layer seam, the timeline
 * shades clips with it and drags its duration handles, the SVG exporter
 * samples it, and the Lottie translator bakes it. The preset LIBRARY is the
 * text animator's registry (animation/presets.ts) evaluated at layer
 * granularity — same ids, same evaluators, same params. One vocabulary.
 */

/**
 * The layer presets THIS layer can use: every whole-layer preset, minus those
 * whose `needs` the layer cannot meet (a draw-on offered on a photo is a knob
 * that does nothing). The Animate tab, the drop targets and any "default
 * animation" chooser ask here, so none of them can offer what the other hides.
 */
export function layerPresetsFor(doc: MotionDocument, clip: VisualClip): AnimationPresetDef[] {
  return LAYER_ANIMATION_PRESETS.filter((p) => !p.needs || (p.needs === "outline" && clipHasOutline(doc, clip)));
}

/** Default spec for a preset at layer level (no unit/stagger — the layer IS the unit). */
export function layerSpecFromPreset(presetId: string): LayerAnimationSpec {
  const def = getPreset(presetId);
  return {
    preset: presetId,
    durationMs: Math.max(200, def?.defaultDurationMs ?? 450),
    easing: def?.defaultEasing ?? { kind: "preset", name: "ease-out" },
    params: Object.fromEntries((def?.params ?? []).map((p) => [p.key, p.defaultValue])),
  };
}

/**
 * Switch an existing layer animation to another preset WITHOUT discarding the
 * user's tuning: duration + easing carry over, and any param the new preset also
 * declares keeps its current value — only genuinely new knobs take defaults.
 * `prev` null → a fresh spec from the preset's defaults. THE seam every "change
 * the animation mode" control uses so changing the mode never resets the timing.
 */
export function retargetLayerSpec(
  prev: LayerAnimationSpec | null,
  presetId: string,
): LayerAnimationSpec {
  const fresh = layerSpecFromPreset(presetId);
  if (!prev) return fresh;
  return {
    preset: presetId,
    durationMs: prev.durationMs,
    easing: prev.easing,
    params: carryMatchingParams(fresh.params, prev.params),
  };
}

function evalLayerSpec(
  spec: LayerAnimationSpec,
  localMs: number,
  phase: "in" | "out",
  clipDurationMs: number,
): GlyphVisual {
  const def = getPreset(spec.preset);
  if (!def) return GLYPH_IDENTITY;
  const dur = Math.max(1, spec.durationMs);
  const start = phase === "in" ? 0 : Math.max(0, clipDurationMs - dur);
  const raw = Math.min(1, Math.max(0, (localMs - start) / dur));
  // Fully settled (in) or not yet started (out) — the identity fast path.
  if (phase === "in" && raw >= 1) return GLYPH_IDENTITY;
  if (phase === "out" && raw <= 0) return GLYPH_IDENTITY;
  const eased = evaluateEasing(spec.easing, raw);
  if (phase === "in") return def.evalIn(eased, spec.params);
  if (def.evalOut) return def.evalOut(eased, spec.params);
  // Default out: the in-animation played backwards (same contract as text).
  return def.evalIn(evaluateEasing(spec.easing, 1 - raw), spec.params);
}

/**
 * Compose two layer poses — opacities and scales multiply, offsets, rotations
 * and blurs add. Exported because a transition's per-side pose composes onto
 * the clip's OWN in/out animation at the render seam, exactly as the glyph pose
 * already composes onto the layer pose. One composition rule everywhere.
 */
export function composePoses(a: GlyphVisual, b: GlyphVisual): GlyphVisual {
  return {
    opacity: a.opacity * b.opacity,
    dx: a.dx + b.dx,
    dy: a.dy + b.dy,
    scale: a.scale * b.scale,
    rotation: a.rotation + b.rotation,
    blur: a.blur + b.blur,
  };
}

/** Is this pose the do-nothing pose? Exported so render seams can fast-path it. */
export const isIdentityPose = (v: GlyphVisual) =>
  v.opacity === 1 && v.dx === 0 && v.dy === 0 && v.scale === 1 && v.rotation === 0 && v.blur === 0;

/** Does the clip carry any layer animation at all? (Cheap render guard.) */
export function hasLayerAnimation(clip: VisualClip): boolean {
  return clip.animIn !== null || clip.animOut !== null;
}

/**
 * The layer's animated pose at a clip-local time. GLYPH_IDENTITY (the exact
 * shared instance) when nothing is animating right now — callers can use a
 * reference check as the fast path.
 */
export function layerPoseAt(clip: VisualClip, localMs: number): GlyphVisual {
  if (!hasLayerAnimation(clip)) return GLYPH_IDENTITY;
  let pose = GLYPH_IDENTITY;
  if (clip.animIn) {
    const v = evalLayerSpec(clip.animIn, localMs, "in", clip.durationMs);
    if (!isIdentityPose(v)) pose = composePoses(pose, v);
  }
  if (clip.animOut) {
    const v = evalLayerSpec(clip.animOut, localMs, "out", clip.durationMs);
    if (!isIdentityPose(v)) pose = composePoses(pose, v);
  }
  return isIdentityPose(pose) ? GLYPH_IDENTITY : pose;
}
