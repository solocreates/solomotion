import { createId } from "../ids";
import type { AudioEqBand, EqBandType } from "../schema";

/**
 * The parametric-EQ math — pure, DOM-free, shared by every surface that has to
 * agree on "what does this EQ curve look like / do to the sound":
 *
 *  - the visual EQ editor draws the summed magnitude response (`eqMagnitudeDb`);
 *  - the live conductor, the exporter and the offline bake all build a biquad
 *    per band (they read the same band list; the node math lives web-side but
 *    the band model + presets + curve are defined here so there is ONE source
 *    of truth the inspector and the audio graph can never disagree about).
 *
 * The coefficients are the Audio-EQ-Cookbook (RBJ) biquads — the exact same
 * family `BiquadFilterNode` implements — so the drawn curve matches what you
 * hear, in preview and in the rendered file.
 */

/** A UI-facing description of a band type (label + whether gain applies). */
export interface EqBandTypeMeta {
  type: EqBandType;
  label: string;
  /** Shelf/peak types are shaped by `gainDb`; pass/notch types are not. */
  usesGain: boolean;
}

export const EQ_BAND_TYPES: readonly EqBandTypeMeta[] = [
  { type: "lowshelf", label: "Low shelf", usesGain: true },
  { type: "peaking", label: "Bell", usesGain: true },
  { type: "highshelf", label: "High shelf", usesGain: true },
  { type: "lowpass", label: "Low pass", usesGain: false },
  { type: "highpass", label: "High pass", usesGain: false },
  { type: "notch", label: "Notch", usesGain: false },
];

export function eqTypeUsesGain(type: EqBandType): boolean {
  return type === "lowshelf" || type === "highshelf" || type === "peaking";
}

function band(partial: Partial<AudioEqBand> & { type: EqBandType; freqHz: number }): AudioEqBand {
  return {
    // Deterministic-ish but unique id; presets clone fresh ids on apply.
    id: createId("eqband"),
    gainDb: 0,
    q: 0.707,
    enabled: true,
    ...partial,
  };
}

/** The default 4-band curve when EQ is first enabled — a gentle, useful start. */
export function defaultEqBands(): AudioEqBand[] {
  return [
    band({ type: "highpass", freqHz: 40, q: 0.707 }),
    band({ type: "lowshelf", freqHz: 120, gainDb: 0, q: 0.707 }),
    band({ type: "peaking", freqHz: 1000, gainDb: 0, q: 1 }),
    band({ type: "highshelf", freqHz: 8000, gainDb: 0, q: 0.707 }),
  ];
}

/** A named starting curve for the preset gallery. `bands()` returns fresh ids. */
export interface EqPreset {
  id: string;
  label: string;
  /** A tiny hint for the icon/tooltip. */
  hint: string;
  bands: () => AudioEqBand[];
}

