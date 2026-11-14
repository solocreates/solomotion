"use client";

import * as React from "react";
import type { BrushPreset, PressureSettings } from "@solomotion/core";
import { brushCardPreview } from "./brush-preview";
import { useTheme } from "../theme/use-theme";

/**
 * BRUSH THUMBNAILS, off the render path.
 *
 * A brush preview is an honest one — it runs the real stroke engine and the
 * real painter over a demo sweep, then encodes a PNG. That is the right call
 * for fidelity and the wrong thing to do ninety times inside a render pass:
 * opening the library used to mean ninety engine runs and ninety
 * `toDataURL` encodes before a single frame painted, which is a locked tab and
 * a spinner nobody asked for.
 *
 * So thumbnails are ASYNCHRONOUS and DEMAND-DRIVEN:
 *
 *  - A card asks for its thumbnail and gets `null` on the first render. It
 *    shows a skeleton and paints immediately.
 *  - The request joins a queue drained during idle time, a few per slice, so
 *    the browser scrolls at sixty while thumbnails fill in behind it.
 *  - Only MOUNTED cards ask, and the list is virtualised — so the cost is the
 *    dozen brushes on screen, not the library.
 *  - Results are cached by everything that changes the pixels, and the cache
 *    is shared by every surface (library, options bar, studio header), so
 *    scrolling back is free and the trigger chip never re-renders a stroke the
 *    library already drew.
 *
 * The cache is module-level and survives the library closing, which is the
 * point: the second open is instant.
 */

const cache = new Map<string, string>();
const pending = new Set<string>();
const queue: Array<{ key: string; run: () => string }> = [];
const listeners = new Set<() => void>();

/** How many thumbnails one idle slice is allowed to encode. */
const PER_SLICE = 3;
/** Bound: ~a few MB of data URLs. Cleared wholesale — a rebuild is cheap. */
const CACHE_MAX = 400;

let draining = false;

const idle: (cb: () => void) => void =
  typeof window !== "undefined" && "requestIdleCallback" in window
    ? (cb) => (window as unknown as { requestIdleCallback: (c: () => void) => void }).requestIdleCallback(cb)
    : (cb) => window.setTimeout(cb, 16);

function drain(): void {
  draining = false;
  let made = 0;
  while (queue.length > 0 && made < PER_SLICE) {
    const job = queue.shift()!;
    pending.delete(job.key);
    if (cache.has(job.key)) continue;
    try {
      if (cache.size > CACHE_MAX) cache.clear();
      cache.set(job.key, job.run());
      made++;
    } catch {
      // A canvas that failed to allocate is not worth breaking the list over;
      // the card simply keeps its skeleton.
    }
  }
  if (made > 0) for (const l of [...listeners]) l();
  if (queue.length > 0) schedule();
}

function schedule(): void {
  if (draining) return;
  draining = true;
  idle(drain);
}

/**
 * The identity of a rendered thumbnail. The whole preset, because ANY field
 * can change the pixels — and a brush is a few hundred bytes, so stringifying
 * it is cheaper than the render it prevents.
 */
function thumbKey(
  brush: BrushPreset,
  ink: string,
  w: number,
  h: number,
  size: number,
  opacity: number,
  pressure: PressureSettings,
): string {
  return `${JSON.stringify(brush)}|${ink}|${w}x${h}|${size}|${opacity}|${pressure.enabled}|${pressure.size.gamma}`;
}

export interface ThumbRequest {
  brush: BrushPreset;
  width: number;
  height: number;
  size?: number;
  opacity?: number;
  pressure: PressureSettings;
}

/**
 * The INK every preview is drawn in — the theme's own foreground, never the
 * colour you are painting with.
 *
 * Two reasons, and the second is the important one.
 *
 * It was in the cache key, so picking a new colour invalidated ninety-two
 * thumbnails and re-ran ninety-two stroke simulations. Nobody asked for that,
 * and on a wet brush it is a physics run per card.
 *
 * And a card should show the BRUSH. Tint them all pale yellow and every brush
 * looks like every other brush — the thing you are choosing between is the
 * mark's texture, weight and taper, which only reads against a neutral ink.
 * Procreate and Fresco both do this, for the same reason. The colour you are
 * about to paint with is already on screen, in the colour well beside it.
 *
 * It is not a parameter, so no call site can pass the paint colour by mistake.
 * The theme's foreground changes only when the theme does — which SHOULD
 * rebuild the previews, since the tile under them changed too.
 */
function previewInk(): string {
  return useTheme.getState().colors.foreground || "#F4F2ED";
}

/**
 * A brush thumbnail, or `null` while it is still being drawn.
 *
 * Re-renders exactly the components whose thumbnail just landed, via one
 * shared subscription rather than a timer per card.
 */
export function useBrushThumb(req: ThumbRequest | null): string | null {
  // The theme's ink is a live value: a theme switch must rebuild the cards,
  // and nothing else may.
  const ink = useTheme((s) => s.colors.foreground) || "#F4F2ED";
  const key = req
    ? thumbKey(
        req.brush,
        ink,
        req.width,
        req.height,
        req.size ?? req.brush.size,
        req.opacity ?? req.brush.opacity,
        req.pressure,
      )
    : null;

  const subscribe = React.useCallback((onChange: () => void) => {
    listeners.add(onChange);
    return () => listeners.delete(onChange);
  }, []);
  const value = React.useSyncExternalStore(
    subscribe,
    () => (key ? cache.get(key) ?? null : null),
    () => null,
  );

  React.useEffect(() => {
    if (!req || !key || cache.has(key) || pending.has(key)) return;
    pending.add(key);
    queue.push({
      key,
      run: () =>
        brushCardPreview(
          req.brush,
          req.pressure,
          previewInk(),
          req.width,
          req.height,
          req.size ?? req.brush.size,
          req.opacity ?? req.brush.opacity,
        ),
    });
    schedule();
  }, [key, req]);

  return value;
}

/**
 * Forget every thumbnail. Called when a brush is edited — the studio writes on
 * every slider frame, and a stale card is worse than a missing one.
 */
export function invalidateBrushThumbs(): void {
  cache.clear();
  queue.length = 0;
  pending.clear();
  for (const l of [...listeners]) l();
}
