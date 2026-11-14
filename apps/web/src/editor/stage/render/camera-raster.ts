"use client";

import { overRenderBudget, renderCostMs } from "./render-budget";

/**
 * THE CAMERA FAST PATH — what the stage draws while you are moving the camera.
 *
 * Panning and zooming change NOTHING about the document. Every layer, every
 * effect, every glyph is the same picture it was a millisecond ago; only where
 * you are standing changed. The stage re-rendered all of it anyway, sixty times
 * a second, because "the view moved" and "the artwork changed" both arrived as
 * the same dirty flag — so the heaviest board cost the most to look around,
 * which is exactly backwards.
 *
 * So: keep the last painted frame content as a raster, and while the camera is
 * in motion, move THAT instead. A pan is a translation of pixels that already
 * exist. A zoom is a scale of them — soft for as long as your fingers are on
 * the trackpad, sharp again the instant they stop.
 *
 * ── Three rules keep it honest ──────────────────────────────────────────────
 *
 *  1. IT ONLY ENGAGES WHEN IT PAYS. The stage measures what a real render
 *     costs. Under the budget it never captures and never blits — a light
 *     document behaves exactly as it did, with no staleness to reason about and
 *     no copy to pay for. The fast path is for the boards that need it.
 *
 *  2. IT CANNOT SHOW STALE ARTWORK. The raster carries the content version it
 *     was painted at. Anything that changes what a draw would produce — an
 *     edit, the playhead, a decoded video frame, a loaded surface, a font —
 *     bumps that version, and a mismatch refuses the blit outright rather than
 *     trying to be clever about what still matches.
 *
 *  3. IT IS A DEFERRAL, NEVER A REPLACEMENT. A real render always follows: on
 *     the next tick after the camera settles, and at least every `MAX_SKIP_MS`
 *     through a long gesture. The blit buys latency, not correctness.
 *
 * ── Nothing ever arrives as a void ──────────────────────────────────────────
 *
 * The raster covers where you WERE, so a pan exposes a strip along the leading
 * edge that it has nothing to say about. `planBlit` returns those bands and the
 * stage paints them for real, clipped to exactly them — board sliding in from
 * off-screen arrives already drawn rather than as a black band that fills in a
 * frame later. And because a pure pan lands on exact pixels, the composite it
 * produces IS a render of the current viewport, so it becomes the next raster:
 * panning a heavy board settles into costing only the strip entering the
 * screen. A zoom resamples, so it keeps its original raster instead — re-keeping
 * a resampled one would compound softness tick after tick.
 *
 * Hit rectangles are world-space, so they survive a blit untouched: you can
 * still click what you can see while the camera is moving.
 */

export interface CameraView {
  scale: number;
  tx: number;
  ty: number;
}

/** Longest run of blits before a real render is forced — see rule 3. */
const MAX_SKIP_MS = 96;
/** Camera considered "in motion" for this long after the last move. */
const MOTION_WINDOW_MS = 90;
interface Snapshot {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** CSS px the raster covers — the size it is blitted back at. */
  cssWidth: number;
  cssHeight: number;
  view: CameraView;
  contentVersion: number;
}

let snapshot: Snapshot | null = null;
let lastMoveMs = -Infinity;
let lastRealRenderMs = -Infinity;

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
 * Is rendering expensive enough for the fast path to be worth its copy?
 *
 * The cost average itself lives in `render-budget.ts`: the pacer needs the same
 * number, and two modules measuring "what does a render cost" would drift the
 * moment one of them learned about a render path the other did not.
 */
