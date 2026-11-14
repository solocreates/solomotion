"use client";

import * as React from "react";

/**
 * "Show the frame now, fill it next frame."
 *
 * A panel that mounts everything it will ever need in the commit that opens it
 * pays for all of it before the user sees anything, so the app appears to
 * freeze and THEN the window arrives — the worst possible order. Splitting the
 * open into two frames reverses it: the chrome paints immediately, and the body
 * mounts against a window that is already on screen.
 *
 * This does not make the body cheaper — nothing about deferring is an
 * optimisation, and a panel whose content is genuinely expensive still costs
 * what it costs (see `useVirtualRows` for the half that does make it cheaper).
 * What it buys is that the cost is paid somewhere the user can see progress
 * instead of somewhere they can only see a stall.
 *
 * Two rAFs, not one: a single frame fires BEFORE the browser has painted the
 * commit that scheduled it, so the heavy mount would land in the same frame as
 * the chrome and nothing would have been gained. The second one runs after the
 * paint has actually happened.
 */
export function useAfterPaint(enabled = true): boolean {
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    if (!enabled) {
      setReady(false);
      return;
    }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setReady(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [enabled]);

  return ready;
}