export const EQ_PRESETS: readonly EqPreset[] = [
  { id: "flat", label: "Flat", hint: "No coloring", bands: () => defaultEqBands() },
  {
    id: "vocal",
    label: "Vocal",
    hint: "Clear, present speech",
    bands: () => [
      band({ type: "highpass", freqHz: 90, q: 0.707 }),
      band({ type: "peaking", freqHz: 300, gainDb: -2.5, q: 1.2 }),
      band({ type: "peaking", freqHz: 3000, gainDb: 3.5, q: 1 }),
      band({ type: "highshelf", freqHz: 10000, gainDb: 2, q: 0.707 }),
    ],
  },
  {
    id: "vocal-air",
    label: "Vocal Air",
    hint: "Silky top end",
    bands: () => [
      band({ type: "highpass", freqHz: 100, q: 0.707 }),
      band({ type: "highshelf", freqHz: 12000, gainDb: 5, q: 0.707 }),
      band({ type: "peaking", freqHz: 5000, gainDb: 2, q: 1.4 }),
    ],
  },
  {
    id: "podcast",
    label: "Podcast",
    hint: "Warm broadcast voice",
    bands: () => [
      band({ type: "highpass", freqHz: 80, q: 0.707 }),
      band({ type: "lowshelf", freqHz: 200, gainDb: 2, q: 0.707 }),
      band({ type: "peaking", freqHz: 450, gainDb: -3, q: 1.5 }),
      band({ type: "peaking", freqHz: 2800, gainDb: 2.5, q: 1 }),
    ],
  },
  {
    id: "telephone",
    label: "Telephone",
    hint: "Lo-fi band-limited",
    bands: () => [
      band({ type: "highpass", freqHz: 500, q: 0.9 }),
      band({ type: "lowpass", freqHz: 3000, q: 0.9 }),
      band({ type: "peaking", freqHz: 1500, gainDb: 4, q: 1.2 }),
    ],
  },
  {
    id: "de-esser",
    label: "De-ess",
    hint: "Tame harsh sibilance",
    bands: () => [band({ type: "peaking", freqHz: 6500, gainDb: -6, q: 3.5 })],
  },
  {
    id: "bass-boost",
    label: "Bass Boost",
    hint: "Fuller low end",
    bands: () => [
      band({ type: "lowshelf", freqHz: 110, gainDb: 5, q: 0.707 }),
      band({ type: "peaking", freqHz: 60, gainDb: 3, q: 0.9 }),
    ],
  },
  {
    id: "bright",
    label: "Bright",
    hint: "Airy and crisp",
    bands: () => [
      band({ type: "highshelf", freqHz: 6000, gainDb: 4, q: 0.707 }),
      band({ type: "peaking", freqHz: 2500, gainDb: 2, q: 1 }),
    ],
  },
  {
    id: "warm",
    label: "Warm",
    hint: "Soft, rounded tone",
    bands: () => [
      band({ type: "highshelf", freqHz: 7000, gainDb: -3, q: 0.707 }),
      band({ type: "lowshelf", freqHz: 250, gainDb: 2, q: 0.707 }),
    ],
  },
  {
    id: "low-cut",
    label: "Low Cut",
    hint: "Remove rumble",
    bands: () => [band({ type: "highpass", freqHz: 120, q: 0.707 })],
  },
  {
    id: "high-cut",
    label: "High Cut",
    hint: "Remove hiss",
    bands: () => [band({ type: "lowpass", freqHz: 8000, q: 0.707 })],
  },
];

// ── Biquad magnitude response (RBJ cookbook) ─────────────────────────────────

interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a0: number;
  a1: number;
  a2: number;
}

/**
 * Every biquad shape a `BiquadFilterNode` plays that a card draws: the EQ's
 * band types plus the band-pass the Filter card offers. One coefficient
 * function for all of them, so a drawn response is the node's response.
 */
export type BiquadShape = EqBandType | "bandpass";

/** One biquad as the cookbook needs it. */
export interface BiquadSpec {
  type: BiquadShape;
  freqHz: number;
  q: number;
  gainDb: number;
}

