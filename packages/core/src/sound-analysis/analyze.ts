import { fft } from "@solomotion/lipsync/spectral";
import {
  SOUND_ANALYSIS_VERSION,
  SOUND_BAND_FLOOR_DB,
  SOUND_BANDS,
  SOUND_FRAME_RATE,
  SOUND_LEVEL_FLOOR_DB,
  SOUND_MAX_HZ,
  SOUND_MIN_HZ,
  SOUND_PEAK_RATE,
  type SoundAnalysis,
} from "./types";

/**
 * LISTENING — samples in, a `SoundAnalysis` out. Pure: Float32Arrays in,
 * plain data out, no DOM and no audio API, so the editor, an export and a
 * test all get the same numbers.
 *
 * It is a STEPPER, not one call, because a song is eighteen thousand spectra:
 * the host runs it a slice at a time between frames (`step`) so the editor
 * never freezes, and a test or a server calls `analyzeSound` to run it whole.
 *
 * The bands are the visualizer's own (a 4096-point Hann window ENDING at the
 * instant — what was just heard, like a hardware analyser — peak magnitude per
 * log band, dB-mapped over 66 dB), so every waveform template draws exactly
 * what it drew when it ran its own FFT per frame, from data anything else can
 * now read too.
 */

const FFT_SIZE = 4096;
const HALF = FFT_SIZE / 2;
/** The loudness window: long enough to read as "how loud", short enough to follow a hit. */
const LEVEL_WINDOW_MS = 50;

let hannCache: { win: Float32Array; sum: number } | null = null;
function hann(): { win: Float32Array; sum: number } {
  if (!hannCache) {
    const win = new Float32Array(FFT_SIZE);
    let sum = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
      sum += win[i]!;
    }
    hannCache = { win, sum };
  }
  return hannCache;
}

/** One channel: the mean of all of them (what a listener hears as one sound). */
function mixdown(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i] = out[i]! + c[i]!;
  const k = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] = out[i]! * k;
  return out;
}

/**
 * THE WAVEFORM TABLE — max |sample| over every channel, per bucket at `rate`.
 * One implementation for the analysis and the timeline strip, so a clip's
 * strip and a visualizer reading the analysis draw the same wave.
 */
export function peakTable(channels: readonly Float32Array[], sampleRate: number, rate = SOUND_PEAK_RATE): Float32Array {
  const length = Math.min(...channels.map((c) => c.length));
  const buckets = Math.max(1, Math.ceil((length / sampleRate) * rate));
  const per = length / buckets;
  const table = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    const s0 = Math.floor(b * per);
    const s1 = Math.min(length, Math.floor((b + 1) * per));
    let max = 0;
    for (const data of channels) {
      for (let i = s0; i < s1; i++) {
        const v = data[i]! < 0 ? -data[i]! : data[i]!;
        if (v > max) max = v;
      }
    }
    table[b] = max;
  }
  return table;
}

const toByte = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
const dbOf = (amp: number): number => 20 * Math.log10(amp + 1e-9);

export interface SoundAnalyzer {
  /** 0..1 of the spectra computed so far. */
  readonly progress: number;
  /** Compute up to `frames` more feature frames. True once every frame is done. */
  step(frames: number): boolean;
  /** The finished analysis — runs whatever steps remain first. */
  finish(): SoundAnalysis;
}

