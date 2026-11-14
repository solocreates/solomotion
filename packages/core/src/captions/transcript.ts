import { createId } from "../ids";
import type { CaptionCue } from "../schema";
import { segmentText } from "../text/segment";

/**
 * TRANSCRIPT → CAPTIONS — the pure half of auto-captioning.
 *
 * A transcriber returns timed WORDS; a caption layer wants PHRASES a person
 * can read in one glance, each carrying its own word cues. The phrasing rule is
 * the one subtitlers use: break on a sentence end, on a breath (a pause longer
 * than `maxGapMs`), or when the phrase would exceed `maxWords` — whichever
 * comes first — and never leave a one-word orphan when it can join its
 * neighbour.
 *
 * Output is plain data: text, a span in source time, and cues relative to the
 * phrase's own start. The caller makes caption layers from it; nothing here
 * knows what a clip is.
 */

export interface TimedWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface CaptionPhrase {
  text: string;
  startMs: number;
  endMs: number;
  /** Word cues, grapheme-indexed into `text`, times relative to `startMs`. */
  cues: CaptionCue[];
}

export interface PhraseOptions {
  maxWords?: number;
  maxGapMs?: number;
  /** Keep a phrase on screen at least this long, so short words can be read. */
  minDurationMs?: number;
}

export function phrasesFromWords(words: readonly TimedWord[], options: PhraseOptions = {}): CaptionPhrase[] {
  const maxWords = Math.max(1, options.maxWords ?? 4);
  const maxGap = options.maxGapMs ?? 450;
  const minDur = options.minDurationMs ?? 600;
  const clean = words
    .map((w) => ({ ...w, text: w.text.trim() }))
    .filter((w) => w.text && Number.isFinite(w.startMs) && w.endMs >= w.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const groups: TimedWord[][] = [];
  let current: TimedWord[] = [];
  for (const w of clean) {
    const prev = current[current.length - 1];
    const breath = prev && w.startMs - prev.endMs > maxGap;
    const sentence = prev && /[.!?…]["')\]]*$/.test(prev.text);
    if (current.length && (breath || sentence || current.length >= maxWords)) {
      groups.push(current);
      current = [];
    }
    current.push(w);
  }
  if (current.length) groups.push(current);

  // A lone trailing word reads as a stutter; fold it back when it was not a breath apart.
  for (let i = groups.length - 1; i > 0; i--) {
    const g = groups[i]!;
    const before = groups[i - 1]!;
    if (g.length === 1 && g[0]!.startMs - before[before.length - 1]!.endMs <= maxGap && before.length < maxWords + 1) {
      before.push(g[0]!);
      groups.splice(i, 1);
    }
  }

  return groups.map((g, i) => {
    const startMs = Math.round(g[0]!.startMs);
    const next = groups[i + 1];
    const naturalEnd = Math.round(g[g.length - 1]!.endMs);
    // Hold short phrases a little longer, but never into the next one.
    const endMs = Math.max(naturalEnd, Math.min(startMs + minDur, next ? Math.round(next[0]!.startMs) : Infinity));
    const text = g.map((w) => w.text).join(" ");
    const cues: CaptionCue[] = [];
    let cursor = 0;
    for (const w of g) {
      const len = segmentText(w.text).graphemes.length;
      cues.push({
        id: createId("cue"),
        start: cursor,
        end: cursor + len,
        startMs: Math.max(0, Math.round(w.startMs) - startMs),
        endMs: Math.max(0, Math.round(w.endMs) - startMs),
      });
      cursor += len + 1;
    }
    return { text, startMs, endMs: Math.max(endMs, startMs + 1), cues };
  });
}

/**
 * Stretches of silence between words — what "cut the dead air" removes. Each
 * gap is trimmed by `padMs` on both sides so cuts land in the pause, not on a
 * syllable. Times are in the words' own clock.
 */
export function silencesBetween(words: readonly TimedWord[], minGapMs = 700, padMs = 120): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const sorted = [...words].sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!.endMs + padMs;
    const b = sorted[i]!.startMs - padMs;
    if (b - a >= minGapMs - 2 * padMs && b > a) out.push([Math.round(a), Math.round(b)]);
  }
  return out;
}
