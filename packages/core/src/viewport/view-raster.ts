import { MAX_LAYER_BUFFER_PX } from "../animation/layer-region";
import type { Camera } from "./camera";

/**
 * THE CAMERA IS A VIEW, NOT AN EDIT — the headless half of moving around a
 * canvas.
 *
 * Panning and zooming change nothing a render would produce; only where the
 * picture lands. So a surface keeps the picture it last painted (a RASTER, in
 * device pixels, a margin wider than the viewport on every side) and, while
 * only the camera has moved, re-projects it: a pan is a copy at an offset, a
 * zoom is a scale. This module is the arithmetic of that and nothing else —
 * no canvas, no clock — so the decision "is this tick a view change or a
 * document change, and what exactly must be painted" is one tested function
 * instead of a few branches inside a render loop.
 *
 * It is the scheme every map and every infinite canvas uses, reduced to one
 * tile:
 *
 *  · THE MARGIN IS PAINTED AHEAD. When the viewport reaches the edge of what
 *    the raster holds, the band that is painted is not the sliver that just
 *    came into view but that sliver plus a whole margin beyond it, in the
 *    direction of travel. A pan then costs a copy on almost every frame and a
 *    paint once per margin, instead of a paint on every frame.
 *  · THE RASTER NEVER RESAMPLES ITSELF. Bands are painted into the raster's
 *    own pixel grid, at the camera it was made at, so a hundred pans leave it
 *    exactly as sharp as the first — there is no generation loss to settle
 *    out of, and a pan needs no re-render when it stops.
 *  · A ZOOM IS A DRAFT. Scaling pixels is soft by nature; the raster is drawn
 *    scaled for as long as the gesture runs and the caller re-renders when it
 *    ends. Nothing is kept from a scaled frame.
 */

/** A rectangle in device pixels. */
export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a surface kept from its last paint. Everything is DEVICE pixels. */
export interface ViewRaster {
  /** The camera the pixels were painted at. */
  view: Camera;
  /** Device px per CSS px the pixels were painted at. */
  dpr: number;
  /** The raster's own size. */
  width: number;
  height: number;
  /** Where the raster's top-left sits ON SCREEN at `view` (negative: the margin). */
  originX: number;
  originY: number;
  /** The part of the raster that holds painted pixels, in raster px. */
  valid: PxRect;
}

export type ReprojectPlan =
  /** The raster cannot stand in for this view: paint it. */
  | { kind: "render" }
  /**
   * A pure pan. In order: `scroll` the raster's pixels (re-centring it on the
   * viewport), paint `fill` into it for real, then copy `width × height` from
   * (`srcX`, `srcY`) to the screen. The raster's new state is what is returned.
   */
  | {
      kind: "pan";
      scroll: { dx: number; dy: number } | null;
      /** Raster-px bands to paint, AFTER the scroll. Empty on most frames. */
      fill: PxRect[];
      valid: PxRect;
      originX: number;
      originY: number;
      srcX: number;
      srcY: number;
    }
  /** A zoom: draw raster `src` into screen `dest` (scaled, soft), paint `holes` on screen. */
  | { kind: "zoom"; src: PxRect; dest: PxRect; holes: PxRect[] };

/** Largest share of the viewport worth patching before a full paint is as cheap. */
const MAX_EXPOSED_SHARE = 0.4;

/** How many margins a layer window is grown by — see `viewOverscanPx`. */
export const WINDOW_MARGINS = 2;

/**
 * THE MARGIN, in device px — how far past the viewport a surface keeps pixels,
 * on every side.
 *
 * One number, and two holders derived from it, on purpose. The stage raster
 * keeps ONE margin beyond the viewport. A layer too big for one buffer keeps
 * its window (`seenWindow`) grown by `WINDOW_MARGINS` of them — so it holds at
 * least two margins and at most four — which is exactly what makes the band a
 * pan paints ahead (the viewport's edge plus one margin, from up to one margin
 * of travel away) land inside pixels the layers already have at full
 * sharpness. Two unrelated margins would mean a band that is sharp to one edge
 * and soft past it.
 *
 * A quarter of the short side, and never so much that a layer window outgrows
 * one layer buffer: past that the window would have to drop resolution,
 * trading sharpness on screen for a wider margin nobody is looking at.
 */
export function viewOverscanPx(width: number, height: number): number {
  const room = Math.floor((MAX_LAYER_BUFFER_PX - Math.max(width, height)) / (WINDOW_MARGINS * 4));
  return Math.max(0, Math.min(Math.round(Math.min(width, height) / 4), room));
}

const area = (r: PxRect) => Math.max(0, r.w) * Math.max(0, r.h);

function intersect(a: PxRect, b: PxRect): PxRect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}

function hull(a: PxRect, b: PxRect): PxRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

