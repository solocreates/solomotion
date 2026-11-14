import { createGroupClip, createTrack } from "../factories";
import { isSettledDocument } from "./settled";
import type { MotionDocument, Clip, GroupClip, Track, Transition, VisualClip } from "../schema";
import { addClipToTrack, fitsInTrack, locateClip, pruneTrackIfEmptied, removeClipFromTrack, sortTrackClips } from "./ops";

/**
 * LAYER GROUPS — one layer that happens to contain others.
 *
 * A group is a CLIP (`kind: "group"`, see `groupClipSchema`), so it has an
 * identity, a span, a transform, paint, effects and keyframes like anything
 * else on the timeline. CONTAINMENT IS THE ROW: a group's interior is the set
 * of tracks whose `groupId` names it, and a clip is in a group because it sits
 * on one of those rows. There is no membership field on a clip, so "which
 * group is this in" is one read off the clip's track, and every op that puts a
 * clip on a track has decided its group in the same motion.
 *
 * A group clip itself sits on an ordinary lane of its PARENT scope — the comp's
 * lanes, or the enclosing group's rows — so a group's ancestry is the chain
 * `track.groupId → that group's track.groupId → … → null`, and nesting needs
 * no code of its own.
 *
 * Before v71 membership lived on the clip and the group's rows were whatever
 * lanes sat beneath the group's own lane, kept contiguous by a compaction pass.
 * The lane had become the group; this file spent most of its length keeping
 * that fiction honest. Z-ORDER now lives in `layer-tree.ts` and is simply: a
 * group node sits at its clip's lane, and its children sort by THEIR rows'
 * order among that group's rows.
 */

/* ------------------------------------------------------------------ index */

/** Where every clip sits and what every group is, computed once per call. */
interface ScopeIndex {
  clip: Map<string, Clip>;
  /** The track each clip is on. */
  trackOf: Map<string, Track>;
  group: Map<string, GroupClip>;
  /** The tracks directly inside each group (`null` = the comp level), in document order. */
  tracksIn: Map<string | null, Track[]>;
  /** `clipsUnderGroup`, filled as it is asked. */
  under: Map<string, string[]>;
}

/**
 * Memoised per IMMUTABLE document. The renderer asks about ancestry for every
 * stroke-only path on every frame (the fill cascade, the draw-on read-through),
 * and rebuilding a map of every clip per question made that O(n²) per frame.
 * Only a FROZEN document is cached: immer freezes every snapshot it hands the
 * store, and frozen is the one property that makes staleness impossible. A
 * draft mid-mutation, or a plain object an op is editing in place, is never
 * frozen and is simply indexed again.
 */
const indexMemo = new WeakMap<MotionDocument, ScopeIndex>();

function scopeIndex(doc: MotionDocument): ScopeIndex {
  const cacheable = isSettledDocument(doc);
  if (cacheable) {
    const hit = indexMemo.get(doc);
    if (hit) return hit;
  }
  const clip = new Map<string, Clip>();
  const trackOf = new Map<string, Track>();
  const group = new Map<string, GroupClip>();
  const tracksIn = new Map<string | null, Track[]>();
  for (const track of doc.tracks) {
    const key = track.groupId ?? null;
    const list = tracksIn.get(key);
    if (list) list.push(track);
    else tracksIn.set(key, [track]);
    for (const c of track.clips) {
      clip.set(c.id, c);
      trackOf.set(c.id, track);
      if (c.kind === "group") group.set(c.id, c);
    }
  }
  const index = { clip, trackOf, group, tracksIn, under: new Map<string, string[]>() };
  if (cacheable) indexMemo.set(doc, index);
  return index;
}

/** A group's ancestry from `groupId` outward, innermost first (cycle-guarded). */
function ancestryFrom(index: ScopeIndex, groupId: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let g = groupId;
  while (g && !seen.has(g) && index.group.has(g)) {
    seen.add(g);
    out.push(g);
    g = index.trackOf.get(g)?.groupId ?? null;
  }
  return out;
}

/* --------------------------------------------------------------- lookups */

/** Is this clip a group? The one narrowing every surface shares. */
export function isGroupClip(clip: Clip | null | undefined): clip is GroupClip {
  return clip?.kind === "group";
}

