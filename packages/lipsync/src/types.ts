import type { VisemeId } from "./visemes";

/**
 * The shared data shapes: audio in, cues out. The engine CONTRACT lives in
 * `engine.ts`; the pre-2.0 `PhonemeEngine` shape below survives as a view of
 * it (`legacy.ts`) so existing hosts keep compiling.
 */

/** Raw sound for analysis: mono PCM. The host decodes (Web Audio, ffmpeg, …). */
export interface AudioInput {
  samples: Float32Array;
  sampleRate: number;
}

/** One mouth shape held over a span of the sound. Cues are sorted, gap-free
 * within speech, and never overlap. */
export interface VisemeCue {
  startMs: number;
  endMs: number;
  viseme: VisemeId;
  /** 0..1 — how unanimous the engine's framewise votes were over this span. */
  confidence: number;
  /**
   * 0..1(+) — how open/strong this mouth is played, set by the feel pass
   * (`shapeCues`: energy knob × the voice's loudness). Absent = full. Morph and
   * bone mouths scale their weights by it; drawings pick an open/small variant.
   */
  intensity?: number;
}

/** The full result of one legacy analysis run — serializable, cacheable as-is. */
export interface LipSyncAnalysis {
  engineId: string;
  engineVersion: number;
  sampleRate: number;
  durationMs: number;
  cues: VisemeCue[];
  /**
   * Normalized 0..1 loudness sampled every `hopMs` — for painting strips,
   * driving mouth openness, or any downstream visualization. Plain numbers so
   * the whole analysis JSON-serializes for caching.
   */
  energy: { hopMs: number; values: number[] };
}

export interface AnalyzeOptions {
  /** Progress 0..1 while the engine chews through the sound. */
  onProgress?: (fraction: number) => void;
  /** Runs shorter than this merge into a neighbor (default 60ms). */
  minCueMs?: number;
  /**
   * Label-smoothing strength — the mode-filter radius over framewise votes.
   * Higher = calmer, steadier holds; lower = snappier, more detail (and jitter).
   * Engines that post-filter should honor this; default 2.
   */
  smoothing?: number;
  /**
   * Voice sensitivity 0..1 — how eagerly quiet sound counts as speech. Higher
   * lowers the silence gate (picks up mumbles/soft takes at the risk of noise);
   * lower is stricter. 0.5 is the neutral default.
   */
  sensitivity?: number;
}

/**
 * @deprecated The pre-Characters-2.0 engine shape, kept so the LipSync plugin
 * compiles unchanged. It is a VIEW of the `SpeechEngine` registry (analyze
 * engines whose only need is pcm) — see `legacy.ts`. New code: `SpeechEngine`.
 */
export interface PhonemeEngine {
  /** Stable id — part of every cache key, so results never cross engines. */
  id: string;
  /** Bump when classification changes — invalidates cached analyses. */
  version: number;
  name: string;
  description: string;
  /** The viseme classes this engine can emit. UIs gray out the rest. */
  emits: readonly VisemeId[];
  analyze(input: AudioInput, opts?: AnalyzeOptions): Promise<LipSyncAnalysis>;
}
