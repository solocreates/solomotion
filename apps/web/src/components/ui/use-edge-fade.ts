"use client";

import * as React from "react";

/**
 * EDGE FADES for a scroller: the edge that has more content beyond it fades
 * out, so a strip that scrolls never looks clipped. Writes
 * `data-fade-start` / `data-fade-end` on the element; the `edge-fade` utility
 * (globals.css) draws the mask on either axis. Re-measures on scroll, resize,
 * children added or removed, and when a child's animation settles; does
 * nothing while the content fits.
 *
 * The settle step matters: a FLIP slide (`useFlip`) translates the neighbours
 * of a closed tab back from where they were, and a transform counts toward
 * `scrollWidth`. Measured mid-slide the strip "overflows" by the slide's
 * distance, and nothing else fires afterwards, so the end fade stuck on a
 * strip that fits. Measuring again once the running animations finish reads
 * the settled layout.
 */
export function useEdgeFade(ref: React.RefObject<HTMLElement | null>, axis: "x" | "y" = "x"): void {
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const measure = () => {
      const pos = axis === "x" ? el.scrollLeft : el.scrollTop;
      const max = axis === "x" ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
      el.toggleAttribute("data-fade-start", pos > 1);
      el.toggleAttribute("data-fade-end", pos < max - 1);
    };
    const update = () => {
      measure();
      const running = el.getAnimations?.({ subtree: true }) ?? [];
      if (running.length === 0) return;
      void Promise.allSettled(running.map((a) => a.finished)).then(() => {
        if (alive) measure();
      });
    };
    update();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    // A child added later (a new tab) is observed too; one removed stops being.
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of Array.from(r.addedNodes)) if (n instanceof Element) ro.observe(n);
        for (const n of Array.from(r.removedNodes)) if (n instanceof Element) ro.unobserve(n);
      }
      // The layout effect that starts a FLIP slide runs before this callback
      // (both after the commit), so the slide is already in getAnimations().
      update();
    });
    mo.observe(el, { childList: true });
    return () => {
      alive = false;
      el.removeEventListener("scroll", measure);
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref, axis]);
}
