"use client";

import * as React from "react";
import type { Asset } from "@solomotion/core";
import type { FilerNode } from "../filer/model/tree";
import type { FilerStore } from "../filer/use-file-manager";
import { useDragOut } from "./drag-out";

/**
 * The one media-tile drag. Inside the library it drops a (multi-)selection into
 * a folder; dragged OUT over the canvas, the timeline or the layers tree it
 * places a clip. Everything the two directions share — the threshold, the
 * ghost, the session publish, the routing, the teardown — is `useDragOut`;
 * what's left here is the only thing that is actually about media: folders.
 *
 * Below the threshold it's a select; a quick second press places
 * (double-click), mirroring the grid.
 */

const DOUBLE_MS = 350;
const DROP_ATTR = "data-drop-over";

function folderTargetAt(x: number, y: number): string | null | false {
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

export function useMediaDrag(fm: FilerStore<Asset>) {
  const { startDragOut, ghostNode } = useDragOut();
  const highlighted = React.useRef<Element | null>(null);
  const lastClick = React.useRef<{ id: string; t: number }>({ id: "", t: 0 });

  const clearHighlight = () => {
    highlighted.current?.removeAttribute(DROP_ATTR);
    highlighted.current = null;
  };

  const beginDrag = (e: React.PointerEvent, node: FilerNode<Asset>) => {
    if (e.button !== 0) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      fm.getState().clickNode(node.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
      return;
    }
    if (!fm.getState().selection.selected.has(node.id)) fm.getState().clickNode(node.id, {});
    const dragIds = [...fm.getState().selection.selected];

    startDragOut(e, {
      // Only items (assets) place a clip when dragged out; a folder dragged
      // onto the canvas/timeline resolves to no asset there and no-ops.
      drag: { kind: "media", id: node.id, label: node.name },
      count: dragIds.length,
      onHover: (x, y) => {
        clearHighlight();
        const el = document.elementFromPoint(x, y)?.closest("[data-drop-folder-id],[data-drop-parent]");
        if (el) {
          el.setAttribute(DROP_ATTR, "true");
          highlighted.current = el;
        }
      },
      onDropElsewhere: (x, y) => {
        const target = folderTargetAt(x, y);
        if (target === false) return false;
        void fm.getState().move(dragIds, target);
        return true;
      },
      onEnd: clearHighlight,
      onClick: () => {
        const now = Date.now();
        if (lastClick.current.id === node.id && now - lastClick.current.t < DOUBLE_MS) {
          lastClick.current = { id: "", t: 0 };
          fm.getState().activate(node.id); // place on the active frame
        } else {
          lastClick.current = { id: node.id, t: now };
          fm.getState().clickNode(node.id, {});
        }
      },
    });
  };

  return { beginDrag, ghostNode };
}
