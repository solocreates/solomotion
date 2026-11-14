import { sourceTimeAt } from "../animation/evaluate";
import type { ClipPlayback } from "../schema";
import { SOUND_BAND_FLOOR_DB, soundFeatureDef, type SoundAnalysis, type SoundFeature } from "./types";

/**
 * READING A SOUND AT AN INSTANT — pure functions of (analysis, source ms).
 *
 * Every value is 0..1 and interpolated between the 10 ms frames, so a value
 * driven by a sound moves as smoothly at 120 fps as at 24, and scrubbing,
 * playback and a stepped export all read the same number.
 */

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A per-frame channel at `ms`, linearly interpolated. */
function frameValue(a: SoundAnalysis, channel: Uint8Array, ms: number): number {
  const x = (ms / 1000) * a.frameRate;
  if (!(x > 0)) return (channel[0] ?? 0) / 255;
  const i = Math.floor(x);
  if (i >= a.frames - 1) return (channel[a.frames - 1] ?? 0) / 255;
  const t = x - i;
  return (channel[i]! * (1 - t) + channel[i + 1]! * t) / 255;
}

/** One stored band at `ms`, interpolated in time. */
function bandValue(a: SoundAnalysis, band: number, ms: number): number {
  const x = (ms / 1000) * a.frameRate;
  const i = Math.max(0, Math.min(a.frames - 1, Math.floor(x)));
  const j = Math.min(a.frames - 1, i + 1);
  const t = x > 0 ? Math.min(1, x - i) : 0;
  const B = a.bandCount;
  return (a.bands[i * B + band]! * (1 - t) + a.bands[j * B + band]! * t) / 255;
}

/** Where `hz` sits on the band axis, in bands (0 = the bottom edge). */
function bandCoord(a: SoundAnalysis, hz: number): number {
  return (Math.log(Math.max(1e-3, hz) / a.minHz) / Math.log(a.maxHz / a.minHz)) * a.bandCount;
}

export function soundLevelAt(a: SoundAnalysis, ms: number): number {
  return frameValue(a, a.level, ms);
}

export function soundBrightnessAt(a: SoundAnalysis, ms: number): number {
  return frameValue(a, a.centroid, ms);
}

export function soundOnsetAt(a: SoundAnalysis, ms: number): number {
  return frameValue(a, a.flux, ms);
}

/** A band value (dB-mapped 0..1) as power, and back. Zero is silence, not the floor. */
const powerOf = (v: number): number => (v > 0 ? 10 ** ((SOUND_BAND_FLOOR_DB * (1 - v)) / 10) : 0);
const valueOfPower = (p: number): number => (p > 0 ? clamp01(1 - (10 * Math.log10(p)) / SOUND_BAND_FLOOR_DB) : 0);

/**
 * The spectrum between two frequencies: the ENERGY of the bands it covers
 * (power summed, overlap-weighted, mapped back to the bands' dB scale), or the
 * one band it falls inside. Summed, not averaged — one strong note in the bass
 * is a loud bass, not a loud band diluted by the empty ones beside it. 0 when
 * the range is entirely outside what the sound carries (above Nyquist, below
 * 32 Hz).
 */
export function soundRangeAt(a: SoundAnalysis, ms: number, fromHz: number, toHz: number): number {
  const lo = Math.min(fromHz, toHz);
  const hi = Math.max(fromHz, toHz);
  const x0 = Math.max(0, bandCoord(a, lo));
  const x1 = Math.min(a.bandCount, bandCoord(a, hi));
  if (x1 <= 0 || x0 >= a.bandCount) return 0;
  if (x1 - x0 < 1) {
    const b = Math.min(a.bandCount - 1, Math.max(0, Math.floor((x0 + x1) / 2)));
    return bandValue(a, b, ms);
  }
  let power = 0;
  for (let b = Math.floor(x0); b < Math.ceil(x1); b++) {
    const w = Math.min(b + 1, x1) - Math.max(b, x0);
    if (w > 0) power += powerOf(bandValue(a, b, ms)) * w;
  }
  return valueOfPower(power);
}

/**
 * `count` bars across the spectrum, bass to treble, at `ms`. Fewer bars than
 * stored bands take each group's loudest (a bar reads punchier as a peak than
 * as an average — the visualizer's long-standing rule); more bars interpolate.
 */
