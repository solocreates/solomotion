import { flushSync } from "react-dom";
import { useSession } from "../state/session";
import { watchScroller, type ViewAxis } from "../workspace/view-axis";
import { laneZoomNow, pxPerSecNow } from "./use-time-axes";
import { dynamicMinPxPerSec, MAX_PX_PER_SEC, timelineView } from "./timeline-view";
import { LANE_ZOOM_MAX, LANE_ZOOM_MIN } from "./time-axes";

/**
 * The view axes of the time surfaces, for `ZoomBar`. Each is a thin reading of
 * state that already has one owner — `timelineView` for the shared time
 * position, `pxPerSec` / `laneZoom` in the session — so the bars add controls,
 * never a second copy of where you are.
 */

/** "2.4 s", "12 s", "1:05" — a visible time span. */
export function formatSpan(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

/** Re-run on every zoom change of either axis. */
function onZoom(fn: () => void): () => void {
  let px = pxPerSecNow();
  let lane = laneZoomNow();
  return useSession.subscribe(() => {
    const p = pxPerSecNow();
    const l = laneZoomNow();
    if (p !== px || l !== lane) {
      px = p;
      lane = l;
      fn();
    }
  });
}

/**
 * THE shared time axis — the lanes, Keyframes and Curves all read one
 * horizontal position (`timelineView`), so their bars are one axis too. The
 * bar stands for the comp's span; the window is the lanes' viewport.
 */
export function timeAxis(getSpanMs: () => number): ViewAxis {
  const range = () => ({ startMs: 0, endMs: getSpanMs() });
  return {
    zoomable: true,
    read() {
      const vw = timelineView.viewportWidth();
      const px = pxPerSecNow();
      if (vw <= 0 || px <= 0) return null;
      const span = getSpanMs();
      return {
        start: (timelineView.scrollLeft() / px) * 1000,
        size: (vw / px) * 1000,
        extent: span,
        minSize: (vw / MAX_PX_PER_SEC) * 1000,
        maxSize: (vw / dynamicMinPxPerSec(vw, span)) * 1000,
      };
    },
    show(start, size, hold) {
      timelineView.showWindow(start, size, range(), hold);
    },
    scrollTo(start) {
      timelineView.panBy((start / 1000) * pxPerSecNow() - timelineView.scrollLeft());
    },
    subscribe(fn) {
      const a = timelineView.registerFollower(fn);
      const b = onZoom(fn);
      return () => {
        a();
        b();
      };
    },
    format: (w) => formatSpan(w.size),
  };
}

/**
 * A time axis on its OWN native scroller — the flipbook sheet, whose cells are
 * not the lanes. `insetPx` is the sticky row-header column at the left of the
 * scroll content: time zero starts after it.
 */
export function scrollerTimeAxis(
  getEl: () => HTMLElement | null,
  insetPx: number,
  getSpanMs: () => number,
  getBounds: () => { min: number; max: number },
): ViewAxis {
  const vwOf = (el: HTMLElement) => el.clientWidth - insetPx;
  return {
    zoomable: true,
    read() {
      const el = getEl();
      const px = pxPerSecNow();
      if (!el || vwOf(el) <= 0 || px <= 0) return null;
      const vw = vwOf(el);
      const b = getBounds();
      return {
        start: (el.scrollLeft / px) * 1000,
        size: (vw / px) * 1000,
        extent: getSpanMs(),
        minSize: (vw / b.max) * 1000,
        maxSize: (vw / b.min) * 1000,
      };
    },
    show(start, size, hold) {
      const el = getEl();
      if (!el || size <= 0) return;
      const b = getBounds();
      const px = Math.min(b.max, Math.max(b.min, (vwOf(el) / size) * 1000));
      // Commit the new cell width BEFORE scrolling, so the scroll lands in the
      // re-laid-out content rather than one frame behind it.
      flushSync(() => useSession.getState().setPxPerSec(px));
      const startMs = hold === "end" ? start + size - (vwOf(el) / px) * 1000 : start;
      el.scrollLeft = (Math.max(0, startMs) / 1000) * px;
    },
    scrollTo(start) {
      const el = getEl();
      if (el) el.scrollLeft = (start / 1000) * pxPerSecNow();
    },
    subscribe(fn) {
      const a = watchScroller(getEl, fn);
      const b = onZoom(fn);
      return () => {
        a();
        b();
      };
    },
    format: (w) => formatSpan(w.size),
  };
}

/**
 * The ROW axis of a scroller whose rows scale with `laneZoom` (the lanes, the
 * flipbook sheet). Units are UNZOOMED pixels, so the extent holds still while
 * the rows grow — that is what lets a handle follow the cursor. `fixedPx` is
 * the sticky band at the top (the ruler) that never scales.
 */
export function rowsAxis(getEl: () => HTMLElement | null, fixedPx = 0): ViewAxis {
  const viewOf = (el: HTMLElement) => el.clientHeight - fixedPx;
  return {
    zoomable: true,
    read() {
      const el = getEl();
      const z = laneZoomNow();
      if (!el || viewOf(el) <= 0 || z <= 0) return null;
      const view = viewOf(el);
      return {
        start: el.scrollTop / z,
        size: view / z,
        extent: (el.scrollHeight - fixedPx) / z,
        minSize: view / LANE_ZOOM_MAX,
        maxSize: view / LANE_ZOOM_MIN,
      };
    },
    show(start, size, hold) {
      const el = getEl();
      if (!el || size <= 0) return;
      const z = Math.min(LANE_ZOOM_MAX, Math.max(LANE_ZOOM_MIN, viewOf(el) / size));
      flushSync(() => useSession.getState().setLaneZoom(z));
      const top = hold === "end" ? start + size - viewOf(el) / z : start;
      el.scrollTop = Math.max(0, top) * z;
    },
    scrollTo(start) {
      const el = getEl();
      if (el) el.scrollTop = start * laneZoomNow();
    },
    subscribe(fn) {
      const a = watchScroller(getEl, fn);
      const b = onZoom(fn);
      return () => {
        a();
        b();
      };
    },
    format: () => `${Math.round(laneZoomNow() * 100)}%`,
  };
}