/** The group clip with this id, or null. */
export function groupClipById(doc: MotionDocument, groupId: string | null): GroupClip | null {
  if (!groupId) return null;
  for (const track of doc.tracks) {
    for (const clip of track.clips) if (clip.id === groupId && clip.kind === "group") return clip;
  }
  return null;
}

/** Every group clip in the document, in lane order. */
export function allGroupClips(doc: MotionDocument): GroupClip[] {
  const out: GroupClip[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) if (clip.kind === "group") out.push(clip);
  }
  return out;
}

/** Every group clip in a comp, in lane order (top first). */
export function groupsInFrame(doc: MotionDocument, frameId: string): GroupClip[] {
  return allGroupClips(doc).filter((g) => g.frameId === frameId);
}

/** The lane a clip sits on, as an index into `doc.tracks` (-1 if unplaced). */
export function trackIndexOfClip(doc: MotionDocument, clipId: string): number {
  return doc.tracks.findIndex((t) => t.clips.some((c) => c.id === clipId));
}

/**
 * The rows INSIDE a group, in z order (top first) — the group's own lanes.
 * Empty rows included: a row the user added and has not filled yet is still a
 * row, exactly as a "+ Track" lane is at the comp's top level.
 */
export function groupRows(doc: MotionDocument, groupId: string): Track[] {
  return doc.tracks.filter((t) => t.groupId === groupId);
}

/** The scope a lane belongs to — the group whose row it is, or null at the top. */
export function laneGroupId(track: Track): string | null {
  return track.groupId ?? null;
}

/* -------------------------------------------------------------- ancestry */

/** A group's ancestry, innermost → outermost (itself first; cycle-guarded). */
export function groupAncestry(doc: MotionDocument, groupId: string): string[] {
  return ancestryFrom(scopeIndex(doc), groupId);
}

/** The immediate parent group id (null at the top). */
export function groupParent(doc: MotionDocument, groupId: string): string | null {
  const loc = locateClip(doc, groupId);
  return loc && loc.clip.kind === "group" ? loc.track.groupId : null;
}

/** Nesting depth: 0 for a top-level group, +1 per enclosing group. */
export function groupDepth(doc: MotionDocument, groupId: string): number {
  return Math.max(0, groupAncestry(doc, groupId).length - 1);
}

/** Direct child groups of a group (or the top-level groups of a comp when null). */
export function subgroupsOf(doc: MotionDocument, parentId: string | null, frameId?: string): string[] {
  const out: string[] = [];
  for (const track of doc.tracks) {
    if ((track.groupId ?? null) !== parentId) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "group") continue;
      if (frameId && clip.frameId !== frameId) continue;
      out.push(clip.id);
    }
  }
  return out;
}

/** Whether `ancestor` encloses `groupId` (or equals it). */
export function isGroupWithin(doc: MotionDocument, groupId: string, ancestor: string): boolean {
  return groupAncestry(doc, groupId).includes(ancestor);
}

/** The group a clip is in (null at the top level, or when the clip is missing). */
export function groupOfClip(doc: MotionDocument, clipId: string): string | null {
  return locateClip(doc, clipId)?.track.groupId ?? null;
}

/**
 * Every group ENCLOSING a clip, innermost → outermost. The one walk behind the
 * inherited answers — locked/hidden, the fill cascade, the render-time window —
 * so none of them re-derives ancestry its own way.
 */
export function clipAncestorGroups(doc: MotionDocument, clipId: string): GroupClip[] {
  const index = scopeIndex(doc);
  const track = index.trackOf.get(clipId);
  if (!track) return [];
  return ancestryFrom(index, track.groupId)
    .map((id) => index.group.get(id))
    .filter(isGroupClip);
}

/* ------------------------------------------------------------- membership */

/** Ids of a group's DIRECT members — every clip on its rows, nested groups included. */
export function clipsInGroup(doc: MotionDocument, groupId: string): string[] {
  const out: string[] = [];
  for (const track of doc.tracks) {
    if (track.groupId !== groupId) continue;
    for (const clip of track.clips) out.push(clip.id);
  }
  return out;
}

/**
 * Ids of EVERY clip under a group — its own members plus all nested
 * descendants, the nested GROUP clips included (they are clips: they move,
 * delete, copy and lock with the rest).
 */
