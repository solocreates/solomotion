"use client";

import * as React from "react";
import { installSpeechReader, mediaAssetOf, noteSpeechChanged, type Asset, type MotionDocument } from "@solomotion/core";
import {
  runSpeechEngine,
  speechCacheKey,
  speechEngine,
  listSpeechEngines,
  type SpeechEngine,
  type SpeechInput,
  type SpeechSettings,
  type SpeechTrack,
  type SpeechWord,
  type SynthesisResult,
} from "@solomotion/lipsync";
import { ensureAudioBuffer } from "../audio/waveform";
import { peekDoc } from "../state/document-context";
import { hashText, loadTrack, loadWords, peekTrack, saveTrack, saveWords } from "./track-cache";
import { NAMES } from "@/editor/names";

/**
 * THE SPEECH HOST — what core's `readSpeechTrack` reaches in the app.
 *
 * A read answers from memory or returns null and queues the job: plan (which
 * engine, with which input) → cache (IDB) → decode → engine (lazy chunk) →
 * cache → install → `noteSpeechChanged()` (every bake re-keys) → listeners
 * (the stage drops its exact pictures, the Voice section and the timeline
 * repaint). Nothing here runs per frame; each (asset, choice, script) is
 * planned once.
 *
 * AUTO, best first (align measured 96% vs spectral 37% on the package's
 * harness):
 *   1. KNOWN — a Test Voice line: re-synthesised from its own text, exact.
 *   2. WORDS — timed words we already have (a TTS's alignment, a past
 *      transcription) or a known script (`asset.speech.text`, a TTS prompt).
 *   3. TRANSCRIBE — a transcription connection gives timed words (paid once,
 *      cached), then 2.
 *   4. LISTEN — the offline spectral analyser.
 * A named engine runs as named; one missing its input falls back to Listen
 * with a note the Voice section shows.
 */

/** `origin.provider` of a Test Voice asset — how Auto knows its mouth is exact. */
export const TEST_VOICE_PROVIDER = NAMES.ids.testVoiceProvider;
export const TEST_VOICE_MODEL = "test-voice";

export type SpeechState = "listening" | "ready" | "failed";
export interface SpeechStatus {
  state: SpeechState;
  progress: number;
  /** The engine that produced (or is producing) the track. */
  engine: string;
  note?: string;
}

const status = new Map<string, SpeechStatus>();
const planned = new Map<string, string>(); // plan key → track cache key
const inflight = new Map<string, Promise<SpeechTrack | null>>();
/** Plans that failed — not retried by reads (a frame must not re-queue a broken file); "Try again" forces. */
const failed = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** A track landed or a status moved — what the Voice section and the timeline repaint on. */
export function onSpeechChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * A TRACK landed — the only speech event that changes a picture. The stage
 * used to listen to every status move instead, so an analysis reporting its
 * progress every 2% threw away every cached frame fifty times over.
 */
const trackListeners = new Set<() => void>();
export function onSpeechTrack(cb: () => void): () => void {
  trackListeners.add(cb);
  return () => trackListeners.delete(cb);
}
function trackLanded(): void {
  noteSpeechChanged();
  for (const l of trackListeners) l();
  emit();
}

export function speechStatusOf(assetId: string): SpeechStatus | null {
  return status.get(assetId) ?? null;
}

export function useSpeechStatus(assetId: string | null): SpeechStatus | null {
  // The status itself is the snapshot (the map keeps one object per status),
  // so it reaches the render through the subscription.
  const read = () => (assetId ? speechStatusOf(assetId) : null);
  return React.useSyncExternalStore(onSpeechChange, read, read);
}

function setStatus(assetId: string, s: SpeechStatus, loud = true): void {
  status.set(assetId, s);
  if (loud) emit();
}

const assetOf = (assetId: string): Asset | undefined => peekDoc()?.assets.find((a) => a.id === assetId);
const choiceOf = (asset: Asset | undefined, engine?: string) => engine ?? asset?.speech?.engine ?? "auto";
const knownText = (asset: Asset | undefined): string | undefined =>
  asset?.speech?.text?.trim() || (asset?.origin?.capability === "speech" ? asset.origin.prompt.trim() : undefined) || undefined;
