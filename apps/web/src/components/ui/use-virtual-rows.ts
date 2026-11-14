"use client";

import * as React from "react";

/**
 * Render only the rows you can see.
 *
 * THE fix for a long list, and the one that actually changes the complexity: a
 * row in this app is not a line of text, it is a swatch canvas, an editor and
 * two or three Radix roots, so a hundred rows built two hundred popover roots
 * for interactions that had not happened yet. Deferring that work makes the
 * window open sooner; only NOT DOING it makes the window fast, and keeps it
 * fast at a thousand rows.
 *
 * Fixed row height on purpose. Measured virtualisation needs a resize observer
 * per row and a running offset table, and every list this is for is a table —
 * uniform by design, because that is what makes columns scannable. A variable
 * height list would be the wrong customer for this hook rather than a reason to
 * make it twice as complicated.
 *
 * Selection is unaffected: range selection slices the DATA, and a marquee can
 * only sweep what is on screen, which is exactly what is mounted.
 */
export interface VirtualRows {
  /** First index to render (inclusive). */
  start: number;
  /** Last index to render (exclusive). */
  end: number;
  /** Spacer heights standing in for the rows above and below. */
  padTop: number;
  padBottom: number;
}

export function useVirtualRows({
  count,
  rowHeight,
  viewportRef,
  /**
   * Rows kept mounted beyond each edge. Enough that a normal scroll flick never
   * shows a gap, few enough that the saving is real.
   */
  overscan = 8,
  /**
   * Below this many rows, render everything. Virtualising a short list costs a
   * scroll listener and a re-render to save nothing, and it would make the
   * common case behave differently from the way it looks.
   */
  threshold = 40,
}: {
  count: number;
  rowHeight: number;
  viewportRef: React.RefObject<HTMLElement | null>;
  overscan?: number;
  threshold?: number;
}): VirtualRows {
  const virtual = count > threshold;
  // The FIRST paint is a window too. Seeding the range with the whole list
  // meant every virtual list mounted all of its rows once — before the effect
  // below had measured anything — which for the font browser was two thousand
  // specimen cards on open. A screenful is a guess; the layout effect corrects
  // it before the browser paints.
  const [range, setRange] = React.useState<{ start: number; end: number }>(() => ({
    start: 0,
    end: virtual ? Math.min(count, threshold) : count,
  }));

  React.useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!virtual || !el) {
      setRange({ start: 0, end: count });
      return;
    }
    const measure = () => {
      const first = Math.floor(el.scrollTop / rowHeight);
      const visible = Math.ceil(el.clientHeight / rowHeight);
      setRange({
        start: Math.max(0, first - overscan),
        end: Math.min(count, first + visible + overscan),
      });
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    // The viewport resizes with the window it lives in, and a taller window
    // that never scrolled would otherwise keep the range it was born with.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [virtual, count, rowHeight, overscan, viewportRef]);

  if (!virtual) return { start: 0, end: count, padTop: 0, padBottom: 0 };
  const start = Math.min(range.start, Math.max(0, count - 1));
  const end = Math.min(range.end, count);
  return { start, end, padTop: start * rowHeight, padBottom: Math.max(0, (count - end) * rowHeight) };
}