export function clipsUnderGroup(doc: MotionDocument, groupId: string): string[] {
  const index = scopeIndex(doc);
  const hit = index.under.get(groupId);
  if (hit) return hit.slice();
  const out: string[] = [];
  for (const track of doc.tracks) {
    if (!track.groupId || !ancestryFrom(index, track.groupId).includes(groupId)) continue;
    for (const clip of track.clips) out.push(clip.id);
  }
  index.under.set(groupId, out);
  return out.slice();
}

/**
 * The tracks DIRECTLY inside a group (`null`: the comp level), in document
 * order — from the per-document index, so a question asked of every group on
 * every frame (a group's box, a rig's parts) is not a scan of every track.
 */
export function tracksInGroup(doc: MotionDocument, groupId: string | null): readonly Track[] {
  return scopeIndex(doc).tracksIn.get(groupId) ?? [];
}

/** The same walk, minus the nested group clips — what actually paints. */
export function leafClipsUnderGroup(doc: MotionDocument, groupId: string): string[] {
  const index = scopeIndex(doc);
  return clipsUnderGroup(doc, groupId).filter((id) => index.clip.get(id)?.kind !== "group");
}

/**
 * A selection plus everything INSIDE any group in it. Selecting a group selects
 * the group CLIP alone — that is what "a group is one thing" means for the
 * inspector, the transform gizmo and the timeline bar — so every op that has to
 * reach the contents (move, delete, duplicate, copy, restack) widens through
 * this one seam instead of each deciding for itself.
 */
export function expandToDescendants(doc: MotionDocument, clipIds: readonly string[]): string[] {
  const out = new Set(clipIds);
  const index = scopeIndex(doc);
  const groups = clipIds.filter((id) => index.group.has(id));
  if (groups.length === 0) return [...out];
  for (const track of doc.tracks) {
    if (!track.groupId) continue;
    const chain = ancestryFrom(index, track.groupId);
    if (!groups.some((g) => chain.includes(g))) continue;
    for (const clip of track.clips) out.add(clip.id);
  }
  return [...out];
}

/** The deepest group that encloses EVERY one of the given innermost groups (or null). */
export function deepestCommonAncestor(doc: MotionDocument, groupIds: (string | null)[]): string | null {
  const index = scopeIndex(doc);
  const chains = groupIds.map((g): (string | null)[] => (g ? [...ancestryFrom(index, g), null] : [null]));
  const first = chains[0] ?? [null];
  for (const cand of first) {
    if (chains.every((ch) => ch.includes(cand))) return cand;
  }
  return null;
}

/**
 * The TOP-LEVEL UNITS a selection represents: a clip is a unit unless one of
 * its ancestors is also selected. Groups and clips both come back in lane order
 * (top first).
 */
export function selectionTopUnits(
  doc: MotionDocument,
  clipIds: string[],
): { groups: string[]; clips: string[] } {
  const sel = new Set(clipIds);
  const index = scopeIndex(doc);
  const groups: string[] = [];
  const clips: string[] = [];
  for (const track of doc.tracks) {
    const chain = track.groupId ? ancestryFrom(index, track.groupId) : [];
    if (chain.some((g) => sel.has(g))) continue;
    for (const clip of track.clips) {
      if (clip.kind === "audio" || !sel.has(clip.id)) continue;
      (clip.kind === "group" ? groups : clips).push(clip.id);
    }
  }
  return { groups, clips };
}

/* ------------------------------------------------------------- the lanes */

export interface InsertTrackOptions {
  frameId: string;
  /** The lane to sit beside; omitted = the end of the comp's lanes. */
  nearTrackId?: string | null;
  where?: "above" | "below";
  /**
   * The scope the new lane belongs to. Omit to INHERIT the reference lane's —
   * which is what makes "add a row" work inside a group without the caller
   * knowing groups exist.
   */
  groupId?: string | null;
  name?: string;
}

/**
 * Insert an empty lane beside another — the ONE op behind the "+ Track" button,
 * the lane right-click menu, and dropping a clip past the first/last row.
 *
 * Placement is RELATIVE, never "at the top". A lane added while you are looking
 * at row six belongs at row six, and a row added inside a group belongs inside
 * that group; both fall out of one rule, which is why there is no separate
 * "add a sub-track" anything. Returns the new lane's id.
 */
