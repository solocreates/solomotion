"use client";

import { identity } from "@/editor/identity";
import { MediaError, entityRef, frameStillMs, isAnimatedImageMime, reportError } from "@solomotion/core";
import {
  clipSourcePhaseAt,
  clipSpeedCurve,
  isSequenceMime,
  loopSpanMs,
  sequenceFrameAt,
  sourceTimeAt,
  type ImageClip,
  speedAt,
  clipRenderLocalTime,
  clipNaturalSourceSpanMs,
  clipSourceTimeAt,
  frameContentDurationMs,
  type Clip,
  type Frame,
  type NestedClip,
  type MotionDocument,
  type VideoClip,
  frameClipEntries,
} from "@solomotion/core";
import { assetObjectURL, getAssetBlob, onAssetBytesChanged } from "../../assets/asset-store";
import { isSequenceBlob, openSequence, sequenceFrameBlob, type OpenSequence } from "../../assets/sequence-file";
import {
  dropSubjectCoverage,
  forgetClip,
  hasFrame,
  mediaCachingAllowed,
  mediaSubject,
  cacheSettings,
  playbackRegime,
  subscribeCacheStatus,
  registerCacheProducer,
  reportFrameCached as reportSubjectCached,
  reportFrameDropped as reportSubjectDropped,
  setClipCachePolicy,
} from "../../cache/cache-status";
import { BUDGET_SHARE, onCacheBudgetChange, shareOfBudget } from "../../cache/memory-budget";
import { renderCostMs } from "./render-budget";
import { notePlaybackEvent } from "../../cache/playback-log";

export { isAnimatedImageMime };

/** Coverage of this clip's FOOTAGE — the media subject, never the layer. */
const reportFrameCached = (clipId: string, sourceMs: number): void =>
  reportSubjectCached(mediaSubject(clipId), sourceMs);
const reportFrameDropped = (clipId: string, sourceMs: number): void =>
  reportSubjectDropped(mediaSubject(clipId), sourceMs);

/**
 * Media elements + the ONE video frame pipeline.
 *
 * Draw functions are PURE CONSUMERS: they blit whatever frame an element
 * currently holds and never touch element time. All time authority lives here:
 *
 *  - `syncVideoFrames(doc, frame, t, playing)` — the single walk that computes
 *    every visible video's source time (recursing nested comps with the same
 *    mapping the renderer uses) and conducts the elements: play + drift-correct
 *    while the transport runs, chained exact seeks while scrubbing.
 *  - `prepareVideoFramesForExport` — same walk, but AWAITS every seek, for
 *    frame-exact stepped exports.
 *  - `lockMediaForExport()` — while an export owns the elements, preview sync
 *    passes become no-ops so the two can't fight over currentTime (the classic
 *    "random frames in the export" bug).
 *
 * Seeks are CHAINED per element: while one is in flight, the newest target is
 * remembered and issued from the `seeked` handler. Scrubbing therefore shows
 * every completed seek in order instead of drawing whatever stale frame the
 * element happened to hold.
 *
 * On top of the elements sits a DECODED-FRAME CACHE (see the section below):
 * settled scrub frames are captured once into ImageBitmaps, draws read them
 * through `videoFrameForClip` (never a mid-seek element — no void flashes),
 * revisited frames paint instantly with zero decode work, and stepped exports
 * read the same cache so previewed frames are free in the render.
 *
 * Images are cached per asset. Videos are cached per CLIP — two clips can play
 * the same file at different times, and an element can only be at one time.
 */

// A new ceiling applies at once: each store evicts down to its share rather
// than waiting for whatever moment it next happens to store something.
onCacheBudgetChange(() => {
  evictProxies();
  evictFrameCache();
});

const readyListeners = new Set<(clipId: string | null) => void>();

/**
 * WHAT A CLIP SHOWS CHANGED — and nothing else fires this.
 *
 * It used to fire for everything the media layer did: a seek landing, a
 * background proxy being banked, a hydration from the proxy tier, an element
 * that was not even on screen settling. Every listener treated each one as
 * "the picture changed", so a playing video in the comp was a continuous
 * stream of stage invalidations, layer-cache flushes and timeline re-renders —
 * the caches were being told their pixels were wrong many times a second by
 * events that had not changed a single pixel anyone was looking at. That is
 * the whole of "the media cache interferes with everything above it".
 *
 * Now there are three channels, one per fact:
 *
 *  - `onMediaReady(clipId)` — the picture a clip is PAINTING changed: its
 *    conducted head landed somewhere new, it became drawable, its latch moved.
 *    `null` = an asset became drawable for everybody (an image decoded).
 *  - `onMediaBanked` — a frame was kept for LATER (coverage). No picture on
 *    screen changed; bars and filmstrips may redraw. Throttled.
 *  - `onMediaSourceChanged` — the BYTES behind an asset changed (relink). The
 *    one event that makes an exact picture stale.
 */
export function onMediaReady(cb: (clipId: string | null) => void): () => void {
  readyListeners.add(cb);
  return () => readyListeners.delete(cb);
}

function notifyReady(clipId: string | null = null) {
  for (const cb of readyListeners) cb(clipId);
}

const bankedListeners = new Set<() => void>();
let bankedTimer: number | null = null;
/** Coverage moved — a banked frame is available for later. At most 4×/s. */
export function onMediaBanked(cb: () => void): () => void {
  bankedListeners.add(cb);
  return () => bankedListeners.delete(cb);
}
function notifyBanked(): void {
  if (bankedTimer !== null || typeof window === "undefined") return;
  bankedTimer = window.setTimeout(() => {
    bankedTimer = null;
    for (const cb of bankedListeners) cb();
  }, 250);
}

const sourceListeners = new Set<() => void>();
/** The bytes behind an asset changed — every exact picture of it is stale. */
export function onMediaSourceChanged(cb: () => void): () => void {
  sourceListeners.add(cb);
  return () => sourceListeners.delete(cb);
}

// ── The fidelity ledger ─────────────────────────────────────────────────────

/**
 * WAS THE PICTURE JUST DRAWN THE PICTURE OF THE INSTANT THAT WAS ASKED FOR?
 *
 * Every cache above the media layer has to know, because every cache above it
 * keeps pixels keyed by an instant: a frame painted while a video was mid-seek,
 * or while a rolling element had drifted off the instant being drawn, is a
 * photograph of something moving. Kept, it replays forever as the jitter it
 * was taken with — which is exactly how footage came to play WORSE with the
 * cache on than off, and worse on each pass as more of those photographs piled
 * up.
 *
 * So the media layer — the only thing that knows — says so at the moment of
 * the draw, and a cache compares the counters before and after its own render:
 *
 *   TRANSIENT  the picture will change WITHOUT the instant changing: a seek in
 *              flight, a cold element, a soft proxy standing in for the sharp
 *              frame, a snapshot latch, an image still decoding. Never kept by
 *              anything.
 *   INEXACT    a real, stable picture — but of a nearby instant: a rolling
 *              element a frame or more off its target, or a paused one frozen
 *              where playback left it. Fine to keep while parked (it is what is
 *              on screen and will stay there); never kept into a range that
 *              will be replayed, because replaying it is the jump.
 *
 * Counters rather than flags because renders nest — a group renders its
 * members, glass renders its backdrop — and each level asks about exactly its
 * own window of the draw by comparing before with after.
 */
let transientFaults = 0;
let inexactFaults = 0;
/** Every footage picture handed to a draw — whether a render used footage at all. */
let footageDraws = 0;

export interface PictureFaults {
  transient: number;
  inexact: number;
  footage: number;
}

export function pictureFaults(): PictureFaults {
  return { transient: transientFaults, inexact: inexactFaults, footage: footageDraws };
}

/**
 * A KEPT PICTURE SAYS WHAT IT WAS MADE OF. A render that blits a cached layer,
 * backdrop or stack prefix draws no footage and faults nothing — so without
 * this, a picture kept while parked (footage frozen a frame off) became part of
 * an "exact" group or glass the moment it was served during playback, and glass
 * served from its backdrop shelf over live video did not count as made from
 * footage at all. Every cache read replays the fidelity of what it serves.
 */
export function replayPicture(exact: boolean, footage: boolean): void {
  if (footage) footageDraws++;
  if (!exact) inexactFaults++;
}

/**
 * A picture that WILL change without the instant changing — the 3D engine still
 * downloading, a model still parsing. Counted as transient so no cache keeps
 * the placeholder; `notifyPicturesChanged` asks everyone to redraw once the
 * real picture can be made.
 */
export function markTransientPicture(): void {
  transientFaults++;
}

/** Something every surface draws became drawable (the 3D engine, a model). */
export function notifyPicturesChanged(): void {
  notifyReady(null);
}

/**
 * Draw something that is NOT part of the picture being kept — the dimmed spill
 * outside the artboard — without it voting on that picture's fidelity. Its
 * footage is drawn live and may be mid-step; the comp inside the box is what a
 * cache keeps and what exact playback waits for.
 */
export function outsideFidelity(draw: () => void): void {
  const before = pictureFaults();
  try {
    draw();
  } finally {
    transientFaults = before.transient;
    inexactFaults = before.inexact;
    footageDraws = before.footage;
  }
}

/** Did the draw since `before` put any footage on the canvas? */
export function drewFootageSince(before: PictureFaults): boolean {
  return footageDraws !== before.footage;
}

/** Did the draw between two readings stay exact? `stableOnly` accepts inexact. */
export function faithfulSince(before: PictureFaults, stableOnly = false): boolean {
  if (transientFaults !== before.transient) return false;
  return stableOnly || inexactFaults === before.inexact;
}

/**
 * Is any video ON SCREEN rolling right now? A composite read from the cache
 * next to one read live from a rolling element differ by where that element's
 * own clock has got to — so playback over live footage reads the cache in RUNS
 * (see `cachedRunAhead`), and needs to know when that applies.
 */
export function rollingVideoOnScreen(): boolean {
  // Exact playback steps its elements frame by frame; nothing is live.
  if (playbackRegime() === "exact") return false;
  for (const entry of videos.values()) {
    if (entry.conductPass !== conductPassId) continue;
    if (elementStateOf(entry) === "rolling") return true;
  }
  return false;
}

/** Longest the transport waits for footage to start presenting. */
const PREROLL_MAX_MS = 500;

/**
 * PRE-ROLL: is footage on screen asked to play but not presenting yet?
 *
 * `play()` takes a beat to become frames. The transport clock started at once,
 * so the video began behind the playhead and, about a second in, the drift
 * correction seeked it forward — the hitch on every play started on a clip
 * (starting before the clip hid it: the element was already running). The
 * transport holds its clock while this is true, bounded, like any player's
 * pre-roll.
 */
export function videoStarting(): boolean {
  const now = performance.now();
  for (const entry of videos.values()) {
    if (entry.conductPass !== conductPassId || entry.startingSince === null) continue;
    if (now - entry.startingSince < PREROLL_MAX_MS) return true;
  }
  return false;
}

/**
 * Is any video ON SCREEN still chasing the frame it was asked for?
 *
 * ON SCREEN is the load-bearing word: a clip that was not conducted this tick
 * would otherwise hold the answer at `true` forever, and everything waiting on
 * this would wait its full timeout on every frame. `seeking` is asked of the
 * element as well as of our own chain, because the two can disagree: our
 * bookkeeping clears when we issue the last target, and the decoder is still
 * landing it.
 */
export function mediaSeeksPending(): boolean {
  for (const entry of videos.values()) {
    if (entry.conductPass !== conductPassId) continue;
    if (!entry.ready) return true;
    if (entry.pendingSeekSec !== null) return true;
    if (entry.el.seeking) return true;
  }
  return false;
}

// ── Export exclusivity ───────────────────────────────────────────────────────

let mediaLocked = false;

/** Take exclusive ownership of media element time (stepped exports). */
export function lockMediaForExport(): () => void {
  mediaLocked = true;
  // Forget where preview scrubbing left each element, so the first exported
  // frame always issues a REAL seek instead of trusting a stale currentTime.
  for (const entry of videos.values()) {
    entry.lastRequestedSec = null;
    entry.pendingSeekSec = null;
    setLatch(entry, null); // stale preview latches must never paint into a render
    leaveRing(entry); // …nor playback's frames
  }
  return () => {
    // Hand every element back to preview in a clean state: paused, with the
    // seek bookkeeping cleared so the next scrub issues a REAL seek instead of
    // trusting wherever the export left the head.
    for (const entry of videos.values()) {
      entry.el.pause();
      entry.lastRequestedSec = null;
      entry.pendingSeekSec = null;
    }
    mediaLocked = false;
    notifyReady();
  };
}

// ── Images ───────────────────────────────────────────────────────────────────

const images = new Map<string, HTMLImageElement | "loading" | "error">();
/** In-flight image decodes — the awaitable seam behind both the sync getter
 * (draw path) and `prepareImagesForExport` (a render must never capture a
 * half-decoded picture). */
const imageDecodes = new Map<string, Promise<void>>();

/** Start (once) an image asset's decode; resolves when it's drawable OR failed.
 * Idempotent — concurrent callers share the one in-flight promise. */
function kickImage(assetId: string, mime?: string): Promise<void> {
  const inflight = imageDecodes.get(assetId);
  if (inflight) return inflight;
  const hit = images.get(assetId);
  if (hit instanceof HTMLImageElement || hit === "error") return Promise.resolve();
  images.set(assetId, "loading");
  const job = (async () => {
    const url = await assetObjectURL(assetId, mime);
    if (!url) {
      images.set(assetId, "error");
      return;
    }
    await new Promise<void>((resolve) => {
      const img = new Image();
      img.onload = () => {
        images.set(assetId, img);
        notifyReady();
        resolve();
      };
      img.onerror = () => {
        images.set(assetId, "error");
        resolve();
      };
      img.src = url;
    });
  })().finally(() => imageDecodes.delete(assetId));
  imageDecodes.set(assetId, job);
  return job;
}

export function getImageForAsset(assetId: string, mime?: string): HTMLImageElement | null {
  const hit = images.get(assetId);
  if (hit instanceof HTMLImageElement) return hit;
  if (hit === "error") return null;
  if (hit !== "loading") void kickImage(assetId, mime);
  // Drawn as nothing now, drawn as the image in a moment: not a picture to keep.
  transientFaults++;
  return null;
}

/** Every still-image asset the document references (animated ones warm through
 * `prepareAnimatedImagesForExport` instead). */
function stillImageAssets(doc: MotionDocument) {
  return doc.assets.filter((a) => a.kind === "image" && !isAnimatedImageMime(a.mime, a.name));
}

/** Fire every still image's decode without waiting — warms a freshly opened
 * project so the first playback of any clip paints its picture, never a blank
 * flash that self-heals only on the second pass. */
export function warmImages(doc: MotionDocument): void {
  for (const a of stillImageAssets(doc)) void kickImage(a.id, a.mime);
}

/** Kick + AWAIT every still image — the export counterpart of the video/audio
 * prepares, so a stepped render never bakes in a first-appearance blank flash. */
export async function prepareImagesForExport(doc: MotionDocument): Promise<void> {
  await Promise.all(stillImageAssets(doc).map((a) => kickImage(a.id, a.mime)));
}

/**
 * Drop ALL cached state for an asset so the next draw reloads it — run by the
 * blob store whenever an asset's bytes are written or deleted (a relink, a
 * restore under the same id). The source changed, so video elements rebuild
 * and every cached frame (+ its status coverage) is invalidated: this is THE
 * source-change trigger; everything else (moves, trims, retimes) keeps its
 * cache because source-time keying makes it position-independent. An asset
 * this cache never drew (a fresh import, a drawing's pixels saving) is left
 * alone, so a write does not cost a repaint.
 */
function invalidateMediaAsset(assetId: string): void {
  const held =
    images.has(assetId) ||
    imageDecodes.has(assetId) ||
    animatedImages.has(assetId) ||
    animatedDecodes.has(assetId) ||
    [...videos.values()].some((v) => v.assetId === assetId);
  if (!held) return;
  images.delete(assetId);
  imageDecodes.delete(assetId);
  animatedImages.delete(assetId);
  animatedDecodes.delete(assetId);
  for (const [clipId, entry] of videos) {
    if (entry.assetId !== assetId) continue;
    dropClipFrames(clipId);
    entry.el.pause();
    entry.el.src = "";
    entry.el.remove();
    videos.delete(clipId);
  }
  for (const cb of sourceListeners) cb();
  notifyReady();
}
onAssetBytesChanged(invalidateMediaAsset);

/**
 * LET GO OF EVERY PICTURE NO DOCUMENT ON SCREEN USES — decoded stills, every
 * frame of a decoded GIF, a sequence's frames, the video elements and their
 * frames. None of these sit under the memory budget (they are the sources the
 * budgeted caches are made from), so nothing else ever freed them: a project
 * closed, or a card hovered on Home, kept its media decoded for the session.
 *
 * Called whenever the documents on screen change (`document-release`). A
 * released picture is decoded again on its next draw, as on first open.
 */
