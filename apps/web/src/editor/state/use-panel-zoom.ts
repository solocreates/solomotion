"use client";

import * as React from "react";
import { useWorkspace } from "./workspace";
import { useZoomGesture } from "./use-zoom-gesture";
import { useMultiTouch } from "../input/use-multi-touch";
import { REFLOW_ZOOM } from "../workspace/view-zoom";
import { registerZoomTarget } from "../workspace/zoom-shortcuts";

/**
 * A headless, reusable ZOOM LEVEL any panel can opt into — the generic
 * counterpart to the Stage/Timeline's bespoke camera/time zoom. A level scales
 * the panel's CONTENT with the CSS `zoom` property, exactly how the app's
 * Blender-style "Interface scale" scales the whole UI (theme-tokens.ts), so it's
 * layout-aware (scrollbars, hit-testing all correct) and consistent.
 *
 * It plugs into the already-unified input: `useZoomGesture` for trackpad-pinch /
 * ⌘-scroll, plus unified ⌘+ / ⌘- / ⌘0 keys (gated to the active panel). The
 * level persists per panel in the workspace prefs. Panels with special zoom
 * semantics (Stage camera, Timeline pxPerSec) keep those; this is for the many
 * ordinary panels (media grid/list, and more later) that just want to scale.
 *
 * Return `style` onto the content wrapper; attach the gesture to `scrollRef`
 * (the scroll viewport), which is also where the cursor-anchored scroll fix
 * lands so the point under the pointer stays put across a zoom.
 */
export interface PanelZoomOptions {
  /** The scroll viewport: the gesture attaches here and anchoring adjusts it. */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** Level bounds (defaults below) and multiplicative step (default 1.1). */
  min?: number;
  max?: number;
  step?: number;
  /** Gate the ⌘±/⌘0 keys to when this panel is focused/active. */
  isActive?: () => boolean;
}

export interface PanelZoom {
  level: number;
  /** Spread onto the content wrapper — CSS `zoom` (identity when 1×). */
  style: React.CSSProperties;
  zoomIn: () => void;
  zoomOut: () => void;
  /** Set an absolute level (clamped). What a continuous dial writes through. */
  setLevel: (level: number) => void;
  reset: () => void;
  canZoomIn: boolean;
  canZoomOut: boolean;
  /** The bounds in force, so a control renders the same range the keys obey. */
  min: number;
  max: number;
}

const clampLevel = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * THE BOUNDS, and why they are this tight.
 *
 * 3× was the reflex "big enough for anybody" ceiling and it is wrong for this
 * control. These panels lay out a GRID that reflows: zooming does not magnify
 * a fixed picture, it makes each tile bigger and fits fewer per row. Past ~1.4×
 * a library column holds one and a half tiles, the filter bar wraps, and the
 * panel stops being a browser and becomes a slideshow of one item — which is
 * exactly what "the zoom can get too much" describes. 1.4 is the last level
 * where a narrow docked panel still shows a row.
 *
 * The floor moves for the same reason from the other end: below 0.6 the tile
 * labels are sub-9px and the thumbnails are indistinguishable, so the extra
 * travel buys nothing but a slider you can overshoot.
 *
 * One pair of numbers for desktop and compact both. A per-width ceiling would
 * mean the same document looked different on a laptop and a phone for a
 * reason the user could not see, and the readout would disagree with itself
 * across a window resize.
 */
/** The reflow kind's bounds (README D5) — one spec, read here, not restated. */
export const PANEL_ZOOM_MIN = REFLOW_ZOOM.min;
export const PANEL_ZOOM_MAX = REFLOW_ZOOM.max;

