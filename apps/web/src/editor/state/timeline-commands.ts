"use client";

import {
  SPEED_PROPERTY,
  adjacentKeyframe,
  clipEnd,
  clipPlaybackOf,
  closeAllGaps,
  compFps,
  frameStepMs,
  freezeKeys,
  isClipLocked,
  locateClip,
  moveClip,
  setKeyframe,
  speedAt,
  type MotionDocument,
  type Clip,
  type DocumentStore,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import { useSession } from "./session";
import { activeCompId, timelineSpanMs } from "../timeline/timeline-utils";
import { timelineView } from "../timeline/timeline-view";
import { timelineViewport } from "../timeline/timeline-viewport";
import { deleteSelectedClips } from "./clip-actions";

/**
 * THE TIMELINE VERBS THAT HAD NO KEY.
 *
 * Every one of these is something an editor does dozens of times an hour and
 * could only reach here with a pointer — select everything downstream to make
 * room, close the hole a delete leaves, nudge a clip a frame, jump to the next
 * key, fit the whole cut on screen. They live together because they are one
 * class of thing (a command over the timeline's current selection) and because
 * `use-shortcuts` should stay a dispatch TABLE rather than growing a body.
 */

/** The comp in view — every command below is scoped to it. */
function scope(store: DocumentStore): { doc: MotionDocument; compId: string } | null {
  const doc = store.getState();
  const compId = activeCompId(doc, useSession.getState().activeFrameId);
  return compId ? { doc, compId } : null;
}

/**
 * Select everything on this lane from the playhead onward — Premiere's track
 * select forward (A), and the reason it exists: "make two seconds of room at
 * 00:42" means grabbing every clip after 00:42, and rubber-banding that means
 * scrolling to the end of the cut first.
 *
 * ALL LANES unless a clip is already selected, in which case just its lane.
 * That is the rule both Premiere and Resolve settled on, and it reads
 * correctly either way: with nothing picked you mean the whole timeline; with
 * something picked you mean the track you are working on.
 */
export function selectClipsFrom(store: DocumentStore, direction: "forward" | "backward"): void {
  const ctx = scope(store);
  if (!ctx) return;
  const session = useSession.getState();
  const at = session.playheadMs;
  const anchor = session.selectedClipIds[0];
  const anchorTrack = anchor ? locateClip(ctx.doc, anchor)?.track.id : undefined;

  const hits: string[] = [];
  for (const track of ctx.doc.tracks) {
    if (anchorTrack && track.id !== anchorTrack) continue;
    for (const clip of track.clips) {
      if (clip.frameId !== ctx.compId || isClipLocked(track, clip)) continue;
      // Forward takes anything still running at the playhead or starting after
      // it; backward takes anything already finished or still running. A clip
      // UNDER the playhead belongs to both, which is what makes the two
      // gestures partition the timeline at the point you are looking at.
      const takes = direction === "forward" ? clipEnd(clip) > at : clip.startMs < at;
      if (takes) hits.push(clip.id);
    }
  }
  if (hits.length === 0) {
    toast(`Nothing ${direction === "forward" ? "after" : "before"} the playhead`);
    return;
  }
  session.select(hits);
}

/**
 * Delete the selection AND close what it leaves behind — Premiere's ⇧⌫.
 *
 * The other half of the gap work: plain Delete leaves the hole (which is right
 * — sometimes the hole is the point), and this is for when it isn't. Re-packs
 * each affected lane rather than shifting by the deleted span, because a
 * multi-clip delete across several tracks has no single span, and because
 * `closeAllGaps` already knows to stop at a locked clip.
 */
export function rippleDeleteSelection(store: DocumentStore): void {
  const ctx = scope(store);
  const ids = useSession.getState().selectedClipIds;
  if (!ctx || ids.length === 0) return;
  const lanes = new Set<string>();
  for (const id of ids) {
    const loc = locateClip(ctx.doc, id);
    if (loc) lanes.add(loc.track.id);
  }
  deleteSelectedClips(store);
  store.update("Ripple delete", (d) => {
    for (const trackId of lanes) closeAllGaps(d, trackId, ctx.compId);
  });
}

/** Move every selected clip by one frame. The keyboard twin of a drag. */
export function nudgeSelection(store: DocumentStore, direction: -1 | 1): void {
  const ctx = scope(store);
  const ids = useSession.getState().selectedClipIds;
  if (!ctx || ids.length === 0) return;
  const step = frameStepMs(compFps(ctx.doc, ctx.compId)) * direction;
  store.update(
    direction < 0 ? "Nudge left" : "Nudge right",
    (d) => {
      for (const id of ids) {
        const loc = locateClip(d, id);
        if (loc) moveClip(d, id, Math.max(0, loc.clip.startMs + step));
      }
    },
    // One undo step per burst of taps, like a drag — holding the key to walk a
    // clip across the timeline should not fill the history with single frames.
    { mergeKey: `nudge-${ids.join(",")}` },
  );
}

/** Freeze the frame under the playhead on every selected source-backed clip. */
export function freezeSelectionAtPlayhead(store: DocumentStore): void {
  const ids = useSession.getState().selectedClipIds;
  const doc = store.getState();
  const targets = ids
    .map((id) => locateClip(doc, id)?.clip)
    .filter((c): c is Clip => !!c && !!clipPlaybackOf(c) && c.kind !== "audio");
  if (targets.length === 0) {
    toast("Select a video or nested clip to freeze");
    return;
  }
  const playhead = useSession.getState().playheadMs;
  store.update("Freeze frame", (d) => {
    for (const target of targets) {
      const clip = locateClip(d, target.id)?.clip;
      if (!clip) continue;
      const local = Math.max(0, Math.min(clip.durationMs, playhead - clip.startMs));
      const rate = speedAt(clip, local) || 1;
      for (const k of freezeKeys(local, 1000, rate)) {
        setKeyframe(clip.keyframes, SPEED_PROPERTY, k.timeMs, k.value, k.easing);
      }
    }
  });
  toast("Frozen — drag the hatched block on the clip to retime the hold");
}

/**
 * Walk the playhead to the selection's next/previous keyframe.
 *
 * ACROSS every animated property of every selected clip, because "the next
 * thing that happens" is what a person means — not "the next key on whichever
 * track the inspector happens to be showing". The same rule the section arrows
 * use, one level up.
 */
export function jumpKeyframe(store: DocumentStore, direction: "prev" | "next"): void {
  const doc = store.getState();
  const session = useSession.getState();
  const now = session.playheadMs;
  let best: number | null = null;
  for (const id of session.selectedClipIds) {
    const clip = locateClip(doc, id)?.clip;
    if (!clip) continue;
    const local = Math.max(0, Math.min(clip.durationMs, now - clip.startMs));
    for (const track of clip.keyframes) {
      const k = adjacentKeyframe(clip.keyframes, local, direction, track.property);
      if (!k) continue;
      const abs = clip.startMs + k.timeMs;
      if (direction === "next" ? abs <= now + 0.5 : abs >= now - 0.5) continue;
      if (best === null || (direction === "next" ? abs < best : abs > best)) best = abs;
    }
  }
  if (best === null) {
    toast(direction === "next" ? "No keyframe after here" : "No keyframe before here");
    return;
  }
  session.setPlaying(false);
  session.setPlayhead(best);
}

/** The time axis, from the keyboard. Zooms about the CENTRE of the view. */
export function zoomTimeline(store: DocumentStore, factor: number): void {
  const ctx = scope(store);
  if (!ctx) return;
  const width = timelineViewport.el?.clientWidth ?? 800;
  timelineView.zoom(width / 2, factor, { startMs: 0, endMs: timelineSpanMs(ctx.doc, ctx.compId) });
}

/** Fit the whole cut. `focusRange` bails when the range is already visible, so
 *  this asks for the fit directly rather than going through it. */
export function fitTimeline(store: DocumentStore): void {
  const ctx = scope(store);
  if (!ctx) return;
  const width = timelineViewport.el?.clientWidth ?? 800;
  const span = Math.max(1, timelineSpanMs(ctx.doc, ctx.compId));
  const px = ((width - 48) / span) * 1000;
  useSession.getState().setPxPerSec(px);
  timelineView.panBy(-1e9);
}
