import type { TimedPhoneme } from "./phonemes";
import type { AudioInput, VisemeCue } from "./types";
import type { VisemeId } from "./visemes";

/**
 * THE SPEECH ENGINE CONTRACT (ADR-characters, "Speech").
 *
 * Registration is cheap METADATA — id, version, what it needs, what it can
 * emit. The heavy part (DSP, dictionary, synthesizer, WASM, a remote client)
 * sits behind `load()`, a dynamic import, so the root bundle carries none of
 * it. Three kinds, one result type:
 *
 *   analyze     pcm → cues                      (spectral; a WASM slot)
 *   align       pcm? + text|words|phonemes → cues (transcripts, AI models)
 *   synthesize  text → pcm + EXACT cues          (Test Voice; TTS with timings)
 *
 * Every run returns a `SpeechTrack`, cached by asset + engine id + version +
 * `settingsKey`. Cues are derived data — never stored in a document.
 */

export type SpeechEngineKind = "analyze" | "align" | "synthesize";
export type SpeechNeed = "pcm" | "text" | "words" | "connection";

/** A spoken word with its time in the sound (the shape every transcriber returns). */
export interface SpeechWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** Smoothed 0..1 loudness sampled every `hopMs` (plain numbers: JSON-cacheable). */
export interface SpeechEnergy {
  hopMs: number;
  values: number[];
}

/** The one result of every engine. Serializable as-is. */
export interface SpeechTrack {
  engine: string;
  version: number;
  /** `settingsKey` of the (defaults-filled) settings that produced it. */
  settingsKey: string;
  /** Length of the sound the cues describe; cues cover [0, durationMs] gap-free. */
  durationMs: number;
  cues: VisemeCue[];
  energy: SpeechEnergy;
  words?: SpeechWord[];
  /** The phoneme timeline, when the engine reasons in phonemes (align, synth). */
  phonemes?: TimedPhoneme[];
}

/** What a synthesize engine returns: a track whose cues are exact, plus its audio. */
export interface SynthesisResult extends SpeechTrack {
  pcm: Float32Array;
  sampleRate: number;
  words: SpeechWord[];
  phonemes: TimedPhoneme[];
}

export type SettingValue = string | number | boolean;
/** Flat, primitive settings — so a stable key is trivial and nothing hides in nesting. */
export type SpeechSettings = Readonly<Record<string, SettingValue | undefined>>;

/** Everything an engine might read; each reads what its `needs` say. */
export interface SpeechInput {
  pcm?: AudioInput;
  text?: string;
  words?: readonly SpeechWord[];
  phonemes?: readonly TimedPhoneme[];
  /** Length of the sound when there is no pcm (align from words alone). */
  durationMs?: number;
  /** Language id for G2P (default "en"). */
  language?: string;
}

/** Per-run plumbing — never part of the cache key. */
export interface RunOptions {
  onProgress?: (fraction: number) => void;
  /** Any AbortSignal (structural: the package has no DOM types). */
  signal?: { readonly aborted: boolean };
}

export interface AnalyzeImpl {
  kind: "analyze";
  analyze(input: SpeechInput & { pcm: AudioInput }, settings?: SpeechSettings, run?: RunOptions): Promise<SpeechTrack>;
}
export interface AlignImpl {
  kind: "align";
  align(input: SpeechInput, settings?: SpeechSettings, run?: RunOptions): Promise<SpeechTrack>;
}
export interface SynthesizeImpl {
  kind: "synthesize";
  synthesize(input: SpeechInput & { text: string }, settings?: SpeechSettings, run?: RunOptions): Promise<SynthesisResult>;
}
export type EngineImpl = AnalyzeImpl | AlignImpl | SynthesizeImpl;

export interface SpeechEngine {
  /** Stable id — part of every cache key. */
  id: string;
  /** Bump whenever output for the same input + settings changes. */
  version: number;
  label: string;
  description?: string;
  kind: SpeechEngineKind;
  /** Inputs it requires (any one of text|words satisfies an align engine). */
  needs: readonly SpeechNeed[];
  /** The visemes it can produce; UIs gray out the rest. */
  emits: readonly VisemeId[];
  /** Settings defaults — folded into `settingsKey` so `{}` and explicit defaults share a cache slot. */
  defaults?: SpeechSettings;
  /** Dynamic-imports the heavy part. Called at most once per registration (memoised). */
  load(): Promise<EngineImpl>;
}

