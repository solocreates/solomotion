import { addClipToTrack, clipFrameBounds, reissueClipIds } from "../timeline/ops";
import type { Bounds } from "../vector/geometry";
import type { Clip, GroupClip, GroupMode, MotionDocument } from "../schema";
import { createCarrierTrack, createGroupClip } from "../factories";
import { groupClipById, groupOfClip, scopeEdgeIndex } from "../timeline/groups";
import { placeClip, type PlaceClipOptions } from "../timeline/place";

/**
 * Library snapshots — the data behind "turn any selection into a component".
 *
 * A snapshot captures one or more clips (a styled headline, a whole grouped
 * composition, a sound sting…) as portable, frame-independent data. Because
 * clip transforms are anchored to the frame centre, a snapshot re-instantiates
 * cleanly into any frame at any time. Pure data + pure functions, so the same
 * user library round-trips through JSON and could ship to native adapters.
 *
 * v2: THE GROUP IS A CLIP, SO THE SNAPSHOT CARRIES IT. v1 kept a name and a
 * composite mode and rebuilt a bare group on the way back in, which lost
 * everything else a group can wear — its in/out animation, its effects, its
 * fill, its transform. A saved icon with a draw-on, or a component whose
 * group faded in, came back inert. The group now travels as itself, rebased
 * like the members; `normalizeSnapshot` lifts a v1 file on read.
 */

export interface LibrarySnapshot {
  /** Schema version — bump when the capture shape changes. */
  v: 2;
  /**
   * Captured MEMBER clips, deep-cloned and time-rebased so the earliest begins
   * at 0. Ids are placeholders; `instantiateLibrarySnapshot` reissues them.
   */
  clips: Clip[];
  /**
   * The group the clips are recreated under, when there is one — rebased like
   * the members, ids placeholders. Null: the clips land loose.
   */
  group: GroupClip | null;
}

/** The pre-v2 shape, still read from old libraries and old catalogue blobs. */
export interface LibrarySnapshotV1 {
  v: 1;
  clips: Clip[];
  grouped: boolean;
  groupName: string | null;
  groupMode?: GroupMode;
}

/**
 * Any stored snapshot → the current shape. A v1 file's bare facts become a
 * fresh group clip spanning its members; anything unrecognisable is null,
 * never a throw — a library entry that will not parse is skipped, not fatal.
 */
export function normalizeSnapshot(input: unknown): LibrarySnapshot | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as {
    v?: unknown;
    clips?: unknown;
    group?: GroupClip | null;
    grouped?: boolean;
    groupName?: string | null;
    groupMode?: GroupMode;
  };
  if (!Array.isArray(raw.clips)) return null;
  const clips = raw.clips as Clip[];
  if (raw.v === 2) return { v: 2, clips, group: raw.group ?? null };
  if (raw.v !== 1) return null;
  const visual = clips.filter((c) => c.kind !== "audio");
  const group =
    raw.grouped && visual.length >= 2
      ? createGroupClip({
          frameId: visual[0]!.frameId,
          ...span(visual),
          name: raw.groupName ?? "Component",
          mode: raw.groupMode ?? "pass",
        })
      : null;
  return { v: 2, clips, group };
}

/** The window covering a set of clips — what a recreated group spans. */
function span(clips: readonly Clip[]): { startMs: number; durationMs: number } {
  const start = Math.min(...clips.map((c) => c.startMs));
  const end = Math.max(...clips.map((c) => c.startMs + c.durationMs));
  return { startMs: start, durationMs: Math.max(1, end - start) };
}

function collectClips(doc: MotionDocument, clipIds: Set<string>): Clip[] {
  const out: Clip[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clipIds.has(clip.id)) out.push(clip);
    }
  }
  return out;
}

/**
 * Capture the given clips as a reusable snapshot, or null if none exist.
 * Time is rebased to the earliest clip; positions are preserved as-is.
 */
export function captureLibrarySnapshot(
  doc: MotionDocument,
  clipIds: string[],
): LibrarySnapshot | null {
  const clips = collectClips(doc, new Set(clipIds));
  if (clips.length === 0) return null;

  const minStart = Math.min(...clips.map((c) => c.startMs));
  const cloned = clips.map((c) => {
    const copy = structuredClone(c);
    copy.startMs -= minStart;
    return copy;
  });

  const visual = cloned.filter((c) => c.kind !== "audio");
  if (visual.length < 2) return { v: 2, clips: cloned, group: null };

  // The whole selection shares one group → THAT group travels, everything it
  // wears included, so a saved mask, a saved draw-on, a saved fade come back
  // as they were. Otherwise a plain group spanning the members is made.
  const groupIds = new Set(visual.map((c) => groupOfClip(doc, c.id)).filter(Boolean) as string[]);
  const existing = groupIds.size === 1 ? groupClipById(doc, [...groupIds][0] ?? null) : null;
  let group: GroupClip;
  if (existing) {
    group = structuredClone(existing);
    group.startMs -= minStart;
  } else {
    group = createGroupClip({ frameId: visual[0]!.frameId, ...span(visual), name: "Component" });
  }
  return { v: 2, clips: cloned, group };
}

/**
 * What to CALL a captured snapshot.
 *
 * "My component" was the default for everything, so a library of saved work
 * read as a column of identical cards — and a card you cannot tell apart from
 * its neighbour is not saved, it is lost. A snapshot already knows what it is:
 * one clip is its own name (which, for text, is its words), and a set is its
 * group's name or the topmost layer plus a count. Nothing here is invented.
 */
