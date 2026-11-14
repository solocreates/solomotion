import type { AudioClip } from "../schema";
import { audioKeepsPitch, semitonesToRatio } from "./envelope";

/**
 * Pure, DOM-free audio DSP — the time/pitch math the offline bake runs. Zero
 * dependencies (matches the engine's open-source ethos), operating on plain
 * `Float32Array[]` channel data so it's testable in Node and reusable anywhere.
 *
 * The heavy transforms — time-stretch (keep pitch under speed) and pitch shift
 * — use WSOLA (Waveform-Similarity Overlap-Add): overlap-add resynthesis where
 * each grain is nudged to the position that best continues the previous one, so
 * a stretched/shifted voice stays smooth instead of buzzing. This is what lets a
 * sped-up voice keep its pitch and a pitch slider work at all (a single media
 * element can't do either).
 */

// WSOLA parameters (tuned for speech at 44.1–48 kHz).
const FRAME = 1024; // grain length in samples (~21 ms @ 48k)
const SYN_HOP = FRAME >> 1; // 50% overlap → Hann windows sum to ~1
const SEARCH = 200; // ± search radius for the best-continuation grain
const CORR_STRIDE = 2; // sub-sample the correlation for speed

/** Precomputed Hann window of length FRAME. */
const HANN = (() => {
  const w = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  return w;
})();

/** Read a sample with zero padding outside the buffer. */
function at(ch: Float32Array, i: number): number {
  return i >= 0 && i < ch.length ? ch[i]! : 0;
}

/**
 * Time-stretch every channel by `ratio` (output length ≈ inputLength × ratio;
 * ratio > 1 = slower/longer, < 1 = faster/shorter) while preserving pitch. The
 * grain-search correlation is computed on a mono mix and the SAME offsets are
 * applied to every channel, so stereo imaging stays coherent.
 */
export function timeStretch(channels: Float32Array[], ratio: number): Float32Array[] {
  if (channels.length === 0) return channels;
  if (Math.abs(ratio - 1) < 1e-4) return channels.map((c) => c.slice());
  const inLen = channels[0]!.length;
  const outLen = Math.max(1, Math.round(inLen * ratio));
  const anaHop = Math.max(1, Math.round(SYN_HOP / ratio));

  // Mono reference for the similarity search.
  const mono = channels.length === 1 ? channels[0]! : mixMono(channels);
  const out = channels.map(() => new Float32Array(outLen + FRAME));
  const norm = new Float32Array(outLen + FRAME); // window-sum, for OLA normalize

  let anchor = 0; // ideal analysis position (advances by anaHop)
  let natural = 0; // where the previous grain's continuation sits
  let outPos = 0;
  while (outPos < outLen) {
    // WSOLA: pick the grain near `anchor` that best continues `natural`.
    const delta = outPos === 0 ? 0 : bestOffset(mono, anchor, natural);
    const src = anchor + delta;
    for (let c = 0; c < channels.length; c++) {
      const inCh = channels[c]!;
      const outCh = out[c]!;
      for (let i = 0; i < FRAME; i++) outCh[outPos + i]! += at(inCh, src + i) * HANN[i]!;
    }
    for (let i = 0; i < FRAME; i++) norm[outPos + i]! += HANN[i]!;
    natural = src + SYN_HOP;
    anchor += anaHop;
    outPos += SYN_HOP;
  }

  // Normalize the overlap-add and trim to the exact output length.
  return out.map((ch) => {
    const res = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) res[i] = norm[i]! > 1e-6 ? ch[i]! / norm[i]! : ch[i]!;
    return res;
  });
}

/** Average all channels into one mono buffer for the similarity search. */
function mixMono(channels: Float32Array[]): Float32Array {
  const len = channels[0]!.length;
  const mono = new Float32Array(len);
  for (const ch of channels) for (let i = 0; i < len; i++) mono[i]! += ch[i]!;
  const inv = 1 / channels.length;
  for (let i = 0; i < len; i++) mono[i]! *= inv;
  return mono;
}

