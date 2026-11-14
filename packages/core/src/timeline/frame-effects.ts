import type { AdjustmentClip, MotionDocument } from "../schema";
import { isAdjustmentClip } from "../clip-registry";

/**
 * WHICH CLIP IS A FRAME'S OWN EFFECTS — a LEAF module on purpose.
 *
 * The render clock (`timeline/fps.ts`, `frameEvalTimeMs`) asks this on every
 * render to hold a posterized frame, and fps.ts is imported by half of core at
 * module scope. Living in `adjustment.ts` meant fps → adjustment → factories →
 * … → expressions → fps: an import cycle that tsc cannot see and module
 * evaluation trips on ("Cannot access DEFAULT_FPS before initialization").
 * So this file imports types and the type-only clip registry, nothing else.
 */

/**
 * THE FRAME'S OWN EFFECT STACK — an effect applied to the whole comp, and to
 * the export, without belonging to any layer in it.
 *
 * It is NOT a new field on the frame, and that is the whole design. A frame
 * effect is exactly what an adjustment layer with `reach: "all"` and no matte
 * already is: it grades the finished composite as a final pass, chains with
 * others bottom→top, keyframes, mattes, mixes through opacity and blend, and
 * renders through the one `buildLfxStages` pipeline every layer uses — which
 * means it exports correctly on the day it is added, because the exporter and
 * the preview call the same function.
 *
 * A `frame.effects` array would have been a SECOND answer to "what grades this
 * composite": a second stack for the renderer to run, a second place for
 * keyframes to live, a second thing the node board and the property registry
 * would need to learn, and a migration to carry it. All to reproduce a
 * behaviour that already shipped. So the frame's stack is DERIVED, not stored —
 * it is the topmost whole-reach adjustment in the frame, and the frame panel
 * is a view onto that clip rather than an owner of a new one.
 *
 * Topmost wins because all-reach adjustments apply highest-track-first, so the
 * topmost is the one the user thinks of as "the frame's look".
 */
export function isFrameEffectClip(clip: { kind: string; scope?: { reach: string; filter: { mode: string } } }): boolean {
  return clip.kind === "adjustment" && clip.scope?.reach === "all" && clip.scope.filter.mode === "all";
}

/**
 * The clip carrying `frameId`'s frame-level effects, or null when it has none.
 * Derived on every read so it can never disagree with the timeline: delete the
 * clip and the frame simply has no frame effects again.
 */
export function frameEffectClip(doc: MotionDocument, frameId: string): AdjustmentClip | null {
  let found: AdjustmentClip | null = null;
  // Ascending track order, keeping the last match — the topmost track wins,
  // matching the order the renderer applies all-reach adjustments in.
  for (const track of doc.tracks) {
    for (const c of track.clips) {
      if (c.frameId === frameId && isAdjustmentClip(c) && isFrameEffectClip(c)) found = c;
    }
  }
  return found;
}
