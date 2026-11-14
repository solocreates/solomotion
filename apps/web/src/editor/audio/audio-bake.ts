import * as React from "react";
import {
  audioKeepsPitch,
  pitchShift,
  resampleChannel,
  timeStretch,
  type AudioClip,
  type MediaAudioSegment,
} from "@solomotion/core";
import { ensureAudioBuffer } from "./waveform";

/**
 * The offline audio BAKE — THE one place a heavy audio occurrence (reverse,
 * pitch shift, keep-pitch under speed) becomes a finished PCM buffer. It's
 * SPEC-based, not clip-based, so it composes at ANY nesting depth: the caller
 * hands it a `AudioBakeSpec` describing the FINAL time/pitch after folding in
 * every ancestor nested clip's speed, and gets one buffer for that exact
 * output. Top-level clips, a voice 10 comps deep, and export all reduce to the
 * same spec → the same cached bake → the same sound.
 *
 * The buffer is the occurrence's output at rate 1.0 over `outputDurationMs`; EQ
 * and level stay downstream (cheap, keyframable). Keyed by the spec signature,
 * reused until a factor changes. Source decode reuses the shared waveform cache.
 */

export interface AudioBakeSpec {
  assetId: string;
  /** Source start (ms) — where in the file this occurrence begins. */
  trimInMs: number;
  /** Output wall duration (ms) at rate 1.0. */
  outputDurationMs: number;
  /** Cumulative source-per-output rate (clip speed × every ancestor's speed). */
  speed: number;
  reverse: boolean;
  /** Hold pitch under `speed` (time-stretch) vs let it tape-shift (resample). */
  keepPitch: boolean;
  pitchSemitones: number;
}

/** The spec for a top-level clip (its own speed, no ancestors). */
export function clipBakeSpec(clip: AudioClip): AudioBakeSpec {
  return {
    assetId: clip.source.type === "asset" ? clip.source.assetId : "",
    trimInMs: clip.trimInMs,
    outputDurationMs: clip.durationMs,
    speed: clip.playback.speed,
    reverse: clip.playback.reverse,
    keepPitch: audioKeepsPitch(clip),
    pitchSemitones: clip.pitchSemitones,
  };
}

/** The spec for an audio segment from the inventory — CUMULATIVE speed already
 * folds in every ancestor nested clip, so effects compose at any depth. */
export function segmentBakeSpec(seg: MediaAudioSegment): AudioBakeSpec {
  const clip = seg.clip;
  const audio = clip.kind === "audio" ? clip : null;
  return {
    assetId: seg.assetId,
    trimInMs: seg.trimInMs,
    outputDurationMs: seg.outputDurationMs,
    speed: seg.speed,
    reverse: audio ? audio.playback.reverse : false,
    keepPitch: audio ? audioKeepsPitch(audio) : true,
    pitchSemitones: audio ? audio.pitchSemitones : 0,
  };
}

/** Whether a spec needs any offline processing at all (else it's a plain read). */
export function specIsHeavy(s: AudioBakeSpec): boolean {
  return s.reverse || s.pitchSemitones !== 0 || (s.keepPitch && Math.abs(s.speed - 1) > 1e-3);
}

/** Whether a spec needs a bake for LIVE playback — the media element already
 * keeps pitch under any playbackRate, so live only bakes what it can't do. */
export function specIsHeavyLive(s: AudioBakeSpec): boolean {
  return s.reverse || s.pitchSemitones !== 0;
}

export function bakeSignature(s: AudioBakeSpec): string {
  return [
    s.assetId,
    `t${Math.round(s.trimInMs)}`,
    `d${Math.round(s.outputDurationMs)}`,
    `s${s.speed.toFixed(4)}`,
    s.reverse ? "rev" : "fwd",
    s.keepPitch ? "kp" : "tape",
    `p${s.pitchSemitones}`,
  ].join("|");
}

type BakeEntry = { buffer: AudioBuffer | null; promise: Promise<AudioBuffer | null> };
const bakes = new Map<string, BakeEntry>();
const readyListeners = new Set<() => void>();
let version = 0;

/**
 * ── SETTLE, THEN BAKE ────────────────────────────────────────────────────────
 *
 * A bake is a full-file WSOLA pass on the main thread — tens to hundreds of
 * milliseconds for a real recording. That is a fine price for ONE value and a
 * frozen browser for a drag, because a drag does not ask for one value: pulling
 * pitch from −12 to +12 asks for every value in between, each a different
 * signature, each a cache MISS, each its own full-file stretch. The tab locks
 * up and the sound you were reaching for arrives last, behind fifty you passed
 * through.
 *
 * So the debounce lives HERE rather than on the slider. The slider is not the
 * only writer — a node driver, a pasted property, an undo and record mode all
 * move the same value — and none of them should have to know that pitch is
 * expensive. One quiet-period gate at the seam covers all of them, and every
 * expensive spec that ships later inherits it.
 *
 * Coalesced PER ASSET, which is the honest grain: a superseded request for the
 * same source is a value you dragged THROUGH, so computing it is pure waste,
 * while two different sources are two independent answers and must not cancel
 * each other. A cache hit still returns instantly and never waits — the gate
 * only ever delays work that does not exist yet.
 */
const SETTLE_MS = 160;
type Pending = { sig: string; timer: ReturnType<typeof setTimeout>; start: () => void };
const pending = new Map<string, Pending>();

function scheduleBake(assetId: string, sig: string, start: () => void): void {
  const prev = pending.get(assetId);
  if (prev) {
    if (prev.sig === sig) return; // already waiting on exactly this
    clearTimeout(prev.timer);
  }
  const timer = setTimeout(() => {
    pending.delete(assetId);
    start();
  }, SETTLE_MS);
  pending.set(assetId, { sig, timer, start });
}

