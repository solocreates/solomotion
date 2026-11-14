import {
  applyLayerAnimToClips,
  applyTemplateToClip,
  getTemplate,
  isClipLocked,
  locateClip,
  type MotionDocument,
} from "@solomotion/core";
import type { useDocStore } from "../state/document-context";
import type { LibraryDrag } from "../state/session";
import { textLookPrefs } from "../state/workspace";

/**
 * "Can this library item land on THIS layer, and what happens if it does" —
 * one pair of functions, so every surface that offers a drop (the canvas, the
 * layers tree, a clip in the timeline) can only ever offer the same answer.
 *
 * The predicate is the load-bearing half. Without it each surface guessed:
 * the layers panel highlighted any row and then silently did nothing over a
 * shape; the stage let a transition draw a "drop here" outline it could not
 * honour. A highlight that promises an edit the commit refuses is worse than
 * no highlight — it teaches the user the gesture is unreliable.
 */

/** Does dropping `drag` on `clipId` actually do something? */
export function libraryDropAppliesTo(
  doc: MotionDocument,
  drag: NonNullable<LibraryDrag>,
  clipId: string,
): boolean {
  const loc = locateClip(doc, clipId);
  // A locked layer is not a target anywhere, on any surface, for anything.
  if (!loc || isClipLocked(loc.track, loc.clip)) return false;
  // An animation rides on any visual layer, a processor included — its pose
  // drives the grade's sizing and mix. Audio is the one kind with no pose.
  if (drag.kind === "anim") return loc.clip.kind !== "audio";
  // A template is type — it restyles text and nothing else.
  if (drag.kind === "template") return loc.clip.kind === "text" && getTemplate(drag.id) !== undefined;
  // A transition belongs to a CUT, which only exists on a time axis; media and
  // components CREATE and therefore never target an existing layer.
  return false;
}

/**
 * Commit a library item onto existing layers. Mirrors the predicate above —
 * anything it refuses is skipped here too, so a caller that skipped the check
 * cannot corrupt anything, only do nothing.
 *
 * PLURAL, because every caller already has a selection. A look applied with
 * four titles selected has to land on four titles: applying it to one of them
 * and leaving the rest is not a smaller version of what was asked for, it is a
 * different thing. One `store.update` either way, so it stays one undo step.
 */
export function applyLibraryItemToClip(
  store: ReturnType<typeof useDocStore>,
  drag: NonNullable<LibraryDrag>,
  clipIds: string | readonly string[],
): void {
  const doc = store.getState();
  const ids = (typeof clipIds === "string" ? [clipIds] : clipIds).filter((id) =>
    libraryDropAppliesTo(doc, drag, id),
  );
  if (ids.length === 0) return;
  store.update(drag.kind === "template" ? "Apply template" : "Apply preset", (d) => {
    if (drag.kind === "anim") {
      applyLayerAnimToClips(d, ids, drag.id, "in");
      return;
    }
    const template = getTemplate(drag.id);
    if (!template) return;
    const prefs = textLookPrefs();
    for (const id of ids) {
      const loc = locateClip(d, id);
      if (loc?.clip.kind === "text") applyTemplateToClip(loc.clip, template, prefs);
    }
  });
}

/**
 * The layers a DROP on `clipId` should land on: the whole selection when the
 * layer under the cursor is part of it, otherwise just that layer. Figma's
 * rule, and it lives here because three surfaces offer this drop — the canvas,
 * the timeline and the layers tree — and a fourth will.
 */
export function libraryDropTargets(
  clipId: string,
  selectedClipIds: readonly string[],
): readonly string[] {
  return selectedClipIds.includes(clipId) ? selectedClipIds : [clipId];
}