export function soundBandsAt(a: SoundAnalysis, ms: number, count: number): Float32Array {
  const out = new Float32Array(Math.max(0, count));
  const B = a.bandCount;
  for (let i = 0; i < count; i++) {
    const x0 = (i * B) / count;
    const x1 = ((i + 1) * B) / count;
    if (x1 - x0 >= 1) {
      let m = 0;
      for (let b = Math.floor(x0); b < Math.min(B, Math.ceil(x1)); b++) m = Math.max(m, bandValue(a, b, ms));
      out[i] = m;
    } else {
      const c = (x0 + x1) / 2 - 0.5;
      const b0 = Math.max(0, Math.min(B - 1, Math.floor(c)));
      const b1 = Math.min(B - 1, b0 + 1);
      const t = Math.max(0, Math.min(1, c - b0));
      out[i] = bandValue(a, b0, ms) * (1 - t) + bandValue(a, b1, ms) * t;
    }
  }
  return out;
}

/** The last entry ≤ `ms` in a sorted list, or -1. */
function lastAtOrBefore(list: Float32Array, ms: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! <= ms) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * The beat as a pulse: 1 on each tracked beat, falling away over about a
 * quarter of a beat, 0 once the song's beats have ended. A pulse rather than
 * a step so that `scale = 1 + 0.1 * sound("Music", "beat")` is already a kick.
 */
export function soundBeatAt(a: SoundAnalysis, ms: number): number {
  if (!a.tempo || a.beats.length === 0) return 0;
  const i = lastAtOrBefore(a.beats, ms);
  if (i < 0) return 0;
  const period = 60000 / a.tempo;
  const dt = ms - a.beats[i]!;
  if (dt > period * 1.5) return 0;
  return Math.exp(-dt / (period * 0.25));
}

/** Any feature by id — the one dispatch every surface reads through. */
export function soundFeatureAt(a: SoundAnalysis, ms: number, feature: SoundFeature): number {
  switch (feature) {
    case "level":
      return soundLevelAt(a, ms);
    case "brightness":
      return soundBrightnessAt(a, ms);
    case "onset":
      return soundOnsetAt(a, ms);
    case "beat":
      return soundBeatAt(a, ms);
    default: {
      const range = soundFeatureDef(feature)?.range;
      return range ? soundRangeAt(a, ms, range[0], range[1]) : 0;
    }
  }
}

// ── Through a clip's playback ────────────────────────────────────────────────

/** How a clip plays its recording: where it starts in it and how it moves through it. */
export interface SoundTiming {
  trimInMs: number;
  /** The clip's length on the timeline — nothing sounds past it. */
  durationMs: number;
  playback: ClipPlayback;
}

/**
 * Peaks over a WINDOW of a clip's own wall time, read from a peak table.
 *
 * Each bin's wall time is mapped through `sourceTimeAt`, so speed (the window
 * widens and narrows), trim, loop, ping-pong and reverse all show, and a bin
 * before the clip, after it or past a play-once end reads silence. The ONE
 * implementation behind a clip's timeline strip and the scrolling-wave
 * visualizer — they read the same table through the same map.
 */
export function windowPeaks(
  table: Float32Array,
  rate: number,
  sourceLengthMs: number,
  timing: Pick<SoundTiming, "trimInMs" | "playback">,
  fromLocalMs: number,
  toLocalMs: number,
  bins: number,
  activeSpanMs = Number.POSITIVE_INFINITY,
): Float32Array {
  const peaks = new Float32Array(Math.max(0, bins));
  const binWallMs = (toLocalMs - fromLocalMs) / bins;
  if (!(binWallMs > 0) || table.length === 0) return peaks;
  const trim = Math.max(0, timing.trimInMs);
  const sourceDurationMs = Math.max(1, sourceLengthMs - trim);
  const speed = timing.playback.speed > 0 ? timing.playback.speed : 1;
  for (let b = 0; b < bins; b++) {
    const wallMid = fromLocalMs + (b + 0.5) * binWallMs;
    if (wallMid < 0 || wallMid >= activeSpanMs) continue;
    if (timing.playback.loop === "none" && wallMid * speed >= sourceDurationMs) continue;
    const centerMs = trim + sourceTimeAt(wallMid, sourceDurationMs, timing.playback);
    const halfMs = (binWallMs * speed) / 2; // one bin's worth of SOURCE time
    const b0 = Math.max(0, Math.floor(((centerMs - halfMs) / 1000) * rate));
    const b1 = Math.min(table.length, Math.ceil(((centerMs + halfMs) / 1000) * rate));
    let max = 0;
    for (let k = b0; k < b1; k++) if (table[k]! > max) max = table[k]!;
    // A bin narrower than a bucket still reads the bucket it sits in.
    peaks[b] = b1 > b0 ? max : (table[Math.min(table.length - 1, Math.max(0, b0))] ?? 0);
  }
  return peaks;
}
