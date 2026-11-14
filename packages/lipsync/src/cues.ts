import { MinHeap } from "./heap";
import { PHONEMES, SILENCE, type TimedPhoneme } from "./phonemes";
import type { LipSyncAnalysis, VisemeCue } from "./types";
import type { VisemeId } from "./visemes";

/**
 * Pure cue post-processing — shared by every engine (label smoothing, run
 * merging, phoneme → cue) and by hosts (normalising, edits, quantizing, span
 * planning). The anti-robot "feel" pass lives beside it in `shape.ts`.
 */

/** Majority-vote (mode) filter over categorical labels, window = 2r+1. */
export function modeFilter(labels: VisemeId[], radius: number): VisemeId[] {
  if (radius <= 0 || labels.length === 0) return labels.slice();
  const out = new Array<VisemeId>(labels.length);
  for (let i = 0; i < labels.length; i++) {
    const counts = new Map<VisemeId, number>();
    for (let j = Math.max(0, i - radius); j <= Math.min(labels.length - 1, i + radius); j++) {
      counts.set(labels[j]!, (counts.get(labels[j]!) ?? 0) + 1);
    }
    let best = labels[i]!;
    let bestN = -1;
    for (const [v, n] of counts) if (n > bestN || (n === bestN && v === labels[i])) { best = v; bestN = n; }
    out[i] = best;
  }
  return out;
}

/**
 * Turn framewise labels into cues: run-length encode, absorb runs shorter than
 * `minCueMs` into their longer neighbour (shortest first, earliest on ties,
 * the earlier neighbour on equal length), coalescing identical neighbours the
 * absorption exposes. `confidence` is the fraction of ORIGINAL frames in each
 * final span that agree with its label.
 *
 * Heap + linked list: O(n log n). The first version rescanned every run per
 * absorption (O(n²) — minutes on an hour of audio); a test pins this one to
 * that reference's exact output.
 */
export function labelsToCues(labels: VisemeId[], hopMs: number, minCueMs: number): VisemeCue[] {
  if (labels.length === 0) return [];
  const start: number[] = [];
  const end: number[] = [];
  const vis: VisemeId[] = [];
  for (let i = 0; i < labels.length; i++) {
    const last = vis.length - 1;
    if (last >= 0 && vis[last] === labels[i]) end[last] = i + 1;
    else { start.push(i); end.push(i + 1); vis.push(labels[i]!); }
  }
  const n = vis.length;
  const prev = Array.from({ length: n }, (_, i) => i - 1);
  const next = Array.from({ length: n }, (_, i) => (i + 1 < n ? i + 1 : -1));
  const alive = new Array<boolean>(n).fill(true);
  let count = n;
  const minFrames = Math.max(1, Math.round(minCueMs / hopMs));
  const heap = new MinHeap<[number, number, number]>(); // [run, len, start] at push time
  const len = (i: number) => end[i]! - start[i]!;
  const queue = (i: number) => heap.push(len(i), start[i]!, [i, len(i), start[i]!]);
  for (let i = 0; i < n; i++) if (len(i) < minFrames) queue(i);
  const unlink = (i: number) => {
    alive[i] = false;
    count--;
    const p = prev[i]!, q = next[i]!;
    if (p >= 0) next[p] = q;
    if (q >= 0) prev[q] = p;
  };

  while (count > 1 && heap.size > 0) {
    const [i, l, st] = heap.pop()!;
    // Stale: the run died, grew or moved since it was queued (its live key is queued too).
    if (!alive[i] || len(i) !== l || start[i] !== st || l >= minFrames) continue;
    const p = prev[i]!, q = next[i]!;
    const into = p < 0 ? q : q < 0 ? p : len(p) >= len(q) ? p : q;
    if (into === p) end[p] = end[i]!;
    else start[q] = start[i]!;
    unlink(i);
    // Coalesce the pair the absorption exposed (the earlier run keeps it).
    let grown = into;
    const a = into === p ? p : prev[q]!;
    const b = into === p ? next[p]! : q;
    if (a >= 0 && b >= 0 && vis[a] === vis[b]) {
      end[a] = end[b]!;
      unlink(b);
      grown = a;
    }
    if (len(grown) < minFrames) queue(grown);
  }

  const out: VisemeCue[] = [];
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    let agree = 0;
    for (let f = start[i]!; f < end[i]!; f++) if (labels[f] === vis[i]) agree++;
    out.push({
      startMs: Math.round(start[i]! * hopMs),
      endMs: Math.round(end[i]! * hopMs),
      viseme: vis[i]!,
      confidence: agree / len(i),
    });
  }
  return out;
}

/** Index of the cue containing `tMs` (binary search; cues sorted, non-overlapping), or -1. */
export function cueIndexAt(cues: readonly VisemeCue[], tMs: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid]!;
    if (tMs < c.startMs) hi = mid - 1;
    else if (tMs >= c.endMs) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** The viseme audible at `tMs`, or null outside every cue. O(log n). */
