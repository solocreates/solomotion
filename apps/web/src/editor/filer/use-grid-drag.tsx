"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { isDescendant } from "./model/tree";
import type { FilerStore } from "./use-file-manager";
import { beginHeldDrag } from "../input/hold-to-drag";
import { subscribePointerEnd } from "../input/pointer-gestures";

/**
 * Pointer-drag for the grid — the same ghost pattern the editor's
 * `use-library-drag` uses, specialised for moving a (multi-)selection into a
 * folder. Before the drag arms it is a plain selecting click; after, a floating
 * stacked ghost with a count badge follows the cursor and highlights whatever
 * drop target (`data-drop-folder-id` folder cards, `data-drop-parent`
 * breadcrumb crumbs) is under it. On release it reparents via `fm.move`, guarding
 * against dropping a folder into itself or its own descendant.
 */

const DROP_ATTR = "data-drop-over";

interface Ghost {
  x: number;
  y: number;
  label: string;
  count: number;
}

/** Resolve the drop target folder id (null = root) under a point, or `false`. */
function dropTargetAt(x: number, y: number): string | null | false {
  const el = document.elementFromPoint(x, y);
  if (!el) return false;
  const folder = el.closest("[data-drop-folder-id]");
  if (folder) return folder.getAttribute("data-drop-folder-id");
  const crumb = el.closest("[data-drop-parent]");
  if (crumb) {
    const v = crumb.getAttribute("data-drop-parent");
    return v === "" ? null : v;
  }
  return false;
}

const DOUBLE_CLICK_MS = 350;

export function useGridDrag<T>(fm: FilerStore<T>) {
  const [ghost, setGhost] = React.useState<Ghost | null>(null);
  const highlighted = React.useRef<Element | null>(null);
  // Own the double-click (open) so it survives the re-render each click causes —
  // native dblclick is unreliable when the card re-renders between clicks.
  const lastClick = React.useRef<{ id: string; t: number }>({ id: "", t: 0 });

  const clearHighlight = () => {
    highlighted.current?.removeAttribute(DROP_ATTR);
    highlighted.current = null;
  };

  const beginDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    // Modifier press = a selection gesture, never a drag.
    if (additive) {
      fm.getState().clickNode(id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
      return;
    }

    const sel = fm.getState().selection.selected;
    const wasSelected = sel.has(id);
    // Pressing an unselected card selects it so the drag has something to move.
    if (!wasSelected) fm.getState().clickNode(id, {});

    const dragIds = [...fm.getState().selection.selected];
    const tree = fm.getState().tree;
    const draggedFolders = dragIds.filter((d) => tree.folders.some((f) => f.id === d));
    const label = [...tree.folders, ...tree.items].find((n) => n.id === id)?.name ?? "item";

    /*
     * The grid scrolls and a card drags, both with one finger. The scope
     * decides — a swipe scrolls, a brief hold picks the card up — instead of
     * this private threshold, which armed a rearrange on any finger that
     * brushed past a card on a tablet.
     */
    const arm = beginHeldDrag(e, { axis: "both" });
    let dragging = false;

    const onMove = (ev: PointerEvent) => {
      if (!arm.update(ev.clientX, ev.clientY)) return;
      dragging = true;
      setGhost({ x: ev.clientX, y: ev.clientY, label, count: dragIds.length });
      const target = dropTargetAt(ev.clientX, ev.clientY);
      clearHighlight();
      if (target !== false && canDrop(target)) {
        const el =
          document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-drop-folder-id],[data-drop-parent]") ??
          null;
        if (el) {
          el.setAttribute(DROP_ATTR, "true");
          highlighted.current = el;
        }
      }
    };

    const canDrop = (target: string | null): boolean => {
      if (target !== null && dragIds.includes(target)) return false; // onto self
      // No folder may drop into its own subtree.
      for (const folderId of draggedFolders) {
        if (target !== null && isDescendant(tree, target, folderId)) return false;
      }
      // Don't "move" into the folder you're already in (no-op).
      const someElsewhere = dragIds.some((d) => {
        const node = [...tree.folders, ...tree.items].find((n) => n.id === d);
        return (node?.parentId ?? null) !== target;
      });
      return someElsewhere;
    };

    const detach = () => {
      arm.end();
      off();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setGhost(null);
      clearHighlight();
    };

    const onUp = (ev: PointerEvent) => {
      detach();
      // A swipe the grid took is not a click: it selects nothing and opens
      // nothing. Without this, scrolling a folder full of cards opened one.
      if (!dragging) {
        if (arm.abandoned()) return;
        // A second plain click on the same card within the window = open it.
        const now = Date.now();
        if (lastClick.current.id === id && now - lastClick.current.t < DOUBLE_CLICK_MS) {
          lastClick.current = { id: "", t: 0 };
          fm.getState().activate(id);
        } else {
          lastClick.current = { id, t: now };
          fm.getState().clickNode(id, {}); // collapse selection to this card
        }
        return;
      }
      const target = dropTargetAt(ev.clientX, ev.clientY);
      if (target !== false && canDrop(target)) void fm.getState().move(dragIds, target);
    };

    // Cancel and "lost" never arrive as `pointerup`. A drag that only tore
    // down on release leaked its move handler for the rest of the session.
    const off = subscribePointerEnd((pid, reason) => {
      if (pid !== e.pointerId) return;
      if (reason !== "up") detach();
    });
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const ghostNode =
    ghost &&
    createPortal(
      <div
        className="pointer-events-none fixed z-200 -translate-x-2 -translate-y-2"
        style={{ left: ghost.x, top: ghost.y }}
      >
        <div className="relative">
          {ghost.count > 1 && (
            <>
              <div className="absolute left-1.5 top-1.5 h-full w-full rounded-md border border-primary/40 bg-card/80" />
              <div className="absolute left-0.5 top-0.5 h-full w-full rounded-md border border-primary/50 bg-card/90" />
            </>
          )}
          <div className="relative max-w-45 truncate rounded-md border border-primary/60 bg-card px-2.5 py-1.5 text-xs font-medium shadow-xl">
            {ghost.label}
          </div>
          {ghost.count > 1 && (
            <span className="absolute -right-2 -top-2 flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground shadow">
              {ghost.count}
            </span>
          )}
        </div>
      </div>,
      document.body,
    );

  return { beginDrag, ghostNode };
}
