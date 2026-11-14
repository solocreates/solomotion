"use client";

import * as React from "react";
import { COMPACT_MAX_WIDTH, usePanels, type ShellDensity } from "./panels";
import { useMediaQuery } from "./use-media-query";

/**
 * The ONE place the window's width becomes a fact the app can act on.
 *
 * Density is stored on the panels store rather than read per component,
 * because the visibility formula itself needs it (`resolvePanel`) and that
 * function has to stay callable from outside React — the rails, the shortcuts
 * and the Window menu all reach it through `getState()`. A hook that each
 * consumer called separately would give the store no way to answer, and we
 * would be back to two sources for one fact.
 *
 * Mount `useDensitySync` once, at the shell root. Everything else reads
 * `useIsCompact`.
 */
export function useDensitySync(): ShellDensity {
  const compact = useMediaQuery(`(max-width: ${COMPACT_MAX_WIDTH - 1}px)`);
  const density: ShellDensity = compact ? "compact" : "wide";
  // Layout effect, not effect: the store must agree with the layout BEFORE
  // paint. One frame of disagreement is one frame of the desktop columns on a
  // phone, and on a slow device that frame is visible.
  useIsomorphicLayoutEffect(() => {
    usePanels.getState().setDensity(density);
  }, [density]);
  // Return the media query's answer, not the store's: on the first render the
  // store still says "wide" (it has to — see its initialiser), and a layout
  // that waited a frame for the effect would mount the desktop columns on a
  // phone and then tear them down.
  return density;
}

/** `useLayoutEffect` in the browser, `useEffect` on the server (which has no
 *  layout to be early for, and warns if you ask). */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

/** Is the workspace in its narrow presentation? */
export function useIsCompact(): boolean {
  return usePanels((s) => s.density === "compact");
}
