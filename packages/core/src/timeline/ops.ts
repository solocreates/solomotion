import { current, isDraft, original } from "immer";
import { frameContentEndMs, nestedClipsShowing } from "./frame-index";
import { isSettledDocument, storedDocumentOf } from "./settled";
import { commandsToSubpaths, shapeCommands, subpathBounds, type Bounds } from "../vector/geometry";
import { createCarrierTrack, createFrame, createNestedClip } from "../factories";
import { internalPageId, isInternalPage } from "../pages";
import { createId } from "../ids";
import { toSubpath } from "../vector/contour-id";
import { frameFps, frameStepMs, normalizeFps } from "./fps";
import { resolveNumber } from "../variables";
import { measuredTextBox } from "../text/measure";
import { loopSpanMs, parentTimeAt, sourcePhaseAt, type SourcePhase } from "../animation/evaluate";
import { clipSpeedCurve, wallTimeForSourceMs } from "../animation/retime";
import { clipPlaybackOf } from "../clip-registry";
import { normalizeCues, scaleCueTimes, shiftCueTimes } from "../captions";
import { anchorLocal, basisOfTransform, cropWindow, mapLinear, type LayerBox } from "../transform-map";
import { keepPivotThroughBoxChange, pathBox } from "../pivot";
import { sampleKeyframeTrack } from "../animation/keyframes";
import type { Clip, Easing, Frame, Keyframe, KeyframeTrack, PathClip, ShapeClip, Track, Transform, MotionDocument } from "../schema";
import { TRACE_PEN_BOX } from "../schema/trace";
import { clipsUnderGroup, expandToDescendants, groupAncestry, moveClipsToScope, pruneGroups, scopeEdgeIndex, tracksInGroup } from "./groups";
import { groupEdgeFollowers } from "./group-time";
import { reassignTransitionTail } from "./transitions";
import { layoutBoxOf } from "../relations/layout";
import { detachTextsFromHost } from "../relations/text-path";

/**
 * Timeline operations. These mutate the document directly and are designed to
 * be called inside a document-store update (immer draft), so every operation
 * automatically becomes an undoable patch.
 */

/**
 * Deep-clone a clip. Ops run inside immer producers, where clips are Proxy
 * drafts that structuredClone cannot serialize — unwrap with `current` first.
 */
export function cloneClip(clip: Clip): Clip {
  return structuredClone(isDraft(clip) ? (current(clip) as Clip) : clip) as Clip;
}

/** The prefix of a clip id (`group` of `group_ab12`), `clip` when it has none. */
function clipIdPrefix(id: string): string {
  const at = id.indexOf("_");
  return at > 0 ? id.slice(0, at) : "clip";
}

/** A deep clone of a clip with every nested id re-issued (ranges, cues, keyframes). */
export function reissueClipIds(clip: Clip): Clip {
  const copy = cloneClip(clip);
  // A copy keeps its source's id PREFIX: a group is `group_…`, a clip `clip_…`.
  // Minting every copy as `clip_` made a duplicated group read as a layer to
  // anything that asks the id what it is.
  copy.id = createId(clipIdPrefix(clip.id));
  if (copy.kind === "text") {
    for (const r of copy.ranges) r.id = createId("range");
    if (copy.caption) for (const c of copy.caption.cues) c.id = createId("cue");
  }
  for (const t of copy.keyframes) {
    t.id = createId("ktrack");
    for (const k of t.keys) k.id = createId("key");
  }
  // Fill/stroke entries are id-addressed by keyframes; re-issue the ENTRY ids
  // (and re-point their keyframe tracks) so a duplicated vector never shares
  // paint ids with its source. Gradient stop ids stay put — they're only ever
  // unique WITHIN a paint, which the 1:1 copy already preserves.
  if (copy.kind === "shape" || copy.kind === "path") {
    const remap = new Map<string, string>();
    for (const f of copy.fills) {
      const nid = createId("paint");
      remap.set(f.id, nid);
      f.id = nid;
    }
    for (const s of copy.strokes) {
      const nid = createId("stroke");
      remap.set(s.id, nid);
      s.id = nid;
    }
    for (const t of copy.keyframes) {
      const [head, id, ...rest] = t.property.split(".");
      const next = id ? remap.get(id) : undefined;
      if (next) t.property = [head, next, ...rest].join(".");
    }
  }
  return copy;
}

export interface ClipLocation {
  track: Track;
  trackIndex: number;
  clip: Clip;
  clipIndex: number;
}

export function locateClip(doc: MotionDocument, clipId: string): ClipLocation | null {
  for (let t = 0; t < doc.tracks.length; t++) {
    const track = doc.tracks[t]!;
    for (let c = 0; c < track.clips.length; c++) {
      if (track.clips[c]!.id === clipId) {
        return { track, trackIndex: t, clip: track.clips[c]!, clipIndex: c };
      }
    }
  }
  return null;
}

/**
 * A clip is locked if either it or its track is locked — the two are
 * independent flags (track lock affects every clip on it; clip lock is
 * per-layer) but every call site cares about the combined result, so this is
 * the one place that ORs them together.
 */
export function isClipLocked(track: Track, clip: Clip): boolean {
  return track.locked || clip.locked;
}

/** Same OR-with-track relationship as `isClipLocked`, for visibility. */
export function isClipHidden(track: Track, clip: Clip): boolean {
  return track.hidden || clip.hidden;
}

export function clipEnd(clip: Clip): number {
  return clip.startMs + clip.durationMs;
}

