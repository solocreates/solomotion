"use client";

import * as React from "react";
import {
  editPath,
  locateClip,
  selectionPath,
  soundInventory,
  type MotionDocument,
  type SoundBus,
  type SoundCharacter,
} from "@solomotion/core";
import { useDoc, useDocStore } from "../../state/document-context";
import { useSession } from "../../state/session";

/** A character's human name — the category kind picker and the mixer both say it this way. */
export const CHARACTER_LABELS: Record<SoundCharacter, string> = {
  voice: "Speech",
  music: "Music",
  sfx: "Effects",
  ambience: "Ambience",
};

/**
 * Who routes where, project-wide — memoised on the document so every panel
 * asking for a count (picker, category panel, mixer, frame Sound tab) pays
 * for ONE walk per edit.
 */
let memo: { doc: MotionDocument; inv: ReturnType<typeof soundInventory> } | null = null;
function inventoryOf(doc: MotionDocument): ReturnType<typeof soundInventory> {
  if (memo?.doc !== doc) memo = { doc, inv: soundInventory(doc) };
  return memo.inv;
}

export function busMembersOf(doc: MotionDocument): Map<string | null, string[]> {
  return inventoryOf(doc).members;
}

export function useBusMembers(): Map<string | null, string[]> {
  const doc = useDoc();
  return React.useMemo(() => busMembersOf(doc), [doc]);
}

/** Clips that make or contain sound — what a ducking rule can name. */
export function useSoundSources(): string[] {
  const doc = useDoc();
  return React.useMemo(() => inventoryOf(doc).sources, [doc]);
}

/** Write one category, in one undo step. */
export function useBusUpdater(): (id: string, label: string, fn: (bus: SoundBus) => void, mergeKey?: string) => void {
  const store = useDocStore();
  return React.useCallback(
    (id, label, fn, mergeKey) =>
      store.update(
        label,
        (d) => {
          const bus = d.soundBuses.find((b) => b.id === id);
          if (bus) fn(bus);
        },
        mergeKey ? { mergeKey: `${mergeKey}-${id}` } : undefined,
      ),
    [store],
  );
}

/**
 * Select a layer from a list and take the editor to it — wherever it lives.
 * A layer reachable from where you stand is simply selected (the selection
 * reaches inside nested comps on its own); one on another page's comp opens
 * that comp first.
 */
export function goToLayer(doc: MotionDocument, clipId: string): void {
  const session = useSession.getState();
  const loc = locateClip(doc, clipId);
  if (!loc) return;
  const at = selectionPath(doc, session.nav.path.rootFrameId ? session.nav.path : editPath(loc.clip.frameId), clipId);
  if (at?.reach === "elsewhere") session.revealFrame(at.path.rootFrameId);
  session.select([clipId]);
}
