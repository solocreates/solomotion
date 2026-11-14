import type { SpeechTrack } from "./types";

/**
 * SPEECH TRACKS CORE CANNOT MAKE — an analysis needs decoded PCM and an
 * engine, both app-side and asynchronous. The app installs the one reader
 * (the physics outline-reader pattern); core asks it synchronously.
 *
 * The reader answers from memory or returns null while a track is pending —
 * and asking IS the request: the host queues the analysis as a side effect,
 * so a `lipsync()` nobody has analysed for yet starts its own analysis the
 * first time a frame needs it. Until the track lands every read is rest.
 *
 * When one lands the host calls `noteSpeechChanged()`: every memo of a bake
 * keys on `speechGeneration()`, so the next frame re-resolves and the mouth
 * starts moving without an edit. Headless (tests, a server without a host),
 * nothing is installed and everything is at rest.
 */
export type SpeechReader = (assetId: string, engine?: string) => SpeechTrack | null;

let reader: SpeechReader | null = null;
let generation = 0;

export function installSpeechReader(fn: SpeechReader | null): void {
  reader = fn;
  generation++;
}

/**
 * The track for this asset, or null while pending. `engine` omitted = the
 * asset's own choice (`asset.speech.engine`, "auto" by default) — the host
 * reads it from the document it serves, which keeps engine policy out of the
 * render path; a verb that wants one engine names it.
 */
export function readSpeechTrack(assetId: string, engine?: string): SpeechTrack | null {
  return reader?.(assetId, engine) ?? null;
}

/** A track landed, changed or was dropped — every bake that read speech is stale. */
export function noteSpeechChanged(): void {
  generation++;
}

export function speechGeneration(): number {
  return generation;
}
