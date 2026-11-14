"use client";

import * as React from "react";
import { installDepthReader, noteDepthChanged, type MotionDocument, type DepthFrame, type DepthTracker } from "@solomotion/core";
import { notifyPicturesChanged } from "../stage/render/media-cache";
import { NAMES } from "@/editor/names";

/**
 * THE DEPTH STORE — where a depth run's maps live, beside the document.
 *
 * Maps are heavy derived data (a few hundred kB a frame), so the document
 * keeps only what made them and under which `key` (`tracker.maps`), and the
 * frames live here, the sound analysis' way:
 *
 *   read (an effect, a matte, a window, a relief) → memory → IndexedDB → null
 *   (and the ask loads the whole run in the background, then repaints).
 *
 * One IndexedDB record per run (the frames packed end to end), so a shot
 * loads in one read. Memory keeps the last few runs; a run nobody reads is
 * dropped first.
 */

interface Run {
  width: number;
  height: number;
  times: number[];
  frames: Map<number, DepthFrame>;
}

const memory = new Map<string, Run>();
let version = 0;
const listeners = new Set<() => void>();
function changed(): void {
  version++;
  noteDepthChanged();
  for (const l of listeners) l();
}

/** Re-render when maps land (a preview that asked before they loaded). */
export function useDepthStoreVersion(): number {
  return React.useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
    () => version,
  );
}
const loading = new Set<string>();
const MEMORY_RUNS = 4;

const IDB_NAME = NAMES.databases.depth;
const STORE = "runs";

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

interface Record_ {
  width: number;
  height: number;
  times: number[];
  /** Every frame's Uint16 map, end to end. */
  data: ArrayBuffer;
}

function remember(key: string, run: Run): void {
  memory.delete(key);
  memory.set(key, run);
  while (memory.size > MEMORY_RUNS) memory.delete(memory.keys().next().value!);
}

function unpack(r: Record_): Run {
  const n = r.width * r.height;
  const all = new Uint16Array(r.data);
  const frames = new Map<number, DepthFrame>();
  r.times.forEach((t, i) => frames.set(t, { width: r.width, height: r.height, data: all.subarray(i * n, (i + 1) * n) }));
  return { width: r.width, height: r.height, times: r.times, frames };
}

/** Keep a fresh run's maps under `key` — memory at once, IndexedDB behind it. */
export async function saveDepthRun(key: string, run: { width: number; height: number; times: number[]; maps: Uint16Array[] }): Promise<void> {
  const n = run.width * run.height;
  const data = new Uint16Array(n * run.maps.length);
  run.maps.forEach((m, i) => data.set(m, i * n));
  const record: Record_ = { width: run.width, height: run.height, times: run.times, data: data.buffer };
  remember(key, unpack(record));
  changed();
  const d = await db();
  if (!d) return;
  await new Promise<void>((resolve) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function load(key: string): Promise<void> {
  if (loading.has(key)) return;
  loading.add(key);
  try {
    const d = await db();
    if (!d) return;
    const r = await new Promise<Record_ | undefined>((resolve) => {
      const req = d.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as Record_ | undefined);
      req.onerror = () => resolve(undefined);
    });
    if (!r) return;
    remember(key, unpack(r));
    changed();
    notifyPicturesChanged();
  } finally {
    loading.delete(key);
  }
}

/** Is this run's data here (memory or disk)? False means it must be run again on this machine. */
export async function hasDepthRun(key: string): Promise<boolean> {
  if (memory.has(key)) return true;
  await load(key);
  return memory.has(key);
}

/** Every depth run the document refers to, loaded into memory — what an export awaits before its first frame. */
export async function prepareDepthForExport(doc: MotionDocument): Promise<void> {
  await Promise.all(doc.trackers.flatMap((t) => (t.kind === "depth" && t.maps ? [hasDepthRun(t.maps.key)] : [])));
}

function read(tracker: DepthTracker, sourceMs: number): DepthFrame | null {
  const key = tracker.maps?.key;
  if (!key) return null;
  const run = memory.get(key);
  if (!run) {
    void load(key);
    return null;
  }
  return run.frames.get(sourceMs) ?? null;
}

if (typeof window !== "undefined") installDepthReader(read);
