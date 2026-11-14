"use client";

import * as React from "react";
import { groupParent, openGroupChain, retreatEnteredGroup, type MotionDocument } from "@solomotion/core";
import { useDocStore } from "./document-context";
import { useSession } from "./session";

/**
 * WHERE THE DRILL STANDS — derived from the selection, one place.
 *
 * Double-clicking a group enters it and opens its rows. Everything after that
 * follows the SELECTION: pick a layer beside the group you are in and the
 * context steps out to the group that holds both; pick one three groups up
 * and it steps out three; pick nothing and it leaves. Each step folds only
 * the rows the DRILL opened below the new level — never one you opened
 * yourself with the chevron, and never the rows you are still inside.
 *
 * `retreatEnteredGroup` (core) is the rule; this is the one seam that applies
 * it, so clicking the canvas, a row in the timeline, a row in the layers
 * panel, ⌘A and Escape all move the context the same way.
 */
export function syncEnteredGroup(doc: MotionDocument): void {
  const s = useSession.getState();
  const next = retreatEnteredGroup(doc, s.enteredGroupId, s.selectedClipIds);
  if (next !== s.enteredGroupId) s.retreatToGroup(next, openGroupChain(doc, next));
}

/**
 * Escape's rung: step OUT of the entered group by selecting it as a unit at
 * its parent's level — Figma's "select parent". Nothing entered: nothing to do.
 */
export function stepOutOfGroup(doc: MotionDocument): boolean {
  const s = useSession.getState();
  const entered = s.enteredGroupId;
  if (!entered) return false;
  const parent = groupParent(doc, entered);
  s.select([entered]);
  s.retreatToGroup(parent, openGroupChain(doc, parent));
  return true;
}

export function useGroupFocus(): void {
  const store = useDocStore();
  const entered = useSession((s) => s.enteredGroupId);
  const selected = useSession((s) => s.selectedClipIds);

  // Reacts to the SELECTION moving, not to every keystroke that edits the
  // document — the document is read live, never subscribed. A structural edit
  // that changes membership (ungroup, move out) calls `syncEnteredGroup` itself.
  React.useEffect(() => {
    syncEnteredGroup(store.getState());
  }, [store, entered, selected]);
}