export function sortTrackClips(track: Track): void {
  track.clips.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Remove a clip from a track. THE one place any ordinary edit (move, drag
 * past an edge, overwrite/carve, delete, restack) permanently takes a clip
 * off a track — never a raw `.splice()` at the call site. If this empties the
 * track, it's homed to the departing clip's comp so it stays visible in that
 * SAME timeline (never vanishes, and never leaks into an unrelated comp) —
 * tracks are otherwise never auto-deleted; only an explicit "Delete track"
 * removes one.
 */
export function removeClipFromTrack(track: Track, clipIndex: number): Clip | undefined {
  const [removed] = track.clips.splice(clipIndex, 1);
  if (removed && track.clips.length === 0) track.homeCompId = removed.frameId;
  return removed;
}

/**
 * THE one place any edit ADDS a clip to a track — the symmetric partner of
 * {@link removeClipFromTrack}. Besides the insert it handles LANE ADOPTION: when
 * a clip lands on an auto-spawned lane that already holds one, the user has made
 * it a real multi-clip lane, so its `auto` flag is cleared and it will never be
 * auto-pruned. `index` splices at a position (splits); omitted appends. Callers
 * still `sortTrackClips` when order matters.
 */
export function addClipToTrack(track: Track, clip: Clip, index?: number): void {
  if (track.auto && track.clips.length > 0) track.auto = false; // adopted
  if (index === undefined) track.clips.push(clip);
  else track.clips.splice(index, 0, clip);
}

/**
 * Auto-clean an EMPTIED track (opt-in — the "zombie track" feature). Removes the
 * one track `trackId` iff it's now empty, is an AUTO carrier (spawned to hold a
 * single clip), and isn't the document's last track. Deliberately TARGETED:
 * callers pass only a track a clip just LEFT, and only auto lanes qualify — a
 * lane the user made ("+ Track", the defaults) or adopted (a 2nd clip landed)
 * is `auto:false` and survives, so an ordinary edit never eats a real lane.
 * Returns true if a track was removed.
 */
export function pruneTrackIfEmptied(doc: MotionDocument, trackId: string): boolean {
  if (doc.tracks.length <= 1) return false;
  const i = doc.tracks.findIndex((t) => t.id === trackId);
  const track = doc.tracks[i];
  if (!track || !track.auto || track.clips.length > 0) return false;
  doc.tracks.splice(i, 1);
  return true;
}

/** Prune every candidate track (tracks clips just left) that is now empty. */
export function pruneEmptiedTracks(doc: MotionDocument, trackIds: Iterable<string>): void {
  for (const id of new Set(trackIds)) pruneTrackIfEmptied(doc, id);
}

/**
 * An empty lane THIS COMP is showing — the subject of the tidy-up sweep below.
 *
 * "Empty" has to be asked per comp, not per document: tracks are global and one
 * lane can carry clips from several comps, so a lane that is blank in the comp
 * you are looking at may be carrying a clip in another and must never be swept
 * from here. The lane must hold nothing at all AND belong to this comp — which
 * is `homeCompId`, the same field `frameLanes` consults to decide the row is
 * yours to see in the first place. Two readers, one rule.
 */
function isEmptyLaneOf(track: Track, frameId: string): boolean {
  return track.clips.length === 0 && track.homeCompId === frameId;
}

/** How many lanes {@link cleanupEmptyTracks} would remove — the button's badge. */
export function emptyTrackCount(doc: MotionDocument, frameId: string): number {
  const empties = doc.tracks.filter((t) => isEmptyLaneOf(t, frameId));
  return Math.max(0, Math.min(empties.length, doc.tracks.length - 1));
}

/**
 * TIDY UP — remove every empty lane this comp is showing, in one explicit move.
 *
 * The automatic prune (`pruneTrackIfEmptied`) is deliberately timid: it only
 * ever touches an AUTO carrier a clip just left, because an ordinary edit must
 * never eat a lane somebody made. That is the right default and it leaves a
 * real residue — lanes you added and emptied, lanes left by an undo, lanes a
 * deleted group left behind — which accumulate until the timeline is mostly
 * blank rows.
 *
 * So this is the OTHER half of the same rule, and the difference between them
 * is consent: the sweep is something the user asks for by name, so it may take
 * lanes the automatic prune never would. It still cannot take a lane that holds
 * anything, cannot take another comp's lanes, and always leaves the document at
 * least one track to stand on.
 *
 * Returns how many it removed, so the caller can say so instead of guessing.
 */
export function cleanupEmptyTracks(doc: MotionDocument, frameId: string): number {
  const kept: Track[] = [];
  let removed = 0;
  for (const track of doc.tracks) {
    if (isEmptyLaneOf(track, frameId)) {
      removed++;
      continue;
    }
    kept.push(track);
  }
  if (kept.length === 0) {
    // Never leave a document with no lane at all: keep the first one we took.
    const first = doc.tracks.find((t) => isEmptyLaneOf(t, frameId));
    if (first) {
      kept.push(first);
      removed--;
    }
  }
  doc.tracks = kept;
  return removed;
}

/**
 * Clamp a proposed start so the clip stays ≥ 0 and never overlaps its track
 * neighbors (NLE behavior: clips push up against each other, never stack).
 * Only clips of the SAME comp collide — a track can carry several comps'
 * clips, and each comp's timeline lane only shows its own.
 */
export function clampStartInTrack(
  track: Track,
  clipId: string,
  proposedStartMs: number,
  durationMs: number,
  frameId?: string,
): number {
  let lo = 0;
  let hi = Number.POSITIVE_INFINITY;
  // Neighbors are decided by which side of the proposed midpoint they sit on.
  const mid = proposedStartMs + durationMs / 2;
  for (const other of track.clips) {
    if (other.id === clipId) continue;
    if (frameId !== undefined && other.frameId !== frameId) continue;
    const otherMid = other.startMs + other.durationMs / 2;
    if (otherMid <= mid) lo = Math.max(lo, clipEnd(other));
    else hi = Math.min(hi, other.startMs - durationMs);
  }
  return Math.max(lo, Math.min(proposedStartMs, hi < lo ? lo : hi));
}

/**
 * Whether a clip of [startMs, startMs+durationMs) fits in a track without
 * overlapping same-comp neighbors.
 */
export function fitsInTrack(
  track: Track,
  clipId: string | null,
  startMs: number,
  durationMs: number,
  frameId?: string,
): boolean {
  const end = startMs + durationMs;
  if (startMs < 0) return false;
  for (const other of track.clips) {
    if (clipId !== null && other.id === clipId) continue;
    if (frameId !== undefined && other.frameId !== frameId) continue;
    if (startMs < clipEnd(other) && end > other.startMs) return false;
  }
  return true;
}

/** Move a clip in time and optionally to another track of the same kind. */
export function moveClip(
  doc: MotionDocument,
  clipId: string,
  newStartMs: number,
  targetTrackId?: string,
): boolean {
  const loc = locateClip(doc, clipId);
  if (!loc || isClipLocked(loc.track, loc.clip)) return false;
  const before = loc.clip.startMs;

  const target = targetTrackId ? doc.tracks.find((t) => t.id === targetTrackId) : loc.track;
  if (!target || target.locked) return false;

  if (target.id !== loc.track.id) {
    if (!fitsInTrack(target, null, Math.max(0, newStartMs), loc.clip.durationMs, loc.clip.frameId)) {
      return false;
    }
    removeClipFromTrack(loc.track, loc.clipIndex);
    loc.clip.startMs = Math.max(0, newStartMs);
    addClipToTrack(target, loc.clip);
    sortTrackClips(target);
  } else {
    loc.clip.startMs = clampStartInTrack(
      target,
      clipId,
      Math.max(0, newStartMs),
      loc.clip.durationMs,
      loc.clip.frameId,
    );
    sortTrackClips(target);
  }
  carryGroupContents(doc, loc.clip, loc.clip.startMs - before);
  reflowAfterMove(doc, loc.clip);
  return true;
}

/**
 * A GROUP moves as one thing: its bar is what you dragged, and everything
 * inside travels by the same delta — at every depth, relative timing intact.
 * Handled here rather than in the timeline's drag loop so a keyboard nudge, a
 * typed start time and a ripple all agree, and so the members' own start
 * times keep saying when they actually play. Its rows never move: a group's
 * lane is its own business and its rows are theirs.
 */
function carryGroupContents(doc: MotionDocument, clip: Clip, deltaMs: number): void {
  if (clip.kind !== "group" || deltaMs === 0) return;
  const inside = new Set(clipsUnderGroup(doc, clip.id));
  for (const track of doc.tracks) {
    let touched = false;
    for (const c of track.clips) {
      if (!inside.has(c.id)) continue;
      c.startMs = Math.max(0, c.startMs + deltaMs);
      touched = true;
    }
    if (touched) sortTrackClips(track);
  }
}

/**
 * A FILL clip is defined as "from my start to the comp end" (see
 * `fillDuration`), so moving one has to re-span it — otherwise the move quietly
 * makes the field a lie: the clip keeps the length it had at its old start and
 * either overshoots the comp or stops short of it, while the Timing panel still
 * reads Fill = on and greys the Duration field that would let you correct it.
 *
 * Moving is not trimming: it does NOT lock tracking off. Dragging a full-comp
 * grade a second to the right should still be a grade that ends with the comp;
 * only an explicit length edit (`trimClip`) means "I want this length".
 */
function reflowAfterMove(doc: MotionDocument, clip: Clip): void {
  if (clip.fillDuration) reconcileFillClips(doc, clip.frameId);
}

/**
 * Insert a fresh, empty carrier track at the very top or bottom of a SCOPE —
 * the comp's stack when `groupId` is null, a group's rows otherwise — and
 * return it. THE one primitive behind "drag past the first/last row spawns a
 * track" — shared by moving an existing clip (`moveClipsToNewLanes`) and
 * dropping fresh media there (`placeClip`'s `newLaneEdge`), so both gestures
 * create the placeholder track exactly the same way.
 */
export function insertTrackAtEdge(
  doc: MotionDocument,
  edge: "top" | "bottom",
  homeCompId?: string | null,
  groupId: string | null = null,
): Track {
  const carrier = createCarrierTrack(undefined, homeCompId ?? null, groupId);
  doc.tracks.splice(scopeEdgeIndex(doc, groupId, edge), 0, carrier);
  return carrier;
}

/**
 * Move a clip onto a BRAND-NEW track at the very top or bottom of its scope —
 * what dragging a clip past the first/last row does. Time updates too; the
 * vacated source track is never deleted (only an explicit "Delete track"
 * does that) — if it's now empty, `removeClipFromTrack` homes it to this
 * clip's comp so it stays right where the user was working, not gone.
 */
export function moveClipToNewLane(
  doc: MotionDocument,
  clipId: string,
  newStartMs: number,
  edge: "top" | "bottom",
  groupId?: string | null,
): boolean {
  const loc = locateClip(doc, clipId);
  if (!loc || isClipLocked(loc.track, loc.clip)) return false;
  const scope = groupId === undefined ? loc.track.groupId : groupId;
  removeClipFromTrack(loc.track, loc.clipIndex);
  loc.clip.startMs = Math.max(0, Math.round(newStartMs));
  addClipToTrack(insertTrackAtEdge(doc, edge, loc.clip.frameId, scope), loc.clip);
  return true;
}

/**
 * The multi-clip generalization of `moveClipToNewLane`: move a whole SET (e.g. a
 * linked video + its audio, or any multi-selection) onto fresh tracks at the
 * top/bottom edge of a scope, spawning ONE new lane per distinct source row and
 * preserving the set's vertical arrangement (topmost source row → topmost new
 * lane). Clips that already share a source track land together on the same new
 * lane, so a push past the edge always creates exactly as many tracks as the
 * set needs — one, two, or more. Each clip keeps its own (already dragged)
 * start time. Returns the created track ids, empty if nothing moved.
 *
 * The scope is the caller's to name: pushing past the edge of a group's band
 * makes rows inside that group; pushing past the comp's edge makes lanes at
 * its top level. Omitted, the set stays in the scope it started in.
 */
export function moveClipsToNewLanes(
  doc: MotionDocument,
  moves: { clipId: string; startMs: number }[],
  edge: "top" | "bottom",
  groupId?: string | null,
): string[] {
  const stackOrder = new Map(doc.tracks.map((t, i) => [t.id, i] as const));
  const movers = moves
    .map((m) => ({ move: m, loc: locateClip(doc, m.clipId) }))
    .filter((x): x is { move: (typeof moves)[number]; loc: NonNullable<ReturnType<typeof locateClip>> } =>
      !!x.loc && !isClipLocked(x.loc.track, x.loc.clip),
    );
  if (movers.length === 0) return [];

  // Distinct source tracks, top→bottom — one new lane each, in the same order.
  const sourceTrackIds = [...new Set(movers.map((m) => m.loc.track.id))].sort(
    (a, b) => (stackOrder.get(a) ?? 0) - (stackOrder.get(b) ?? 0),
  );
  const frameId = movers[0]!.loc.clip.frameId;
  const scope = groupId === undefined ? movers[0]!.loc.track.groupId : groupId;
  const created: Track[] = sourceTrackIds.map(() => createCarrierTrack(undefined, frameId, scope));
  doc.tracks.splice(scopeEdgeIndex(doc, scope, edge), 0, ...created);
  const newLaneFor = new Map<string, Track>();
  sourceTrackIds.forEach((tid, i) => newLaneFor.set(tid, created[i]!));

  // Detach each clip from its source lane (re-locating: indices shift as clips
  // leave), then adopt it onto its row's fresh lane at its dragged start time.
  for (const { clipId, startMs } of moves) {
    const loc = locateClip(doc, clipId);
    if (!loc || isClipLocked(loc.track, loc.clip)) continue;
    const lane = newLaneFor.get(loc.track.id);
    if (!lane) continue;
    removeClipFromTrack(loc.track, loc.clipIndex);
    loc.clip.startMs = Math.max(0, Math.round(startMs));
    addClipToTrack(lane, loc.clip);
  }
  return created.map((t) => t.id);
}

/**
 * Carve the span [start,end) out of every same-frame clip in `track` except
 * the protected ones. A neighbor the span overlaps is trimmed at the head or
 * tail, SPLIT into two remnants when the span sits inside it, or removed when
 * fully covered (or left below the minimum duration). This is the "overwrite"
 * that lets a dragged clip push into — and eat — its neighbors when snapping
 * is off. Right/inner remnants re-base their keyframes and caption words.
 */
function carveOverlaps(
  track: Track,
  protect: Set<string>,
  start: number,
  end: number,
  frameId: string,
): void {
  const minDuration = 50;
  const added: Clip[] = [];
  for (let i = track.clips.length - 1; i >= 0; i--) {
    const other = track.clips[i]!;
    if (protect.has(other.id) || other.frameId !== frameId) continue;
    const oStart = other.startMs;
    const oEnd = clipEnd(other);
    if (oEnd <= start || oStart >= end) continue; // disjoint

    const coversLeft = start <= oStart;
    const coversRight = end >= oEnd;
    if (coversLeft && coversRight) {
      removeClipFromTrack(track, i); // fully eaten
      continue;
    }
    if (!coversLeft && !coversRight) {
      // Span sits inside → left remnant stays, a right remnant splits off.
      const right = cloneClip(other);
      right.id = createId("clip");
      const delta = end - oStart;
      right.startMs = end;
      right.durationMs = oEnd - end;
      shiftClipInternals(right, -delta);
      other.durationMs = start - oStart;
      added.push(right);
      continue;
    }
    if (coversLeft) {
      // Eat the head: push the in-point forward to the span end.
      const delta = end - oStart;
      other.startMs = end;
      other.durationMs = oEnd - end;
      shiftClipInternals(other, -delta);
    } else {
      // Eat the tail: pull the out-point back to the span start.
      other.durationMs = start - oStart;
    }
    if (other.durationMs < minDuration) removeClipFromTrack(track, i);
  }
  for (const c of added) addClipToTrack(track, c);
}

/**
 * Move a clip in time / across tracks like {@link moveClip}, but in OVERWRITE
 * mode: instead of resisting neighbors it pushes straight through them, and any
 * same-frame clip it lands over is trimmed, split, or eaten (NLE overwrite —
 * what dragging with snapping off does). `protect` names the other clips of a
 * multi-clip drag so movers never carve each other. Callers preview this by
 * rebuilding from a pre-drag baseline each frame, so a neighbor only stays
 * eaten once the clip is actually dropped over it.
 */
export function moveClipOverwrite(
  doc: MotionDocument,
  clipId: string,
  newStartMs: number,
  targetTrackId?: string,
  protect?: Iterable<string>,
): boolean {
  const loc = locateClip(doc, clipId);
  if (!loc || isClipLocked(loc.track, loc.clip)) return false;
  // A GROUP moves as one thing and does not EAT: overwrite is a rule about what
  // one clip does to the neighbours it lands on, and a container landing on a
  // clip has no single answer to that — it holds many, on many lanes. Delegating
  // keeps a group drag identical with snapping on and off, which is the only
  // behaviour a person can predict.
  //
  // This is also the bug behind "moving a group leaves its contents behind": a
  // plain drag is ALWAYS an overwrite drag (see `overwriteBaseline`), so the
  // group arm in `moveClip` was never reached from the timeline at all.
  if (loc.clip.kind === "group") return moveClip(doc, clipId, newStartMs, targetTrackId);
  const target = targetTrackId ? doc.tracks.find((t) => t.id === targetTrackId) : loc.track;
  if (!target || target.locked) return false;

  const start = Math.max(0, Math.round(newStartMs));
  const clip = loc.clip;
  if (target.id !== loc.track.id) {
    removeClipFromTrack(loc.track, loc.clipIndex);
    clip.startMs = start;
    addClipToTrack(target, clip);
  } else {
    clip.startMs = start;
  }
  const guard = new Set<string>(protect ?? []);
  guard.add(clipId);
  carveOverlaps(target, guard, start, start + clip.durationMs, clip.frameId);
  sortTrackClips(target);
  return true;
}

/**
 * Trim a clip edge. Keyframes and caption word timings are re-based when the
 * left edge moves.
 *
 * A GROUP trims through here like any clip — its span is a WINDOW over its rows
 * (`withinGroupWindow`), so the edge drag, a typed duration and a keyboard trim
 * all reveal or hide its contents — with one addition: the descendants whose own
 * edge was FLUSH with the group's are trimmed by the same delta, recursively
 * (`groupEdgeFollowers`). A group built around its contents shortens them
 * instead of hiding them, which is the whole reason it reads as a container.
 *
 * The followers are named BEFORE anything moves and each one then moves through
 * `moveClipEdge` — the same function, and the same limits, as the group's own
 * edge. That shape is deliberate: one pass, one mutation per clip, no clip
 * consulting a half-applied document, and nothing that can re-enter this
 * function and trim a group twice. The whole cascade is one store update, so it
 * is one undo step.
 */
export function trimClip(doc: MotionDocument, clipId: string, edge: "start" | "end", timeMs: number): boolean {
  const loc = locateClip(doc, clipId);
  if (!loc || isClipLocked(loc.track, loc.clip)) return false;
  const clip = loc.clip;
  // Asked of the document as authored, before the group's own edge moves —
  // afterwards "flush with the group" would mean flush with the NEW edge, which
  // is true of nothing and would carry no one.
  const followers = clip.kind === "group" ? groupEdgeFollowers(doc, clip, edge) : [];

  const delta = moveClipEdge(doc, loc, edge, timeMs);
  if (delta !== 0) {
    for (const id of followers) {
      const f = locateClip(doc, id);
      if (!f || isClipLocked(f.track, f.clip)) continue;
      const at = edge === "start" ? f.clip.startMs : clipEnd(f.clip);
      moveClipEdge(doc, f, edge, at + delta);
    }
  }
  return true;
}

/**
 * Move ONE clip's edge to `timeMs` and return the delta actually applied.
 *
 * Every limit here belongs to the clip itself: a floor on its span, the head of
 * its source media (extending back stops where the in-point hits source 0), and
 * the same-comp neighbours on its own lane, which a trim clamps against rather
 * than overlapping. A caller carrying several clips by one delta therefore does
 * not have to know what any of them is — a video follower keeps its in-point, a
 * nested follower reconciles its fill children, and a follower that would
 * collapse simply stops at its floor and, being no longer flush, is not carried
 * again.
 *
 * The return value is the delta, not a boolean, because that is what a cascade
 * needs: the group's edge may clamp short of where the pointer asked, and its
 * contents must follow the edge that actually moved.
 */
function moveClipEdge(
  doc: MotionDocument,
  loc: ClipLocation,
  edge: "start" | "end",
  timeMs: number,
): number {
  const clip = loc.clip;
  const minDuration = 50;
  const before = edge === "start" ? clip.startMs : clipEnd(clip);

  // A manual trim LOCKS a fill clip to its explicit value from now on.
  clip.fillDuration = false;

  if (edge === "start") {
    const maxStart = clipEnd(clip) - minDuration;
    let newStart = Math.min(Math.max(0, timeMs), maxStart);
    // Source-backed clips can't reveal media that doesn't exist: extending the
    // head stops where the in-point hits source 0 (trim out and back in
    // restores exactly, never slides).
    const playback = clipPlaybackOf(clip);
    if (playback && "trimInMs" in clip) {
      const speed = playback.speed > 0 ? playback.speed : 1;
      newStart = Math.max(newStart, clip.startMs - clip.trimInMs / speed);
    }
    // Don't cross the previous same-comp neighbor.
    for (const other of loc.track.clips) {
      if (other.id === clip.id || other.frameId !== clip.frameId) continue;
      if (clipEnd(other) <= clip.startMs + clip.durationMs && clipEnd(other) > newStart && other.startMs < clip.startMs) {
        newStart = clipEnd(other);
      }
    }
    const delta = newStart - clip.startMs;
    clip.startMs = newStart;
    clip.durationMs -= delta;
    // In-point + keyframes + words all re-base through the one head seam.
    rebaseClipHead(clip, delta);
  } else {
    let newEnd = Math.max(timeMs, clip.startMs + minDuration);
    for (const other of loc.track.clips) {
      if (other.id === clip.id || other.frameId !== clip.frameId) continue;
      if (other.startMs >= clipEnd(clip) - 1 && other.startMs < newEnd) {
        newEnd = other.startMs;
      }
    }
    clip.durationMs = newEnd - clip.startMs;
  }
  // Resizing a nested clip resizes its private source comp: its fill children
  // follow so the content always spans the (new) parent duration.
  if (clip.kind === "nested") reconcileFillClips(doc, clip.sourceFrameId);
  return (edge === "start" ? clip.startMs : clipEnd(clip)) - before;
}

/** Scale clip-relative timings (keyframes for EVERY kind, caption cues) —
 * retimes stretch the content, so its internal choreography stretches with it. */
function scaleClipInternals(clip: Clip, factor: number): void {
  if (factor === 1) return;
  for (const track of clip.keyframes) {
    // A scale about the clip's head keeps the sign: a key that sits before the
    // head stays that far before it, proportionally (see `shiftClipInternals`).
    for (const key of track.keys) key.timeMs *= factor;
  }
  if (clip.kind === "text" && clip.caption) scaleCueTimes(clip.caption.cues, factor);
}

/**
 * Retime a clip (the NLE-standard speed change): set the playback speed AND
 * rescale the clip's timeline footprint so it keeps covering the same source
 * span — 2× on a 5s clip yields 2.5s of timeline, accurately. Internal timings
 * (keyframes, caption cues) stretch with the content.
 *
 * Loop/ping-pong clips keep their footprint (cycles just run faster) — their
 * length is a user choice, not media-bound.
 *
 * `ripple` (DaVinci-style) shifts every later same-comp clip on the track by
 * the length delta so downstream edits stay attached; without it, a growing
 * clip clamps at its next neighbor instead of swallowing it.
 */
export function retimeClip(
  doc: MotionDocument,
  clipId: string,
  newSpeed: number,
  opts: { ripple?: boolean } = {},
): boolean {
  const loc = locateClip(doc, clipId);
  if (!loc || isClipLocked(loc.track, loc.clip)) return false;
  const clip = loc.clip;
  const playback = clipPlaybackOf(clip);
  if (!playback || !(newSpeed > 0)) return false;
  const oldSpeed = playback.speed > 0 ? playback.speed : 1;
  if (Math.abs(newSpeed - oldSpeed) < 1e-9) return false;
  playback.speed = newSpeed;
  if (playback.loop !== "none") return true;

  const factor = oldSpeed / newSpeed;
  const oldDuration = clip.durationMs;
  const oldEnd = clip.startMs + oldDuration;
  clip.durationMs = Math.max(50, Math.round(oldDuration * factor));
  clip.fillDuration = false;
  scaleClipInternals(clip, factor);

  const delta = clip.durationMs - oldDuration;
  if (opts.ripple && delta !== 0) {
    for (const other of loc.track.clips) {
      if (other.id === clip.id || other.frameId !== clip.frameId) continue;
      if (other.startMs >= oldEnd - 1) other.startMs = Math.max(0, other.startMs + delta);
    }
    sortTrackClips(loc.track);
  } else if (delta > 0) {
    // No ripple: a growing clip stops at its next neighbor, never eats it.
    let limit = Infinity;
    for (const other of loc.track.clips) {
      if (other.id === clip.id || other.frameId !== clip.frameId) continue;
      if (other.startMs >= oldEnd - 1) limit = Math.min(limit, other.startMs);
    }
    if (Number.isFinite(limit)) {
      clip.durationMs = Math.max(50, Math.min(clip.durationMs, limit - clip.startMs));
    }
  }
  if (clip.kind === "nested") reconcileFillClips(doc, clip.sourceFrameId);
  return true;
}

/**
 * How much timeline a play-once MEDIA clip can cover before running out of
 * footage: (source − in-point) ÷ speed. Null for looping clips, non-media
 * kinds (nested comps are elastic — their fill children stretch), and media
 * whose intrinsic duration is unknown.
 */
export function clipSourceCapacityMs(doc: MotionDocument, clip: Clip): number | null {
  const playback = clipPlaybackOf(clip);
  if (!playback || playback.loop !== "none") return null;
  let sourceMs: number | null = null;
  if (clip.kind === "video") {
    sourceMs = doc.assets.find((a) => a.id === clip.assetId)?.durationMs ?? null;
  } else if (clip.kind === "audio" && clip.source.type === "asset") {
    const assetId = clip.source.assetId;
    sourceMs = doc.assets.find((a) => a.id === assetId)?.durationMs ?? null;
  }
  if (sourceMs === null || sourceMs <= 0) return null;
  const trimIn = "trimInMs" in clip ? clip.trimInMs : 0;
  const available = Math.max(0, sourceMs - trimIn);
  // A RAMPED clip has no single divisor — the wall time it runs out at is
  // where the integral of its rate reaches the footage it has, so ask the
  // curve. A clip with a constant rate takes the division it always did.
  const curve = clipSpeedCurve(clip);
  if (curve) return wallTimeForSourceMs(curve, available);
  const speed = playback.speed > 0 ? playback.speed : 1;
  return available / speed;
}

/**
 * How much SOURCE a clip still has, in source milliseconds — the numerator
 * `clipSourceCapacityMs` divides. Split out because a retimed clip needs the
 * two facts separately: how much footage exists, and how much these rates eat.
 */
export function clipSourceAvailableMs(doc: MotionDocument, clip: Clip): number | null {
  let sourceMs: number | null = null;
  if (clip.kind === "video") {
    sourceMs = doc.assets.find((a) => a.id === clip.assetId)?.durationMs ?? null;
  } else if (clip.kind === "audio" && clip.source.type === "asset") {
    const assetId = clip.source.assetId;
    sourceMs = doc.assets.find((a) => a.id === assetId)?.durationMs ?? null;
  } else if (clip.kind === "nested") {
    sourceMs = frameContentDurationMs(doc, clip.sourceFrameId);
  }
  if (sourceMs === null || sourceMs <= 0) return null;
  const trimIn = "trimInMs" in clip ? clip.trimInMs : 0;
  return Math.max(0, sourceMs - trimIn);
}

/** The automatic retime-ripple default: on when the next same-comp clip on
 * this track sits attached to the clip's end (moving it keeps the cut tight). */
export function retimeRippleDefault(doc: MotionDocument, clipId: string): boolean {
  const loc = locateClip(doc, clipId);
  if (!loc) return false;
  const end = clipEnd(loc.clip);
  return loc.track.clips.some(
    (c) => c.id !== clipId && c.frameId === loc.clip.frameId && Math.abs(c.startMs - end) <= 1,
  );
}

/** The ripple setting a retime should use: the clip's saved override when set,
 * the attachment-based automatic default otherwise. */
export function resolveRetimeRipple(doc: MotionDocument, clipId: string): boolean {
  const loc = locateClip(doc, clipId);
  if (!loc) return false;
  return clipPlaybackOf(loc.clip)?.ripple ?? retimeRippleDefault(doc, clipId);
}

/**
 * Roll edit (DaVinci-style): drag the SHARED boundary between two adjacent
 * same-comp clips, trimming the left's out-point and the right's in-point
 * together so the pair's outer span never changes. The boundary is clamped so
 * neither clip drops below the minimum duration. Right-side keyframes/word
 * timings re-base with the moved in-point.
 */
export function rollEdit(
  doc: MotionDocument,
  leftClipId: string,
  rightClipId: string,
  boundaryMs: number,
): boolean {
  const L = locateClip(doc, leftClipId);
  const R = locateClip(doc, rightClipId);
  if (!L || !R || isClipLocked(L.track, L.clip) || isClipLocked(R.track, R.clip)) return false;
  const left = L.clip;
  const right = R.clip;
  const minDuration = 50;
  const lo = left.startMs + minDuration;
  const hi = clipEnd(right) - minDuration;
  if (hi < lo) return false;
  let b = Math.round(Math.min(Math.max(boundaryMs, lo), hi));
  // The right clip can't reveal media before its source 0 when rolling left.
  const playback = clipPlaybackOf(right);
  if (playback && "trimInMs" in right) {
    const speed = playback.speed > 0 ? playback.speed : 1;
    b = Math.max(b, Math.round(right.startMs - right.trimInMs / speed));
  }
  left.fillDuration = false;
  right.fillDuration = false;
  left.durationMs = b - left.startMs;
  const delta = b - right.startMs;
  right.startMs = b;
  right.durationMs -= delta;
  // The right side's head moved: in-point + keyframes + words re-base through
  // the one seam, so the media trims from the start instead of drifting. The
  // left side trims its out-point — no head change.
  rebaseClipHead(right, delta);
  if (left.kind === "nested") reconcileFillClips(doc, left.sourceFrameId);
  if (right.kind === "nested") reconcileFillClips(doc, right.sourceFrameId);
  return true;
}

/**
 * Shift clip-relative timings (keyframes for EVERY kind, caption cues) by delta.
 *
 * Keys are NOT clamped to the clip. A key holds the instant it was authored
 * for, so a head trim shifts every one of them by the same delta and the ones
 * that fall outside the new window simply sit outside it (see
 * `keyframeSchema.timeMs`). They used to be pinned at 0, which stacked every
 * early key on the head — two keys at the same instant are one key, so the
 * spacing and the easing between them were destroyed by a framing edit and
 * dragging the head back could not restore them. Now trim in, trim out, and
 * the animation is exactly as it was.
 */
function shiftClipInternals(clip: Clip, deltaMs: number): void {
  for (const track of clip.keyframes) {
    for (const key of track.keys) key.timeMs += deltaMs;
  }
  if (clip.kind === "text" && clip.caption) {
    shiftCueTimes(clip.caption.cues, deltaMs);
    clip.caption.cues = normalizeCues(clip.caption.cues, Infinity, clip.durationMs);
  }
}

/**
 * Re-base a clip whose HEAD moved by `wallDeltaMs` (positive = head consumed,
 * negative = head restored) — THE one seam every head edit calls: trim-start,
 * roll edits, and any future ripple/slip tool. Kind-agnostic by construction:
 *  - every kind's clip-local timings shift (keyframes, caption cues);
 *  - source-backed kinds (asset audio, video, nested — the registry's
 *    `clipPlaybackOf` decides) advance their in-point by the wall delta ×
 *    speed, clamped at 0, so the media TRIMS from the start instead of
 *    drifting — and extending the head back restores exactly what was cut.
 * The caller owns startMs/durationMs; this owns everything inside the clip.
 */
export function rebaseClipHead(clip: Clip, wallDeltaMs: number): void {
  if (wallDeltaMs === 0) return;
  shiftClipInternals(clip, -wallDeltaMs);
  const playback = clipPlaybackOf(clip);
  if (playback && "trimInMs" in clip) {
    const speed = playback.speed > 0 ? playback.speed : 1;
    clip.trimInMs = Math.max(0, clip.trimInMs + wallDeltaMs * speed);
  }
}

/**
 * A source-backed clip's NATURAL span — asset duration for video/audio,
 * content end for nested — minus trim-in. Zero when the asset/duration isn't
 * known yet (unloaded). This is what `loopLengthMs` overrides: the ONE
 * per-kind lookup every render path and the timeline's loop-cycle handle
 * share, so they can never disagree on what "natural" means.
 *
 * A host may know a natural span this function cannot (an animated GIF's
 * length lives in the app's decode cache, not in the document) — that is what
 * `clipSourceTimeAt`'s `naturalMs` argument is for, and it is the ONLY reason
 * to compute a natural span anywhere else.
 */
export function clipNaturalSourceSpanMs(doc: MotionDocument, clip: Clip): number {
  if (clip.kind === "audio") {
    if (clip.source.type !== "asset") return 0;
    const assetId = clip.source.assetId;
    const dur = doc.assets.find((a) => a.id === assetId)?.durationMs ?? 0;
    return dur > 0 ? Math.max(1, dur - clip.trimInMs) : 0;
  }
  if (clip.kind === "video") {
    const dur = doc.assets.find((a) => a.id === clip.assetId)?.durationMs ?? 0;
    return dur > 0 ? Math.max(1, dur - clip.trimInMs) : 0;
  }
  if (clip.kind === "nested") {
    return Math.max(1, frameContentDurationMs(doc, clip.sourceFrameId) - clip.trimInMs);
  }
  return 0;
}

/**
 * THE clip-local → SOURCE-time map. Where inside its source (file ms for
 * video/audio, comp ms for a nested clip) does this clip sit `localMs` after
 * it started?
 *
 * This is one function and not one per kind on purpose. Trim-in, speed,
 * loop/ping-pong, an overridden cycle length and reverse are properties of
 * `playback` + `trimInMs`, which every source-backed kind carries; the only
 * per-kind fact is the natural span, and that already has exactly one lookup
 * (`clipNaturalSourceSpanMs`). The renderer, the video conductor, the frame
 * tracker, the cache bars and the timeline posters all ask through here, so
 * "which frame is showing" cannot have two answers — which it did, when the
 * app kept a `videoSourceMs` and a `nestedSourceMs` of its own that agreed
 * with this one only by hand.
 *
 * `naturalMs` overrides the document-derived span for the cases the document
 * cannot answer: an animated image's length (app-side decode cache) and a
 * video whose asset duration hasn't loaded yet (the clip's own duration is
 * the honest stand-in). A clip with no `playback` has no source to map into,
 * so local time passes straight through.
 */
export function clipSourcePhaseAt(
  doc: MotionDocument,
  clip: Clip,
  localMs: number,
  naturalMs?: number | null,
): SourcePhase {
  const playback = clipPlaybackOf(clip);
  // No playback = no source to wrap into: local time IS source time, one pass,
  // never held. Returning a phase (rather than refusing) is what lets callers
  // treat a still image and a ping-ponging video with the same code.
  if (!playback) return { sourceMs: Math.max(0, localMs), cycleIndex: 0, held: false };
  const natural = naturalMs ?? clipNaturalSourceSpanMs(doc, clip);
  const trimIn = "trimInMs" in clip ? clip.trimInMs : 0;
  // THE clip-aware door: every surface in the app reads source time through
  // here, so passing the speed curve once is what makes a ramp or a freeze show
  // in the renderer, the exporter, the poster strip, the cache bars and the
  // waveform without any of them learning what a speed key is.
  const curve = clipSpeedCurve(clip);
  const phase = sourcePhaseAt(localMs, loopSpanMs(playback, natural, curve), playback, curve);
  return { ...phase, sourceMs: trimIn + phase.sourceMs };
}

/** Where in its source a clip sits — {@link clipSourcePhaseAt} without the pass. */
export function clipSourceTimeAt(
  doc: MotionDocument,
  clip: Clip,
  localMs: number,
  naturalMs?: number | null,
): number {
  return clipSourcePhaseAt(doc, clip, localMs, naturalMs).sourceMs;
}

/**
 * THE inverse of {@link clipSourceTimeAt}, first pass: at what clip-local time
 * does this clip show `sourceMs` of its source?
 *
 * It exists because the inverse used to be written inline wherever something
 * mapped UP — navigation, marker projection — as `sourceMs / speed`, which is
 * only the inverse of a clip nobody trimmed. Trim-in, reverse and a speed ramp
 * all live in the forward map, so each inline copy put a trimmed instance's
 * playhead `trimIn` too early: standing on 1s inside a comp whose instance
 * starts at 5.5s of it painted 6.5s. Loop/pingpong make the true inverse
 * many-valued; the first pass is the editing-intuitive answer. Clamped to the
 * clip's own span, like the forward map's `local`.
 */
export function clipLocalTimeAtSource(doc: MotionDocument, clip: Clip, sourceMs: number): number {
  const playback = clipPlaybackOf(clip);
  if (!playback) return Math.max(0, sourceMs);
  const trimIn = "trimInMs" in clip ? clip.trimInMs : 0;
  const curve = clipSpeedCurve(clip);
  let s = sourceMs - trimIn;
  if (playback.reverse) s = loopSpanMs(playback, clipNaturalSourceSpanMs(doc, clip), curve) - s;
  s = Math.max(0, s);
  const local = curve ? (wallTimeForSourceMs(curve, s) ?? clip.durationMs) : parentTimeAt(s, playback);
  return Math.min(Math.max(0, local), clip.durationMs);
}

/**
 * How much SOURCE time a clip reads over its first `local` wall-ms — the split
 * point's in-point advance, so the right half CONTINUES the media instead of
 * restarting it. Trim-relative (the halves share an in-point origin), hence
 * the subtraction rather than a second time-map.
 */
function sourceConsumedMs(doc: MotionDocument, clip: Clip, local: number): number {
  const playback = clipPlaybackOf(clip);
  if (!playback) return 0;
  const trimIn = "trimInMs" in clip ? clip.trimInMs : 0;
  return clipSourceTimeAt(doc, clip, local) - trimIn;
}

/**
 * Partition keyframe tracks around a cut at `local`, planting a boundary key on
 * EACH side at the exact sampled value so an in-progress animation stays
 * continuous: the left half ends on that value, the right half resumes from it
 * (carrying the easing that governed the cut), instead of the value snapping
 * back to base. Every key gets a fresh id; right-side keys re-base to t=0.
 */
function splitKeyframeTracks(
  tracks: KeyframeTrack[],
  local: number,
): { left: KeyframeTrack[]; right: KeyframeTrack[] } {
  const left: KeyframeTrack[] = [];
  const right: KeyframeTrack[] = [];
  for (const track of tracks) {
    if (track.keys.length === 0) continue;
    const valueAtSplit = sampleKeyframeTrack(track, local);
    if (valueAtSplit === undefined) continue;
    // The easing governing the segment at the cut = the last key at/before it.
    let easingAtSplit: Easing = track.keys[0]!.easing;
    for (const k of track.keys) if (k.timeMs <= local) easingAtSplit = k.easing;

    const leftKeys: Keyframe[] = track.keys
      .filter((k) => k.timeMs < local - 0.5)
      .map((k) => ({ ...k, id: createId("key") }));
    leftKeys.push({ id: createId("key"), timeMs: local, value: valueAtSplit, easing: easingAtSplit });
    left.push({ id: createId("ktrack"), property: track.property, range: track.range, keys: leftKeys });

    const rightKeys: Keyframe[] = [
      { id: createId("key"), timeMs: 0, value: valueAtSplit, easing: easingAtSplit },
    ];
    for (const k of track.keys) {
      if (k.timeMs > local + 0.5) rightKeys.push({ ...k, id: createId("key"), timeMs: k.timeMs - local });
    }
    right.push({ id: createId("ktrack"), property: track.property, range: track.range, keys: rightKeys });
  }
  return { left, right };
}

/**
 * Split a clip at an absolute time (⌘/Ctrl+B). Returns the id of the new
 * right-hand clip, or null if the time isn't strictly inside the clip.
 * Source-backed clips (audio/video/nested) CONTINUE — the right half's in-point
 * advances so it plays on, not from the start. Keyframes keep animating across
 * the cut via boundary keys. Text: left keeps the in-animation, right keeps the
 * out. Caption cues fall to whichever side of the cut they start on.
 */
export function splitClip(doc: MotionDocument, clipId: string, timeMs: number): string | null {
  const loc = locateClip(doc, clipId);
  if (!loc || isClipLocked(loc.track, loc.clip)) return null;
  // A GROUP is one layer that happens to contain others, so cutting it has to
  // cut them: two groups, each holding its own half. Cutting only the container
  // left every member whole and hid half of each behind a window, which is not
  // a split by any definition a person would use.
  //
  // Named before anything moves, and applied after the container's own cut so
  // the new group exists to receive the right-hand halves.
  if (loc.clip.kind !== "group") return splitOneClip(doc, loc, timeMs);
  const rightId = splitOneClip(doc, loc, timeMs);
  if (rightId) {
    const touched: string[] = [];
    splitGroupInterior(doc, loc.clip.id, rightId, timeMs, touched);
    // ONE sweep, and only once the whole recursion has finished. A group being
    // cut legitimately has no rows for a moment — they are created as the first
    // member is handed over — so sweeping inside the recursion deleted the very
    // group that was about to receive the right-hand halves, and the cut
    // silently kept only the left side.
    pruneEmptiedTracks(doc, touched);
    pruneGroups(doc);
  }
  return rightId;
}

/** The cut itself, for ONE clip — a group's container included. */
function splitOneClip(doc: MotionDocument, loc: ClipLocation, timeMs: number): string | null {
  const clip = loc.clip;
  const local = timeMs - clip.startMs;
  if (local <= 1 || local >= clip.durationMs - 1) return null;

  const right = cloneClip(clip);
  right.id = createId("clip");
  right.startMs = timeMs;
  right.durationMs = clip.durationMs - local;
  clip.durationMs = local;

  // A split is an explicit length edit, so BOTH halves lock to their new
  // spans — same contract as trim/roll (see `fillDuration` in clips.ts). Without
  // this, splitting a fill clip (e.g. a pixel/capture drawing layer, born
  // `fillDuration: true`) leaves both pieces flagged fill, and the next
  // `reconcileFillClips` stretches EACH back to the comp end — they balloon to
  // full length and overlap every clip in front of them.
  clip.fillDuration = false;
  right.fillDuration = false;

  // Continue the media: advance the right half's source in-point by what the
  // left half already played (speed/loop aware). Registry-driven — any future
  // source-backed kind with an in-point joins automatically.
  if (clipPlaybackOf(right) && "trimInMs" in right) {
    right.trimInMs += sourceConsumedMs(doc, clip, local);
  }

  if (clip.kind === "text" && right.kind === "text") {
    clip.animations.out = null;
    right.animations.in = null;
    // Cues fall to the side of the cut they START on; one straddling it is
    // truncated rather than duplicated, so the halves never both claim it.
    if (clip.caption && right.caption) {
      const all = clip.caption.cues;
      clip.caption.cues = normalizeCues(
        all.filter((c) => c.startMs < local).map((c) => ({ ...c, endMs: Math.min(c.endMs, local) })),
        Infinity, local,
      );
      right.caption.cues = normalizeCues(
        all.filter((c) => c.startMs >= local).map((c) => ({
          ...c, id: createId("cue"), startMs: c.startMs - local, endMs: c.endMs - local,
        })),
        Infinity, right.durationMs,
      );
    }
  }

  // Keyframes split for EVERY kind (audio gain included), with boundary keys so
  // the animation carries across the seam.
  const keyframeSplit = splitKeyframeTracks(clip.keyframes, local);
  clip.keyframes = keyframeSplit.left;
  right.keyframes = keyframeSplit.right;

  // The cut the left half's out-transition was authored on now belongs to the
  // right half — the left half's new end is the split point, which is not a cut
  // at all. (Its in-transition stays put: the left half keeps the start.)
  reassignTransitionTail(loc.track, clip.id, right.id);

  addClipToTrack(loc.track, right, loc.clipIndex + 1);
  sortTrackClips(loc.track);
  return right.id;
}

/**
 * Hand the right-hand half of a group's CONTENTS to the new group the cut just
 * created.
 *
 * A group's membership lives on its ROWS (`track.groupId`), so the new group
 * needs rows of its own: one per row of the original, inserted immediately
 * after it, which is what keeps the two bands z-ordered internally the way the
 * one band was. Then every member goes to the side of the cut it belongs on —
 * moved whole when it lies entirely after, cut when it straddles, left alone
 * when it lies entirely before.
 *
 * Recursive through `splitClip`, so a sub-group is cut exactly the way its
 * parent was, at any depth, and a sub-group that merely MOVES takes its whole
 * subtree with it for free: its descendants' rows name it, not the row it sits
 * on, so nothing below has to be touched.
 *
 * The original rows are swept if the cut emptied them (`pruneEmptiedTracks`
 * spares the ones a person made by hand), and a group left holding nothing is
 * removed by `pruneGroups` like any other empty group.
 */
function splitGroupInterior(
  doc: MotionDocument,
  groupId: string,
  newGroupId: string,
  timeMs: number,
  /** Rows the cut took clips off — swept by the caller once, at the end. */
  touched: string[],
): void {
  const rows = doc.tracks.filter((t) => t.groupId === groupId);
  for (const row of rows) {
    // Snapshot: the loop below adds to `row.clips` (a straddling member's right
    // half lands beside it before we move it off).
    const members = [...row.clips];
    if (members.length === 0) continue;
    let mirror: Track | null = null;
    const rowFor = (): Track => {
      if (!mirror) {
        mirror = createCarrierTrack(row.name, row.homeCompId, newGroupId);
        mirror.heightPx = row.heightPx;
        mirror.auto = row.auto;
        doc.tracks.splice(doc.tracks.indexOf(row) + 1, 0, mirror);
      }
      return mirror;
    };
    const handOver = (clipId: string): void => {
      const at = locateClip(doc, clipId);
      if (!at) return;
      const moved = removeClipFromTrack(at.track, at.clipIndex);
      if (moved) addClipToTrack(rowFor(), moved);
    };
    for (const member of members) {
      if (clipEnd(member) <= timeMs) continue;
      if (member.startMs >= timeMs) {
        handOver(member.id);
        continue;
      }
      const at = locateClip(doc, member.id);
      const half = at ? splitOneClip(doc, at, timeMs) : null;
      if (!half) continue;
      // A sub-group's own contents are cut the same way before it moves: its
      // rows name it by id, so handing the sub-group over carries its whole
      // subtree with it and nothing below has to be re-pointed.
      if (member.kind === "group") splitGroupInterior(doc, member.id, half, timeMs, touched);
      handOver(half);
    }
    touched.push(row.id);
  }
}

/** All clips whose span contains timeMs, across unlocked tracks. */
export function clipsAtTime(doc: MotionDocument, timeMs: number): ClipLocation[] {
  const out: ClipLocation[] = [];
  for (let t = 0; t < doc.tracks.length; t++) {
    const track = doc.tracks[t]!;
    for (let c = 0; c < track.clips.length; c++) {
      const clip = track.clips[c]!;
      if (timeMs > clip.startMs && timeMs < clipEnd(clip)) {
        out.push({ track, trackIndex: t, clip, clipIndex: c });
      }
    }
  }
  return out;
}

export function deleteClip(doc: MotionDocument, clipId: string): boolean {
  const loc = locateClip(doc, clipId);
  if (!loc || isClipLocked(loc.track, loc.clip)) return false;
  // Any text riding this layer's outline is set down where it was, as plain
  // text — a relation to a layer that is gone is not a state the document keeps.
  if (loc.clip.kind === "shape" || loc.clip.kind === "path") detachTextsFromHost(doc, clipId);
  removeClipFromTrack(loc.track, loc.clipIndex);
  return true;
}

/**
 * Duplicate a clip keeping its exact timing — the ONE duplicate primitive
 * (Figma "duplicate in place"), used by ⌘D/menu and ⌥-drag alike. Since clips
 * can't overlap in a track, the copy lands on another track of the same kind
 * with room — or a freshly inserted one right at the source's z-order. Purely
 * id-based: duplicating a copy clones exactly THAT clip, never its source.
 */
export function duplicateClipInPlace(doc: MotionDocument, clipId: string): string | null {
  const loc = locateClip(doc, clipId);
  if (!loc) return null;
  const copy = reissueClipIds(loc.clip);

  // Figma parity: the copy lands DIRECTLY ABOVE the source (in front) on its own
  // fresh carrier at the source's z, inside the source's group. Never scan downward for a "free" lower lane — that's what put
  // copies BEHIND the original. The copy keeps the source's exact time, so it
  // always overlaps it; a fresh lane above is the only correct z. Audio has no
  // z, so it rides a new lane at the bottom.
  const target = createCarrierTrack(`${loc.track.name} copy`);
  target.color = loc.track.color;
  target.heightPx = loc.track.heightPx;
  // The copy is in the group its source was in: same scope, fresh row.
  target.groupId = loc.track.groupId;
  if (loc.clip.kind === "audio") doc.tracks.push(target);
  else doc.tracks.splice(loc.trackIndex, 0, target);
  addClipToTrack(target, copy);
  sortTrackClips(target);
  return copy.id;
}

/**
 * DUPLICATE a selection, structure intact — the ONE op behind ⌘D, ⌥-drag and
 * the layers list's duplicate.
 *
 * A group is selected as ONE clip, so a duplicate of it has to bring what is
 * inside: a copy of a container holding nothing is not a copy of anything.
 * Widening happens here rather than at each call site, which is how ⌘D, ⌥-drag
 * and copy/paste had ended up with different answers about what a duplicated
 * group even is.
 *
 * Placement is `duplicateClipInPlace`'s, per clip: a fresh lane directly above
 * the source, so copies land in front of their originals and keep their
 * relative z. Applied BOTTOM-UP, because splicing a lane shifts every lane
 * below it — walking upward would move the targets out from under itself.
 *
 * `remapClipRefsAfterCopy` then re-points the copies' membership at the COPIED
 * group, so the duplicate is a second independent group rather than a second
 * reference into the first.
 *
 * Returns both the whole copied set and just the copies of what was SELECTED —
 * the callers want different ones, and the difference is exactly the difference
 * between "what moved" and "what you now have selected".
 */
export function duplicateClips(
  doc: MotionDocument,
  clipIds: readonly string[],
): { created: string[]; tops: string[] } {
  const wanted = new Set(expandToDescendants(doc, clipIds));
  const ordered: string[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) if (wanted.has(clip.id)) ordered.push(clip.id);
  }
  const idMap = new Map<string, string>();
  const copies: Clip[] = [];
  for (const id of ordered.reverse()) {
    const newId = duplicateClipInPlace(doc, id);
    if (!newId) continue;
    idMap.set(id, newId);
    const loc = locateClip(doc, newId);
    if (loc) copies.push(loc.clip);
  }
  remapClipRefsAfterCopy(doc, copies, idMap);
  return {
    created: [...idMap.values()],
    tops: clipIds.map((id) => idMap.get(id)).filter((x): x is string => !!x),
  };
}

