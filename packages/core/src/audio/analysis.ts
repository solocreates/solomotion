/**
 * Audio ANALYSIS — the derived facts about a sound file, computed once.
 *
 * A published sound carries three numbers nobody should ever type: how long it
 * is, where it strikes, and what it looks like. All three are functions of the
 * samples, so all three are computed — never declared. This file is that
 * computation, and it is deliberately pure (`Float32Array` in, plain data out)
 * so the ONE implementation runs in three places that must not disagree:
 *
 *   • the publish script, deriving a pack manifest from files on disk;
 *   • the editor, deriving the same fields when you publish from the app;
 *   • the picker, drawing a waveform for a sound it has just decoded.
 *
 * The alternative — a Node analyser and a browser analyser — is two answers to
 * "where does this sound hit", and the seam between them is a sound that lands
 * on a different beat depending on who published it.
 */

/** How many bins a published waveform carries. Wide enough to read at card
 *  size, small enough that 200 of them are a ~150 KB manifest. */
export const PEAK_BINS = 128;

/**
 * Peak amplitude per bin — the shape a waveform is drawn from.
 *
 * Max-per-bin, not RMS: a transient that survives averaging is exactly the
 * thing a hit sound IS, and an RMS waveform draws every click as a flat line.
 * Big bins are sampled sparsely (visually identical, an order cheaper).
 */
export function peaksFromSamples(
  samples: Float32Array,
  bins: number = PEAK_BINS,
  from = 0,
  to = samples.length,
): Float32Array {
  const start = Math.max(0, Math.floor(from));
  const end = Math.min(samples.length, Math.ceil(to));
  const out = new Float32Array(bins);
  const span = Math.max(1, end - start);
  const step = span / bins;
  for (let b = 0; b < bins; b++) {
    const s0 = start + Math.floor(b * step);
    const s1 = Math.min(end, start + Math.floor((b + 1) * step));
    let max = 0;
    const stride = Math.max(1, Math.floor((s1 - s0) / 64));
    for (let i = s0; i < s1; i += stride) {
      const v = Math.abs(samples[i]!);
      if (v > max) max = v;
    }
    out[b] = max;
  }
  return out;
}

/**
 * Peaks as they travel on the wire: normalised to the loudest bin and rounded
 * to two decimals. Normalising is what lets a quiet sound and a loud one draw
 * at the same visual weight in a card — the manifest carries SHAPE, and gain is
 * the mixer's business. Two decimals is ~4 bytes a bin and indistinguishable at
 * any size a card is drawn.
 */
export function quantisePeaks(peaks: Float32Array | number[]): number[] {
  let max = 0;
  for (const p of peaks) if (p > max) max = p;
  const k = max > 0 ? 1 / max : 0;
  const out: number[] = [];
  for (const p of peaks) out.push(Math.round(p * k * 100) / 100);
  return out;
}

/**
 * Where the sound STRIKES, in ms.
 *
 * A hit sound rarely begins at sample zero — there is a breath of room tone, a
 * fade, an encoder's padding — and a library that ignores that lands every
 * sound late by exactly that much. So: find the peak, then walk FORWARD from
 * the start to the first sample that crosses a fraction of it. Forward, not
 * backward from the peak, because a sound with a soft attack (a riser, a
 * swell) reads as starting when it becomes audible, not when it is loudest.
 *
 * Returns 0 for silence — a sound that never crosses the threshold has no
 * transient to align, and 0 is the honest answer.
 */
export function detectOnsetMs(
  samples: Float32Array,
  sampleRate: number,
  threshold = 0.12,
): number {
  if (!samples.length || sampleRate <= 0) return 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]!);
    if (v > peak) peak = v;
  }
  if (peak <= 0) return 0;
  const gate = peak * threshold;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]!) >= gate) return (i / sampleRate) * 1000;
  }
  return 0;
}

/**
 * Where the sound STOPS being audible, in ms — the tail trimmed off the end.
 *
 * A 3-second WAV whose last 2.4 seconds are digital silence is a 600 ms sound
 * wearing a long coat, and the card that draws it full-width draws mostly
 * nothing. This is what the picker's sweep already runs over; publishing it
 * means an online card reads correctly before a single byte is downloaded.
 */