export function releaseMediaNotIn(docs: readonly MotionDocument[]): void {
  const assets = new Set<string>();
  const clips = new Set<string>();
  for (const doc of docs) {
    for (const a of doc.assets) assets.add(a.id);
    for (const t of doc.tracks) for (const c of t.clips) clips.add(c.id);
  }
  for (const id of [...images.keys()]) {
    if (assets.has(id)) continue;
    images.delete(id);
    imageDecodes.delete(id);
  }
  for (const [id, entry] of [...animatedImages]) {
    if (assets.has(id) || entry === "loading") continue;
    if (typeof entry === "object" && "frames" in entry) for (const f of entry.frames) f.bitmap.close();
    dropSequence(id);
  }
  pruneVideoElements(clips);
}

// ── Animated images (GIF / animated WebP / APNG) ────────────────────────────
//
// Decoded ONCE per asset into a bitmap-per-frame table via WebCodecs'
// ImageDecoder; draws pick the frame for a loop-local time. Where the API is
// missing (older Safari) the asset simply stays a still image.

interface AnimatedImageFrame {
  bitmap: ImageBitmap;
  /** Frame start within the loop (ms). */
  startMs: number;
}

interface AnimatedImageEntry {
  frames: AnimatedImageFrame[];
  totalMs: number;
}

/**
 * An IMAGE SEQUENCE's entry. Unlike a GIF it is never decoded whole — a
 * sequence can be thousands of frames — so it holds the opened file and
 * decodes frames on demand into the shared, bounded `sequenceFrames` cache.
 */
interface SequenceEntry {
  seq: OpenSequence;
  count: number;
}

const animatedImages = new Map<string, AnimatedImageEntry | SequenceEntry | "loading" | "static" | "error">();
const animatedDecodes = new Map<string, Promise<void>>();


function kickAnimatedDecode(assetId: string): void {
  if (animatedImages.has(assetId)) return;
  animatedImages.set(assetId, "loading");
  const job = decodeAnimatedImage(assetId).finally(() => animatedDecodes.delete(assetId));
  animatedDecodes.set(assetId, job);
}

async function decodeAnimatedImage(assetId: string): Promise<void> {
  try {
    const decoderConstructor = (globalThis as any).ImageDecoder;
    const blob = await getAssetBlob(assetId);
    if (!blob) {
      animatedImages.set(assetId, "error");
      return;
    }
    if (await isSequenceBlob(blob)) {
      const seq = await openSequence(blob);
      animatedImages.set(assetId, { seq, count: seq.header.frames.length });
      notifyReady();
      return;
    }
    if (typeof decoderConstructor === "undefined") {
      animatedImages.set(assetId, "static");
      return;
    }
    const decoder = new decoderConstructor({ data: await blob.arrayBuffer(), type: blob.type || "image/gif" });
    try {
      /*
       * BOTH promises get a handler before either is awaited, and that is not
       * belt-and-braces — it is the whole bug.
       *
       * `tracks.ready` and `completed` settle INDEPENDENTLY, and a file this
       * decoder cannot parse rejects both. Awaiting them in sequence leaves the
       * second one rejecting with nothing attached, and an unhandled rejection
       * does not go to the `catch` below — it goes to the WINDOW. That is the
       * "EncodingError: Metadata decoding failed" overlay people hit importing
       * an image: the failure was always handled, and the app crashed anyway
       * over the duplicate nobody was listening to.
       *
       * Attaching a no-op handler does not consume the rejection — the awaits
       * below still throw into the `catch` exactly as before.
       */
      const ready = decoder.tracks.ready as Promise<void>;
      const completed = decoder.completed as Promise<void>;
      ready.catch(() => {});
      completed.catch(() => {});
      await ready;
      await completed;
      const track = decoder.tracks.selectedTrack;
      if (!track || track.frameCount <= 1) {
        animatedImages.set(assetId, "static");
        return;
      }
      const frames: AnimatedImageFrame[] = [];
      let t = 0;
      for (let i = 0; i < track.frameCount; i++) {
        const { image } = await decoder.decode({ frameIndex: i });
        // VideoFrame duration is µs; browsers clamp tiny GIF delays to ~100ms.
        const durMs = Math.max(10, (image.duration ?? 100_000) / 1000 || 100);
        const bitmap = await createImageBitmap(image);
        image.close();
        frames.push({ bitmap, startMs: t });
        t += durMs;
      }
      animatedImages.set(assetId, { frames, totalMs: Math.max(1, t) });
      notifyReady();
    } finally {
      // Was only closed on the two success paths, so every failure leaked the
      // decoder and the frame buffer behind it.
      decoder.close();
    }
  } catch (err) {
    animatedImages.set(assetId, "error");
    /*
     * Recorded, not announced. This path runs for anything that LOOKS animated
     * by mime, and a still WebP failing to produce an animation is ordinary —
     * the caller falls straight back to the plain image decode and the person
     * sees their picture. Toasting here would cry wolf on a working import.
     * But it still belongs in the Console and the bug report, because when the
     * fallback ALSO fails this line is the one that says why.
     */
    reportError(
      new MediaError({
        code: "media/animated-decode-failed",
        message: `Could not read asset ${assetId} as an animated image`,
        userMessage: "That image couldn’t be read as an animation.",
        severity: "warning",
        announce: false,
        context: { assetId },
        subject: entityRef("media", assetId),
        cause: err,
      }),
    );
  }
}

/**
 * The animation frame for a loop-local time — null while decoding or when the
 * asset is a plain still (callers fall back to the static image path). Wraps
 * `timeMs` over the asset's OWN natural duration — for a clip with a custom
 * `loopLengthMs` override, use `animatedImageFrameAtRaw` instead (the wrap
 * already happened upstream, via `sourceTimeAt`).
 */
export function animatedImageFrameAt(assetId: string, timeMs: number): ImageBitmap | null {
  const hit = animatedImages.get(assetId);
  if (hit === undefined || hit === "loading") {
    if (hit === undefined) kickAnimatedDecode(assetId);
    transientFaults++; // the still stands in until the frames decode
    return null;
  }
  if (typeof hit === "string") return null;
  const total = "seq" in hit ? (hit.count / hit.seq.header.fps) * 1000 : hit.totalMs;
  const t = ((timeMs % total) + total) % total;
  return animatedImageFrameAtRaw(assetId, t);
}

/**
 * The animation frame for an ALREADY-WRAPPED source time (no modulo here) —
 * holds on the last frame for any `sourceMs` past the asset's own duration,
 * which is exactly right when a clip's loop cycle is pinned longer than the
 * natural animation.
 */
export function animatedImageFrameAtRaw(assetId: string, sourceMs: number): ImageBitmap | null {
  const hit = animatedImages.get(assetId);
  if (hit === undefined || hit === "loading") {
    if (hit === undefined) kickAnimatedDecode(assetId);
    transientFaults++;
    return null;
  }
  if (typeof hit === "string") return null;
  if ("seq" in hit) {
    return sequencePicture(assetId, sequenceFrameAt(sourceMs, hit.seq.header.fps, hit.count), null);
  }
  const t = Math.max(0, sourceMs);
  let frame = hit.frames[0]!;
  for (const f of hit.frames) {
    if (f.startMs > t) break;
    frame = f;
  }
  return frame.bitmap;
}

/**
 * Mean ms per animation frame, or null while decoding / for a still.
 *
 * The poster grid wants one number, and a GIF's delays are per-frame. The mean
 * is right for the overwhelmingly common uniform-delay file and merely
 * imprecise for the rest: an unevenly-timed frame can be sampled twice, which
 * costs one duplicate cache entry and shows the correct picture both times —
 * `animatedImageFrameAtRaw` floors to the containing frame either way, so a
 * poster can never show a frame the renderer would not.
 */
export function animatedImageStepMs(assetId: string): number | null {
  const hit = animatedImages.get(assetId);
  if (!hit || typeof hit === "string") return null;
  if ("seq" in hit) return 1000 / hit.seq.header.fps;
  if (hit.frames.length === 0) return null;
  return hit.totalMs / hit.frames.length;
}

/** The decoded animation's natural total duration, or null while decoding /
 * for a static image / before decode has been kicked off. */
export function animatedImageDurationMs(assetId: string): number | null {
  const hit = animatedImages.get(assetId);
  if (!hit || typeof hit === "string") return null;
  return "seq" in hit ? (hit.count / hit.seq.header.fps) * 1000 : hit.totalMs;
}

/** Kick + await every animated decode (frame-exact exports). */
export async function prepareAnimatedImagesForExport(doc: MotionDocument): Promise<void> {
  for (const a of doc.assets) {
    if (a.kind === "image" && isAnimatedImageMime(a.mime, a.name)) kickAnimatedDecode(a.id);
  }
  await Promise.all([...animatedDecodes.values()]);
}

// ── Image sequences: frames on demand ───────────────────────────────────────
//
// Decoded frames, oldest first (a Map iterates in insertion order), bounded by
// bytes, shared by every sequence. Drawing reads ahead so playback finds its
// frames waiting; an export awaits the exact one.

const sequenceFrames = new Map<string, ImageBitmap>();
const sequenceDecodes = new Map<string, Promise<void>>();
let sequenceBytes = 0;
const SEQUENCE_BUDGET_BYTES = 384 * 1024 * 1024;
const SEQUENCE_READ_AHEAD = 8;
const frameKey = (assetId: string, i: number) => `${assetId}#${i}`;

/**
 * Frame `index` of a sequence, or the nearest earlier frame already decoded
 * while it arrives — a sequence HOLDS rather than blinking back to its poster.
 * Null only before anything is decoded. `clipId` is told when the frame lands.
 */
export function sequencePicture(assetId: string, index: number, clipId: string | null): ImageBitmap | null {
  const hit = animatedImages.get(assetId);
  if (hit === undefined) kickAnimatedDecode(assetId);
  if (!hit || typeof hit === "string" || !("seq" in hit)) {
    transientFaults++;
    return null;
  }
  for (let k = 1; k <= SEQUENCE_READ_AHEAD && index + k < hit.count; k++) void decodeSequenceFrame(assetId, hit, index + k, null);
  const exact = sequenceFrames.get(frameKey(assetId, index));
  if (exact) {
    sequenceFrames.delete(frameKey(assetId, index));
    sequenceFrames.set(frameKey(assetId, index), exact);
    return exact;
  }
  void decodeSequenceFrame(assetId, hit, index, clipId);
  transientFaults++;
  for (let i = index - 1; i >= Math.max(0, index - SEQUENCE_READ_AHEAD * 4); i--) {
    const held = sequenceFrames.get(frameKey(assetId, i));
    if (held) return held;
  }
  return null;
}

/** An export's wait: resolves once frame `index` is decoded (or unreadable). */
export async function awaitSequenceFrame(assetId: string, index: number): Promise<void> {
  if (!animatedImages.has(assetId)) kickAnimatedDecode(assetId);
  await animatedDecodes.get(assetId);
  const hit = animatedImages.get(assetId);
  if (!hit || typeof hit === "string" || !("seq" in hit)) return;
  await decodeSequenceFrame(assetId, hit, Math.min(index, hit.count - 1), null);
}

function decodeSequenceFrame(assetId: string, entry: SequenceEntry, i: number, clipId: string | null): Promise<void> {
  const key = frameKey(assetId, i);
  if (sequenceFrames.has(key)) return Promise.resolve();
  const pending = sequenceDecodes.get(key);
  if (pending) return pending;
  const job = createImageBitmap(sequenceFrameBlob(entry.seq, i))
    .then((bmp) => {
      if (animatedImages.get(assetId) !== entry) {
        bmp.close(); // the asset was dropped or replaced while decoding
        return;
      }
      sequenceFrames.set(key, bmp);
      sequenceBytes += bmp.width * bmp.height * 4;
      for (const [old, b] of sequenceFrames) {
        if (sequenceBytes <= SEQUENCE_BUDGET_BYTES || old === key) break;
        sequenceBytes -= b.width * b.height * 4;
        b.close();
        sequenceFrames.delete(old);
      }
      if (clipId) notifyReady(clipId);
    })
    .catch(() => undefined) // an unreadable frame stays undrawn; neighbours hold
    .finally(() => sequenceDecodes.delete(key));
  sequenceDecodes.set(key, job);
  return job;
}

/**
 * WHICH FRAME AN IMAGE CLIP SHOWS, when its asset is a sequence — the ONE
 * answer the renderer draws and an export waits for. The asset's own `fps` is
 * the sequence's rate (editable, so the document is the authority), and the
 * clip's trim / speed / loop / reverse map time onto it exactly as they do for
 * video.
 */
export function sequenceFrameForClip(doc: MotionDocument, clip: ImageClip, localMs: number): number | null {
  const asset = doc.assets.find((a) => a.id === clip.assetId);
  if (!asset || !isSequenceMime(asset.mime) || !asset.fps || !asset.durationMs) return null;
  const count = Math.max(1, Math.round((asset.durationMs * asset.fps) / 1000));
  const playback = clip.playback ?? { speed: 1, loop: "none" as const, reverse: false, loopLengthMs: null };
  const span = Math.max(1, asset.durationMs - clip.trimInMs);
  // Through the clip's speed curve, like every other source-backed clip: a
  // ramp or a freeze on a sequence reads its frames at the ramped rate.
  const curve = clipSpeedCurve(clip);
  const srcMs = clip.trimInMs + sourceTimeAt(localMs, loopSpanMs(playback, span, curve), playback, curve);
  return sequenceFrameAt(srcMs, asset.fps, count);
}

/** Forget a sequence whose bytes changed or went away. */
export function dropSequence(assetId: string): void {
  animatedImages.delete(assetId);
  for (const [k, b] of sequenceFrames) {
    if (!k.startsWith(`${assetId}#`)) continue;
    sequenceBytes -= b.width * b.height * 4;
    b.close();
    sequenceFrames.delete(k);
  }
}

// ── Videos (per clip) ────────────────────────────────────────────────────────

interface VideoEntry {
  /**
   * THE FRAME THE ELEMENT IS SHOWING, by its own timestamp (rVFC `mediaTime`)
   * — rolling, stepped or landed. Null until the first presentation, and
   * where rVFC does not exist. `currentTime` is the playback CLOCK, not the
   * picture: a rolling element's clock runs between frames, and a paused one
   * can sit anywhere inside its frame. Exactness is asked of this.
   */
  shownSec: number | null;
  /**
   * The shortest gap seen between two consecutive presented frames — the
   * source's frame duration. Starts small (strict), so an unknown rate can only
   * make a frame look NOT yet exact (costing a step), never falsely exact.
   */
  frameSec: number;
  /** The target the last landed seek was aimed at: the decoder's own answer to
   *  "which frame is this instant", so it is exact by definition. */
  landedFor: number | null;
  /** Exact playback: stepping forward to this target, pausing on its frame. */
  stepTo: number | null;
  /**
   * EXACT PLAYBACK'S FRAMES, ascending: every frame the element presents while
   * exact playback runs, captured inside its own presentation callback and
   * labelled with its own timestamp — so a picture here IS the frame it says
   * it is, whatever the element does next. The decoder runs one instant ahead
   * into this ring while the canvas still shows the current one.
   */
  exactFrames: ExactFrame[];
  /** The ring is fed from this element's presentations (stepping or back-filling). */
  capturing: boolean;
  /**
   * BACKWARD DECODE in flight: the element plays FORWARD over this stretch of
   * source, every presented frame landing in the ring, so the display can walk
   * it backwards. Codecs only decode forward; every NLE reverses this way.
   */
  backFill: { from: number; to: number } | null;
  /** The ring frame last handed to a draw — held while nothing better is decoded yet. */
  ringShown: ExactFrame | null;
  /** play() was called and the element has not reported `playing` yet. */
  startingSince: number | null;
  clipId: string;
  assetId: string;
  el: HTMLVideoElement;
  ready: boolean;
  /** Last seek target this pipeline issued (currentTime lies while seeking). */
  lastRequestedSec: number | null;
  /** Newest target that arrived while a seek was in flight — issued on `seeked`. */
  pendingSeekSec: number | null;
  /** EMA of how long this element's seeks take to land (wall-clock sec).
   * Playback resyncs LEAD their target by this much, so the frame that finally
   * arrives is the frame the timeline has reached by then — without the lead,
   * every resync lands already-stale and triggers the next one (seek storm). */
  seekLatencySec: number;
  /** performance.now() when the in-flight seek was issued (latency sample). */
  seekIssuedAt: number | null;
  /** performance.now() when the last seek landed — resync cooldown, so a
   * slow-to-converge sync can't degenerate into back-to-back seeks. */
  seekDoneAt: number;
  /** Previous conducted target (sec) — a backwards jump while the element sits
   * in `ended` is THE loop-wrap signal, whatever the trim window. */
  lastTargetSec: number | null;
  /** A BACKGROUND JOB owns this element's head: it is parked wherever the job
   * put it, not on the playhead ("Cache clip now" is the only such job).
   *
   * Sticky for the WHOLE job, never one seek in flight — the gap between two
   * background seeks is exactly where the element sits `paused && ready` and
   * looks, to anything reading it naively, like a settled picture of the
   * playhead. It is not; it is a picture of somewhere else in the file.
   *
   * Set and cleared by the job itself (one owner). While it is true:
   * `headIsConducted` is false, so draws read the latch, the conductor stands
   * off, and NOTHING the element lands on may become the latch. */
  borrowed: boolean;
  /** Last playbackRate write (drift nudge) — rate writes jerk the decoder
   * pipeline, so they're damped to one every RATE_WRITE_MIN_MS at most. */
  rateWroteAt: number;
  /** Rolling proxy capture loop is attached (rVFC while playing). */
  rollingCapture: boolean;
  /** Last source cell the rolling capture covered — holes between consecutive
   * presented frames are range-filled so coverage is contiguous at any fps. */
  proxyPrevCell: number | null;
  /** A proxy encode is in flight — presented frames meanwhile are skipped
   * (natural pacing; the range-fill covers what was skipped). */
  proxyEncoding: boolean;
  /** The element is rolling FORWARD as a reverse-fill decoder (codecs can't
   * step backward) — draws must read the latch, never this element. */
  fillRolling: boolean;
  /** Conduct pass this entry was already conducted in — the same inner clip
   * can be reachable through several visible frames (parent mapping, the
   * comp's own frame, two instances); only the FIRST conduct per tick wins,
   * or the mappings fight over one element forever. */
  conductPass: number;
  /** The cached frame this clip is currently showing (the "latch") — draws
   * prefer it whenever it covers the wanted source time. */
  lastFrame: CachedVideoFrame | null;
}

