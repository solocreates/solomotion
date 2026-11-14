"use client";

import * as React from "react";
import {
  clipPosterSource,
  clipPosterTiles,
  compFps,
  frameStepMs,
  POSTER_MIN_LANE_PX,
  POSTER_STILL_MS,
  posterTileFloorPx,
  type MotionDocument,
  type Clip,
  type PosterSource,
  type PosterTile,
} from "@solomotion/core";
import { animatedImageStepMs, clipLoopNaturalSpanMs, onMediaReady } from "../stage/render/media-cache";
import { timelineView } from "../timeline/timeline-view";
import { posterSourceCostMs, postersEnabled, subscribePosterCosts, subscribePosters } from "./poster-cache";

/**
 * The React seam over the poster store: when to repaint, and what to paint.
 *
 * Deliberately thin. Nothing here decides what a clip looks like (core's plan
 * does) or holds a picture (the store does) — this only answers "should this
 * surface be painting posters at all" and "has anything changed since the last
 * paint", which is exactly the pair a canvas painter needs and nothing more.
 */

/**
 * A version counter that ticks when MEDIA finishes decoding — and deliberately
 * not when a poster lands.
 *
 * Media readiness is the one input the poster plan cannot derive: an image's
 * bytes arriving changes no document, so no revision moves, but the natural
 * span and frame step the plan wanted are suddenly knowable. It is also rare —
 * once per asset — so a React re-render is the right price.
 *
 * A poster LANDING is the opposite: hundreds arrive while a timeline fills,
 * and routing those through React state would re-render every strip on screen
 * for each one. Those repaint through `usePosterPaint` instead, which touches
 * a canvas and no component — the same split the rest of the editor draws on,
 * where React owns structure and canvases own pixels.
 */
export function useMediaVersion(): number {
  const [version, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => onMediaReady(bump), []);
  return version;
}

/**
 * Repaint a canvas whenever a poster lands, without re-rendering anything.
 *
 * Coalesced to one paint per animation frame per canvas: a burst of arrivals —
 * which is exactly what the first fill of a timeline is — collapses into a
 * single repaint, so a strip fills in smoothly instead of thrashing through
 * partial draws.
 *
 * `paint` is read through a ref so a caller can close over fresh props without
 * re-subscribing every render; `deps` are only the things that change WHAT is
 * painted (the plan, the size), and each change repaints immediately.
 */
