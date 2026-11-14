/**
 * THE WINDOW HOST SEAM (README D4) — any editor in three hosts: docked (a
 * region), floating (`FloatingWindow`) or an OS window, with HOME memory so
 * closing a detached editor puts it back where it came from.
 *
 * This file is the headless half: the state machine over the layout tree
 * (which transitions are legal, where each one lands) and the OS-window
 * adapter CONTRACT. The DOM half (`os-window.ts`) implements the web/PWA
 * adapter with `window.open` + `createPortal` — one JS realm, one store, no
 * sync protocol.
 *
 * Tauri: a Tauri `WebviewWindow` is a separate webview with its OWN realm, so
 * it cannot share React state through a portal. Shipping it needs a sync
 * protocol and is out of scope; `osWindowSupport()` reports `"none"` there
 * and the menu hides "New window" rather than offering a door that fails.
 */

import { allowsHost, type EditorId, type HostKind } from "./editor-registry";
import {
  findRegion,
  floatEditor,
  hostOf,
  returnHome,
  windowEditor,
  type Bounds,
  type Workspace,
} from "./layout-tree";

export type HostTransition =
  | { to: "floating"; bounds: Bounds }
  | { to: "window"; bounds: Bounds }
  | { to: "home" }
  | { to: "region"; regionId: string };

export function canHost(editor: EditorId, host: HostKind, osWindows: OsWindowSupport): boolean {
  if (!allowsHost(editor, host)) return false;
  if (host === "window") return osWindows === "portal";
  return true;
}

/**
 * Move an editor between hosts. `rect` is the workspace rect (for the HOME
 * edge). Illegal moves return the workspace unchanged.
 */
export function transition(ws: Workspace, editor: EditorId, t: HostTransition, rect: Bounds, osWindows: OsWindowSupport = "portal"): Workspace {
  const now = hostOf(ws, editor);
  switch (t.to) {
    case "floating":
      if (!canHost(editor, "floating", osWindows) || now === "floating") return ws;
      return floatEditor(ws, editor, t.bounds, rect);
    case "window":
      if (!canHost(editor, "window", osWindows) || now === "window") return ws;
      return windowEditor(ws, editor, t.bounds, rect);
    case "home":
      if (now === "docked" || now === null) return ws;
      return returnHome(ws, editor);
    case "region": {
      if (!findRegion(ws, t.regionId)) return ws;
      // Docking a detached editor somewhere other than home: same as a drop.
      return returnHomeTo(ws, editor, t.regionId);
    }
  }
}

function returnHomeTo(ws: Workspace, editor: EditorId, regionId: string): Workspace {
  const f = ws.floating.find((x) => x.editor === editor) ?? ws.windows.find((x) => x.editor === editor);
  if (!f) return ws;
  const patched: Workspace = {
    ...ws,
    floating: ws.floating.map((x) => (x.editor === editor ? { ...x, home: { ...x.home, regionId, index: 1e9 } } : x)),
    windows: ws.windows.map((x) => (x.editor === editor ? { ...x, home: { ...x.home, regionId, index: 1e9 } } : x)),
  };
  return returnHome(patched, editor);
}

/** What this platform can do for OS windows. */
export type OsWindowSupport = "portal" | "none";

/**
 * The adapter contract. `open` returns a handle whose `container` is a DOM
 * node in the child window that React portals into; `onClose` fires when the
 * user closes the child (the editor then returns home).
 */
export interface OsWindowHandle {
  container: HTMLElement;
  window: Window;
  close: () => void;
  focus: () => void;
}

export interface OsWindowAdapter {
  support: OsWindowSupport;
  open: (opts: { key: string; title: string; bounds: Bounds; onClose: () => void }) => OsWindowHandle | null;
}

/**
 * Place a new floating window: centred on the pointer's side of the window,
 * clamped fully inside the viewport, cascading 24px per existing window.
 */
export function placeFloating(
  size: { w: number; h: number },
  viewport: { width: number; height: number },
  existing: number,
  at?: { x: number; y: number },
): Bounds {
  const w = Math.min(size.w, viewport.width - 32);
  const h = Math.min(size.h, viewport.height - 96);
  const x0 = at ? at.x - 24 : viewport.width - w - 340 - existing * 24;
  const y0 = at ? at.y - 14 : 72 + existing * 24;
  return {
    x: Math.round(Math.min(Math.max(16, x0), viewport.width - w - 16)),
    y: Math.round(Math.min(Math.max(16, y0), viewport.height - h - 16)),
    width: Math.round(w),
    height: Math.round(h),
  };
}