/**
 * Fix up a batch of freshly-copied clips (duplicate / paste / ⌥-drag):
 *  - each link group represented ≥2× in the batch becomes a NEW group (the
 *    copies stay linked to each other, never to the originals);
 *  - a lone member of a group is unlinked (its partner wasn't copied);
 *  - waveform `targetClipId`s retarget to the copied audio when it's in the
 *    batch (via `idMap`: original clip id → copy id), else keep the original.
 */
export function remapClipRefsAfterCopy(
  doc: MotionDocument,
  copies: Clip[],
  idMap?: Map<string, string>,
  /**
   * Ids of copies that landed in a DIFFERENT comp than they were taken from.
   *
   * Membership is scoped to a comp, so a row pointing at a group that did NOT
   * travel with this paste cannot follow a layer across — it would name a
   * group in another comp, or in another document entirely. A group that DID
   * travel is re-pointed below and keeps everything: its members, its nesting,
   * its composite mode and roles.
   */
  reframed?: ReadonlySet<string>,
): void {
  const groupCounts = new Map<string, number>();
  for (const c of copies) {
    if (c.linkGroupId) groupCounts.set(c.linkGroupId, (groupCounts.get(c.linkGroupId) ?? 0) + 1);
  }
  const fresh = new Map<string, string>();
  for (const c of copies) {
    if (!c.linkGroupId) continue;
    if ((groupCounts.get(c.linkGroupId) ?? 0) < 2) {
      c.linkGroupId = null;
      continue;
    }
    let next = fresh.get(c.linkGroupId);
    if (!next) {
      next = createId("link");
      fresh.set(c.linkGroupId, next);
    }
    c.linkGroupId = next;
  }
  if (idMap) {
    for (const c of copies) {
      if (c.kind === "waveform") {
        const mapped = idMap.get(c.targetClipId);
        if (mapped) c.targetClipId = mapped;
      }
      // A trace copied with what it follows follows the copy.
      if (c.kind === "trace" && c.trace.source.clipId) {
        const mapped = idMap.get(c.trace.source.clipId);
        if (mapped) c.trace.source = { ...c.trace.source, clipId: mapped };
      }
    }
    // GROUP MEMBERSHIP is the ROW's, so it is the copies' rows that re-point:
    // a row holding a copy and naming a group that CAME ALONG names the copied
    // group instead. A row naming a group that did not come along keeps it —
    // "not in this copy" means "not mine to change" — unless the copy crossed
    // comps, where that group cannot follow.
    //
    // A copied member shares its row with nothing but copies (each copy rides
    // a fresh carrier), so re-scoping the row never moves an original.
    const copied = new Set(copies.map((c) => c.id));
    for (const track of [...doc.tracks]) {
      // A row already naming a COPIED group was seated there by the paste: it
      // is the answer, not a stale source to re-point. Treating it as "a group
      // that did not come along" emptied every group pasted into another comp.
      if (!track.groupId || copied.has(track.groupId)) continue;
      const mine = track.clips.filter((c) => copied.has(c.id));
      if (mine.length === 0) continue;
      const mapped = idMap.get(track.groupId);
      const next = mapped ?? (reframed && mine.some((c) => reframed.has(c.id)) ? null : undefined);
      if (next === undefined) continue;
      if (mine.length === track.clips.length) {
        track.groupId = next;
        continue;
      }
      // Copies sharing a row with originals (a comp clone) get a row of their own.
      const row = createCarrierTrack(track.name, mine[0]!.frameId, next);
      row.color = track.color;
      row.heightPx = track.heightPx;
      track.clips = track.clips.filter((c) => !copied.has(c.id));
      for (const c of mine) addClipToTrack(row, c);
      doc.tracks.splice(doc.tracks.indexOf(track) + 1, 0, row);
    }
  }
}

