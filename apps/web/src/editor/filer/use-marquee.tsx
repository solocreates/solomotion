"use client";

import * as React from "react";
import type { FilerStore } from "./use-file-manager";
import { useSweepSelect } from "../state/use-sweep-select";

/**
 * Rubber-band selection over the grid background — drag an empty area to sweep a
 * rectangle and select every card it touches (hit-tested by each card's
 * `data-node-id` box). Holding Shift adds to the existing selection; a plain
 * empty click (no drag) clears it. Thin FilerStore binding over the shared
 * [[useSweepSelect]] gesture (same approach as the stage/timeline marquees and
 * the flipbook sheet).
 */
export function useMarquee<T>(fm: FilerStore<T>, containerRef: React.RefObject<HTMLElement | null>) {
  const baseRef = React.useRef<string[]>([]);
  return useSweepSelect(containerRef, "data-node-id", {
    onDragStart: (additive) => {
      baseRef.current = additive ? [...fm.getState().selection.selected] : [];
    },
    onSweep: (hits) => fm.getState().setSelection([...new Set([...baseRef.current, ...hits])]),
    onClear: () => fm.getState().clearSelection(),
  });
}
