import { clipEnd, moveClip } from "./ops";
import { clipsUnderGroup } from "./groups";
import type { MotionDocument, Clip, Track } from "../schema";

/**
 * GAPS — the empty stretch between two clips, as a thing you can point at.
 *
 * A gap is not stored anywhere and must never be: it is the space two clips
 * leave, so the only honest way to have one is to derive it from the pair. The
 * alternative — a "gap clip" — is the classic version of this mistake, and it
 * goes wrong the first time anything moves, because then there are two records
 * of one fact and a drag updates only one of them.
 *
 * Which makes gaps a pure reading of the track, and closing one a pure shift.
 * Every NLE has this pair of verbs (Premiere: click the gap, Delete; Resolve:
 * Delete Gap; Final Cut: Close Gap) and they all mean the same thing — take the
 * hole out and let what follows fall back into it.
 *
 * TRACK-LOCAL, deliberately, like all three of those. A gap is a fact about one
 * lane; closing it on every lane at once is a different (and much more
 * destructive) edit, and no editor gives it the Delete key.
 */
export interface TimelineGap {
  trackId: string;
  frameId: string;
  startMs: number;
  endMs: number;
  /** The clip that falls back when the gap closes — the one after it. */
  nextClipId: string;
}

function locateTrack(doc: MotionDocument, trackId: string): Track | undefined {
  return doc.tracks.find((t) => t.id === trackId);
}

/** The clips of one comp on one track, in time order. */
function laneClips(track: Track, frameId: string): Clip[] {
  return track.clips
    .filter((c) => c.frameId === frameId)
    .slice()
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * Every hole on a lane, in order.
 *
 * The lane's HEAD counts — the stretch from 0 to the first clip is a gap in
 * exactly the sense that matters (close it and everything slides to the start),
 * and it is the one people most often want gone. The tail does not: there is
 * nothing after it to pull back, so there is no edit to offer.
 */
export function trackGaps(doc: MotionDocument, trackId: string, frameId: string): TimelineGap[] {
  const track = locateTrack(doc, trackId);
  if (!track) return [];
  const clips = laneClips(track, frameId);
  const gaps: TimelineGap[] = [];
  let cursor = 0;
  for (const clip of clips) {
    if (clip.startMs - cursor > 1) {
      gaps.push({ trackId, frameId, startMs: cursor, endMs: clip.startMs, nextClipId: clip.id });
    }
    cursor = Math.max(cursor, clipEnd(clip));
  }
  return gaps;
}

/** The gap under a time on a lane, if the point lands in one. */
export function gapAt(
  doc: MotionDocument,
  trackId: string,
  frameId: string,
  timeMs: number,
): TimelineGap | null {
  for (const gap of trackGaps(doc, trackId, frameId)) {
    if (timeMs >= gap.startMs && timeMs < gap.endMs) return gap;
  }
  return null;
}

/**
 * RIPPLE A LANE, THROUGH THE ONE MOVER.
 *
 * `moveClip` is what it means to move a clip in this document, and a clip is
 * not always just its own bar: a GROUP's bar is a handle on everything inside
 * it, at every depth, living on other lanes entirely (`carryGroupContents`); a
 * FILL clip is defined as "from my start to the comp end", so moving one
 * re-spans it (`reflowAfterMove`). Both of those facts live inside `moveClip`,
 * and both were lost the moment this file wrote `clip.startMs` itself — which
 * is exactly what closing a gap on a lane holding a group did: the bar slid
 * left and left its contents behind, tearing the group in half.
 *
 * So nothing here assigns a start time. It decides WHICH clips move and WHERE,
 * and `moveClip` decides what moving means. Left to right is load-bearing:
 * each clip lands in the space the one before it just vacated, so no move ever
 * has to pass through an occupied slot.
 *
 * `carried` is the guard for the degenerate case where a group's member shares
 * its bar's lane — the bar already brought it, and moving it again would
 * double the delta.
 */
function rippleLane(
  doc: MotionDocument,
  track: Track,
  frameId: string,
  /** Where each clip should end up, or null to leave it (and pin what follows). */
  targetOf: (clip: Clip, cursor: number) => number | null,
): boolean {
  const carried = new Set<string>();
  let cursor = 0;
  let moved = false;
  for (const clip of laneClips(track, frameId)) {
    if (carried.has(clip.id)) continue;
    const target = clip.locked ? null : targetOf(clip, cursor);
    if (target !== null && Math.abs(target - clip.startMs) > 0.5) {
      if (clip.kind === "group") for (const id of clipsUnderGroup(doc, clip.id)) carried.add(id);
      if (moveClip(doc, clip.id, target)) moved = true;
    }
    cursor = Math.max(cursor, clipEnd(clip));
  }
  return moved;
}

/**
 * Close a gap: everything on the lane from the gap's end onwards moves back by
 * its length. Locked clips pin the lane — a ripple that slid a locked clip
 * would be the lock not meaning anything — so the edit refuses rather than
 * half-doing it.
 *
 * Mutates; returns whether anything moved.
 */
export function closeGap(doc: MotionDocument, gap: TimelineGap): boolean {
  const track = locateTrack(doc, gap.trackId);
  if (!track || track.locked) return false;
  const delta = gap.endMs - gap.startMs;
  if (delta <= 0) return false;
  const following = laneClips(track, gap.frameId).filter((c) => c.startMs >= gap.endMs - 0.5);
  if (following.length === 0) return false;
  if (following.some((c) => c.locked)) return false;
  return rippleLane(doc, track, gap.frameId, (clip) =>
    clip.startMs >= gap.endMs - 0.5 ? Math.max(0, clip.startMs - delta) : null,
  );
}

/**
 * Close every gap on a lane in one pass — "ripple the whole track up".
 *
 * A re-pack rather than repeated `closeGap` calls: each close invalidates the
 * next gap's times, and a loop over a stale list is how that kind of function
 * ends up off by one hole. A locked clip pins everything after it.
 */
export function closeAllGaps(doc: MotionDocument, trackId: string, frameId: string): boolean {
  const track = locateTrack(doc, trackId);
  if (!track || track.locked) return false;
  return rippleLane(doc, track, frameId, (clip, cursor) =>
    clip.startMs > cursor + 0.5 ? cursor : null,
  );
}