export function createSoundAnalyzer(channels: readonly Float32Array[], sampleRate: number): SoundAnalyzer {
  const mono = mixdown(channels);
  const durationMs = (mono.length / sampleRate) * 1000;
  const frameRate = SOUND_FRAME_RATE;
  const frames = Math.max(1, Math.ceil((durationMs / 1000) * frameRate) + 1);
  const bandCount = SOUND_BANDS;
  const maxHz = Math.min(SOUND_MAX_HZ, sampleRate / 2);
  const minHz = SOUND_MIN_HZ;
  const binHz = sampleRate / FFT_SIZE;

  // Each band's FFT bins, once.
  const logSpan = Math.log(maxHz / minHz);
  const lo = new Int32Array(bandCount);
  const hi = new Int32Array(bandCount);
  for (let b = 0; b < bandCount; b++) {
    const f0 = minHz * Math.exp((logSpan * b) / bandCount);
    const f1 = minHz * Math.exp((logSpan * (b + 1)) / bandCount);
    lo[b] = Math.max(1, Math.floor(f0 / binHz));
    hi[b] = Math.min(HALF, Math.max(lo[b]! + 1, Math.ceil(f1 / binHz)));
  }
  const topBin = Math.min(HALF, Math.ceil(maxHz / binHz));

  const level = new Uint8Array(frames);
  const bands = new Uint8Array(frames * bandCount);
  const centroid = new Uint8Array(frames);
  const fluxRaw = new Float32Array(frames);
  const levelWindow = Math.max(1, Math.round((LEVEL_WINDOW_MS / 1000) * sampleRate));
  const { win, sum: winSum } = hann();
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const magA = new Float32Array(HALF + 1);
  const magB = new Float32Array(HALF + 1);
  let prevLog: Float32Array | null = null;
  let next = 0;

  const endSample = (f: number) => Math.min(mono.length, Math.round((f / frameRate) * sampleRate));

  /** Frame `f`'s windowed samples into `buf` (zero outside the file). */
  const fill = (buf: Float32Array, f: number) => {
    const start = endSample(f) - FFT_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = start + i;
      buf[i] = (s >= 0 && s < mono.length ? mono[s]! : 0) * win[i]!;
    }
  };

  /** Everything per-frame except the spectrum. */
  const loudness = (f: number) => {
    const end = endSample(f);
    const start = Math.max(0, end - levelWindow);
    let acc = 0;
    for (let i = start; i < end; i++) acc += mono[i]! * mono[i]!;
    const rms = end > start ? Math.sqrt(acc / (end - start)) : 0;
    level[f] = toByte((dbOf(rms) - SOUND_LEVEL_FLOOR_DB) / -SOUND_LEVEL_FLOOR_DB);
  };

  /** Bands, brightness and flux from one frame's magnitudes. */
  const spectrum = (f: number, mag: Float32Array) => {
    const row = f * bandCount;
    for (let b = 0; b < bandCount; b++) {
      let m = 0;
      for (let i = lo[b]!; i < hi[b]!; i++) if (mag[i]! > m) m = mag[i]!;
      const amp = (2 * m) / winSum; // ≈ a sine's amplitude
      bands[row + b] = toByte((dbOf(amp) - SOUND_BAND_FLOOR_DB) / -SOUND_BAND_FLOOR_DB);
    }
    // Brightness: the centre of mass, placed on the same log axis as the bands.
    let wsum = 0;
    let msum = 0;
    for (let i = 1; i < topBin; i++) {
      wsum += i * mag[i]!;
      msum += mag[i]!;
    }
    const audible = (2 * msum) / winSum > 1e-3;
    const hz = msum > 0 ? (wsum / msum) * binHz : 0;
    centroid[f] = audible && hz > minHz ? toByte(Math.log(hz / minHz) / logSpan) : 0;
    // Flux: how much louder each bin got, on a compressed scale — new sound
    // arriving, not sound getting quieter.
    const log = new Float32Array(topBin);
    let flux = 0;
    for (let i = 1; i < topBin; i++) {
      log[i] = Math.log1p((200 * mag[i]!) / winSum);
      if (prevLog) {
        const d = log[i]! - prevLog[i]!;
        if (d > 0) flux += d;
      }
    }
    prevLog = log;
    fluxRaw[f] = flux;
  };

  const step = (count: number): boolean => {
    const until = Math.min(frames, next + Math.max(1, count));
    while (next < until) {
      // TWO REAL FRAMES PER COMPLEX FFT: frame f in the real part, f+1 in the
      // imaginary, separated by conjugate symmetry afterwards — half the FFTs.
      const f = next;
      const pair = f + 1 < frames;
      fill(re, f);
      if (pair) fill(im, f + 1);
      else im.fill(0);
      fft(re, im);
      for (let k = 0; k <= HALF; k++) {
        const nk = (FFT_SIZE - k) % FFT_SIZE;
        const xr = re[k]!;
        const xi = im[k]!;
        const yr = re[nk]!;
        const yi = im[nk]!;
        // A = (X_k + conj X_{N-k}) / 2,  B = (X_k − conj X_{N-k}) / 2i
        magA[k] = 0.5 * Math.hypot(xr + yr, xi - yi);
        magB[k] = 0.5 * Math.hypot(xi + yi, yr - xr);
      }
      loudness(f);
      spectrum(f, magA);
      next++;
      if (pair) {
        loudness(f + 1);
        spectrum(f + 1, magB);
        next++;
      }
    }
    return next >= frames;
  };

  let done: SoundAnalysis | null = null;
  return {
    get progress() {
      return next / frames;
    },
    step,
    finish() {
      if (done) return done;
      while (!step(4096));
      done = finishAnalysis({ mono, channels, sampleRate, durationMs, frames, frameRate, bandCount, minHz, maxHz, level, bands, centroid, fluxRaw });
      return done;
    },
  };
}