interface ExactFrame {
  /** The frame's own timestamp (rVFC `mediaTime`). */
  sec: number;
  /** Null while its bitmap resolves. */
  bitmap: ImageBitmap | null;
  /** When the capture was asked for — one that never resolves is let go. */
  at: number;
}

/** A capture still unresolved after this is abandoned (the element moved on). */
const CAPTURE_EXPIRE_MS = 400;

const videos = new Map<string, VideoEntry>();

// ── Decoded-frame cache ──────────────────────────────────────────────────────
//
// Scrubbing pays an H.264 keyframe-relative re-decode for EVERY seek, and a
// mid-seek element can paint blank or stale pictures. So each SETTLED scrub
// frame is captured once into an ImageBitmap and kept in a byte-budgeted LRU:
//
//  - Draws go through `videoFrameForClip`: a matching bitmap paints instantly
//    (zero decode on revisits) and while a seek is in flight the last good
//    picture stays up — no void frames, no raw seeking-element flashes.
//  - Stepped exports READ the same cache before touching the element, so
//    frames decoded while previewing are free in the render. Exports don't
//    WRITE it: a sequential full-length render pushed through a small LRU
//    would just thrash out the scrub frames that actually get revisited.
//  - Smooth playback doesn't write it either — capturing ~60 bitmaps/sec of
//    ~8 MB each is pure churn while a rolling element is already the freshest
//    possible source. Captures happen only when a scrub seek SETTLES.
//
// Correctness rule: preview frames are keyed by SOURCE-FRAME CELL — a fixed
// per-clip 30fps grid over source time. ONE pass over a cell caches it
// forever (until the source itself changes): every consumer (conduct, scrub,
// status bars) quantizes with the same floor, so coverage is contiguous,
// stable, and independent of playhead phase — the exact opposite
// of keying by "whatever millisecond happened to be requested", which made
// coverage spotty confetti that moved with the playhead. Preview may serve a
// neighbor within a cell (≤1 source frame — invisible); EXPORT never reads
// this cache and always seeks exactly.

/** The preview cache's frame grid (source-time cells). */
const PREVIEW_CELL_SEC = 1 / 30;

/** The cell a source time falls in — THE one quantization every consumer uses. */
function cellOf(sourceSec: number): number {
  // 1e-4 of a cell (≈3µs): comp instants arrive as thirds of a millisecond,
  // and 1.6666…s / (1/30)s came out at 49.99999… — the frame before.
  return Math.floor(sourceSec / PREVIEW_CELL_SEC + 1e-4);
}

interface CachedVideoFrame {
  clipId: string;
  bitmap: ImageBitmap;
  /** Source-frame cell this bitmap covers (-1 = latch-only snapshot). */
  cell: number;
  bytes: number;
  lastUse: number;
  /** Latch-only snapshot (grabbed off a rolling element before a disruptive
   * seek) — never in the LRU, serves no exact target, freed on replacement. */
  transient?: boolean;
  /** Captured below source resolution (preview budget) — exports skip these. */
  scaled?: boolean;
}

const frameCache: CachedVideoFrame[] = [];
let frameCacheBytes = 0;
let frameCacheTick = 0;
/** Memory ceiling for cached frames (RGBA estimate). Sources wider than
 * CAPTURE_MAX_WIDTH cache downscaled (preview-only — exports skip them), so
 * the budget stretches to several seconds of look-ahead per clip. */
/** This store's share of the ONE ceiling — see `cache/memory-budget.ts`. */
const FRAME_CACHE_MAX_BYTES = () => shareOfBudget(BUDGET_SHARE.mediaDecoded);
const FRAME_CACHE_MAX_FRAMES = 512;
const CAPTURE_MAX_WIDTH = 1280;

function servesTarget(f: CachedVideoFrame, targetSec: number): boolean {
  return f.cell >= 0 && f.cell === cellOf(targetSec);
}

/** The cached frame for a requested target time, if any (touches LRU recency).
 * `fullResOnly` skips preview-downscaled captures — the export path must never
 * ship a soft frame. */
function frameCacheLookup(clipId: string, targetSec: number, fullResOnly = false): CachedVideoFrame | null {
  for (const f of frameCache) {
    if (f.clipId !== clipId) continue;
    if (fullResOnly && f.scaled) continue;
    if (servesTarget(f, targetSec)) {
      f.lastUse = ++frameCacheTick;
      return f;
    }
  }
  return null;
}

function frameCacheStore(
  entry: VideoEntry,
  bitmap: ImageBitmap,
  requestedSec: number,
  scaled: boolean,
): CachedVideoFrame {
  const cell = cellOf(requestedSec);
  // A DOWNSCALED CAPTURE IS NOT KEPT. It never becomes the picture of a parked
  // stage (the settled element is sharper, and "a soft cell never downgrades a
  // sharp element"), and the in-between fallback is the proxy — so for large
  // footage every park and every chained landing was megabytes kept for
  // nothing. It becomes a proxy and a transient latch; only a SHARP capture,
  // which really does replace a seek on the next visit, enters the decoded tier.
  if (scaled) {
    encodeProxy(entry.clipId, [cell], bitmap);
    return {
      clipId: entry.clipId,
      bitmap,
      cell,
      bytes: bitmap.width * bitmap.height * 4,
      lastUse: ++frameCacheTick,
      transient: true,
      scaled: true,
    };
  }
  for (const f of frameCache) {
    if (f.clipId === entry.clipId && f.cell === cell) {
      if (f.scaled && !scaled) {
        // Upgrade in place: a sharp capture replaces a proxy-soft one.
        f.bitmap.close();
        frameCacheBytes += bitmap.width * bitmap.height * 4 - f.bytes;
        f.bitmap = bitmap;
        f.bytes = bitmap.width * bitmap.height * 4;
        f.scaled = false;
      } else {
        bitmap.close(); // this cell is already cached — load once, keep forever
      }
      f.lastUse = ++frameCacheTick;
      return f;
    }
  }
  const added: CachedVideoFrame = {
    clipId: entry.clipId,
    bitmap,
    cell,
    bytes: bitmap.width * bitmap.height * 4,
    lastUse: ++frameCacheTick,
    scaled,
  };
  frameCache.push(added);
  frameCacheBytes += added.bytes;
  reportFrameCached(entry.clipId, (cell + 0.5) * PREVIEW_CELL_SEC * 1000);
  // Every full capture also banks a proxy — the durable "seen once, green
  // forever" tier that outlives this LRU's eviction window.
  encodeProxy(entry.clipId, [cell], bitmap);
  evictFrameCache();
  return added;
}

/** Tell the status registry a frame left the LRU. */
function reportFrameGone(f: CachedVideoFrame): void {
  if (f.cell >= 0) reportFrameDropped(f.clipId, (f.cell + 0.5) * PREVIEW_CELL_SEC * 1000);
}

/**
 * A picture of an asset at a source time, IF one is already cached — the
 * read-only door the timeline's video posters come through.
 *
 * Strictly a lookup: it never seeks an element, never decodes, never warms
 * anything. Video is the one source whose pictures cost real time to make, so
 * the rule for its posters is "show what a playthrough already banked, and
 * otherwise show nothing" — a filmstrip is not worth a decode storm, and the
 * frames a user has actually watched are exactly the ones they want to
 * recognise on the timeline.
 *
 * The proxy tier is preferred over the full-res LRU on purpose: proxies are
 * ~480px, which is already larger than any poster tier, and they are the
 * durable "seen once, kept" layer, so posters survive the LRU's eviction
 * window. Coverage is keyed per CLIP (an element can only be at one time), so
 * this scans the clips on this asset — there are as many as there are video
 * clips, and a hit on any of them is a picture of the same file.
 */
export function cachedAssetPicture(
  assetId: string,
  sourceMs: number,
): { blob: Blob } | { bitmap: ImageBitmap } | null {
  const cell = cellOf(sourceMs / 1000);
  for (const entry of videos.values()) {
    if (entry.assetId !== assetId) continue;
    const blob = proxyGet(entry.clipId, cell);
    if (blob) return { blob };
  }
  for (const f of frameCache) {
    if (f.cell !== cell || f.transient) continue;
    const owner = videos.get(f.clipId);
    if (owner?.assetId === assetId) return { bitmap: f.bitmap };
  }
  return null;
}

// ── Proxy tier ───────────────────────────────────────────────────────────────
//
// Compressed proxy frames (~480px WebP/JPEG, ~15–25KB each) — the tier that
// makes "one play → the WHOLE footprint green, forever" affordable: minutes of
// video fit where raw bitmaps hold seconds. Every capture path writes it
// (rolling playback, scrub settles, reverse chains, the manual cache job), it
// reports into the same status registry (refcounted with tier 1), and paints
// hydrate from it instantly while the exact seek fetches the sharp frame
// behind them.
// Exports never touch proxies.

interface ProxyFrame {
  blob: Blob;
  lastUse: number;
}

const proxyFrames = new Map<string, ProxyFrame>(); // `${clipId}:${cell}`
let proxyBytes = 0;
/**
 * This store's share of the ONE ceiling.
 *
 * It was 256MB hardcoded, which is where a clip's bar started developing holes
 * at the beginning while the end was still filling: the LRU was dropping the
 * oldest source cells to stay under a limit nothing on screen mentioned, on a
 * machine with room to spare. See `cache/memory-budget.ts`.
 */
const PROXY_MAX_BYTES = () => shareOfBudget(BUDGET_SHARE.mediaProxy);
const PROXY_WIDTH = 480;

function proxyKey(clipId: string, cell: number): string {
  return `${clipId}:${cell}`;
}

function proxyGet(clipId: string, cell: number): Blob | null {
  const hit = proxyFrames.get(proxyKey(clipId, cell));
  if (!hit) return null;
  hit.lastUse = ++frameCacheTick;
  return hit.blob;
}

function proxyPut(clipId: string, cell: number, blob: Blob): void {
  const key = proxyKey(clipId, cell);
  if (proxyFrames.has(key)) return;
  proxyFrames.set(key, { blob, lastUse: ++frameCacheTick });
  proxyBytes += blob.size;
  reportFrameCached(clipId, (cell + 0.5) * PREVIEW_CELL_SEC * 1000);
  evictProxies();
}

/**
 * Least recently used proxies out until this store is inside its share of the
 * ONE ceiling.
 *
 * A NAMED function rather than a loop inlined in `proxyPut`, because eviction
 * has two callers: storing something, and the ceiling MOVING. Buried in the
 * writer, a store can only ever discover a smaller budget the next time it
 * happens to write — which on a paused editor is never.
 */
function evictProxies(): void {
  const limit = PROXY_MAX_BYTES();
  while (proxyBytes > limit && proxyFrames.size > 0) {
    let victimKey: string | null = null;
    let victimUse = Infinity;
    for (const [k, f] of proxyFrames) {
      if (f.lastUse < victimUse) {
        victimUse = f.lastUse;
        victimKey = k;
      }
    }
    if (!victimKey) break;
    const gone = proxyFrames.get(victimKey)!;
    proxyFrames.delete(victimKey);
    proxyBytes -= gone.blob.size;
    const sep = victimKey.lastIndexOf(":");
    reportFrameDropped(victimKey.slice(0, sep), (Number(victimKey.slice(sep + 1)) + 0.5) * PREVIEW_CELL_SEC * 1000);
  }
}

function proxyDropClip(clipId: string): void {
  const prefix = `${clipId}:`;
  for (const [k, f] of proxyFrames) {
    if (!k.startsWith(prefix)) continue;
    proxyFrames.delete(k);
    proxyBytes -= f.blob.size;
  }
}

/** Encode `source` down to a proxy blob and register it for `cells` (one
 * presented frame can span several 30fps cells at low-fps sources — sharing
 * the blob keeps coverage contiguous). Fire-and-forget; never throws. */
function encodeProxy(clipId: string, cells: number[], source: ImageBitmap | HTMLVideoElement): void {
  const todo = cells.filter((c) => c >= 0 && !proxyFrames.has(proxyKey(clipId, c)));
  if (todo.length === 0 || typeof OffscreenCanvas === "undefined") return;
  try {
    const sw = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    const sh = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
    if (sw === 0 || sh === 0) return;
    const w = Math.min(PROXY_WIDTH, sw);
    const h = Math.max(1, Math.round((sh / sw) * w));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(source, 0, 0, w, h);
    void canvas
      .convertToBlob({ type: "image/webp", quality: 0.72 })
      .catch(() => canvas.convertToBlob({ type: "image/jpeg", quality: 0.75 }))
      .then((blob) => {
        for (const c of todo) proxyPut(clipId, c, blob);
        // Kept for later. Nothing on screen changed — see `onMediaBanked`.
        notifyBanked();
      })
      .catch(() => undefined);
  } catch {
    // proxy is best-effort — a failed encode just stays red on the bar
  }
}

function evictFrameCache(): void {
  while (frameCacheBytes > FRAME_CACHE_MAX_BYTES() || frameCache.length > FRAME_CACHE_MAX_FRAMES) {
    // Never evict a latch — some clip is painting that bitmap right now.
    const latched = new Set<ImageBitmap>();
    for (const e of videos.values()) if (e.lastFrame) latched.add(e.lastFrame.bitmap);
    let victim = -1;
    for (let i = 0; i < frameCache.length; i++) {
      const f = frameCache[i]!;
      if (latched.has(f.bitmap)) continue;
      if (victim === -1 || f.lastUse < frameCache[victim]!.lastUse) victim = i;
    }
    if (victim === -1) return;
    const gone = frameCache.splice(victim, 1)[0]!;
    frameCacheBytes -= gone.bytes;
    reportFrameGone(gone);
    gone.bitmap.close();
  }
}

/** Drop (and free) every PERSISTENT cached frame + proxy + coverage for a clip,
 * and release its latch — the UI "clear this clip's cache" / set-to-never path.
 * Safe while the clip is on screen: `resolvePicture` falls back to the live
 * element (sharp), so nothing blanks. */
export function clearClipCache(clipId: string): void {
  dropClipFrames(clipId);
}

/** Drop (and free) every cached frame belonging to a clip. */
function dropClipFrames(clipId: string): void {
  const entry = videos.get(clipId);
  if (entry) setLatch(entry, null);
  for (let i = frameCache.length - 1; i >= 0; i--) {
    const f = frameCache[i]!;
    if (f.clipId !== clipId) continue;
    frameCache.splice(i, 1);
    frameCacheBytes -= f.bytes;
    f.bitmap.close();
  }
  proxyDropClip(clipId);
  dropSubjectCoverage(mediaSubject(clipId));
}

/** THE one way a latch changes hands — transient snapshots are freed the
 * moment something replaces them (LRU-owned frames are freed by eviction). */
function setLatch(entry: VideoEntry, frame: CachedVideoFrame | null): void {
  const prev = entry.lastFrame;
  if (prev && prev.transient && prev !== frame) prev.bitmap.close();
  entry.lastFrame = frame;
}

/** Snapshot the picture the element is showing RIGHT NOW into the latch —
 * called before any disruptive seek (pause correction, jump, reverse step),
 * so whatever paints while the seek flies is the frame the user was already
 * looking at, never an older one. Skipped if a settled (exact) capture lands
 * first. */
function snapshotLatch(entry: VideoEntry): Promise<void> {
  const el = entry.el;
  if (el.readyState < 2 || el.videoWidth === 0) return Promise.resolve();
  const before = entry.lastFrame;
  return createImageBitmap(el)
    .then((bitmap) => {
      if (entry.lastFrame !== before) {
        bitmap.close(); // something fresher (a settled capture) won the race
        return;
      }
      setLatch(entry, {
        clipId: entry.clipId,
        bitmap,
        cell: -1, // pure display snapshot — serves no cell
        bytes: bitmap.width * bitmap.height * 4,
        lastUse: ++frameCacheTick,
        transient: true,
      });
    })
    .catch(() => undefined);
}