/** The offset in [-SEARCH, SEARCH] whose grain at `anchor+δ` best matches the
 * grain at `natural` (normalized cross-correlation). */
function bestOffset(mono: Float32Array, anchor: number, natural: number): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let delta = -SEARCH; delta <= SEARCH; delta += CORR_STRIDE) {
    const src = anchor + delta;
    let dot = 0;
    let energy = 0;
    for (let i = 0; i < FRAME; i += CORR_STRIDE) {
      const a = at(mono, src + i);
      const b = at(mono, natural + i);
      dot += a * b;
      energy += a * a;
    }
    const score = dot / Math.sqrt(energy + 1e-6);
    if (score > bestScore) {
      bestScore = score;
      best = delta;
    }
  }
  return best;
}

/** Linear-interpolated resample of one channel to `targetLen` samples. */
export function resampleChannel(input: Float32Array, targetLen: number): Float32Array {
  const out = new Float32Array(targetLen);
  if (input.length === 0 || targetLen === 0) return out;
  const step = (input.length - 1) / Math.max(1, targetLen - 1);
  for (let i = 0; i < targetLen; i++) {
    const pos = i * step;
    const j = Math.floor(pos);
    const frac = pos - j;
    out[i] = at(input, j) * (1 - frac) + at(input, j + 1) * frac;
  }
  return out;
}

/**
 * Shift pitch by `semitones` while PRESERVING duration (12 st = one octave).
 * Stretch by the pitch ratio, then resample back to the original length — the
 * signal's frequencies scale but its length doesn't.
 */
export function pitchShift(channels: Float32Array[], semitones: number): Float32Array[] {
  if (channels.length === 0 || Math.abs(semitones) < 1e-4) return channels.map((c) => c.slice());
  const ratio = semitonesToRatio(semitones);
  const targetLen = channels[0]!.length;
  const stretched = timeStretch(channels, ratio);
  return stretched.map((ch) => resampleChannel(ch, targetLen));
}

// ── Bake signature + "does this clip need offline processing?" ────────────────

/**
 * A stable signature of everything that changes an audio clip's PROCESSED
 * buffer (source + how it's retimed/pitched — NOT level or EQ, which stay
 * cheap real-time nodes downstream). The bake cache + the render-in-place
 * "already up to date?" check key on this; a change to any factor mints a new
 * key so a stale bake is never reused.
 */
export function clipAudioSignature(clip: AudioClip): string {
  const src = clip.source.type === "asset" ? `a:${clip.source.assetId}` : `p:${clip.source.pack}`;
  const pb = clip.playback;
  return [
    src,
    `t${Math.round(clip.trimInMs)}`,
    `d${Math.round(clip.durationMs)}`,
    `s${pb.speed}`,
    `l${pb.loop}`,
    `L${pb.loopLengthMs ?? ""}`,
    pb.reverse ? "rev" : "fwd",
    audioKeepsPitch(clip) ? "kp" : "tape",
    `p${clip.pitchSemitones}`,
  ].join("|");
}

/**
 * Whether the clip's output needs an OFFLINE bake in an export (an
 * OfflineAudioContext has no `preservesPitch` element flag, so keep-pitch under
 * speed must be time-stretched; reverse and independent pitch always need DSP).
 */
export function audioNeedsBake(clip: AudioClip): boolean {
  return (
    clip.playback.reverse ||
    clip.pitchSemitones !== 0 ||
    (audioKeepsPitch(clip) && clip.playback.speed !== 1)
  );
}

/**
 * Whether the clip needs a bake for LIVE preview. The media element already
 * keeps pitch under speed via `preservesPitch`, so live only bakes what an
 * element genuinely can't do: reverse and independent pitch shift.
 */
export function audioNeedsBakeLive(clip: AudioClip): boolean {
  return clip.playback.reverse || clip.pitchSemitones !== 0;
}
