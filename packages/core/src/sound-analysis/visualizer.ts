import { sourceTimeAt } from "../animation/evaluate";
import type { WaveformStyle } from "../schema";
import { soundBandsAt, windowPeaks, type SoundTiming } from "./query";
import type { SoundAnalysis } from "./types";

/**
 * THE VISUALIZER'S DATA — what a waveform layer draws at an instant, read from
 * the sound's analysis like any expression or node reads it.
 *
 * The waveform plugin's templates used to run their own FFT per bar per frame
 * from the decoded buffer, inside the renderer, which made the visualizer the
 * one thing in the app that could react to a sound and the one thing nothing
 * else could share. It now reads the same `SoundAnalysis` as `sound()` and the
 * Sound node, through the clip's own playback, so a template is just another
 * reader: preview, export, nodes and agents see one set of numbers.
 */

/** How far back the spectrum's release looks, and in what steps (fps-independent). */
const RELEASE_STEP_MS = 26;
const RELEASE_STEPS = 6;

/** Bars for a style — the continuous templates read finer for a fluid curve. */
export function styleBinCount(style: WaveformStyle): number {
  return style.template === "line" || style.template === "area" ? Math.max(style.barCount, 96) : style.barCount;
}

/**
 * The bars a waveform layer shows at `centerLocalMs` of its target clip's wall
 * time. `spectrum` is a fixed EQ (bass left, treble right) with a
 * DETERMINISTIC release — the max of the last few instants, decay-weighted, so
 * bars fall smoothly after a hit and the value depends only on time.
 * `waveform` is the amplitude scrolling through a window centred on now.
 */
export function visualizerBars(a: SoundAnalysis, style: WaveformStyle, timing: SoundTiming, centerLocalMs: number): Float32Array {
  const bins = styleBinCount(style);
  if (style.mode === "waveform") {
    return windowPeaks(
      a.peaks,
      a.peakRate,
      a.durationMs,
      timing,
      centerLocalMs - style.windowMs / 2,
      centerLocalMs + style.windowMs / 2,
      bins,
      timing.durationMs,
    );
  }
  const trim = Math.max(0, timing.trimInMs);
  const sourceDurationMs = Math.max(1, a.durationMs - trim);
  const speed = timing.playback.speed > 0 ? timing.playback.speed : 1;
  const out = new Float32Array(bins);
  const steps = style.decay <= 0.001 ? 1 : RELEASE_STEPS;
  for (let k = 0; k < steps; k++) {
    const wall = centerLocalMs - k * RELEASE_STEP_MS;
    if (wall < 0 || wall >= timing.durationMs) continue;
    if (timing.playback.loop === "none" && wall * speed >= sourceDurationMs) continue;
    const bands = soundBandsAt(a, trim + sourceTimeAt(wall, sourceDurationMs, timing.playback), bins);
    const weight = Math.pow(style.decay, k);
    for (let i = 0; i < bins; i++) {
      const v = bands[i]! * weight;
      if (v > out[i]!) out[i] = v;
    }
  }
  return out;
}
