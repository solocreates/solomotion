"use client";

import {
  SOUND_PEAK_RATE,
  audioGainAt,
  segmentCrossfadeAt,
  collectCompMedia,
  peakTable,
  peaksFromSamples,
  windowPeaks,
  type MotionDocument,
  type ClipPlayback,
  type NestedClip,
} from "@solomotion/core";
import { getAssetBlob, onAssetBytesChanged } from "../assets/asset-store";

/**
 * A fixed-resolution max-abs peak table over SOURCE time (buckets/second),
 * cached per asset. This is the mip that makes the timeline waveform STEADY
 * while trimming: peaks are baked against the immutable source, so changing a
 * clip's width/trim just windows into the same table — the drawn bars no
 * longer flicker as the bin count and sparse-sample stride shift underneath a
 * live gesture (the old per-frame re-scan of raw samples caused that jitter).
 */
const SOURCE_PEAK_RES = SOUND_PEAK_RATE; // buckets per second (2.5 ms) — smooth at any zoom
const sourcePeakTables = new Map<string, Float32Array>();

/** The asset's peak table — core's `peakTable`, the same one a sound's analysis carries. */
function sourcePeakTable(assetId: string, buffer: AudioBuffer): Float32Array {
  const cached = sourcePeakTables.get(assetId);
  if (cached) return cached;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const table = peakTable(channels, buffer.sampleRate, SOURCE_PEAK_RES);
  sourcePeakTables.set(assetId, table);
  return table;
}

/** Max peak over a source-time span [fromMs, toMs) read from the fixed table. */
function peakOverSource(table: Float32Array, fromMs: number, toMs: number): number {
  const b0 = Math.max(0, Math.floor((fromMs / 1000) * SOURCE_PEAK_RES));
  const b1 = Math.min(table.length, Math.ceil((toMs / 1000) * SOURCE_PEAK_RES));
  let max = 0;
  for (let b = b0; b < b1; b++) if (table[b]! > max) max = table[b]!;
  // A zero-width or out-of-range span still reads its nearest bucket.
  return b1 <= b0 ? table[Math.min(table.length - 1, Math.max(0, b0))] ?? 0 : max;
}

/**
 * Gain-aware clip peaks for the timeline strip — built on the EXACT primitive
 * the waveform visualizer renders through (core `windowPeaks` over core
 * `peakTable`, mapped through the clip's playback). ONE foundation, so the
 * strip and the visualizer can never disagree: speed, trim, loop and reverse all
 * show truthfully and the wave fills the clip edge-to-edge, in sync with the
 * sound. The strip-only step is scaling each column by the volume envelope so
 * fades taper and louder sections stand taller. `gainAt` is clip-local wall-ms →
 * 0..n multiplier.
 *
 * The raw shape is memoized per (asset + playback window + bins), so it's
 * computed ONCE per clip-sound change and remembered — repaints for a moved
 * playhead, a gain tweak or an unrelated re-render reuse it (the envelope is
 * re-applied cheaply on top). Bounded LRU keeps it scalable across many clips.
 */
const stripShapeCache = new Map<string, Float32Array>();

function stripShapeKey(assetId: string, bins: number, trimInMs: number, durationMs: number, playback: ClipPlayback): string {
  return [
    assetId,
    `n${bins}`,
    `t${Math.round(trimInMs)}`,
    `d${Math.round(durationMs)}`,
    `s${(playback.speed > 0 ? playback.speed : 1).toFixed(4)}`,
    playback.loop,
    playback.reverse ? "rev" : "fwd",
    `L${playback.loopLengthMs ?? ""}`,
  ].join("|");
}

function stripShapePeaks(
  assetId: string,
  buffer: AudioBuffer,
  bins: number,
  trimInMs: number,
  durationMs: number,
  playback: ClipPlayback,
): Float32Array {
  const key = stripShapeKey(assetId, bins, trimInMs, durationMs, playback);
  const hit = stripShapeCache.get(key);
  if (hit) return hit;
  const peaks = windowPeaks(sourcePeakTable(assetId, buffer), SOURCE_PEAK_RES, buffer.duration * 1000, { trimInMs, playback }, 0, durationMs, bins, durationMs);
  stripShapeCache.set(key, peaks);
  if (stripShapeCache.size > 256) {
    const oldest = stripShapeCache.keys().next().value;
    if (oldest && oldest !== key) stripShapeCache.delete(oldest);
  }
  return peaks;
}

export function clipStripPeaks(
  assetId: string,
  buffer: AudioBuffer,
  bins: number,
  trimInMs: number,
  durationMs: number,
  playback: ClipPlayback,
  gainAt: (localMs: number) => number,
): Float32Array {
  const shape = stripShapePeaks(assetId, buffer, bins, trimInMs, durationMs, playback);
  const binWallMs = durationMs / bins;
  const peaks = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    peaks[b] = Math.min(1, shape[b]! * gainAt((b + 0.5) * binWallMs));
  }
  return peaks;
}

/** Max source-time peak of an asset over [fromMs, toMs) — reuses the fixed table. */
export function assetPeakOver(assetId: string, buffer: AudioBuffer, fromMs: number, toMs: number): number {
  return peakOverSource(sourcePeakTable(assetId, buffer), fromMs, toMs);
}

