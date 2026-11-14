import { normalizeCues, overlayCues, quantizeCues, type CueEdit } from "./cues";
import { energyAt } from "./energy";
import type { SpeechEnergy } from "./engine";
import { MinHeap } from "./heap";
import type { VisemeCue } from "./types";
import type { VisemeId } from "./visemes";

/**
 * THE FEEL PASS (UX spec §3, "Lip sync feel") — engine cues → cues that read
 * as acting, not a robot. ONE pure function, run at READ time, so changing the
 * feel never re-analyses:
 *
 *   gate      breaths, room tone, music under the floor never open the mouth
 *   bridge    a silence < 150 ms inside a phrase holds the last shape
 *   round     a U/O pulls a short S/E/L just before it round ("stew")
 *   hold      cues under min hold merge into the neighbour with the higher
 *             visual priority (MBP > FV > O ≈ U > AI > E > L > S > rest);
 *             a closure (MBP, FV) is NEVER dropped — it borrows time instead
 *   edits     hand fixes (voice time) win their ranges; Delete = rest
 *   energy    intensity = knob × the voice's loudness over the cue
 *   lead      pose changes arrive early (drawings 60 / morph 90 / bones 110 ms)
 *   grid      drawings snap to frames (closures survive the rounding)
 *
 * Flicker smoothing ("downsampling") falls out of `hold`: no shape can be
 * shorter than min hold (≥ 33 ms), so three changes per 100 ms can't happen.
 */

export type MouthProfile = "drawings" | "morph" | "bones";

export interface FeelProfile {
  leadMs: number;
  /** Min hold in ms; drawings use 2 frames at the comp's fps (≥ 60 ms). */
  minHoldMs: (fps: number) => number;
  /** Blend hint for PoseMix (0 = cut). The pass itself never blends. */
  blendMs: number;
  /** Snap to the frame grid. */
  onFrames: boolean;
}

export const FEEL_PROFILES: Readonly<Record<MouthProfile, FeelProfile>> = {
  drawings: { leadMs: 60, minHoldMs: (fps) => Math.max(60, (2 * 1000) / fps), blendMs: 0, onFrames: true },
  morph: { leadMs: 90, minHoldMs: () => 50, blendMs: 80, onFrames: false },
  bones: { leadMs: 110, minHoldMs: () => 70, blendMs: 100, onFrames: false },
};

export interface FeelOptions {
  profile?: MouthProfile;
  /** Comp frame rate (min hold in frames, the grid). Default 24. */
  fps?: number;
  /** Overrides of the profile's numbers (Feel presets: Snappy, Relaxed…). */
  leadMs?: number;
  minHoldMs?: number;
  /** 0..1(+) openness knob; 1 = as heard. */
  energy?: number;
  /** The voice's loudness envelope (track.energy): gate + per-cue intensity. */
  loudness?: SpeechEnergy;
  /** Loudness below this (0..1) is not speech. Default 0.12. */
  gate?: number;
  /** Silence shorter than this inside a phrase holds the last shape. Default 150. */
  bridgeMs?: number;
  /** A short S/E/L within this before a U/O goes round. Default 120. */
  roundAheadMs?: number;
  /** Hand edits in the voice's own time, applied after clean, before lead. */
  edits?: readonly CueEdit[];
  /** Cover [0, durationMs]. */
  durationMs?: number;
}

/** Visual priority for merges — closures first, rest last. */
export const VISEME_PRIORITY: Readonly<Record<VisemeId, number>> = { MBP: 8, FV: 7, O: 6, U: 6, AI: 5, E: 4, L: 3, S: 2, X: 1 };
const CLOSURE = (v: VisemeId) => v === "MBP" || v === "FV";
const ROUND = (v: VisemeId) => v === "O" || v === "U";

function meanLoudness(e: SpeechEnergy, a: number, b: number): number {
  const i0 = Math.max(0, Math.floor(a / e.hopMs));
  const i1 = Math.min(e.values.length, Math.ceil(b / e.hopMs));
  if (i1 <= i0) return energyAt(e, (a + b) / 2);
  let s = 0;
  for (let i = i0; i < i1; i++) s += e.values[i]!;
  return s / (i1 - i0);
}