export function visemeAt(analysis: Pick<LipSyncAnalysis, "cues">, tMs: number): VisemeId | null {
  const i = cueIndexAt(analysis.cues, tMs);
  return i < 0 ? null : analysis.cues[i]!.viseme;
}

/**
 * Make any cue list obey the contract: finite, sorted, non-overlapping
 * (a later cue wins its overlap), gaps filled with rest, identical
 * neighbours merged, covering [0, durationMs] when a duration is given.
 */
export function normalizeCues(cues: readonly VisemeCue[], durationMs?: number): VisemeCue[] {
  const sorted = cues
    .filter((c) => Number.isFinite(c.startMs) && Number.isFinite(c.endMs) && c.endMs > Math.max(0, c.startMs))
    .map((c) => ({ ...c, startMs: Math.max(0, c.startMs) }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out: VisemeCue[] = [];
  const push = (c: VisemeCue) => {
    if (c.endMs <= c.startMs) return;
    const last = out[out.length - 1];
    if (last && last.viseme === c.viseme && last.endMs === c.startMs) {
      const a = last.endMs - last.startMs, b = c.endMs - c.startMs;
      last.confidence = (last.confidence * a + c.confidence * b) / (a + b);
      if (c.intensity !== undefined || last.intensity !== undefined) {
        last.intensity = ((last.intensity ?? 1) * a + (c.intensity ?? 1) * b) / (a + b);
      }
      last.endMs = c.endMs;
    } else out.push(c);
  };
  for (const c of sorted) {
    const last = out[out.length - 1];
    const cursor = last?.endMs ?? 0;
    if (last && last.endMs > c.startMs) {
      // The later cue wins its overlap; whatever of the earlier one outlives it resumes after.
      const tail = last.endMs > c.endMs ? { ...last, startMs: c.endMs } : null;
      last.endMs = c.startMs;
      if (last.endMs <= last.startMs) out.pop();
      push({ ...c });
      if (tail) push(tail);
      continue;
    }
    if (c.startMs > cursor) push({ startMs: cursor, endMs: c.startMs, viseme: "X", confidence: 1 });
    push({ ...c });
  }
  if (durationMs !== undefined && durationMs > 0) {
    while (out.length && out[out.length - 1]!.startMs >= durationMs) out.pop();
    const last = out[out.length - 1];
    if (last && last.endMs > durationMs) last.endMs = durationMs;
    push({ startMs: out[out.length - 1]?.endMs ?? 0, endMs: durationMs, viseme: "X", confidence: 1 });
  }
  return out;
}

/** Below this a diphthong shows one shape (two would flicker). */
const MIN_GLIDE_PART_MS = 35;

/**
 * Phoneme timeline → cues, the ONE mapping every phoneme-aware engine
 * (align, remote models, the Test Voice) shares:
 *  - silence → rest;
 *  - diphthongs split into their two shapes at 55% ("eye" = AI then E);
 *  - transparent phonemes (H) take the next sound's mouth when it follows
 *    without a pause ("who" is round from the start).
 * Identical neighbours merge; confidence is 1 (phonemes are known, not heard).
 */
export function phonemesToCues(phonemes: readonly TimedPhoneme[], durationMs?: number): VisemeCue[] {
  const list = [...phonemes]
    .filter((p) => p.endMs > p.startMs && Number.isFinite(p.startMs) && Number.isFinite(p.endMs))
    .sort((a, b) => a.startMs - b.startMs);
  const raw: VisemeCue[] = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i]!;
    if (p.phoneme === SILENCE) {
      raw.push({ startMs: p.startMs, endMs: p.endMs, viseme: "X", confidence: 1 });
      continue;
    }
    const info = PHONEMES[p.phoneme];
    let viseme = info.viseme;
    if (info.transparent) {
      for (let j = i + 1; j < list.length; j++) {
        const q = list[j]!;
        if (q.phoneme === SILENCE || q.startMs - list[j - 1]!.endMs > 1) break;
        const qi = PHONEMES[q.phoneme];
        if (!qi.transparent) { viseme = qi.viseme; break; }
      }
    }
    const d = p.endMs - p.startMs;
    if (info.glide && info.glide !== viseme && d * 0.45 >= MIN_GLIDE_PART_MS) {
      const mid = p.startMs + d * 0.55;
      raw.push({ startMs: p.startMs, endMs: mid, viseme, confidence: 1 });
      raw.push({ startMs: mid, endMs: p.endMs, viseme: info.glide, confidence: 1 });
    } else raw.push({ startMs: p.startMs, endMs: p.endMs, viseme, confidence: 1 });
  }
  return normalizeCues(raw, durationMs);
}

/**
 * Hand edits over computed cues (UX §3.4: edits live in the voice's own time
 * and win their ranges). An edit's `viseme: "rest"` is rest — Delete never
 * stretches the neighbours.
 */
