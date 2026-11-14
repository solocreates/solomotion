"use client";

import { useSession } from "../state/session";
import { LANE_ZOOM_MAX, LANE_ZOOM_MIN, type TimeAxes } from "./time-axes";

/**
 * READING the showing surface's axes. Split from `time-axes.ts` so the pure
 * half (which surface, what defaults) stays importable by the navigation slice
 * without a cycle through the store that navigation itself populates.
 *
 * There is deliberately no stored "current pxPerSec": the live value is
 * DERIVED from the per-surface memory plus which surface is showing, so a zoom
 * level and the surface it belongs to cannot fall out of step. Bounds are
 * applied on READ, never on write — a persisted number must survive a ceiling
 * moving under it.
 */

/** The live axes of whichever surface is showing — the non-React reader.
 *
 * No falsy-id guard, on purpose: `timeSurfaceOf` names the comp the timeline
 * actually shows, so a showing surface always has a key, and the store refuses
 * to remember an axis when it does not (`rememberAxis`). The guard that used to
 * be here was what hid the mismatch — it answered with the defaults for a key
 * the writer was busily filling in. */
export function timeAxesNow(): TimeAxes {
  const s = useSession.getState();
  return { ...s.timeSurfaceDefaults, ...s.zoomBySurface[s.timeSurfaceId] };
}

export function pxPerSecNow(): number {
  return timeAxesNow().pxPerSec;
}

export function laneZoomNow(): number {
  return Math.min(LANE_ZOOM_MAX, Math.max(LANE_ZOOM_MIN, timeAxesNow().laneZoom));
}

/** Subscribe to the showing surface's horizontal axis. */
export function usePxPerSec(): number {
  return useSession((s) => s.zoomBySurface[s.timeSurfaceId]?.pxPerSec ?? s.timeSurfaceDefaults.pxPerSec);
}

/** Subscribe to the showing surface's vertical axis, clamped on READ. */
export function useLaneZoom(): number {
  const raw = useSession((s) => s.zoomBySurface[s.timeSurfaceId]?.laneZoom ?? s.timeSurfaceDefaults.laneZoom);
  return Math.min(LANE_ZOOM_MAX, Math.max(LANE_ZOOM_MIN, raw));
}


/**
 * Zoom a PLAIN scroller (one with no `timelineView`-style controller behind it)
 * around a screen anchor, keeping the instant under that anchor still.
 *
 * The scroll has to be applied AFTER the new content width is laid out, which
 * is why it waits a frame — the timeline solves the same ordering problem with
 * a layout effect because it already has one; a surface whose width is plain
 * CSS (`w-max` over a px-per-frame grid) does not, and a frame is cheaper than
 * inventing one.
 */
export function zoomScrollerAt(
  el: HTMLElement | null,
  from: number,
  to: number,
  anchorX: number,
  offsetPx = 0,
): void {
  if (!el || from <= 0 || to <= 0) return;
  const before = el.scrollLeft;
  const atMs = (before + anchorX - offsetPx) / from;
  requestAnimationFrame(() => {
    el.scrollLeft = Math.max(0, atMs * to - anchorX + offsetPx);
  });
}