const contains = (outer: PxRect, inner: PxRect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/** `outer` minus `inner`, as up to four bands: two full-height sides, then top and bottom between them. */
export function bandsAround(outer: PxRect, inner: PxRect): PxRect[] {
  const i = intersect(outer, inner);
  if (area(i) === 0) return area(outer) > 0 ? [outer] : [];
  const out: PxRect[] = [];
  const push = (x: number, y: number, w: number, h: number) => {
    if (w > 0.5 && h > 0.5) out.push({ x, y, w, h });
  };
  push(outer.x, outer.y, i.x - outer.x, outer.h);
  push(i.x + i.w, outer.y, outer.x + outer.w - (i.x + i.w), outer.h);
  push(i.x, outer.y, i.w, i.y - outer.y);
  push(i.x, i.y + i.h, i.w, outer.y + outer.h - (i.y + i.h));
  return out;
}

/**
 * What must happen for `raster` to show `view` in a viewport of this many
 * device px. Pure: the caller performs the plan and stores the returned state.
 *
 * The caller owns WHETHER the raster may be used at all — that its content is
 * still the document's picture is a question about the document, not about
 * geometry. This answers only where the pixels go.
 */
export function planReproject(raster: ViewRaster, view: Camera, viewport: { width: number; height: number }): ReprojectPlan {
  const W = viewport.width;
  const H = viewport.height;
  const k = view.scale / raster.view.scale;
  if (!Number.isFinite(k) || k <= 0 || W <= 0 || H <= 0) return { kind: "render" };
  const screen: PxRect = { x: 0, y: 0, w: W, h: H };

  if (Math.abs(k - 1) > 1e-9) {
    // A world point p is on screen at p·s + t, so the raster's pixels move by
    // the one similarity that takes the old view to the new one.
    const ex = (view.tx - raster.view.tx * k) * raster.dpr;
    const ey = (view.ty - raster.view.ty * k) * raster.dpr;
    const dest: PxRect = {
      x: (raster.originX + raster.valid.x) * k + ex,
      y: (raster.originY + raster.valid.y) * k + ey,
      w: raster.valid.w * k,
      h: raster.valid.h * k,
    };
    const holes = bandsAround(screen, dest);
    if (holes.reduce((s, r) => s + area(r), 0) > W * H * MAX_EXPOSED_SHARE) return { kind: "render" };
    return { kind: "zoom", src: raster.valid, dest, holes };
  }

  // ── A pan. Whole device pixels, so the copy never resamples: the picture is
  // at most half a device pixel from where a render would have put it.
  const dx = Math.round((view.tx - raster.view.tx) * raster.dpr);
  const dy = Math.round((view.ty - raster.view.ty) * raster.dpr);
  let originX = raster.originX;
  let originY = raster.originY;
  let valid = raster.valid;
  // The viewport, in raster px.
  let vx = 0 - (originX + dx);
  let vy = 0 - (originY + dy);
  if (contains(valid, { x: vx, y: vy, w: W, h: H })) {
    return { kind: "pan", scroll: null, fill: [], valid, originX, originY, srcX: vx, srcY: vy };
  }
  const exposed = W * H - area(intersect(valid, { x: vx, y: vy, w: W, h: H }));
  if (exposed > W * H * MAX_EXPOSED_SHARE) return { kind: "render" };

  // Which way it is travelling: the sides the viewport has run off.
  const left = vx < valid.x;
  const top = vy < valid.y;
  const right = vx + W > valid.x + valid.w;
  const bottom = vy + H > valid.y + valid.h;
  // Re-centre the raster on the viewport, so there is a full margin ahead to
  // paint into and a full margin behind still holding what was there.
  const mx = Math.max(0, Math.floor((raster.width - W) / 2));
  const my = Math.max(0, Math.floor((raster.height - H) / 2));
  const sx = vx - mx;
  const sy = vy - my;
  let scroll: { dx: number; dy: number } | null = null;
  if (sx !== 0 || sy !== 0) {
    scroll = { dx: 0 - sx, dy: 0 - sy };
    valid = intersect({ x: valid.x - sx, y: valid.y - sy, w: valid.w, h: valid.h }, { x: 0, y: 0, w: raster.width, h: raster.height });
    originX += sx;
    originY += sy;
    vx = mx;
    vy = my;
  }
  // The viewport, plus a margin on every side it is heading.
  const want = intersect(
    { x: vx - (left ? mx : 0), y: vy - (top ? my : 0), w: W + (left ? mx : 0) + (right ? mx : 0), h: H + (top ? my : 0) + (bottom ? my : 0) },
    { x: 0, y: 0, w: raster.width, h: raster.height },
  );
  // What is held stays a RECTANGLE (one tile, not a region to track), so the
  // bands are whatever takes the old rectangle to the hull of old and wanted.
  const next = area(valid) > 0 ? hull(valid, want) : want;
  return { kind: "pan", scroll, fill: bandsAround(next, valid), valid: next, originX, originY, srcX: vx, srcY: vy };
}