export function audibleEndMs(
  samples: Float32Array,
  sampleRate: number,
  threshold = 0.02,
): number {
  if (!samples.length || sampleRate <= 0) return 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]!);
    if (v > peak) peak = v;
  }
  const gate = Math.max(peak * threshold, 1e-4);
  for (let i = samples.length - 1; i >= 0; i--) {
    if (Math.abs(samples[i]!) >= gate) return ((i + 1) / sampleRate) * 1000;
  }
  return 0;
}

/**
 * HOW LOUD IT SEEMS, in dB — not how loud its loudest sample is.
 *
 * Peak is nearly useless for protecting ears while browsing a library: a
 * brickwalled impact and a 3 ms click both peak at 1.0, and one of them is
 * fifteen decibels louder to a human. What hurts is sustained energy, so what
 * gets measured is sustained energy.
 *
 * This is mean-square over the AUDIBLE span, gated to drop near-silence — a
 * rough, honest stand-in for LUFS. A true BS.1770 meter wants K-weighting and
 * a gated 400 ms sliding window, which is a real filter bank for a number
 * whose only job is to decide how far to turn one sound down. The gate is the
 * part that actually matters, and it is here: without it, a one-second impact
 * with two seconds of tail measures as quiet, which is exactly backwards.
 *
 * Returns -Infinity for silence — the honest answer, and one every caller
 * already has to handle for `gainToDb(0)`.
 */
export const LOUDNESS_INTEGRATION_MS = 200;

export function measureLoudnessDb(samples: Float32Array, sampleRate: number): number {
  if (!samples.length || sampleRate <= 0) return -Infinity;

  // Energy over the AUDIBLE span only. A 200 ms hit padded out to three
  // seconds is a 200 ms hit, and averaging in the silence would make the
  // loudest sounds in a pack measure as the quietest.
  const end = Math.min(samples.length, Math.ceil((audibleEndMs(samples, sampleRate) / 1000) * sampleRate)) || samples.length;
  let sum = 0;
  for (let i = 0; i < end; i++) sum += samples[i]! * samples[i]!;
  if (!(sum > 0)) return -Infinity;

  // Spread over at least the ear's own integration time. This is the whole
  // difference between a number that protects ears and one that does not: a
  // 3 ms tick and a one-second tone both peak at 1.0 and both have the same
  // mean square over their own length, yet one of them is painful. The ear
  // sums energy over roughly 200 ms, so anything shorter than that is judged
  // by how much energy it delivers INTO that window, not by its own average.
  const window = Math.max(end, Math.round((LOUDNESS_INTEGRATION_MS / 1000) * sampleRate));
  return 10 * Math.log10(sum / window);
}

/** Everything a manifest needs to know about a decoded sound. */
export interface AudioAnalysis {
  durationMs: number;
  /** Audible length — `durationMs` minus a silent tail. */
  audibleMs: number;
  /** Detected transient, in ms from the file's start. */
  hitMs: number;
  /** Normalised, quantised waveform (`PEAK_BINS` long). */
  peaks: number[];
  /** Loudest sample, 0..1. */
  peak: number;
  /** Perceived loudness in dB (see `measureLoudnessDb`). Finite, or -120. */
  loudnessDb: number;
}

/**
 * Analyse one decoded mono/left channel. Peaks are taken over the AUDIBLE span
 * so a padded file and a tight one draw the same, which is the whole reason the
 * card looks authored rather than imported.
 */
export function analyzeAudio(
  samples: Float32Array,
  sampleRate: number,
  bins: number = PEAK_BINS,
): AudioAnalysis {
  const durationMs = sampleRate > 0 ? (samples.length / sampleRate) * 1000 : 0;
  const audibleMs = audibleEndMs(samples, sampleRate);
  const end = audibleMs > 0 ? Math.ceil((audibleMs / 1000) * sampleRate) : samples.length;
  return {
    durationMs: Math.round(durationMs),
    audibleMs: Math.round(audibleMs),
    hitMs: Math.round(detectOnsetMs(samples, sampleRate) * 10) / 10,
    peaks: quantisePeaks(peaksFromSamples(samples, bins, 0, end)),
    peak: Math.round(peakOf(samples) * 1000) / 1000,
    // Floored rather than left at -Infinity: this number is serialised into
    // JSON, and `-Infinity` is not a thing JSON can carry.
    loudnessDb: Math.max(-120, Math.round(measureLoudnessDb(samples, sampleRate) * 10) / 10),
  };
}

function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]!);
    if (v > peak) peak = v;
  }
  return peak;
}
