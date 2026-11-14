/**
 * LOUDNESS — how loud a sound IS to a person, measured the way broadcast does
 * it (ITU-R BS.1770 / EBU R128), headless and zero-dependency.
 *
 * Peak level says nothing about loudness: a snare and a pad can peak at the
 * same dBFS and sound ten decibels apart. So a sound is first K-WEIGHTED (a
 * high shelf for the ear's presence boost, a high-pass for its deafness to
 * rumble), then its energy is taken in 100ms blocks. Every question the mixer
 * asks — "how loud is this take", "how loud does this whoosh get", "is anything
 * playing here" — is then a sum over blocks, which is why one table per asset,
 * measured once, answers all of them for any trim of that asset in any clip.
 *
 * Pure: the app decodes and hands channel data in; the exporter, the tests and
 * a worker could all run it.
 */

/** Block size of every loudness table. 400ms momentary = 4 blocks, 75% overlap = 1-block hop. */
export const LOUDNESS_BLOCK_MS = 100;

/** Below this a block is silence for every gate and every "is it playing" test. */
export const SILENCE_LUFS = -70;

export interface LoudnessTable {
  /** Always {@link LOUDNESS_BLOCK_MS}; stored so a table explains itself. */
  blockMs: number;
  /** K-weighted mean square per block, summed over channels (BS.1770's zᵢ·Gᵢ). */
  energy: Float32Array;
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * The two K-weighting stages for any sample rate — the analogue prototype the
 * standard specifies at 48kHz, re-derived through the bilinear transform
 * (libebur128's formulation), so a 44.1kHz file measures the same as a 48kHz one.
 */
function kWeighting(sampleRate: number): [Biquad, Biquad] {
  // Stage 1 — the head's high shelf (+4 dB above ~1.5kHz).
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K1 = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K1 / Q + K1 * K1;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K1) / Q + K1 * K1) / a0,
    b1: (2 * (K1 * K1 - Vh)) / a0,
    b2: (Vh - (Vb * K1) / Q + K1 * K1) / a0,
    a1: (2 * (K1 * K1 - 1)) / a0,
    a2: (1 - K1 / Q + K1 * K1) / a0,
  };
  // Stage 2 — the RLB high-pass (the ear barely hears below ~40Hz).
  const f1 = 38.13547087602444;
  const Q1 = 0.5003270373238773;
  const K2 = Math.tan((Math.PI * f1) / sampleRate);
  const d = 1 + K2 / Q1 + K2 * K2;
  const highpass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K2 * K2 - 1)) / d, a2: (1 - K2 / Q1 + K2 * K2) / d };
  return [shelf, highpass];
}

/**
 * Measure a decoded sound into its block table. O(samples), one pass, no
 * allocation per sample — a three-minute stereo song is ~17M samples and
 * measures in tens of milliseconds.
 */
export function measureLoudnessTable(channels: readonly Float32Array[], sampleRate: number): LoudnessTable {
  const length = channels.reduce((m, c) => Math.max(m, c.length), 0);
  const perBlock = Math.max(1, Math.round((sampleRate * LOUDNESS_BLOCK_MS) / 1000));
  const blocks = Math.ceil(length / perBlock);
  const energy = new Float32Array(blocks);
  const [s, h] = kWeighting(sampleRate);
  for (const data of channels) {
    // Direct form I, both stages, state carried across blocks.
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0; // stage 1
    let u1 = 0, u2 = 0, v1 = 0, v2 = 0; // stage 2
    for (let b = 0; b < blocks; b++) {
      const from = b * perBlock;
      const to = Math.min(data.length, from + perBlock);
      let sum = 0;
      for (let i = from; i < to; i++) {
        const x = data[i]!;
        const y = s.b0 * x + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        const v = h.b0 * y + h.b1 * u1 + h.b2 * u2 - h.a1 * v1 - h.a2 * v2;
        u2 = u1; u1 = y; v2 = v1; v1 = v;
        sum += v * v;
      }
      // Mean over the FULL block length, so a short tail block reads as the
      // quieter block it is rather than as a loud one.
      energy[b] = energy[b]! + sum / perBlock;
    }
  }
  return { blockMs: LOUDNESS_BLOCK_MS, energy };
}

