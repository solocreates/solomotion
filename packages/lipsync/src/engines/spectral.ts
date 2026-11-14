import { extractFeatures, type FrameFeatures } from "../dsp";
import { labelsToCues, modeFilter } from "../cues";
import { energyEnvelope } from "../energy";
import { numSetting, settingsKey, type AnalyzeImpl, type SpeechTrack } from "../engine";
import type { AudioInput, VisemeCue } from "../types";
import type { VisemeId } from "../visemes";
import { SPECTRAL } from "./meta";

/**
 * The default analyze engine: pure spectral heuristics, no model, no network.
 * It classifies 10ms hops by band-energy shape — the same acoustics a
 * phonetician reads off a spectrogram:
 *
 *  - silence (RMS under the file's own noise floor)        → X (rest)
 *  - strong sibilant hiss (energy piled above 4 kHz)       → S
 *  - soft high-frequency friction without sibilant weight  → FV
 *  - voiced but spectrally "shut" (all lows, no mids)      → MBP (lips closed)
 *  - vowels by formant proxies: F1 ≈ jaw openness, F2 ≈ tongue frontness:
 *      open + front → AI · open + back → O · close + front → E · close + back → U
 *
 * What DSP alone cannot hear: tongue position behind closed teeth — so this
 * engine never emits L. Framewise votes pass a mode filter + minimum-duration
 * merge, so the output is stable holds, not 100Hz flicker.
 *
 * v2 (Characters 2.0): cues are byte-identical to v1; `energy` is now the
 * shared `energyEnvelope` (perceptual, smoothed) instead of raw rms/peak per
 * hop — one loudness curve across engines, and ~4× less hop-to-hop jitter on
 * speech (measured on Test Voice, see the README).
 */

const HOP_MS = 10;
const CHUNK_FRAMES = 1500; // yield to the event loop between chunks

function classify(f: FrameFeatures, speechFloor: number): VisemeId {
  if (f.rms < speechFloor) return "X";
  const [b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0] = f.bands;
  const high = b4 + b5; // 2–8 kHz
  const sib = b5; // 4–8 kHz
  const low = b0 + b1; // 0–500 Hz
  const mid = b2 + b3; // 500–2000 Hz

  if (sib > 0.3 && f.zcr > 0.18) return "S";
  if (high > 0.45 && f.zcr > 0.12) return "FV";
  if (low > 0.62 && mid < 0.22) return "MBP";
  const open = f.f1Hz > 560; // jaw
  const front = f.f2Hz > 1450; // tongue
  if (open) return front ? "AI" : "O";
  return front ? "E" : "U";
}

export interface SpectralOptions {
  minCueMs?: number;
  smoothing?: number;
  sensitivity?: number;
  onProgress?: (fraction: number) => void;
  signal?: { readonly aborted: boolean };
}

/** The classification pass: pcm → cues (the v1 algorithm, unchanged). */
export async function spectralCues(input: AudioInput, opts: SpectralOptions = {}): Promise<VisemeCue[]> {
  const { samples, sampleRate } = input;
  const hop = Math.max(1, Math.round((sampleRate * HOP_MS) / 1000));
  const winSize = 1 << Math.round(Math.log2(sampleRate * 0.025));

  const features: FrameFeatures[] = [];
  const end = Math.max(0, samples.length - winSize);
  for (let start = 0; start <= end; start += hop * CHUNK_FRAMES) {
    if (opts.signal?.aborted) throw new Error("Cancelled");
    const to = Math.min(end + 1, start + hop * CHUNK_FRAMES);
    extractFeatures(samples, sampleRate, winSize, hop, start, to, features);
    opts.onProgress?.(Math.min(1, to / (end + 1)));
    await new Promise((r) => setTimeout(r, 0));
  }

  // The file sets its own silence gate: well above its noise floor, never
  // above a fraction of its loudest moment. `sensitivity` scales the gate.
  const sorted = features.map((f) => f.rms).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.15)] ?? 0;
  const peak = sorted[sorted.length - 1] ?? 0;
  const sens = Math.min(1, Math.max(0, opts.sensitivity ?? SPECTRAL.defaults.sensitivity));
  const gate = 1.5 - sens;
  const speechFloor = Math.min(Math.max(floor * 2.5, peak * 0.06), peak * 0.25) * gate + 1e-6;

  const labels = features.map((f) => classify(f, speechFloor));
  const smoothed = modeFilter(labels, Math.max(0, Math.round(opts.smoothing ?? SPECTRAL.defaults.smoothing)));
  return labelsToCues(smoothed, HOP_MS, opts.minCueMs ?? SPECTRAL.defaults.minCueMs);
}

export const spectralImpl: AnalyzeImpl = {
  kind: "analyze",
  async analyze(input, settings = {}, run = {}): Promise<SpeechTrack> {
    const { pcm } = input;
    const cues = await spectralCues(pcm, {
      minCueMs: numSetting(settings, "minCueMs", SPECTRAL.defaults.minCueMs),
      smoothing: numSetting(settings, "smoothing", SPECTRAL.defaults.smoothing),
      sensitivity: numSetting(settings, "sensitivity", SPECTRAL.defaults.sensitivity),
      onProgress: run.onProgress,
      signal: run.signal,
    });
    return {
      engine: SPECTRAL.id,
      version: SPECTRAL.version,
      settingsKey: settingsKey(settings, SPECTRAL.defaults),
      durationMs: (pcm.samples.length / pcm.sampleRate) * 1000,
      cues,
      energy: energyEnvelope(pcm.samples, pcm.sampleRate, { hopMs: HOP_MS }),
    };
  },
};