export function shapeCues(input: readonly VisemeCue[], opts: FeelOptions = {}): VisemeCue[] {
  const profile = FEEL_PROFILES[opts.profile ?? "drawings"];
  const fps = opts.fps && opts.fps > 0 ? opts.fps : 24;
  const minHold = opts.minHoldMs ?? profile.minHoldMs(fps);
  const lead = opts.leadMs ?? profile.leadMs;
  const gate = opts.gate ?? 0.12;
  const bridge = opts.bridgeMs ?? 150;
  const roundAhead = opts.roundAheadMs ?? 120;
  const loud = opts.loudness;

  let cues = normalizeCues(input, opts.durationMs);

  // 1 · gate non-speech
  if (loud) cues = normalizeCues(cues.map((c) => (c.viseme !== "X" && meanLoudness(loud, c.startMs, c.endMs) < gate ? { ...c, viseme: "X" } : c)), opts.durationMs);

  // 2 · bridge short silences inside a phrase (the previous shape holds, a step softer)
  cues = normalizeCues(
    cues.map((c, i) => {
      const p = cues[i - 1];
      const n = cues[i + 1];
      if (c.viseme !== "X" || !p || !n || c.endMs - c.startMs >= bridge) return c;
      return { ...c, viseme: p.viseme, intensity: (p.intensity ?? 1) * 0.8 };
    }),
    opts.durationMs,
  );

  // 3 · anticipate rounding
  cues = normalizeCues(
    cues.map((c, i) => {
      const n = cues[i + 1];
      if (!n || !ROUND(n.viseme) || (c.viseme !== "S" && c.viseme !== "E" && c.viseme !== "L") || c.endMs - c.startMs > roundAhead) return c;
      return { ...c, viseme: n.viseme };
    }),
    opts.durationMs,
  );

  // 4 · priority merge + closures that borrow
  cues = holdMerge(cues, minHold);

  // 5 · hand edits
  if (opts.edits?.length) cues = overlayCues(cues, opts.edits, opts.durationMs);

  // 6 · energy → intensity
  const knob = opts.energy ?? 1;
  if (loud || knob !== 1) {
    cues = cues.map((c) => {
      if (c.viseme === "X") return c;
      const heard = loud ? 0.45 + 0.55 * Math.min(1, meanLoudness(loud, c.startMs, c.endMs) / 0.8) : 1;
      return { ...c, intensity: Math.round(knob * heard * (c.intensity ?? 1) * 1000) / 1000 };
    });
  }

  // 7 · lead: every change into a shape arrives early; the return to rest half as early
  if (lead !== 0 && cues.length > 1) {
    const b = cues.map((c) => c.startMs);
    for (let i = 1; i < cues.length; i++) b[i] = Math.max(0, b[i]! - (cues[i]!.viseme === "X" ? lead / 2 : lead));
    for (let i = 1; i < b.length; i++) b[i] = Math.max(b[i]!, b[i - 1]!);
    const end = cues[cues.length - 1]!.endMs;
    cues = cues.map((c, i) => ({ ...c, startMs: b[i]!, endMs: b[i + 1] ?? end })).filter((c) => c.endMs > c.startMs);
    cues = normalizeCues(cues, opts.durationMs);
  }

  // 8 · frame grid
  if (profile.onFrames) cues = normalizeCues(quantizeCues(cues, 1000 / fps), opts.durationMs);
  return cues;
}

/**
 * Cues shorter than `minHold`, shortest first: a closure takes time from its
 * longer neighbour (the FOLLOWING one first) while that neighbour stays above
 * min hold; anything else merges into the neighbour with the higher visual
 * priority. O(n log n).
 */
function holdMerge(cues: VisemeCue[], minHold: number): VisemeCue[] {
  const n = cues.length;
  if (n < 2 || minHold <= 0) return cues;
  const c = cues.map((x) => ({ ...x }));
  const prev = c.map((_, i) => i - 1);
  const next = c.map((_, i) => (i + 1 < n ? i + 1 : -1));
  const alive = new Array<boolean>(n).fill(true);
  const len = (i: number) => c[i]!.endMs - c[i]!.startMs;
  const heap = new MinHeap<[number, number]>();
  const queue = (i: number) => heap.push(len(i), c[i]!.startMs, [i, len(i)]);
  for (let i = 0; i < n; i++) if (len(i) < minHold) queue(i);
  const unlink = (i: number) => {
    alive[i] = false;
    const p = prev[i]!, q = next[i]!;
    if (p >= 0) next[p] = q;
    if (q >= 0) prev[q] = p;
  };
  const absorb = (into: number, from: number) => {
    const a = c[into]!, b = c[from]!;
    a.startMs = Math.min(a.startMs, b.startMs);
    a.endMs = Math.max(a.endMs, b.endMs);
    unlink(from);
  };
  const coalesce = (i: number) => {
    const q = next[i]!;
    if (q >= 0 && c[q]!.viseme === c[i]!.viseme) absorb(i, q);
    const p = prev[i]!;
    if (p >= 0 && c[p]!.viseme === c[i]!.viseme) { absorb(p, i); return p; }
    return i;
  };

  while (heap.size > 0) {
    const [i, l] = heap.pop()!;
    if (!alive[i] || len(i) !== l || l >= minHold) continue;
    const p = prev[i]!, q = next[i]!;
    if (p < 0 && q < 0) break;
    const cue = c[i]!;
    if (CLOSURE(cue.viseme)) {
      const need = minHold - l;
      const donor = [q, p].find((d) => d >= 0 && len(d) - need >= minHold);
      if (donor !== undefined) {
        if (donor === q) { cue.endMs += need; c[q]!.startMs += need; }
        else { cue.startMs -= need; c[p]!.endMs -= need; }
        continue;
      }
      // No neighbour can spare the time: the closure keeps what it has (never dropped).
      if (cue.viseme === "MBP") continue;
    }
    const into = p < 0 ? q : q < 0 ? p : VISEME_PRIORITY[c[q]!.viseme] > VISEME_PRIORITY[c[p]!.viseme] ? q : p;
    absorb(into, i);
    const k = coalesce(into);
    if (len(k) < minHold) queue(k);
  }
  return c.filter((_, i) => alive[i]);
}