/** Run the whole analysis now — tests, servers, anything that can wait. */
export function analyzeSound(channels: readonly Float32Array[], sampleRate: number): SoundAnalysis {
  return createSoundAnalyzer(channels, sampleRate).finish();
}

// ── After the spectra: hits, tempo, beats, totals ────────────────────────────

interface Pass1 {
  mono: Float32Array;
  channels: readonly Float32Array[];
  sampleRate: number;
  durationMs: number;
  frames: number;
  frameRate: number;
  bandCount: number;
  minHz: number;
  maxHz: number;
  level: Uint8Array;
  bands: Uint8Array;
  centroid: Uint8Array;
  fluxRaw: Float32Array;
}

function finishAnalysis(p: Pass1): SoundAnalysis {
  // Flux is relative to the sound: its 99th percentile is "a big hit". A
  // fixed scale would make a quiet piano read as no hits and a drum loop as
  // one long hit.
  const sorted = Float32Array.from(p.fluxRaw).sort();
  const ref = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]! || 1;
  const env = new Float32Array(p.frames);
  for (let f = 0; f < p.frames; f++) env[f] = Math.min(1, p.fluxRaw[f]! / ref);
  const flux = new Uint8Array(p.frames);
  for (let f = 0; f < p.frames; f++) flux[f] = toByte(env[f]!);

  const onsets = pickOnsets(env, p.frameRate);
  const tempo = estimateTempo(env, p.frameRate);
  const beats = tempo ? trackBeats(env, p.frameRate, tempo) : new Float32Array(0);

  let peak = 0;
  let acc = 0;
  for (let i = 0; i < p.mono.length; i++) {
    const v = p.mono[i]!;
    acc += v * v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  for (const c of p.channels) for (let i = 0; i < c.length; i++) if (Math.abs(c[i]!) > peak) peak = Math.abs(c[i]!);
  const rms = p.mono.length ? Math.sqrt(acc / p.mono.length) : 0;

  return {
    version: SOUND_ANALYSIS_VERSION,
    durationMs: p.durationMs,
    sampleRate: p.sampleRate,
    frameRate: p.frameRate,
    frames: p.frames,
    bandCount: p.bandCount,
    minHz: p.minHz,
    maxHz: p.maxHz,
    level: p.level,
    bands: p.bands,
    flux,
    centroid: p.centroid,
    peaks: peakTable(p.channels, p.sampleRate),
    peakRate: SOUND_PEAK_RATE,
    onsets,
    beats,
    tempo: tempo ? Math.round(tempo * 10) / 10 : null,
    peakDb: Math.round(dbOf(peak) * 10) / 10,
    rmsDb: Math.round(dbOf(rms) * 10) / 10,
  };
}

/**
 * Hits: a local peak of the onset envelope that stands above its own
 * neighbourhood. The neighbourhood mean is what keeps a sustained loud
 * passage from reading as a hit every frame.
 */
