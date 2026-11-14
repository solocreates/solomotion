"use client";

import * as React from "react";
import { useDoc } from "../state/document-context";
import { compPosterAt, releasePosterDemand } from "./poster-cache";
import { usePosterPaint } from "./use-poster";

/**
 * A comp's picture, for surfaces that show comps rather than clips: flipbook
 * cells, their ghost repeats, drawing previews.
 *
 * A canvas rather than an `<img src={dataURL}>`, which is what this replaced.
 * The store holds `ImageBitmap`s because that is what a timeline strip has to
 * blit dozens of times per paint; encoding each one to a PNG data URL so an
 * `<img>` could decode it again was the old cache's per-thumbnail tax, and it
 * is why cells used to hitch on the first paint after a stroke.
 *
 * Revalidation needs no code here at all: `compPosterAt` keys on the comp's
 * content revision, so a stroke changes the key and the next paint asks for a
 * new picture. `usePosterPaint` is only the repaint signal, and it repaints
 * the canvas without re-rendering the component — a sheet of fifty cells
 * filling in is fifty draws, not fifty React renders per arriving picture.
 */
export function CompThumb({
  frameId,
  className,
  timeMs = 0,
  heightPx = 96,
  focus,
}: {
  frameId: string;
  className?: string;
  /** Which instant of the comp to show. Cells are one frame, so 0 is the cell. */
  timeMs?: number;
  heightPx?: number;
  /**
   * Show only this part of the comp, in NORMALISED comp units (0..1). A
   * flipbook row passes one box for ALL its cells so the strip reads as an
   * animation rather than as a series of independently-cropped pictures — see
   * `drawing/cell-focus.ts` for why that is the whole design.
   *
   * The poster is requested at the zoomed height, so framing a small drawing
   * makes it BIGGER rather than blurrier — the cache key already carries the
   * height, so it costs one extra entry per zoom level, not per cell.
   */
  focus?: { x: number; y: number; w: number; h: number } | null;
}) {
  const doc = useDoc();
  const ref = React.useRef<HTMLCanvasElement | null>(null);
  const zoom = focus && focus.w > 0 ? Math.min(8, 1 / focus.w) : 1;
  // Demand is owned: an unmounted cell (a sheet closed, a row scrolled away)
  // withdraws its ask instead of leaving a render queued for nobody.
  const owner = React.useRef({}).current;
  React.useEffect(() => () => releasePosterDemand(owner), [owner]);

  usePosterPaint(() => {
    releasePosterDemand(owner);
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const picture = compPosterAt(doc, frameId, timeMs, Math.round(heightPx * zoom), owner);
    if (!picture) return;
    const w = focus ? Math.max(1, Math.round(picture.width * focus.w)) : picture.width;
    const h = focus ? Math.max(1, Math.round(picture.height * focus.h)) : picture.height;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Blit the framed region only. Cropping the SOURCE rather than transforming
    // the destination keeps the canvas element exactly the size of what it
    // shows, so `object-contain` around it still means what it says.
    if (focus) {
      ctx.drawImage(picture, Math.round(picture.width * focus.x), Math.round(picture.height * focus.y), w, h, 0, 0, w, h);
    } else {
      ctx.drawImage(picture, 0, 0);
    }
  }, [doc, frameId, timeMs, heightPx, zoom, focus?.x, focus?.y, focus?.w, focus?.h]);

  return <canvas ref={ref} className={className} aria-hidden />;
}