// ── Frame (artboard) ops ─────────────────────────────────────────────────────

/**
 * Replace one clip with several, IN ITS PLACE.
 *
 * The rule, and it is the whole point: an operation that turns one layer into
 * many is not permission to rearrange the timeline. The FIRST replacement takes
 * the source's exact track and exact slot; the rest ride fresh carriers spliced
 * directly BELOW that track, so they read top→bottom in the order given and
 * every lane above is untouched. The source's track is never removed — an
 * emptied lane that existed before the edit still existed before the edit.
 *
 * Written because the first version of promotion did the opposite: it minted a
 * carrier per piece at the top of the stack and deleted the lane it emptied, so
 * separating one shape re-ordered the whole comp and quietly took some empty
 * tracks with it. Surprising is the one thing a structural edit must not be.
 *
 * Returns false when the source cannot be found or is locked.
 */
export function replaceClipInPlace(
  doc: MotionDocument,
  clipId: string,
  replacements: Clip[],
): boolean {
  const loc = locateClip(doc, clipId);
  if (!loc || replacements.length === 0) return false;
  const { track, trackIndex, clipIndex } = loc;

  // CONTAINMENT COMES WITH THE SLOT — for free, now that the row is what says
  // a layer is inside something: a replacement in the source's slot is in the
  // source's group, and the siblings' carriers below are scoped to match.

  // The source's own slot, reused. Splicing at `clipIndex` rather than pushing
  // keeps its neighbours' order on this lane as well as the lane order itself.
  track.clips.splice(clipIndex, 1, replacements[0]!);
  sortTrackClips(track);

  // Siblings go immediately below, in order, so the stack reads the way the
  // caller listed them and nothing above the source moves at all.
  replacements.slice(1).forEach((clip, i) => {
    const carrier = createCarrierTrack(clip.name);
    carrier.color = track.color;
    carrier.heightPx = track.heightPx;
    carrier.homeCompId = track.homeCompId;
    carrier.groupId = track.groupId;
    doc.tracks.splice(trackIndex + 1 + i, 0, carrier);
    addClipToTrack(carrier, clip);
  });
  return true;
}

