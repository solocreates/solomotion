/**
 * Minimal DSP toolbox for the default engine — a windowed FFT and framewise
 * spectral features. Hand-rolled (in-place radix-2) so the package stays
 * dependency-free; a few dozen lines beat a 200KB DSP dependency for this job.
 */

/** In-place iterative radix-2 FFT. `re`/`im` length must be a power of two. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = i + k + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr; im[b] = im[a]! - xi;
        re[a] = re[a]! + xr; im[a] = im[a]! + xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Precomputed Hann window of length n. */
export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

/** The per-frame features the classifier reads. Band energies are fractions of
 * the frame's total spectral energy, so loudness cancels out of every ratio. */
export interface FrameFeatures {
  /** Time-domain RMS (absolute — silence gating happens against the file's own floor). */
  rms: number;
  /** Zero-crossing rate, 0..1 of sample pairs. High = noisy/fricative. */
  zcr: number;
  /** Energy fraction per band (see BAND_EDGES_HZ), summing to ~1 when voiced. */
  bands: number[];
  /** Energy-weighted mean frequency inside 200–1000 Hz — a first-formant proxy. */
  f1Hz: number;
  /** Energy-weighted mean frequency inside 700–2600 Hz — a second-formant proxy. */
  f2Hz: number;
}

/** Band layout for `FrameFeatures.bands` (upper edges clamp to Nyquist). */
export const BAND_EDGES_HZ = [0, 200, 500, 1000, 2000, 4000, 8000] as const;

/**
 * Slice `samples` into hopped windows and extract features for each. Windows
 * are `winSize` samples (power of two) every `hop` samples.
 */
export function extractFeatures(
  samples: Float32Array,
  sampleRate: number,
  winSize: number,
  hop: number,
  from: number,
  to: number,
  out: FrameFeatures[],
): void {
  const window = hannCache(winSize);
  const re = new Float32Array(winSize);
  const im = new Float32Array(winSize);
  const half = winSize / 2;
  const hzPerBin = sampleRate / winSize;

  for (let start = from; start < to; start += hop) {
    let rmsAcc = 0;
    let crossings = 0;
    for (let i = 0; i < winSize; i++) {
      const s = samples[start + i] ?? 0;
      rmsAcc += s * s;
      re[i] = s * window[i]!;
      im[i] = 0;
      if (i > 0) {
        const prev = samples[start + i - 1] ?? 0;
        if ((s >= 0) !== (prev >= 0)) crossings++;
      }
    }
    fft(re, im);

    const bands = new Array<number>(BAND_EDGES_HZ.length - 1).fill(0);
    let total = 0;
    let f1Num = 0, f1Den = 0;
    let f2Num = 0, f2Den = 0;
    for (let bin = 1; bin < half; bin++) {
      const hz = bin * hzPerBin;
      const p = re[bin]! * re[bin]! + im[bin]! * im[bin]!;
      total += p;
      for (let b = 0; b < bands.length; b++) {
        if (hz >= BAND_EDGES_HZ[b]! && hz < BAND_EDGES_HZ[b + 1]!) { bands[b]! += p; break; }
      }
      if (hz >= 200 && hz < 1000) { f1Num += hz * p; f1Den += p; }
      if (hz >= 700 && hz < 2600) { f2Num += hz * p; f2Den += p; }
    }
    if (total > 0) for (let b = 0; b < bands.length; b++) bands[b]! /= total;

    out.push({
      rms: Math.sqrt(rmsAcc / winSize),
      zcr: crossings / (winSize - 1),
      bands,
      f1Hz: f1Den > 0 ? f1Num / f1Den : 0,
      f2Hz: f2Den > 0 ? f2Num / f2Den : 0,
    });
  }
}

const hannCacheMap = new Map<number, Float32Array>();
function hannCache(n: number): Float32Array {
  let w = hannCacheMap.get(n);
  if (!w) { w = hannWindow(n); hannCacheMap.set(n, w); }
  return w;
}
