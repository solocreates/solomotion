"use client";

import type { ScopeSource } from "@solomotion/core";

/**
 * THE FRAME SAMPLER — a small, throttled copy of whatever the stage last drew.
 *
 * Scopes have to measure the picture on screen, and the picture on screen lives
 * in a canvas whose backing store is the full composite at device resolution.
 * Reading that directly, per frame, is a `getImageData` of up to eight million
 * pixels — which is both the slowest operation in the browser's 2D API and a
 * GPU→CPU sync that stalls the very render it is measuring.
 *
 * So: ONE downscale to a fixed small buffer, shared by every subscriber, on a
 * rAF clock with a floor. A scope is a statistic; measuring a 480-wide copy of
 * a 4K frame gives the same waveform, and it costs about 1% as much.
 *
 * Subscribers drive the loop. With nothing listening there is no sampling at
 * all, so the cost is exactly zero whenever the Color page is closed — which is
 * most of the time, and is the difference between a feature that is free and a
 * feature that taxes everyone who never opens it.
 */

/** Width the composite is downscaled to before it is read back. */
const SAMPLE_W = 480;
/** Floor between samples. ~20/s is smoother than the eye reads a scope. */
const MIN_INTERVAL_MS = 50;

type Listener = (frame: ScopeSource | null) => void;

let stageCanvas: HTMLCanvasElement | null = null;
let buffer: HTMLCanvasElement | null = null;
const listeners = new Set<Listener>();
let raf = 0;
let last = 0;

/**
 * Tell the sampler where the stage's canvas is. Called once by the stage.
 *
 * A registration rather than a DOM query, for the reason every registration in
 * this codebase exists: a query would silently find the wrong canvas the day a
 * second one appears, and would return null during the frame before the stage
 * mounts — a failure that looks like "the scopes are broken" rather than like a
 * missing call.
 */
export function registerStageCanvas(canvas: HTMLCanvasElement | null): () => void {
  stageCanvas = canvas;
  return () => {
    if (stageCanvas === canvas) stageCanvas = null;
  };
}

/** Subscribe to downscaled frames. Returns an unsubscribe. */
export function getStageFrameSample(fn: Listener): () => void {
  listeners.add(fn);
  start();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) stop();
  };
}

function start(): void {
  if (raf) return;
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    if (now - last < MIN_INTERVAL_MS) return;
    last = now;
    const frame = sample();
    for (const fn of listeners) fn(frame);
  };
  raf = requestAnimationFrame(tick);
}

function stop(): void {
  cancelAnimationFrame(raf);
  raf = 0;
}

function sample(): ScopeSource | null {
  const src = stageCanvas;
  if (!src || src.width === 0 || src.height === 0) return null;
  const w = Math.min(SAMPLE_W, src.width);
  const h = Math.max(1, Math.round((src.height / src.width) * w));
  if (!buffer) buffer = document.createElement("canvas");
  if (buffer.width !== w || buffer.height !== h) {
    buffer.width = w;
    buffer.height = h;
  }
  const ctx = buffer.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  // The stage paints on a transparent ground, and a scope must measure the
  // picture rather than the checkerboard behind it — so nothing is drawn under
  // it and transparent pixels are excluded by the scope maths itself.
  ctx.clearRect(0, 0, w, h);
  try {
    ctx.drawImage(src, 0, 0, w, h);
  } catch {
    // A tainted canvas (a cross-origin source drawn without CORS) throws on
    // read. Losing the scopes is the right outcome; losing the frame is not.
    return null;
  }
  try {
    return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
  } catch {
    return null;
  }
}