export function locateFrame(doc: MotionDocument, frameId: string): Frame | null {
  return doc.frames.find((f) => f.id === frameId) ?? null;
}

/**
 * The SOLE nested clip that owns a frame as a PRIVATE (embedded) source comp.
 * Such a comp is joined at the hip to its one instance, so its duration IS that
 * clip's duration (that's what "fill children stay in sync with the parent"
 * means), it is never painted as an artboard, and it is opened by entering its
 * instance.
 *
 * Ownership is a fact of STORAGE, never of reference count: a comp is embedded
 * only when it lives on the internal shelf (precompose, a drawing cell, a made-
 * unique copy). A comp filed on a real page is a scene in its own right — every
 * nested clip showing it is a LINK to it, whether there is one link or forty.
 * Inferring ownership from "exactly one clip shows it" is what made a template
 * scene that its cover happens to show once vanish from its own page and open
 * as Cover ▸ Scene. Returns null for components, flipbooks, page comps and comps
 * referenced 0 or 2+ times.
 *
 * A flipbook is NEVER an owned comp, regardless of instance count — its own
 * duration (the sheet's end bar) must stay independent of whatever clip box
 * happens to reference it, or shrinking the sheet to preview a short loop
 * would silently resize the parent clip too. The only link between a
 * flipbook and how a clip instance replays it is `playback.loopLengthMs`
 * (see loopSpanMs) — deliberately not this.
 */
export function compOwnerNested(doc: MotionDocument, frameId: string): Clip | null {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame || !isInternalPage(frame.pageId) || frame.component != null || frame.mode === "flipbook") return null;
  const shown = nestedClipsShowing(doc, frameId);
  return shown.length === 1 ? shown[0]! : null;
}

/**
 * A frame's intrinsic content duration — the last visual clip end within it.
 * With no clips at all there's nothing to measure, so it falls back to the
 * frame's explicit override or the document duration (NOT through
 * `frameDurationMs` — that would recurse back into this function). Used as the
 * source duration when the frame is nested (loop/pingpong wrap around this).
 */
export function frameContentDurationMs(doc: MotionDocument, frameId: string): number {
  const end = frameContentEndMs(doc, frameId);
  if (end > 0) return end;
  const frame = doc.frames.find((f) => f.id === frameId);
  return frame?.durationMs ?? doc.durationMs;
}

/**
 * The ONE brain for "how long does this comp play/export for" — the timeline's
 * end bar, playback loop point, export span, prefetch window and drawing
 * overlay all read this, so changing it here keeps every consumer in
 * agreement. A privately-owned nested comp (`compOwnerNested`) has no length
 * of its own — it IS its owner clip's duration in the parent timeline.
 * Everything else takes its own length or, with none set, hugs its content end
 * so the bar sits at the last clip instead of floating in empty space
 * (`frame.get` says which: `durationFollowsContent`).
 *
 * The length lives on the comp and nowhere else (v113). It used to live on the
 * DOCUMENT while a project had one comp, so adding a second comp moved where
 * the first one's length was read from — and it silently became its content end.
 */
export function frameDurationMs(doc: MotionDocument, frame: Frame): number {
  const owner = compOwnerNested(doc, frame.id);
  if (owner) {
    // A private comp's duration is the SOURCE span its owner clip covers, NOT
    // the owner's footprint in the parent. Footprint = source ÷ speed (see
    // `retimeClip`/`sourceTimeAt`), so multiply the speed back out. This keeps
    // `footprint × speed` invariant under a retime — changing an instance's
    // speed rescales its footprint but NEVER the source comp, so fill children
    // (capture/snapshot drawing layers, backgrounds) keep their length and
    // their snapshot keyframes stay put. Loop clips decouple footprint from
    // source (the footprint is a user choice), so they use the footprint as-is.
    const pb = clipPlaybackOf(owner);
    if (pb && pb.loop === "none" && pb.speed > 0) return Math.round(owner.durationMs * pb.speed);
    return owner.durationMs;
  }
  return frame.durationMs ?? frameContentDurationMs(doc, frame.id);
}

/**
 * A nested clip that OWNS a frame as its private comp — the sole private owner
 * when there is one, otherwise the first instance found (for a private frame
 * two clips happen to share, so the nesting tree still has a reachable path).
 *
 * A COMPONENT definition is deliberately owner-less: it's a root artboard on
 * the Components page that instances REFERENCE, never contain, so it has no
 * canonical parent to walk up to. Returning an arbitrary instance here is what
 * made a component's parent-preview render the sequence that instances it (a
 * phantom animation behind the static mouth, flickering as the picked instance
 * changed). Parent-agnostic by construction: a shared definition has no owner.
 */
export function ownerNestedOf(doc: MotionDocument, frameId: string): Clip | null {
  const sole = compOwnerNested(doc, frameId);
  if (sole) return sole;
  // A shared component definition is a root — never owned by its instances.
  if (doc.frames.find((f) => f.id === frameId)?.component != null) return null;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "nested" && clip.sourceFrameId === frameId) return clip;
    }
  }
  return null;
}

/**
 * The drill path from a ROOT comp down to `targetFrameId`'s immediate parent —
 * one `{ frameId: parentComp, clipId: nestedClip }` per hop, root-first — so a
 * timeline can navigate straight to the comp that holds a given clip without a
 * manual double-click chain. Empty when the target is itself a root comp.
 * Cycle-guarded; stops at the first frame no nested clip references.
 */
export function compAncestryPath(
  doc: MotionDocument,
  targetFrameId: string,
): Array<{ frameId: string; clipId: string }> {
  const chain: Array<{ frameId: string; clipId: string }> = [];
  const visited = new Set<string>();
  let cur = targetFrameId;
  while (!visited.has(cur)) {
    visited.add(cur);
    const owner = ownerNestedOf(doc, cur);
    if (!owner) break; // cur is a root comp — nothing nests it
    chain.unshift({ frameId: owner.frameId, clipId: owner.id });
    cur = owner.frameId;
  }
  return chain;
}

/**
 * The effective duration of a comp (frame), by id — a thin `frameDurationMs`
 * wrapper for callers that only have the id. This is the length `fill` clips
 * inside the comp span.
 */
export function compDurationMs(doc: MotionDocument, frameId: string): number {
  const frame = doc.frames.find((f) => f.id === frameId);
  return frame ? frameDurationMs(doc, frame) : doc.durationMs;
}

/**
 * Extend every `fill` clip in a comp to span the comp's full duration (from its
 * own start to the comp end). Called whenever a comp's duration can change — a
 * frame-duration edit, the doc duration, or a nested clip being resized (its
 * private source comp follows). Fill clips keep animating; only their tail moves.
 */
export function reconcileFillClips(doc: MotionDocument, frameId: string): void {
  const dur = compDurationMs(doc, frameId);
  if (dur <= 0) return;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.frameId !== frameId || !clip.fillDuration) continue;
      // A fill clip spans to the comp end, but NEVER past the next clip on its
      // OWN track (same frame) — it takes the free gap, it never swallows or
      // overlaps a neighbour. This is the headless guarantee: no matter how a
      // clip came to be flagged `fillDuration` (born that way, cloned, imported),
      // reconciling it can never produce an overlap.
      let limit = dur;
      for (const other of track.clips) {
        if (other === clip || other.frameId !== clip.frameId) continue;
        if (other.startMs >= clip.startMs + 1 && other.startMs < limit) limit = other.startMs;
      }
      clip.durationMs = Math.max(50, limit - clip.startMs);
    }
  }
}

/**
 * THE writer for a comp's duration — the mirror of {@link frameDurationMs}.
 *
 * It exists because the read side was a brain and the write side was a call
 * site: `useCompDuration` in the timeline knew about private nested owners, the
 * one-frame document case and the per-frame override, and it reconciled fill
 * clips on exactly ONE of those three branches. So dragging the End Bar of an
 * ordinary comp silently left every `fillDuration` layer in it at its old
 * length — the comp grew, the layers that were supposed to span it did not.
 *
 * Reconciling here, unconditionally, is what makes "this layer tracks the comp"
 * true by construction rather than by remembering. Any future surface that
 * changes a duration (a plugin, an importer, a script) gets the guarantee for
 * free, and there is no second place for the two halves to disagree.
 */
export function setFrameDurationMs(doc: MotionDocument, frameId: string, ms: number): void {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame) return;
  const rounded = Math.max(50, Math.round(ms));
  // A comp PRIVATELY owned by one nested clip has no length of its own — its
  // length IS that clip's, so editing it writes the owner (see `frameDurationMs`).
  const owner = compOwnerNested(doc, frame.id);
  if (owner) owner.durationMs = rounded;
  else frame.durationMs = rounded;
  reconcileFillClips(doc, frameId);
}

// Frame rate: the VALUES (rates, grids, presets) live in ./fps; the two
// functions that CHANGE a rate live here, because re-cutting a flipbook has to
// reconcile fill clips and that brain is in this module.

/**
 * Re-cut a flipbook's drawings onto a new grid when its rate changes.
 *
 * This is the ONE place a rate change is allowed to touch time, and it is
 * deliberate: a flipbook's cells are *drawings per frame*, so "this sheet is
 * now 24fps instead of 12" means each drawing should hold for a 24fps frame —
 * not that the sheet should keep its old millisecond timings and stop lining up
 * with its own grid. Cells scale by `oldStep / newStep`, which preserves each
 * cell's HOLD COUNT: a drawing held for 2 frames is still held for 2 frames,
 * the sheet just runs at the new speed.
 *
 * Ordinary comps are pointedly NOT retimed: their content is authored in
 * milliseconds against a wall clock, so 30 → 60 there means "sample this twice
 * as finely", never "play it twice as fast".
 *
 * Rounding goes through the HOLD COUNT (`round(t / oldStep) * newStep`) rather
 * than scaling the millisecond value, so a sheet that has been retimed back and
 * forth lands exactly back on whole frames instead of accumulating drift.
 */
export function retimeFlipbookCells(
  doc: MotionDocument,
  flipbookId: string,
  fromFps: number,
  toFps: number,
): void {
  const oldStep = frameStepMs(fromFps);
  const newStep = frameStepMs(toFps);
  if (!Number.isFinite(oldStep) || !Number.isFinite(newStep) || oldStep === newStep) return;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.frameId !== flipbookId) continue;
      clip.startMs = Math.max(0, Math.round(clip.startMs / oldStep) * newStep);
      clip.durationMs = Math.max(1, Math.round(clip.durationMs / oldStep)) * newStep;
      // A cell's source drawing hugs the cell's duration, and its layers are
      // `fillDuration` — so the drawing's insides have to follow the new hold.
      if (clip.kind === "nested") reconcileFillClips(doc, clip.sourceFrameId);
    }
  }
  // The sheet's own explicit length (its End Bar) is measured in frames too.
  const frame = doc.frames.find((f) => f.id === flipbookId);
  if (frame?.durationMs != null) {
    frame.durationMs = Math.max(newStep, Math.round(frame.durationMs / oldStep) * newStep);
  }
}

/**
 * Set a comp's rate. THE one writer — the frame inspector, the flipbook sheet
 * header and the export dialog all go through it, because the decision of
 * *what a rate change means* has to be made in exactly one place.
 *
 * For an ordinary comp (and a drawing, and a component master) it means nothing
 * beyond the number: content is authored in milliseconds, so clips and
 * keyframes stay exactly where they are and only the grid the UI snaps and
 * steps on moves.
 *
 * For a FLIPBOOK it additionally re-cuts the sheet — see
 * {@link retimeFlipbookCells} for why that one case is different.
 *
 * Note what is NOT here: nothing walks into nested comps, and nothing touches a
 * keyframe. Children own their own rates (a 12fps sheet inside a comp you just
 * moved to 60 is still a 12fps sheet, and should be), and keyframe times are
 * absolute milliseconds that no rate change is allowed to move.
 */
export function setFrameFps(doc: MotionDocument, frameId: string, nextFps: number): void {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame) return;
  const from = frameFps(doc, frame);
  const to = normalizeFps(nextFps);
  if (from === to) return;
  frame.fps = to;
  if (frame.mode === "flipbook") retimeFlipbookCells(doc, frameId, from, to);
}

/**
 * Scale a frame's contents by a uniform factor (Figma scale-tool semantics):
 * every layer's position and scale — including their x/y/scale keyframes —
 * multiplies, so the composition looks pixel-identical at the new size.
 */
export function scaleFrameContents(doc: MotionDocument, frameId: string, factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) return;
  const round = (v: number) => Math.round(v * 1000) / 1000;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "audio" || clip.frameId !== frameId) continue;
      clip.transform.x = round(clip.transform.x * factor);
      clip.transform.y = round(clip.transform.y * factor);
      clip.transform.scale = round(clip.transform.scale * factor);
      // maxWidth stays: layout runs pre-scale, so scaling it would double-apply.
      for (const kf of clip.keyframes) {
        if (kf.property !== "x" && kf.property !== "y" && kf.property !== "scale") continue;
        for (const key of kf.keys) {
          if (typeof key.value === "number") key.value = round(key.value * factor);
        }
      }
    }
  }
}

/**
 * Resize a frame. With `scaleContents`, contents scale by the width ratio
 * (uniform — the visual scale of a layer can't stretch per-axis).
 */
export function resizeFrame(
  doc: MotionDocument,
  frameId: string,
  width: number,
  height: number,
  options: { scaleContents?: boolean } = {},
): void {
  const frame = locateFrame(doc, frameId);
  if (!frame) return;
  const w = Math.max(16, Math.round(width));
  const h = Math.max(16, Math.round(height));
  if (options.scaleContents && frame.width > 0) {
    scaleFrameContents(doc, frameId, w / frame.width);
  }
  frame.width = w;
  frame.height = h;
}

/** Delete a frame and every clip that renders into it. The last frame stays. */
export function deleteFrame(doc: MotionDocument, frameId: string): boolean {
  const idx = doc.frames.findIndex((f) => f.id === frameId);
  if (idx === -1) return false;
  doc.frames.splice(idx, 1);
  for (const track of doc.tracks) {
    track.clips = track.clips.filter((c) => c.frameId !== frameId);
  }
  return true;
}


/** Content end of the document (last clip end), for fitting playback/export. */
export function contentEndMs(doc: MotionDocument): number {
  let end = 0;
  for (const track of doc.tracks) {
    for (const clip of track.clips) end = Math.max(end, clipEnd(clip));
  }
  return end;
}

// ── Layer stacking (layers-list semantics) ───────────────────────────────────

export interface RestackTarget {
  /** Where the clip's carrier track lands in doc.tracks (z position). */
  trackIndex: number;
  /** Reparent the clip to this comp. */
  frameId?: string;
  /** The scope the carrier row belongs to (null = top level, undefined keeps the source's). */
  groupId?: string | null;
  /** Mask-group role after the move (visual clips; undefined keeps). */
  isStencil?: boolean;
}

/**
 * Move one clip to an exact z position: the clip rides its own new track
 * inserted at `trackIndex`. Time never changes — this is pure
 * stacking/parenting, the move the layers list makes.
 *
 * THE VACATED LANE GOES WITH THE CLIP when it was an AUTO carrier — a lane
 * that only ever existed to hold that one clip. Every restack mints a fresh
 * carrier, so without this every layers-list drag left its old carrier behind:
 * reorder a stack of six a few times and the timeline is a field of empty rows
 * nobody made and nothing explains. That is the "zombie track" everyone
 * eventually complains about, and it is not a cleanup problem — it is this
 * function forgetting to put its own scaffolding away.
 *
 * A lane the USER made ("+ Track", the document defaults) or ADOPTED (a second
 * clip landed on it) is `auto: false` and always survives, homed to this clip's
 * previous comp so it stays visible right where it was, not gone.
 */
