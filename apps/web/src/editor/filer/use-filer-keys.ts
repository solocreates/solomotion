"use client";

import * as React from "react";
import type { FilerStore } from "./use-file-manager";
import { eventKey } from "../state/shortcut-registry";
import { isTypingTarget } from "../input/typing-target";

/**
 * Keyboard for the file manager — a scoped window handler (this is a distinct
 * surface from the editor, so it's intentionally not in the editor's
 * shortcut-registry). Clipboard (⌘C/X/V), duplicate (⌘D), select-all (⌘A),
 * rename (F2), open (Enter), clear (Esc), delete (⌦/Backspace → a confirm the
 * host supplies), and arrow-key navigation over the current view order. Ignores
 * events while typing, renaming, or a modal is open.
 */

interface Options {
  /** The grid element — used to read the live column count for up/down nav. */
  gridRef: React.RefObject<HTMLElement | null>;
  /** Host-owned delete (opens a confirm dialog); receives the target ids. */
  onRequestDelete: (ids: string[]) => void;
  enabled?: boolean;
}

function columnCount(grid: HTMLElement | null): number {
  if (!grid) return 1;
  const cols = getComputedStyle(grid).gridTemplateColumns;
  return Math.max(1, cols.split(" ").filter(Boolean).length);
}

export function useFilerKeys<T>(fm: FilerStore<T>, { gridRef, onRequestDelete, enabled = true }: Options) {
  React.useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const s = fm.getState();
      if (s.renamingId) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;

      const meta = e.metaKey || e.ctrlKey;
      const key = eventKey(e);
      const selected = [...s.selection.selected];

      if (meta && key === "a") {
        e.preventDefault();
        s.selectAll();
        return;
      }
      if (meta && key === "c") {
        if (selected.length) s.copy();
        return;
      }
      if (meta && key === "x") {
        if (selected.length) s.cut();
        return;
      }
      if (meta && key === "v") {
        e.preventDefault();
        void s.paste();
        return;
      }
      if (meta && key === "d") {
        e.preventDefault();
        void s.duplicateSelection();
        return;
      }
      if (key === "Delete" || key === "Backspace") {
        if (selected.length) {
          e.preventDefault();
          onRequestDelete(selected);
        }
        return;
      }
      if (key === "Escape") {
        s.clearSelection();
        return;
      }
      if (key === "F2") {
        if (selected.length) s.beginRename(selected[selected.length - 1]!);
        return;
      }
      if (key === "Enter") {
        if (selected.length === 1) {
          e.preventDefault();
          s.activate(selected[0]!);
        }
        return;
      }

      // Arrow navigation over the visible order.
      const arrows: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: 0, ArrowDown: 0 };
      if (key in arrows) {
        const order = s.view().order;
        if (order.length === 0) return;
        e.preventDefault();
        const cols = columnCount(gridRef.current);
        const step = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : key === "ArrowUp" ? -cols : cols;
        const anchor = s.selection.anchor ?? selected[selected.length - 1] ?? order[0]!;
        const from = Math.max(0, order.indexOf(anchor));
        const to = Math.min(order.length - 1, Math.max(0, from + step));
        const targetId = order[to]!;
        s.clickNode(targetId, { shift: e.shiftKey });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fm, gridRef, onRequestDelete, enabled]);
}
