import type { MotionDocument, Clip } from "../schema";
import { expandToDescendants, moveClipsToScope, pruneGroups } from "./groups";
import { reissueClipIds, remapClipRefsAfterCopy } from "./ops";
import { placeClip, type PlaceClipOptions } from "./place";

/**
 * LAYERS IN TRANSIT — what a copy carries from one comp (or project) to
 * another: the clips, top of the stack first, the lane each came off, and the
 * group row each sat in. Groups are clips like any other, so a group, its
 * members and the groups inside it all travel as one flat list; `scopes` is
 * what lets the paste rebuild the nesting.
 *
 * One shape for the editor's clipboard and the agent's `layers.copy`, so a copy
 * from either side is the same copy.
 */
export interface ClipCarry {
  clips: Clip[];
  /** clip id → the group whose row it sat on. */
  scopes: Record<string, string>;
  /** clip id → the track it came off (where a paste puts it back if it can). */
  lanes: Record<string, string>;
}

/** What copying these layers carries: each one and everything inside its groups, in stack order. */
export function carryClips(doc: MotionDocument, clipIds: readonly string[]): ClipCarry {
  const ids = new Set(expandToDescendants(doc, clipIds));
  const carry: ClipCarry = { clips: [], scopes: {}, lanes: {} };
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (!ids.has(clip.id)) continue;
      carry.clips.push(clip);
      carry.lanes[clip.id] = track.id;
      if (track.groupId) carry.scopes[clip.id] = track.groupId;
    }
  }
  return carry;
}

export interface PasteTarget {
  frameId: string;
  /** Where the earliest clip lands; the rest keep their offsets from it. */
  startMs: number;
  /** Where each copy is placed. Default: back on its own lane when free, else any lane with room. */
  place?: (d: MotionDocument, copy: Clip, source: Clip) => PlaceClipOptions;
}

/**
 * Paste carried layers into a comp — new ids throughout, relative timing kept,
 * each copy seated in the group its source sat in (the COPIED group when it
 * came along). Returns the new ids and the source → copy map.
 *
 * A group belongs to ONE comp, so membership cannot cross frames — unless the
 * group crossed with it. That needs the finished id map, which is why the
 * remap, not the loop, decides it (`remapClipRefsAfterCopy`'s `reframed`):
 * deciding it per copy emptied every group pasted into another comp.
 */
export function pasteCarry(d: MotionDocument, carry: ClipCarry, target: PasteTarget): { created: string[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const created: string[] = [];
  if (carry.clips.length === 0) return { created, idMap };
  const earliest = Math.min(...carry.clips.map((c) => c.startMs));
  const copies: Clip[] = [];
  const reframed = new Set<string>();
  // Bottom first: each copy lands on the surface (or right above where it was
  // aimed), so the stack's order is rebuilt rather than reversed.
  for (let i = carry.clips.length - 1; i >= 0; i--) {
    const source = carry.clips[i]!;
    const clip = reissueClipIds(source);
    clip.startMs = Math.max(0, target.startMs + (source.startMs - earliest));
    if (clip.frameId !== target.frameId) reframed.add(clip.id);
    clip.frameId = target.frameId;
    placeClip(d, clip, target.place?.(d, clip, source) ?? { homeTrackId: carry.lanes[source.id], landing: "reuse" });
    created.push(clip.id);
    idMap.set(source.id, clip.id);
    copies.push(clip);
  }
  // Seat copies by SOURCE group — one move per group, so copies from one row
  // share a row again — straight into the copied group when it came along.
  const byGroup = new Map<string, string[]>();
  for (const [sourceId, groupId] of Object.entries(carry.scopes)) {
    const copyId = idMap.get(sourceId);
    if (copyId) byGroup.set(groupId, [...(byGroup.get(groupId) ?? []), copyId]);
  }
  for (const [groupId, ids] of byGroup) moveClipsToScope(d, ids, idMap.get(groupId) ?? groupId);
  // Pasted pairs stay linked to each other, never to what they were copied from.
  remapClipRefsAfterCopy(d, copies, idMap, reframed);
  pruneGroups(d);
  return { created, idMap };
}