/** Downscale big sources on capture — preview budget. Exports skip scaled
 * frames (frameCacheLookup fullResOnly), so quality never leaks into a render. */
function captureOptions(el: HTMLVideoElement): { opts: ImageBitmapOptions | undefined; scaled: boolean } {
  // By the LONG side. A portrait 1080×1920 source is under a width cap and was
  // kept at full size — 8MB a frame — for a picture that is at most a stage's
  // worth of pixels while scrubbing.
  const long = Math.max(el.videoWidth, el.videoHeight);
  if (long > CAPTURE_MAX_WIDTH) {
    const k = CAPTURE_MAX_WIDTH / long;
    return {
      opts: { resizeWidth: Math.round(el.videoWidth * k), resizeHeight: Math.round(el.videoHeight * k), resizeQuality: "medium" },
      scaled: true,
    };
  }
  return { opts: undefined, scaled: false };
}

/** Capture the picture a settled scrub seek landed on, keyed by the target
 * that was REQUESTED (that's what revisits will ask for again). rVFC hands us
 * the frame's true presentation timestamp (currentTime is the fallback where
 * the API is missing). Bails whenever a newer seek is already in flight — the
 * copy would be mislabelled. */
function captureSettledFrame(entry: VideoEntry, requestedSec: number): void {
  const el = entry.el;
  // Whether this landing may become the picture is NOT the caller's call — it
  // is one fact about the element, asked in one place. A background job's
  // landing banks its cell and nothing more.
  const latch = headIsConducted(entry);
  const store = mediaCachingAllowed(entry.clipId);
  if (!latch && !store) return; // nowhere for the copy to go
  // A RANGE BUILD KEEPS ITS PICTURES UPSTAIRS. The finished frame it is about
  // to store already holds this exact picture, so a full-size decoded copy
  // down here would be the same pixels twice — the one tier that made a built
  // range cost double. The settled element is what the build draws; the media
  // bar only needs the small proxy.
  if (exactRegime()) {
    if (store) {
      const rvfcB = (el as VideoWithRvfc).requestVideoFrameCallback;
      const bank = () => {
        if (!mediaLocked && !el.seeking && el.paused) encodeProxy(entry.clipId, [cellOf(requestedSec)], el);
      };
      if (typeof rvfcB === "function") rvfcB.call(el, bank);
      else bank();
    }
    return;
  }
  const grab = () => {
    if (mediaLocked || el.seeking || !el.paused) return;
    const { opts, scaled } = captureOptions(el);
    void (opts ? createImageBitmap(el, opts) : createImageBitmap(el))
      .then((bitmap) => {
        if (el.seeking || !el.paused) {
          bitmap.close();
          return;
        }
        const frame = store
          ? frameCacheStore(entry, bitmap, requestedSec, scaled)
          : // Caching off for this clip: latch-only (display stability), no LRU.
            {
              clipId: entry.clipId,
              bitmap,
              cell: cellOf(requestedSec),
              bytes: bitmap.width * bitmap.height * 4,
              lastUse: ++frameCacheTick,
              transient: true,
              scaled,
            };
        if (latch) {
          setLatch(entry, frame);
          notifyReady(entry.clipId);
        } else if (!store || frame.transient) bitmap.close();
        else notifyBanked();
      })
      .catch(() => undefined);
  };
  const rvfc = (el as VideoWithRvfc).requestVideoFrameCallback;
  if (typeof rvfc === "function") rvfc.call(el, () => grab());
  else grab();
}

/** Capture a LANDED frame in the middle of a seek chain — the moment `seeked`
 * fires and BEFORE the next chained seek is issued, so the snapshot is the
 * just-delivered picture. This is what makes reverse playback and fast scrubs
 * visibly PLAY (the chain never drains while targets keep coming, so waiting
 * for a settle froze the picture until pause) — and it warms the cache as it
 * goes, so the second pass is instant. */
function captureChainFrame(entry: VideoEntry, requestedSec: number): void {
  const el = entry.el;
  const store = mediaCachingAllowed(entry.clipId);
  const latch = headIsConducted(entry);
  if (!store && !latch) return; // nowhere for the copy to go
  // A RANGE BUILD keeps its pictures upstairs — the same rule as a settled
  // landing (`captureSettledFrame`). Chained landings used to slip past it and
  // bank a full-size decoded frame per instant of every build: memory filled
  // with pictures nothing ever plays from.
  if (exactRegime()) {
    if (store) encodeProxy(entry.clipId, [cellOf(requestedSec)], el);
    return;
  }
  const { opts, scaled } = captureOptions(el);
  void (opts ? createImageBitmap(el, opts) : createImageBitmap(el))
    .then((bitmap) => {
      const frame = store
        ? frameCacheStore(entry, bitmap, requestedSec, scaled)
        : {
            clipId: entry.clipId,
            bitmap,
            cell: cellOf(requestedSec),
            bytes: bitmap.width * bitmap.height * 4,
            lastUse: ++frameCacheTick,
            transient: true,
            scaled,
          };
      if (latch) {
        setLatch(entry, frame);
        notifyReady(entry.clipId);
      } else if (!store || frame.transient) bitmap.close();
      else notifyBanked();
    })
    .catch(() => undefined);
}

/**
 * Off-screen host for the video elements. A paused video that isn't in the DOM
 * is never composited, so the browser never *presents* a frame:
 * `requestVideoFrameCallback` won't fire and `drawImage` can read a stale
 * picture — the "export is slow AND jumpy" bug. A 1×1 invisible, non-interactive
 * host keeps every element live and cheap while staying out of the way.
 */
let videoHost: HTMLElement | null = null;
function ensureVideoHost(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  ensureVisibilityHousekeeping();
  if (videoHost && videoHost.isConnected) return videoHost;
  const host = document.createElement("div");
  host.setAttribute("data-tm-video-host", "");
  host.style.cssText =
    "position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1;";
  document.body.appendChild(host);
  videoHost = host;
  return host;
}

export function getVideoForClip(clipId: string, assetId: string): HTMLVideoElement | null {
  const entry = ensureVideoEntry(clipId, assetId);
  return entry.ready ? entry.el : null;
}

// ── The typed picture model ─────────────────────────────────────────────────
//
// ONE decision, no scattered conditions: what an element can provide this tick
// (`ElementState`) drives where a clip's picture comes from (`PictureSource`).
// The load-bearing rule — the live <video> is the source of truth whenever it
// can paint the frame; the cache is a STRICT FALLBACK (anti-blank during seeks,
// reverse display, cold), never a replacement that downgrades a good live frame.

/** What the element can paint RIGHT NOW — the ground truth. */
type ElementState =
  | "cold" // not ready — no decoded picture yet
  | "rolling" // playing forward, settled — the freshest live picture
  | "seeking" // a seek is in flight — drawing it paints blank/stale
  | "settled" // paused/landed — holds an exact decoded frame
  | "elsewhere"; // head parked off the playhead (decoder / background job)

/** Where a clip's picture comes from at draw time (discriminated union). */
type PictureSource =
  | { from: "element"; el: HTMLVideoElement } // sharpest — the live decoder
  | { from: "bitmap"; bitmap: ImageBitmap; sharp: boolean; exact?: true } // latch / cache / exact ring
  | { from: "none" }; // placeholder

/**
 * Is the head where the CONDUCTOR put it — i.e. on the playhead?
 *
 * Two things move it elsewhere: a background cache job (`borrowed`) and the
 * reverse-fill decoder (`fillRolling`), which rolls forward through frames the
 * timeline has already passed because codecs cannot step backward. In both
 * cases the element is a DECODER, not a picture.
 *
 * This is the ONE question three separate rules used to answer differently:
 *  - draws: the element is not our picture → read the latch;
 *  - the latch: whatever such a landing decodes is a frame from somewhere else
 *    in the file, so it may be STORED but must never become the latch;
 *  - the conductor: do not seek — two owners writing one `currentTime` is the
 *    oscillation this pipeline keeps rediscovering.
 */
function headIsConducted(entry: VideoEntry): boolean {
  return !entry.borrowed && !entry.fillRolling;
}

function elementStateOf(entry: VideoEntry): ElementState {
  const el = entry.el;
  if (!entry.ready || el.readyState < 2) return "cold";
  // Not our head → not our picture; fall through to the latch, which is the
  // frame the user is actually looking at.
  if (!headIsConducted(entry)) return "elsewhere";
  if (el.seeking) return "seeking";
  if (!el.paused) return "rolling";
  return "settled";
}

/**
 * Resolve a clip's picture for a wanted source time. Element-first and strict:
 * a cached frame may only preempt the element when the element genuinely can't
 * paint the wanted frame (mid-seek, reverse-decoding, cold). `reads` gates the
 * PERSISTENT cache tiers (LRU + proxy); the transient element snapshot (a photo
 * of the element, `cell < 0`) is always allowed for one-frame anti-blank.
 */
function resolvePicture(entry: VideoEntry, targetSec: number, reads: boolean): PictureSource {
  const el = entry.el;
  const lf = entry.lastFrame;
  const state = elementStateOf(entry);

  // THE RING, whenever the transport feeds one (exact stepping, backward
  // decode): the frame labelled for this instant. Exact playback holds until
  // it is there; live playback shows the nearest decoded frame meanwhile —
  // a frame of the right stretch, never the fill element mid-chunk.
  if (entry.capturing && entry.exactFrames.length > 0) {
    const want = clampToMedia(el, targetSec);
    const f = exactFrameFor(entry, want);
    if (f?.bitmap) {
      setRingShown(entry, f);
      return { from: "bitmap", bitmap: f.bitmap, sharp: true, exact: true };
    }
    if (!exactRegime()) {
      // A stand-in HOLDS what was already passed — never a frame still to
      // come. In a descent those are the frames below, and they arrive in
      // ascending order as a chunk decodes: showing them played the chunk
      // forwards on screen before playing it backwards.
      let near: ExactFrame | null = null;
      for (const c of entry.exactFrames) {
        const passed = entry.backFill !== null || entry.stepTo === null ? c.sec >= want - entry.frameSec : c.sec <= want;
        if (c.bitmap && passed && (!near || Math.abs(c.sec - want) < Math.abs(near.sec - want))) near = c;
      }
      if (near?.bitmap) {
        setRingShown(entry, near);
        return { from: "bitmap", bitmap: near.bitmap, sharp: true };
      }
    }
  }
  // WHILE THE RING IS THE SOURCE, IT IS THE ONLY SOURCE. The element is off
  // decoding a chunk and the latch is whatever an older gesture left: falling
  // through to them at a ping-pong's turn drew a frame from the start of the
  // file, or nothing at all. The last ring frame drawn holds instead.
  if (entry.capturing && entry.ringShown?.bitmap) {
    return { from: "bitmap", bitmap: entry.ringShown.bitmap, sharp: true };
  }

  // Rolling forward → the live element, always. A cached frame must NEVER
  // preempt it (soft proxy over the live codec was the core quality bug, and
  // the "nested video frozen while playing" bug — a stale latch out-ranking the
  // element that was actually rolling).
  if (state === "rolling") return { from: "element", el };

  // A persistent cache CELL that covers the wanted frame (instant scrub-revisit
  // / a parked cache hit where the element never moved). Read-gated.
  const covering = !!lf && lf.cell >= 0 && servesTarget(lf, targetSec) && reads;

  if (state === "settled") {
    // Paused / landed. Only a SHARP covering cell preempts the element (a parked
    // cache hit, where scrub landed on a sharp cache frame without moving the
    // element). A soft/downscaled cell must NEVER downgrade a sharp settled
    // frame — the element holds its exact decoded picture (the pause "hold"
    // frame), always full quality.
    if (covering && !lf!.scaled) return { from: "bitmap", bitmap: lf!.bitmap, sharp: true };
    return { from: "element", el };
  }

  // seeking / elsewhere / cold — the element can't paint a good frame now. Fall
  // back to the best bitmap: the transient snapshot (sharp, always allowed) or a
  // read-gated cache cell (soft is acceptable here — it beats a blank).
  if (lf && (lf.transient || covering)) return { from: "bitmap", bitmap: lf.bitmap, sharp: !lf.scaled };
  // NEVER A SEEKING ELEMENT WHILE ANY REAL PICTURE IS HELD. Mid-seek, the
  // element holds whatever its decoder is working through — often the keyframe
  // before the target — and drawing it flashed a wrong frame for an instant,
  // repeatably at the same steps (it depends on where the keyframes are). The
  // last real picture stays until the seek lands.
  // …but only a picture NEAR the wanted frame. An old saved frame (the clip's
  // first, from long ago) standing in during a correction seek flashed the
  // clip start for an instant; a seeking element is nearer the truth than that.
  // The latch only ever holds a frame that LANDED during the current scrub
  // (or a photo of the element before it), and is cleared when playback
  // starts — so it is always the right stand-in, whatever its cell.
  if (lf && state === "seeking") return { from: "bitmap", bitmap: lf.bitmap, sharp: !lf.scaled };
  if (state === "seeking") return { from: "element", el };
  // Nothing exact left. If we hold ANY picture of this clip, paint it: only the
  // conductor moves the latch, so the worst case is a frame or two stale. A
  // hole here is what made a paused clip go fully transparent — the element was
  // borrowed (→ "elsewhere") while a background landing had quietly replaced
  // the latch with a cell from another part of the file, so neither `transient`
  // nor `covering` held and the draw fell off the end of this function.
  if (lf) return { from: "bitmap", bitmap: lf.bitmap, sharp: !lf.scaled };
  return { from: "none" };
}

/**
 * The picture a video clip should paint for a wanted source time — the ONE read
 * the draw path uses. A thin adapter over `resolvePicture` (element-first, cache
 * as strict fallback), returning the concrete drawable.
 */
export function videoFrameForClip(
  clipId: string,
  assetId: string,
  targetSec: number,
): HTMLVideoElement | ImageBitmap | null {
  const entry = ensureVideoEntry(clipId, assetId);
  // THE CACHE NEVER PAINTS THE PICTURE. Banked frames are labelled by the
  // frame the decoder reported and grabbed a moment later (and small holes are
  // filled from a neighbour), so a banked cell can be a frame or two off —
  // shown as a scrub stand-in, that was the random wrong frame, and only with
  // the cache on. The stage draws the element and its own landed frames, as
  // with the cache off; the banked tiers serve filmstrips and reverse play.
  const src = resolvePicture(entry, targetSec, false);
  notePictureFidelity(entry, src, targetSec);
  if (src.from === "element") return src.el;
  if (src.from === "bitmap") return src.bitmap;
  return null;
}

/**
 * Tell the fidelity ledger what was just handed to the draw. See
 * `pictureFaults` — the one place a cache above learns whether this frame of
 * footage is the frame of the instant, or merely the frame that was there.
 */
function notePictureFidelity(entry: VideoEntry, src: PictureSource, targetSec: number): void {
  footageDraws++;
  if (src.from === "none") {
    transientFaults++;
    return;
  }
  if (src.from === "bitmap") {
    if (src.exact) return;
    if (entry.capturing && (entry.ringShown?.bitmap === src.bitmap || entry.exactFrames.some((f) => f.bitmap === src.bitmap))) {
      inexactFaults++; // a real frame, a neighbour of the instant
      return;
    }
    const lf = entry.lastFrame;
    // A snapshot, a soft proxy, or a cell of somewhere else: all stand-ins
    // for a picture that is on its way.
    if (!lf || lf.transient || lf.scaled || !servesTarget(lf, targetSec)) transientFaults++;
    return;
  }
  const state = elementStateOf(entry);
  if (state !== "rolling" && state !== "settled") {
    transientFaults++;
    return;
  }
  // EXACT MEANS THE FRAME OF THIS INSTANT — asked of the frame the element is
  // SHOWING. It used to be "within one 30fps cell of the clock", which passed
  // pictures a whole frame early or late as exact; kept, they replayed as the
  // jump at certain frames. Only without rVFC is the clock all there is.
  const exact = showsFrameFor(entry, clampToMedia(entry.el, targetSec));
  if (exact === false) inexactFaults++;
  else if (exact === null && Math.abs(entry.el.currentTime - clampToMedia(entry.el, targetSec)) > PREVIEW_CELL_SEC) inexactFaults++;
}

/**
 * Is the element showing THE frame for this source time? True, false, or null
 * when it cannot know (no rVFC report yet).
 *
 * "The frame for" is the decoder's own answer: the frame a seek to this time
 * lands on (seeks aim `SEEK_BIAS_SEC` inside, see `issueSeek`), so a landing
 * for this exact target is exact by definition, and otherwise the frame shown
 * must start at or before the aim point and end after it.
 */
