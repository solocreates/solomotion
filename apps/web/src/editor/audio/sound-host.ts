"use client";

import React from "react";
import {
  SOUND_ANALYSIS_VERSION,
  SOUND_NODE_TYPE,
  createSoundAnalyzer,
  installSoundReader,
  mediaAssetOf,
  noteSoundChanged,
  withEffectiveTargets,
  type MotionDocument,
  type SoundAnalysis,
} from "@solomotion/core";
import { ensureAudioBuffer } from "./waveform";
import { NAMES } from "@/editor/names";

/**
 * THE SOUND HOST — where a recording's analysis is made, kept and handed to
 * core. Lip sync's host, deliberately the same shape:
 *
 *   read (a frame, an expression, a node, the panel) → memory → IndexedDB →
 *   decode (the one shared buffer cache) → analyse in slices → persist →
 *   install → `noteSoundChanged()` (every bake re-keys) → listeners.
 *
 * Reading IS asking: the first frame that needs a sound queues its analysis
 * and reads silence until it lands. Analyses run ONE AT A TIME — they are
 * CPU-bound, so two in parallel would only finish later together — and in
 * slices of a few milliseconds between frames, so the editor never stutters.
 *
 * The analyser is core code in the main bundle, not a lazy chunk or a worker
 * URL: it needs nothing from the network, so a session that went offline can
 * still analyse a sound it has never heard.
 */

export type SoundStatus =
  | { state: "queued" }
  | { state: "analyzing"; progress: number }
  | { state: "ready" }
  | { state: "failed"; message: string };

const memory = new Map<string, SoundAnalysis>();
const status = new Map<string, SoundStatus>();
const inflight = new Map<string, Promise<SoundAnalysis | null>>();
/** Files that failed — reads do not re-queue them (a frame must not retry a broken file every tick); "Analyze" forces. */
const failed = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

// ── Listeners ────────────────────────────────────────────────────────────────

const changeListeners = new Set<() => void>();
function emit(): void {
  for (const l of changeListeners) l();
}

/** Status or result moved — what panels repaint on. */
export function onSoundChange(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

/**
 * An ANALYSIS landed — the only sound event that changes a picture, so it is
 * the only one the stage listens to (progress ticks must not throw away
 * cached frames).
 */
const landedListeners = new Set<() => void>();
export function onSoundAnalysis(cb: () => void): () => void {
  landedListeners.add(cb);
  return () => landedListeners.delete(cb);
}

function setStatus(assetId: string, s: SoundStatus): void {
  status.set(assetId, s);
  emit();
}

// One object, so a status read twice without a change in between is the same
// value — `useSyncExternalStore` compares snapshots by identity.
const READY: SoundStatus = { state: "ready" };

export function soundStatusOf(assetId: string): SoundStatus | null {
  if (memory.has(assetId)) return READY;
  return status.get(assetId) ?? null;
}

/**
 * A panel's view of one sound: its status and, once ready, its analysis. Each
 * is its own snapshot, so the values come THROUGH the subscription and a
 * render never reads the maps behind React's back.
 */
export function useSoundAnalysis(assetId: string | null): { status: SoundStatus | null; analysis: SoundAnalysis | null } {
  const readStatus = () => (assetId ? soundStatusOf(assetId) : null);
  const readAnalysis = () => (assetId ? (memory.get(assetId) ?? null) : null);
  const status = React.useSyncExternalStore(onSoundChange, readStatus, readStatus);
  const analysis = React.useSyncExternalStore(onSoundChange, readAnalysis, readAnalysis);
  return { status, analysis };
}

// ── Persistence ──────────────────────────────────────────────────────────────

const IDB_NAME = NAMES.databases.sound;
const STORE = "analyses";
const keyOf = (assetId: string) => `${assetId}@${SOUND_ANALYSIS_VERSION}`;

let dbPromise: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

async function load(assetId: string): Promise<SoundAnalysis | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    const req = d.transaction(STORE, "readonly").objectStore(STORE).get(keyOf(assetId));
    req.onsuccess = () => {
      const a = req.result as SoundAnalysis | undefined;
      resolve(a && a.version === SOUND_ANALYSIS_VERSION ? a : null);
    };
    req.onerror = () => resolve(null);
  });
}