export interface CueEdit {
  startMs: number;
  endMs: number;
  viseme: VisemeId | "rest";
}
export function overlayCues(cues: readonly VisemeCue[], edits: readonly CueEdit[], durationMs?: number): VisemeCue[] {
  if (edits.length === 0) return normalizeCues(cues, durationMs);
  const sortedEdits = edits.filter((e) => e.endMs > e.startMs).sort((a, b) => a.startMs - b.startMs);
  const out: VisemeCue[] = [];
  for (const c of cues) {
    // Cut each computed cue around every edit it overlaps.
    let pieces: VisemeCue[] = [{ ...c }];
    for (const e of sortedEdits) {
      if (e.endMs <= c.startMs || e.startMs >= c.endMs) continue;
      pieces = pieces.flatMap((p) => {
        if (e.endMs <= p.startMs || e.startMs >= p.endMs) return [p];
        const parts: VisemeCue[] = [];
        if (e.startMs > p.startMs) parts.push({ ...p, endMs: e.startMs });
        if (e.endMs < p.endMs) parts.push({ ...p, startMs: e.endMs });
        return parts;
      });
    }
    out.push(...pieces);
  }
  for (const e of sortedEdits) {
    out.push({ startMs: e.startMs, endMs: e.endMs, viseme: e.viseme === "rest" ? "X" : e.viseme, confidence: 1 });
  }
  return normalizeCues(out, durationMs);
}

/**
 * Snap cue boundaries to a grid (1000/fps for on-frame swaps, 2× for "on
 * twos"). A closure (MBP) that would round away keeps one grid cell taken
 * from its longer neighbour — the lips always meet on screen.
 */
export function quantizeCues(cues: readonly VisemeCue[], gridMs: number): VisemeCue[] {
  if (!(gridMs > 0) || cues.length === 0) return cues.map((c) => ({ ...c }));
  const snap = (t: number) => Math.round(t / gridMs) * gridMs;
  const b = [snap(cues[0]!.startMs), ...cues.map((c) => snap(c.endMs))];
  for (let i = 0; i < cues.length; i++) {
    if (cues[i]!.viseme !== "MBP" || b[i + 1]! > b[i]!) continue;
    const prevLen = i > 0 ? b[i]! - b[i - 1]! : 0;
    const nextLen = i + 1 < cues.length ? b[i + 2]! - b[i + 1]! : 0;
    if (nextLen >= 2 * gridMs && nextLen >= prevLen) b[i + 1] = b[i + 1]! + gridMs;
    else if (prevLen >= 2 * gridMs) b[i] = b[i]! - gridMs;
  }
  const out: VisemeCue[] = [];
  for (let i = 0; i < cues.length; i++) {
    const s = Math.max(b[i]!, out.length ? out[out.length - 1]!.endMs : -Infinity);
    const e = b[i + 1]!;
    if (e <= s) continue;
    const last = out[out.length - 1];
    if (last && last.viseme === cues[i]!.viseme && last.endMs === s) last.endMs = e;
    else out.push({ ...cues[i]!, startMs: s, endMs: e });
  }
  return out;
}

/** A planned timeline span — what a host materializes as one clip. */
export interface MouthSpan {
  startMs: number;
  durationMs: number;
  viseme: VisemeId;
}

export interface PlanOptions {
  /**
   * Snap span boundaries to this grid (e.g. 1000/fps for on-frame switches, or
   * 2× that for classic "on twos" cartoon timing). 0/undefined = raw cue times.
   */
  quantizeMs?: number;
  /** Drop planned spans shorter than this after quantization (default: quantize step, else 1ms). */
  minSpanMs?: number;
}

/**
 * Turn cues into a gap-free plan of mouth spans — the pure step between an
 * analysis and a generated track. Quantizes to the grid, merges adjacent
 * same-viseme spans, and guarantees spans are sorted and non-overlapping, so a
 * host can map each span to art and place clips 1:1 with no further checks.
 */
export function planMouthSpans(cues: VisemeCue[], opts: PlanOptions = {}): MouthSpan[] {
  const q = opts.quantizeMs && opts.quantizeMs > 0 ? opts.quantizeMs : 0;
  const minSpan = opts.minSpanMs ?? (q || 1);
  const snap = (t: number) => (q ? Math.round(t / q) * q : t);

  const spans: MouthSpan[] = [];
  for (const cue of cues) {
    const start = snap(cue.startMs);
    const end = snap(cue.endMs);
    if (end - start < minSpan) continue;
    const last = spans[spans.length - 1];
    // Clamp against the previous span (quantization can pull starts backwards).
    const s = last ? Math.max(start, last.startMs + last.durationMs) : start;
    if (end <= s) continue;
    if (last && last.viseme === cue.viseme && last.startMs + last.durationMs === s) {
      last.durationMs = end - last.startMs;
    } else {
      spans.push({ startMs: s, durationMs: end - s, viseme: cue.viseme });
    }
  }
  return spans;
}
