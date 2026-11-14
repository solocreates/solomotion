/**
 * THE ANALYSIS CONTRACT — what the host hands a solve, and nothing else.
 *
 * Engines never touch the DOM, media decoding or seeking. The host decodes
 * (WebCodecs in a worker, or a `<video>` element as the fallback) and hands
 * over FRAMES; everything from there to a baked sample is pure maths in this
 * package, so it runs in a worker, on the main thread or in a test unchanged.
 *
 * Frames are LUMA planes at ANALYSIS resolution: one byte a pixel instead of
 * four, and a 4K plate analysed at 1280 px costs a ninth of the pixels. Every
 * method but `color` reads luma alone; `color` asks for RGBA as well. Positions
 * are scaled back to source pixels at the boundary (`run.ts`), so nothing the
 * document stores knows what resolution it was measured at.
 */

import { yieldNow } from "../runtime/chunk";

export interface AnalysisFrame {
  width: number;
  height: number;
  /** Rec.601 luma, 0..255, row-major, `width * height`. */
  luma: Uint8Array;
  /** RGBA, row-major, present only when the solve asked for colour. */
  rgba?: Uint8ClampedArray;
}

/**
 * Pixel access over a source's timeline at a fixed analysis resolution. The
 * run steps `times` and pulls frames; how they arrive is the host's business.
 */
export interface FrameProvider {
  /** Source size, px — what samples are stored in. */
  sourceWidth: number;
  sourceHeight: number;
  /** Analysis px per source px (≤ 1). Frames arrive at `round(source * scale)`. */
  scale: number;
  /** Every frame time (source ms, ascending) a run may visit. */
  times: number[];
  /** The source shows the same pixels at every time (a still): one sample is the whole answer. */
  still: boolean;
  getFrame(sourceMs: number): Promise<AnalysisFrame>;
}

/** Thrown (as `err.name === "AbortError"`) when work is cancelled. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const err = new Error("Tracking cancelled");
    err.name = "AbortError";
    throw err;
  }
}

/**
 * Cooperative yield for loops that may run synchronously for a long time (a
 * still-image provider resolves instantly). Yields a real macrotask at most
 * every ~16 ms of wall clock, so whatever thread this runs on stays live and
 * a pause or cancel lands promptly.
 */
export class FrameThrottle {
  private last = Date.now();
  async tick(): Promise<void> {
    const now = Date.now();
    if (now - this.last > 16) {
      this.last = now;
      // The host's yield (a message task), never `setTimeout(0)`: a hidden
      // tab clamps timers to once a second, which turned a 16 s track into
      // 100 s the moment you looked at another tab.
      await yieldNow();
    }
  }
}

/** Rec.601 luma of RGBA bytes into a plane — what every host frame source calls once per frame. */
export function lumaFromRgba(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, out?: Uint8Array): Uint8Array {
  const n = width * height;
  const luma = out && out.length === n ? out : new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    // Integer weights (×1024) — the exact Rec.601 mix without a float per byte.
    luma[i] = (306 * rgba[j]! + 601 * rgba[j + 1]! + 117 * rgba[j + 2]!) >> 10;
  }
  return luma;
}

/** Luma at an integer pixel; out of bounds reads as the nearest edge (no black frame border to lock onto). */
export function lumaAt(f: AnalysisFrame, x: number, y: number): number {
  const cx = x < 0 ? 0 : x >= f.width ? f.width - 1 : x;
  const cy = y < 0 ? 0 : y >= f.height ? f.height - 1 : y;
  return f.luma[cy * f.width + cx]!;
}

/** Clamp a value to [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The analysis scale for a source and an edge cap (0 = native). */
export function analysisScale(sourceWidth: number, sourceHeight: number, edge: number): number {
  const long = Math.max(sourceWidth, sourceHeight);
  return edge > 0 && long > edge ? edge / long : 1;
}

/** A small deterministic PRNG (mulberry32) — RANSAC must give the same answer on every replay. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