/** Energy → LUFS (BS.1770's −0.691 offset). */
export function energyToLufs(energy: number): number {
  return energy > 0 ? -0.691 + 10 * Math.log10(energy) : -Infinity;
}

function blockRange(t: LoudnessTable, fromMs: number, toMs: number): [number, number] {
  const n = t.energy.length;
  const a = Math.max(0, Math.min(n, Math.floor(fromMs / t.blockMs)));
  const b = Math.max(a, Math.min(n, Math.ceil(toMs / t.blockMs)));
  return [a, b];
}

/** Momentary (400ms) energy of the window ENDING at block `j` (exclusive). */
function momentaryEnergy(t: LoudnessTable, j: number): number {
  const from = Math.max(0, j - 4);
  let sum = 0;
  for (let i = from; i < j; i++) sum += t.energy[i]!;
  return sum / 4;
}

/**
 * Integrated (gated) loudness over a span of the SOURCE — what a take, a
 * music bed or a whole mix "is". Absolute gate at −70 LUFS, relative gate at
 * −10 LU, over 400ms windows with 75% overlap. A span shorter than one window
 * is measured as that one window, so a short clip still has an answer.
 */
export function integratedLoudness(t: LoudnessTable, fromMs: number, toMs: number): number {
  const [a, b] = blockRange(t, fromMs, toMs);
  if (b <= a) return -Infinity;
  const windows: number[] = [];
  for (let j = Math.min(b, a + 4); j <= b; j++) windows.push(momentaryEnergy(t, j));
  const gatedAbs = windows.filter((e) => energyToLufs(e) > SILENCE_LUFS);
  if (gatedAbs.length === 0) return -Infinity;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const relGate = energyToLufs(mean(gatedAbs)) - 10;
  const gated = gatedAbs.filter((e) => energyToLufs(e) > relGate);
  return energyToLufs(mean(gated.length ? gated : gatedAbs));
}

/**
 * The LOUDEST MOMENT over a span — what an effect "is". A whoosh or a hit is
 * judged by its peak moment, not its average: averaged over its silence a
 * door slam is quiet, and levelling it by its average is how an effect ends
 * up blasting.
 */
export function maxMomentaryLoudness(t: LoudnessTable, fromMs: number, toMs: number): number {
  const [a, b] = blockRange(t, fromMs, toMs);
  let best = 0;
  for (let j = a + 1; j <= b; j++) best = Math.max(best, momentaryEnergy(t, j));
  return energyToLufs(best);
}

/** Momentary loudness at one instant of the source (the 400ms ending there). */
export function momentaryLoudnessAt(t: LoudnessTable, ms: number): number {
  return energyToLufs(momentaryEnergy(t, Math.min(t.energy.length, Math.max(1, Math.ceil(ms / t.blockMs)))));
}

/**
 * The stretches of a source span where something is actually audible — what a
 * ducking trigger is "playing" as opposed to merely lasting. Gaps shorter than
 * `bridgeMs` are bridged, so the breath between two words does not release a
 * duck and slam it back down.
 */
export function audibleSpans(
  t: LoudnessTable,
  fromMs: number,
  toMs: number,
  thresholdLufs = -45,
  bridgeMs = 350,
): Array<{ from: number; to: number }> {
  const [a, b] = blockRange(t, fromMs, toMs);
  const out: Array<{ from: number; to: number }> = [];
  for (let i = a; i < b; i++) {
    if (energyToLufs(t.energy[i]!) <= thresholdLufs) continue;
    const from = Math.max(fromMs, i * t.blockMs);
    const to = Math.min(toMs, (i + 1) * t.blockMs);
    const last = out[out.length - 1];
    if (last && from - last.to <= bridgeMs) last.to = to;
    else out.push({ from, to });
  }
  return out;
}