/** Run a scheduled bake NOW — for callers that cannot wait (the exporter). */
function flushBake(assetId: string, sig: string): void {
  const prev = pending.get(assetId);
  if (!prev || prev.sig !== sig) return;
  clearTimeout(prev.timer);
  pending.delete(assetId);
  prev.start();
}

/** Subscribe to "a bake finished" (UI can repaint cache bars / re-conduct). */
export function onBakeReady(cb: () => void): () => void {
  readyListeners.add(cb);
  return () => readyListeners.delete(cb);
}

function fireReady(): void {
  version++;
  for (const cb of readyListeners) cb();
}

/** Reactive counter — bumps whenever a bake finishes, so a clip badge repaints. */
export function useBakeVersion(): number {
  return React.useSyncExternalStore(
    (cb) => onBakeReady(cb),
    () => version,
    () => 0,
  );
}

// ── Spec-keyed cache (the one store; clip/segment helpers below wrap it) ──────

export function getSpecBake(spec: AudioBakeSpec): AudioBuffer | null {
  return bakes.get(bakeSignature(spec))?.buffer ?? null;
}

/** Start the work for a signature and file it in the cache. Idempotent. */
function beginBake(spec: AudioBakeSpec, sig: string): BakeEntry {
  const existing = bakes.get(sig);
  if (existing) return existing;
  const entry: BakeEntry = { buffer: null, promise: Promise.resolve(null) };
  bakes.set(sig, entry);
  entry.promise = bakeSpec(spec).then((buf) => {
    entry.buffer = buf;
    fireReady();
    return buf;
  });
  if (bakes.size > 96) {
    const oldest = bakes.keys().next().value;
    if (oldest && oldest !== sig) bakes.delete(oldest);
  }
  return entry;
}

export function ensureSpecBake(spec: AudioBakeSpec): AudioBuffer | null {
  if (!spec.assetId) return null;
  const sig = bakeSignature(spec);
  const hit = bakes.get(sig);
  if (hit) return hit.buffer;
  // Not cached: wait for the value to settle. `fireReady` wakes every caller
  // when it lands, so nothing here has to poll.
  scheduleBake(spec.assetId, sig, () => void beginBake(spec, sig));
  return null;
}

export async function ensureSpecBakeAsync(spec: AudioBakeSpec): Promise<AudioBuffer | null> {
  if (!spec.assetId) return null;
  const sig = bakeSignature(spec);
  const hit = bakes.get(sig);
  if (hit) return hit.buffer ?? hit.promise;
  // An awaited caller has committed to this exact spec — it is not passing
  // through it — so the quiet period has nothing left to save. Skip it.
  flushBake(spec.assetId, sig);
  return beginBake(spec, sig).promise;
}

// ── Clip-facing wrappers (badge, export, render-in-place) ─────────────────────

export function getClipBake(clip: AudioClip): AudioBuffer | null {
  return getSpecBake(clipBakeSpec(clip));
}
export function hasClipBake(clip: AudioClip): boolean {
  return !!getClipBake(clip);
}
export function ensureClipBake(clip: AudioClip): AudioBuffer | null {
  if (clip.source.type !== "asset") return null;
  return ensureSpecBake(clipBakeSpec(clip));
}
export function ensureClipBakeAsync(clip: AudioClip): Promise<AudioBuffer | null> {
  if (clip.source.type !== "asset") return Promise.resolve(null);
  return ensureSpecBakeAsync(clipBakeSpec(clip));
}

/** Render one spec's processed output to an AudioBuffer. Extracts the consumed
 * source window (reversed if asked), stretches (keep pitch) or resamples (tape)
 * to the output length, then pitch-shifts. Loop is approximated forward. */
export async function bakeSpec(spec: AudioBakeSpec): Promise<AudioBuffer | null> {
  if (!spec.assetId) return null;
  const src = await ensureAudioBuffer(spec.assetId);
  if (!src) return null;

  const sr = src.sampleRate;
  const speed = Math.max(0.01, spec.speed);
  const consumedSec = (spec.outputDurationMs / 1000) * speed;
  const startSample = Math.round((spec.trimInMs / 1000) * sr);
  const winLen = Math.max(1, Math.round(consumedSec * sr));

  const nCh = src.numberOfChannels;
  let channels: Float32Array[] = [];
  for (let c = 0; c < nCh; c++) {
    const data = src.getChannelData(c);
    const win = new Float32Array(winLen);
    for (let i = 0; i < winLen; i++) {
      const j = startSample + i;
      win[i] = j >= 0 && j < data.length ? data[j]! : 0;
    }
    if (spec.reverse) win.reverse();
    channels.push(win);
  }

  const targetLen = Math.max(1, Math.round((spec.outputDurationMs / 1000) * sr));
  if (spec.keepPitch) channels = timeStretch(channels, targetLen / winLen);
  else channels = channels.map((ch) => resampleChannel(ch, targetLen));
  if (spec.pitchSemitones !== 0) channels = pitchShift(channels, spec.pitchSemitones);

  const ctx = new OfflineAudioContext(nCh, Math.max(1, channels[0]?.length ?? targetLen), sr);
  const out = ctx.createBuffer(nCh, channels[0]?.length ?? targetLen, sr);
  for (let c = 0; c < nCh; c++) out.getChannelData(c).set(channels[c] ?? new Float32Array(targetLen));
  return out;
}

/** Back-compat wrapper — bake a clip's own output. */
export function bakeProcessedClip(clip: AudioClip): Promise<AudioBuffer | null> {
  if (clip.source.type !== "asset") return Promise.resolve(null);
  return bakeSpec(clipBakeSpec(clip));
}

/** Drop every cached bake (asset relink / project switch). */
export function clearAudioBakes(): void {
  bakes.clear();
}