export function rasterWorthwhile(): boolean {
  return overRenderBudget();
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BlitPlan {
  /** Viewport bands the raster does not cover — painted for real, so the
   *  leading edge of a pan is never a void. Empty when it covers everything. */
  holes: Rect[];
  /**
   * The blit is pixel-exact (a pure pan), so the composite it produces is as
   * good as a render and can be kept as the new raster. A zoom resamples, and
   * re-keeping a resampled raster would compound the softness every tick —
   * generation loss — so a zoom stays on its original until the camera settles.
   */
  exact: boolean;
}

/** Largest share of the viewport worth patching before a full render is cheaper. */
const MAX_HOLE_AREA = 0.4;

/**
 * May this tick blit instead of render, and what would it have to patch?
 * Null means render normally — the answer for every condition below, each of
 * which is a reason the raster would otherwise be a lie.
 */
export function planBlit(
  nowMs: number,
  contentVersion: number,
  cssWidth: number,
  cssHeight: number,
  view: CameraView,
): BlitPlan | null {
  const s = snapshot;
  if (!s || !rasterWorthwhile()) return null;
  if (!cameraInMotion(nowMs)) return null; // settled → render, sharp
  if (s.contentVersion !== contentVersion) return null; // artwork moved on
  if (s.cssWidth !== cssWidth || s.cssHeight !== cssHeight) return null;
  // Rule 3 — but never at the price of a frozen gesture. A refresh is worth
  // forcing mid-gesture only when a render fits in a couple of frames; when it
  // costs more, forcing one every MAX_SKIP_MS turned a pan over a heavy board
  // into a 1 s stall every 96 ms. Such a board refreshes when the camera settles.
  if (nowMs - lastRealRenderMs > MAX_SKIP_MS && renderCostMs() < MAX_SKIP_MS / 3) return null;

  // Where the raster lands at the camera's current position.
  const k = view.scale / s.view.scale;
  const x0 = view.tx - s.view.tx * k;
  const y0 = view.ty - s.view.ty * k;
  const x1 = x0 + s.cssWidth * k;
  const y1 = y0 + s.cssHeight * k;

  // The viewport minus that rect, as up to four bands. Panning exposes one or
  // two; zooming out exposes a ring.
  const holes: Rect[] = [];
  const push = (x: number, y: number, w: number, h: number) => {
    if (w > 0.5 && h > 0.5) holes.push({ x, y, w, h });
  };
  const l = Math.min(cssWidth, Math.max(0, x0));
  const r = Math.min(cssWidth, Math.max(0, cssWidth - x1));
  const t = Math.min(cssHeight, Math.max(0, y0));
  const b = Math.min(cssHeight, Math.max(0, cssHeight - y1));
  push(0, 0, l, cssHeight);
  push(cssWidth - r, 0, r, cssHeight);
  push(l, 0, cssWidth - l - r, t);
  push(l, cssHeight - b, cssWidth - l - r, b);

  let area = 0;
  for (const h of holes) area += h.w * h.h;
  if (area > cssWidth * cssHeight * MAX_HOLE_AREA) return null; // patching costs more

  return { holes, exact: k === 1 };
}

/**
 * Draw the stored raster where the CURRENT camera says it belongs. `ctx` is
 * expected in CSS px (the stage's dpr transform already applied).
 *
 * Screen position of a world point is `p·s + t`, so mapping the raster from the
 * view it was painted at to the view now is one similarity: scale by s₁/s₀ and
 * translate by whatever keeps the origin honest. A pure pan lands on exact
 * pixels; only a zoom resamples, and only until you let go.
 */
export function blitRaster(ctx: CanvasRenderingContext2D, view: CameraView): void {
  const s = snapshot;
  if (!s) return;
  const k = view.scale / s.view.scale;
  ctx.save();
  ctx.transform(k, 0, 0, k, view.tx - s.view.tx * k, view.ty - s.view.ty * k);
  ctx.imageSmoothingQuality = "low"; // a gesture-time resample, not a render
  ctx.drawImage(s.canvas, 0, 0, s.cssWidth, s.cssHeight);
  ctx.restore();
}

/**
 * Keep the frame content just painted onto `source`, for the camera to move
 * around. Called with the composite AFTER the frames and BEFORE any chrome, so
 * selection, guides and rulers stay live and crisp on a blitted tick.
 */
export function captureRaster(
  source: HTMLCanvasElement,
  view: CameraView,
  cssWidth: number,
  cssHeight: number,
  nowMs: number,
  contentVersion: number,
  /**
   * A pure-pan tick keeps its own composite as the new raster: the blit was
   * pixel-exact and the holes were painted for real, so the result is a real
   * render of the current viewport. That is what makes panning cost only the
   * strip that came into view — but it must NOT reset the deferral clock,
   * because no full render happened.
   */
  fromBlit = false,
): void {
  if (!fromBlit) lastRealRenderMs = nowMs;
  if (!rasterWorthwhile()) {
    // Cheap board: drop anything held so memory does not linger behind a fast
    // path this document will never take.
    snapshot = null;
    return;
  }
  let s = snapshot;
  if (!s) {
    const canvas = document.createElement("canvas");
    const c2d = canvas.getContext("2d");
    if (!c2d) return;
    s = { canvas, ctx: c2d, cssWidth: 0, cssHeight: 0, view, contentVersion };
    snapshot = s;
  }
  if (s.canvas.width !== source.width || s.canvas.height !== source.height) {
    s.canvas.width = source.width;
    s.canvas.height = source.height;
  } else {
    s.ctx.setTransform(1, 0, 0, 1, 0, 0);
    s.ctx.clearRect(0, 0, s.canvas.width, s.canvas.height);
  }
  s.ctx.setTransform(1, 0, 0, 1, 0, 0);
  s.ctx.drawImage(source, 0, 0);
  s.cssWidth = cssWidth;
  s.cssHeight = cssHeight;
  s.view = { ...view };
  s.contentVersion = contentVersion;
}

/** Forget the raster — the document, the surface or the session changed shape. */
export function dropRaster(): void {
  snapshot = null;
}
