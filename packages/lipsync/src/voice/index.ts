/**
 * `@solomotion/lipsync/voice` — the TEST VOICE (lazy entry): a built-in,
 * offline, deterministic formant synthesizer. Text in → audio + EXACT visemes
 * out, because the cues come from the same phoneme timeline that drives the
 * synthesis. It always works (no connection), it is the ground truth engine
 * tests measure against, and it voices templates.
 *
 * Klatt-lite source–filter:
 *   glottal impulse train → spectral-tilt lowpass → radiation (difference)
 *   + aspiration noise → cascade of five formant resonators (time-varying)
 *   + frication noise → band-pass (per fricative) and plosive bursts.
 * Per-phoneme targets (Peterson–Barney / Hillenbrand means), 35 ms formant
 * transitions, diphthong glides, a punctuation-driven pitch contour with
 * accents on stressed vowels and declination. Same text + preset + seed →
 * identical samples (seeded noise, no clock, no Math.random).
 */
import { phonemesToCues } from "../cues";
import { energyEnvelope } from "../energy";
import { numSetting, settingsKey, strSetting, type SpeechSettings, type SpeechWord, type SynthesisResult, type SynthesizeImpl } from "../engine";
import { TEST_VOICE } from "../engines/meta";
import { english } from "../g2p/index";
import type { G2PToken, PauseMark } from "../language";
import { PHONEMES, isVowel, type Phoneme, type PhonemeToken, type TimedPhoneme } from "../phonemes";

// ── Presets ───────────────────────────────────────────────────────────────────

export interface VoicePreset {
  id: string;
  label: string;
  /** Mean pitch, Hz. */
  f0: number;
  /** Formant scale (vocal tract length): 1 adult male, ~1.17 adult female. */
  formantScale: number;
  /** 0..1 pitch movement (accents, declination, question rise). 0 = monotone. */
  intonation: number;
  /** 0..1 noise mixed into voicing. */
  breath: number;
  /** Spectral tilt lowpass bandwidth (Hz): lower = softer, higher = buzzier. */
  tiltBw: number;
  /** Quantise pitch to semitone steps (the robot tell). */
  steppedPitch: boolean;
  rate: number;
}

export const VOICE_PRESETS: Record<string, VoicePreset> = {
  warm: { id: "warm", label: "Warm", f0: 118, formantScale: 1, intonation: 1, breath: 0.08, tiltBw: 120, steppedPitch: false, rate: 1 },
  bright: { id: "bright", label: "Bright", f0: 205, formantScale: 1.16, intonation: 1.1, breath: 0.06, tiltBw: 160, steppedPitch: false, rate: 1.05 },
  robo: { id: "robo", label: "Robo", f0: 96, formantScale: 1.03, intonation: 0.15, breath: 0, tiltBw: 420, steppedPitch: true, rate: 1.08 },
};

// ── Acoustic targets ──────────────────────────────────────────────────────────

