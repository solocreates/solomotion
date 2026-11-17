"use client";

import { planReproject, viewOverscanPx, type PxRect, type ReprojectPlan, type ViewRaster } from "@solomotion/core";
import { overRenderBudget } from "./render-budget";

/**
 * THE CAMERA PATH — what the stage draws while you are moving the camera.
 *
 * Panning and zooming change NOTHING about the document. Every layer, every
 * effect, every glyph is the same picture it was a millisecond ago; only where
 * you are standing changed. So the stage keeps the picture it last painted and,
 * while only the camera has moved, moves THAT: a pan is a copy of pixels that
 * already exist, a zoom is a scale of them — soft for as long as your fingers
 * are on the trackpad, sharp again when they stop.
 *
 * The arithmetic is core's (`viewport/view-raster.ts`, tested headless): what
 * to copy, what band to paint ahead, when the raster cannot stand in at all.
 * This file is the half that owns a canvas.
 *
 * ── What makes it hold at any zoom ──────────────────────────────────────────
 *
 *  1. THE RASTER IS WIDER THAN THE SCREEN. It keeps a margin on every side, and
 *     when the viewport reaches the edge of what is held, the band painted is
 *     the strip that came into view PLUS a whole margin in the direction of
 *     travel. So a pan is a single copy on almost every frame and one real
 *     paint per margin of travel — where painting the leading strip on every
 *     frame walked the whole scene sixty times a second.
 *
 *  2. NOTHING IS RESAMPLED TWICE. Bands are painted into the raster's own
 *     pixel grid at the camera it was made at, and the copy to the screen is
 *     by whole device pixels. There is no generation loss to recover from, so
 *     a pan that ends needs no re-render: what is on screen is already the
 *     picture. (It used to keep each blitted composite as the next raster,
 *     which was exact only for whole-pixel pans — a trackpad's are not — and
 *     re-rendered the whole stage every time the camera came to rest.)
 *
 *  3. IT CANNOT SHOW STALE ARTWORK. The raster carries the content version it
 *     was painted at. Anything that changes what a draw would produce — an
 *     edit, the playhead, a decoded video frame, a loaded surface, a font —
 *     bumps that version, and a mismatch refuses the raster outright.
 *
 *  4. IT ONLY ENGAGES WHEN IT PAYS. Under the render budget nothing is kept
 *     and nothing is copied — a light document renders every frame exactly as
 *     it always did, with no staleness to reason about.
 *
 * Hit rectangles are world-space, so they survive untouched: you can still
 * click what you can see while the camera is moving.
 */

/** Camera considered "in motion" for this long after the last move. */
const MOTION_WINDOW_MS = 90;

interface Snapshot extends ViewRaster {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** The viewport it was made for, device px. */
  viewW: number;
  viewH: number;
  contentVersion: number;
}

let snapshot: Snapshot | null = null;
let lastMoveMs = -Infinity;

/** The camera moved. Called from the ONE seam every camera gesture funnels
 *  through, so no future gesture can forget to say so. */
export function noteCameraMove(nowMs: number): void {
  lastMoveMs = nowMs;
}

/** Is the camera in motion right now? */
export function cameraInMotion(nowMs: number): boolean {
  return nowMs - lastMoveMs < MOTION_WINDOW_MS;
}

/** How long the camera has been still — what the stage waits on before it sharpens after a zoom. */
export function cameraStillForMs(nowMs: number): number {
  return nowMs - lastMoveMs;
}

/**
 * Is rendering expensive enough for the raster to be worth its copy?
 *
 * The cost average itself lives in `render-budget.ts`: the pacer needs the same
 * number, and two modules measuring "what does a render cost" would drift the
 * moment one of them learned about a render path the other did not.
 */
export function rasterWorthwhile(): boolean {
  return overRenderBudget();
}

export type CameraPlan = Exclude<ReprojectPlan, { kind: "render" }>;

/**
 * May this tick move the raster instead of rendering, and how? Null means
 * render — the answer for every condition below, each of which is a reason the
 * raster would otherwise be a lie.
 *
 * `contentVersion` null is the caller vouching for the content itself: a
 * playing comp between two of its own frames is the same picture whatever the
 * transport's clock has written since.
 */
export function planCamera(
  nowMs: number,
  contentVersion: number | null,
  viewW: number,
  viewH: number,
  dpr: number,
  view: { scale: number; tx: number; ty: number },
): CameraPlan | null {
  const s = snapshot;
  if (!s || !rasterWorthwhile()) return null;
  if (!cameraInMotion(nowMs)) return null; // at rest every dirty tick is a real render
  if (contentVersion !== null && s.contentVersion !== contentVersion) return null; // artwork moved on
  if (s.viewW !== viewW || s.viewH !== viewH || s.dpr !== dpr) return null;
  const plan = planReproject(s, view, { width: viewW, height: viewH });
  return plan.kind === "render" ? null : plan;
}

