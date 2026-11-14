import type { MotionDocument, Clip, GroupClip } from "../schema";
import { clipAncestorGroups, clipsInGroup, clipsUnderGroup, groupClipById } from "./groups";

/**
 * A GROUP'S TIME — the window it shows its contents through.
 *
 * A group's span is a WINDOW, not a sync. Its members keep their own absolute
 * times on the parent's clock; dragging the group's edge changes only what the
 * window reveals, exactly as trimming a nested clip reveals more or less of
 * its comp. Moving the group is the one gesture that carries the contents
 * (`moveClip`), because moving is not trimming.
 *
 * The window is what the group SHOWS. It is not the whole story of a trim,
 * because a group is usually built around its contents and starts out flush
 * with them: dragging its end in should shorten the layer that ends with it,
 * not hide it. `groupEdgeFollowers` is that rule, and it is deliberately
 * narrower than the v66 version it replaces — only a FLUSH edge moves, only the
 * edge being dragged moves, and the walk stops at any sub-group that is not
 * itself flush. Everything else the window handles, which is why "why did that
 * clip change" has one answer now: because its edge was the one you dragged.
 */

/**
 * Does this clip render at `timeMs`, as far as its ENCLOSING GROUPS are
 * concerned? A group's span is a window: a descendant outside it does not paint,
 * at any depth.
 *
 * Asked at the render seam about the group NODE, not per child, so the cost is
 * one ancestry walk per group rather than per layer.
 */
export function withinGroupWindow(doc: MotionDocument, clipId: string, timeMs: number): boolean {
  for (const g of clipAncestorGroups(doc, clipId)) {
    if (timeMs < g.startMs || timeMs >= g.startMs + g.durationMs) return false;
  }
  return true;
}

export interface GroupTimeEdit {
  clipId: string;
  startMs: number;
  durationMs: number;
}

/**
 * A SPEED change on a group scales its contents rather than time-mapping the
 * group, and that is a deliberate difference from a nested comp.
 *
 * A nested comp owns a separate timeline, so `playback.speed` there is a map
 * from parent time to child time and the children never move. A group's members
 * sit on the PARENT's timeline at absolute times you can see and drag; a stored
 * map on the group would mean the bars in its band no longer say when their
 * contents play, and every snap, marker and transition around them would be
 * reading a lie. Scaling the spans keeps the timeline honest — what you see is
 * when it happens — at the cost of being a destructive edit, which is the right
 * trade for the surface that exists to show you time.
 *
 * Returns every edit, so the caller applies them as ONE step.
 */
export function planGroupRetime(
  doc: MotionDocument,
  groupId: string,
  factor: number,
  minDurationMs = 1,
): GroupTimeEdit[] {
  const group = groupClipById(doc, groupId);
  if (!group || !(factor > 0)) return [];
  const anchor = group.startMs;
  const scale = (clip: Clip): GroupTimeEdit => ({
    clipId: clip.id,
    startMs: Math.round(anchor + (clip.startMs - anchor) * factor),
    durationMs: Math.max(minDurationMs, Math.round(clip.durationMs * factor)),
  });
  const index = new Map<string, Clip>();
  for (const track of doc.tracks) for (const clip of track.clips) index.set(clip.id, clip);
  return [
    scale(group),
    ...clipsUnderGroup(doc, groupId)
      .map((id) => index.get(id))
      .filter((c): c is Clip => !!c)
      .map(scale),
  ];
}

/**
 * How far off level an edge may sit and still count as level.
 *
 * Not a fudge: group spans are computed from their members' spans and rounded
 * (`groupClips`, `planGroupRetime`), so an edge that a person authored flush can
 * land a millisecond apart. Exact equality would make the rule below fire or not
 * fire for a reason invisible on screen, which is worse than either answer.
 */
const EDGE_LEVEL_TOLERANCE_MS = 2;

/**
 * The descendants a group's edge CARRIES when it is trimmed: the ones whose own
 * edge is flush with the group's, and — through those of them that are groups —
 * their flush descendants in turn, to any depth.
 *
 * This is the one rule that makes a group's window feel like a container rather
 * than a curtain. A group is usually built AROUND its contents, so its edges
 * start flush with them; dragging the group's end in then hid the last layer
 * instead of shortening it, and shortening it meant opening the band and
 * dragging N edges by hand, at every depth, hoping to land on the same value.
 *
 * It is narrow on purpose, and the narrowness is what the v66 version of this
 * rule got wrong:
 *
 *  - **Only flush edges move.** A layer that ends before the group does is
 *    saying something about its own timing; the window still reveals or hides
 *    it, and it does not move.
 *  - **Only the trimmed edge moves.** The follower's other edge stays exactly
 *    where it is, so a trim is a trim and never a slide.
 *  - **Recursion passes through flush SUB-GROUPS only.** A sub-group that is
 *    not flush is a boundary: its own window already decides what its contents
 *    show, so reaching past it to move a grandchild would change a span nobody
 *    asked about, which is precisely the "why did that clip change" the old rule
 *    produced.
 *
 * Levelness is measured against the group's CURRENT edge, so a caller must ask
 * BEFORE it moves anything — the set is a fact about the document as authored,
 * not about the state of a half-applied edit. Returns ids, in no particular
 * order: each follower's edge moves by the same delta and clamps against its
 * own limits, so the order it is applied in cannot matter (two clips on one lane
 * cannot both be flush with the same edge without overlapping).
 */
export function groupEdgeFollowers(
  doc: MotionDocument,
  group: GroupClip,
  edge: "start" | "end",
): string[] {
  const at = edge === "start" ? group.startMs : group.startMs + group.durationMs;
  const flush = (clip: Clip): boolean =>
    Math.abs((edge === "start" ? clip.startMs : clip.startMs + clip.durationMs) - at) <=
    EDGE_LEVEL_TOLERANCE_MS;

  const index = new Map<string, Clip>();
  for (const track of doc.tracks) for (const clip of track.clips) index.set(clip.id, clip);

  const out: string[] = [];
  const seen = new Set<string>([group.id]);
  const walk = (groupId: string): void => {
    for (const id of clipsInGroup(doc, groupId)) {
      if (seen.has(id)) continue;
      const clip = index.get(id);
      if (!clip || !flush(clip)) continue;
      seen.add(id);
      out.push(id);
      if (clip.kind === "group") walk(id);
    }
  };
  walk(group.id);
  return out;
}