const planKeyOf = (assetId: string, asset: Asset | undefined, choice: string) => `${assetId}|${choice}|${hashText(knownText(asset) ?? "")}`;
const isTestVoice = (asset: Asset | undefined) => asset?.origin?.provider === TEST_VOICE_PROVIDER && asset.origin.model.startsWith(TEST_VOICE_MODEL);
/** A Test Voice asset's preset, from its model id (`test-voice:bright`). */
const testPresetOf = (asset: Asset | undefined) => asset?.origin?.model.split(":")[1] ?? "warm";

/** The track already in memory for an asset (its current choice) — no request. */
export function peekSpeechTrack(assetId: string, engine?: string): SpeechTrack | null {
  const asset = assetOf(assetId);
  const key = planned.get(planKeyOf(assetId, asset, choiceOf(asset, engine)));
  return key ? peekTrack(key) : null;
}

/** The synchronous reader core asks. Null = pending, and the job is queued. */
function read(assetId: string, engine?: string): SpeechTrack | null {
  const hit = peekSpeechTrack(assetId, engine);
  if (hit) return hit;
  const asset = assetOf(assetId);
  if (!failed.has(planKeyOf(assetId, asset, choiceOf(asset, engine)))) void ensureSpeechTrack(assetId, engine);
  return null;
}

/**
 * The track for an asset under its (or a named) engine choice — cached,
 * deduplicated, or analysed now. `force` re-runs the analysis.
 */
export function ensureSpeechTrack(assetId: string, engine?: string, opts: { force?: boolean } = {}): Promise<SpeechTrack | null> {
  const asset = assetOf(assetId);
  const choice = choiceOf(asset, engine);
  const pk = planKeyOf(assetId, asset, choice);
  if (!opts.force) {
    const key = planned.get(pk);
    const hit = key ? peekTrack(key) : null;
    if (hit) return Promise.resolve(hit);
    const running = inflight.get(pk);
    if (running) return running;
  }
  failed.delete(pk);
  const job = analyse(assetId, asset, choice, !!opts.force)
    .then((r) => {
      if (!r) return null;
      planned.set(pk, r.key);
      setStatus(assetId, { state: "ready", progress: 1, engine: r.track.engine, ...(r.note ? { note: r.note } : {}) }, false);
      trackLanded();
      return r.track;
    })
    .catch((e: unknown) => {
      failed.add(pk);
      setStatus(assetId, { state: "failed", progress: 0, engine: choice, note: e instanceof Error ? e.message : String(e) });
      return null;
    })
    .finally(() => inflight.delete(pk));
  inflight.set(pk, job);
  return job;
}

/** Install a track we KNOW (a synthesis, a TTS's own timing) for an asset — ground truth. */
export async function installKnownTrack(assetId: string, track: SpeechTrack, words?: SpeechWord[]): Promise<void> {
  const key = `${speechCacheKey(assetId, { id: track.engine, version: track.version })}#known`;
  await saveTrack(key, stripAudio(track));
  if (words?.length) await saveWords(assetId, words);
  const asset = assetOf(assetId);
  for (const choice of ["auto", track.engine]) planned.set(planKeyOf(assetId, asset, choice), key);
  setStatus(assetId, { state: "ready", progress: 1, engine: track.engine }, false);
  trackLanded();
}

/**
 * Before an export steps frames: every voice a speech function names has its
 * track, so no exported frame shows the pending rest mouth. Voices named
 * through an input (`lipsync(input("Voice"))`) can be any clip — all media
 * clips are prepared then.
 */
