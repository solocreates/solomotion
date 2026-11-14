"use client";

/**
 * THE ZOOM SHORTCUTS, bound ONCE (README D5): ⌘= / ⌘− step, ⌘0 fit,
 * ⇧0 100% — the same four keys in every view, and one listener in the app.
 *
 * Who gets a key, in order:
 *   1. a target whose `isActive()` is true right now (the pointer is over it
 *      or focus is inside it) — newest first, so a view inside a view wins;
 *   2. the target registered for the FOCUSED region (`session.focusedPanel`);
 *   3. the stage (`requestStageZoom`) — the canvas is the default subject.
 *
 * Before this, each view bound its own window keydown, the page-zoom guard
 * bound another and handed leftovers to the stage, and which view zoomed
 * depended on listener order. Now it depends on where you are.
 *
 * ⌘0 is FIT everywhere a view can fit (D5); a view that cannot (a reflowing
 * grid) treats it as its default size.
 */

import { requestStageZoom } from "../input/page-zoom-guard";
import { useSession, type WorkspacePanel } from "../state/session";
import { zoomCommandFor, type ZoomCommand } from "./view-zoom";

export interface ZoomTarget {
  /** Precise ownership: pointer over / focus within. */
  isActive?: () => boolean;
  /** The focus key this target answers for when no precise owner exists. */
  focus?: WorkspacePanel;
  /** Return false to decline (e.g. "actual" on a time view). */
  run: (cmd: ZoomCommand) => boolean | void;
}

const targets: ZoomTarget[] = [];
let installed = false;

function dispatch(cmd: ZoomCommand): boolean {
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i]!;
    if (t.isActive?.() && t.run(cmd) !== false) return true;
  }
  const focused = useSession.getState().focusedPanel;
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i]!;
    if (t.focus === focused && t.run(cmd) !== false) return true;
  }
  requestStageZoom(cmd);
  return true;
}

function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented) return;
  const cmd = zoomCommandFor(e);
  if (!cmd) return;
  const el = e.target as Element | null;
  // ⇧0 in a text field is a ")" being typed; ⌘± there is still ours.
  if (cmd === "actual" && el?.closest?.("input, textarea, select, [contenteditable='true'], [contenteditable='']")) return;
  if (dispatch(cmd)) e.preventDefault();
}

/** Install the one listener (idempotent). The shell calls this on mount. */
export function installZoomShortcuts(): void {
  if (installed || typeof window === "undefined") return;
  window.addEventListener("keydown", onKey);
  installed = true;
}

export function registerZoomTarget(target: ZoomTarget): () => void {
  installZoomShortcuts();
  targets.push(target);
  return () => {
    const i = targets.indexOf(target);
    if (i >= 0) targets.splice(i, 1);
  };
}

/** Pointer-over / focus-within, for `isActive`. */
export function ownsInput(el: Element | null): boolean {
  if (!el) return false;
  return el.matches(":hover") || el.contains(document.activeElement);
}
