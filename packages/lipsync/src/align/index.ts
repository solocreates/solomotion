/**
 * `@solomotion/lipsync/align` — the transcript-aligned engine (lazy entry).
 *
 *   words with times (any transcriber, any AI, a TTS's alignment)
 *     → G2P per word → phoneme durations by class weight inside each word
 *     → short inter-word gaps hold, real pauses rest → phonemesToCues
 *   phonemes with times (a phoneme model)          → phonemesToCues directly
 *   text + pcm, no times                            → rough alignment: words
 *     laid over the voiced stretches of the loudness envelope by expected length
 *
 * Output cues are EXACT (no lead, no hold): the feel pass (`shapeCues`) runs
 * at read time, so changing feel never re-aligns. Linear in the input size.
 */
import { energyEnvelope, energyFromCues } from "../energy";
import { numSetting, settingsKey, strSetting, type AlignImpl, type SpeechInput, type SpeechTrack, type SpeechWord } from "../engine";
import { ALIGN } from "../engines/meta";
import { normalizeCues, phonemesToCues } from "../cues";
import { loadLanguage, type LanguageImpl } from "../language";
import { phonemeWeight, type PhonemeToken, type TimedPhoneme } from "../phonemes";
import type { VisemeCue } from "../types";

/** Shortest a word may be when its timing says less (≈ a fast syllable). */
const MIN_WORD_MS = 60;

/**
 * Make transcriber output safe: finite, sorted, non-negative, overlaps cut at
 * the later word's start (or the overlap's middle when one swallows the
 * other), zero-length words widened into the free time around them.
 */
export function sanitizeWords(words: readonly SpeechWord[]): SpeechWord[] {
  const ws = words
    .filter((w) => Number.isFinite(w.startMs) && Number.isFinite(w.endMs) && w.text.trim() !== "")
    .map((w) => ({ text: w.text.trim(), startMs: Math.max(0, w.startMs), endMs: Math.max(0, w.startMs, w.endMs) }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  for (let i = 1; i < ws.length; i++) {
    const p = ws[i - 1]!;
    const w = ws[i]!;
    if (w.startMs < p.endMs) {
      const cut = w.startMs > p.startMs ? w.startMs : (p.startMs + Math.min(p.endMs, w.endMs)) / 2;
      p.endMs = cut;
      w.startMs = Math.max(w.startMs, cut);
      w.endMs = Math.max(w.endMs, w.startMs);
    }
  }
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    const need = MIN_WORD_MS - (w.endMs - w.startMs);
    if (need <= 0) continue;
    const nextStart = ws[i + 1]?.startMs ?? Infinity;
    const grow = Math.min(need, Math.max(0, nextStart - w.endMs));
    w.endMs += grow;
    const prevEnd = ws[i - 1]?.endMs ?? 0;
    w.startMs -= Math.min(need - grow, Math.max(0, w.startMs - prevEnd));
  }
  return ws;
}

/** Spread a word's phonemes over its time by class weight (stressed vowels long, schwas short). */
function spread(ps: readonly PhonemeToken[], startMs: number, endMs: number, out: TimedPhoneme[]): void {
  const total = ps.reduce((n, p) => n + phonemeWeight(p), 0);
  let t = startMs;
  let acc = 0;
  for (const p of ps) {
    acc += phonemeWeight(p);
    const e = startMs + ((endMs - startMs) * acc) / total;
    out.push(p.stress !== undefined ? { phoneme: p.phoneme, stress: p.stress, startMs: t, endMs: e } : { phoneme: p.phoneme, startMs: t, endMs: e });
    t = e;
  }
}

/** Timed words → a phoneme timeline (gaps under `minGapMs` hold the last sound). */
export function wordsToPhonemes(lang: LanguageImpl, words: readonly SpeechWord[], minGapMs: number = ALIGN.defaults.minGapMs): TimedPhoneme[] {
  const out: TimedPhoneme[] = [];
  const ws = sanitizeWords(words);
  const memo = new Map<string, PhonemeToken[]>(); // transcripts repeat words; G2P each once
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    let ps = memo.get(w.text);
    if (!ps) memo.set(w.text, (ps = lang.wordPhonemes(w.text)));
    const prevEnd = out.length ? out[out.length - 1]!.endMs : 0;
    const gap = w.startMs - prevEnd;
    if (gap > 0) {
      if (gap < minGapMs && out.length && out[out.length - 1]!.phoneme !== "SIL") out[out.length - 1]!.endMs = w.startMs;
      else out.push({ phoneme: "SIL", startMs: prevEnd, endMs: w.startMs });
    }
    if (ps.length && w.endMs > w.startMs) spread(ps, w.startMs, w.endMs, out);
    else if (w.endMs > w.startMs) out.push({ phoneme: "SIL", startMs: w.startMs, endMs: w.endMs });
  }
  return out;
}