export async function prepareSpeechForExport(doc: MotionDocument): Promise<void> {
  const calls = doc.expressions.flatMap((e) => [...e.source.matchAll(/\b(?:lipsync|speaking|loudness)\(\s*(?:"((?:[^"\\]|\\.)*)"|([^)]*))/g)]);
  if (!calls.length) return;
  const names = new Set(calls.map((m) => (m[1] ?? "").toLowerCase()));
  const any = calls.some((m) => m[1] === undefined);
  const assets = new Set<string>();
  for (const t of doc.tracks) {
    for (const c of t.clips) {
      const id = mediaAssetOf(c);
      if (id && (any || names.has(c.name.trim().toLowerCase()) || names.has(c.id.toLowerCase()))) assets.add(id);
    }
  }
  await Promise.all([...assets].map((id) => ensureSpeechTrack(id)));
}

/** Timed words for an asset arrived (a TTS's timing, a transcript): Auto re-plans to align on them. */
export async function installVoiceWords(assetId: string, words: SpeechWord[]): Promise<void> {
  if (!words.length) return;
  await saveWords(assetId, words);
  for (const k of [...planned.keys()]) if (k.startsWith(`${assetId}|`)) planned.delete(k);
  await ensureSpeechTrack(assetId);
}

function stripAudio(track: SpeechTrack | SynthesisResult): SpeechTrack {
  const { engine, version: v, settingsKey, durationMs, cues, energy, words } = track;
  return { engine, version: v, settingsKey, durationMs, cues, energy, ...(words ? { words } : {}) };
}

// ── The plan ─────────────────────────────────────────────────────────────────

interface Plan {
  engine: SpeechEngine;
  input: SpeechInput;
  /** What else the result depends on (text, words) — folded into the cache key. */
  inputKey: string;
  settings?: SpeechSettings;
  needsPcm: boolean;
  note?: string;
}

async function planFor(asset: Asset | undefined, assetId: string, choice: string): Promise<Plan> {
  const spectral = speechEngine("spectral")!;
  const listen = (note?: string): Plan => ({ engine: spectral, input: {}, inputKey: "", needsPcm: true, ...(note ? { note } : {}) });
  const align = speechEngine("align")!;
  const text = knownText(asset);
  const voice = speechEngine("test-voice");

  if ((choice === "auto" || choice === "test-voice") && isTestVoice(asset) && text && voice) {
    return { engine: voice, input: { text }, settings: { preset: testPresetOf(asset) }, inputKey: hashText(text), needsPcm: false };
  }
  if (choice === "auto" || choice === "align") {
    const words = asset?.speech?.words?.length ? asset.speech.words : await loadWords(assetId);
    if (words?.length) return { engine: align, input: { words }, inputKey: `w${hashText(JSON.stringify(words))}`, needsPcm: true };
    if (text) return { engine: align, input: { text }, inputKey: `t${hashText(text)}`, needsPcm: true };
    const bridge = await import("./ai-bridge");
    if (bridge.canTranscribe()) {
      const heard = await bridge.transcribeAsset(assetId);
      if (heard.length) {
        await saveWords(assetId, heard);
        return { engine: align, input: { words: heard }, inputKey: `w${hashText(JSON.stringify(heard))}`, needsPcm: true };
      }
    }
    return listen(choice === "align" ? "Words needs a transcript — Listen is used for now" : undefined);
  }
  const named = speechEngine(choice);
  if (!named || named.kind === "synthesize") return listen(`${named?.label ?? choice} isn’t available — Listen is used for now`);
  return { engine: named, input: {}, inputKey: "", needsPcm: true };
}

async function analyse(assetId: string, asset: Asset | undefined, choice: string, force: boolean): Promise<{ track: SpeechTrack; key: string; note?: string } | null> {
  const plan = await planFor(asset, assetId, choice);
  const key = `${speechCacheKey(assetId, plan.engine, plan.settings)}${plan.inputKey ? `#${plan.inputKey}` : ""}`;
  if (!force) {
    const cached = await loadTrack(key);
    if (cached) return { track: cached, key, note: plan.note };
  }
  setStatus(assetId, { state: "listening", progress: 0, engine: plan.engine.id, ...(plan.note ? { note: plan.note } : {}) });
  const input: SpeechInput = { ...plan.input };
  if (plan.needsPcm) {
    const buffer = await ensureAudioBuffer(assetId);
    if (!buffer) throw new Error("Couldn't hear a voice in this clip");
    input.pcm = { samples: mono(buffer), sampleRate: buffer.sampleRate };
  }
  let last = 0;
  const track = await runSpeechEngine(plan.engine, input, plan.settings ?? {}, {
    onProgress: (p) => {
      // A status per percent, not per hop.
      if (p - last < 0.02 && p < 1) return;
      last = p;
      setStatus(assetId, { state: "listening", progress: p, engine: plan.engine.id, ...(plan.note ? { note: plan.note } : {}) });
    },
  });
  const clean = stripAudio(track);
  await saveTrack(key, clean);
  return { track: clean, key, note: plan.note };
}

/** Mono mixdown for analysis. */
function mono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const out = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < out.length; i++) out[i]! += data[i]! / buffer.numberOfChannels;
  }
  return out;
}

/** The engines a picker offers, with whether each can run here now. */
export function speechEngineChoices(): Array<{ id: string; label: string; available: boolean; description?: string }> {
  return listSpeechEngines().map((e) => ({
    id: e.id,
    label: e.label,
    description: e.description,
    // Test Voice speaks its own lines; it cannot hear a recording.
    available: e.kind !== "synthesize",
  }));
}

if (typeof window !== "undefined") installSpeechReader(read);