export function usePanelZoom(panelId: string, opts: PanelZoomOptions): PanelZoom {
  const { scrollRef, min = PANEL_ZOOM_MIN, max = PANEL_ZOOM_MAX, step = REFLOW_ZOOM.step, isActive } = opts;
  // CLAMPED ON READ, not merely on write. The level is persisted, so lowering
  // the ceiling would otherwise leave anyone who had already zoomed to 2.4×
  // stuck above the new maximum — the dial pinned at its end, `canZoomIn`
  // false, and no input able to bring it back down to a legal value. Bounds
  // belong to the reader; the store holds a number, not a promise about it.
  const stored = useWorkspace((s) => s.panelZoom[panelId] ?? 1);
  const level = clampLevel(stored, min, max);

  // Latest-value refs so the gesture / key callbacks never read a stale level.
  const levelRef = React.useRef(level);
  levelRef.current = level;
  const pendingAnchor = React.useRef<{ cx: number; cy: number; ratio: number } | null>(null);

  const applyZoom = React.useCallback(
    (factor: number, center: { x: number; y: number } | null) => {
      const prev = levelRef.current;
      const next = clampLevel(prev * factor, min, max);
      if (next === prev) return;
      if (center) pendingAnchor.current = { cx: center.x, cy: center.y, ratio: next / prev };
      useWorkspace.getState().setPanelZoom(panelId, Number(next.toFixed(3)));
    },
    [panelId, min, max],
  );

  // After `zoom` relays out (before paint), nudge the scroll so the point under
  // the cursor stays fixed — the anchored-zoom feel, on a plain scroll viewport.
  React.useLayoutEffect(() => {
    const a = pendingAnchor.current;
    pendingAnchor.current = null;
    const el = scrollRef.current;
    if (a && el) {
      el.scrollLeft = (el.scrollLeft + a.cx) * a.ratio - a.cx;
      el.scrollTop = (el.scrollTop + a.cy) * a.ratio - a.cy;
    }
  }, [level, scrollRef]);

  // Unified gesture: trackpad-pinch / ⌘-scroll → zoom, anchored at the pointer.
  useZoomGesture(scrollRef, { onZoom: (factor, center) => applyZoom(factor, center) });

  /*
   * THE SAME TWO FINGERS, on every panel that has a zoom.
   *
   * The library and the media grid had a zoom dial, ⌘-scroll and ⌘± — and no
   * pinch at all, because `useZoomGesture` only ever listened to the wheel. On
   * a tablet that left the one gesture everybody tries first doing nothing,
   * in the two panels most obviously made of thumbnails.
   *
   * It belongs HERE rather than in each panel: `usePanelZoom` is already the
   * one place that owns "this panel has a zoom level", so every current and
   * future panel that opts into it gets pinch in the same line that gives it
   * the dial and the keys. Panels with bespoke zoom models (the stage camera,
   * the timeline's pxPerSec) keep their own, and reach the same `useMultiTouch`
   * directly.
   *
   * Pan is deliberately not wired: these are native scrollers, so one finger
   * already scrolls them and a two-finger pan would move the viewport twice.
   */
  useMultiTouch(scrollRef, {
    onGesture: ({ scale, x, y }) => {
      if (scale !== 1) applyZoom(scale, { x, y });
    },
  });

  // Keyboard: the ONE zoom shortcut set (⌘= ⌘− ⌘0 ⇧0), through the shared
  // router — which hands a command to the panel that is active, and only to
  // it. Every panel used to bind its own window listener for the same keys.
  React.useEffect(
    () =>
      registerZoomTarget({
        isActive: () => (isActive ? isActive() : false),
        run: (cmd) => {
          if (cmd === "in") applyZoom(step, null);
          else if (cmd === "out") applyZoom(1 / step, null);
          else useWorkspace.getState().setPanelZoom(panelId, REFLOW_ZOOM.default);
        },
      }),
    [applyZoom, isActive, panelId, step],
  );

  return {
    level,
    style: level === 1 ? {} : ({ zoom: level } as React.CSSProperties),
    zoomIn: () => applyZoom(step, null),
    zoomOut: () => applyZoom(1 / step, null),
    setLevel: (next) => useWorkspace.getState().setPanelZoom(panelId, clampLevel(next, min, max)),
    reset: () => useWorkspace.getState().setPanelZoom(panelId, 1),
    canZoomIn: level < max - 1e-3,
    canZoomOut: level > min + 1e-3,
    min,
    max,
  };
}