export function usePosterPaint(paint: () => void, deps: React.DependencyList): void {
  const latest = React.useRef(paint);
  latest.current = paint;
  React.useEffect(() => {
    let raf = 0;
    const run = () => {
      raf = 0;
      latest.current();
    };
    run();
    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(run);
    };
    const off = subscribePosters(schedule);
    return () => {
      off();
      if (raf !== 0) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * Whether a lane of this height should show posters at all.
 *
 * Two floors, both stated in core: the global switch, and a height under which
 * a picture stops being a picture. A 20px-tall smear costs a decode, a bitmap
 * and a draw to communicate nothing, so a collapsed lane simply reads as
 * coloured bars — which is what a collapsed lane is FOR.
 */
export function postersVisibleAt(heightPx: number): boolean {
  return postersEnabled() && heightPx >= POSTER_MIN_LANE_PX;
}

/**
 * Is this element on screen? Posters are computed and requested per visible
 * clip, so a project with a thousand clips does the work of the thirty you can
 * see. Without this gate the timeline would warm — and evict — pictures for
 * clips nobody has scrolled to, which is the difference between a feature that
 * is free and one that is a tax.
 */
export function useOnScreen<T extends Element>(): [React.RefCallback<T>, boolean] {
  const [visible, setVisible] = React.useState(false);
  const observer = React.useRef<IntersectionObserver | null>(null);

  const ref = React.useCallback((node: T | null) => {
    observer.current?.disconnect();
    if (!node) {
      setVisible(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    // A generous margin so a clip's pictures are already warm by the time it
    // scrolls in — the poster appears with the clip, not a beat after it.
    observer.current = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { rootMargin: "256px" },
    );
    observer.current.observe(node);
  }, []);

  React.useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, visible];
}

/** A clip-local span of the strip, in px from the clip's left edge. */
export interface StripWindow {
  fromPx: number;
  toPx: number;
}

/**
 * Windows snap to PAGES of the timeline, not pixels: scrolling re-plans once
 * per page crossed, and every clip's window moves on the same page grid.
 */
const PAGE_PX = 512;

/**
 * WHICH PART OF THIS CLIP IS ON SCREEN — plus half a viewport either side, so
 * a pan finds its pictures already made.
 *
 * Read from the timeline's one horizontal authority (`timelineView`), so a
 * strip follows the same scroll the ruler and the playhead do. React
 * re-renders only when the window crosses a page edge.
 */
export function useStripWindow(startMs: number, durationMs: number, pxPerSec: number): StripWindow | null {
  const [key, setKey] = React.useState("");
  React.useEffect(() => {
    const measure = (scrollLeft: number) => {
      const vw = timelineView.viewportWidth() || 1600;
      const absFrom = Math.floor((scrollLeft - vw / 2) / PAGE_PX) * PAGE_PX;
      const absTo = Math.ceil((scrollLeft + vw * 1.5) / PAGE_PX) * PAGE_PX;
      const left = (startMs / 1000) * pxPerSec;
      const width = (durationMs / 1000) * pxPerSec;
      const from = Math.max(0, absFrom - left);
      const to = Math.min(width, absTo - left);
      setKey(to > from ? `${from}:${to}` : "none");
    };
    return timelineView.registerFollower(measure);
  }, [startMs, durationMs, pxPerSec]);
  return React.useMemo(() => {
    if (!key || key === "none") return null;
    const [from, to] = key.split(":").map(Number);
    return { fromPx: from!, toPx: to! };
  }, [key]);
}

/**
 * A clip's poster source and tile plan, memoized on the things that actually
 * change it — windowed to the screen and thinned by what one picture of the
 * source MEASURED to cost (`posterTileFloorPx`; a source past
 * `POSTER_STILL_MS` shows one picture per clip). The same rule for every kind
 * of clip: footage, images, comps, flipbooks, pixel layers.
 *
 * The host's two refinements to core's plan both live here, so no surface has
 * to know about them:
 *  - `naturalMs` — the natural source span this app knows and the document
 *    does not (an animated image's decoded length, a video whose asset
 *    duration is still loading);
 *  - `sourceStepMs` — an animated image's mean frame step, which likewise
 *    only exists once its bytes are decoded.
 * Both arrive asynchronously, which is why `mediaVersion` is a dependency: the
 * plan sharpens itself the moment the decode lands, without anyone polling.
 */
export function useClipPoster(
  doc: MotionDocument,
  clip: Clip,
  pxPerSec: number,
  heightPx: number,
  mediaVersion: number,
  window: StripWindow | null,
): { source: PosterSource; tiles: PosterTile[] } | null {
  const source = React.useMemo(
    () => (postersVisibleAt(heightPx) ? clipPosterSource(doc, clip) : null),
    [doc, clip, heightPx],
  );
  const sourceKey = source?.key ?? "";
  const costMs = React.useSyncExternalStore(
    subscribePosterCosts,
    () => (sourceKey ? posterSourceCostMs(sourceKey) : null),
    () => null,
  );
  return React.useMemo(() => {
    if (!source || !window) return null;
    const pxPerMs = pxPerSec / 1000;
    const still = costMs != null && costMs > POSTER_STILL_MS;
    const animatedStep = clip.kind === "image" ? animatedImageStepMs(clip.assetId) : null;
    const tiles = clipPosterTiles(doc, clip, source, {
      pxPerMs,
      renderStepMs: frameStepMs(compFps(doc, clip.frameId)),
      sourceStepMs: still ? Infinity : (animatedStep ?? undefined),
      naturalMs: clipLoopNaturalSpanMs(doc, clip),
      minTilePx: posterTileFloorPx(costMs),
      window: { fromMs: window.fromPx / pxPerMs, toMs: window.toPx / pxPerMs },
    });
    return tiles.length > 0 ? { source, tiles } : null;
    // `mediaVersion` is load-bearing: see the note above.
  }, [doc, clip, source, pxPerSec, mediaVersion, window, costMs]);
}