type F3 = readonly [number, number, number];
const V: Partial<Record<Phoneme, F3>> = {
  AA: [730, 1090, 2440], AE: [660, 1720, 2410], AH: [640, 1190, 2390], AO: [570, 840, 2410], EH: [530, 1840, 2480],
  ER: [490, 1350, 1690], IH: [390, 1990, 2550], IY: [270, 2290, 3010], UH: [440, 1020, 2240], UW: [300, 870, 2240],
};
const SCHWA: F3 = [500, 1450, 2500];
const GLIDES: Partial<Record<Phoneme, readonly [F3, F3]>> = {
  AW: [[730, 1090, 2440], [440, 1020, 2240]], AY: [[730, 1090, 2440], [390, 1990, 2550]],
  EY: [[480, 2000, 2550], [330, 2250, 2900]], OW: [[540, 950, 2400], [400, 800, 2300]], OY: [[570, 840, 2410], [390, 1990, 2550]],
};
const LOCUS: Partial<Record<Phoneme, F3>> = {
  B: [250, 900, 2200], P: [250, 900, 2200], M: [250, 1000, 2200], F: [300, 1100, 2300], V: [300, 1100, 2300],
  D: [280, 1700, 2600], T: [280, 1700, 2600], N: [280, 1700, 2600], TH: [300, 1500, 2500], DH: [300, 1500, 2500],
  S: [300, 1700, 2600], Z: [300, 1700, 2600], SH: [300, 1900, 2400], ZH: [300, 1900, 2400], CH: [300, 1900, 2400],
  JH: [300, 1900, 2400], G: [280, 2000, 2400], K: [280, 2000, 2400], NG: [280, 2100, 2500], L: [360, 1100, 2700],
  R: [330, 1060, 1380], W: [290, 610, 2150], Y: [260, 2070, 3020],
};
/** Frication: [centre Hz, bandwidth Hz, amplitude]. */
const FRIC: Partial<Record<Phoneme, readonly [number, number, number]>> = {
  S: [6000, 3000, 0.55], Z: [6000, 3000, 0.4], SH: [3000, 1800, 0.55], ZH: [3000, 1800, 0.4], CH: [3000, 1800, 0.55],
  JH: [3000, 1800, 0.4], F: [5000, 7000, 0.1], V: [5000, 7000, 0.07], TH: [5000, 7000, 0.08], DH: [5000, 7000, 0.06],
};
/** Plosive burst: [centre Hz, bandwidth Hz, amplitude]. */
const BURST: Partial<Record<Phoneme, readonly [number, number, number]>> = {
  P: [900, 1500, 0.5], B: [900, 1500, 0.3], T: [4200, 2500, 0.55], D: [4000, 2500, 0.35], K: [2200, 1200, 0.55],
  G: [2200, 1200, 0.35], CH: [3000, 1800, 0.4], JH: [3000, 1800, 0.3],
};

interface Frame {
  f1: number; f2: number; f3: number;
  av: number; ah: number; af: number; ff: number; fbw: number; ab: number; bf: number; bbw: number;
  nasal: number;
}

/** The acoustic frame for phoneme `p` at `phase` (0..1 through it); `next` for H. */
function target(p: TimedPhoneme, phase: number, next: TimedPhoneme | undefined): Frame {
  const z: Frame = { f1: 500, f2: 1500, f3: 2500, av: 0, ah: 0, af: 0, ff: 4000, fbw: 3000, ab: 0, bf: 2000, bbw: 1500, nasal: 0 };
  if (p.phoneme === "SIL") {
    const n = next && next.phoneme !== "SIL" ? target(next, 0, undefined) : z;
    return { ...n, av: 0, ah: 0, af: 0, ab: 0 };
  }
  const ph = p.phoneme;
  const info = PHONEMES[ph];
  const set = (f: F3, extra: Partial<Frame>): Frame => ({ ...z, f1: f[0], f2: f[1], f3: f[2], ...extra });
  if (isVowel(ph)) {
    const g = GLIDES[ph];
    const w = Math.min(1, Math.max(0, (phase - 0.25) / 0.6)); // glide over the middle of the vowel
    const f: F3 = g
      ? [lerp(g[0][0], g[1][0], w), lerp(g[0][1], g[1][1], w), lerp(g[0][2], g[1][2], w)]
      : ph === "AH" && p.stress === 0 ? SCHWA : V[ph]!;
    return set(f, { av: 1 });
  }
  if (ph === "HH") {
    const n = next && next.phoneme !== "SIL" && next.phoneme !== "HH" ? target(next, 0, undefined) : z;
    return { ...n, av: 0, ah: 0.7, af: 0, ab: 0, nasal: 0 };
  }
  const loc = LOCUS[ph]!;
  switch (info.class) {
    case "nasal":
      return set(loc, { av: 0.55, nasal: 1 });
    case "liquid":
    case "glide":
      return set(loc, { av: 0.8 });
    case "fricative": {
      const [ff, fbw, af] = FRIC[ph]!;
      return set(loc, { av: info.voiced ? 0.45 : 0, af, ff, fbw });
    }
    case "stop":
    case "affricate": {
      const closeEnd = info.class === "affricate" ? 0.45 : 0.62;
      if (phase < closeEnd) return set(loc, { av: info.voiced ? 0.12 : 0, nasal: info.voiced ? 1 : 0 }); // closure (voice bar)
      const [bf, bbw, ab] = BURST[ph]!;
      if (phase < closeEnd + 0.12) return set(loc, { ab, bf, bbw, av: info.voiced ? 0.3 : 0 });
      if (info.class === "affricate") {
        const [ff, fbw, af] = FRIC[ph]!;
        return set(loc, { af, ff, fbw, av: info.voiced ? 0.4 : 0 });
      }
      return set(loc, { ah: info.voiced ? 0 : 0.45, av: info.voiced ? 0.6 : 0 }); // aspiration / voice onset
    }
    default:
      return set(loc, { av: 0.5 });
  }
}