async function save(assetId: string, a: SoundAnalysis): Promise<void> {
  const d = await db();
  if (!d) return;
  await new Promise<void>((resolve) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(a, keyOf(assetId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// ── The work ─────────────────────────────────────────────────────────────────

/** A macrotask that hidden tabs do not throttle to a second (an export may run in one). */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(null);
  });
}

/** Milliseconds of analysis per slice — well inside a 60 fps frame. */
const SLICE_MS = 8;

async function analyse(assetId: string): Promise<SoundAnalysis | null> {
  const cached = await load(assetId);
  if (cached) return cached;
  const buffer = await ensureAudioBuffer(assetId);
  if (!buffer) throw new Error("This file could not be decoded.");
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const analyzer = createSoundAnalyzer(channels, buffer.sampleRate);
  let shown = -1;
  for (;;) {
    const t0 = performance.now();
    let done = false;
    while (!done && performance.now() - t0 < SLICE_MS) done = analyzer.step(16);
    if (done) break;
    const pct = Math.floor(analyzer.progress * 50) / 50;
    if (pct !== shown) {
      shown = pct;
      setStatus(assetId, { state: "analyzing", progress: pct });
    }
    await yieldToUi();
  }
  const result = analyzer.finish();
  void save(assetId, result);
  return result;
}

/**
 * The analysis of a sound — cached, or made now. Concurrent asks share one
 * run. `force` re-runs a file that failed before.
 */
export function ensureSoundAnalysis(assetId: string, opts: { force?: boolean } = {}): Promise<SoundAnalysis | null> {
  const hit = memory.get(assetId);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(assetId);
  if (running) return running;
  if (failed.has(assetId) && !opts.force) return Promise.resolve(null);
  failed.delete(assetId);
  setStatus(assetId, { state: "queued" });
  const job = (queue = queue.then(async () => {
    try {
      const a = await analyse(assetId);
      if (!a) return null;
      memory.set(assetId, a);
      status.set(assetId, { state: "ready" });
      noteSoundChanged();
      for (const l of landedListeners) l();
      emit();
      return a;
    } catch (err) {
      failed.add(assetId);
      setStatus(assetId, { state: "failed", message: err instanceof Error ? err.message : "The sound could not be analysed." });
      return null;
    } finally {
      inflight.delete(assetId);
    }
  })) as Promise<SoundAnalysis | null>;
  inflight.set(assetId, job);
  return job;
}

/** Core's reader: memory, or null while pending — and the ask queues it. */
function read(assetId: string): SoundAnalysis | null {
  const hit = memory.get(assetId);
  if (hit) return hit;
  if (!inflight.has(assetId) && !failed.has(assetId)) void ensureSoundAnalysis(assetId);
  return null;
}

if (typeof window !== "undefined") installSoundReader(read);

// ── Export ───────────────────────────────────────────────────────────────────

const SOUND_CALL = /\b(?:sound|soundBand|soundTempo)\(\s*(?:"((?:[^"\\]|\\.)*)"|([^,)]*))/g;

/**
 * Before an export steps frames, every sound something listens to has its
 * analysis — no exported frame reads the pending silence. Listeners are:
 * waveform layers (their target), `sound()`-family expressions (by layer
 * name; a name that is not a literal prepares every sound), and Sound nodes
 * (their target, or any Layer hub wired into them).
 */
export async function prepareSoundForExport(doc: MotionDocument): Promise<void> {
  const clips = doc.tracks.flatMap((t) => t.clips);
  const byId = new Map(clips.map((c) => [c.id, c]));
  const assets = new Set<string>();
  const hear = (id: string | undefined) => {
    const c = id ? byId.get(id) : undefined;
    const a = c ? mediaAssetOf(c) : null;
    if (a) assets.add(a);
  };
  for (const c of clips) if (c.kind === "waveform") hear(c.targetClipId);
  const calls = doc.expressions.flatMap((e) => [...e.source.matchAll(SOUND_CALL)]);
  if (calls.some((m) => m[1] === undefined)) {
    for (const c of clips) hear(c.id);
  } else {
    const names = new Set(calls.map((m) => (m[1] ?? "").trim().toLowerCase()));
    for (const c of clips) if (names.has(c.name.trim().toLowerCase()) || names.has(c.id.toLowerCase())) hear(c.id);
  }
  for (const g of doc.graphs) {
    for (const n of withEffectiveTargets(g).nodes) {
      if (n.type === SOUND_NODE_TYPE && typeof n.params.target === "string") {
        const t = n.params.target;
        hear(byId.has(t) ? t : clips.find((c) => c.name.trim().toLowerCase() === t.trim().toLowerCase())?.id);
      }
    }
  }
  await Promise.all([...assets].map((id) => ensureSoundAnalysis(id, { force: true })));
}