function showsFrameFor(entry: VideoEntry, targetSec: number): boolean | null {
  const el = entry.el;
  if (!entry.ready || el.seeking) return false;
  if (el.paused && entry.landedFor !== null && Math.abs(entry.landedFor - targetSec) < 0.0005) return true;
  const shown = entry.shownSec;
  if (shown === null) return null;
  const aim = targetSec + SEEK_BIAS_SEC;
  return shown <= aim + 0.001 && aim < shown + entry.frameSec - 0.0005;
}

/** The ring frame that is the picture of this source time, if held. */
function exactFrameFor(entry: VideoEntry, targetSec: number): ExactFrame | null {
  const ring = entry.exactFrames;
  // A seek's landing for this very target is its frame by definition.
  if (entry.landedFor !== null && entry.shownSec !== null && Math.abs(entry.landedFor - targetSec) < 0.0005) {
    const landed = ring.find((f) => Math.abs(f.sec - entry.shownSec!) < 1e-6);
    if (landed) return landed;
  }
  const aim = targetSec + SEEK_BIAS_SEC;
  for (let i = ring.length - 1; i >= 0; i--) {
    const f = ring[i]!;
    if (f.sec > aim + 0.001) continue;
    const next = ring[i + 1];
    const end = Math.min(f.sec + entry.frameSec, next ? next.sec : Number.POSITIVE_INFINITY);
    return aim < end - 0.0005 ? f : null;
  }
  return null;
}

/** Let go of ring frames the transport has passed — they will not be drawn again. */
function pruneExactFrames(entry: VideoEntry, targetSec: number, backward = false): void {
  const ring = entry.exactFrames;
  const aim = targetSec + SEEK_BIAS_SEC;
  if (backward) {
    // Above the instant is behind us — a few frames stay, to hold while the
    // next chunk decodes; far below is a stretch we left.
    const floor = aim - BACK_CHUNK_SEC * 3;
    for (let i = ring.length - 1; i >= 0; i--) {
      const f = ring[i]!;
      if (f.sec > aim + entry.frameSec * 4 + 0.001 || f.sec < floor) {
        releaseExactFrame(entry, f);
        ring.splice(i, 1);
      }
    }
    return;
  }
  let cut = 0;
  while (cut + 1 < ring.length && ring[cut + 1]!.sec <= aim + 0.001) cut++;
  // Past the end of the ring entirely: nothing held is of any use.
  if (ring.length > 0 && ring[ring.length - 1]!.sec + entry.frameSec * 4 < aim) cut = ring.length;
  for (const f of ring.splice(0, cut)) releaseExactFrame(entry, f);
}

function clearExactFrames(entry: VideoEntry): void {
  for (const f of entry.exactFrames) f.bitmap?.close();
  if (entry.ringShown && !entry.exactFrames.includes(entry.ringShown)) entry.ringShown.bitmap?.close();
  entry.exactFrames = [];
  entry.ringShown = null;
}

/**
 * THE ELEMENT LEAVES THE RING — the one exit, from every direction: a conduct
 * mode that does not use it, the transport stopping, an export taking the
 * element. A ring left behind is a picture source nobody is feeding: an export
 * drew its stale frames instead of the frame it had just seeked to.
 */
function leaveRing(entry: VideoEntry): void {
  entry.stepTo = null;
  entry.capturing = false;
  if (entry.backFill) {
    entry.backFill = null;
    entry.fillRolling = false;
  }
  if (entry.exactFrames.length > 0 || entry.ringShown) clearExactFrames(entry);
}

/** Parked: the ring keeps the frames landed around the playhead, a handful at most. */
const PARKED_RING_FRAMES = 6;

function parkRing(entry: VideoEntry, targetSec: number): void {
  entry.stepTo = null;
  if (entry.backFill) {
    entry.backFill = null;
    entry.fillRolling = false;
  }
  entry.capturing = true;
  const ring = entry.exactFrames;
  while (ring.length > PARKED_RING_FRAMES) {
    // Drop the landed frame farthest from where the playhead is now.
    const far = Math.abs(ring[0]!.sec - targetSec) >= Math.abs(ring[ring.length - 1]!.sec - targetSec) ? 0 : ring.length - 1;
    releaseExactFrame(entry, ring[far]!);
    ring.splice(far, 1);
  }
}

/** A ring frame leaves the ring — kept open only while it is the one on screen. */
function releaseExactFrame(entry: VideoEntry, f: ExactFrame): void {
  if (f !== entry.ringShown) f.bitmap?.close();
}

function setRingShown(entry: VideoEntry, f: ExactFrame): void {
  const prev = entry.ringShown;
  if (prev === f) return;
  if (prev && !entry.exactFrames.includes(prev)) prev.bitmap?.close();
  entry.ringShown = f;
}

/** Keep the frame just presented, labelled with its own timestamp. */
function captureExactFrame(entry: VideoEntry, sec: number): ExactFrame | null {
  const ring = entry.exactFrames;
  const now = performance.now();
  for (let i = ring.length - 1; i >= 0; i--) {
    if (ring[i]!.bitmap === null && now - ring[i]!.at > CAPTURE_EXPIRE_MS) ring.splice(i, 1);
  }
  if (entry.ringShown && entry.ringShown.bitmap === null && now - entry.ringShown.at > CAPTURE_EXPIRE_MS) {
    entry.ringShown = null;
  }
  if (ring.some((f) => Math.abs(f.sec - sec) < 1e-6)) return null;
  const slot: ExactFrame = { sec, bitmap: null, at: performance.now() };
  let at = ring.length;
  while (at > 0 && ring[at - 1]!.sec > sec) at--;
  ring.splice(at, 0, slot);
  // The snapshot is taken NOW, synchronously, inside the presentation
  // callback; only its resolution is asynchronous.
  void createImageBitmap(entry.el)
    .then((bitmap) => {
      if (!entry.exactFrames.includes(slot) && entry.ringShown !== slot) {
        bitmap.close();
        return;
      }
      slot.bitmap = bitmap;
      // Only the frame the stage is waiting on is news; the rest are ahead.
      if (entry.lastTargetSec !== null && exactFrameFor(entry, entry.lastTargetSec) === slot) notifyReady(entry.clipId);
    })
    .catch(() => {
      const i = entry.exactFrames.indexOf(slot);
      if (i >= 0) entry.exactFrames.splice(i, 1);
      if (entry.ringShown === slot) entry.ringShown = null;
    });
  return slot;
}

/**
 * Follow every frame the element presents, for as long as it exists: rolling,
 * stepped, or landed from a seek. One callback per presented frame, none while
 * nothing changes — and the one place `shownSec`, the learned frame duration
 * and the exact STEP (pause on the frame asked for) are decided.
 */
function watchShown(entry: VideoEntry): void {
  const el = entry.el;
  const rvfc = (el as VideoWithRvfc).requestVideoFrameCallback;
  if (typeof rvfc !== "function") return;
  let prevSec: number | null = null;
  let prevCount = -1;
  const step = (_now: number, meta: RvfcMetadata) => {
    if (videos.get(entry.clipId) !== entry) return; // replaced or dropped
    rvfc.call(el, step);
    const sec = meta.mediaTime;
    // Consecutive presentations while playing measure the frame duration.
    if (prevSec !== null && meta.presentedFrames === prevCount + 1 && !el.seeking) {
      const d = sec - prevSec;
      if (d > 0.004 && d < 0.1 && (entry.frameSec <= 1 / 120 + 1e-9 || d < entry.frameSec)) entry.frameSec = d;
    }
    // Pre-roll ends when presentations ADVANCE — the start seek's own landing
    // is presented too, with `paused` already false, before playback moves.
    if (!el.paused && prevSec !== null && sec > prevSec + 0.001) entry.startingSince = null;
    prevSec = sec;
    prevCount = meta.presentedFrames;
    entry.shownSec = sec;
    if (entry.capturing && !entry.borrowed && !mediaLocked) captureExactFrame(entry, sec);
    const fill = entry.backFill;
    if (fill && !el.paused && sec >= fill.to - 0.0005) {
      // The chunk is decoded up to where the ring already was: rest.
      el.pause();
      entry.backFill = null;
      entry.fillRolling = false;
    }
    if (entry.stepTo === null || el.paused) return;
    // ── THE STEP ── pause ON the frame asked for, from inside its own
    // presentation callback: the element then holds exactly that frame (a
    // pause from anywhere later races the decoder onto the next one).
    const target = entry.stepTo;
    if (showsFrameFor(entry, target)) {
      el.pause();
      entry.stepTo = null;
    } else if (sec > target + SEEK_BIAS_SEC + 0.001) {
      // Went past it (a frame was presented while the thread was busy):
      // the decoder answers exactly instead.
      el.pause();
      entry.stepTo = null;
      notePlaybackEvent("step-overshoot", target, `${entry.clipId} shown ${sec.toFixed(4)}`);
      issueSeek(entry, target);
    }
  };
  rvfc.call(el, step);
}

/**
 * EXACT MEDIA NOT YET ON SCREEN — is any video conducted this tick not yet
 * showing the frame of its instant? Exact playback presents nothing until it
 * is (showing the frame a step is passing through, and then the right one, is
 * exactly the flicker it exists to remove).
 */
export function exactMediaPending(): boolean {
  for (const entry of videos.values()) {
    if (entry.conductPass !== conductPassId || entry.borrowed) continue;
    if (!entry.ready) return true;
    if (entry.lastTargetSec === null) continue;
    if (!exactFrameFor(entry, entry.lastTargetSec)?.bitmap) return true;
  }
  return false;
}

function ensureVideoEntry(clipId: string, assetId: string): VideoEntry {
  let entry = videos.get(clipId);
  if (entry && entry.assetId !== assetId) {
    dropClipFrames(clipId); // cached pictures belong to the OLD asset
    entry.el.src = "";
    entry.el.remove();
    videos.delete(clipId);
    entry = undefined;
  }
  if (entry) return entry;

  const el = document.createElement("video");
  el.muted = true; // audibility is the conductor's job
  el.playsInline = true;
  el.preload = "auto";
  el.crossOrigin = "anonymous";
  el.preservesPitch = false; // speed shifts pitch, matching the exported audio
  el.style.cssText = "width:1px;height:1px;";
  // Live in the DOM so the compositor presents frames (see ensureVideoHost).
  ensureVideoHost()?.appendChild(el);
  const created: VideoEntry = {
    clipId,
    assetId,
    el,
    ready: false,
    lastRequestedSec: null,
    pendingSeekSec: null,
    seekLatencySec: 0.12,
    seekIssuedAt: null,
    seekDoneAt: 0,
    lastTargetSec: null,
    borrowed: false,
    rateWroteAt: 0,
    rollingCapture: false,
    proxyPrevCell: null,
    proxyEncoding: false,
    fillRolling: false,
    conductPass: -1,
    lastFrame: null,
    shownSec: null,
    frameSec: 1 / 120,
    landedFor: null,
    stepTo: null,
    exactFrames: [],
    capturing: false,
    backFill: null,
    ringShown: null,
    startingSince: null,
  };
  videos.set(clipId, created);
  // Chained seeking: the newest target issued the moment the previous lands.
  // When the chain drains (scrub settled), capture the landed frame into the
  // decoded-frame cache so revisiting it costs nothing.
  // The element is really presenting — see `videoStarting`.
  // Where rVFC exists, the first PRESENTED frame ends it (`watchShown`):
  // `playing` fires before a frame is on screen, and a clock started there
  // began the footage several frames behind it.
  el.addEventListener("playing", () => {
    if (typeof (el as VideoWithRvfc).requestVideoFrameCallback !== "function") created.startingSince = null;
  });
  el.addEventListener("seeked", () => {
    created.seekDoneAt = performance.now();
    // The decoder has resolved this target to a frame — the one it now shows.
    if (created.pendingSeekSec === null) created.landedFor = created.lastRequestedSec;
    if (created.seekIssuedAt !== null) {
      const sample = (created.seekDoneAt - created.seekIssuedAt) / 1000;
      created.seekIssuedAt = null;
      created.seekLatencySec = Math.min(0.5, created.seekLatencySec * 0.7 + sample * 0.3);
    }
    if (created.pendingSeekSec !== null) {
      // Chain continues: capture the frame that just LANDED before seeking on
      // (reverse playback / fast scrubs paint every delivered frame instead
      // of freezing until the chain drains).
      if (!mediaLocked && el.paused && created.lastRequestedSec !== null) {
        captureChainFrame(created, created.lastRequestedSec);
      }
      const next = created.pendingSeekSec;
      created.pendingSeekSec = null;
      issueSeek(created, next);
    } else if (!mediaLocked && el.paused && created.lastRequestedSec !== null) {
      captureSettledFrame(created, created.lastRequestedSec);
    }
    // A landing on a head someone ELSE is driving (a cache job, the reverse
    // decoder) is a decoder at work, not a new picture on screen.
    if (headIsConducted(created)) notifyReady(clipId);
  });
  void assetObjectURL(assetId).then((url) => {
    if (!url) return;
    el.src = url;
    el.addEventListener(
      "loadeddata",
      () => {
        created.ready = true;
        watchShown(created);
        notifyReady(clipId);
      },
      { once: true },
    );
    el.load();
  });
  return created;
}

/** Resolve once a clip's video element can deliver frames (export path). */
function ensureVideoReady(clipId: string, assetId: string): Promise<HTMLVideoElement | null> {
  const entry = ensureVideoEntry(clipId, assetId);
  if (entry.ready) return Promise.resolve(entry.el);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(entry.ready ? entry.el : null), 8000);
    entry.el.addEventListener(
      "loadeddata",
      () => {
        window.clearTimeout(timer);
        resolve(entry.el);
      },
      { once: true },
    );
  });
}

// ── Background / idle housekeeping ───────────────────────────────────────────
//
// A hidden tab shouldn't keep decode pipelines hot or hold ~200MB of scrub
// frames: on hide every element pauses (unless an export owns them — a
// backgrounded render keeps working), and after 30s hidden the frame cache
// trims to just the latched (currently painted) bitmaps. Coming back is lazy:
// the next sync pass re-seeks/replays whatever the stage actually needs.

const HIDDEN_TRIM_DELAY_MS = 30_000;
let hiddenTrimTimer: number | null = null;
let visibilityHooked = false;

function ensureVisibilityHousekeeping(): void {
  if (visibilityHooked || typeof document === "undefined") return;
  visibilityHooked = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (!mediaLocked) {
        // Stop hidden decode work — but never pause an element carrying
        // audible program audio (the user may be listening from another tab).
        for (const entry of videos.values()) {
          if (!entry.el.paused && !entry.el.muted) continue;
          entry.el.pause();
          entry.lastRequestedSec = null;
          entry.pendingSeekSec = null;
        }
      }
      hiddenTrimTimer = window.setTimeout(() => {
        hiddenTrimTimer = null;
        if (mediaLocked || document.visibilityState !== "hidden") return;
        trimFrameCacheToLatched();
      }, HIDDEN_TRIM_DELAY_MS);
    } else if (hiddenTrimTimer !== null) {
      window.clearTimeout(hiddenTrimTimer);
      hiddenTrimTimer = null;
    }
  });
}

/** Free every cached frame no clip is currently painting. */
export function trimFrameCacheToLatched(): void {
  const latched = new Set<ImageBitmap>();
  for (const e of videos.values()) if (e.lastFrame) latched.add(e.lastFrame.bitmap);
  for (let i = frameCache.length - 1; i >= 0; i--) {
    const f = frameCache[i]!;
    if (latched.has(f.bitmap)) continue;
    frameCache.splice(i, 1);
    frameCacheBytes -= f.bytes;
    reportFrameGone(f);
    f.bitmap.close();
  }
}

/**
 * Park every idle element back at its clip's CURRENT target (the playhead
 * frame) — a background cache job wanders elements across the file, and a
 * play-start from a wandered element pays a random-length seek before the
 * first frame moves. Parked elements start instantly.
 *
 * Parking only; it does NOT release a borrow. The job that took the head hands
 * it back in its own `finally`, so there is exactly one owner of that
 * transition — a second release site is how the two-owner bug starts.
 */
function parkIdleElements(): void {
  if (mediaLocked) return;
  for (const entry of videos.values()) {
    if (!entry.ready || entry.lastTargetSec === null) continue;
    const el = entry.el;
    if (!el.paused || el.seeking || !headIsConducted(entry)) continue;
    const target = clampToMedia(el, entry.lastTargetSec);
    if (Math.abs(el.currentTime - target) > 0.05) issueSeek(entry, target);
  }
}

/** Pause video elements the sync pass did NOT touch this tick — clips that left
 * the visible set (scrolled past the playhead, a comp switched away). The video
 * pipeline is the SOLE authority over element play/pause; the stage calls this
 * once, AFTER conducting every visible frame, so off-screen videos stop without
 * a second conductor fighting the ones actually rolling (nested included). */
export function pauseUnconductedElements(): void {
  if (mediaLocked) return;
  for (const entry of videos.values()) {
    if (entry.conductPass === conductPassId) continue; // conducted this tick → owned
    if (!headIsConducted(entry)) continue;
    if (!entry.el.paused) {
      entry.el.pause();
      entry.lastRequestedSec = null;
      entry.pendingSeekSec = null;
    }
  }
}

