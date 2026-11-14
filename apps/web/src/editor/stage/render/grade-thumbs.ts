"use client";

/**
 * PER-NODE THUMBNAILS — what each step of the chain actually produced.
 *
 * A node board without them is a diagram of a grade; with them it is the grade.
 * The reason it is not obviously worth doing is cost, so here is the cost,
 * stated rather than assumed:
 *
 *   the copy       one `drawImage` from a canvas the runner has ALREADY made,
 *                  down to 96px. Microseconds. It is not the expensive part.
 *   the CADENCE    doing that N times per frame, at 60fps, forever, for a panel
 *                  nobody has open. That IS the expensive part.
 *
 * So the cadence is the whole design. Three gates, in order of how much they
 * save:
 *
 *   1. NOBODY IS LOOKING → nothing happens at all. The Color page subscribes
 *      while it is open; with no subscriber the runner never asks.
 *   2. NOT YET → at most one capture pass every `MIN_INTERVAL_MS`. A thumbnail
 *      is a glance, not a monitor.
 *   3. SMALL → a fixed 96px long edge, so a 4K plate and a 720p one cost the
 *      same, and the whole board's worth of thumbs is a few hundred KB.
 *
 * Canvases are pooled per node id and reused, so a steady state allocates
 * nothing. The version counter is what the board re-renders on — the canvases
 * themselves are mutated in place, and React cannot see that.
 */

const THUMB_LONG_EDGE = 96;
const MIN_INTERVAL_MS = 220;

const thumbs = new Map<string, HTMLCanvasElement>();
const listeners = new Set<() => void>();
let version = 0;
let lastPass = 0;
let passOpen = false;

/** Subscribe while a surface is showing thumbnails. Returns an unsubscribe. */
export function subscribeGradeThumbs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) {
      // Drop the pool when the last viewer leaves: these are caches of a frame
      // that will not be current when anyone comes back.
      thumbs.clear();
      version++;
    }
  };
}

/** Is anything showing them? The runner's first and cheapest gate. */
export function gradeThumbsWanted(): boolean {
  return listeners.size > 0;
}

/** The current thumbnail for a node, or null. */
export function gradeThumb(nodeId: string): HTMLCanvasElement | null {
  return thumbs.get(nodeId) ?? null;
}

/** Bumped whenever a capture pass lands — the board's `useSyncExternalStore` key. */
export function gradeThumbsVersion(): number {
  return version;
}

/**
 * Open a capture pass for one program run. Returns false when this frame should
 * not capture, so the runner's per-step call is a single boolean test.
 *
 * A PASS rather than a per-node throttle, because a half-updated board — three
 * nodes from this frame and two from four frames ago — reads as a glitch, and
 * the frames it would save are the cheap ones anyway.
 */
export function beginThumbPass(): boolean {
  if (listeners.size === 0) return false;
  const now = performance.now();
  if (now - lastPass < MIN_INTERVAL_MS) return false;
  lastPass = now;
  passOpen = true;
  return true;
}

/** Close the pass and tell the subscribers. */
export function endThumbPass(): void {
  if (!passOpen) return;
  passOpen = false;
  version++;
  for (const fn of listeners) fn();
}

/** Capture one node's output. Called only inside an open pass. */
export function captureThumb(nodeId: string, src: CanvasImageSource, w: number, h: number): void {
  if (!passOpen || w <= 0 || h <= 0) return;
  const scale = THUMB_LONG_EDGE / Math.max(w, h);
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  let canvas = thumbs.get(nodeId);
  if (!canvas) {
    canvas = document.createElement("canvas");
    thumbs.set(nodeId, canvas);
  }
  if (canvas.width !== tw || canvas.height !== th) {
    canvas.width = tw;
    canvas.height = th;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, tw, th);
  ctx.drawImage(src, 0, 0, tw, th);
}