export function restackClip(doc: MotionDocument, clipId: string, target: RestackTarget): boolean {
  const loc = locateClip(doc, clipId);
  if (!loc || isClipLocked(loc.track, loc.clip)) return false;
  const clip = loc.clip;
  const priorFrameId = clip.frameId;

  if (target.frameId && doc.frames.some((f) => f.id === target.frameId)) {
    // Crossing comps is ONE rule wherever it happens — see `rebaseClipToFrame`.
    rebaseClipToFrame(doc, clip, target.frameId);
  }
  if (clip.kind !== "audio" && target.isStencil !== undefined) clip.isStencil = target.isStencil;

  const srcTrack = loc.track;
  // The carrier's scope IS the clip's new group.
  const carrier = createCarrierTrack(undefined, null, target.groupId !== undefined ? target.groupId : srcTrack.groupId);
  srcTrack.clips.splice(loc.clipIndex, 1);
  if (srcTrack.clips.length === 0) srcTrack.homeCompId = priorFrameId;
  addClipToTrack(carrier, clip);
  doc.tracks.splice(Math.max(0, Math.min(target.trackIndex, doc.tracks.length)), 0, carrier);
  // Put the scaffolding away. Ordered AFTER the insert so `trackIndex` still
  // means what the caller measured it against, and targeted at the one lane the
  // clip just left — `pruneTrackIfEmptied` refuses anything else.
  pruneTrackIfEmptied(doc, srcTrack.id);
  return true;
}

/** Restack several clips as a block (pass ids top-to-bottom to keep their order). */
export function restackClips(doc: MotionDocument, clipIds: string[], target: RestackTarget): void {
  restackUnits(doc, clipIds.map((id) => ({ kind: "clip" as const, id })), target);
}

/** One draggable thing in the layers list: a loose clip, or a WHOLE group. */
export interface LayerUnit {
  kind: "clip" | "group";
  id: string;
}

/**
 * Restack a mixed selection of loose clips and WHOLE groups as one block —
 * the structure-preserving move behind every layers-list drag. A group unit
 * is ONE clip to restack: its rows name it, so they come along wherever its
 * bar goes, subgroups, composite modes and mask roles intact — and dragging a
 * union out of a subtract never dissolves either. Only a comp crossing has to
 * reach inside, to re-home every descendant. Loose clip units take
 * `target.groupId`/`isStencil` directly. A group dropped into itself or its
 * own descendant is skipped (no cycles).
 */
export function restackUnits(doc: MotionDocument, units: LayerUnit[], target: RestackTarget): void {
  let insertAt = target.trackIndex;
  const place = (clipId: string, t: RestackTarget): void => {
    if (!restackClip(doc, clipId, { ...t, trackIndex: insertAt })) return;
    const carried = locateClip(doc, clipId);
    if (carried) insertAt = carried.trackIndex + 1;
  };
  for (const unit of units) {
    if (unit.kind === "clip") {
      place(unit.id, target);
      continue;
    }
    if (target.groupId && (target.groupId === unit.id || groupAncestry(doc, target.groupId).includes(unit.id))) {
      continue; // dropping a group into itself/its descendant would cycle
    }
    const members = target.frameId ? clipsUnderGroup(doc, unit.id) : [];
    place(unit.id, target);
    if (target.frameId) {
      for (const id of members) {
        const loc = locateClip(doc, id);
        if (loc) rebaseClipToFrame(doc, loc.clip, target.frameId);
      }
      for (const track of doc.tracks) {
        if (track.groupId && groupAncestry(doc, track.groupId).includes(unit.id)) track.homeCompId = target.frameId;
      }
    }
  }
  pruneGroups(doc);
}

/**
 * A LAYER CROSSES INTO ANOTHER COMP — the position half of that move, written
 * once.
 *
 * A clip's `transform.x/y` is measured from its own comp's centre, so simply
 * repointing `frameId` teleports the artwork by however far the two comps sit
 * apart on the board. The fix is a shift of the base position and of every
 * `x`/`y` key by the centre delta, which keeps the layer exactly where it looks
 * like it is — Figma's reparenting promise.
 *
 * This used to live inside `reparentClipToFrame` alone, which made the layers
 * list's own "move this into that comp" — `restackClip` with a `frameId` — a
 * SECOND way to cross comps that skipped the shift entirely. Two rules for one
 * fact: the drag-onto-a-frame gesture kept the art still, and the
 * drag-into-a-frame-ROW gesture threw it across the board. The low-level op
 * carries it now, so every gesture that can reparent inherits it — including
 * ones nobody has written yet.
 *
 * Audio has no spatial home, and a clip whose comp is missing has nothing to
 * measure against: both just repoint.
 */
function rebaseClipToFrame(doc: MotionDocument, clip: Clip, targetFrameId: string): void {
  if (clip.kind === "audio" || clip.frameId === targetFrameId) {
    clip.frameId = targetFrameId;
    return;
  }
  const from = doc.frames.find((f) => f.id === clip.frameId);
  const to = doc.frames.find((f) => f.id === targetFrameId);
  clip.frameId = targetFrameId;
  if (!from || !to) return;
  const dx = Math.round(from.x + from.width / 2 - (to.x + to.width / 2));
  const dy = Math.round(from.y + from.height / 2 - (to.y + to.height / 2));
  if (dx === 0 && dy === 0) return;
  clip.transform.x += dx;
  clip.transform.y += dy;
  for (const kf of clip.keyframes) {
    if (kf.property !== "x" && kf.property !== "y") continue;
    const delta = kf.property === "x" ? dx : dy;
    for (const key of kf.keys) if (typeof key.value === "number") key.value += delta;
  }
}

/**
 * THE "a layer joins a frame" gesture (Figma parenting) for the CANVAS drag:
 * keep the world position, drop group membership (the old group lived in the
 * old frame), and land at the TOP of the target comp.
 *
 * The position rebase is `rebaseClipToFrame`, shared with every other way to
 * cross comps. What is specific to this gesture — and so stays here — is the
 * destination: dropping artwork onto a frame means "put it on top", because the
 * gesture carries no z information of its own. The layers list DOES carry one
 * (the gap you dropped into), so it passes its own `trackIndex` instead.
 *
 * A no-op when the target is the clip's own frame or is missing — dropping a
 * layer into the void never re-homes it.
 */
export function reparentClipToFrame(
  doc: MotionDocument,
  clipId: string,
  targetFrameId: string,
): boolean {
  const loc = locateClip(doc, clipId);
  if (!loc || loc.clip.kind === "audio" || isClipLocked(loc.track, loc.clip)) return false;
  if (loc.clip.frameId === targetFrameId) return false;
  if (!doc.frames.some((f) => f.id === targetFrameId)) return false;
  restackClip(doc, clipId, { trackIndex: 0, frameId: targetFrameId, groupId: null });
  return true;
}

/**
 * Convert a parametric shape clip into an editable path clip IN PLACE — same
 * id, timing, transform, paint, trim, layer effects and keyframes, so nothing
 * else in the document notices. Shape-geometry keyframe tracks (width, radius,
 * point count…) no longer resolve on a path and are dropped.
 */
export function convertShapeClipToPath(doc: MotionDocument, clipId: string): boolean {
  const loc = locateClip(doc, clipId);
  if (!loc || loc.clip.kind !== "shape") return false;
  loc.track.clips[loc.clipIndex] = shapeAsPath(cloneClip(loc.clip) as ShapeClip);
  return true;
}

/**
 * A shape as the path it draws — the same layer (id, look, keys but the
 * shape-only ones, placement), its outline as points. Pure: the convert verb
 * swaps it in; a bending shape is drawn through it (`rig/vector.ts`).
 */
export function shapeAsPath(c: ShapeClip, geometry: Pick<ShapeClip, "width" | "height"> & Partial<ShapeClip> = c): PathClip {
  const subpaths = commandsToSubpaths(
    shapeCommands({
      shape: c.shape,
      width: geometry.width,
      height: geometry.height,
      cornerRadius: geometry.cornerRadius ?? c.cornerRadius,
      radius: geometry.radius ?? c.radius,
      pointCount: geometry.pointCount ?? c.pointCount,
      innerRatio: geometry.innerRatio ?? c.innerRatio,
      arcStartDeg: geometry.arcStartDeg ?? c.arcStartDeg,
      arcSweepDeg: geometry.arcSweepDeg ?? c.arcSweepDeg,
      arcRatio: geometry.arcRatio ?? c.arcRatio,
      cornerOffsets: geometry.cornerOffsets ?? c.cornerOffsets,
    }),
  );
  const SHAPE_ONLY = /^(width|height|radius(\.|$)|pointCount|innerRatio)/;
  const src = c;
  const path: PathClip = {
    id: src.id,
    kind: "path",
    contourStyles: {},
    frameId: src.frameId,
    isStencil: src.isStencil,
    fps: null,
    animIn: src.animIn,
    animOut: src.animOut,
    layoutItem: src.layoutItem,
    sounds: src.sounds,
    trackBinding: src.trackBinding,
    feather: src.feather,
    borderRadius: src.borderRadius,
    crop: src.crop,
    content: src.content,
    name: src.name,
    startMs: src.startMs,
    durationMs: src.durationMs,
    // Its own copies of what the pivot re-base below writes, so the source
    // (a document clip, when a bending shape is drawn) is never touched.
    keyframes: src.keyframes
      .filter((t) => !SHAPE_ONLY.test(t.property))
      .map((t) => (t.property === "anchor.x" || t.property === "anchor.y" ? { ...t, keys: t.keys.map((k) => ({ ...k })) } : t)),
    drivers: src.drivers,
    linkGroupId: src.linkGroupId,
    mirrorId: src.mirrorId,
    origin: src.origin,
    fillDuration: src.fillDuration,
    locked: src.locked,
    hidden: src.hidden,
    audioMix: src.audioMix,
    motionBlur: src.motionBlur,
    audioEffects: src.audioEffects,
    transform: { ...src.transform },
    maxWidth: src.maxWidth,
    effects: src.effects,
    subpaths: subpaths.map(toSubpath),
    fillRule: "nonzero",
    fills: src.fills,
    strokes: src.strokes,
    opacity: src.opacity,
    blendMode: src.blendMode,
  };
  // The outline is generated about the origin, but its extent needn't match the
  // shape's declared w/h (a pie, an arc, a star with pulled corners), and the
  // PIVOT is a fraction of whichever box the clip now has. Re-base it onto the
  // new one so converting to a path is what it claims to be: a change of
  // representation that moves nothing.
  keepPivotThroughBoxChange(path, { width: geometry.width, height: geometry.height, cx: 0, cy: 0 }, pathBox(subpaths));
  return path;
}


/**
 * A clip's axis-aligned bounding box in its comp's coordinates (frame-center
 * relative — the same space as `transform.x/y`), from the BASE transform. Exact
 * for geometry/box clips; text/caption are approximated from font size + text
 * (real metrics need a canvas), which is fine for framing a group. Audio and
 * anything unmeasurable return null.
 */
/**
 * Present a nested comp as one opaque layer, or open it back up.
 *
 * The whole of "treat this as an image" — no artwork is copied, flattened or
 * re-read from its source asset, so the round trip is lossless by construction
 * and there is never a second, staler copy of the same drawing.
 */
export function setClipFlat(doc: MotionDocument, clipId: string, flat: boolean): void {
  const clip = locateClip(doc, clipId)?.clip;
  if (clip?.kind === "nested") clip.flat = flat;
}

/**
 * A group's natural box: its members' placed boxes, unioned, in the group's own
 * local space (the group transform is applied on top by the caller, exactly as
 * it is for every other kind).
 *
 * Cycle-guarded through the depth cap rather than a visited set — a group whose
 * ancestry loops has already been healed by `pruneGroups`, and paying for a Set
 * on every bounds query to defend against a state that cannot persist is the
 * wrong trade.
 */
/**
 * WHERE ONE MEMBER'S BOX ACTUALLY LANDS in its comp — the corners, through the
 * member's own placement.
 *
 * `transform.x/y` is where the layer's PIVOT sits, not where its box centre
 * sits, and the two are only the same while the pivot is centred. The union
 * below used to read `transform.x + box.cx` as the centre, which made a group's
 * size a function of its members' PIVOTS: moving a child's crosshair writes a
 * compensating x/y (so the art holds still), the union read that new x/y as a
 * move, and the group visibly grew or shrank depending on whether the pivot
 * travelled toward its centre or away from it. The artwork had not moved at
 * all.
 *
 * Rotation, scale and shear were dropped entirely too, so a turned member's
 * bounds were its unturned ones.
 *
 * A nested GROUP member is placed by the same formula with a different origin:
 * its `x/y` is a DELTA about its pivot rather than the pivot itself, so the
 * origin is `pivot + delta`. One expression, both models — see `group-space.ts`
 * for why the two exist.
 */
export function memberCorners(
  clip: Clip,
  box: LayerBox,
  /** The placement to use — the clip's own, or the one SAMPLED at an instant
   *  (see `groupBoxWith`). Both go through this one formula. */
  placed?: Transform,
): Array<{ x: number; y: number }> {
  if (clip.kind === "audio") return [];
  const hw = box.width / 2;
  const hh = box.height / 2;
  return [
    { x: box.cx - hw, y: box.cy - hh },
    { x: box.cx + hw, y: box.cy - hh },
    { x: box.cx + hw, y: box.cy + hh },
    { x: box.cx - hw, y: box.cy + hh },
  ].map(memberPlace(clip, box, placed));
}

/** The member's placement as a point map, own space → its parent's — the formula `memberCorners` applies to the corners. */
function memberPlace(clip: Clip, box: LayerBox, placed?: Transform): (q: { x: number; y: number }) => { x: number; y: number } {
  if (clip.kind === "audio") return (q) => q;
  const t = placed ?? clip.transform;
  const pivot = anchorLocal(t.anchor, box);
  const origin =
    clip.kind === "group" ? { x: pivot.x + t.x, y: pivot.y + t.y } : { x: t.x, y: t.y };
  const basis = basisOfTransform(t, box);
  return (q) => {
    const d = mapLinear(q.x - pivot.x, q.y - pivot.y, basis);
    return { x: origin.x + d.x, y: origin.y + d.y };
  };
}

/**
 * WHAT A MEMBER OCCUPIES BEYOND ITS PLACED BOX, at an instant — for members
 * that something other than their own transform carries. A rig's bones are
 * the one such thing (rig/bind): a piece riding a bone gains the bone's skin
 * (`after`, in the PARENT's member space), and art that bends occupies its
 * bent silhouette (`local`: points of its own space, flat x,y pairs, placed by
 * the member's transform like the corners would be).
 */
export interface MemberShape {
  local?: readonly number[];
  after?: readonly [number, number, number, number, number, number];
}
export type MemberShaping = (clip: Clip) => MemberShape | null;

/**
 * WHERE A MEMBER IS AT ONE INSTANT — its sampled placement, or null when it is
 * not on screen then. Supplied by `timeline/group-bounds.ts`; `undefined` here
 * means the AUTHORED box, which is the reading every pivot is a fraction of.
 *
 * This callback is the whole of the live/authored split. One reducer, two
 * clocks — the same shape `flattenClipsToPath` uses for the silhouette, so a
 * group's outline and its box can never be measured at two different instants.
 */
export type MemberPlacement = (clip: Clip) => Transform | null;

