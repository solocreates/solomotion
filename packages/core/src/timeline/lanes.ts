import type { MotionDocument, Clip, Track } from "../schema";
import { createCarrierTrack } from "../factories";
import { addClipToTrack, cleanupEmptyTracks, clipEnd, removeClipFromTrack, sortTrackClips } from "./ops";
import { frameLanes, isCompLane } from "./layer-tree";
import { scopeEdgeIndex } from "./groups";

/**
 * LANES AS A QUESTION ABOUT TIME — which rows of a comp a clip may sit on.
 *
 * A lane's only meaning for the picture is its z against the clips it shares an
 * instant with. Two clips that never play at once never meet on screen, so
 * their lanes say nothing to each other — and that is the whole room this
 * module works in: a clip may sit on ANY lane that keeps it above what it must
 * be above and below what it must be below while it plays, and when one of
 * those lanes already exists, growing another is sprawl.
 *
 * Three readers share the rule, so they cannot disagree about what "the same
 * z" means: placement's `settle` landing (a birth that reuses the stack), the
 * API's time edits (a neighbour in the way changes a clip's lane, never the
 * time it was asked for), and `compactLanes` (the explicit tidy-up).
 */

/** The time a clip occupies (or would), in its comp. */
export interface LaneSpan {
  frameId: string;
  startMs: number;
  durationMs: number;
  /** The clip being moved — never its own obstacle. */
  id?: string | null;
}

/**
 * A lane a RULE may put a clip on: one that changes nothing about the clip but
 * its z. Locked refuses edits, hidden hides what lands, muted silences it, and a
 * looping lane repeats its content span — landing on any of those changes the
 * clip, so they are only ever aimed at by hand.
 */
export function isPlainLane(track: Track): boolean {
  return !track.locked && !track.hidden && !track.muted && track.loop === "none";
}

/** `doc.tracks` indices of the comp's lanes in one scope (null = its top level), top first. */
export function compLaneIndices(doc: MotionDocument, frameId: string, scope: string | null): number[] {
  const out: number[] = [];
  doc.tracks.forEach((t, i) => {
    if ((t.groupId ?? null) !== scope) return;
    if (scope === null && !isCompLane(t, frameId)) return;
    out.push(i);
  });
  return out;
}

/** The clip on `track` that shares an instant with the span, if any. */
export function laneBlocker(track: Track, span: LaneSpan): Clip | null {
  const end = span.startMs + span.durationMs;
  for (const c of track.clips) {
    if (c.id === span.id || c.frameId !== span.frameId) continue;
    if (span.startMs < clipEnd(c) && end > c.startMs) return c;
  }
  return null;
}

/**
 * THE SETTLED LANE for a new clip: directly above the topmost lane with
 * anything on screen during its span — so it is born on top of all of it, the
 * promise a birth makes — and otherwise as LOW as that allows, on a lane the
 * comp already has. Every lane above the topmost busy one is free by
 * construction; the lowest plain one of them is the answer. `mintAt` (a
 * `doc.tracks` index) when none is.
 */
export function settleLane(
  doc: MotionDocument,
  span: LaneSpan,
  scope: string | null,
): { track: Track } | { mintAt: number } {
  const lanes = compLaneIndices(doc, span.frameId, scope);
  const busy = lanes.findIndex((i) => laneBlocker(doc.tracks[i]!, span));
  const free = busy === -1 ? lanes : lanes.slice(0, busy);
  for (let k = free.length - 1; k >= 0; k--) {
    const track = doc.tracks[free[k]!]!;
    if (isPlainLane(track)) return { track };
  }
  if (busy !== -1) return { mintAt: lanes[busy]! };
  return { mintAt: lanes.length ? lanes[lanes.length - 1]! + 1 : scopeEdgeIndex(doc, scope, "top") };
}

/**
 * The comp's next lane directly above or below `trackIndex` in its scope, when
 * it can take the span. That lane IS the z of a fresh lane spliced in between:
 * nothing on it plays during the span, so the clip's order is decided against
 * the lanes on either side exactly as it would be on a new one. Null when it
 * cannot take it — mint instead.
 */
export function laneBeside(
  doc: MotionDocument,
  trackIndex: number,
  side: "above" | "below",
  span: LaneSpan,
): Track | null {
  const lanes = compLaneIndices(doc, span.frameId, doc.tracks[trackIndex]?.groupId ?? null);
  const at = side === "above" ? lanes.filter((i) => i < trackIndex).pop() : lanes.find((i) => i > trackIndex);
  if (at === undefined) return null;
  const track = doc.tracks[at]!;
  return isPlainLane(track) && !laneBlocker(track, span) ? track : null;
}

/**
 * Where a clip goes when its own lane cannot hold it for `span`: just above that
 * lane — the neighbour beside it when it is free then, else a fresh lane. It is
 * the z a drop onto a busy lane gets (`placeClip`'s preferred-lane rule): the
 * clip passes over whatever blocked it and keeps its order against everything
 * else. Returns the lane to move it to.
 */