export function insertTrackNear(doc: MotionDocument, opts: InsertTrackOptions): string {
  const nearIndex = opts.nearTrackId ? doc.tracks.findIndex((t) => t.id === opts.nearTrackId) : -1;
  const near = nearIndex >= 0 ? doc.tracks[nearIndex] : null;
  const groupId = opts.groupId !== undefined ? opts.groupId : near ? near.groupId : null;
  const track = createTrack(opts.name, opts.frameId, groupId);
  // A lane the USER asked for is never auto-swept, exactly like "+ Track".
  track.auto = false;
  if (near) {
    track.color = near.color;
    track.heightPx = near.heightPx;
  }
  const at = nearIndex < 0 ? doc.tracks.length : opts.where === "below" ? nearIndex + 1 : nearIndex;
  doc.tracks.splice(at, 0, track);
  return track.id;
}

/**
 * A fresh row of scope `groupId` (null = the comp's top level), spliced in at
 * `at`. Auto, so it is swept the moment its last clip leaves — exactly as a
 * lane minted by dragging past the edge is.
 */
function mintRow(doc: MotionDocument, at: number, frameId: string, groupId: string | null, like?: Track): Track {
  const row = createTrack(groupId ? undefined : like?.name, frameId, groupId);
  if (groupId) row.name = "Row";
  row.auto = true;
  if (like) {
    row.color = like.color;
    row.heightPx = like.heightPx;
  }
  doc.tracks.splice(Math.max(0, Math.min(doc.tracks.length, at)), 0, row);
  return row;
}

/**
 * Where a new row goes to be the FIRST (or last) row of a scope. Inside a group
 * that is just above (below) its existing rows — or straight after the group's
 * own lane when it has none yet. At the comp's top level it is the top (bottom)
 * of the whole stack; the caller that knows a better lane passes `at` itself.
 */
export function scopeEdgeIndex(doc: MotionDocument, groupId: string | null, edge: "top" | "bottom"): number {
  if (!groupId) return edge === "top" ? 0 : doc.tracks.length;
  const rows = doc.tracks.map((t, i) => (t.groupId === groupId ? i : -1)).filter((i) => i >= 0);
  if (rows.length === 0) return trackIndexOfClip(doc, groupId) + 1;
  return edge === "top" ? rows[0]! : rows[rows.length - 1]! + 1;
}

/**
 * MOVE CLIPS INTO A SCOPE — the one structural move behind grouping, ungrouping,
 * "drag past the band's edge", the layers list's drop and every tool that
 * builds a group out of what it just made.
 *
 * Time never changes. Each distinct source row becomes ONE row in the target
 * scope, in the same top→bottom order, so a set of layers keeps its
 * arrangement when it changes hands: two clips laid end to end on one row are
 * still end to end on one row afterwards. A source row that gives up EVERY
 * clip it held is re-scoped in place rather than emptied and re-minted, which
 * is what keeps its name, colour, height and the transitions between its clips.
 *
 * Rows are inserted at `at` (a `doc.tracks` index), or at the scope's top edge
 * when omitted. A clip that is itself a group brings its interior with it for
 * free — its rows say which group they belong to, and that has not changed.
 *
 * Returns the ids of the rows the clips now sit on, top first.
 */