export function librarySnapshotName(snapshot: LibrarySnapshot): string {
  if (snapshot.group?.name && snapshot.group.name !== "Component") return snapshot.group.name;
  const visual = snapshot.clips.filter((c) => c.kind !== "audio");
  const clips = visual.length ? visual : snapshot.clips;
  const first = clips[0];
  if (!first) return "Component";
  const name = first.name.trim() || "Layer";
  return clips.length === 1 ? name : `${name} +${clips.length - 1}`;
}

/**
 * How long a snapshot occupies once placed — the far edge of its latest clip,
 * since capture rebased the earliest to 0. What a drop ghost is sized by.
 */
export function snapshotSpanMs(snapshot: LibrarySnapshot): number {
  return snapshot.clips.reduce((end, c) => Math.max(end, c.startMs + c.durationMs), 0);
}

/**
 * The frame-space box a snapshot's visual clips would cover if placed with no
 * offset — the union of their transformed boxes. Text measures against the
 * document's fonts, so the caller's doc is needed; a snapshot with no visual
 * clips has no box.
 */
export function snapshotBounds(doc: MotionDocument, snapshot: LibrarySnapshot): Bounds | null {
  let out: Bounds | null = null;
  for (const clip of snapshot.clips) {
    if (clip.kind === "audio") continue;
    const b = clipFrameBounds(doc, clip);
    if (!b) continue;
    out = out
      ? {
          minX: Math.min(out.minX, b.minX),
          minY: Math.min(out.minY, b.minY),
          maxX: Math.max(out.maxX, b.maxX),
          maxY: Math.max(out.maxY, b.maxY),
        }
      : b;
  }
  return out;
}

export interface InstantiateTarget {
  frameId: string;
  startMs: number;
  /** Optional canvas offset applied to every visual clip. */
  dx?: number;
  dy?: number;
}

/**
 * Materialise a snapshot into fresh clips (new ids throughout). A grouped
 * snapshot comes back with its GROUP CLIP in the list — a group is a clip, so
 * there is nothing for the caller to place separately any more. Membership is
 * the ROW's, so once the clips are on lanes the caller hands `members` to
 * `moveClipsToScope(doc, members, group.id)` and they take the group's rows.
 *
 * Deterministic and side-effect-free apart from id generation.
 */
export function instantiateLibrarySnapshot(
  snapshot: LibrarySnapshot,
  target: InstantiateTarget,
): { clips: Clip[]; group: Clip | null; members: string[] } {
  const members = snapshot.clips.map((source) => {
    const clip = reissueClipIds(source);
    clip.startMs += target.startMs;
    clip.frameId = target.frameId;
    if (clip.kind !== "audio") {
      if (target.dx) clip.transform.x += target.dx;
      if (target.dy) clip.transform.y += target.dy;
    }
    return clip;
  });

  const visual = members.filter((c) => c.kind !== "audio");
  if (!snapshot.group || visual.length < 1) return { clips: members, group: null, members: [] };

  // The stored group, reissued and moved like its members. Its span is
  // re-derived from them: a group's window is what it holds.
  const group = reissueClipIds(snapshot.group) as GroupClip;
  group.frameId = target.frameId;
  const window = span(visual);
  group.startMs = window.startMs;
  group.durationMs = window.durationMs;
  // The drop offset went onto the MEMBERS above and must not go onto the group
  // as well: a group's (x, y) is a delta applied to what it holds, so moving
  // both put the artwork twice as far from the centre as the cursor was.
  return { clips: [group, ...members], group, members: visual.map((c) => c.id) };
}

/**
 * THE way a snapshot becomes layers in a document — a saved component, an icon
 * from a plugin, layers an agent copied from another comp. New ids throughout,
 * the group recreated and its members moved onto its rows, every clip routed
 * through `placeClip` so it lands where `placement` says (a lane, a group's
 * band, above an anchor, on top). Returns the new clip ids, the group (when
 * there is one) and the visual clips.
 *
 * In core, not in the panel that first needed it: three surfaces each
 * instantiated a snapshot and each forgot the same thing — containment is the
 * ROW, so a recreated group whose members were never moved onto its rows was a
 * group holding nothing — and the API's cross-comp copy is a fourth.
 */
export function placeSnapshot(
  doc: MotionDocument,
  snapshot: LibrarySnapshot,
  target: InstantiateTarget,
  placement: PlaceClipOptions = {},
): { ids: string[]; group: Clip | null; visual: string[] } {
  const { clips, group, members } = instantiateLibrarySnapshot(snapshot, target);
  const visual = clips.filter((c) => c.kind !== "audio").map((c) => c.id);
  if (!group) {
    // Bottom first: each lands on the surface (or right above the anchor), so
    // the snapshot's top-first order is rebuilt rather than reversed.
    for (let i = clips.length - 1; i >= 0; i--) placeClip(doc, clips[i]!, placement);
    return { ids: clips.map((c) => c.id), group: null, visual };
  }
  // The GROUP goes where the placement says. Its members get rows of their own,
  // in the snapshot's order — topmost first, as every clip list in the app is —
  // spliced in one motion at the group's top edge. Placing them one by one
  // through the first-fit scanner put each on a fresh top lane, which reversed
  // the stack: an icon's background landed over its mark.
  placeClip(doc, group, placement);
  const wanted = new Set(members);
  const rows = clips
    .filter((c) => wanted.has(c.id))
    .map((c) => {
      const row = createCarrierTrack(undefined, null, group.id);
      addClipToTrack(row, c);
      return row;
    });
  doc.tracks.splice(scopeEdgeIndex(doc, group.id, "top"), 0, ...rows);
  // Audio members have no z; they ride lanes like any sound.
  for (const c of clips) if (c.kind === "audio") placeClip(doc, c, {});
  return { ids: clips.map((c) => c.id), group, visual };
}
