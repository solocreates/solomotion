"use client";

/**
 * MOVING AN EDITOR — the drag from a rail item, a region header or a floating
 * window's title, through the drop solver, to a committed layout.
 *
 * Two decisions carry the feel:
 *
 * 1. The arbitration is the app's (`beginHeldDrag`), not ours. A rail is a
 *    scroller, so on touch the gesture scope there is `defer`: a finger that
 *    moves at once SCROLLS the rail, a finger that rests briefly LIFTS the
 *    item. A mouse lifts on its first few pixels. Nothing here re-decides
 *    that, which is why rails keep their one-finger scroll.
 *
 * 2. The solver runs on the layout AS DRAWN: hidden regions pruned, split
 *    sizes measured from the DOM, the gutter measured too. Applying the
 *    target to the real tree then lays out exactly what the overlay showed,
 *    because hidden regions stay hidden — preview == result in pixels, not
 *    just in kind.
 *
 * Teardown is every exit: up, cancel, `subscribePointerEnd` (lost,
 * superseded by a second finger), Escape. Abort never commits.
 */

import { create } from "zustand";
import { beginHeldDrag } from "../input/hold-to-drag";
import { subscribePointerEnd } from "../input/pointer-gestures";
import { usePanels } from "../state/panels";
import { editorMeta, isEditorId, type EditorId } from "./editor-registry";
import { applyDrop, solveDrop, type DropList, type DropSolution } from "./drop-solver";
import { findRegion, regionOf, type Bounds, type Edge, type LayoutNode, type Workspace } from "./layout-tree";
import { showRegion, useLayout } from "./store";

export interface WorkspaceDrag {
  editor: EditorId;
  pointer: { x: number; y: number };
  solution: DropSolution | null;
}

export const useWorkspaceDrag = create<{ drag: WorkspaceDrag | null }>(() => ({ drag: null }));

/**
 * The live badge for one list (a rail or a strip): which editor, at which
 * slot — or null. A primitive-ish selector so a rail re-renders only when ITS
 * badge moves, not on every pointer frame.
 */
export function useListPreview(listId: string | undefined): { editor: EditorId; slot: number } | null {
  const key = useWorkspaceDrag((s) => {
    const t = s.drag?.solution?.target;
    return listId && t?.kind === "list" && t.list === listId ? `${s.drag!.editor}:${t.slot}` : "";
  });
  if (!key) return null;
  const [editor, slot] = key.split(":");
  return { editor: editor as EditorId, slot: Number(slot) };
}

/** The editor being dragged right now, if any (its own items dim). */
export function useDraggingEditor(): EditorId | null {
  return useWorkspaceDrag((s) => s.drag?.editor ?? null);
}

/**
 * THE LISTS AS DRAWN — every rail and tab strip, measured. Surfaces opt in
 * with attributes, so the solver needs no knowledge of components:
 *
 *   [data-dock-band=id]  the band (+ data-dock-kind rail|strip, data-dock-edge,
 *                        data-dock-region for an empty strip)
 *   [data-dock-list=id]  the item container (+ data-dock-axis x|y)
 *   [data-dock-item=editor][data-dock-region=region]  one per item; several
 *                        items of one editor (Properties' tabs) are one block
 *
 * Rects are NATURAL: the dragged editor is removed and the items after it
 * shifted back over its hole, so the slot maths is stable while the
 * surface visibly closes the hole and parts around the badge. Indices are
 * read from the real tree (hidden regions included — dropping on the rail of
 * a closed panel opens it).
 *
 * Compact presents every rail in one dock; it keeps the region targets only,
 * exactly as before (a phone never rewrites the desktop by accident).
 */
