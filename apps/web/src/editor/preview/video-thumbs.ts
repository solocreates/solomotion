"use client";

import { assetObjectURL } from "../assets/asset-store";

/**
 * FOOTAGE THUMBNAILS WITHOUT PLAYBACK — what every NLE shows the moment a clip
 * lands on the timeline.
 *
 * The poster store used to read footage only from frames a playthrough had
 * already banked, and for a sound reason: decoding on behalf of a filmstrip,
 * on the stage's own elements, made scrolling the heaviest thing in the app
 * and fought playback for the decoder. Both objections are answered
 * structurally now, not by refusing:
 *
 *  - **Private elements.** Thumbnails decode on their own `<video>`, one per
 *    file, never on a clip's playback element. A seek here cannot move a frame
 *    on the stage or confuse the conductor.
 *  - **The background lane.** Every request arrives through the poster store's
 *    permits (`core/runtime/background.ts`): one at a time, paused while the
 *    transport runs or the person is interacting, and only for tiles that are
 *    on screen (the plan is windowed). A seek is decoder work, off the main
 *    thread; the only main-thread cost is the downscale copy.
 *  - **Bounded.** At most `MAX_ELEMENTS` files hold a decoder; the least
 *    recently used one gives its element back (src cleared, `load()`), which
 *    is what actually frees a media pipeline in every engine.
 *
 * Seeks on one element are SERIAL (an element is at one time), and a seek that
 * never lands resolves after a grace period with nothing rather than hanging
 * the queue behind it.
 */

const MAX_ELEMENTS = 2;
const LOAD_TIMEOUT_MS = 15_000;
const SEEK_TIMEOUT_MS = 4_000;

interface Decoder {
  el: HTMLVideoElement;
  ready: Promise<boolean>;
  /** The tail of this element's seek chain — seeks never overlap. */
  chain: Promise<unknown>;
  lastUse: number;
}

const decoders = new Map<string, Decoder>();
let clock = 0;

function release(assetId: string): void {
  const d = decoders.get(assetId);
  if (!d) return;
  decoders.delete(assetId);
  d.el.removeAttribute("src");
  d.el.load();
}

function decoderFor(assetId: string, mime: string | undefined): Decoder {
  const hit = decoders.get(assetId);
  if (hit) {
    hit.lastUse = ++clock;
    return hit;
  }
  while (decoders.size >= MAX_ELEMENTS) {
    let victim: string | null = null;
    let oldest = Infinity;
    for (const [id, d] of decoders) if (d.lastUse < oldest) (oldest = d.lastUse), (victim = id);
    if (!victim) break;
    release(victim);
  }
  const el = document.createElement("video");
  el.muted = true;
  el.playsInline = true;
  el.preload = "auto";
  el.crossOrigin = "anonymous";
  const ready = (async () => {
    const url = await assetObjectURL(assetId, mime);
    if (!url) return false;
    el.src = url;
    return new Promise<boolean>((resolve) => {
      const to = setTimeout(() => resolve(false), LOAD_TIMEOUT_MS);
      el.onloadeddata = () => {
        clearTimeout(to);
        resolve(true);
      };
      el.onerror = () => {
        clearTimeout(to);
        resolve(false);
      };
    });
  })();
  const d: Decoder = { el, ready, chain: ready, lastUse: ++clock };
  decoders.set(assetId, d);
  return d;
}

function seek(el: HTMLVideoElement, sec: number): Promise<boolean> {
  return new Promise((resolve) => {
    const target = Math.max(0, Math.min(sec, Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.001) : sec));
    if (Math.abs(el.currentTime - target) < 1e-3 && el.readyState >= 2) return resolve(true);
    const finish = (ok: boolean) => {
      el.removeEventListener("seeked", onSeeked);
      clearTimeout(to);
      resolve(ok);
    };
    const onSeeked = () => finish(true);
    const to = setTimeout(() => finish(false), SEEK_TIMEOUT_MS);
    el.addEventListener("seeked", onSeeked);
    el.currentTime = target;
  });
}

/**
 * One frame of a video file at `sourceMs`, downscaled into `box`, or null when
 * the file cannot be decoded here. Never touches the stage's elements.
 */
export function videoThumbAt(
  assetId: string,
  mime: string | undefined,
  sourceMs: number,
  box: { width: number; height: number },
): Promise<ImageBitmap | null> {
  const d = decoderFor(assetId, mime);
  const job = d.chain.then(async () => {
    if (!(await d.ready)) return null;
    if (!decoders.has(assetId)) return null; // evicted while waiting
    if (!(await seek(d.el, sourceMs / 1000))) return null;
    return createImageBitmap(d.el, { resizeWidth: box.width, resizeHeight: box.height, resizeQuality: "medium" });
  });
  d.chain = job.catch(() => null);
  return job.catch(() => null);
}

/** A file was relinked or removed: give its decoder back. */
export function dropVideoThumbs(assetId: string): void {
  release(assetId);
}
