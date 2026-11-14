import type { SpeechEnergy } from "./engine";
import type { VisemeCue } from "./types";
import type { VisemeId } from "./visemes";

/**
 * THE loudness envelope — one function behind every engine's `energy`, so
 * `loudness()` reads the same thing whatever produced the track.
 *
 * RMS per hop → dB against the take's own robust peak (98th percentile, so one
 * clap doesn't flatten the rest) → 0..1 over a `floorDb` range (perceptual:
 * a whisper still moves the jaw a little) → attack/release follower (fast
 * open, slower close — mouths don't snap shut).
 */
export interface EnvelopeOptions {
  hopMs?: number;
  attackMs?: number;
  releaseMs?: number;
  /** dB below the robust peak that maps to 0. */
  floorDb?: number;
}

export function energyEnvelope(samples: Float32Array, sampleRate: number, opts: EnvelopeOptions = {}): SpeechEnergy {
  const hopMs = opts.hopMs ?? 10;
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const n = Math.ceil(samples.length / hop);
  const rms = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    // Window = two hops centred on the hop, so the curve isn't late by half a window.
    const from = Math.max(0, f * hop - (hop >> 1));
    const to = Math.min(samples.length, f * hop + hop + (hop >> 1));
    let acc = 0;
    for (let i = from; i < to; i++) acc += samples[i]! * samples[i]!;
    rms[f] = to > from ? Math.sqrt(acc / (to - from)) : 0;
  }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const ref = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))] ?? 0;
  const floorDb = opts.floorDb ?? -42;
  const raw = new Array<number>(n);
  for (let f = 0; f < n; f++) {
    const db = ref > 0 && rms[f]! > 0 ? 20 * Math.log10(rms[f]! / ref) : -Infinity;
    raw[f] = Math.min(1, Math.max(0, (db - floorDb) / -floorDb));
  }
  return { hopMs, values: follow(raw, hopMs, opts.attackMs ?? 12, opts.releaseMs ?? 70) };
}

/** Attack/release one-pole follower, rounded to 3 decimals (smaller cache JSON). */
function follow(raw: number[], hopMs: number, attackMs: number, releaseMs: number): number[] {
  const a = Math.exp(-hopMs / Math.max(1e-3, attackMs));
  const r = Math.exp(-hopMs / Math.max(1e-3, releaseMs));
  const out = new Array<number>(raw.length);
  let y = 0;
  for (let i = 0; i < raw.length; i++) {
    const x = raw[i]!;
    const k = x > y ? a : r;
    y = k * y + (1 - k) * x;
    out[i] = Math.round(y * 1000) / 1000;
  }
  return out;
}

/** How open each canonical mouth is, 0..1 — the envelope of a track with no audio. */
export const VISEME_OPENNESS: Readonly<Record<VisemeId, number>> = {
  X: 0, MBP: 0.05, FV: 0.2, S: 0.25, U: 0.35, L: 0.45, E: 0.55, O: 0.75, AI: 1,
};

/** An envelope derived from cues (align from words alone, no pcm). */
export function energyFromCues(cues: readonly VisemeCue[], durationMs: number, hopMs = 10): SpeechEnergy {
  const n = Math.ceil(durationMs / hopMs);
  const raw = new Array<number>(n).fill(0);
  let ci = 0;
  for (let f = 0; f < n; f++) {
    const t = f * hopMs;
    while (ci < cues.length && cues[ci]!.endMs <= t) ci++;
    const c = cues[ci];
    raw[f] = c && c.startMs <= t ? VISEME_OPENNESS[c.viseme] : 0;
  }
  return { hopMs, values: follow(raw, hopMs, 12, 70) };
}

/** Energy at a time, linearly interpolated; 0 outside. */
export function energyAt(energy: SpeechEnergy, tMs: number): number {
  const x = tMs / energy.hopMs;
  const i = Math.floor(x);
  if (i < 0 || i >= energy.values.length) return 0;
  const a = energy.values[i]!;
  const b = energy.values[i + 1] ?? a;
  return a + (b - a) * (x - i);
}
