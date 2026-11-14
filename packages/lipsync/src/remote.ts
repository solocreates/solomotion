import { canonicalViseme, fromAlphabet } from "./alphabets";
import { registerSpeechEngine, type SpeechEngine, type SpeechInput, type SpeechWord } from "./engine";
import { ALIGN } from "./engines/meta";
import { ipaToArpabet, parseArpabet, type TimedPhoneme } from "./phonemes";
import type { VisemeCue } from "./types";
import { VISEME_IDS, type VisemeId } from "./visemes";

/**
 * THE AI BRIDGE. Any remote model — a transcriber, a phoneme recogniser, a
 * TTS that returns timings, a viseme stream — answers in one of these shapes
 * (all times in ms), and the align engine turns it into a SpeechTrack. Cheap
 * (no G2P here); the alignment itself loads lazily.
 */
export type RemoteSpeechResult =
  | { kind: "words"; words: SpeechWord[]; durationMs?: number }
  | {
      kind: "phonemes";
      /** ARPAbet ("AH0", "sil") or IPA ("ə", "tʃ") symbols. */
      phonemes: { symbol: string; startMs: number; endMs: number }[];
      alphabet?: "arpabet" | "ipa";
      durationMs?: number;
    }
  | {
      kind: "visemes";
      /** Shape names in `alphabet` (any registered alphabet id; default the canonical nine). */
      visemes: { shape: string; startMs: number; endMs?: number }[];
      alphabet?: string;
      durationMs?: number;
    }
  | {
      /** Character-level timing (ElevenLabs `with-timestamps`, Azure word boundaries…). */
      kind: "characters";
      characters: string[];
      startMs: number[];
      endMs: number[];
      durationMs?: number;
    };

/** ElevenLabs `/text-to-speech/{id}/with-timestamps` `alignment` (or `normalized_alignment`). */
export interface ElevenLabsAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export function fromElevenLabsAlignment(a: ElevenLabsAlignment): RemoteSpeechResult {
  return {
    kind: "characters",
    characters: a.characters,
    startMs: a.character_start_times_seconds.map((s) => s * 1000),
    endMs: a.character_end_times_seconds.map((s) => s * 1000),
  };
}

/** Whisper / Deepgram / AssemblyAI-style words in SECONDS (`word` or `text`, `start`, `end`). */
export function fromSecondsWords(words: readonly { word?: string; text?: string; start: number; end: number }[]): RemoteSpeechResult {
  return { kind: "words", words: words.map((w) => ({ text: (w.word ?? w.text ?? "").trim(), startMs: w.start * 1000, endMs: w.end * 1000 })) };
}

/** Characters with times → words with times (a word spans its first to last letter). */
export function charactersToWords(chars: readonly string[], startMs: readonly number[], endMs: readonly number[]): SpeechWord[] {
  const words: SpeechWord[] = [];
  let cur: SpeechWord | null = null;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] ?? "";
    if (/^\s*$/.test(c)) { cur = null; continue; }
    const s = startMs[i] ?? 0;
    const e = endMs[i] ?? s;
    if (!cur) { cur = { text: c, startMs: s, endMs: e }; words.push(cur); }
    else { cur.text += c; cur.endMs = Math.max(cur.endMs, e); }
  }
  // Punctuation attached to a word is part of its spelling, not its sound — G2P drops it.
  return words.filter((w) => /[\p{L}\p{N}]/u.test(w.text));
}

/**
 * A remote result as align-engine input (words or phonemes), or as ready cues
 * for a viseme stream. Unknown phoneme symbols become silence; an IPA symbol
 * that is several ARPAbet phonemes shares its time evenly.
 */
export function remoteToInput(r: RemoteSpeechResult): { input: SpeechInput; cues?: VisemeCue[] } {
  switch (r.kind) {
    case "words":
      return { input: { words: r.words, durationMs: r.durationMs } };
    case "characters":
      return { input: { words: charactersToWords(r.characters, r.startMs, r.endMs), durationMs: r.durationMs } };
    case "phonemes": {
      const phonemes: TimedPhoneme[] = [];
      for (const p of r.phonemes) {
        if (r.alphabet === "ipa") {
          const toks = ipaToArpabet(p.symbol);
          if (!toks?.length) { phonemes.push({ phoneme: "SIL", startMs: p.startMs, endMs: p.endMs }); continue; }
          const step = (p.endMs - p.startMs) / toks.length;
          toks.forEach((t, k) => phonemes.push({ phoneme: t.phoneme, stress: t.stress, startMs: p.startMs + k * step, endMs: p.startMs + (k + 1) * step }));
        } else {
          const a = parseArpabet(p.symbol);
          phonemes.push({ phoneme: a?.phoneme ?? "SIL", stress: a?.stress, startMs: p.startMs, endMs: p.endMs });
        }
      }
      return { input: { phonemes, durationMs: r.durationMs } };
    }
    case "visemes": {
      const sorted = [...r.visemes].sort((a, b) => a.startMs - b.startMs);
      const cues: VisemeCue[] = sorted.map((v, i) => {
        const viseme: VisemeId = (r.alphabet ? fromAlphabet(r.alphabet, v.shape) : canonicalViseme(v.shape)) ?? "X";
        const endMs = v.endMs ?? sorted[i + 1]?.startMs ?? v.startMs + 100;
        return { startMs: v.startMs, endMs, viseme, confidence: 1 };
      });
      return { input: { durationMs: r.durationMs }, cues };
    }
  }
}

export interface RemoteEngineSpec {
  id: string;
  version: number;
  label: string;
  description?: string;
  /** The host's call to its connection (fetch, SDK…). Gets the same input any engine gets. */
  request(input: SpeechInput, signal?: { readonly aborted: boolean }): Promise<RemoteSpeechResult>;
}

/**
 * Register any AI connection as an align engine in one call: the host does
 * the network request, the package does everything after (G2P, timing,
 * cues, energy). `needs` includes "connection" so pickers can grey it out
 * while offline.
 */
export function registerRemoteSpeechEngine(spec: RemoteEngineSpec): SpeechEngine {
  const engine: SpeechEngine = {
    id: spec.id,
    version: spec.version,
    label: spec.label,
    description: spec.description,
    kind: "align",
    needs: ["pcm", "connection"],
    emits: VISEME_IDS,
    defaults: ALIGN.defaults,
    load: async () => {
      const align = await import("./align/index");
      return {
        kind: "align",
        async align(input, settings = {}, run = {}) {
          const r = await spec.request(input, run.signal);
          const { input: aligned, cues } = remoteToInput(r);
          const merged: SpeechInput = { ...input, ...aligned, durationMs: aligned.durationMs ?? input.durationMs };
          const track = cues ? await align.trackFromCues(cues, merged) : await align.alignImpl.align(merged, settings, run);
          return { ...track, engine: spec.id, version: spec.version };
        },
      };
    },
  };
  registerSpeechEngine(engine);
  return engine;
}
