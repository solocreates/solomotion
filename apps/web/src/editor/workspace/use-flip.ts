"use client";

import * as React from "react";

/**
 * FLIP for an ordered list: children tagged `data-flip=<stable key>` glide
 * from where they were to where the last render put them. Used by the rails
 * and tab strips so siblings PART around a live badge and slide when a drop
 * reorders them — the motion is what tells you the list is being sorted.
 *
 * Positions are kept relative to the container and its scroll offset, so
 * scrolling the list or moving the window never reads as a reorder. Runs after
 * every render of the owner (cheap: a rect per item), and honours reduced
 * motion. Web Animations, so no inline styles are left behind to fight React.
 */
export function useFlip<T extends HTMLElement>(ref: React.RefObject<T | null>): void {
  const last = React.useRef(new Map<string, { x: number; y: number }>());
  React.useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const origin = box.getBoundingClientRect();
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, { x: number; y: number }>();
    for (const el of Array.from(box.querySelectorAll<HTMLElement>("[data-flip]"))) {
      const key = el.dataset.flip!;
      const r = el.getBoundingClientRect();
      const at = { x: r.left - origin.left + box.scrollLeft, y: r.top - origin.top + box.scrollTop };
      next.set(key, at);
      const was = last.current.get(key);
      if (!was || reduce) continue;
      const dx = was.x - at.x;
      const dy = was.y - at.y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
        duration: 160,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      });
    }
    last.current = next;
  });
}