// ── Timeline ──────────────────────────────────────────────────────────────────

const PAUSE_MS: Record<PauseMark, number> = { ",": 200, ".": 420, "?": 420, "!": 420 };
const LEAD_IN_MS = 150;
const TAIL_MS = 250;

interface Plan {
  phonemes: TimedPhoneme[];
  words: SpeechWord[];
  /** Phrase spans and how each ends — the pitch contour's skeleton. */
  phrases: { startMs: number; endMs: number; mark: PauseMark }[];
  durationMs: number;
}

/** Inherent duration of a phoneme in this voice (ms) — slower and clearer than conversation. */
function durationOf(t: PhonemeToken, phraseFinal: boolean, rate: number): number {
  const info = PHONEMES[t.phoneme];
  let d = info.weight * (isVowel(t.phoneme) ? 1.35 : 1.15);
  if (isVowel(t.phoneme)) d *= t.stress === 0 ? 0.7 : t.stress === 2 ? 0.95 : 1.1;
  if (phraseFinal) d *= isVowel(t.phoneme) ? 1.45 : 1.15;
  return d / rate;
}

export function planSpeech(tokens: readonly G2PToken[], rate = 1): Plan {
  const phonemes: TimedPhoneme[] = [];
  const words: SpeechWord[] = [];
  const phrases: Plan["phrases"] = [];
  let t = 0;
  const sil = (ms: number) => {
    phonemes.push({ phoneme: "SIL", startMs: t, endMs: t + ms });
    t += ms;
  };
  sil(LEAD_IN_MS);
  let phraseStart = t;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.kind === "pause") {
      phrases.push({ startMs: phraseStart, endMs: t, mark: tok.mark });
      sil(PAUSE_MS[tok.mark] / rate);
      phraseStart = t;
      continue;
    }
    if (!tok.phonemes.length) continue;
    const final = !tokens.slice(i + 1).some((n) => n.kind === "word") || tokens[i + 1]?.kind === "pause";
    // The last syllable of a phrase lengthens: phonemes from the word's last vowel on.
    let lastVowel = -1;
    tok.phonemes.forEach((p, k) => { if (isVowel(p.phoneme)) lastVowel = k; });
    const start = t;
    tok.phonemes.forEach((p, k) => {
      const d = durationOf(p, final && k >= lastVowel, rate);
      phonemes.push(p.stress !== undefined ? { phoneme: p.phoneme, stress: p.stress, startMs: t, endMs: t + d } : { phoneme: p.phoneme, startMs: t, endMs: t + d });
      t += d;
    });
    words.push({ text: tok.text, startMs: start, endMs: t });
  }
  if (t > phraseStart) phrases.push({ startMs: phraseStart, endMs: t, mark: "." });
  sil(TAIL_MS);
  return { phonemes, words, phrases, durationMs: t };
}

// ── Pitch ─────────────────────────────────────────────────────────────────────

function pitchAt(tMs: number, plan: Plan, accents: readonly TimedPhoneme[], v: VoicePreset): number {
  const k = v.intonation;
  let f = 1;
  const ph = plan.phrases.find((p) => tMs >= p.startMs && tMs < p.endMs + 1) ?? plan.phrases[plan.phrases.length - 1];
  if (ph) {
    const x = Math.min(1, Math.max(0, (tMs - ph.startMs) / Math.max(1, ph.endMs - ph.startMs)));
    f *= 1 + k * (0.08 - 0.16 * x); // declination
    const toEnd = ph.endMs - tMs;
    if (toEnd < 280) {
      const y = 1 - Math.max(0, toEnd) / 280;
      const end = ph.mark === "?" ? 0.38 : ph.mark === "," ? 0.07 : ph.mark === "!" ? -0.12 : -0.18;
      f *= 1 + k * end * y * y;
    }
  }
  for (const a of accents) {
    if (tMs < a.startMs - 60 || tMs > a.endMs + 60) continue;
    const c = (a.startMs + a.endMs) / 2;
    const w = (a.endMs - a.startMs) / 2 + 60;
    f *= 1 + k * 0.13 * 0.5 * (1 + Math.cos((Math.PI * Math.min(w, Math.abs(tMs - c))) / w));
  }
  const hz = v.f0 * f;
  return v.steppedPitch ? v.f0 * 2 ** (Math.round(12 * Math.log2(hz / v.f0)) / 12) : hz;
}

