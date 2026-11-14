"use client";

import * as React from "react";
import {
  EMPTY_SELECTION,
  clickSelect,
  marqueeSelect,
  pruneSelection,
  selectAll as selectAllOf,
  setSelection,
  type SelectionState,
} from "./selection-model";
import { useSweepSelect } from "./use-sweep-select";

/**
 * MULTI-SELECT for any ordered list of cards — the media library's gesture
 * vocabulary, handed to whoever asks.
 *
 * The two halves already existed and had never been put together: the pure
 * `selection-model` (click / shift-range / cmd-toggle / marquee / prune) and
 * the `useSweepSelect` gesture. Every surface that wanted both — the filer, the
 * flipbook, and now the effect stacks — was re-deriving the same twenty lines
 * of glue. This IS that glue, once, so a new list gets Figma-grade selection by
 * mounting a hook and spreading two prop bags.
 *
 * `order` is the list's current id order, and it is also the domain the model
 * prunes against: delete a card and it leaves the selection on its own, with no
 * call site remembering to tidy up.
 *
 * The caller keeps ownership of what selection MEANS — what a right-click
 * offers, what Delete does — because that is the only part that differs between
 * a folder of files and a stack of effects.
 */
export interface ListSelection {
  selected: ReadonlySet<string>;
  isSelected: (id: string) => boolean;
  /**
   * The ids to act on when a verb fires on `id`: the whole selection when `id`
   * is part of it, otherwise just `id`. The rule every file manager uses, and
   * the reason right-clicking one card of five does not silently drop four.
   */
  actionable: (id: string) => string[];
  onItemPointerDown: (id: string, e: React.PointerEvent | React.MouseEvent) => void;
  /** Props for each card — carries the marquee's hit-test tag. */
  itemProps: (id: string) => { "data-select-id": string };
  /** Props for the list container (marquee gesture + empty-click clear). */
  containerProps: { onPointerDown: (e: React.PointerEvent) => void };
  /** The rubber band. Render inside a `relative` container. */
  marqueeNode: React.ReactNode;
  select: (ids: Iterable<string>) => void;
  selectAll: () => void;
  clear: () => void;
}

export function useListSelection(
  order: string[],
  containerRef: React.RefObject<HTMLElement | null>,
): ListSelection {
  const [state, setState] = React.useState<SelectionState>(EMPTY_SELECTION);
  const orderRef = React.useRef(order);
  orderRef.current = order;

  // Ids that no longer exist leave on their own. Keyed on the joined order so
  // this runs when the LIST changes, not on every render of a stable list.
  const orderKey = order.join(" ");
  React.useEffect(() => {
    const valid = new Set(orderKey.split(" ").filter(Boolean));
    setState((s) => pruneSelection(s, valid));
  }, [orderKey]);

  const baseRef = React.useRef<SelectionState>(EMPTY_SELECTION);
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const { onPointerDown, marqueeNode } = useSweepSelect(containerRef, "data-select-id", {
    onDragStart: (additive) => {
      baseRef.current = additive ? stateRef.current : EMPTY_SELECTION;
    },
    onSweep: (hits) => setState(marqueeSelect(baseRef.current, hits, true)),
    onClear: () => setState(EMPTY_SELECTION),
  });

  return React.useMemo<ListSelection>(() => {
    const selected = state.selected;
    return {
      selected,
      isSelected: (id) => selected.has(id),
      actionable: (id) => (selected.has(id) && selected.size > 1 ? [...selected] : [id]),
      // Pointer-DOWN, not click: a right-click must resolve the selection
      // BEFORE its menu opens, or "delete these three" would act on the three
      // you had a moment ago. A right-click on a card that is ALREADY part of
      // the selection leaves it alone, though — otherwise every attempt to
      // right-click a multi-selection would collapse it to one first, which is
      // precisely the case the menu exists to serve.
      onItemPointerDown: (id, e) => {
        if (e.button === 2 && selected.has(id)) return;
        setState((s) => clickSelect(orderRef.current, s, id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey }));
      },
      itemProps: (id) => ({ "data-select-id": id }),
      containerProps: { onPointerDown },
      marqueeNode,
      select: (ids) => setState(setSelection(ids)),
      selectAll: () => setState(selectAllOf(orderRef.current)),
      clear: () => setState(EMPTY_SELECTION),
    };
  }, [state, onPointerDown, marqueeNode]);
}