function groupNaturalSize(
  doc: MotionDocument,
  group: Clip,
  depth = 0,
  placement?: MemberPlacement,
  shaping?: MemberShaping,
): LayerBox | null {
  if (depth > 32 || group.kind !== "group") return null;
  // The AUTHORED box is the members at REST: measured in the stored document a
  // bake came from, never in the values the bake wrote. Keys never touch
  // `transform`, drivers and poses write into it — so without this a member
  // panned by an expression dragged its parent's pivot along, and the same pan
  // keyed left it still. One rule now, however the motion is made.
  if (!placement && !shaping) doc = storedDocumentOf(doc);
  // A laid-out group DECLARES its box (relations/layout.ts): the members are
  // derived from it, not the other way round.
  if (group.layout) return layoutBoxOf(doc, group, depth);
  // The AUTHORED box is a pure function of an immutable document, and every
  // pivot, binding and bounds question asks it — a rig asks it of each group
  // between the rig and every part, per frame. Remembered per document.
  const authored = !placement && !shaping && isSettledDocument(doc);
  if (authored) {
    const memo = authoredGroupBoxes.get(doc)?.get(group.id);
    if (memo !== undefined) return memo;
  }
  const box = measureGroup(doc, group, depth, placement, shaping);
  if (authored) {
    let per = authoredGroupBoxes.get(doc);
    if (!per) authoredGroupBoxes.set(doc, (per = new Map()));
    per.set(group.id, box);
  }
  return box;
}

const authoredGroupBoxes = new WeakMap<MotionDocument, Map<string, LayerBox | null>>();

function measureGroup(
  doc: MotionDocument,
  group: Clip,
  depth: number,
  placement?: MemberPlacement,
  shaping?: MemberShaping,
): LayerBox | null {
  const rows = tracksInGroup(doc, group.id).filter((t) => !(placement && t.hidden));
  return measureMembers(doc, rows.map((t) => t.clips), depth, placement, shaping);
}

/**
 * THE BOX AROUND SOME LAYERS as they are placed (`placement`) and carried
 * (`shaping`: a rig's skin, a bent silhouette) — in the space they are written
 * in. A group's box is its members'; `layersBoxWith` asks it of any layers.
 */
export function layersBoxWith(doc: MotionDocument, clips: readonly Clip[], placement?: MemberPlacement, shaping?: MemberShaping): LayerBox | null {
  return measureMembers(doc, [clips], 0, placement, shaping);
}

function measureMembers(
  doc: MotionDocument,
  rows: ReadonlyArray<readonly Clip[]>,
  depth: number,
  placement?: MemberPlacement,
  shaping?: MemberShaping,
): LayerBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const clips of rows) {
    for (const clip of clips) {
      // A processor has no box of its own — it would size the group to the comp.
      if (clip.kind === "audio" || clip.kind === "adjustment") continue;
      const placed = placement ? placement(clip) : clip.transform;
      // Not on screen at this instant: not part of what the group IS right now.
      if (!placed) continue;
      const box =
        clip.kind === "group"
          ? groupNaturalSize(doc, clip, depth + 1, placement, shaping)
          : clipNaturalSize(doc, clip);
      if (!box) continue;
      const shape = shaping?.(clip);
      let pts = memberCorners(clip, box, placed);
      if (shape?.local) {
        const place = memberPlace(clip, box, placed);
        pts = [];
        for (let i = 0; i + 1 < shape.local.length; i += 2) pts.push(place({ x: shape.local[i]!, y: shape.local[i + 1]! }));
      }
      if (shape?.after) {
        const [a, b, c, d, e, f] = shape.after;
        pts = pts.map((p) => ({ x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f }));
      }
      for (const c of pts) {
        minX = Math.min(minX, c.x);
        maxX = Math.max(maxX, c.x);
        minY = Math.min(minY, c.y);
        maxY = Math.max(maxY, c.y);
      }
    }
  }
  if (!Number.isFinite(minX)) return null;
  return {
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  };
}

/**
 * THE GROUP'S BOX AS IT IS RIGHT NOW — its members placed by the values they
 * actually wear at this instant, with the ones that have not started (or have
 * ended) left out.
 *
 * A group is the only layer whose size is DERIVED from other layers, so it is
 * the only one whose size can be wrong about time — and it was. `clipBox` reads
 * the base transforms, which is the box the group had before anything animated:
 * keyframe a member across the frame and the selection box, the gizmo and the
 * W/H readout all stayed welded to where the artwork used to be.
 *
 * Two readings of one reducer, and the difference is deliberate:
 *
 *   AUTHORED (`clipBox`)  what the PIVOT is a fraction of. It must not follow
 *                         the animation, or the point the group rotates about
 *                         would crawl as its members move and the artwork would
 *                         drift — the defect `memberCorners` documents.
 *   LIVE (this)           what is ON SCREEN. Selection chrome, hit testing and
 *                         anything that describes the picture.
 *
 * After Effects draws the same line: a shape group's bounds are per-frame, its
 * anchor point is authored.
 *
 * NOT the renderer's `groupMembersExtent`, which is the rectangle the group
 * INKS — every member's extent padded by its own glow, stroke and blur bleed —
 * and is what an isolation buffer has to be big enough to hold. A box and an
 * inked extent are different facts (see `clipLocalGeometry`), and a selection
 * box drawn around the bleed would be a box around a shadow.
 */
export function groupBoxWith(doc: MotionDocument, group: Clip, placement: MemberPlacement, shaping?: MemberShaping): LayerBox | null {
  return groupNaturalSize(doc, group, 0, placement, shaping);
}

/**
 * A clip's NATURAL box — its own size in local (pre-transform) units, plus the
 * offset of that box's center from the layer's local origin (non-zero only for
 * a path, whose outline needn't be centered on 0,0).
 *
 * THE per-kind size answer for the whole app: bounds, snapping, the pivot (which
 * is a fraction of this box) and the crop window all read it, so a new clip kind
 * declares its size here once. Text is an ESTIMATE — real text size needs font
 * metrics the headless core has no access to, so surfaces that have measured a
 * layout (the renderer) pass their own size to the pivot math instead of this.
 */
export function clipNaturalSize(doc: MotionDocument, clip: Clip): LayerBox | null {
  if (clip.kind === "audio") return null;
  if (clip.kind === "text" && clip.path) {
    // A text on a path has the HOST's box: its transform is the host's, so its
    // pivot must be a fraction of the same rectangle or the two would turn about
    // different points. A host that cannot be found leaves it a plain text.
    const host = locateClip(doc, clip.path.hostClipId)?.clip;
    if (host && (host.kind === "shape" || host.kind === "path") && host.frameId === clip.frameId) {
      return clipNaturalSize(doc, host);
    }
  }
  if (clip.kind === "shape") return { width: clip.width, height: clip.height, cx: 0, cy: 0 };
  if (clip.kind === "path") {
    // An outline that has wandered off its origin keeps its CENTRE in the box —
    // that offset is what makes the pivot land on the art (see pivot.ts).
    return clip.subpaths.length === 0 ? null : pathBox(clip.subpaths);
  }
  if (clip.kind === "image" || clip.kind === "video") {
    const a = doc.assets.find((x) => x.id === clip.assetId);
    const fallback = clip.kind === "image" ? { w: 320, h: 180 } : { w: 640, h: 360 };
    return { width: a?.width ?? fallback.w, height: a?.height ?? fallback.h, cx: 0, cy: 0 };
  }
  if (clip.kind === "nested") {
    const s = doc.frames.find((f) => f.id === clip.sourceFrameId);
    return { width: s?.width ?? 100, height: s?.height ?? 100, cx: 0, cy: 0 };
  }
  if (clip.kind === "waveform") {
    return { width: clip.style.width, height: clip.style.height, cx: 0, cy: 0 };
  }
  if (clip.kind === "raster") {
    return { width: Math.max(1, clip.width), height: Math.max(1, clip.height), cx: 0, cy: 0 };
  }
  if (clip.kind === "trace") {
    // A trace's own box is its PEN — the point its position names. The line
    // it draws is comp-space and measured per instant (`traceBounds`).
    return { width: TRACE_PEN_BOX, height: TRACE_PEN_BOX, cx: 0, cy: 0 };
  }
  if (clip.kind === "group") {
    // A group's natural box is the UNION of what it holds, placed. It has no
    // size of its own — a group that reported one would let a resize handle
    // claim to be scaling something that does not exist, and the members would
    // drift out of the box the moment any of them moved.
    return groupNaturalSize(doc, clip);
  }
  if (clip.kind === "mesh" || clip.kind === "camera" || clip.kind === "light" || clip.kind === "empty") {
    // A 3D object has no 2D box — it lives in a world, where its extent is
    // its evaluated geometry (`world/evaluate`). A nominal square keeps every
    // box-reading surface finite should one ever ask.
    return { width: 100, height: 100, cx: 0, cy: 0 };
  }
  if (clip.kind === "adjustment") {
    // A processor has no intrinsic box — it spans its whole comp.
    const f = doc.frames.find((fr) => fr.id === clip.frameId);
    return { width: f?.width ?? 100, height: f?.height ?? 100, cx: 0, cy: 0 };
  }
  // text — the one kind whose box has to be MEASURED. The app installs
  // a measurer (`setTextBoxMeasurer`) that lays the glyphs out in the real font
  // with the same engine that paints them, so a headless caller and the picture
  // agree about how wide a word is. See text/measure.ts for what disagreeing
  // used to cost — chiefly a pivot drag that slid the text sideways.
  const measured = measuredTextBox(doc, clip);
  if (measured) return measured;
  // No measurer (a worker, a test, an export before fonts are up): fall back to
  // an approximation from font size + longest line. Deliberately crude — it is
  // the answer of last resort, not a second opinion.
  const fs = resolveNumber(doc, clip.style.fontSize, 96);
  const lines = clip.text.split("\n");
  const maxLen = Math.max(1, ...lines.map((l) => l.length));
  return {
    width: clip.maxWidth ?? Math.min(maxLen * fs * 0.6, fs * 40),
    height: Math.max(1, lines.length) * fs * 1.3,
    cx: 0,
    cy: 0,
  };
}

/**
 * The box every pivot, gizmo and bound is measured against — `clipNaturalSize`
 * with the one fallback the whole app used to spell out at each call site (a
 * dozen copies of `?? { width: 100, height: 100 }`, which is a dozen chances to
 * disagree about a sizeless layer). Audio has no box and never asks.
 */
export function clipBox(doc: MotionDocument, clip: Clip): LayerBox {
  return clipNaturalSize(doc, clip) ?? { width: 100, height: 100, cx: 0, cy: 0 };
}

/**
 * A TEXT LAYER'S PIVOT HOLDS ITS POINT THROUGH EVERY CONTENT EDIT — enforced
 * once, for every write, by the document store (see `history/document-store`).
 *
 * A pivot is stored as a FRACTION of the layer's box, and a text layer's box is
 * measured from its own glyphs: type a letter, pick a font, change the size,
 * the weight, the tracking or the case of an auto-width layer and the box is a
 * different size, so the same fraction is a different point, so the words
 * slide. Invisible with the default centred pivot (the fraction of any box is
 * the same point), and growing with how far off-centre the pivot sits — which
 * is why "the text drifts once I've moved its pivot" was one bug, not a family.
 *
 * It used to be a seam each caller had to remember (`editTextGeometry`), and
 * two did: typing on the canvas and the caption rows. The inspector's Text
 * field, every typography control, the Fonts window, paste-properties and the
 * agent API did not, so each of them slid the words. A rule every write must
 * obey belongs where every write passes, so it is a pass over the draft after
 * the recipe — like transition re-anchoring — and a write nobody has written
 * yet obeys it too.
 *
 * The rule is core's existing one, stated in transform-map.ts: **content edits
 * keep the point, box edits keep the fraction.** So it stands aside when the
 * write changed the box itself (`maxWidth`/`maxHeight`, a path host) — a pivot
 * on a corner stays welded to that corner through a resize — and when it wrote
 * the pivot (a pivot drag, a pasted transform, an undo-shaped write).
 *
 * Cheap where it matters: immer's `current` hands back the ORIGINAL for any
 * subtree the recipe did not modify, so an edit that touched no text pays one
 * identity check per lane, and only a text clip whose text, style or ranges
 * actually changed is measured.
 */
export function holdTextPivots(draft: MotionDocument): void {
  if (!isDraft(draft)) return;
  const was = original(draft)!;
  // A recipe may hand back plain objects anywhere (a rebuilt lane list, a lane
  // spliced in), so every level is read through `snap`, never `current` alone.
  const now = snap(draft.tracks);
  if (now === was.tracks) return;
  const lanes = new Set(was.tracks);
  let clips: Set<Clip> | null = null;
  let before: Map<string, Clip> | null = null;
  for (let ti = 0; ti < now.length; ti++) {
    const lane = snap(now[ti]!);
    if (lanes.has(lane)) continue;
    for (let ci = 0; ci < lane.clips.length; ci++) {
      const next = snap(lane.clips[ci]!);
      if (next.kind !== "text") continue;
      // An unmodified clip comes back as the very object it was.
      clips ??= new Set(was.tracks.flatMap((t) => t.clips));
      if (clips.has(next)) continue;
      before ??= new Map(was.tracks.flatMap((t) => t.clips.map((c) => [c.id, c] as const)));
      const prev = before.get(next.id);
      if (!prev || prev.kind !== "text") continue;
      if (prev.text === next.text && prev.style === next.style && prev.ranges === next.ranges) continue;
      if (prev.maxWidth !== next.maxWidth || prev.maxHeight !== next.maxHeight || prev.path !== next.path) continue;
      if (prev.transform.anchor !== next.transform.anchor || (prev.keyframes !== next.keyframes && anchorKeysDiffer(prev, next))) continue;
      const target = draft.tracks[ti]!.clips[ci]!;
      if (target.kind === "text") keepPivotThroughBoxChange(target, clipBox(was, prev), clipBox(draft, next));
    }
  }
}

/** A draft's present value (the original itself when unmodified); a plain value as is. */
function snap<T>(value: T): T {
  return isDraft(value) ? (current(value) as T) : value;
}

function anchorKeysDiffer(a: Clip, b: Clip): boolean {
  const keys = (c: Clip) => c.keyframes.filter((t) => !t.range && (t.property === "anchor.x" || t.property === "anchor.y"));
  const ka = keys(a);
  const kb = keys(b);
  return ka.length !== kb.length || ka.some((t, i) => t !== kb[i]);
}

export function clipFrameBounds(doc: MotionDocument, clip: Clip): Bounds | null {
  if (clip.kind === "audio") return null;
  const t = clip.transform;
  const sx = t.scale;
  const sy = t.scaleY == null ? t.scale : t.scaleY;

  const nat = clipNaturalSize(doc, clip);
  if (!nat) return null;
  // WHAT PAINTS is the crop window, not the box — the renderer measures its
  // buffers the same way (`cropWindow`). The pivot stays a fraction of the BOX,
  // so cropping never moves the pixels that are left. Measured from the box,
  // a cropped picture's bounds included what the crop removed, and an agent
  // placing one by its bounds saw it "shift" by half the uneven inset.
  const win = clip.kind !== "group" && "crop" in clip && clip.crop ? cropWindow(clip.crop, nat) : nat;
  const hw = win.width / 2;
  const hh = win.height / 2;
  const ox = win.cx;
  const oy = win.cy;
  // The pivot is where `t.x/y` sits; geometry is laid out about the box center,
  // so everything is measured relative to the pivot (zero for a centered one).
  const anchor = anchorLocal(t.anchor, nat);
  // A GROUP's x/y is a DELTA about its pivot (`positionOrigin`, group-space):
  // its box sits where its members are and the delta moves it from there. A
  // leaf's x/y IS its pivot. Without this a group measured as a box centred on
  // its delta — the comp centre for an unmoved group — and everything that
  // asks (layers.list, snapping, grouping a group, a library snapshot) put the
  // group somewhere its art is not.
  const origin = clip.kind === "group" ? anchor : { x: 0, y: 0 };

  // Rotate the local box corners, then place at the transform. Scale folds in.
  const rad = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [dx, dy] of [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ] as const) {
    const lx = (ox + dx - anchor.x) * sx;
    const ly = (oy + dy - anchor.y) * sy;
    const wx = t.x + origin.x + lx * cos - ly * sin;
    const wy = t.y + origin.y + lx * sin + ly * cos;
    minX = Math.min(minX, wx);
    minY = Math.min(minY, wy);
    maxX = Math.max(maxX, wx);
    maxY = Math.max(maxY, wy);
  }
  return { minX, minY, maxX, maxY };
}