// ── DSP primitives ────────────────────────────────────────────────────────────

/** mulberry32 — tiny, fast, seedable; the voice's only randomness. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Klatt two-pole resonator (unity gain at DC). */
class Resonator {
  a = 1; b = 0; c = 0; y1 = 0; y2 = 0;
  set(f: number, bw: number, sr: number) {
    const r = Math.exp((-Math.PI * bw) / sr);
    this.c = -r * r;
    this.b = 2 * r * Math.cos((2 * Math.PI * f) / sr);
    this.a = 1 - this.b - this.c;
  }
  tick(x: number): number {
    const y = this.a * x + this.b * this.y1 + this.c * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** RBJ band-pass, 0 dB peak — noise shaping for frication and bursts. */
class BandPass {
  b0 = 0; b2 = 0; a1 = 0; a2 = 0; x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  set(f: number, bw: number, sr: number) {
    const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
    const alpha = Math.sin(w) / (2 * Math.max(0.3, f / bw));
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w)) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  tick(x: number): number {
    const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

const lerp = (a: number, b: number, w: number) => a + (b - a) * w;
function mix(a: Frame, b: Frame, wF: number, wA: number): Frame {
  return {
    f1: lerp(a.f1, b.f1, wF), f2: lerp(a.f2, b.f2, wF), f3: lerp(a.f3, b.f3, wF),
    av: lerp(a.av, b.av, wA), ah: lerp(a.ah, b.ah, wA), af: lerp(a.af, b.af, wA), ab: b.ab * wA + a.ab * (1 - wA),
    ff: wA < 0.5 ? a.ff : b.ff, fbw: wA < 0.5 ? a.fbw : b.fbw, bf: wA < 0.5 ? a.bf : b.bf, bbw: wA < 0.5 ? a.bbw : b.bbw,
    nasal: lerp(a.nasal, b.nasal, wA),
  };
}

// ── Synthesis ─────────────────────────────────────────────────────────────────

export interface VoiceOptions {
  preset?: string;
  seed?: number;
  /** Speaking rate multiplier (1 = the preset's own). */
  rate?: number;
  sampleRate?: number;
}

const FRAME_MS = 5;
const TRANS_F = 35; // formant transition half-width
const TRANS_A = 8; // amplitude transition half-width

/** Text → audio + exact phoneme/viseme/word timing. Synchronous, deterministic. */
export function synthesize(text: string, opts: VoiceOptions = {}): SynthesisResult {
  const voice = VOICE_PRESETS[opts.preset ?? TEST_VOICE.defaults.preset] ?? VOICE_PRESETS.warm!;
  const sr = opts.sampleRate ?? TEST_VOICE.defaults.sampleRate;
  const seed = opts.seed ?? TEST_VOICE.defaults.seed;
  const plan = planSpeech(english.phonemize(text), voice.rate * (opts.rate ?? 1));
  const { phonemes } = plan;
  const accents = phonemes.filter((p) => p.phoneme !== "SIL" && isVowel(p.phoneme) && p.stress === 1);

  const n = Math.ceil((plan.durationMs / 1000) * sr);
  const out = new Float32Array(n);
  const noise = rng(seed);
  const fs = voice.formantScale;
  const res = [new Resonator(), new Resonator(), new Resonator(), new Resonator(), new Resonator()];
  const tilt = new Resonator();
  tilt.set(0, voice.tiltBw, sr);
  const fric = new BandPass();
  const burst = new BandPass();
  const frameLen = Math.max(1, Math.round((sr * FRAME_MS) / 1000));
  let pi = 0;
  let phase = 0;
  let prevSrc = 0;
  let fr: Frame = target(phonemes[0]!, 0, phonemes[1]);

  for (let s0 = 0; s0 < n; s0 += frameLen) {
    // ── parameters for this 5 ms frame ──
    const tMs = (s0 / sr) * 1000;
    while (pi < phonemes.length - 1 && tMs >= phonemes[pi]!.endMs) pi++;
    const p = phonemes[pi]!;
    const d = Math.max(1e-6, p.endMs - p.startMs);
    fr = target(p, (tMs - p.startMs) / d, phonemes[pi + 1]);
    const prev = phonemes[pi - 1];
    const next = phonemes[pi + 1];
    const intoP = tMs - p.startMs;
    const toNext = p.endMs - tMs;
    if (prev && intoP < TRANS_F) {
      const a = target(prev, 1, p);
      fr = mix(a, fr, 0.5 + (0.5 * intoP) / TRANS_F, intoP < TRANS_A ? 0.5 + (0.5 * intoP) / TRANS_A : 1);
    } else if (next && toNext < TRANS_F) {
      const b = target(next, 0, phonemes[pi + 2]);
      fr = mix(fr, b, 0.5 - (0.5 * toNext) / TRANS_F, toNext < TRANS_A ? 0.5 - (0.5 * toNext) / TRANS_A : 0);
    }
    const nasal = fr.nasal;
    res[0]!.set((nasal > 0.5 ? 260 : fr.f1) * fs, nasal > 0.5 ? 110 : 60 + fr.f1 * 0.04, sr);
    res[1]!.set(fr.f2 * fs, (nasal > 0.5 ? 300 : 90) + fr.f2 * 0.02, sr);
    res[2]!.set(fr.f3 * fs, nasal > 0.5 ? 400 : 150, sr);
    res[3]!.set(3300 * fs, 250, sr);
    res[4]!.set(3850 * fs, 300, sr);
    if (fr.af > 0) fric.set(fr.ff * Math.sqrt(fs), fr.fbw, sr);
    if (fr.ab > 0) burst.set(fr.bf * Math.sqrt(fs), fr.bbw, sr);
    const f0 = pitchAt(tMs, plan, accents, voice);
    const av = fr.av * (nasal > 0.5 ? 0.7 : 1);

    // ── samples ──
    const end = Math.min(n, s0 + frameLen);
    for (let s = s0; s < end; s++) {
      phase += f0 / sr;
      let pulse = 0;
      if (phase >= 1) { phase -= 1; pulse = av * 30; }
      const z = noise() * 2 - 1;
      const glottal = tilt.tick(pulse);
      const src = glottal - prevSrc; // radiation: +6 dB/oct
      prevSrc = glottal;
      let x = src + z * (fr.ah * 0.04 + voice.breath * av * 0.02 * (phase < 0.5 ? 1 : 0.3));
      for (const r of res) x = r.tick(x);
      let y = x;
      if (fr.af > 0) y += fric.tick(z) * fr.af * 0.35;
      if (fr.ab > 0) y += burst.tick(z) * fr.ab * 0.5;
      out[s] = y;
    }
  }

  // DC block + normalise to a fixed peak (deterministic, no clipping).
  let x1 = 0, y1 = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    const y = out[i]! - x1 + 0.995 * y1;
    x1 = out[i]!;
    y1 = y;
    out[i] = y;
    peak = Math.max(peak, Math.abs(y));
  }
  const g = peak > 0 ? 0.89 / peak : 0;
  for (let i = 0; i < n; i++) out[i] = out[i]! * g;

  const settings: SpeechSettings = { preset: voice.id, seed, rate: opts.rate ?? 1, sampleRate: sr };
  return {
    engine: TEST_VOICE.id,
    version: TEST_VOICE.version,
    settingsKey: settingsKey(settings, TEST_VOICE.defaults),
    durationMs: plan.durationMs,
    cues: phonemesToCues(phonemes, plan.durationMs),
    energy: energyEnvelope(out, sr),
    words: plan.words,
    phonemes,
    pcm: out,
    sampleRate: sr,
  };
}

export const voiceImpl: SynthesizeImpl = {
  kind: "synthesize",
  async synthesize(input, settings = {}) {
    return synthesize(input.text, {
      preset: strSetting(settings, "preset", TEST_VOICE.defaults.preset),
      seed: numSetting(settings, "seed", TEST_VOICE.defaults.seed),
      rate: numSetting(settings, "rate", TEST_VOICE.defaults.rate),
      sampleRate: numSetting(settings, "sampleRate", TEST_VOICE.defaults.sampleRate),
    });
  },
};

export { voiceImpl as impl };

/** 16-bit PCM WAV bytes — so a host can hand the voice to an audio clip as a file. */
export function toWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i]!)) * 32767, true);
  return bytes;
}
