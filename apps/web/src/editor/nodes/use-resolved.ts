"use client";

import * as React from "react";
import type { MotionDocument, Clip } from "@solomotion/core";
import { useDoc } from "../state/document-context";
import { useParkedPlayhead, useSession } from "../state/session";
import { activeCompId } from "../timeline/timeline-utils";
import { resolvedDocAt, withAuthoredLengths } from "@solomotion/core";

/**
 * THE RESOLVED DOCUMENT — what the app SEES, as opposed to what it stores.
 *
 * A driven property (`clip.drivers[path]`, holding a graph, an expression or a
 * variable) used to be resolved separately by each surface that happened to care,
 * which meant only the ones that remembered to look saw it. Here it is resolved
 * once, into the clip's own slots, so every consumer downstream — the inspector's
 * fields, the stage's handles and hit rectangles, a node card's value row — reads
 * an ordinary value and cannot disagree with the canvas about where a layer is.
 *
 * Kept as a separate hook rather than folded into `useDoc` on purpose. Resolution
 * depends on the playhead, so a document that re-resolved globally would
 * re-render every subscriber on every frame of playback. Surfaces that need
 * visual truth opt in; surfaces that only read structure keep the cheap raw
 * document. Writes always go to the raw store — you edit the value underneath a
 * driver, never the driven result.
 */
export function useResolvedDoc(): MotionDocument {
  const doc = useDoc();
  const compId = activeCompId(doc, useSession((s) => s.activeFrameId));
  const playheadMs = useDynamicPlayhead(doc);
  return React.useMemo(() => resolvedDocAt(doc, playheadMs, compId), [doc, playheadMs, compId]);
}

/**
 * The resolved document as a surface that EDITS values sees it — every size
 * written in a unit shows the number written (`40` fw), not the px it bakes to
 * (core `withAuthoredLengths`). The inspector and node rows; never the stage.
 */
export function useEditedDoc(): MotionDocument {
  const raw = useDoc();
  const doc = useResolvedDoc();
  return React.useMemo(() => withAuthoredLengths(doc, raw), [doc, raw]);
}

/** One clip with its drivers baked — the same rule, for a surface that already
 *  has the clip in hand (an inspector section, a node row). Resolved through the
 *  document so it shares the one cached pass rather than opening a second one. */
export function useResolvedClip(clip: Clip | undefined): Clip | undefined {
  const doc = useEditedDoc();
  return React.useMemo(() => {
    if (!clip?.drivers || Object.keys(clip.drivers).length === 0) return clip;
    for (const track of doc.tracks) {
      const found = track.clips.find((c) => c.id === clip.id);
      if (found) return found;
    }
    return clip;
  }, [clip, doc]);
}

/**
 * The playhead, but ONLY for documents that can actually vary with it — and
 * parked (`useParkedPlayhead`): a document with one expression anywhere used to
 * re-bake and re-render the whole inspector every frame of playback.
 */
function useDynamicPlayhead(doc: MotionDocument): number {
  return useParkedPlayhead(doc.graphs.length > 0 || doc.expressions.length > 0 || doc.variables.length > 0);
}