/** Pause (and silence) every video element — transport stop. */
export function pauseAllVideoElements(): void {
  for (const entry of videos.values()) {
    // A PAUSE LANDS ON THE LAST INSTANT SHOWN: the transport puts the
    // playhead there (`use-playback`), and the next parked tick seeks this
    // element to that instant's exact frame while the stage holds the screen
    // until it lands. The ring stays — in exact playback it already holds that
    // frame, so the pause changes nothing on screen at all.
    entry.el.pause();
    entry.el.muted = true;
    entry.lastRequestedSec = null;
    entry.pendingSeekSec = null;
  }
}

/** Drop video elements whose clips no longer exist (called from the conductor). */
export function pruneVideoElements(liveClipIds: Set<string>): void {
  for (const [clipId, entry] of videos) {
    if (liveClipIds.has(clipId)) continue;
    dropClipFrames(clipId);
    forgetClip(clipId);
    entry.el.pause();
    entry.el.src = "";
    entry.el.remove();
    videos.delete(clipId);
  }
}

/**
 * A clip's natural source span AS THIS HOST KNOWS IT — the app-side half of
 * core's `clipNaturalSourceSpanMs`, and the only place a natural span is
 * computed outside core.
 *
 * Two facts genuinely live here and not in the document:
 *  - an animated image's length, which comes out of this module's decode cache;
 *  - a video whose asset metadata is still streaming in, where the clip's own
 *    length is the honest stand-in so a loop still WRAPS instead of running
 *    off unbounded until the duration lands.
 * Every other kind delegates straight through.
 */
export function clipLoopNaturalSpanMs(doc: MotionDocument, clip: Clip): number {
  if (clip.kind === "image") {
    const dur = animatedImageDurationMs(clip.assetId) ?? 0;
    return dur > 0 ? Math.max(1, dur - clip.trimInMs) : 0;
  }
  if (clip.kind === "video") {
    const dur = doc.assets.find((a) => a.id === clip.assetId)?.durationMs ?? 0;
    if (dur <= 0) return Math.max(1, clip.durationMs - clip.trimInMs);
  }
  return clipNaturalSourceSpanMs(doc, clip);
}

/**
 * THE app-side clip-local → source-time map: core's `clipSourceTimeAt` bound
 * to the natural span this host knows (above). Every surface that asks "which
 * frame of the source is showing here" — the renderer, the video conductor,
 * the frame tracker, the cache bars, the timeline posters — calls THIS, so
 * video, animated images and nested comps can never drift apart. It replaced a
 * `videoSourceMs` and a `nestedSourceMs` that duplicated the same arithmetic
 * per kind and agreed with core only by hand.
 */
export function clipSourceMs(doc: MotionDocument, clip: Clip, localMs: number): number {
  return clipSourceTimeAt(doc, clip, localMs, clipLoopNaturalSpanMs(doc, clip));
}

/**
 * Aggregate cache status for every video visible in `frame` at `timeMs`,
 * recursing nested comps exactly like the renderer: "green" = all cached,
 * "red" = something needs a decode, null = nothing cache-eligible there.
 * The ruler bar and nested-clip strips read THIS — parent and child
 * timelines can't disagree, because they ask the same question.
 */
export function videoCacheStatusAt(
  doc: MotionDocument,
  frame: Frame,
  timeMs: number,
): "green" | "red" | null {
  let covering = 0;
  let cached = 0;
  for (const t of collectVideoTargets(doc, frame, timeMs)) {
    setClipCachePolicy(t.clipId, t.cachePolicy);
    if (!mediaCachingAllowed(t.clipId)) continue;
    covering++;
    const q = t.maxSourceMs !== null ? Math.min(t.targetMs, t.maxSourceMs) : t.targetMs;
    if (hasFrame(mediaSubject(t.clipId), q)) cached++;
  }
  if (covering === 0) return null;
  return cached === covering ? "green" : "red";
}

// ── The unified target walk ──────────────────────────────────────────────────

/** A sequence frame an export must have decoded before drawing. */
interface SequenceTarget {
  assetId: string;
  index: number;
}

interface VideoTarget {
  clipId: string;
  assetId: string;
  targetMs: number;
  /** Effective playback rate: the clip's speed × every ancestor nested speed. */
  speed: number;
  /** The mapped source time is CLAMPED (play-once clip past its footage) —
   * the source isn't advancing, so the element must freeze on that frame, not
   * roll. Rolling an element at its end flips it to `ended`, where play()
   * restarts at 0 — the "jumps between two frames after the clip ends" bug. */
  hold: boolean;
  /** The clip's saved cache override, pushed to the status registry. */
  cachePolicy: "always" | "never" | undefined;
  /** Last queryable source ms (asset duration minus the end clamp), if known. */
  maxSourceMs: number | null;
}

/**
 * Does this comp, or any comp it nests, hold footage the walk below would
 * conduct — a video clip or a video fill? Time-independent, so memoised per
 * document snapshot.
 */
const footageMemo = new WeakMap<MotionDocument, Map<string, boolean>>();
function frameHasFootage(doc: MotionDocument, frameId: string, guard: Set<string> = new Set()): boolean {
  let perDoc = footageMemo.get(doc);
  if (!perDoc) footageMemo.set(doc, (perDoc = new Map()));
  const hit = perDoc.get(frameId);
  if (hit !== undefined) return hit;
  if (guard.has(frameId)) return false;
  guard.add(frameId);
  let found = false;
  for (const { clip } of frameClipEntries(doc, frameId)) {
    if (clip.kind === "video") found = true;
    else if (clip.kind === "nested") found = frameHasFootage(doc, clip.sourceFrameId, guard);
    else if ("fills" in clip) {
      found = clip.fills.some(
        (f) => f.type === "media" && f.source.type === "asset" && doc.assets.some((a) => a.id === (f.source as { assetId: string }).assetId && a.kind === "video"),
      );
    }
    if (found) break;
  }
  perDoc.set(frameId, found);
  return found;
}

/**
 * Every video visible in `frame` at `timeMs` and the exact source time it must
 * show — recursing nested comps with the SAME time mapping the renderer uses.
 * This is the single source of truth for both preview sync and export.
 */
function collectVideoTargets(
  doc: MotionDocument,
  frame: Frame,
  timeMs: number,
  speedScale = 1,
  out: VideoTarget[] = [],
  guard: Set<string> = new Set([frame.id]),
  inheritedPolicy: "always" | "never" | undefined = undefined,
  /** Sequence frames this instant shows, if the caller asks (an export). */
  sequences: SequenceTarget[] | null = null,
  /** Clips that own their end instant — mirrors the renderer's `clipEnds`. */
  clipEnds: ReadonlySet<string> | null = null,
  /** Inside a STATIC frame: every source is parked on the still's moment. */
  frozen = false,
): VideoTarget[] {
  // Nothing to conduct anywhere in this comp: skip the walk. It ran per comp
  // on the page on every stage tick — a pan over a page of character comps
  // walked every one of their layers sixty times a second to find no video.
  if (!sequences && !frameHasFootage(doc, frame.id)) return out;
  // A still shows one instant whatever it is asked (the renderer's clock, see
  // `frameEvalTimeMs`), so its footage is conducted to that instant and held.
  const still = frameStillMs(frame);
  if (still !== null) {
    timeMs = still;
    frozen = true;
  }
  // The comp's own clips, from core's per-document index — never a scan of
  // every clip in the project per nested level (that made the walk quadratic).
  for (const { track, clip } of frameClipEntries(doc, frame.id)) {
    if (track.hidden || clip.hidden) continue;
    // Gap-fill mirrors the renderer: a footage clip HOLDS a frame across an
    // adjacent gap, so its element is conducted (seeked + frozen) to that
    // still instead of sitting cold — no transparent flash between shots.
    const rl = clipRenderLocalTime(track, clip, timeMs, clipEnds);
    if (!rl) continue;
    const local = rl.local;
    // Asset VIDEO fills (an image/video/shape layer filled with a video) each
    // need their own synced element, keyed per (clip, fill). Independent of the
    // clip's OWN footage element — so a video clip's trim/speed/loop is untouched;
    // these overlay/shape fills just loop by the host clip's local time.
    if ("fills" in clip) {
      for (const fill of clip.fills) {
        if (fill.type !== "media") continue;
        if (fill.source.type !== "asset") continue;
        const fillAssetId = fill.source.assetId;
        const fa = doc.assets.find((a) => a.id === fillAssetId);
        if (fa?.kind !== "video") continue;
        const dur = fa.durationMs ?? 0;
        out.push({
          clipId: `${clip.id}::fill::${fill.id}`,
          assetId: fillAssetId,
          targetMs: dur > 0 ? ((local % dur) + dur) % dur : Math.max(0, local),
          speed: speedScale,
          hold: frozen,
          cachePolicy: inheritedPolicy,
          maxSourceMs: fa.durationMs != null ? Math.max(0, fa.durationMs - 34) : null,
        });
      }
    }
    if (sequences && clip.kind === "image") {
      const index = sequenceFrameForClip(doc, clip, local);
      if (index !== null) sequences.push({ assetId: clip.assetId, index });
    }
    if (clip.kind === "video") {
      const asset = doc.assets.find((a) => a.id === clip.assetId);
      const span = Math.max(1, (asset?.durationMs ?? clip.durationMs) - clip.trimInMs);
      // The RATE right now, not the clip's base speed: under a ramp the
      // element's playbackRate has to follow the curve, or the drift
      // corrector spends the whole ramp chasing a target it was never told
      // about — which reads as the stutter it literally is.
      const rate = speedAt(clip, local);
      out.push({
        clipId: clip.id,
        assetId: clip.assetId,
        targetMs: clipSourceMs(doc, clip, local),
        speed: speedScale * rate,
        // A gap-fill still (`rl.held`), a play-once tail, and a FREEZE are
        // one fact: the source is not advancing, so park the element on the
        // frame it is already showing instead of rolling it. Core answers
        // that once, in `sourcePhaseAt`.
        hold:
          frozen ||
          rl.held ||
          clipSourcePhaseAt(doc, clip, local).held ||
          (clip.playback.loop === "none" && local * clip.playback.speed >= span),
        // A parent nested clip's saved policy cascades to children that
        // don't set their own.
        cachePolicy: clip.cachePolicy ?? inheritedPolicy,
        maxSourceMs: asset?.durationMs != null ? Math.max(0, asset.durationMs - 34) : null,
      });
    } else if (clip.kind === "nested" && !guard.has(clip.sourceFrameId)) {
      const source = doc.frames.find((f) => f.id === clip.sourceFrameId);
      if (!source) continue;

      const childGuard = new Set(guard);
      childGuard.add(source.id);
      // Mirrors drawNestedClip exactly — trim-in included (it wasn't, so
      // videos inside TRIMMED nested clips synced to the wrong times).
      const srcLocal = clipSourceMs(doc, clip, local);
      collectVideoTargets(
        doc,
        source,
        srcLocal,
        // A nested comp's own ramp scales everything inside it, so the rate
        // that cascades is the rate NOW — the same reading a video clip takes.
        speedScale * speedAt(clip, local),
        out,
        childGuard,
        clip.cachePolicy ?? inheritedPolicy,
        sequences,
        clipEnds,
        frozen,
      );
    }
  }
  return out;
}

/** Issue a seek and stamp the bookkeeping every seek must carry. Targets are
 * clamped to the playable range (see clampToMedia) — no seek may strand the
 * element in `ended`. */
function issueSeek(entry: VideoEntry, targetSec: number): void {
  const clamped = clampToMedia(entry.el, targetSec);
  entry.lastRequestedSec = clamped;
  entry.seekIssuedAt = performance.now();
  entry.landedFor = null;
  // AIM INSIDE THE FRAME. Containers store frame times to the millisecond, so
  // frame 50 of 30fps footage is stamped 1.667 while its instant is 1.6666…;
  // seeking to the instant exactly lands BEFORE the stamp and shows frame 49.
  // An off-by-one on some frames and not others — the "jumpy at certain
  // numbers" stepping. 2ms clears the rounding and cannot reach the next frame
  // even at 120fps. Bookkeeping keeps the instant; only the element aims in.
  entry.el.currentTime = Math.min(clamped + SEEK_BIAS_SEC, clampToMedia(entry.el, Number.POSITIVE_INFINITY));
}

/** How far inside a frame every seek aims — see `issueSeek`. */
const SEEK_BIAS_SEC = 0.002;

/** Playback drift beyond this hard-resyncs with a seek. */
const HARD_RESYNC_SEC = 0.3;
/** Drift below this is clock/decoder jitter, not real desync — leave it be.
 * Under half a 30fps frame: a deadband wider than a frame let the footage
 * settle a whole frame off and stay there. */
const DRIFT_DEADBAND_SEC = 0.015;
/** A landed resync gets this long to prove itself before the next one — with
 * the latency lead this converges in one hop; without a cooldown a slow seek
 * degenerates into a visible seek-per-frame stutter storm. */
const RESYNC_COOLDOWN_MS = 300;
/** Minimum spacing between playbackRate writes (drift nudging). */
const RATE_WRITE_MIN_MS = 250;

/** Clamp a seek target to the element's playable range, a hair before the
 * end — landing exactly ON duration flips the element to `ended`, a state
 * whose play() restarts from zero. A frozen tail frame never wants that. */
function clampToMedia(el: HTMLVideoElement, sec: number): number {
  const dur = el.duration;
  if (!Number.isFinite(dur) || dur <= 0) return Math.max(0, sec);
  return Math.min(Math.max(0, sec), Math.max(0, dur - 1 / 30));
}

/** ONE PLAY → the whole footprint green: while an element rolls, every
 * presented frame banks a proxy for the cells it covers. rVFC hands us each
 * presented frame; holes (skipped while an encode was busy, or low-fps
 * sources spanning several cells) are range-filled from the next frame —
 * ≤1 source frame off, exactly the cell tolerance. Costs ~1–3ms per encode,
 * one in flight per clip, nothing when the footprint is already covered. */
function ensureRollingCapture(entry: VideoEntry): void {
  if (entry.rollingCapture || mediaLocked || !mediaCachingAllowed(entry.clipId)) return;
  const el = entry.el;
  const rvfc = (el as VideoWithRvfc).requestVideoFrameCallback;
  if (typeof rvfc !== "function") return;
  entry.rollingCapture = true;
  let lastBanked: number | null = null;
  let skip = false;
  const step = (_now: number, meta: RvfcMetadata) => {
    if (el.paused || el.ended || mediaLocked || !mediaCachingAllowed(entry.clipId)) {
      entry.rollingCapture = false;
      return;
    }
    rvfc.call(el, step);
    const cell = cellOf(meta.mediaTime);
    // WHO IS WATCHING DECIDES THE RATE. A decoder job (`fillRolling` — reverse
    // fill, "Cache clip now") banks every presented frame. Real
    // playback banks only on SPARE time — a readback and an encode on the
    // thread that is playing must never be what makes it stutter — and then
    // every other frame, each covering the one it skipped (≤1 frame off, the
    // cell tolerance). A light clip fills its bar as it plays; a heavy comp
    // plays first and fills on later passes.
    if (!entry.fillRolling) {
      skip = !skip;
      if (skip || renderCostMs() > SPARE_RENDER_MS) return;
    }
    if (entry.proxyEncoding) return;
    // This frame covers every cell since the last one banked — small holes
    // only; a jump or a loop wrap starts fresh rather than smearing a picture.
    const from = lastBanked !== null && cell - lastBanked >= 1 && cell - lastBanked <= 3 ? lastBanked + 1 : cell;
    const cells: number[] = [];
    for (let c = Math.min(from, cell); c <= cell; c++) cells.push(c);
    lastBanked = cell;
    if (!cells.some((c) => !proxyFrames.has(proxyKey(entry.clipId, c)))) return;
    entry.proxyEncoding = true;
    try {
      encodeProxy(entry.clipId, cells, el);
    } finally {
      // The blob lands async; release the gate next task so capture keeps pace
      // without stacking encodes.
      setTimeout(() => {
        entry.proxyEncoding = false;
      }, 0);
    }
  };
  rvfc.call(el, step);
}

/** The stage's render cost below which real playback may also bank footage. */
const SPARE_RENDER_MS = 12;

/**
 * How the element should be driven this tick — chosen by OBSERVING the target,
 * never flags. A <video> can only roll FORWARD, so a backward-moving target
 * (reverse clip, ping-pong descent, backward jump) decodes forward + displays
 * from cache (`rollBackward`). Coming straight out of playback, and held tails,
 * FREEZE where they are (`hold`, NO seek — the anti-jump rule: seeking to the
 * exact playhead would jump up to HARD_RESYNC_SEC). A paused playhead that MOVES
 * scrubs there exactly (`seekTo`).
 */
type TransportIntent =
  | { mode: "step" }
  | { mode: "rollForward" }
  | { mode: "rollBackward" }
  | { mode: "hold" }
  | { mode: "seekTo"; sec: number };

