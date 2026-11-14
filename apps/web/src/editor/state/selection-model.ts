/**
 * The pure selection model — the single source of truth for how clicks, the
 * marquee, and the keyboard change what's selected. Shift extends a range from
 * an anchor; ⌘/Ctrl toggles; a plain click replaces and re-anchors. Reused by
 * every interaction so behaviour can never drift between them (mirrors the
 * timeline's marquee/selection rules). No React, no DOM.
 */

export interface SelectionState {
  selected: ReadonlySet<string>;
  /** The pivot for shift-range extension (last plain click). */
  anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { selected: new Set(), anchor: null };

interface ClickMods {
  shift?: boolean;
  /** ⌘ on macOS / Ctrl elsewhere — additive toggle. */
  meta?: boolean;
}

/** Inclusive index range between two ids in the ordered domain. */
function range(order: string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i === -1 || j === -1) return b === a ? [a] : [];
  const [lo, hi] = i <= j ? [i, j] : [j, i];
  return order.slice(lo, hi + 1);
}

/** Resolve a click (with modifiers) against the current selection. */
export function clickSelect(
  order: string[],
  state: SelectionState,
  id: string,
  mods: ClickMods = {},
): SelectionState {
  if (mods.shift && state.anchor) {
    const next = new Set(mods.meta ? state.selected : []);
    for (const r of range(order, state.anchor, id)) next.add(r);
    return { selected: next, anchor: state.anchor };
  }
  if (mods.meta) {
    const next = new Set(state.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { selected: next, anchor: id };
  }
  // Plain click: if it's already the sole selection, keep it; else select only it.
  return { selected: new Set([id]), anchor: id };
}

/** Replace the selection with an explicit set (marquee commit, select-all). */
export function setSelection(ids: Iterable<string>, anchor: string | null = null): SelectionState {
  return { selected: new Set(ids), anchor };
}

/** Marquee: base selection (kept when additive) unioned with the hit set. */
export function marqueeSelect(
  base: SelectionState,
  hits: Iterable<string>,
  additive: boolean,
): SelectionState {
  const next = new Set(additive ? base.selected : []);
  for (const id of hits) next.add(id);
  return { selected: next, anchor: base.anchor };
}

export function selectAll(order: string[]): SelectionState {
  return { selected: new Set(order), anchor: order[0] ?? null };
}

/** Drop ids that no longer exist (after a move/delete/navigation). */
export function pruneSelection(state: SelectionState, valid: ReadonlySet<string>): SelectionState {
  const next = new Set<string>();
  for (const id of state.selected) if (valid.has(id)) next.add(id);
  if (next.size === state.selected.size) return state;
  return { selected: next, anchor: state.anchor && next.has(state.anchor) ? state.anchor : null };
}
