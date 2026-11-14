"use client";

import * as React from "react";
import { mapLinear, type MotionDocument, type Clip, type Frame, type FlipbookRow } from "@solomotion/core";
import { onSurfaceReady, surfaceInk } from "./raster-store";

/**
 * WHAT A CELL THUMBNAIL SHOULD ACTUALLY SHOW.
 *
 * A cell used to render the whole comp, scaled to fit. That is the obvious
 * answer and it is wrong in both directions at once: a drawing that occupies
 * one corner of a 1080×1920 canvas becomes a picture of mostly nothing, and a
 * pixel layer that has GROWN past the frame has the interesting part cropped
 * off — which the sheet is the one surface that most needs to see.
 *
 * The obvious fix — frame each cell on its own content — is worse than the
 * problem. A row of cells is an ANIMATION: you read it by seeing the same
 * subject move. Zoom each thumbnail independently and every frame is a
 * different scale and a different crop, so the one thing the strip exists to
 * show is exactly what it destroys.
 *
 * So the framing is decided PER ROW, once, from the union of every cell's ink,
 * and every cell in that row is drawn through it. The subject fills the strip
 * AND holds still, which is what an X-sheet has always looked like.
 *
 * Ink, not layer bounds: the document knows how big a pixel layer is, only the
 * pixels know how much of it is used (`surfaceInk`). Vector and box layers fall
 * back to their declared box, which for them is the same statement.
 */

/** A framing box in NORMALISED comp units — 0..1 across the comp's own box. */
export interface FocusBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Breathing room around the ink, as a fraction of the box. */
const PAD = 0.08;
/**
 * Below this the ink is close enough to filling the comp that zooming would
 * only wobble the picture for no gain — and a row of cells that re-frames
 * itself as you draw is worse than one that never does.
 */
const MIN_GAIN = 1.25;

/** A clip's painted box in COMP coordinates (comp-centre origin), or null. */
function clipInkBox(doc: MotionDocument, clip: Clip): { x0: number; y0: number; x1: number; y1: number } | null {
  if (clip.kind !== "raster") return null;
  const ink = surfaceInk(clip);
  if (!ink) return null;
  const t = clip.transform;
  const basis = {
    scale: t.scale,
    scaleY: t.scaleY ?? t.scale,
    rotation: t.rotation,
    skewX: t.skewX,
    skewY: t.skewY,
    anchor: t.anchor,
    size: { width: clip.width, height: clip.height, cx: 0, cy: 0 },
  };
  // Four corners through the layer's own map — a rotated layer's ink box is not
  // its ink box rotated, and using one would crop the corners off.
  const corners = [
    [ink.x0, ink.y0],
    [ink.x1, ink.y0],
    [ink.x0, ink.y1],
    [ink.x1, ink.y1],
  ] as const;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [px, py] of corners) {
    const a = { x: (t.anchor.x - 0.5) * clip.width, y: (t.anchor.y - 0.5) * clip.height };
    const d = mapLinear(px - clip.width / 2 - a.x, py - clip.height / 2 - a.y, basis);
    x0 = Math.min(x0, t.x + d.x);
    y0 = Math.min(y0, t.y + d.y);
    x1 = Math.max(x1, t.x + d.x);
    y1 = Math.max(y1, t.y + d.y);
  }
  return { x0, y0, x1, y1 };
}

/**
 * The framing for a whole row, or null to show the comp as-is.
 *
 * Null is the common and correct answer: a drawing that already fills its frame
 * needs no help, and a thumbnail that zooms by 4% is a thumbnail that jitters.
 */
export function rowFocusBox(doc: MotionDocument, row: FlipbookRow, comp: Frame): FocusBox | null {
  if (comp.width <= 0 || comp.height <= 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let found = false;
  for (const cell of row.cells) {
    if (cell.kind !== "nested") continue;
    for (const track of doc.tracks) {
      for (const layer of track.clips) {
        if (layer.frameId !== cell.sourceFrameId) continue;
        if (layer.hidden || track.hidden) continue;
        const box = clipInkBox(doc, layer);
        if (!box) continue;
        found = true;
        x0 = Math.min(x0, box.x0);
        y0 = Math.min(y0, box.y0);
        x1 = Math.max(x1, box.x1);
        y1 = Math.max(y1, box.y1);
      }
    }
  }
  if (!found || x1 <= x0 || y1 <= y0) return null;

  // Comp-centre origin → the comp's own 0..1 box, padded.
  const padX = (x1 - x0) * PAD;
  const padY = (y1 - y0) * PAD;
  const nx0 = (x0 - padX) / comp.width + 0.5;
  const ny0 = (y0 - padY) / comp.height + 0.5;
  const nx1 = (x1 + padX) / comp.width + 0.5;
  const ny1 = (y1 + padY) / comp.height + 0.5;

  const w = nx1 - nx0;
  const h = ny1 - ny0;
  if (w <= 0 || h <= 0) return null;
  // Zoom by the tighter axis, so the box keeps the comp's aspect and a cell
  // never has to letterbox or distort what it is showing.
  const gain = 1 / Math.max(w, h);
  if (gain < MIN_GAIN) return null;
  const side = Math.max(w, h);
  return {
    x: (nx0 + nx1) / 2 - side / 2,
    y: (ny0 + ny1) / 2 - side / 2,
    w: side,
    h: side,
  };
}


/**
 * A counter that ticks whenever any surface's pixels change or finish loading.
 *
 * The framing is derived from PIXELS, and pixels arrive asynchronously: a
 * freshly opened project answers "I don't know yet" for every layer whose PNG
 * is still streaming (`surfaceInk` returns null while loading, deliberately —
 * answering "empty" would zoom a thumbnail to nothing and then jump). Without
 * this the sheet would keep that first answer until something unrelated
 * happened to re-render it.
 *
 * One subscription per row rather than one per cell, and it drives a memo
 * rather than a paint, so a sheet of fifty cells settling in is a handful of
 * renders and not fifty.
 */
export function useSurfaceTick(): number {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => onSurfaceReady(() => setTick((t) => t + 1)), []);
  return tick;
}