function resolveTransport(
  entry: VideoEntry,
  targetSec: number,
  playing: boolean,
  movingBackward: boolean,
): TransportIntent {
  if (playing) {
    // Backward (reverse, a ping-pong descent) decodes in chunks in EVERY
    // regime; forward exact playback steps, forward live playback rolls.
    if (movingBackward) return { mode: "rollBackward" };
    return exactRegime() ? { mode: "step" } : { mode: "rollForward" };
  }
  // PARKED MEANS ON THE FRAME OF THE PLAYHEAD. A rolling element runs a little
  // AHEAD of the playhead on purpose (the seek-latency lead), so freezing it
  // where it stood on pause showed a frame from the future, and the next
  // correction seek showed the past: current → future → past on every stop.
  // The stage now holds what is on screen until a seek lands ("present only
  // what has landed" in Stage), so the stop can simply seek to the exact frame
  // — one clean change, or none when the element is already there.
  const there =
    entry.el.paused &&
    !entry.el.seeking &&
    (showsFrameFor(entry, targetSec) === true || Math.abs(entry.el.currentTime - targetSec) < 0.008);
  const asked = entry.lastRequestedSec !== null && Math.abs(entry.lastRequestedSec - targetSec) < 0.008;
  return there || (asked && entry.el.paused) ? { mode: "hold" } : { mode: "seekTo", sec: targetSec };
}

/** Exact playback or a build: every picture is kept upstairs, as the exact frame. */
const exactRegime = (): boolean => playbackRegime() === "exact";

/**
 * Conduct one element toward a target time — a thin executor over the typed
 * `TransportIntent`. All the hard-won tuning (seek-latency lead, resync
 * cooldown, rate-nudge damping, loop-wrap `ended` handling, reverse fill) lives
 * inside the mode bodies.
 */
function conductEntry(entry: VideoEntry, targetMs: number, playing: boolean, speed: number, leadMs: number | null = null): void {
  const el = entry.el;
  const targetSec = clampToMedia(el, targetMs / 1000);
  const baseRate = Math.min(16, Math.max(0.07, speed));
  const prevTargetSec = entry.lastTargetSec;
  entry.lastTargetSec = targetSec;
  // WHICH WAY THE SOURCE IS MOVING. Exact playback knows — it hands over the
  // next instant (a loop wrap is a lead ABOVE a jump back, not a descent).
  // Live playback infers it from the last target: a DESCENT moves back by
  // about a tick of source; a loop WRAP jumps, and is a reposition for the
  // forward roll, not a reverse.
  const leadSec = leadMs === null ? null : clampToMedia(el, leadMs / 1000);
  const drop = prevTargetSec === null ? 0 : prevTargetSec - targetSec;
  const movingBackward =
    exactRegime() && leadSec !== null
      ? leadSec < targetSec - 0.0005
      : drop > 0.001 && drop < Math.max(0.25, baseRate / 10);
  const intent = resolveTransport(entry, targetSec, playing, movingBackward);

  if (intent.mode === "rollForward" && el.ended) {
    // The element ran off the end of the file on its own. If the timeline
    // target wrapped back (loop restart — the target jumps BACKWARDS), chase
    // it; otherwise leave the last frame up — play() from `ended` restarts at
    // 0 and flickers between the first and last frame. FORWARD ONLY: this
    // used to run before the direction was known, so a ping-pong turning at
    // the end of its file was read as a wrap — nothing drawn for half a
    // second, then the descent played forwards.
    const wrapped =
      (prevTargetSec !== null && targetSec < prevTargetSec - 0.05) ||
      (Number.isFinite(el.duration) && targetSec < el.duration - 0.5);
    if (wrapped) {
      issueSeek(entry, targetSec + entry.seekLatencySec * baseRate);
      entry.lastRequestedSec = null;
      void el.play().catch(() => undefined);
    }
    return;
  }

  // THE RING IS THE PICTURE WHENEVER THE ELEMENT IS BEING MOVED, not only in
  // playback: parked (a drag, a step, a stop) every landed frame goes into it
  // too, and while the next seek flies the layer holds the frame last DRAWN.
  // The latch it replaces was snapshotted just before each seek, and a
  // snapshot resolves after the call — it came back as an older landing and
  // the picture flicked back a frame during drags. Only live forward rolling
  // leaves it: there the element itself is the picture.
  if (intent.mode === "rollForward") leaveRing(entry);
  else if (intent.mode === "seekTo" || intent.mode === "hold") parkRing(entry, targetSec);

  switch (intent.mode) {
    case "step": {
      conductStep(entry, targetSec, leadSec, baseRate);
      return;
    }

    case "rollForward": {
      // ── ROLLING ── the element plays; small drift rate-nudges away, big drift
      // hard-resyncs with a latency lead. The live element is the picture.
      entry.pendingSeekSec = null;
      entry.fillRolling = false; // forward transport owns the element again
      if (el.paused) {
        el.playbackRate = baseRate;
        // Lead the entry point by the measured seek latency so the frame that
        // lands is the frame the timeline has reached by then — but ONLY when no
        // seek is already in flight. Re-issuing the seek every tick (the target
        // keeps advancing while the element is still seeking) aborts both the
        // previous seek AND the pending play(), so play() never resolves, the
        // element never leaves `paused`, and it seek-storms forever instead of
        // rolling — the "nested video jumps / won't play" bug. One seek, then
        // let it land and play; drift correction below takes over once rolling.
        // Where the clock waits for the first presented frame (pre-roll, see
        // `videoStarting`), the start seek aims AT the target: a latency lead
        // on top of a clock that is holding put the footage a frame ahead for
        // the whole run. Without rVFC the clock does not wait, so it leads.
        const holds = typeof (el as VideoWithRvfc).requestVideoFrameCallback === "function";
        if (!el.seeking && Math.abs(el.currentTime - targetSec) > 0.05) {
          issueSeek(entry, targetSec + (holds ? 0 : entry.seekLatencySec * baseRate));
        }
        entry.lastRequestedSec = null; // playback moves the head — next scrub seeks fresh
        entry.startingSince ??= performance.now();
        // A picture held from before this play (a scrub, a stop) is not this
        // playback's — cleared, so a correction seek later can never flash it
        // (the clip-start flash).
        setLatch(entry, null);
        void el.play().catch(() => undefined);
        ensureRollingCapture(entry);
      } else if (!el.seeking) {
        ensureRollingCapture(entry);
        // A fill machine may have left this element at 2× — snap back NOW,
        // outside the damper: rate is PITCH (preservesPitch off); half a second
        // of double-speed bell at every play start was the random-pitch bug.
        // Beyond the drift nudge's own ±25% — within it, the rate IS the nudge
        // (this used to reset anything past 12%, undoing the correction).
        if (Math.abs(el.playbackRate - baseRate) > baseRate * 0.3) {
          el.playbackRate = baseRate;
          entry.rateWroteAt = performance.now();
        }
        // DRIFT OF THE PICTURE, not of the clock: a playing element draws the
        // newest decoded frame, which runs ahead of `currentTime`, so a clock
        // held on target still showed a frame or two early. Measured from the
        // centre of the frame last presented; the clock is the fallback.
        const shownMid = entry.shownSec !== null && !el.seeking ? entry.shownSec + entry.frameSec / 2 : null;
        const drift = (shownMid ?? el.currentTime) - targetSec; // >0 → video runs ahead of the timeline
        if (Math.abs(drift) > HARD_RESYNC_SEC) {
          if (performance.now() - entry.seekDoneAt > RESYNC_COOLDOWN_MS) {
            void snapshotLatch(entry); // the in-flight picture = the frame we're leaving
            el.playbackRate = baseRate;
            issueSeek(entry, targetSec + entry.seekLatencySec * baseRate);
            entry.lastRequestedSec = null;
          }
        } else {
          // Small drift converges by nudging the rate a few percent — invisible
          // and free (no re-decode, no picture jump). Damped: writing
          // playbackRate every tick jerks the decode pipeline, which reads as
          // "playback isn't smooth" — one adjustment per RATE_WRITE_MIN_MS.
          const now = performance.now();
          if (now - entry.rateWroteAt >= RATE_WRITE_MIN_MS) {
            // Up to ±25%: the element is always muted (sound is the sound
            // engine's), so its rate is not pitch here — a timid nudge only
            // left the picture frames off for seconds.
            const nudge =
              Math.abs(drift) < DRIFT_DEADBAND_SEC ? 0 : Math.max(-0.25, Math.min(0.25, -drift * 1.5));
            const rate = baseRate * (1 + nudge);
            if (Math.abs(el.playbackRate - rate) > 0.01) {
              el.playbackRate = rate;
              entry.rateWroteAt = now;
            }
          }
        }
      }
      return;
    }

    case "rollBackward": {
      // ── BACKWARD (reverse / ping-pong descent) ── codecs can't decode
      // backwards, so the roles split: the DISPLAY reads the cache tiers while
      // the ELEMENT works as a forward-decoding fill machine over the unseen
      // stretch below — the chunked reverse decode every real NLE uses.
      conductBackward(entry, targetSec, baseRate);
      return;
    }

    case "hold": {
      // ── HOLD (freeze on pause / held tail — NO seek) ── the element already
      // holds the exact frame that was on screen the instant before; keep it.
      // Seeking to the playhead here would jump up to HARD_RESYNC_SEC away (the
      // pause-jump bug). `resolvePicture` returns the settled element, so the
      // picture is the live, sharp, frozen frame — zero cache involvement.
      if (!el.paused) {
        void snapshotLatch(entry); // pin the on-screen frame for any later scrub seek
        el.pause();
        entry.fillRolling = false;
      }
      // Park bookkeeping at the PLAYHEAD (a deliberate idle-dedupe lie — the
      // element sits at its drifted freeze position). Every later same-playhead
      // tick then stays idle; a real scrub (target moves) is detected and seeks.
      entry.lastRequestedSec = targetSec;
      return;
    }

    case "seekTo": {
      // ── PARKED ON A NEW INSTANT (a stop, a step, a scrub) → exact seek ──
      if (!el.paused) {
        el.pause();
        entry.fillRolling = false;
      }
      const wantSec = intent.sec;
      // Always a real seek — see "THE CACHE NEVER PAINTS THE PICTURE".
      // Hold a SHARP picture across the seek. The element's current settled frame
      // is sharp — snapshot it so you see the last real frame (~1 frame stale),
      // never a soft proxy of the target (the "scrub goes low quality" bug). Only
      // when the element has no decoded frame at all do we fall back to a soft
      // cache paint, and only when reads are allowed ("off means off").
      if (!el.seeking && el.readyState >= 2) void snapshotLatch(entry);
      if (el.seeking) entry.pendingSeekSec = wantSec;
      else issueSeek(entry, wantSec);
      return;
    }
  }
}

/** How far ahead a step plays forward rather than seeking (source sec). */
const STEP_REACH_SEC = 1.0;

/**
 * EXACT PLAYBACK'S DECODER — the frame of each instant, in order, without a
 * seek per frame.
 *
 * A seek re-decodes from the keyframe before it, which is what made
 * every-frame footage crawl. Playing forward decodes each frame once, so an
 * instant a little ahead is reached by PLAYING to it and pausing on its frame
 * from inside that frame's own presentation callback (`watchShown`) — where a
 * pause holds exactly the frame presented. Behind, far ahead, or where rVFC
 * does not exist, the decoder is asked directly: one exact seek.
 */
function conductStep(entry: VideoEntry, targetSec: number, leadSec: number | null, rate: number): void {
  const el = entry.el;
  entry.capturing = true;
  entry.backFill = null;
  entry.fillRolling = false;
  entry.startingSince = null;
  pruneExactFrames(entry, targetSec);
  if (el.seeking) {
    // A seek is landing: the newest target goes next (never re-aim mid-flight).
    entry.pendingSeekSec = Math.abs((entry.lastRequestedSec ?? -1) - targetSec) < 0.0005 ? null : targetSec;
    return;
  }
  const canStep = typeof (el as VideoWithRvfc).requestVideoFrameCallback === "function" && entry.shownSec !== null;
  const shown = entry.shownSec ?? el.currentTime;
  const aim = (sec: number) => sec + SEEK_BIAS_SEC;
  const reach = STEP_REACH_SEC * rate;
  const exactSeek = (sec: number, why: string) => {
    entry.stepTo = null;
    if (!el.paused) el.pause();
    notePlaybackEvent("step-seek", sec, `${entry.clipId} ${why} from ${shown.toFixed(4)}`);
    issueSeek(entry, sec);
  };

  // 1. THIS INSTANT. Held in the ring, or the decoder must get there first —
  //    playing forward to it when it is a little ahead, asking the decoder
  //    directly when it is behind (a frame was skipped) or far away.
  const have = exactFrameFor(entry, targetSec);
  if (!have) {
    const ahead = aim(targetSec) - shown;
    if (!canStep || ahead < -0.001 || ahead > reach) return exactSeek(targetSec, ahead < 0 ? "behind" : "far");
    if (ahead <= 0.001 && el.paused) {
      // Showing it, but not captured (e.g. a landing without a callback).
      captureExactFrame(entry, shown);
      return;
    }
  }

  // 2. THE NEXT INSTANT, while this one is on screen. The canvas already
  //    holds this instant's frame, so the decoder is free to walk on — which
  //    is what hides the play-to-frame latency behind the frame's own display
  //    time. Never past the next instant: a decoder racing ahead while the
  //    main thread renders is how frames get skipped.
  // At least one SOURCE frame ahead: in a comp faster than its footage the
  // next instant is often the same frame, and the new one then arrives with
  // no display time to hide its step behind.
  const want =
    have && leadSec !== null && leadSec > targetSec
      ? clampToMedia(el, Math.max(leadSec, targetSec + entry.frameSec))
      : targetSec;
  if (exactFrameFor(entry, want) || aim(want) < shown - 0.001) {
    if (!el.paused) el.pause();
    entry.stepTo = null;
    return;
  }
  if (!canStep || aim(want) - shown > reach) {
    if (!have) exactSeek(targetSec, "far");
    else if (!el.paused) el.pause();
    return;
  }
  entry.stepTo = want;
  if (el.paused) {
    // At the clip's own rate. Faster (2× was measured) makes the compositor
    // skip frames, every skip is an overshoot, and every overshoot a seek.
    el.playbackRate = rate;
    void el.play().catch(() => undefined);
  }
}

/** One backward chunk, in source seconds — a few hundred ms of frames in the ring. */
const BACK_CHUNK_SEC = 0.8;

/**
 * BACKWARD PLAYBACK — reverse clips and ping-pong descents, in every regime,
 * with the cache on or off.
 *
 * A decoder only runs forward. So the element decodes the stretch just BELOW
 * the instant, forward, into the ring (every presented frame labelled with its
 * own timestamp), and the display walks that ring backwards; the next chunk
 * down starts as soon as less than a chunk is held below the instant, so the
 * decode stays ahead of the descent.
 *
 * It used to display from the decoded-footage CACHE — soft proxies banked by a
 * fill machine — which meant reverse played nothing with the cache off, and
 * played cell-rounded proxies with it on. The ring is a working buffer, not a
 * cache: it holds only the stretch being played and exists whatever the
 * switches say.
 */
function conductBackward(entry: VideoEntry, targetSec: number, speed: number): void {
  const el = entry.el;
  entry.capturing = true;
  entry.stepTo = null;
  entry.startingSince = null;
  pruneExactFrames(entry, targetSec, true);
  if (el.seeking) return; // a chunk's start is landing; the watcher keeps it
  // THE TURN. Coming out of forward playback (a ping-pong turning, a reverse
  // starting) the ring is empty and the element — still rolling forward — is
  // about to leave to decode the chunk below: the layer drew NOTHING until it
  // landed. Three steps, in order: stop the element, keep the frame it shows
  // as the picture to hold, and only then send it off.
  if (entry.exactFrames.length === 0 && !entry.backFill) {
    if (!el.paused) el.pause();
    if (!entry.ringShown && entry.shownSec !== null && el.readyState >= 2) {
      const slot = captureExactFrame(entry, entry.shownSec);
      if (slot) setRingShown(entry, slot);
    }
  }
  // NEVER MOVE THE ELEMENT UNDER THE TURN'S CAPTURE. A snapshot resolves
  // after the call; a seek issued meanwhile makes it the seek's frame, or
  // nothing. Only the held frame waits — a fill's own captures never block it.
  if (entry.ringShown?.bitmap === null) return;

  const fill = entry.backFill;
  if (fill) {
    if (el.paused) {
      // Done at the chunk's end — or at the file's: a chunk ending on the last
      // frame can run the element into `ended` without that frame presented
      // (a fast fill drops frames), and `play()` from `ended` restarts at 0.
      if ((entry.shownSec ?? -1) >= fill.to - 0.0005 || el.ended) {
        entry.backFill = null;
        entry.fillRolling = false;
      } else {
        // Landed at the chunk's start: decode forward through it. EXACT at 1×:
        // any faster and the compositor drops frames it cannot present
        // (measured: every third at 1.5×), holes exact playback would have to
        // seek back for — it plays a little under real time instead. LIVE at
        // twice the clip's speed (≤4×): it must outrun a real-time descent, a
        // clip at speed s shows only every s-th source frame anyway, and a
        // dropped one is shown as its neighbour (inexact, never kept).
        el.playbackRate = exactRegime() ? 1 : Math.min(4, 2 * Math.max(1, speed));
        entry.fillRolling = true;
        void el.play().catch(() => undefined);
      }
    }
    return; // `watchShown` pauses at the chunk's end
  }

  // How far below the instant the ring already reaches, contiguously. A small
  // hole live playback steps over (it shows the nearest frame); exact playback
  // refills it.
  const ring = entry.exactFrames;
  const maxGap = entry.frameSec * (exactRegime() ? 1.5 : 4) + 0.001;
  const top = exactFrameFor(entry, targetSec);
  let lowest: number | null = null;
  if (top) {
    let i = ring.indexOf(top);
    lowest = top.sec;
    while (i > 0 && lowest - ring[i - 1]!.sec <= maxGap) lowest = ring[--i]!.sec;
  }
  // A faster descent needs longer chunks: each chunk pays one seek, and
  // amortising it is the only way a single decoder keeps up.
  const chunk = BACK_CHUNK_SEC * Math.min(2, Math.max(1, speed));
  if (lowest !== null && (lowest <= targetSec - chunk || lowest <= entry.frameSec)) {
    if (!el.paused) el.pause();
    return; // enough is decoded below; rest
  }
  const to = lowest ?? targetSec + SEEK_BIAS_SEC + entry.frameSec;
  if (to <= 0.0005) return; // the head of the file: nothing below
  const from = Math.max(0, to - chunk);
  entry.backFill = { from, to };
  if (!el.paused) el.pause();
  notePlaybackEvent("back-fill", from, `${entry.clipId} to ${to.toFixed(3)}`);
  issueSeek(entry, from);
}

