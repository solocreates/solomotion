import type { GroupMode, MotionDocument, VisualClip } from "../schema";
import { clipsInGroup, clipsUnderGroup, deepestCommonAncestor, groupClipById, groupClips, groupOfClip, leafClipsUnderGroup, moveClipsToScope, selectionTopUnits } from "./groups";

/**
 * Composite groups — the headless brain behind Union / Subtract / Intersect /
 * Exclude / Mask. A composite is NOT a new container: it is a mode on the one
 * existing group concept, so it inherits every group behavior for free
 * (selection, drag-drop, rename, library snapshots) and switching modes never
 * wraps layers in another group. The inspector's Combine row, the right-click
 * menu and the ⌘⌥M shortcut all read `selectionCompositeInfo` and write
 * through `applyCompositeMode`, so their enabling conditions can never drift.
 */

/** UI-facing metadata, in display order. `pass` renders as a plain group. */
export const COMPOSITE_MODES: ReadonlyArray<{ mode: GroupMode; label: string }> = [
  { mode: "union", label: "Union" },
  { mode: "subtract", label: "Subtract" },
  { mode: "intersect", label: "Intersect" },
  { mode: "exclude", label: "Exclude" },
  { mode: "mask", label: "Mask" },
];

const MODE_GROUP_NAME: Record<GroupMode, string> = {
  pass: "Group",
  union: "Union",
  subtract: "Subtract",
  intersect: "Intersect",
  exclude: "Exclude",
  mask: "Mask group",
};

/** The selected visual clips, TOP→BOTTOM in paint order (track 0 paints on top). */
function selectedVisuals(doc: MotionDocument, clipIds: string[]): VisualClip[] {
  const wanted = new Set(clipIds);
  const out: VisualClip[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "audio" && wanted.has(clip.id)) out.push(clip);
    }
  }
  return out;
}

export interface SelectionCompositeInfo {
  /** Combine actions apply: 2+ visual layers, all in one frame. */
  eligible: boolean;
  /**
   * Set when the selection IS exactly one whole group — mode changes then edit
   * that group in place instead of creating a wrapper.
   */
  groupId: string | null;
  /** The existing group's mode ("pass" when none / not a whole group). */
  mode: GroupMode;
  /** The selected visual clip ids, top→bottom in paint order. */
  orderedIds: string[];
}

/**
 * THE one condition every Combine surface shares: what the selection is, and
 * whether mode changes should edit an existing group or form a new one.
 */
export function selectionCompositeInfo(
  doc: MotionDocument,
  clipIds: string[],
): SelectionCompositeInfo {
  const members = selectedVisuals(doc, clipIds);
  const orderedIds = members.map((c) => c.id);
  const eligible =
    members.every((c) => c.frameId === members[0]!.frameId) &&
    (members.length >= 2 || members[0]?.kind === "group");

  // "The selection IS a whole group" — nesting-aware: the deepest group that
  // encloses every member counts when the selection covers ALL of its clips,
  // subgroups included (a union nested inside still belongs to its parent).
  let groupId: string | null = null;
  if (eligible) {
    // Selecting the group CLIP is the everyday case now — one member, and it
    // is the group itself.
    const only = members.length === 1 ? members[0]! : null;
    if (only?.kind === "group") groupId = only.id;
    else {
      const cand = deepestCommonAncestor(doc, members.map((c) => groupOfClip(doc, c.id)));
      if (cand && clipsUnderGroup(doc, cand).length === members.length) groupId = cand;
    }
  }
  const mode = groupClipById(doc, groupId)?.mode ?? "pass";
  return { eligible, groupId, mode, orderedIds };
}

/** Does this mode split its members into stencil and content? */
export function modeUsesStencil(mode: GroupMode): boolean {
  return mode !== "pass" && mode !== "union";
}

/**
 * Set a group's composite mode in place. Entering a mode that needs a stencil
 * with none chosen yet promotes the TOPMOST member — Figma/Illustrator's "the
 * upper shape does the cutting", minus the duplicate-layer dance. Leaving the
 * mode keeps the roles on the clips, so toggling back restores them.
 */
export function setGroupMode(doc: MotionDocument, groupId: string, mode: GroupMode): boolean {
  const group = groupClipById(doc, groupId);
  if (!group) return false;
  group.mode = mode;
  if (modeUsesStencil(mode)) {
    // Any DIRECT member may be the stencil — a nested group included, since a
    // group has a silhouette of its own now. Nothing chosen yet → promote the
    // topmost, when there is anything below it to operate on.
    const direct = selectedVisuals(doc, clipsInGroup(doc, groupId));
    if (direct.length > 1 && !direct.some((c) => c.isStencil)) direct[0]!.isStencil = true;
  }
  return true;
}

/**
 * Apply a composite mode to a selection: reuse the group when the selection is
 * one whole group (no zombie wrappers), otherwise group the layers through the
 * normal grouping pipeline and set the mode. Returns the group id, or null
 * when the selection can't combine.
 */
export function applyCompositeMode(
  doc: MotionDocument,
  clipIds: string[],
  mode: GroupMode,
): string | null {
  const info = selectionCompositeInfo(doc, clipIds);
  if (!info.eligible) return null;
  const groupId = info.groupId ?? adoptIntoComposite(doc, clipIds, mode) ?? groupClips(doc, clipIds, MODE_GROUP_NAME[mode]);
  if (!groupId) return null;
  return setGroupMode(doc, groupId, mode) ? groupId : null;
}