export function measureDockLists(ws: Workspace, dragged: EditorId): DropList[] {
  if (typeof document === "undefined" || usePanels.getState().density === "compact") return [];
  const out: DropList[] = [];
  for (const band of Array.from(document.querySelectorAll<HTMLElement>("[data-dock-band]"))) {
    const id = band.dataset.dockBand!;
    const listEl = band.matches(`[data-dock-list]`) ? band : band.querySelector<HTMLElement>(`[data-dock-list="${CSS.escape(id)}"]`);
    if (!listEl) continue;
    const axis = listEl.dataset.dockAxis === "x" ? "x" : "y";
    const kind = band.dataset.dockKind === "strip" ? "strip" : "rail";
    const blocks: { editor: EditorId; regionId: string; rect: Bounds }[] = [];
    for (const el of Array.from(listEl.querySelectorAll<HTMLElement>("[data-dock-item]"))) {
      const editor = el.dataset.dockItem;
      const regionId = el.dataset.dockRegion;
      if (!isEditorId(editor) || !regionId) continue;
      const r = rectOf(el);
      const last = blocks[blocks.length - 1];
      if (last && last.editor === editor) {
        const x = Math.min(last.rect.x, r.x);
        const y = Math.min(last.rect.y, r.y);
        last.rect = { x, y, width: Math.max(last.rect.x + last.rect.width, r.x + r.width) - x, height: Math.max(last.rect.y + last.rect.height, r.y + r.height) - y };
      } else blocks.push({ editor, regionId, rect: r });
    }
    // The badge's length: the dragged item itself when it comes from this
    // list, else this list's typical item — plus the gap between items.
    const len = (r: Bounds) => (axis === "x" ? r.width : r.height);
    const at = blocks.findIndex((b) => b.editor === dragged);
    const gapPx = blocks.length > 1 ? Math.max(0, (axis === "x" ? blocks[1]!.rect.x - blocks[0]!.rect.x : blocks[1]!.rect.y - blocks[0]!.rect.y) - len(blocks[0]!.rect)) : 4;
    const singles = blocks.filter((b) => b.editor !== "inspector").map((b) => len(b.rect)).sort((a, b) => a - b);
    const badge = (at >= 0 ? len(blocks[at]!.rect) : singles[Math.floor(singles.length / 2)] ?? 44) + gapPx;
    // Close the dragged editor's hole.
    if (at >= 0) {
      const gone = blocks[at]!.rect;
      const next = blocks[at + 1]?.rect;
      const shift = next ? (axis === "x" ? next.x - gone.x : next.y - gone.y) : 0;
      blocks.splice(at, 1);
      for (let i = at; i < blocks.length; i++) {
        const r = blocks[i]!.rect;
        blocks[i]!.rect = axis === "x" ? { ...r, x: r.x - shift } : { ...r, y: r.y - shift };
      }
    }
    const items = blocks.map((b) => {
      const editors = findRegion(ws, b.regionId)?.editors.filter((e) => e !== dragged) ?? [];
      return { ...b, index: Math.max(0, editors.indexOf(b.editor)) };
    });
    const edge = band.dataset.dockEdge as Edge | undefined;
    out.push({ id, kind, axis, band: rectOf(band), edge: edge ?? null, regionId: band.dataset.dockRegion ?? null, items, badge });
  }
  return out;
}

/** Attribute every rendered tree node carries, so the drag can measure it. */
export const WS_NODE_ATTR = "data-ws-node";

const rectOf = (el: Element): Bounds => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};

/**
 * The tree as it is DRAWN right now: nodes without a DOM element (hidden
 * regions, empty splits) pruned, split sizes from measured lengths.
 */
export function measuredWorkspace(ws: Workspace, root: HTMLElement | null): { ws: Workspace; rect: Bounds; gutter: number } | null {
  if (!root) return null;
  const els = new Map<string, Element>();
  // The root itself carries the tree root's id — querySelectorAll never
  // returns the element it is called on.
  for (const el of [root, ...Array.from(root.querySelectorAll(`[${WS_NODE_ATTR}]`))]) {
    const id = el.getAttribute(WS_NODE_ATTR);
    if (id) els.set(id, el);
  }
  const gutters: number[] = [];
  const prune = (node: LayoutNode): LayoutNode | null => {
    const el = els.get(node.id);
    if (!el) return null;
    if (node.kind === "region") return node;
    const kids = node.children
      .map((c) => ({ node: prune(c.node), el: els.get(c.node.id) }))
      .filter((k): k is { node: LayoutNode; el: Element } => !!k.node && !!k.el);
    if (kids.length === 0) return null;
    if (kids.length === 1) return kids[0]!.node;
    const rects = kids.map((k) => rectOf(k.el));
    const len = (r: Bounds) => (node.axis === "row" ? r.width : r.height);
    const total = rects.reduce((a, r) => a + len(r), 0) || 1;
    for (let i = 1; i < rects.length; i++) {
      const a = rects[i - 1]!;
      const b = rects[i]!;
      gutters.push(node.axis === "row" ? b.x - (a.x + a.width) : b.y - (a.y + a.height));
    }
    return { ...node, children: kids.map((k, i) => ({ node: k.node, size: len(rects[i]!) / total })) };
  };
  const pruned = prune(ws.root);
  const rootEl = els.get(ws.root.id) ?? root;
  if (!pruned) return null;
  const gutter = gutters.length ? Math.max(0, gutters.reduce((a, g) => a + g, 0) / gutters.length) : 0;
  return { ws: { ...ws, root: pruned }, rect: rectOf(rootEl), gutter };
}