/**
 * Keep every video visible in `frame` on the right picture for `timeMs`.
 * Called by the stage before each paint (per frame) and by realtime capture.
 * No-op while a stepped export owns the elements, unless `force`.
 */
/** One conduct per element per stage tick — the stage calls this before its
 * per-frame sync loop; the ACTIVE timeline should be synced first so its
 * mapping wins when a clip is visible through several frames. */
let conductPassId = 0;
export function beginConductPass(): void {
  conductPassId++;
}

/** Transport state as of the latest sync — background jobs abort on play. */
let transportPlaying = false;
export function isTransportPlaying(): boolean {
  return transportPlaying;
}

export function syncVideoFrames(
  doc: MotionDocument,
  frame: Frame,
  timeMs: number,
  playing: boolean,
  force = false,
  /**
   * Exact playback: the frame's NEXT instant. Each element's decoder walks on
   * to its own mapped time for it (through trims, speed, nesting) while the
   * current instant is on screen — see `conductStep`.
   */
  leadMs: number | null = null,
  /** The selection while paused — see the renderer's `clipEnds`. */
  clipEnds: ReadonlySet<string> | null = null,
): void {
  transportPlaying = playing;
  if (mediaLocked && !force) return;
  const leads = leadMs === null ? null : new Map(collectVideoTargets(doc, frame, leadMs).map((l) => [l.clipId, l.targetMs]));
  for (const t of collectVideoTargets(doc, frame, timeMs, 1, [], new Set([frame.id]), undefined, null, clipEnds)) {
    const entry = ensureVideoEntry(t.clipId, t.assetId);
    setClipCachePolicy(t.clipId, t.cachePolicy);
    if (!entry.ready) continue;
    // One conduct per tick — except forced passes (realtime WebM capture
    // drives its own loop without stage ticks).
    if (entry.conductPass === conductPassId && !force) continue;
    entry.conductPass = conductPassId;
    // A background cache job owns this element right now: conducting it would
    // yank the head back to the playhead between every banked cell, and its
    // seeks move `lastRequestedSec` off the playhead, which `resolveTransport`
    // reads as "the user scrubbed" and answers with a seek BACK — two owners
    // writing one `currentTime`, forever. Stand off; the latch keeps painting
    // the playhead frame, and the job releases on its own (it polls
    // `isTransportPlaying`, so a play-start ends it within a beat).
    if (entry.borrowed) continue;
    // A held frame (play-once clip past its footage) conducts as paused even
    // while the transport runs: exact seek, settle, latch — a rock-solid
    // freeze that also matches EXACTLY what pausing there shows.
    conductEntry(entry, t.targetMs, playing && !t.hold, t.speed, leads?.get(t.clipId) ?? null);
  }
}

type RvfcMetadata = { mediaTime: number; presentedFrames: number };
type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: RvfcMetadata) => void) => number;
};

/** Exact seek + await delivery — the one place that pays the real "re-decode
 * from the nearest keyframe" cost.
 *
 * Resolves on `seeked` plus one presented-frame beat: rVFC where the
 * compositor runs, a short timer where it doesn't (hidden/background tab —
 * `drawImage` already reads the post-seek picture once `seeked` lands, so a
 * backgrounded render keeps stepping at full speed instead of hitting a
 * timeout on every frame). Retries once on a stuck seek, then resolves with a
 * warning: one stubborn frame must not hang a whole render. */
function seekExact(entry: VideoEntry, targetSec: number, attempt = 0): Promise<void> {
  const el = entry.el;
  entry.pendingSeekSec = null;
  // Dedupe on the element's ACTUAL head — bookkeeping like lastRequestedSec
  // can be set by cache-hit paths that never moved the element.
  if (!el.seeking && Math.abs(el.currentTime - targetSec) < SEEK_BIAS_SEC + 0.0005) {
    return Promise.resolve(); // already delivered this exact frame
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(deadline);
      el.removeEventListener("seeked", onSeeked);
      resolve();
    };
    const onDeadline = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("seeked", onSeeked);
      if (attempt === 0) {
        console.warn(`[${identity.ns}] video seek to ${targetSec.toFixed(3)}s stalled — retrying once`);
        resolve(seekExact(entry, targetSec, 1));
      } else {
        console.warn(`[${identity.ns}] video seek to ${targetSec.toFixed(3)}s stalled twice — using current frame`);
        resolve();
      }
    };
    const deadline = window.setTimeout(onDeadline, 2000);
    const onSeeked = () => {
      const rvfc = (el as VideoWithRvfc).requestVideoFrameCallback;
      // rVFC needs the compositor; in a hidden tab it never fires, and
      // `seeked` alone already guarantees the frame drawImage will read.
      if (typeof rvfc === "function" && document.visibilityState !== "hidden") {
        const fallback = window.setTimeout(finish, 120);
        rvfc.call(el, () => {
          window.clearTimeout(fallback);
          finish();
        });
      } else {
        finish();
      }
    };
    el.addEventListener("seeked", onSeeked, { once: true });
    issueSeek(entry, targetSec);
  });
}

/**
 * Deliver exact frames for every video visible in `frame` at `timeMs` —
 * stepped exports call this before drawing each output frame. Waits for
 * element readiness too, so the first frames never ship placeholders.
 *
 * Deliberately seek-per-frame, no play-through fast path: letting the element
 * roll and pausing "at" the target races the decoder (rVFC fires, the element
 * advances another frame before pause lands, the canvas grabs the wrong
 * picture — tried twice, reverted twice). Deterministic beats fast here.
 */
export async function prepareVideoFramesForExport(
  doc: MotionDocument,
  frame: Frame,
  timeMs: number,
): Promise<void> {
  const sequences: SequenceTarget[] = [];
  const targets = collectVideoTargets(doc, frame, timeMs, 1, [], new Set([frame.id]), undefined, sequences);
  await Promise.all(sequences.map((q) => awaitSequenceFrame(q.assetId, q.index)));
  await Promise.all(
    targets.map(async (t) => {
      const targetSec = t.targetMs / 1000;

      // Export NEVER reads the preview cache: cells may serve a neighboring
      // source frame (fine at preview, wrong in a render) and may be
      // downscaled. Every export frame is an exact, verified seek.
      const el = await ensureVideoReady(t.clipId, t.assetId);
      if (!el) {
        console.warn(`[${identity.ns}] video for clip ${t.clipId} never became ready — exporting without it`);
        return;
      }
      const entry = videos.get(t.clipId);
      if (!entry) return;
      el.pause();
      setLatch(entry, null); // the element itself is this frame's source
      // Clamped like preview: a frozen tail exports the last real frame, and
      // every following tail frame dedupes into a zero-cost repeat seek.
      await seekExact(entry, clampToMedia(el, targetSec));
    }),
  );
}

/**
 * Manually cache a clip's ENTIRE footprint (right-click → "Cache clip now"),
 * walking its source cells in ASCENDING order — the optimal decode direction
 * regardless of how the clip plays them back: reverse, loops and ping-pong
 * all read from the same forward-decoded cells. Returns "busy" if playback,
 * a scrub or an export took the element back.
 */
let manualCacheJobId: string | null = null;

export interface CacheClipResult {
  status: "done" | "busy" | "playing" | "off";
  /** Cells banked by THIS run. */
  cached: number;
  /** Cells that were already covered. */
  already: number;
}

export async function cacheClipFootprint(
  doc: MotionDocument,
  clipId: string,
  /**
   * A caller's "hand the element back NOW" — a background caller passes
   * one that trips on any playhead movement. The job borrows the element, and
   * a borrowed element is not conducted: scrubbing during a fill moved nothing
   * on screen until the job happened to finish.
   */
  shouldStop: () => boolean = () => false,
): Promise<CacheClipResult> {
  const result: CacheClipResult = { status: "done", cached: 0, already: 0 };
  if (manualCacheJobId !== null) return { ...result, status: "busy" }; // one job at a time
  let clip: VideoClip | NestedClip | null = null;
  for (const track of doc.tracks) {
    for (const c of track.clips) {
      if (c.id === clipId && (c.kind === "video" || c.kind === "nested")) clip = c;
    }
  }
  if (!clip) return result;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // Build the work list: every video this clip's footprint shows (itself, or
  // the whole subtree of a nested comp), with the source cells each one uses
  // — mapped through every playback layer, then decoded in ASCENDING order.
  const jobs = new Map<string, { assetId: string; cells: Set<number> }>();
  const addCell = (id: string, assetId: string, sourceMs: number, maxSourceMs: number | null) => {
    let job = jobs.get(id);
    if (!job) {
      job = { assetId, cells: new Set() };
      jobs.set(id, job);
    }
    const clamped = maxSourceMs !== null ? Math.min(sourceMs, maxSourceMs) : sourceMs;
    job.cells.add(cellOf(Math.max(0, clamped) / 1000));
  };
  const stepMs = (PREVIEW_CELL_SEC * 500) / Math.max(1, clip.playback.speed); // half-cell — never skips
  if (clip.kind === "video") {
    setClipCachePolicy(clipId, clip.cachePolicy);
    const asset = doc.assets.find((a) => a.id === clip.assetId);
    const maxSrc = asset?.durationMs != null ? Math.max(0, asset.durationMs - 34) : null;
    for (let local = 0; local <= clip.durationMs; local += stepMs) {
      addCell(clipId, clip.assetId, clipSourceMs(doc, clip, local), maxSrc);
    }
  } else {
    const source = doc.frames.find((f) => f.id === clip.sourceFrameId);
    if (!source) return result;
    for (let local = 0; local <= clip.durationMs; local += stepMs) {
      const inner = clipSourceMs(doc, clip, local);
      for (const t of collectVideoTargets(doc, source, inner, 1, [], new Set([source.id]), clip.cachePolicy)) {
        setClipCachePolicy(t.clipId, t.cachePolicy);
        addCell(t.clipId, t.assetId, t.targetMs, t.maxSourceMs);
      }
    }
  }

  try {
    for (const [innerId, job] of jobs) {
      if (!mediaCachingAllowed(innerId)) continue;
      const el = await ensureVideoReady(innerId, job.assetId);
      const entry = videos.get(innerId);
      if (!el || !entry) return { ...result, status: "busy" };
      // Pin the on-screen picture into the latch BEFORE taking the head: from
      // here until the `finally` below, the latch is the only thing this clip
      // can paint, so it has to already hold the frame the user is looking at.
      // Sharp, too — the snapshot comes off the element, where a cached cell
      // for a source wider than CAPTURE_MAX_WIDTH would be downscaled.
      await snapshotLatch(entry);
      manualCacheJobId = innerId; // one job at a time
      entry.borrowed = true; // sticky for the whole job, not one seek

      // Wait out TRANSIENT owners (a settling seek) — only real playback or
      // an export genuinely takes the element away.
      const waitElementFree = async (): Promise<"free" | "playing" | "taken"> => {
        for (let i = 0; i < 40; i++) {
          if (mediaLocked) return "taken";
          if (isTransportPlaying() || shouldStop()) return "playing";
          if (el.paused && !el.seeking) return "free";
          if (!el.paused && !entry.fillRolling) return "playing"; // transport runs
          await sleep(50);
        }
        return "taken";
      };

      // Group the missing cells into contiguous RUNS and PLAY THROUGH each
      // one (muted, 2×) — the same free banking playback gets, so a manual
      // cache is FASTER than playing, never slower than seeking frame by
      // frame. The rolling capture banks every presented frame.
      const sorted = [...job.cells].sort((a, b) => a - b);
      const runs: Array<{ start: number; end: number }> = [];
      for (const cell of sorted) {
        if (proxyFrames.has(proxyKey(innerId, cell))) {
          result.already++;
          continue;
        }
        const last = runs[runs.length - 1];
        if (last && cell - last.end <= 2) last.end = cell;
        else runs.push({ start: cell, end: cell });
      }

      const stopFill = () => {
        el.pause();
        entry.fillRolling = false;
      };
      for (const run of runs) {
        const free = await waitElementFree();
        if (free !== "free") return { ...result, status: free === "playing" ? "playing" : "busy" };
        const startSec = clampToMedia(el, run.start * PREVIEW_CELL_SEC);
        const endSec = clampToMedia(el, (run.end + 1) * PREVIEW_CELL_SEC);
        try {
          await seekExact(entry, startSec);
          if (mediaLocked) return { ...result, status: "busy" };
          el.playbackRate = 2;
          entry.fillRolling = true; // draws keep the latch; this is a decoder
          void el.play().catch(() => undefined);
          ensureRollingCapture(entry);
          const deadline = performance.now() + ((endSec - startSec) / 2) * 1000 + 4000;
          while (true) {
            await sleep(60);
            ensureRollingCapture(entry); // self-heals if the loop dropped
            if (mediaLocked) {
              stopFill();
              return { ...result, status: "busy" };
            }
            if (isTransportPlaying() || shouldStop()) {
              stopFill();
              return { ...result, status: "playing" };
            }
            if (el.ended || (el.paused && !el.seeking)) break; // ran out / taken
            if (el.currentTime >= endSec - 0.001) break;
            if (performance.now() > deadline) break;
          }
        } finally {
          stopFill();
        }
      }
      // Encodes land async — settle briefly, then count what actually banked.
      await sleep(200);
      entry.borrowed = false; // done with this element — hand the head back
      let present = 0;
      for (const cell of sorted) if (proxyFrames.has(proxyKey(innerId, cell))) present++;
      result.cached += Math.max(0, present - result.already);
    }
    if (jobs.size === 0) return { ...result, status: "off" };
    console.info(
      `[${identity.ns}] cache clip ${clipId}: banked ${result.cached} new frames (${result.already} already cached)`,
    );
    return result;
  } finally {
    // Backstop: the normal path releases each element as its job finishes, but
    // every early return above lands here too — a borrow that outlived its job
    // would freeze the clip on its latch for good.
    for (const innerId of jobs.keys()) {
      const entry = videos.get(innerId);
      if (entry) entry.borrowed = false;
    }
    manualCacheJobId = null;
    parkIdleElements(); // play-start must find elements at the playhead
  }
}

// ── The media producer ──────────────────────────────────────────────────────

/**
 * OFF MEANS OFF: the decoded tier drops to what is on screen; proxies stop
 * being read or written (`mediaCachingAllowed`), and are purged outright only
 * by an explicit purge — they are the cheap, durable tier a person would be
 * annoyed to rebuild after flicking a switch to compare.
 */
let footageWasOn = cacheSettings().media;
subscribeCacheStatus(() => {
  const on = cacheSettings().media;
  if (footageWasOn && !on) trimFrameCacheToLatched();
  footageWasOn = on;
});

/** Every decoded frame and proxy, for every clip — the latches stay. */
function purgeMediaCache(): void {
  trimFrameCacheToLatched();
  for (const clipId of new Set([...proxyFrames.keys()].map((k) => k.slice(0, k.lastIndexOf(":"))))) {
    proxyDropClip(clipId);
    dropSubjectCoverage(mediaSubject(clipId));
  }
  notifyBanked();
}

registerCacheProducer({
  id: "media",
  label: "Decoded footage",
  order: 1,
  stats: () => ({
    bytes: frameCacheBytes + proxyBytes,
    budget: FRAME_CACHE_MAX_BYTES() + PROXY_MAX_BYTES(),
  }),
  purge: purgeMediaCache,
  independent: true,
});


