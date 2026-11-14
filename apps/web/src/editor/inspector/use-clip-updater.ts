"use client";

import * as React from "react";
import { locateClip, type Clip, type MotionDocument } from "@solomotion/core";
import { useDocStore } from "../state/document-context";
import { useSelectionScope } from "./selection-scope";
import { useClipHost } from "./clip-host";

/**
 * Update a clip inside an undoable step. The WRITE SEAM every inspector section
 * goes through — so making it selection-aware turns every section into a
 * multi-editor with no per-section code:
 *
 *  - No `SelectionScope` around it → edits the one `clipId` (single-clip).
 *  - Inside a `SelectionScope` → the same mutation `fn` runs against EVERY clip
 *    in scope, in ONE undo step. `fn` is written against one clip and the clips
 *    are structurally identical (same kind), so a style/text/transform/sizing
 *    write fans cleanly; id-scoped writes (a specific paint id) simply no-op on
 *    the siblings that lack that id, which is the correct, safe degradation.
 *
 * Pass a mergeKey for continuous controls (sliders, colour pickers) so a whole
 * gesture is one undo entry — it's suffixed per target set, not per clip, so a
 * multi-edit gesture still merges.
 *
 * `.preview(fn)` runs the SAME selection-aware fan-out as an ephemeral overlay
 * (no history) — the one seam for live, non-committal previews (font hover, …).
 * Pass `null` to clear it; commit by clearing the preview then calling the
 * updater normally.
 */
export interface ClipUpdater {
  (label: string, fn: (clip: Clip, doc: MotionDocument) => void, mergeKey?: string): void;
  preview(fn: ((clip: Clip, doc: MotionDocument) => void) | null): void;
}

export function useClipUpdater(clipId: string): ClipUpdater {
  const store = useDocStore();
  const scope = useSelectionScope();
  const host = useClipHost(clipId);
  // The scope applies to a section showing one of ITS clips. A section showing
  // some other clip — a voice inside the selected comp, a waveform's target —
  // edits that clip alone, or the write would land on the selection instead.
  const ids = scope && scope.includes(clipId) ? scope : null;
  return React.useMemo<ClipUpdater>(() => {
    // A host standing in for this id (a category's chain) takes the write.
    if (host) {
      const run = ((label, fn, mergeKey) => host.write(label, fn, mergeKey)) as ClipUpdater;
      run.preview = () => undefined;
      return run;
    }
    const targets = () => ids ?? [clipId];
    const eachTarget =
      (fn: (clip: Clip, doc: MotionDocument) => void) => (d: MotionDocument) => {
        for (const id of targets()) {
          const loc = locateClip(d, id);
          if (loc) fn(loc.clip, d);
        }
      };
    const run = ((label, fn, mergeKey) => {
      store.update(
        label,
        eachTarget(fn),
        mergeKey ? { mergeKey: `${mergeKey}-${ids ? ids.join(",") : clipId}` } : undefined,
      );
    }) as ClipUpdater;
    run.preview = (fn) => store.setOverlay(fn ? eachTarget(fn) : null);
    return run;
    // `ids` identity is memoized by the provider, so this stays stable per selection.
  }, [store, clipId, ids, host]);
}
