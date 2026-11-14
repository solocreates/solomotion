"use client";

import * as React from "react";

/**
 * EDGE FADES for a scroller: the edge that has more content beyond it fades
 * out, so a strip that scrolls never looks clipped. Writes
 * `data-fade-start` / `data-fade-end` on the element; the `edge-fade` utility
 * (globals.css) draws the mask on either axis. Re-measures on scroll, resize
 * and content change; does nothing while the content fits.
 */
export function useEdgeFade(ref: React.RefObject<HTMLElement | null>, axis: "x" | "y" = "x"): void {
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const pos = axis === "x" ? el.scrollLeft : el.scrollTop;
      const max = axis === "x" ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
      el.toggleAttribute("data-fade-start", pos > 1);
      el.toggleAttribute("data-fade-end", pos < max - 1);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [ref, axis]);
}
