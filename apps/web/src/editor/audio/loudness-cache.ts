"use client";

import { create } from "zustand";
import {
  maxMomentaryLoudness,
  measureLoudnessTable,
  type LoudnessSource,
  type LoudnessTable,
  type SoundPackId,
} from "@solomotion/core";
import { ensureAudioBuffer } from "./waveform";
import { renderPackBuffer } from "./sound-engine";

/**
 * The app's side of the leveler's loudness PORT — every asset measured ONCE,
 * in the background, one at a time.
 *
 * Measuring is the heavy part of levelling (a decode plus a filter pass over
 * every sample), so it never blocks anything: playback reads whatever is
 * measured so far through `loudnessSource` and a sound still in the queue
 * simply plays untrimmed until its table lands. The version store bumps as
 * each one does, which is what rebuilds the mix plan — so the leveler fills
 * in progressively, sound by sound, however much audio a project holds.
 *
 * Tables are keyed by asset id and assets are immutable, so a table is never
 * stale. The export path awaits `measureAll` instead: a file must not be
 * written half-levelled.
 */

const assets = new Map<string, LoudnessTable | "failed">();
const packs = new Map<SoundPackId, number>();
const queue: string[] = [];
const queuedPacks = new Set<SoundPackId>();
let running = false;

/** Bumps once per finished measurement — subscribe to rebuild the mix plan. */
export const useLoudnessVersion = create<{ version: number; queued: number }>(() => ({ version: 0, queued: 0 }));

function bump(): void {
  useLoudnessVersion.setState((s) => ({ version: s.version + 1, queued: queue.length + queuedPacks.size }));
}

async function measureAsset(assetId: string): Promise<void> {
  const buffer = await ensureAudioBuffer(assetId);
  if (!buffer) {
    assets.set(assetId, "failed");
    return;
  }
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  assets.set(assetId, measureLoudnessTable(channels, buffer.sampleRate));
}

async function measurePack(pack: SoundPackId): Promise<void> {
  const buffer = await renderPackBuffer(pack);
  if (!buffer) return;
  const table = measureLoudnessTable([buffer.getChannelData(0)], buffer.sampleRate);
  packs.set(pack, maxMomentaryLoudness(table, 0, table.energy.length * table.blockMs));
}

/** Yield to the frame between measurements so a long queue never janks playback. */
const idle = (): Promise<void> =>
  new Promise((resolve) =>
    typeof requestIdleCallback === "function" ? requestIdleCallback(() => resolve(), { timeout: 400 }) : setTimeout(resolve, 16),
  );

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0 || queuedPacks.size > 0) {
      await idle();
      const pack = queuedPacks.values().next().value as SoundPackId | undefined;
      if (pack) {
        queuedPacks.delete(pack);
        await measurePack(pack);
      } else {
        const id = queue.shift()!;
        if (!assets.has(id)) await measureAsset(id);
      }
      bump();
    }
  } finally {
    running = false;
  }
}

/** Ask for measurements (idempotent) — the plan's `missingAssets`/`missingPacks`. */
export function requestLoudness(assetIds: Iterable<string>, packIds: Iterable<SoundPackId> = []): void {
  let added = false;
  for (const id of assetIds) {
    if (assets.has(id) || queue.includes(id)) continue;
    queue.push(id);
    added = true;
  }
  for (const p of packIds) {
    if (packs.has(p) || queuedPacks.has(p)) continue;
    queuedPacks.add(p);
    added = true;
  }
  if (added) {
    // Asking happens while a plan is BUILT — inside a component's render (the
    // mixer's useMemo) as well as the transport's tick. Telling subscribers in
    // the same breath was a setState during render; the news waits a microtask.
    queueMicrotask(() => {
      useLoudnessVersion.setState({ queued: queue.length + queuedPacks.size });
      void drain();
    });
  }
}

/** Measure everything now (export). Resolves once every table exists or failed. */
export async function measureAll(assetIds: Iterable<string>, packIds: Iterable<SoundPackId> = []): Promise<void> {
  for (const p of packIds) if (!packs.has(p)) await measurePack(p);
  for (const id of assetIds) if (!assets.has(id)) await measureAsset(id);
  bump();
}

/** THE port the mix plan reads. A failed measurement counts as measured-silent (no trim). */
export const loudnessSource: LoudnessSource = {
  asset: (id) => {
    const hit = assets.get(id);
    return hit && hit !== "failed" ? hit : hit === "failed" ? { blockMs: 100, energy: new Float32Array(0) } : null;
  },
  pack: (p) => packs.get(p) ?? null,
};