/**
 * REAL summed timeline peaks for an audio-only nested clip — reuses the export
 * inventory (`collectCompMedia` on the SOURCE comp, nested-recursive, in
 * source-comp time) so a nested stack of voices draws a true waveform instead of
 * a placeholder. Each column maps the nested clip's local wall time down to the
 * source comp, picks whichever segments sound there, and takes the max peak
 * (level-aware). Forward map (loop/reverse approximated, like export).
 */
export function nestedClipPeaks(doc: MotionDocument, nested: NestedClip, bins: number): Float32Array {
  const peaks = new Float32Array(bins);
  if (bins <= 0) return peaks;
  const segments = collectCompMedia(doc, nested.sourceFrameId);
  if (segments.length === 0) return peaks;
  const binWallMs = nested.durationMs / bins;
  const speed = nested.playback.speed > 0 ? nested.playback.speed : 1;
  for (let b = 0; b < bins; b++) {
    const srcCompMs = nested.trimInMs + (b + 0.5) * binWallMs * speed;
    let peak = 0;
    for (const seg of segments) {
      const localOut = srcCompMs - seg.atMs;
      if (localOut < 0 || localOut >= seg.outputDurationMs) continue;
      const buffer = getAudioBufferForAsset(seg.assetId);
      if (!buffer) continue;
      const sourcePos = seg.trimInMs + localOut * seg.speed;
      const win = Math.max(1, binWallMs * seg.speed);
      const raw = assetPeakOver(seg.assetId, buffer, sourcePos - win / 2, sourcePos + win / 2);
      const clipLocal = (sourcePos - seg.clip.trimInMs) / (seg.clip.playback.speed || 1);
      const level =
        raw *
        seg.gainScale *
        (seg.clip.kind === "audio" ? audioGainAt(seg.clip, clipLocal) : 1) *
        segmentCrossfadeAt(seg, clipLocal);
      if (level > peak) peak = level;
    }
    peaks[b] = Math.min(1, peak);
  }
  return peaks;
}

/**
 * THE waveform module — one decode cache and one painter for every surface
 * that shows audio: timeline clips, the custom-sound hit picker, and the live
 * cue player all read the same decoded buffers and draw through the same
 * function. Peaks are max-abs per bin, resampled from the decoded data.
 */

const buffers = new Map<string, AudioBuffer | "loading" | "error">();
const bufferWaiters = new Map<string, Array<(b: AudioBuffer | null) => void>>();
const readyListeners = new Set<() => void>();

// New bytes under an id (a relink, a restore) are a new sound: decode again —
// a failure, above all, must not outlive the file that caused it.
onAssetBytesChanged((id) => {
  if (buffers.get(id) !== "loading") buffers.delete(id);
});

/** Fires when a pending decode lands (repaint waveforms). */
export function onAudioBufferReady(cb: () => void): () => void {
  readyListeners.add(cb);
  return () => readyListeners.delete(cb);
}

let sharedCtx: AudioContext | null = null;
function decodeCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  sharedCtx ??= new (window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  return sharedCtx;
}

/** Synchronous cache hit; a miss kicks off the decode and returns null. */
export function getAudioBufferForAsset(assetId: string): AudioBuffer | null {
  const hit = buffers.get(assetId);
  if (hit instanceof AudioBuffer) return hit;
  if (hit === "loading" || hit === "error") return null;
  buffers.set(assetId, "loading");
  void (async () => {
    try {
      const blob = await getAssetBlob(assetId);
      const ctx = decodeCtx();
      if (!blob || !ctx) throw new Error("no blob");
      const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
      buffers.set(assetId, buffer);
      for (const cb of readyListeners) cb();
      for (const w of bufferWaiters.get(assetId) ?? []) w(buffer);
    } catch {
      buffers.set(assetId, "error");
      for (const w of bufferWaiters.get(assetId) ?? []) w(null);
    }
    bufferWaiters.delete(assetId);
  })();
  return null;
}

/** Await the decoded buffer (dialogs, preview). */
export function ensureAudioBuffer(assetId: string): Promise<AudioBuffer | null> {
  const hit = getAudioBufferForAsset(assetId);
  if (hit) return Promise.resolve(hit);
  if (buffers.get(assetId) === "error") return Promise.resolve(null);
  return new Promise((resolve) => {
    const list = bufferWaiters.get(assetId) ?? [];
    list.push(resolve);
    bufferWaiters.set(assetId, list);
  });
}

/**
 * Max-abs peaks, `bins` values in 0..1, over [fromSec, toSec] of the buffer.
 * The binning itself lives in core (`peaksFromSamples`) because a published
 * waveform and a decoded one must be the same shape — otherwise a sound
 * visibly changes the moment you download it.
 */
export function waveformPeaks(
  buffer: AudioBuffer,
  bins: number,
  fromSec = 0,
  toSec = buffer.duration,
): Float32Array {
  return peaksFromSamples(
    buffer.getChannelData(0),
    bins,
    fromSec * buffer.sampleRate,
    toSec * buffer.sampleRate,
  );
}

/** Paint peaks as a mirrored bar waveform into a rect. */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  peaks: Float32Array,
  rect: { x: number; y: number; w: number; h: number },
  color: string,
): void {
  const mid = rect.y + rect.h / 2;
  ctx.fillStyle = color;
  const barW = rect.w / peaks.length;
  for (let i = 0; i < peaks.length; i++) {
    const h = Math.max(1, peaks[i]! * rect.h * 0.94);
    ctx.fillRect(rect.x + i * barW, mid - h / 2, Math.max(0.5, barW - 0.75), h);
  }
}
