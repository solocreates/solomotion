"use client";

/**
 * THE PASS BUFFER POOL — every canvas the effect chain draws into.
 *
 * A ring of OUTPUT canvases (reused across frames) so a chain of passes never
 * overwrites the buffer the next pass still reads, plus a separate acquire/
 * release pool for the scratch a single pass needs internally (blur copies,
 * pixel reads, stencils).
 *
 * It lives in its own module because it is the one thing every pass family
 * shares, and a family is a LAZY CHUNK: if each chunk carried its own ring, a
 * document with grain and glass would hold two pools of eight full-frame
 * canvases instead of one, which at 4K is about 250 MB of nothing. One pool,
 * imported by every family, is the whole reason the lazy split does not cost
 * memory to buy bundle size.
 */

// A ring of output canvases (reused across frames) so a chain of passes never
// overwrites the buffer the next pass still reads. Temp buffers (blur copies,
// pixel reads) come from a separate acquire/release pool.
export interface Buf {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  busy: boolean;
}
const RING = 8;
const ring: Buf[] = [];
let ringAt = 0;
export function nextOutput(w: number, h: number): Buf {
  if (ring.length < RING) {
    const canvas = document.createElement("canvas");
    ring.push({ canvas, ctx: canvas.getContext("2d")!, busy: false });
  }
  const b = ring[ringAt % ring.length]!;
  ringAt++;
  // The ring is eight deep and wraps. Reissuing the canvas whose pixels are
  // retained makes that retention a lie, so it is dropped here rather than
  // relying on a chain never being that long.
  if (retained?.canvas === b.canvas) retained = null;
  sizeAndClear(b, w, h);
  return b;
}
const tempPool: Buf[] = [];
export function acquireTemp(w: number, h: number): Buf {
  let b = tempPool.find((x) => !x.busy);
  if (!b) {
    const canvas = document.createElement("canvas");
    b = { canvas, ctx: canvas.getContext("2d")!, busy: false };
    tempPool.push(b);
  }
  b.busy = true;
  sizeAndClear(b, w, h);
  return b;
}
function sizeAndClear(b: Buf, w: number, h: number): void {
  if (b.canvas.width !== w || b.canvas.height !== h) {
    b.canvas.width = w; // resizing already clears
    b.canvas.height = h;
  } else {
    b.ctx.setTransform(1, 0, 0, 1, 0, 0);
    b.ctx.filter = "none";
    b.ctx.globalAlpha = 1;
    b.ctx.globalCompositeOperation = "source-over";
    b.ctx.clearRect(0, 0, w, h);
  }
  b.ctx.setTransform(1, 0, 0, 1, 0, 0);
  b.ctx.filter = "none";
  b.ctx.globalAlpha = 1;
  b.ctx.globalCompositeOperation = "source-over";
}


/** Give a scratch buffer back to the pool. Pair every `acquireTemp` with one. */
export function releaseTemp(b: Buf | null): void {
  if (b) b.busy = false;
}

/**
 * THE PIXELS THE LAST CPU PASS WROTE, kept so the next one need not read them
 * back.
 *
 * A per-pixel pass is `drawImage` → `getImageData` → mutate → `putImageData`,
 * and a stack of them is that round trip once per card. `getImageData` is the
 * expensive half — it forces a GPU-to-CPU readback and synchronises the
 * pipeline — and in a Performance recording of a heavy layer it was 66% of the
 * self time of the whole render.
 *
 * But a chain already knows the answer: when pass B's source is the very buffer
 * pass A just wrote, the pixels B is about to read back are the `ImageData` A
 * was holding. Handing it over turns an N-card stack from N readbacks into one.
 *
 * Retention is deliberately a SINGLE slot with no history, and it is dropped on
 * the first of: someone taking it (they are about to mutate it, so it no longer
 * describes the canvas), or the ring reissuing that canvas. Anything the chain
 * does that this does not model simply misses and reads back, which is exactly
 * today's behaviour — the failure direction is a wasted `getImageData`, never a
 * wrong pixel.
 */
let retained: { canvas: HTMLCanvasElement; image: ImageData } | null = null;

/** Called by `writePixels`: these pixels ARE that canvas, until told otherwise. */
export function retainPixels(canvas: HTMLCanvasElement, image: ImageData): void {
  retained = { canvas, image };
}

/**
 * The retained pixels for `canvas`, or null. Taking them CONSUMES the slot: the
 * caller mutates what it gets, so the canvas and the image stop agreeing the
 * moment this returns.
 */
export function takeRetained(canvas: CanvasImageSource, w: number, h: number): ImageData | null {
  const r = retained;
  if (!r || r.canvas !== canvas) return null;
  if (r.image.width !== w || r.image.height !== h) return null;
  retained = null;
  return r.image;
}

/**
 * `src` moved by (dx, dy) inside a w×h buffer, the strips it uncovers filled
 * by stretching its own edge rows and columns — CLAMP-TO-EDGE sampling, what a
 * GPU does for an offset read and what After Effects calls "repeat edge
 * pixels". The strips go down FIRST so the picture's sub-pixel edge blends onto
 * its own colour, never onto nothing.
 */
export function shiftClamped(src: CanvasImageSource, w: number, h: number, dx: number, dy: number): Buf {
  const t = acquireTemp(w, h);
  const c = t.ctx;
  const L = dx > 0 ? Math.ceil(dx) + 1 : 0;
  const R = dx < 0 ? Math.ceil(-dx) + 1 : 0;
  const T = dy > 0 ? Math.ceil(dy) + 1 : 0;
  const B = dy < 0 ? Math.ceil(-dy) + 1 : 0;
  if (L) c.drawImage(src, 0, 0, 1, h, 0, dy, L, h);
  if (R) c.drawImage(src, w - 1, 0, 1, h, w - R, dy, R, h);
  if (T) c.drawImage(src, 0, 0, w, 1, dx, 0, w, T);
  if (B) c.drawImage(src, 0, h - 1, w, 1, dx, h - B, w, B);
  // The corners repeat the corner pixel.
  if (L && T) c.drawImage(src, 0, 0, 1, 1, 0, 0, L, T);
  if (R && T) c.drawImage(src, w - 1, 0, 1, 1, w - R, 0, R, T);
  if (L && B) c.drawImage(src, 0, h - 1, 1, 1, 0, h - B, L, B);
  if (R && B) c.drawImage(src, w - 1, h - 1, 1, 1, w - R, h - B, R, B);
  c.drawImage(src, dx, dy);
  return t;
}
