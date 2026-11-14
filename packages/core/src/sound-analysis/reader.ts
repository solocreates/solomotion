import type { SoundAnalysis } from "./types";

/**
 * ANALYSES CORE CANNOT MAKE ON ITS OWN — decoding a file is app-side and
 * asynchronous, so the app installs the one reader and core asks it
 * synchronously (the speech reader's pattern, deliberately the same).
 *
 * The reader answers from memory or returns null while an analysis is
 * pending — and asking IS the request: the host queues the work as a side
 * effect, so the first frame that needs a sound starts its analysis. Until it
 * lands every value reads 0.
 *
 * When one lands the host calls `noteSoundChanged()`. Every memo of a bake
 * keys on `soundGeneration()`, so the next frame re-resolves and whatever
 * listens starts moving without an edit. Headless (tests, a server without a
 * host) nothing is installed and everything is silent.
 */
export type SoundReader = (assetId: string) => SoundAnalysis | null;

let reader: SoundReader | null = null;
let generation = 0;

export function installSoundReader(fn: SoundReader | null): void {
  reader = fn;
  generation++;
}

/** The analysis of this asset, or null while pending (asking queues it). */
export function readSoundAnalysis(assetId: string): SoundAnalysis | null {
  return reader?.(assetId) ?? null;
}

/** An analysis landed, changed or was dropped — every bake that read sound is stale. */
export function noteSoundChanged(): void {
  generation++;
}

export function soundGeneration(): number {
  return generation;
}