/**
 * Words with no times: lay them over the voiced stretches of an envelope
 * (or, with none, at a natural speaking rate from 0). A monotone warp of
 * "expected time" onto "voiced time" — pauses in the audio are skipped, each
 * word lands where its share of the speech falls.
 */
export function roughWords(lang: LanguageImpl, text: string, envelope?: { hopMs: number; values: number[] }): SpeechWord[] {
  const toks = lang.phonemize(text);
  const words: { text: string; ms: number }[] = [];
  // Pauses come from the audio (its quiet stretches), not the punctuation.
  for (const t of toks) {
    if (t.kind === "word") words.push({ text: t.text, ms: Math.max(MIN_WORD_MS, t.phonemes.reduce((n, p) => n + phonemeWeight(p), 0)) });
  }
  if (!envelope) {
    let t = 0;
    return words.map((w) => ({ text: w.text, startMs: t, endMs: (t += w.ms) }));
  }
  // Voiced stretches (envelope above a gate), bridging dips under 120 ms.
  const { hopMs, values } = envelope;
  const segs: [number, number][] = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i]! < 0.35) continue;
    const s = i * hopMs;
    let j = i;
    while (j < values.length && values[j]! >= 0.35) j++;
    const last = segs[segs.length - 1];
    if (last && s - last[1] < 120) last[1] = j * hopMs;
    else segs.push([s, j * hopMs]);
    i = j;
  }
  const voiced = segs.reduce((n, [a, b]) => n + b - a, 0);
  const expected = words.reduce((n, w) => n + w.ms, 0);
  if (!voiced || !expected) return [];
  const at = (x: number) => {
    // voiced-time offset → absolute time
    let left = x;
    for (const [a, b] of segs) {
      if (left <= b - a) return a + left;
      left -= b - a;
    }
    return segs[segs.length - 1]![1];
  };
  let acc = 0;
  return words.map((w) => {
    const s = at((acc / expected) * voiced);
    acc += w.ms;
    const e = at((acc / expected) * voiced - 1e-6);
    // A word straddling a pause sits on the side holding most of it.
    return { text: w.text, startMs: s, endMs: Math.max(s, e) };
  });
}

/** Latest end time (no spread: huge inputs would overflow the argument list). */
const maxEnd = (xs: readonly { endMs: number }[]) => xs.reduce((m, x) => (x.endMs > m ? x.endMs : m), 0);

/** Ready cues (a viseme stream) → a SpeechTrack, with the same energy rule as align. */
export async function trackFromCues(cues: readonly VisemeCue[], input: SpeechInput): Promise<SpeechTrack> {
  const durationMs = input.pcm ? (input.pcm.samples.length / input.pcm.sampleRate) * 1000 : input.durationMs ?? maxEnd(cues);
  const norm = normalizeCues(cues, durationMs);
  return {
    engine: ALIGN.id,
    version: ALIGN.version,
    settingsKey: settingsKey({}, ALIGN.defaults),
    durationMs,
    cues: norm,
    energy: input.pcm ? energyEnvelope(input.pcm.samples, input.pcm.sampleRate) : energyFromCues(norm, durationMs),
  };
}

export const alignImpl: AlignImpl = {
  kind: "align",
  async align(input, settings = {}, run = {}): Promise<SpeechTrack> {
    const language = strSetting(settings, "language", input.language ?? ALIGN.defaults.language);
    const minGapMs = numSetting(settings, "minGapMs", ALIGN.defaults.minGapMs);
    const pcm = input.pcm;
    const energy = pcm ? energyEnvelope(pcm.samples, pcm.sampleRate) : undefined;
    let words: SpeechWord[] | undefined;
    let phonemes: TimedPhoneme[];
    if (input.phonemes?.length) {
      phonemes = [...input.phonemes];
    } else {
      const lang = await loadLanguage(language);
      words = input.words?.length ? sanitizeWords(input.words) : roughWords(lang, input.text ?? "", energy);
      phonemes = wordsToPhonemes(lang, words, minGapMs);
    }
    run.onProgress?.(1);
    const durationMs = pcm
      ? (pcm.samples.length / pcm.sampleRate) * 1000
      : input.durationMs ?? Math.max(maxEnd(phonemes), maxEnd(words ?? []));
    const cues = phonemesToCues(phonemes, durationMs);
    return {
      engine: ALIGN.id,
      version: ALIGN.version,
      settingsKey: settingsKey({ ...settings, language }, ALIGN.defaults),
      durationMs,
      cues,
      energy: energy ?? energyFromCues(cues, durationMs),
      ...(words ? { words } : {}),
      phonemes,
    };
  },
};

export { alignImpl as impl };