export function moveClipsToScope(
  doc: MotionDocument,
  clipIds: readonly string[],
  groupId: string | null,
  opts: { at?: number; frameId?: string } = {},
): string[] {
  const index = scopeIndex(doc);
  const wanted = new Set(clipIds);
  const selectedGroups = [...wanted].filter((id) => index.group.has(id));
  // A group clip carries its rows, so only the TOP units change hands: a clip
  // whose ancestry includes a selected group stays exactly where it is.
  // And a group cannot move into itself or into its own interior.
  const forbidden = new Set(groupId ? ancestryFrom(index, groupId) : []);
  const moving = new Set<string>();
  for (const id of wanted) {
    const track = index.trackOf.get(id);
    if (!track || forbidden.has(id)) continue;
    const chain = track.groupId ? ancestryFrom(index, track.groupId) : [];
    if (selectedGroups.some((g) => g !== id && chain.includes(g))) continue;
    moving.add(id);
  }
  if (moving.size === 0) return [];

  const sources = doc.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => track.clips.some((c) => moving.has(c.id)));
  const frameId = opts.frameId ?? sources[0]!.track.clips.find((c) => moving.has(c.id))!.frameId;

  let at = opts.at ?? scopeEdgeIndex(doc, groupId, "top");
  const rows: string[] = [];
  for (const { track } of sources) {
    const all = track.clips.every((c) => moving.has(c.id));
    if (all && track.groupId !== groupId) {
      // Re-scope in place: same lane, new owner — then re-seat it at `at`.
      const from = doc.tracks.indexOf(track);
      doc.tracks.splice(from, 1);
      if (from < at) at--;
      track.groupId = groupId;
      doc.tracks.splice(Math.max(0, Math.min(doc.tracks.length, at)), 0, track);
      at = doc.tracks.indexOf(track) + 1;
      carryTransitions(track, track, moving, frameId);
      rows.push(track.id);
      continue;
    }
    if (all) {
      // Already in the scope, and it holds nothing else: it simply stays.
      carryTransitions(track, track, moving, frameId);
      rows.push(track.id);
      continue;
    }
    const row = mintRow(doc, at, frameId, groupId, track);
    for (const clip of [...track.clips]) {
      if (!moving.has(clip.id)) continue;
      removeClipFromTrack(track, track.clips.indexOf(clip));
      addClipToTrack(row, clip);
    }
    carryTransitions(track, row, moving, frameId);
    sortTrackClips(row);
    at = doc.tracks.indexOf(row) + 1;
    rows.push(row.id);
    pruneTrackIfEmptied(doc, track.id);
  }
  return rows;
}

/**
 * Transitions ride with their clips. A transition is a record on the lane
 * naming the two clips at a cut, so a clip that changes lanes — or comps, when
 * precompose has just re-homed it — would otherwise leave its cut behind:
 * stranded on the old lane, still stamped with the old comp, drawn in the root
 * timeline between clips that are no longer there and missing from the nested
 * comp where both clips now live. That was the "my transitions didn't come
 * into the nested clip" bug.
 *
 * A record whose every named side moves rides to `to` and takes the clips'
 * comp. One whose sides part ways is no longer one cut: the moving side is
 * dropped from it and the record stays with the clip that stayed, single-sided,
 * for the re-anchor pass to re-clamp.
 */
function carryTransitions(from: Track, to: Track, moving: ReadonlySet<string>, frameId: string): void {
  const stay: Transition[] = [];
  for (const tr of from.transitions) {
    const aMoves = tr.aClipId ? moving.has(tr.aClipId) : null;
    const bMoves = tr.bClipId ? moving.has(tr.bClipId) : null;
    const rides = aMoves !== false && bMoves !== false && (aMoves === true || bMoves === true);
    if (rides) {
      tr.frameId = frameId;
      if (to === from) stay.push(tr);
      else to.transitions.push(tr);
      continue;
    }
    if (aMoves === true) tr.aClipId = null;
    if (bMoves === true) tr.bClipId = null;
    if (tr.aClipId || tr.bClipId) stay.push(tr);
  }
  from.transitions = stay;
}

/* ------------------------------------------------------------ structure */