let rootEl: HTMLElement | null = null;
/** The shell registers the element its tree renders into. */
export function setDragRoot(el: HTMLElement | null): void {
  rootEl = el;
}

/** Commit a solution to the REAL tree and make the editor visible there. */
export function commitDrop(editor: EditorId, solution: DropSolution, pointer: { x: number; y: number }): void {
  const t = solution.target;
  const layout = useLayout.getState();
  if (t.kind === "none") return;
  if (t.kind === "float") {
    if (regionOf(layout.ws, editor) || layout.ws.windows.some((w) => w.editor === editor)) layout.float(editor, pointer);
    return;
  }
  layout.apply((ws) => applyDrop(ws, editor, t) ?? ws);
  const region = regionOf(useLayout.getState().ws, editor);
  if (region) {
    if (region.id === "timeline") layout.reveal(editor);
    else showRegion(region.id);
  }
}

/**
 * Start a solver session that something else drives (a floating window's
 * title drag, or `beginEditorDrag`). `source` is the list the press began in
 * — a tab strip sorts until the pointer tears out of it, then the same
 * session docks; there is no second recognizer.
 */
export function createDropSession(editor: EditorId, opts: { allowFloat: boolean; source?: { list: string; span: number } | null }) {
  const real = useLayout.getState().ws;
  const measured = measuredWorkspace(real, rootEl);
  const lists = measureDockLists(real, editor);
  let solution: DropSolution | null = null;
  let torn = false;
  document.documentElement.setAttribute("data-ws-dragging", "");
  return {
    move(pointer: { x: number; y: number }) {
      if (!measured) return;
      const s = solveDrop(measured.ws, measured.rect, editor, pointer, {
        gutter: measured.gutter,
        prev: solution,
        floatSize: editorMeta(editor)?.floatSize,
        lists,
        source: opts.source ? { ...opts.source, torn } : null,
      });
      solution = !opts.allowFloat && s.target.kind === "float" ? null : s;
      if (opts.source && !(s.target.kind === "list" && s.target.list === opts.source.list)) torn = true;
      useWorkspaceDrag.setState({ drag: { editor, pointer, solution } });
    },
    end(commit: boolean, pointer: { x: number; y: number }) {
      document.documentElement.removeAttribute("data-ws-dragging");
      useWorkspaceDrag.setState({ drag: null });
      if (commit && solution) commitDrop(editor, solution, pointer);
    },
  };
}

/**
 * Begin a possible editor drag from a press. Returns nothing; a press that
 * never becomes a drag leaves the click to the element.
 */
export function beginEditorDrag(e: React.PointerEvent | PointerEvent, editor: EditorId): void {
  if (editor === "stage") return;
  if (e.button !== 0) return;
  const held = beginHeldDrag(e, { axis: "both" });
  const pointerId = e.pointerId;
  // The list the press began in (a tab strip sorts before it tears out).
  const pressed = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-dock-item]") : null;
  const listEl = pressed?.closest<HTMLElement>("[data-dock-list]");
  const source = listEl
    ? {
        list: listEl.dataset.dockList!,
        span: listEl.dataset.dockAxis === "x" ? pressed!.getBoundingClientRect().width : pressed!.getBoundingClientRect().height,
      }
    : null;
  let session: ReturnType<typeof createDropSession> | null = null;
  let last = { x: e.clientX, y: e.clientY };
  let raf = 0;

  const teardown = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    offEnd();
    held.end();
    cancelAnimationFrame(raf);
  };

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    last = { x: ev.clientX, y: ev.clientY };
    if (!session) {
      if (!held.update(ev.clientX, ev.clientY)) {
        if (held.abandoned()) teardown();
        return;
      }
      session = createDropSession(editor, { allowFloat: true, source });
    }
    ev.preventDefault();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => session?.move(last));
  };

  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    teardown();
    if (!session) return;
    // The click that follows a drag must not also toggle the rail item.
    const swallow = (c: MouseEvent) => {
      c.stopPropagation();
      c.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    session.move(last);
    session.end(true, last);
  };

  const abort = () => {
    teardown();
    session?.end(false, last);
  };
  const onCancel = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) abort();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !session) return;
    ev.preventDefault();
    ev.stopPropagation();
    abort();
  };
  const offEnd = subscribePointerEnd((id, reason) => {
    if (id === pointerId && reason !== "up") abort();
  });

  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
}
