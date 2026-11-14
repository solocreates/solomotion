import type { MotionDocument } from "../schema/document";
import { clipAncestorGroups } from "./groups";
import { isClipLocked, locateClip } from "./ops";

/**
 * WHICH LAYER a pointer gesture acts on when several are stacked under it.
 *
 * The stack itself is a rendering question (the canvas has world boxes, the
 * layers tree has rows), but the CHOICE is pure policy, and it was being
 * decided independently by whoever happened to be handling the event — which
 * is how the stage ended up answering a left click with one layer and a right
 * click on the same pixel with another.
 *
 * Both rules below exist because a menu is a statement about a thing the user
 * has already identified. It is not a selection gesture wearing a different
 * button.
 */

/** Ordered topmost-first. */
export type LayerStack = readonly string[];

/**
 * The layer a SELECTING gesture (left click, drag) claims: the topmost one that
 * is not locked. Locked layers are transparent — Figma's rule — so a locked
 * backdrop can never eat a click meant for what is under it.
 */
export function pickSelectTarget(doc: MotionDocument, stack: LayerStack): string | null {
  return stack.find((id) => !layerLocked(doc, id)) ?? null;
}

/**
 * The layer a CONTEXT MENU targets. Three rules, in order:
 *
 *  1. **The selection wins.** If anything already selected is in the stack, the
 *     menu is about THAT, even with an unselected layer stacked over it. A menu
 *     that retargets out from under you acts on something other than the thing
 *     you were looking at, and the press that opened it was not a request to
 *     change the selection.
 *  2. Otherwise the topmost UNLOCKED layer — the same answer
 *     `pickSelectTarget` gives, so the two buttons can never disagree about
 *     "this one".
 *  3. Only when NOTHING unlocked is under the point does a locked layer become
 *     the target, because Unlock has to be reachable from somewhere.
 *
 * Rule 3 used to be rule 1 (take the topmost, locked included), which is the
 * whole bug: a locked layer over an unlocked one answered a left click with the
 * layer beneath and a right click with "Unlock" on the layer above.
 */
export function pickContextTarget(
  doc: MotionDocument,
  stack: LayerStack,
  selected: readonly string[],
): string | null {
  if (stack.length === 0) return null;
  const held = stack.find((id) => pressHoldsSelection(doc, [id], selected));
  if (held) return held;
  return pickSelectTarget(doc, stack) ?? stack[0] ?? null;
}

/** Combined lock (track OR clip) for a clip id — the one lock question. */
export function layerLocked(doc: MotionDocument, clipId: string): boolean {
  const loc = locateClip(doc, clipId);
  return !!loc && isClipLocked(loc.track, loc.clip);
}

/* ------------------------------------------------------- press vs. click */

/**
 * Does a press on `stack` land ON the current selection? True when any layer
 * under the point is selected itself, or sits inside a selected group — a
 * group is selected as a unit, and its members are the pixels that unit has.
 * The one question behind grab priority (`resolvePressSelection`'s `held`)
 * and the context menu's "the selection wins"; the two must not drift.
 */
export function pressHoldsSelection(
  doc: MotionDocument,
  stack: LayerStack,
  selected: readonly string[],
): boolean {
  if (selected.length === 0 || stack.length === 0) return false;
  const sel = new Set(selected);
  return stack.some((id) => sel.has(id) || clipAncestorGroups(doc, id).some((g) => sel.has(g.id)));
}

/**
 * THE shared press-selection resolver for every direct-manipulation surface —
 * the stage canvas and the timeline clips. One brain so they can never drift,
 * and so any surface added later reuses it instead of re-deriving it.
 *
 * Figma's rule in one sentence: **a drag moves what is selected; a click
 * selects what is under the cursor.** Those contradict only if you decide at
 * press time, so the press keeps whatever a drag would need and every
 * selection change a bare click would make is DEFERRED to the release —
 * `onClick` is the whole selection to apply if the press never moves.
 *
 *   plain, on the selection       hold it; click retargets to `picks`
 *   plain, elsewhere              select `picks` now
 *   ⇧, `picks` already selected   hold it; click toggles `picks` OUT
 *   ⇧, on the selection           hold it; click toggles `picks` IN
 *   ⇧, elsewhere                  add `picks` now, so the drag carries them
 *
 * `picks` is what a CLICK here selects, already expanded by the surface (the
 * group unit on the stage, the link group on the timeline). `held` is whether
 * the press landed ON the selection — a selected layer under the point, a
 * selected group's member, or the air inside the selection's box — which is
 * the surface's question (`pressHoldsSelection`), not this one's. The old
 * bug this kills: ⇧ used to switch grab priority off, so a ⇧-drag meant to
 * constrain a move grabbed the unselected layer on top and moved both.
 */
export interface PressSelection {
  /** Selection to apply on the press, so a drag operates on the right set. */
  selection: string[];
  /** Whether `selection` differs from `current` (lets a caller skip a no-op). */
  changed: boolean;
  /** Selection to apply INSTEAD if the press turns out to be a bare click; null when the release changes nothing. */
  onClick: string[] | null;
}

export function resolvePressSelection(
  current: readonly string[],
  picks: readonly string[],
  additive: boolean,
  held: boolean,
): PressSelection {
  const set = new Set(current);
  const picksSelected = picks.length > 0 && picks.every((id) => set.has(id));
  const keep = (onClick: string[] | null): PressSelection => ({ selection: [...current], changed: false, onClick });
  const union = () => [...current, ...picks.filter((id) => !set.has(id))];

  if (!additive) {
    if (picksSelected) return keep(null);
    if (held) return keep(picks.length ? [...picks] : null);
    return { selection: [...picks], changed: true, onClick: null };
  }
  if (picksSelected) {
    const drop = new Set(picks);
    return keep(current.filter((id) => !drop.has(id)));
  }
  if (held) return keep(picks.length ? union() : null);
  return { selection: union(), changed: true, onClick: null };
}