/** A group whose rig or poses place its members (a character): its stored bounds are not where it shows. */
function movesItsOwnArt(clip: Clip): boolean {
  return clip.kind === "group" && !!(clip.rig?.bones.length || clip.poses?.length || clip.behaviors?.length);
}

/**
 * "Make nested clip" — precompose: move the given clips (all from one comp)
 * into a NEW frame and put one nested clip where they were. Track carriers are
 * untouched (z-order survives) and clip times re-base to the earliest start.
 *
 * The new comp is AUTO-SIZED to the members' content bounds (Figma "frame
 * selection"), not the parent's size — so the nested clip is a normal,
 * content-sized layer that drags and resizes like any other, never a fake
 * parent-sized rectangle. Members re-center on the content, the nested clip is
 * offset by the same amount, and its background is transparent — so pixels don't
 * move. Falls back to the parent's size if nothing measurable is selected.
 * Returns the nested clip's id, or null.
 */
export function nestClips(
  doc: MotionDocument,
  clipIds: string[],
  name?: string,
  /**
   * `fullFrame`: the new comp is the PARENT's size and the nested clip sits at
   * identity, so the two are pixel-for-pixel the same picture with no offset —
   * what a render in place needs to hand the original back inside a wrapper
   * that carries the render's own edits verbatim.
   */
  opts: {
    fullFrame?: boolean;
    /**
     * `wholeComp`: the wrapper IS the comp, in time as well as space — members
     * keep their own times (the nested clip starts at 0 and spans the comp)
     * and locked layers come along too, because leaving one behind would split
     * the picture. What a mode switch needs to hand a whole timeline to a
     * flipbook as its first frame (see `setFrameMode`). Implies `fullFrame`.
     */
    wholeComp?: boolean;
  } = {},
): string | null {
  const located = clipIds
    .map((id) => locateClip(doc, id))
    .filter((l): l is NonNullable<typeof l> => l !== null && (opts.wholeComp || !isClipLocked(l.track, l.clip)));
  if (located.length === 0) return null;
  const frameId = located[0]!.clip.frameId;
  const members = located.filter((l) => l.clip.frameId === frameId);
  if (members.length === 0) return null;
  const parent = doc.frames.find((f) => f.id === frameId);
  if (!parent) return null;

  const measured = groupPlan(doc, members.map((l) => l.clip), parent);
  const plan: GroupPlan = opts.wholeComp
    ? { minStart: 0, maxEnd: Math.max(measured.maxEnd, compDurationMs(doc, frameId)), width: parent.width, height: parent.height, cx: 0, cy: 0 }
    : opts.fullFrame || parent.world || members.some((l) => movesItsOwnArt(l.clip))
      ? // A WORLD's content keeps its place: the new comp is a world of the
        // parent's size and the instance stands at its origin, so every object
        // is where it was (a world has no 2D bounds to centre on). A CHARACTER
        // too: its rig and poses put its art somewhere its stored transforms
        // do not say (a posed root bone carries the body across the frame), so
        // a comp sized to those bounds cut the character out of itself.
        { ...measured, width: parent.width, height: parent.height, cx: 0, cy: 0 }
      : measured;

  // NAME INHERITS. "Nested clip" told you the mechanism and nothing about the
  // artwork — open an SVG called `logo.svg` and it became "Nested clip", which
  // is the app describing its own plumbing back at you. A caller's name wins;
  // otherwise the topmost member's, which is the layer you were looking at.
  const inheritedName =
    name ||
    members.reduce((best, l) => (l.trackIndex < best.trackIndex ? l : best), members[0]!).clip.name ||
    "Group";
  const source = createGroupFrame(doc, parent, inheritedName, plan);
  // 3D content stays 3D: the comp it moves to is a world with the parent's look.
  // (A JSON copy: inside an edit the parent is a draft, which structuredClone refuses.)
  if (parent.world) source.world = JSON.parse(JSON.stringify(parent.world)) as typeof parent.world;
  doc.frames.push(source);

  // Every member re-homes — and everything INSIDE a member group with it, on
  // the same shift, since a group's contents share its comp and its space.
  // The members then leave whatever group rows they sat on for the new comp's
  // top level; a nested group's own rows come along by naming it.
  const memberIds = members.map((l) => l.clip.id);
  for (const id of expandToDescendants(doc, memberIds)) {
    const l = locateClip(doc, id);
    if (l) rebaseIntoGroup(l.clip, source.id, plan);
  }
  const topIndex = Math.min(...members.map((l) => l.trackIndex));
  const hostTrack = doc.tracks[topIndex]!;
  const hostScope = hostTrack.groupId;
  moveClipsToScope(doc, memberIds, null, { at: doc.tracks.length, frameId: source.id });
  // A WORLD ALONE still needs a lens and light: copies of the parent's
  // cameras and lights go with it, so the new comp previews as it looked.
  // An instance of it never brings them back (`evaluateWorld` leaves an
  // instance's cameras and lights home) — the world it stands in lights it.
  if (parent.world && !opts.wholeComp) {
    const moving = new Set(expandToDescendants(doc, memberIds));
    for (const track of [...doc.tracks]) {
      if (track.groupId) continue;
      for (const c of track.clips) {
        if (c.frameId !== frameId || moving.has(c.id) || (c.kind !== "camera" && c.kind !== "light")) continue;
        const copy = reissueClipIds(c);
        copy.frameId = source.id;
        copy.startMs = 0;
        copy.durationMs = Math.max(50, plan.maxEnd - plan.minStart);
        const carrier = createCarrierTrack(copy.name, source.id);
        addClipToTrack(carrier, copy);
        doc.tracks.push(carrier);
      }
    }
  }

  const nested = createNestedClip({
    frameId,
    sourceFrameId: source.id,
    startMs: plan.minStart,
    durationMs: Math.max(50, plan.maxEnd - plan.minStart),
    name: inheritedName,
    x: plan.cx,
    y: plan.cy,
  });

  // Land the nested clip on the topmost member's lane if it is still there
  // with room, else a fresh carrier at that z, in the scope the members left.
  const hostAt = doc.tracks.indexOf(hostTrack);
  if (hostAt >= 0 && hostTrack.groupId === hostScope && !hostTrack.locked && fitsInTrack(hostTrack, null, nested.startMs, nested.durationMs, frameId)) {
    addClipToTrack(hostTrack, nested);
    sortTrackClips(hostTrack);
  } else {
    const carrier = createCarrierTrack(inheritedName, null, hostScope);
    addClipToTrack(carrier, nested);
    doc.tracks.splice(Math.max(0, Math.min(hostAt >= 0 ? hostAt : topIndex, doc.tracks.length)), 0, carrier);
  }
  pruneGroups(doc);
  return nested.id;
}

/**
 * Paint order → z order: the one conversion between "how artwork is drawn" and
 * "how layers are stacked", and the reason it has a name.
 *
 * A path's `subpaths` are painted front to back in list order, so the FIRST
 * contour is the BOTTOM of the picture. Every clip-placement primitive here
 * (`replaceClipInPlace`, `nestNewClips`) takes its clips topmost-first. The two
 * lists therefore run in opposite directions, and handing one to the other is
 * not a style choice — it silently inverts the artwork.
 *
 * That was the split bug: separating a drawn outline with three lines across it
 * put the outline's own region on TOP, so its fill covered the lines it was
 * drawn behind, and the only way back was to drag the layer down by hand.
 * `mergeVectorClips` already states the same rule from the other side ("the
 * BOTTOM lane paints first, so it leads the list") — with this, split and merge
 * are finally the round trip they are documented to be.
 */
export function stackPaintOrder<T>(pieces: ReadonlyArray<T>): T[] {
  return [...pieces].reverse();
}

/**
 * Group clips that are NOT IN THE DOCUMENT YET.
 *
 * `nestClips` can only group what it can already find in a comp, so every
 * caller that BUILDS artwork — SVG import, and separating a path into pieces —
 * had to stage its new clips in the parent first, purely so the grouping op
 * could locate them. That staging created a lane per piece in the parent, moved
 * every piece straight back out of it, and then pruned the lanes it had just
 * made. You saw the wreckage: a row of empty "zombie" lanes in the root
 * timeline whenever the prune missed one, and an undo history with a state in
 * it that was never anyone's intent.
 *
 * The clips are placed once, in their final home. Carriers are born inside the
 * group, the group takes `slotClipId`'s own slot, and no parent lane is ever
 * created only to be destroyed. Same geometry as `nestClips` — both read
 * `groupPlan`, so the two placements can never drift on where the pixels land.
 *
 * The inner carriers are inserted directly BELOW the group's lane, which is
 * also where the timeline draws them when you expand it.
 */
export function nestNewClips(
  doc: MotionDocument,
  parentFrameId: string,
  clips: Clip[],
  opts: { name?: string; slotClipId?: string } = {},
): string | null {
  if (clips.length === 0) return null;
  const parent = doc.frames.find((f) => f.id === parentFrameId);
  if (!parent) return null;

  const plan = groupPlan(doc, clips, parent);
  const groupName = opts.name || clips[0]!.name || "Group";
  const source = createGroupFrame(doc, parent, groupName, plan);
  doc.frames.push(source);

  // Below the slot, in the order given — `clips[0]` ends up topmost, matching
  // `replaceClipInPlace`, so a caller's z-order means the same thing whether it
  // groups its clips or lays them out flat.
  const slot = opts.slotClipId ? locateClip(doc, opts.slotClipId) : null;
  const base = slot ? slot.trackIndex + 1 : doc.tracks.length;
  let at = base;
  for (const clip of clips) {
    rebaseIntoGroup(clip, source.id, plan);
    const carrier = createCarrierTrack(clip.name, source.id);
    addClipToTrack(carrier, clip);
    doc.tracks.splice(at, 0, carrier);
    at += 1;
  }

  const nested = createNestedClip({
    frameId: parentFrameId,
    sourceFrameId: source.id,
    startMs: plan.minStart,
    durationMs: Math.max(50, plan.maxEnd - plan.minStart),
    name: groupName,
    x: plan.cx,
    y: plan.cy,
  });

  if (slot) {
    // The slot IS the layer being replaced, so the group inherits its lane and
    // its z — converting a layer is not permission to restack the timeline.
    replaceClipInPlace(doc, slot.clip.id, [nested]);
  } else {
    const carrier = createCarrierTrack(groupName, parentFrameId);
    addClipToTrack(carrier, nested);
    doc.tracks.splice(base, 0, carrier);
  }
  pruneGroups(doc);
  return nested.id;
}

/**
 * The geometry and timing of a grouping: how big the comp must be, where its
 * content sits relative to the parent, and the span it covers.
 *
 * Pure, and deliberately ignorant of where the members currently live — that is
 * the whole reason `nestClips` (clips already in a comp) and `nestNewClips`
 * (clips being born) can share it instead of each carrying a copy of the
 * bounds math that would drift the first time one was fixed.
 *
 * The comp is AUTO-SIZED to the members' content bounds (Figma "frame
 * selection"), not the parent's size — so the group is a normal, content-sized
 * layer that drags and resizes like any other, never a fake parent-sized
 * rectangle. Falls back to the parent's size if nothing measurable is selected.
 */
export interface GroupPlan {
  minStart: number;
  maxEnd: number;
  width: number;
  height: number;
  /** Content center, relative to the PARENT frame's center. */
  cx: number;
  cy: number;
}

export function groupPlan(doc: MotionDocument, clips: readonly Clip[], parent: Frame): GroupPlan {
  const minStart = Math.min(...clips.map((c) => c.startMs));
  const maxEnd = Math.max(...clips.map((c) => clipEnd(c)));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of clips) {
    const b = clipFrameBounds(doc, c);
    if (!b) continue;
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  const measured = Number.isFinite(minX);
  return {
    minStart,
    maxEnd,
    width: Math.round(measured ? Math.max(1, maxX - minX) : parent.width),
    height: Math.round(measured ? Math.max(1, maxY - minY) : parent.height),
    cx: measured ? Math.round((minX + maxX) / 2) : 0,
    cy: measured ? Math.round((minY + maxY) / 2) : 0,
  };
}

/** The comp a group lives in — sized, placed and seeded from its parent. */
function createGroupFrame(doc: MotionDocument, parent: Frame, name: string, plan: GroupPlan): Frame {
  return createFrame({
    name,
    width: plan.width,
    height: plan.height,
    background: "#00000000", // transparent — the parent shows through
    // A precomposed comp must never crop its members (they may extend past the
    // measured bounds via effects/overflow, and precompose promises the pixels
    // don't move), so it opts out of the default artboard clipping.
    overflow: 1,
    x: parent.x,
    y: parent.y + parent.height + 160,
    // Precomposed comps live on the auto "Nested" page — out of the way of
    // the page being designed, still fully editable from its own timeline.
    pageId: internalPageId(doc),
    // Born on the PARENT's grid. Precompose promises the pixels don't move, and
    // that promise has to cover the grid the author is snapping and stepping
    // on too: precomposing inside a 12fps sheet must not hand back a 30fps comp.
    // A seed, not a link — the new comp owns its rate and can change it freely.
    fps: frameFps(doc, parent),
    // …and on the parent's SHUTTER, for the identical reason. The two are one
    // fact: an angle is a fraction of a frame interval. Precomposing a moving
    // layer out of a comp whose master is off must not hand it back blurring,
    // and out of one whose master is on must not hand it back sharp — either
    // way the pixels would move, which is the one thing precompose promises
    // they never do.
    motionBlur: parent.motionBlur,
  });
}

/**
 * Re-home one clip into a group: its comp, its time re-based to the group's
 * start, and its pose re-centered on the content (base transform AND every x/y
 * keyframe shift together, or an animated layer would jump the moment it
 * played).
 */
function rebaseIntoGroup(clip: Clip, sourceFrameId: string, plan: GroupPlan): void {
  clip.frameId = sourceFrameId;
  clip.startMs -= plan.minStart;
  if (clip.kind === "audio") return;
  // A GROUP's transform is a DELTA about its members (0 = where they stand),
  // and its members are re-homed on the same shift as everything else — so
  // shifting the group too moved its whole content twice (a character
  // precomposed into a component slid half out of its own comp).
  if (clip.kind !== "group") {
    // The plan's centre is already whole pixels; subtracting it keeps a layer's
    // own sub-pixel position rather than rounding it away.
    clip.transform.x -= plan.cx;
    clip.transform.y -= plan.cy;
    for (const kf of clip.keyframes) {
      if (kf.property !== "x" && kf.property !== "y") continue;
      const shift = kf.property === "x" ? plan.cx : plan.cy;
      for (const key of kf.keys) if (typeof key.value === "number") key.value -= shift;
    }
    return;
  }
  if (!plan.cx && !plan.cy) return;
  // A character moves with its art: root bones are written in the members'
  // space (a child's rest is its parent's frame, so it follows), and a pose
  // that sets where a part STANDS (`x`, `y`) names a place in that space too.
  for (const bone of clip.rig?.bones ?? []) {
    if (bone.parent) continue;
    bone.rest.x -= plan.cx;
    bone.rest.y -= plan.cy;
  }
  for (const set of clip.poses ?? [])
    for (const pose of set.poses)
      for (const v of pose.values) if ((v.path === "x" || v.path === "y") && typeof v.value === "number") v.value -= v.path === "x" ? plan.cx : plan.cy;
}