/** The span [start, end) a set of clips covers. */
function unionSpan(clips: readonly Clip[]): { startMs: number; durationMs: number } {
  let start = Infinity;
  let end = -Infinity;
  for (const c of clips) {
    start = Math.min(start, c.startMs);
    end = Math.max(end, c.startMs + c.durationMs);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { startMs: 0, durationMs: 1 };
  return { startMs: start, durationMs: Math.max(1, end - start) };
}

/**
 * Group the given clips under one new group CLIP. Structure-preserving: a
 * selection that covers a whole group nests that group intact (its rows, modes
 * and members come along, because they hang off its id); when everything
 * already shares an enclosing group the new group nests INSIDE it. Returns the
 * new group's id.
 *
 * The group clip takes the topmost member's lane — its z is exactly where its
 * contents were — sharing that lane with whatever else is on it when its span
 * fits beside them, and riding a fresh lane at that index when it does not.
 * The members move onto the group's own rows through `moveClipsToScope`, one
 * row per source row, so they keep their arrangement.
 */
export function groupClips(doc: MotionDocument, clipIds: string[], name?: string): string | null {
  const targets = new Set(clipIds);
  const members = doc.tracks
    .flatMap((t) => t.clips)
    .filter((c): c is VisualClip => c.kind !== "audio" && targets.has(c.id));
  if (members.length === 0) return null;
  const frameId = members[0]!.frameId;
  if (members.some((m) => m.frameId !== frameId)) return null;

  const units = selectionTopUnits(doc, clipIds);
  const top = new Set([...units.groups, ...units.clips]);
  // ONE unit is enough — ⌘G on a single layer wraps it, as it does in Figma,
  // and ⌘G on a whole group wraps that group rather than refusing.
  const topMembers = members.filter((m) => top.has(m.id));
  if (topMembers.length === 0) return null;

  // Parent = the deepest group enclosing the whole selection, but never one of
  // the groups being wrapped (⌘G on a whole group climbs to ITS parent).
  let parentId = deepestCommonAncestor(doc, topMembers.map((m) => groupOfClip(doc, m.id)));
  while (parentId && topMembers.some((m) => m.id === parentId)) parentId = groupParent(doc, parentId);

  const span = unionSpan(topMembers);
  const group = createGroupClip({ frameId, startMs: span.startMs, durationMs: span.durationMs, name });

  // The z the group takes: the topmost member's lane.
  const topIndex = Math.min(...topMembers.map((m) => trackIndexOfClip(doc, m.id)).filter((i) => i >= 0));
  const topLane = doc.tracks[topIndex]!;

  // Members leave first, so the fit test below sees the lane as it will be.
  moveClipsToScope(doc, topMembers.map((m) => m.id), group.id, { at: topIndex + 1, frameId });

  const laneStillThere = doc.tracks.includes(topLane) && topLane.groupId === (parentId ?? null);
  if (laneStillThere && !topLane.locked && fitsInTrack(topLane, null, group.startMs, group.durationMs, frameId)) {
    addClipToTrack(topLane, group);
    sortTrackClips(topLane);
  } else {
    // A fresh lane in the PARENT scope, at the z the topmost member had.
    const lane = mintRow(doc, topIndex, frameId, parentId, topLane);
    lane.name = group.name;
    addClipToTrack(lane, group);
  }
  pruneGroups(doc);
  return group.id;
}

/**
 * Dissolve one group: its rows become rows of its parent scope, seated at the
 * group's own z, and the group clip itself is removed.
 *
 * The group's own paint, effects and transform go with it. That is deliberate,
 * and it is the honest of the two wrong answers: baking them into every child
 * multiplies one shared fact into N copies that immediately drift (and a
 * silhouette stroke has no per-child meaning at all — it is a property of the
 * combined outline, which stops existing the moment the group does). Ungrouping
 * a styled group is a real loss of information, so the surfaces that offer it
 * say so; undo is the way back.
 */
function dissolveGroup(doc: MotionDocument, groupId: string): void {
  const loc = locateClip(doc, groupId);
  if (!loc || loc.clip.kind !== "group") return;
  const parent = loc.track.groupId;
  const rows = groupRows(doc, groupId);
  // The rows take the group's z: in front of the lane the group sat on.
  let at = loc.trackIndex;
  for (const row of rows) {
    const from = doc.tracks.indexOf(row);
    doc.tracks.splice(from, 1);
    if (from < at) at--;
    row.groupId = parent;
    doc.tracks.splice(at, 0, row);
    at++;
  }
  const lane = loc.track;
  removeClipFromTrack(lane, lane.clips.indexOf(loc.clip));
  pruneTrackIfEmptied(doc, lane.id);
}

/**
 * WHICH GROUPS an ungroup of this selection would dissolve — innermost first,
 * so dissolving a parent never strands a child's pointer.
 *
 * A selected GROUP clip dissolves itself — the everyday case now that a group
 * is a thing you can click — and any other selected clip dissolves the group
 * it is in.
 */
export function groupsUngroupedBy(doc: MotionDocument, clipIds: readonly string[]): string[] {
  const toDissolve = new Set<string>();
  for (const id of clipIds) {
    const loc = locateClip(doc, id);
    if (!loc) continue;
    if (loc.clip.kind === "group") toDissolve.add(loc.clip.id);
    else if (loc.track.groupId) toDissolve.add(loc.track.groupId);
  }
  return [...toDissolve].sort((a, b) => groupDepth(doc, b) - groupDepth(doc, a));
}

/** Would Ungroup do anything to this selection? The menu item's enabled state. */
export function canUngroup(doc: MotionDocument, clipIds: readonly string[]): boolean {
  return groupsUngroupedBy(doc, clipIds).length > 0;
}

/**
 * Ungroup: dissolve the innermost group each selected clip belongs to (or the
 * group ITSELF when a group clip is what's selected), popping its contents up
 * one level. A composite group is no different: its mode is a property OF a
 * group, so dissolving the group leaves the members behind as plain layers.
 */
export function ungroupClips(doc: MotionDocument, clipIds: string[]): void {
  for (const gid of groupsUngroupedBy(doc, clipIds)) dissolveGroup(doc, gid);
  pruneGroups(doc);
}

/* ------------------------------------------------------------- the drill */

/*
 * ENTERING GROUPS — Figma's deep-select, with one stored fact.
 *
 * `enteredGroupId` is the group whose DIRECT children a click resolves to.
 * Everything else about "where am I" is derived from it: entering G3 inside
 * G2 inside G1 means all three are OPEN (`openGroupChain`), and a click on
 * something anywhere in that ancestry resolves at the deepest open level that
 * holds it — a sibling of G2 is picked directly, not its outermost group.
 *
 * The context RETREATS with the selection rather than resetting: select a
 * layer beside G3 and you are in G2 now, not back at the top with every row
 * folded. `retreatEnteredGroup` is that rule, and it is the one the surfaces
 * run after every selection change, so the stage, the timeline and the layers
 * panel can never disagree about how deep you are.
 */

/**
 * The groups that are OPEN while `enteredGroupId` is entered: it and every
 * ancestor, innermost → outermost. Empty at the top level, and for a group
 * that no longer exists (ungrouped under you).
 */
export function openGroupChain(doc: MotionDocument, enteredGroupId: string | null): string[] {
  return enteredGroupId ? ancestryFrom(scopeIndex(doc), enteredGroupId) : [];
}

/**
 * Figma click semantics, nesting-aware: a click resolves to the child of the
 * DEEPEST OPEN group on the clip's ancestry, or to its outermost group when
 * none of them is open. Returns the ids to select — a group resolves to the
 * group CLIP, not to its contents.
 */
export function expandSelectionToGroups(
  doc: MotionDocument,
  clipIds: string[],
  enteredGroupId: string | null = null,
): string[] {
  const index = scopeIndex(doc);
  const open = new Set(ancestryFrom(index, enteredGroupId));
  const out = new Set<string>();
  for (const id of clipIds) {
    out.add(selectionUnitForClip(index, id, open) ?? id);
  }
  return [...out];
}

/**
 * The NEXT group to enter when drilling toward `clipId` — one level below the
 * deepest open group on the way, the outermost when none is open, null when
 * the clip is already directly reachable. Symmetric with `expandSelectionToGroups`.
 */
export function nextEnterGroup(
  doc: MotionDocument,
  clipId: string,
  enteredGroupId: string | null,
): string | null {
  const index = scopeIndex(doc);
  const gid = index.trackOf.get(clipId)?.groupId ?? null;
  if (!gid) return null;
  const outerToInner = [...ancestryFrom(index, gid)].reverse();
  const open = new Set(ancestryFrom(index, enteredGroupId));
  let deepestOpen = -1;
  for (let i = 0; i < outerToInner.length; i++) if (open.has(outerToInner[i]!)) deepestOpen = i;
  return outerToInner[deepestOpen + 1] ?? null;
}

/**
 * Where the entered context stands once the selection is `selectedIds`: the
 * deepest OPEN group that still holds every selected clip — stepping out one
 * level at a time as the selection moves sideways — and, when no open group
 * holds it, the selection's own innermost common group (a leaf picked from
 * the layers panel implies its parents are open, exactly as Figma reads it).
 * Null for an empty selection: clicking nothing is leaving.
 */
export function retreatEnteredGroup(
  doc: MotionDocument,
  enteredGroupId: string | null,
  selectedIds: readonly string[],
): string | null {
  if (selectedIds.length === 0) return null;
  const index = scopeIndex(doc);
  const chains = selectedIds.map((id) => ({
    id,
    ancestry: ancestryFrom(index, index.trackOf.get(id)?.groupId ?? null),
  }));
  for (const g of ancestryFrom(index, enteredGroupId)) {
    if (chains.every((c) => c.id === g || c.ancestry.includes(g))) return g;
  }
  return deepestCommonAncestor(
    doc,
    chains.map((c) => c.ancestry[0] ?? null),
  );
}

/**
 * The unit a click on `clipId` selects: walking its ancestry inward→outward,
 * the first OPEN group's child on the path — the clip itself when it sits
 * directly in an open group — else the outermost group. Null for a loose clip.
 */
function selectionUnitForClip(index: ScopeIndex, clipId: string, open: ReadonlySet<string>): string | null {
  const gid = index.trackOf.get(clipId)?.groupId ?? null;
  if (!gid) return null;
  const chain = ancestryFrom(index, gid); // innermost → outermost
  for (let i = 0; i < chain.length; i++) {
    if (open.has(chain[i]!)) return i === 0 ? clipId : chain[i - 1]!;
  }
  return chain[chain.length - 1] ?? null;
}

/**
 * Pull clips OUT of their innermost group by one nesting level — onto the
 * parent scope, at the group's own z. The headless op behind "move out of
 * group", symmetric with `nextEnterGroup`.
 */
export function pullClipsOutOneLevel(doc: MotionDocument, clipIds: readonly string[]): void {
  const byGroup = new Map<string, string[]>();
  for (const id of clipIds) {
    const gid = groupOfClip(doc, id);
    if (!gid) continue;
    byGroup.set(gid, [...(byGroup.get(gid) ?? []), id]);
  }
  for (const [gid, ids] of byGroup) {
    const at = trackIndexOfClip(doc, gid);
    moveClipsToScope(doc, ids, groupParent(doc, gid), { at: at < 0 ? undefined : at });
  }
  pruneGroups(doc);
}


/**
 * Heal the row structure — the one call every structural edit ends with.
 *
 * A row whose group is gone (deleted, or undone out from under it) heals to
 * the comp's top level if it still holds anything, and is dropped if it does
 * not; nothing a person made is ever lost to a dangling pointer. A GROUP that
 * holds nothing at all — no clip on any row at any depth — is deleted, along
 * with its empty rows and the auto lane that carried it. A container with no
 * contents has no silhouette, no span worth trimming and nothing to composite;
 * it is indistinguishable from a bug. Innermost-out, so emptying a child can
 * empty its parent in the same pass.
 */
export function pruneGroups(doc: MotionDocument): void {
  for (let pass = 0; pass < 64; pass++) {
    const index = scopeIndex(doc);
    let changed = false;
    // Rows pointing at nothing.
    doc.tracks = doc.tracks.filter((track) => {
      if (!track.groupId || index.group.has(track.groupId)) return true;
      changed = true;
      if (track.clips.length === 0) return false;
      track.groupId = null;
      return true;
    });
    // Groups holding nothing. A RIG's bones are contents of their own — bones
    // drawn before the art is moved in are a skeleton, not an empty container.
    const occupied = new Set<string>();
    for (const track of doc.tracks) {
      if (!track.groupId || track.clips.length === 0) continue;
      for (const g of ancestryFrom(index, track.groupId)) occupied.add(g);
    }
    for (const [id, g] of index.group) {
      if (g.rig?.bones.length) for (const a of [id, ...ancestryFrom(index, index.trackOf.get(id)?.groupId ?? null)]) occupied.add(a);
    }
    const dead = [...index.group.keys()].filter((id) => !occupied.has(id));
    if (dead.length > 0) {
      changed = true;
      const gone = new Set(dead);
      for (const track of doc.tracks) track.clips = track.clips.filter((c) => !gone.has(c.id));
      doc.tracks = doc.tracks.filter((t) => !(t.groupId && gone.has(t.groupId) && t.clips.length === 0));
      for (const id of dead) {
        const lane = index.trackOf.get(id);
        if (lane) pruneTrackIfEmptied(doc, lane.id);
      }
    }
    if (!changed) return;
  }
}