function pickOnsets(env: Float32Array, frameRate: number): Float32Array {
  const out: number[] = [];
  const peakSpan = 3; // ±30 ms
  const meanSpan = 10; // ±100 ms
  const gap = Math.round(0.05 * frameRate);
  let last = -Infinity;
  for (let f = 0; f < env.length; f++) {
    const v = env[f]!;
    if (v < 0.1) continue;
    let isPeak = true;
    for (let k = Math.max(0, f - peakSpan); k <= Math.min(env.length - 1, f + peakSpan); k++) {
      if (env[k]! > v || (env[k] === v && k < f)) {
        isPeak = false;
        break;
      }
    }
    if (!isPeak) continue;
    let mean = 0;
    let n = 0;
    for (let k = Math.max(0, f - meanSpan); k <= Math.min(env.length - 1, f + meanSpan); k++) {
      mean += env[k]!;
      n++;
    }
    if (v < mean / n + 0.07 || f - last < gap) continue;
    out.push((f / frameRate) * 1000);
    last = f;
  }
  return Float32Array.from(out);
}

const MIN_BPM = 60;
const MAX_BPM = 200;

/**
 * Tempo from the onset envelope's autocorrelation, weighted toward 120 BPM by
 * a one-octave log-Gaussian — the standard prior that settles the octave
 * question (is it 60, 120 or 240?) the way a listener tapping along would.
 * Null when nothing repeats strongly enough to count.
 */
function estimateTempo(env: Float32Array, frameRate: number): number | null {
  const n = env.length;
  const minLag = Math.floor((60 * frameRate) / MAX_BPM);
  const maxLag = Math.ceil((60 * frameRate) / MIN_BPM);
  if (n < maxLag * 3) return null;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i]!;
  mean /= n;
  const x = new Float32Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    x[i] = env[i]! - mean;
    energy += x[i]! * x[i]!;
  }
  if (energy <= 1e-9) return null;
  const r = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += x[i]! * x[i + lag]!;
    r[lag] = acc / energy;
  }
  let best = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * frameRate) / lag;
    const prior = Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    const score = r[lag]! * prior;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  if (best < 0 || r[best]! < 0.1) return null;
  // Parabolic refinement between the neighbouring lags.
  const a = r[best - 1]!;
  const b = r[best]!;
  const c = r[best + 1]!;
  const d = a - 2 * b + c;
  const lag = d < 0 ? best + (0.5 * (a - c)) / d : best;
  return (60 * frameRate) / lag;
}

/**
 * The beat: dynamic-programming tracking (Ellis 2007). Each frame's score is
 * its onset strength plus the best predecessor roughly one period back,
 * penalised by how far that gap strays from the period on a log scale — so the
 * beat follows the hits where there are hits and keeps time through the gaps
 * where there are none.
 */
function trackBeats(env: Float32Array, frameRate: number, bpm: number): Float32Array {
  const n = env.length;
  const period = (60 * frameRate) / bpm;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i]!;
  mean /= n;
  let sd = 0;
  for (let i = 0; i < n; i++) sd += (env[i]! - mean) ** 2;
  sd = Math.sqrt(sd / n) || 1;
  const local = new Float32Array(n);
  for (let i = 0; i < n; i++) local[i] = env[i]! / sd;

  const tightness = 100;
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const from = Math.round(period / 2);
  const to = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = 0;
    let arg = -1;
    for (let gap = from; gap <= to; gap++) {
      const tau = t - gap;
      if (tau < 0) break;
      const s = score[tau]! - tightness * Math.log(gap / period) ** 2;
      if (arg < 0 || s > best) {
        best = s;
        arg = tau;
      }
    }
    score[t] = local[t]! + (arg >= 0 ? Math.max(0, best) : 0);
    back[t] = arg >= 0 && best > 0 ? arg : -1;
  }
  // End on the strongest beat within the last period, then walk back.
  let end = n - 1;
  for (let t = Math.max(0, n - Math.ceil(period)); t < n; t++) if (score[t]! > score[end]!) end = t;
  const out: number[] = [];
  for (let t = end; t >= 0; t = back[t]!) {
    out.push((t / frameRate) * 1000);
    if (back[t]! < 0) break;
  }
  return Float32Array.from(out.reverse());
}
