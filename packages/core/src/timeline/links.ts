import { createId } from "../ids";
import type { Clip, MotionDocument } from "../schema";
import { locateClip } from "./ops";

/**
 * DaVinci-style clip LINKING. A link group is just a shared id on the clip
 * base — pure data, no structure to maintain. Linked clips select together
 * (so they move, split and delete together through the ordinary multi-select
 * machinery — no parallel "move linked" code paths), and the timeline's link
 * toggle can mute that behavior without touching the data, exactly like
 * Resolve's chain-link switch.
 */

/** Link clips into one group (joins/merges any groups they were in). Returns the group id. */
export function linkClips(doc: MotionDocument, clipIds: string[]): string | null {
  const clips = clipIds
    .map((id) => locateClip(doc, id)?.clip)
    .filter((c): c is Clip => c !== undefined);
  if (clips.length < 2) return null;
  // Reuse the first existing group so "link one more clip in" grows the group.
  const groupId = clips.find((c) => c.linkGroupId)?.linkGroupId ?? createId("link");
  const merging = new Set(clips.map((c) => c.linkGroupId).filter((g): g is string => !!g));
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.linkGroupId && merging.has(clip.linkGroupId)) clip.linkGroupId = groupId;
    }
  }
  for (const clip of clips) clip.linkGroupId = groupId;
  return groupId;
}

/** Remove clips from their link groups (the rest of each group stays linked). */
export function unlinkClips(doc: MotionDocument, clipIds: string[]): void {
  for (const id of clipIds) {
    const loc = locateClip(doc, id);
    if (loc) loc.clip.linkGroupId = null;
  }
}

/**
 * Expand a selection across link groups: the input ids plus every clip sharing
 * a group with any of them. Order-stable (input first, then found members).
 */
export function expandLinkedSelection(doc: MotionDocument, clipIds: string[]): string[] {
  const groups = new Set<string>();
  for (const id of clipIds) {
    const g = locateClip(doc, id)?.clip.linkGroupId;
    if (g) groups.add(g);
  }
  if (groups.size === 0) return clipIds;
  const out = [...clipIds];
  const seen = new Set(clipIds);
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.linkGroupId && groups.has(clip.linkGroupId) && !seen.has(clip.id)) {
        seen.add(clip.id);
        out.push(clip.id);
      }
    }
  }
  return out;
}

/**
 * Re-export: `remapClipRefsAfterCopy` LIVES in ops.ts.
 *
 * It moved there when `duplicateClips` needed it, because ops → links → ops is
 * a cycle, and a cycle in this package is not a style question: two of the
 * flipbook's tests started failing in the full suite and passing on their own,
 * which is module-evaluation order, not logic. The function is about clip
 * REFERENCES after a copy — link groups, waveform targets, group membership —
 * so ops is where it belonged anyway.
 */
export { remapClipRefsAfterCopy } from "./ops";