/** RBJ coefficients for one biquad at the given sample rate (unnormalized). */
function bandCoeffs(band: BiquadSpec, fs: number): BiquadCoeffs {
  const f0 = Math.min(Math.max(band.freqHz, 10), fs / 2 - 1);
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const Q = Math.max(0.05, band.q);
  const alpha = sw / (2 * Q);
  const A = Math.pow(10, band.gainDb / 40);
  const sqrtA = Math.sqrt(A);

  switch (band.type) {
    // Constant 0 dB peak — WebAudio's band-pass.
    case "bandpass":
      return { b0: alpha, b1: 0, b2: -alpha, a0: 1 + alpha, a1: -2 * cw, a2: 1 - alpha };
    case "peaking":
      return {
        b0: 1 + alpha * A,
        b1: -2 * cw,
        b2: 1 - alpha * A,
        a0: 1 + alpha / A,
        a1: -2 * cw,
        a2: 1 - alpha / A,
      };
    case "lowshelf":
      return {
        b0: A * (A + 1 - (A - 1) * cw + 2 * sqrtA * alpha),
        b1: 2 * A * (A - 1 - (A + 1) * cw),
        b2: A * (A + 1 - (A - 1) * cw - 2 * sqrtA * alpha),
        a0: A + 1 + (A - 1) * cw + 2 * sqrtA * alpha,
        a1: -2 * (A - 1 + (A + 1) * cw),
        a2: A + 1 + (A - 1) * cw - 2 * sqrtA * alpha,
      };
    case "highshelf":
      return {
        b0: A * (A + 1 + (A - 1) * cw + 2 * sqrtA * alpha),
        b1: -2 * A * (A - 1 + (A + 1) * cw),
        b2: A * (A + 1 + (A - 1) * cw - 2 * sqrtA * alpha),
        a0: A + 1 - (A - 1) * cw + 2 * sqrtA * alpha,
        a1: 2 * (A - 1 - (A + 1) * cw),
        a2: A + 1 - (A - 1) * cw - 2 * sqrtA * alpha,
      };
    case "lowpass":
      return {
        b0: (1 - cw) / 2,
        b1: 1 - cw,
        b2: (1 - cw) / 2,
        a0: 1 + alpha,
        a1: -2 * cw,
        a2: 1 - alpha,
      };
    case "highpass":
      return {
        b0: (1 + cw) / 2,
        b1: -(1 + cw),
        b2: (1 + cw) / 2,
        a0: 1 + alpha,
        a1: -2 * cw,
        a2: 1 - alpha,
      };
    case "notch":
      return {
        b0: 1,
        b1: -2 * cw,
        b2: 1,
        a0: 1 + alpha,
        a1: -2 * cw,
        a2: 1 - alpha,
      };
  }
}

/** One band's magnitude (dB) at frequency `f`, per the digital transfer fn. */
export function bandMagnitudeDb(band: AudioEqBand, f: number, fs = 48000): number {
  if (!band.enabled) return 0;
  return biquadMagnitudeDb(band, f, fs);
}

/** Any biquad's magnitude (dB) at frequency `f`. */
export function biquadMagnitudeDb(band: BiquadSpec, f: number, fs = 48000): number {
  const { b0, b1, b2, a0, a1, a2 } = bandCoeffs(band, fs);
  const w = (2 * Math.PI * Math.min(Math.max(f, 1), fs / 2 - 1)) / fs;
  const phi = Math.sin(w / 2) ** 2;
  // |H(e^jw)|^2 for a biquad in terms of phi = sin^2(w/2) (numerically stable).
  const num =
    (b0 + b1 + b2) ** 2 - 4 * (b0 * b1 + 4 * b0 * b2 + b1 * b2) * phi + 16 * b0 * b2 * phi * phi;
  const den =
    (a0 + a1 + a2) ** 2 - 4 * (a0 * a1 + 4 * a0 * a2 + a1 * a2) * phi + 16 * a0 * a2 * phi * phi;
  if (den <= 0 || num < 0) return 0;
  return 10 * Math.log10(num / den);
}

/** The summed magnitude (dB) of a whole band list at frequency `f`. */
export function eqMagnitudeDb(bands: AudioEqBand[], f: number, fs = 48000): number {
  let sum = 0;
  for (const b of bands) sum += bandMagnitudeDb(b, f, fs);
  return sum;
}

/**
 * A structural signature of the enabled bands — id + type ONLY. The live audio
 * graph rebuilds its biquad NODES when this changes (a band added/removed/
 * retyped), but keeps them and just re-points frequency/gain/Q AudioParams when
 * only values move. Cheap to compute per tick.
 */
export function eqStructureSig(bands: AudioEqBand[] | null): string {
  if (!bands) return "";
  return bands
    .filter((b) => b.enabled)
    .map((b) => `${b.id}:${b.type}`)
    .join(",");
}
