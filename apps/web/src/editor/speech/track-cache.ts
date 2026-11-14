"use client";

import type { SpeechTrack, SpeechWord } from "@solomotion/lipsync";
import { NAMES } from "@/editor/names";

/**
 * PERSISTENT SPEECH RESULTS — an analysis costs seconds, its result is a few
 * KB, so tracks persist in IndexedDB under `speechCacheKey` (asset + engine +
 * version + settings, plus the input for alignment). Bumping an engine's
 * version orphans its old entries instead of serving them. Word timings that
 * cost a network call (a transcription, a TTS's alignment) persist too, per
 * asset, so a reload never pays twice. A memory map fronts the IDB.
 *
 * Never fatal: no IDB (private mode, a worker) just means re-analysing.
 */

const IDB_NAME = NAMES.databases.speech;
const TRACKS = "tracks";
const WORDS = "words";

let dbPromise: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of [TRACKS, WORDS]) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

async function get<T>(store: string, key: string): Promise<T | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    const req = d.transaction(store, "readonly").objectStore(store).get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}

async function put(store: string, key: string, value: unknown): Promise<void> {
  const d = await db();
  if (!d) return;
  await new Promise<void>((resolve) => {
    const tx = d.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

const tracks = new Map<string, SpeechTrack>();

/** A cached track — memory first, then IDB. */
export async function loadTrack(key: string): Promise<SpeechTrack | null> {
  const hit = tracks.get(key);
  if (hit) return hit;
  const stored = await get<SpeechTrack>(TRACKS, key);
  if (stored) tracks.set(key, stored);
  return stored;
}

/** The memory copy only — what a synchronous read can see. */
export function peekTrack(key: string): SpeechTrack | null {
  return tracks.get(key) ?? null;
}

export async function saveTrack(key: string, track: SpeechTrack): Promise<void> {
  // Strip what a reload does not need (phonemes ride along only for inspection).
  tracks.set(key, track);
  await put(TRACKS, key, track);
}

/** Timed words for an asset — from a transcription or a TTS's own alignment. */
export function loadWords(assetId: string): Promise<SpeechWord[] | null> {
  return get<SpeechWord[]>(WORDS, assetId);
}

export function saveWords(assetId: string, words: SpeechWord[]): Promise<void> {
  return put(WORDS, assetId, words);
}

/** A short stable hash — folds an alignment's input text/words into its cache key. */
export function hashText(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