export type SpeechErrorCode = "unknown-engine" | "missing-input" | "aborted" | "wrong-kind";
export class SpeechError extends Error {
  constructor(
    readonly code: SpeechErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SpeechError";
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

const engines = new Map<string, SpeechEngine>();
const loaded = new Map<SpeechEngine, Promise<EngineImpl>>();

export function registerSpeechEngine(engine: SpeechEngine): void {
  engines.set(engine.id, engine);
}
export function speechEngine(id: string): SpeechEngine | undefined {
  return engines.get(id);
}
export function listSpeechEngines(kind?: SpeechEngineKind): SpeechEngine[] {
  const all = [...engines.values()];
  return kind ? all.filter((e) => e.kind === kind) : all;
}

/** Load (once) and return an engine's implementation. A failed load is retried next call. */
export function loadSpeechEngine(engineOrId: SpeechEngine | string): Promise<EngineImpl> {
  const engine = typeof engineOrId === "string" ? engines.get(engineOrId) : engineOrId;
  if (!engine) return Promise.reject(new SpeechError("unknown-engine", `No speech engine "${String(engineOrId)}"`));
  let p = loaded.get(engine);
  if (!p) {
    p = engine.load();
    loaded.set(engine, p);
    p.catch(() => loaded.delete(engine));
  }
  return p;
}

/** Throws when the engine's needs aren't met by the input ("connection" is the host's business). */
export function checkNeeds(engine: SpeechEngine, input: SpeechInput): void {
  for (const need of engine.needs) {
    if (need === "pcm" && !input.pcm) throw new SpeechError("missing-input", `${engine.label} needs audio`);
  }
  const wantsWords = engine.needs.includes("words") || engine.needs.includes("text");
  if (wantsWords && !input.text && !input.words?.length && !input.phonemes?.length) {
    throw new SpeechError("missing-input", `${engine.label} needs a transcript (text or timed words)`);
  }
}

/**
 * Run any engine by id: load it, check its needs, dispatch on kind. A
 * synthesize engine resolves to a `SynthesisResult` (a SpeechTrack with pcm).
 */
export async function runSpeechEngine(
  engineOrId: SpeechEngine | string,
  input: SpeechInput,
  settings: SpeechSettings = {},
  run: RunOptions = {},
): Promise<SpeechTrack> {
  const engine = typeof engineOrId === "string" ? engines.get(engineOrId) : engineOrId;
  if (!engine) throw new SpeechError("unknown-engine", `No speech engine "${String(engineOrId)}"`);
  checkNeeds(engine, input);
  const impl = await loadSpeechEngine(engine);
  if (run.signal?.aborted) throw new SpeechError("aborted", "Cancelled");
  switch (impl.kind) {
    case "analyze":
      return impl.analyze({ ...input, pcm: input.pcm! }, settings, run);
    case "align":
      return impl.align(input, settings, run);
    case "synthesize":
      if (input.text === undefined) throw new SpeechError("missing-input", `${engine.label} needs text`);
      return impl.synthesize({ ...input, text: input.text }, settings, run);
  }
}

// ── Cache keys ────────────────────────────────────────────────────────────────

/**
 * A stable string for a settings object: defaults filled, undefined dropped,
 * keys sorted. Two settings that produce the same output produce the same key.
 */
export function settingsKey(settings: SpeechSettings = {}, defaults: SpeechSettings = {}): string {
  const merged: Record<string, SettingValue> = {};
  for (const src of [defaults, settings]) {
    for (const k of Object.keys(src)) {
      const v = src[k];
      if (v !== undefined) merged[k] = v;
    }
  }
  return Object.keys(merged)
    .sort()
    .map((k) => `${k}=${String(merged[k])}`)
    .join(";");
}

/** asset + engine id + engine version + settings — THE cache key of a SpeechTrack. */
export function speechCacheKey(assetId: string, engine: Pick<SpeechEngine, "id" | "version" | "defaults">, settings?: SpeechSettings): string {
  return `${assetId}|${engine.id}@${engine.version}|${settingsKey(settings, engine.defaults)}`;
}

// ── Typed reads of the flat settings bag ──────────────────────────────────────

export function numSetting(s: SpeechSettings | undefined, key: string, fallback: number): number {
  const v = s?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
export function strSetting(s: SpeechSettings | undefined, key: string, fallback: string): string {
  const v = s?.[key];
  return typeof v === "string" ? v : fallback;
}
export function boolSetting(s: SpeechSettings | undefined, key: string, fallback: boolean): boolean {
  const v = s?.[key];
  return typeof v === "boolean" ? v : fallback;
}
