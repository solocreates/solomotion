import { z } from "zod";
import { keyframeValueSchema } from "./animation";
import { layerEffectListSchema, type LayerEffect } from "./layer-effects";
import { paintSchema, strokeStyleSchema, type Paint, type StrokeStyle } from "./vector";
import { textEffectSchema, type TextEffect } from "./text-style";

/**
 * THE OVERLAY — one shape for every partial style target in the document.
 *
 * A text layer has three style targets that are not the layer: a selected
 * RANGE, a caption's FOCUS, and (soon) whatever else wants to say "like the
 * parent, except…". Until v59 each of those carried its own hand-rolled
 * payload — a `PartialTextStyle` and nothing else — which is why:
 *
 *   • the Focus tab could not override an effect, a fill or a stroke, so the
 *     Effects tab silently edited the WHOLE layer while claiming to edit the
 *     focused word;
 *   • "what does this range actually change?" had to be re-derived, per
 *     payload shape, at every call site that wanted to show or clear it;
 *   • every new scoped capability meant a new field on two schemas plus a new
 *     branch in the merge, the normalizer, the migration and the inspector.
 *
 * The fix is to stop describing overrides per-feature and describe them ONCE,
 * by the property PATH vocabulary the keyframe engine already owns: `fontSize`,
 * `color`, `fill.<id>.color`, `stroke.<id>.width`, `lfx.<id>.blur`,
 * `highlight.radius`. So an overlay is a sparse map from path to value, and:
 *
 *   presence IS an override · absence IS inheritance
 *
 * There is no `inherited: true` flag to keep in sync with a value, because the
 * illegal state (a field that is both inherited and overridden) is not
 * representable. Un-linking a field is writing the path; re-linking it is
 * `delete`. That is the whole parent/child contract, and it is two operations.
 *
 * Structural changes — a scope that ADDS an effect the parent doesn't have, or
 * REMOVES one it does — cannot be expressed as a value at a path, so they get
 * the two lists below. `removed` holds parent entry ids; `added` holds whole
 * entries that exist only in this scope. Both are empty on an untouched scope,
 * which is why an overlay costs a few bytes until you actually use it.
 */

/** Entries a scope adds on top of what it inherits, per list. */
export const overlayAdditionsSchema = z.object({
  effects: layerEffectListSchema.default([]),
  fills: z.array(paintSchema).default([]),
  strokes: z.array(strokeStyleSchema).default([]),
  /** Per-glyph passes this scope adds — see `TextStyle.textEffects`. */
  textEffects: z.array(textEffectSchema).default([]),
});
export interface OverlayAdditions {
  effects: LayerEffect[];
  fills: Paint[];
  strokes: StrokeStyle[];
  textEffects: TextEffect[];
}

export const scopeOverlaySchema = z.object({
  /**
   * path → value. The paths are exactly the ones `getClipProperty` /
   * `setClipProperty` understand, so an overlay entry and a keyframe track
   * address the same thing and can never drift apart in what they mean.
   */
  props: z.record(z.string(), keyframeValueSchema).default({}),
  /** Ids of INHERITED entries (effects/fills/strokes) this scope drops. */
  removed: z.array(z.string()).default([]),
  /** Entries that exist only in this scope. */
  added: overlayAdditionsSchema.default({ effects: [], fills: [], strokes: [], textEffects: [] }),
});
export interface ScopeOverlay {
  props: Record<string, z.infer<typeof keyframeValueSchema>>;
  removed: string[];
  added: OverlayAdditions;
}

/** The empty overlay — "identical to my parent". Allocate through this. */
export function emptyOverlay(): ScopeOverlay {
  return { props: {}, removed: [], added: { effects: [], fills: [], strokes: [], textEffects: [] } };
}
