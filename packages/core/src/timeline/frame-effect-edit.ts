import type { AdjustmentClip, MotionDocument, LayerEffect } from "../schema";
import { createAdjustmentClip } from "../factories";
import { frameEffectClip } from "./frame-effects";
import { frameDurationMs } from "./ops";
import { placeClip } from "./place";
import { deleteLayers } from "./delete-layers";

// An EDIT, so it lives apart from the leaf that answers "which clip is it?"
// (`./frame-effects`): this one pulls in the factories and placement, and
// nothing at module scope below the API and the app may depend on that.

/**
 * The clip carrying a frame's OWN effects, creating it the first time — in a
 * document being edited. The one brain behind the frame inspector's "Add
 * frame effect", its Texture looks and the API's frame targets, so the clip
 * an agent makes is the clip the panel finds.
 *
 * It spans the WHOLE frame, because a frame effect that stops halfway is a
 * layer effect wearing the wrong name — and it KEEPS spanning it, through the
 * `fillDuration` tracking every processor is born with. It lands topmost so it
 * reads as the outermost thing in the stack, which is where the renderer
 * applies it. Whole reach + no filter IS the definition `frameEffectClip`
 * reads back, so nothing is stored to remember which clip it was.
 */
export function ensureFrameEffectClipIn(d: MotionDocument, frameId: string): AdjustmentClip | null {
  const existing = frameEffectClip(d, frameId);
  if (existing) return existing;
  const frame = d.frames.find((f) => f.id === frameId);
  if (!frame) return null;
  const clip = createAdjustmentClip({ frameId, startMs: 0, durationMs: frameDurationMs(d, frame), name: "Frame effects" });
  clip.scope = { reach: "all", filter: { mode: "all", targetIds: [] }, source: "replace" };
  placeClip(d, clip);
  return clip;
}

/**
 * REPLACE A FRAME'S OWN EFFECT STACK — `[]` clears it. The one write behind
 * `frame.update {effects}`: the same clip `ensureFrameEffectClipIn` makes and
 * `frameEffectClip` reads, so the API, the frame inspector and the renderer
 * keep agreeing that a comp's effects are one stack. Clearing removes that
 * clip — with no cards, a whole-frame processor is nothing — and replacing
 * drops the keys of every card that is gone. Returns the clip, or null when
 * the frame now has no effects of its own.
 */
export function setFrameEffectsIn(d: MotionDocument, frameId: string, effects: readonly LayerEffect[]): AdjustmentClip | null {
  if (effects.length === 0) {
    const existing = frameEffectClip(d, frameId);
    if (existing) deleteLayers(d, [existing.id]);
    return null;
  }
  const clip = ensureFrameEffectClipIn(d, frameId);
  if (!clip) return null;
  const kept = new Set(effects.map((e) => e.id));
  const gone = clip.effects.filter((e) => !kept.has(e.id)).map((e) => e.id);
  if (gone.length) clip.keyframes = clip.keyframes.filter((t) => !gone.some((id) => t.property.includes(`.${id}.`)));
  clip.effects = [...effects];
  return clip;
}