/**
 * ADD TO THE OPERATION YOU ALREADY HAVE, instead of wrapping it in another one.
 *
 * Select a union and one more shape, press Union, and the obvious answer is a
 * union of three things. The answer you got was a NEW group holding the old
 * union and the shape — a second operation, a second row, a second set of
 * roles, and a nesting level nobody asked for. Do it twice and the layer list
 * is a staircase. Figma and Illustrator both extend the existing boolean here,
 * and the reason is that a composite is a SET: "add one more" is the commonest
 * thing anybody does to one, and it must not cost a level of depth.
 *
 * The condition is deliberately narrow — exactly one of the top-level units is
 * a group, it already runs the mode being asked for, and every other unit is
 * its sibling. Anything else (two groups, a group of a different mode, units
 * from different parents) is genuinely a new operation and falls through to
 * wrapping, which is the honest answer for those.
 *
 * Newcomers land as CONTENT in a mode that has sides: joining a mask means "be
 * one of the things it shows", and promoting a stencil is a click on the badge.
 *
 * Returns the group that adopted them, or null when this is not that case.
 */
function adoptIntoComposite(
  doc: MotionDocument,
  clipIds: string[],
  mode: GroupMode,
): string | null {
  if (mode === "pass") return null;
  const units = selectionTopUnits(doc, clipIds);
  if (units.groups.length !== 1 || units.clips.length === 0) return null;
  const host = groupClipById(doc, units.groups[0]!);
  if (!host || host.mode !== mode) return null;
  const newcomers = units.clips
    .map((id) => selectedVisuals(doc, [id])[0])
    .filter((c): c is VisualClip => !!c);
  // Siblings only: adopting across parents would silently move a layer out of
  // the group it was in, which is a different edit from the one being asked for.
  const hostScope = groupOfClip(doc, host.id);
  if (!newcomers.every((c) => groupOfClip(doc, c.id) === hostScope)) return null;
  for (const clip of newcomers) if (modeUsesStencil(mode)) clip.isStencil = false;
  // Newcomers take the BOTTOM of the host's rows: content sits under the
  // stencil, and under everything already there, which is where a new
  // operand reads as "added to" rather than "in front of".
  moveClipsToScope(doc, newcomers.map((c) => c.id), host.id, { at: scopeBottom(doc, host.id) });
  return host.id;
}

/** The `doc.tracks` index just past a group's last row. */
function scopeBottom(doc: MotionDocument, groupId: string): number {
  let end = -1;
  doc.tracks.forEach((t, i) => {
    if (t.groupId === groupId) end = i + 1;
  });
  return end >= 0 ? end : doc.tracks.findIndex((t) => t.clips.some((c) => c.id === groupId)) + 1;
}

/**
 * Flip one member between STENCIL and CONTENT within its composite group. The
 * one writer behind the layers-list badge, the timeline badge and the Combine
 * row, so the three can never disagree about which side a layer is on.
 */
export function setClipStencilRole(doc: MotionDocument, clipId: string, isStencil: boolean): void {
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "audio" && clip.id === clipId) clip.isStencil = isStencil;
    }
  }
}

/**
 * SWAP SIDES — every direct member of a composite group changes role at once.
 *
 * The question people actually ask of a mask is "no, the OTHER one" and until
 * now the only answer was to find each layer and flip it, one at a time, in a
 * panel that shows two sections when there are two layers and N rows when there
 * are N. An inversion is the generalisation that stays right at any count: two
 * members swap, five members turn inside out, and a group with everything on
 * one side is a no-op rather than a destroyed arrangement.
 *
 * Direct members only, at this depth. A nested composite keeps its own roles —
 * it is one member of this group and one operation of its own, and folding the
 * two would make "swap" mean something different depending on how deep you
 * happened to be looking.
 *
 * Returns false when the group has no sides to swap (plain, union, or missing),
 * so the callers' enabled state is this function's answer rather than a second
 * copy of the rule.
 */
export function swapGroupRoles(doc: MotionDocument, groupId: string): boolean {
  const group = groupClipById(doc, groupId);
  if (!group || !modeUsesStencil(group.mode)) return false;
  const direct = selectedVisuals(doc, clipsInGroup(doc, groupId));
  if (direct.length < 2) return false;
  for (const clip of direct) clip.isStencil = !clip.isStencil;
  // A swap that empties the stencil side leaves the mode meaningless (every
  // mode with no stencil renders as its content, which reads as "the mask
  // stopped working"). That only happens when every member was a stencil, so
  // put the topmost back — the same layer `setGroupMode` promotes.
  if (!direct.some((c) => c.isStencil)) direct[0]!.isStencil = true;
  return true;
}

/** A group's composite mode ("pass" for plain/missing groups). */
export function groupModeOf(doc: MotionDocument, groupId: string | null): GroupMode {
  return groupClipById(doc, groupId)?.mode ?? "pass";
}

/**
 * A composite group's members split into the two sides its mode operates on,
 * each in paint order (top first). Stencils are DIRECT members flagged
 * `isStencil`; everything else is content.
 *
 * The ONE partition — the renderer, the flattener, the layers list and the
 * timeline badges all call it, so "which layers are doing the cutting" has a
 * single answer at every depth and in every mode.
 */
export function groupRoles(
  doc: MotionDocument,
  groupId: string,
): { stencils: VisualClip[]; contents: VisualClip[] } {
  const members = selectedVisuals(doc, clipsInGroup(doc, groupId));
  const mode = groupModeOf(doc, groupId);
  if (!modeUsesStencil(mode)) return { stencils: [], contents: members };
  return {
    stencils: members.filter((c) => c.isStencil),
    contents: members.filter((c) => !c.isStencil),
  };
}
