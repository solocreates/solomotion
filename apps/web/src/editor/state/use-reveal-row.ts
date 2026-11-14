"use client";

import * as React from "react";

/**
 * BRING THE ACTIVE ROW INTO VIEW — the small courtesy every long list in this
 * app owes and none of them paid.
 *
 * Two moments, and they are the same moment from the list's point of view:
 * something else changed what is active (a click on the canvas, a drill into a
 * flipbook cell, an undo) while the list was open; or the list was CLOSED when
 * that happened and has just been opened onto a scroll position describing an
 * older selection. Both are "the row I am about to look for is somewhere off
 * screen", and a panel that makes you hunt for it is a panel you stop trusting.
 *
 * It is deliberately the cheapest thing that can work:
 *
 *  - it runs only when the active KEY changes (or the caller asks again with a
 *    new `seq`, and on mount), never per render
 *    and never per frame — a playhead moving does not scroll a list;
 *  - it does nothing when the row is already fully visible, so a selection you
 *    can see never moves under you;
 *  - it writes `scrollTop` on the viewport itself rather than calling
 *    `scrollIntoView`, which is free to scroll every ancestor including the
 *    page — the classic way a panel "helpfully" scrolls the whole editor.
 *
 * Rows opt in with one attribute: `data-row-key`.
 */
export function useRevealRow(
  viewportRef: React.RefObject<HTMLElement | null>,
  activeKey: string | null,
  opts: { padding?: number; seq?: number } = {},
): void {
  const padding = opts.padding ?? 12;
  // A caller's request counter: a new value asks again for the same key.
  const seq = opts.seq ?? 0;
  React.useEffect(() => {
    if (!activeKey) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    // One frame's grace: the row may be mounting in the same commit that made
    // it active (opening a panel, expanding the group it lives in).
    const id = requestAnimationFrame(() => {
      const el = viewport.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(activeKey)}"]`);
      if (!el) return;
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      const viewTop = viewport.scrollTop;
      const viewBottom = viewTop + viewport.clientHeight;
      if (top >= viewTop + padding && bottom <= viewBottom - padding) return; // already showing
      // Nearest edge, not centred: a row one line below the fold should move one
      // line, not jump to the middle and take everything else with it.
      viewport.scrollTop =
        top < viewTop + padding
          ? Math.max(0, top - padding)
          : bottom - viewport.clientHeight + padding;
    });
    return () => cancelAnimationFrame(id);
  }, [activeKey, viewportRef, padding, seq]);
}