/**
 * Carry out a pan: scroll the raster, have `paint` fill the bands for real,
 * copy the viewport out of it. `paint` receives the raster's context already
 * clipped to the bands and cleared there, with an identity transform; the
 * stage's own camera lands at (`srcX`, `srcY`) in it.
 */
export function panRaster(
  screen: CanvasRenderingContext2D,
  plan: Extract<CameraPlan, { kind: "pan" }>,
  paint: (raster: CanvasRenderingContext2D, extent: PxRect) => void,
): void {
  const s = snapshot;
  if (!s) return;
  const r = s.ctx;
  if (plan.scroll) {
    // A canvas may draw itself: the engine reads the source before it writes.
    // `copy` also clears what the shift leaves behind.
    r.save();
    r.setTransform(1, 0, 0, 1, 0, 0);
    r.globalCompositeOperation = "copy";
    r.drawImage(s.canvas, plan.scroll.dx, plan.scroll.dy);
    r.restore();
  }
  if (plan.fill.length > 0) {
    r.save();
    r.setTransform(1, 0, 0, 1, 0, 0);
    r.beginPath();
    for (const b of plan.fill) r.rect(b.x, b.y, b.w, b.h);
    r.clip();
    for (const b of plan.fill) r.clearRect(b.x, b.y, b.w, b.h);
    paint(r, plan.valid);
    r.restore();
  }
  s.valid = plan.valid;
  s.originX = plan.originX;
  s.originY = plan.originY;

  screen.save();
  screen.setTransform(1, 0, 0, 1, 0, 0);
  screen.drawImage(s.canvas, plan.srcX, plan.srcY, s.viewW, s.viewH, 0, 0, s.viewW, s.viewH);
  screen.restore();
}

/** Carry out a zoom: the raster, scaled to where the camera now puts it. Device px. */
export function zoomRaster(screen: CanvasRenderingContext2D, plan: Extract<CameraPlan, { kind: "zoom" }>): void {
  const s = snapshot;
  if (!s) return;
  screen.save();
  screen.setTransform(1, 0, 0, 1, 0, 0);
  screen.imageSmoothingQuality = "low"; // a gesture-time resample, not a render
  screen.drawImage(s.canvas, plan.src.x, plan.src.y, plan.src.w, plan.src.h, plan.dest.x, plan.dest.y, plan.dest.w, plan.dest.h);
  screen.restore();
}

/**
 * Keep the frame content just painted onto `source`, for the camera to move
 * around. Called with the composite AFTER the frames and BEFORE any chrome, so
 * selection, guides and rulers stay live and crisp while it moves.
 *
 * It lands in the middle of a raster one margin wider on every side
 * (`viewOverscanPx`); the margins start empty and are painted as a pan heads
 * into them.
 */
export function captureRaster(
  source: HTMLCanvasElement,
  view: { scale: number; tx: number; ty: number },
  dpr: number,
  contentVersion: number,
): void {
  if (!rasterWorthwhile()) {
    // Cheap board: drop anything held so memory does not linger behind a path
    // this document will never take.
    snapshot = null;
    return;
  }
  let s = snapshot;
  if (!s) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    s = {
      canvas,
      ctx,
      view,
      dpr,
      width: 0,
      height: 0,
      originX: 0,
      originY: 0,
      valid: { x: 0, y: 0, w: 0, h: 0 },
      viewW: 0,
      viewH: 0,
      contentVersion,
    };
    snapshot = s;
  }
  const margin = viewOverscanPx(source.width, source.height);
  const width = source.width + margin * 2;
  const height = source.height + margin * 2;
  s.ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (s.canvas.width !== width || s.canvas.height !== height) {
    s.canvas.width = width;
    s.canvas.height = height;
  } else {
    s.ctx.clearRect(0, 0, width, height);
  }
  s.ctx.drawImage(source, margin, margin);
  s.width = width;
  s.height = height;
  s.viewW = source.width;
  s.viewH = source.height;
  s.originX = -margin;
  s.originY = -margin;
  s.valid = { x: margin, y: margin, w: source.width, h: source.height };
  s.view = { scale: view.scale, tx: view.tx, ty: view.ty };
  s.dpr = dpr;
  s.contentVersion = contentVersion;
}

/** Forget the raster — the document, the surface or the session changed shape. */
export function dropRaster(): void {
  snapshot = null;
}
