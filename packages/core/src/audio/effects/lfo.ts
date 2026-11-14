import type { LfoShape } from "../../schema/audio-effects";

/**
 * THE LFO — one definition of each shape, shared by the sound and its picture.
 *
 * The shapes are WebAudio's own (`OscillatorNode` sine, triangle, square,
 * sawtooth, as the spec defines their Fourier series), so the scope a card
 * draws is the wave the oscillator plays, not an approximation of it.
 *
 * PHASE IS CLIP TIME. An oscillator starts at phase 0 whenever it is built —
 * at the clip's start in an export, wherever you pressed play in a preview —
 * so a wobble auditioned from the middle of a clip would sit at a different
 * point of its cycle than the same instant in the file. `lfoWave` hands the
 * oscillator a periodic wave ROTATED to the phase the clip is at, so building
 * the chain mid-clip starts the LFO where it would have been. Preview and
 * export land on the same cycle.
 */

/** -1..1 at `cycles` (any real; the fractional part is the phase). */
export function lfoValue(shape: LfoShape, cycles: number): number {
  const p = cycles - Math.floor(cycles);
  switch (shape) {
    case "sine":
      return Math.sin(2 * Math.PI * p);
    case "square":
      return p < 0.5 ? 1 : -1;
    case "triangle":
      // 0 → 1 at a quarter, → −1 at three quarters, → 0.
      return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
    case "sawtooth":
      // Rising from 0, wrapping from 1 to −1 at the half.
      return p < 0.5 ? 2 * p : 2 * p - 2;
  }
}

/** Harmonics a non-sine LFO is built from — past this the edges are sharp enough to hear as a click. */
const HARMONICS = 48;

/** The spec's sine-series coefficient bₙ for each shape (cosine terms are 0). */
function sineCoefficient(shape: LfoShape, n: number): number {
  switch (shape) {
    case "sine":
      return n === 1 ? 1 : 0;
    case "square":
      return n % 2 === 1 ? 4 / (Math.PI * n) : 0;
    case "triangle":
      return n % 2 === 1 ? (8 * Math.sin((n * Math.PI) / 2)) / (Math.PI * Math.PI * n * n) : 0;
    case "sawtooth":
      return (2 * (n % 2 === 1 ? 1 : -1)) / (Math.PI * n);
  }
}

/**
 * The coefficients for `createPeriodicWave(real, imag, { disableNormalization:
 * true })` that play `shape` starting `phaseCycles` into its cycle.
 *
 * f(θ + φ) = Σ bₙ sin(n(θ + φ)) = Σ bₙ sin nφ · cos nθ + bₙ cos nφ · sin nθ.
 */
export function lfoWave(shape: LfoShape, phaseCycles: number): { real: Float32Array; imag: Float32Array } {
  const count = shape === "sine" ? 2 : HARMONICS + 1;
  const real = new Float32Array(count);
  const imag = new Float32Array(count);
  const phi = 2 * Math.PI * (phaseCycles - Math.floor(phaseCycles));
  for (let n = 1; n < count; n++) {
    const b = sineCoefficient(shape, n);
    real[n] = b * Math.sin(n * phi);
    imag[n] = b * Math.cos(n * phi);
  }
  return { real, imag };
}

/** Where an LFO at `rateHz` is in its cycle at `localMs` of the clip. */
export function lfoPhaseAt(rateHz: number, localMs: number): number {
  return (Math.max(0, rateHz) * Math.max(0, localMs)) / 1000;
}