export function laneAboveFor(doc: MotionDocument, trackIndex: number, span: LaneSpan): Track {
  const beside = laneBeside(doc, trackIndex, "above", span);
  if (beside) return beside;
  const carrier = createCarrierTrack(undefined, span.frameId, doc.tracks[trackIndex]?.groupId ?? null);
  doc.tracks.splice(trackIndex, 0, carrier);
  return carrier;
}

/**
 * Each lane's number as the comp's timeline shows it — 0 is the top row of its
 * scope (the comp's top level, or one group's rows). Keyed by track id.
 */
export function laneNumbers(doc: MotionDocument, frameId: string): Map<string, number> {
  const next = new Map<string | null, number>();
  const out = new Map<string, number>();
  for (const row of frameLanes(doc, frameId)) {
    const scope = row.scope?.id ?? null;
    const n = next.get(scope) ?? 0;
    out.set(row.track.id, n);
    next.set(scope, n + 1);
  }
  return out;
}

export interface CompactResult {
  /** The comp's lanes (every scope) before and after. */
  lanesBefore: number;
  lanesAfter: number;
  /** Clips that changed lane. */
  moved: number;
}

/**
 * COMPACT a comp's lanes: every clip falls as low as it can without passing
 * under anything it overlaps and was above, then the lanes left empty go.
 *
 * Gravity, bottom lane first. A clip lands one level above the highest clip
 * already settled that shares an instant with it — everything settled so far
 * came from a lower lane, so that is exactly "keep every overlapping pair in
 * order" and nothing more. Clips never rise, so the picture at every instant is
 * the picture it was: the same clips, in the same order.
 *
 * What does not move: a clip on a lane that is not plain (locked, hidden,
 * muted, looping) — those lanes are BARRIERS, and clips on either side are
 * packed separately so nothing crosses one. Clips joined by a transition move
 * together, carrying it, because a transition lives on the lane of the cut it
 * spans. Each group's rows pack among themselves; a group's bar packs with its
 * siblings. Another comp's clips sharing a lane are left where they are.
 */
export function compactLanes(doc: MotionDocument, frameId: string): CompactResult {
  const lanesBefore = frameLanes(doc, frameId).length;
  let moved = 0;
  const scopes: Array<string | null> = [null];
  for (const t of doc.tracks) {
    for (const c of t.clips) if (c.kind === "group" && c.frameId === frameId) scopes.push(c.id);
  }
  for (const scope of scopes) {
    let segment: Track[] = [];
    for (const i of compLaneIndices(doc, frameId, scope)) {
      const track = doc.tracks[i]!;
      if (isPlainLane(track)) segment.push(track);
      else {
        moved += packSegment(frameId, segment);
        segment = [];
      }
    }
    moved += packSegment(frameId, segment);
  }
  // `removeClipFromTrack` homed every lane it emptied to this comp, so the one
  // tidy-up sweep takes those together with the empties that were already here.
  cleanupEmptyTracks(doc, frameId);
  return { lanesBefore, lanesAfter: frameLanes(doc, frameId).length, moved };
}

/** Pack one run of plain lanes (top first) by gravity. Returns clips moved. */
function packSegment(frameId: string, lanes: Track[]): number {
  if (lanes.length < 2) return 0;
  interface Unit { clips: Clip[]; from: Track; start: number; end: number; level: number }
  const settled: Unit[] = [];
  for (let k = lanes.length - 1; k >= 0; k--) {
    const from = lanes[k]!;
    for (const clips of cutUnits(from, frameId)) {
      const start = Math.min(...clips.map((c) => c.startMs));
      const end = Math.max(...clips.map(clipEnd));
      let level = 0;
      for (const u of settled) {
        if (u.from !== from && start < u.end && end > u.start) level = Math.max(level, u.level + 1);
      }
      settled.push({ clips, from, start, end, level });
    }
  }
  let moved = 0;
  const touched = new Set<Track>();
  for (const u of settled) {
    const to = lanes[lanes.length - 1 - u.level]!;
    if (to === u.from) continue;
    const ids = new Set(u.clips.map((c) => c.id));
    for (const clip of u.clips) {
      removeClipFromTrack(u.from, u.from.clips.indexOf(clip));
      addClipToTrack(to, clip);
      moved++;
    }
    const carried = u.from.transitions.filter((tr) => (tr.aClipId && ids.has(tr.aClipId)) || (tr.bClipId && ids.has(tr.bClipId)));
    if (carried.length) {
      u.from.transitions = u.from.transitions.filter((tr) => !carried.includes(tr));
      to.transitions.push(...carried);
    }
    touched.add(to);
  }
  for (const t of touched) sortTrackClips(t);
  return moved;
}

/** One lane's clips of a comp, grouped so clips a transition joins stay together. */
function cutUnits(track: Track, frameId: string): Clip[][] {
  const mine = track.clips.filter((c) => c.frameId === frameId);
  const unitOf = new Map<string, Clip[]>(mine.map((c) => [c.id, [c]]));
  for (const tr of track.transitions) {
    if (tr.frameId !== frameId || !tr.aClipId || !tr.bClipId) continue;
    const a = unitOf.get(tr.aClipId);
    const b = unitOf.get(tr.bClipId);
    if (!a || !b || a === b) continue;
    a.push(...b);
    for (const c of b) unitOf.set(c.id, a);
  }
  return [...new Set(unitOf.values())];
}
