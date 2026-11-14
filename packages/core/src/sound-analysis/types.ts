/**
 * WHAT A SOUND IS MADE OF — the derived facts about a recording that anything
 * in the document can react to.
 *
 * One analysis per ASSET, in SOURCE time (from the start of the file, before
 * any clip's trim, speed, loop or reverse), exactly as lip sync's tracks are:
 * every clip of a recording shares it, and moving, trimming or retiming a clip
 * re-syncs whatever reacts to it with no re-analysis, because the clip's own
 * time map (`mediaSourceAt`) does the rest.
 *
 * It is DERIVED, never stored in the document: a function of the samples,
 * computed once (core `analyzeSound`), cached app-side and handed to core
 * through the reader (`reader.ts`). The document only ever holds what someone
 * decided — which layer listens to which sound, and which feature.
 *
 * Every per-frame feature channel is a `Uint8Array` scaled to 0..255. A feature value
 * is a perceptual 0..1 (levels are dB-mapped), and 1/255 of that is a quarter
 * of a decibel — finer than any picture driven by it can show, at a quarter
 * of the memory of floats. A three-minute song is about 1.3 MB.
 */

/** Bump when the analysis changes shape or meaning — cached results key on it. */
export const SOUND_ANALYSIS_VERSION = 1;

/** Feature frames per second: one every 10 ms. */
export const SOUND_FRAME_RATE = 100;

/** Log-spaced frequency bands stored per frame. */
export const SOUND_BANDS = 64;

/** Waveform peak buckets per second (2.5 ms) — the timeline's resolution too. */
export const SOUND_PEAK_RATE = 400;

/** The frequency axis the bands span. The top is capped at Nyquist. */
export const SOUND_MIN_HZ = 32;
export const SOUND_MAX_HZ = 14000;

/** The silence floor of the bands' dB mapping. */
export const SOUND_BAND_FLOOR_DB = -66;

/** The silence floor of the loudness mapping. */
export const SOUND_LEVEL_FLOOR_DB = -60;

export interface SoundAnalysis {
  version: number;
  durationMs: number;
  sampleRate: number;
  /** Feature frames per second (`SOUND_FRAME_RATE`). */
  frameRate: number;
  frames: number;
  bandCount: number;
  /** The bands' frequency span: log-spaced from `minHz` to `maxHz`. */
  minHz: number;
  maxHz: number;
  /** Loudness per frame: RMS over the last 50 ms, dB-mapped to 0..255. */
  level: Uint8Array;
  /** `frames × bandCount`, row-major: each band's peak magnitude, dB-mapped. */
  bands: Uint8Array;
  /** Onset strength per frame — how much new sound arrived (spectral flux), normalised to the sound itself. */
  flux: Uint8Array;
  /** Brightness per frame: where the spectrum's centre of mass sits on the log axis. */
  centroid: Uint8Array;
  /** Waveform: max |sample| per bucket at `peakRate`, linear 0..1 (`peakTable`). */
  peaks: Float32Array;
  peakRate: number;
  /** Detected hits, source ms. */
  onsets: Float32Array;
  /** The tracked beat, source ms. Empty when the sound has no steady pulse. */
  beats: Float32Array;
  /** Beats per minute, or null when there is no steady pulse to count. */
  tempo: number | null;
  /** Whole-file loudness facts, dBFS. */
  peakDb: number;
  rmsDb: number;
}

/**
 * THE FEATURES — one list, read by every surface that offers them: the
 * `sound()` expression's argument, the Sound node's outputs, the inspector's
 * "use it" menu and the agent API. A new feature is one entry here and one
 * branch in `soundFeatureAt`; nothing else names them.
 *
 * `range` features are the energy of a stretch of the spectrum. The edges are
 * the ones a mix engineer would name — a designer asks for "the bass", not for
 * 60–250 Hz, but the numbers are here for anyone who does.
 */
export interface SoundFeatureDef {
  id: SoundFeature;
  label: string;
  describe: string;
  range?: readonly [number, number];
}

export type SoundFeature =
  | "level"
  | "sub"
  | "bass"
  | "lowMid"
  | "mid"
  | "highMid"
  | "treble"
  | "brightness"
  | "onset"
  | "beat";

export const SOUND_FEATURES: readonly SoundFeatureDef[] = [
  { id: "level", label: "Level", describe: "How loud it is now." },
  { id: "sub", label: "Sub", describe: "The rumble under the bass, 20–60 Hz.", range: [20, 60] },
  { id: "bass", label: "Bass", describe: "Kick and bass line, 60–250 Hz.", range: [60, 250] },
  { id: "lowMid", label: "Low mid", describe: "Body and warmth, 250–500 Hz.", range: [250, 500] },
  { id: "mid", label: "Mid", describe: "Voices and most instruments, 500 Hz–2 kHz.", range: [500, 2000] },
  { id: "highMid", label: "High mid", describe: "Presence and attack, 2–4 kHz.", range: [2000, 4000] },
  { id: "treble", label: "Treble", describe: "Hats, air and sparkle, 4–16 kHz.", range: [4000, 16000] },
  { id: "brightness", label: "Brightness", describe: "How bright the sound is — high when the treble leads." },
  { id: "onset", label: "Hits", describe: "Spikes when something new is struck — drums, plucks, consonants." },
  { id: "beat", label: "Beat", describe: "Jumps to 1 on every beat of the tracked tempo and falls away before the next." },
];

const BY_ID = new Map<string, SoundFeatureDef>(SOUND_FEATURES.map((f) => [f.id, f]));

/** A feature by id (case-insensitive), or undefined. */
export function soundFeatureDef(id: string): SoundFeatureDef | undefined {
  return BY_ID.get(id) ?? SOUND_FEATURES.find((f) => f.id.toLowerCase() === id.toLowerCase());
}
