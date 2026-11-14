"use client";

import { auditionPhrase, cueVariation, type SoundCue, type SoundPackId, type SoundVoice } from "@solomotion/core";
import { ensureAudioBuffer, getAudioBufferForAsset } from "./waveform";
import { MixGraph } from "./mix-graph";

/**
 * WebAudio synthesis engine. All sounds are synthesized (no samples to load),
 * so packs are instant, tweakable by pitch, and weigh nothing.
 * `scheduleCue` uses the AudioContext clock for sample-accurate timing ahead
 * of the visual frame loop.
 */

// A voice paints into any BaseAudioContext — live for playback, OFFLINE for
// `renderPackBuffer`. That one widening is what lets a synthesized pack produce
// a real AudioBuffer, and therefore a real waveform from the same painter the
// timeline uses. No second "what does a pack look like?" model.
interface PackVoice {
  /** `bright` 0..1 is tone colour — the tuned voices open up with it; the click packs ignore it. */
  play: (ctx: BaseAudioContext, dest: AudioNode, when: number, volume: number, pitch: number, bright: number) => void;
}

/**
 * One decaying sine partial — the building block of the tuned voices. A
 * struck bar or tine is a few partials dying at different rates; which ones,
 * and how fast, is the whole difference between a marimba and a glass.
 */
function partial(ctx: BaseAudioContext, dest: AudioNode, when: number, freq: number, amp: number, decay: number, attack = 0.002) {
  if (amp <= 0.0001 || freq > ctx.sampleRate / 2.2) return;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(amp, when + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
  g.connect(dest);
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(freq, when);
  osc.connect(g);
  osc.start(when);
  osc.stop(when + attack + decay + 0.02);
}

/** A strike's transient: a few ms of band-passed noise. */
function strike(ctx: BaseAudioContext, dest: AudioNode, when: number, freq: number, amp: number, duration: number, q = 1) {
  if (amp <= 0.0001) return;
  let noise = noiseCache.get(ctx.sampleRate);
  if (!noise) noiseCache.set(ctx.sampleRate, (noise = noiseBuffer(ctx)));
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = Math.min(freq, ctx.sampleRate / 2.2);
  filter.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(amp, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  src.connect(filter).connect(g).connect(dest);
  src.start(when);
  src.stop(when + duration + 0.01);
}

/** The tuned voices sit on C, so a scale of notes from `audio/sound-sets` is in key. */
const C4 = 261.63;
const C5 = 523.25;
const C6 = 1046.5;

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

// Keyed by sample rate: the offline render context and the live one need not
// agree, and a buffer built at the wrong rate plays back at the wrong pitch.
const noiseCache = new Map<number, AudioBuffer>();

function playTone(
  ctx: BaseAudioContext,
  dest: AudioNode,
  when: number,
  opts: {
    type: OscillatorType;
    freq: number;
    endFreq?: number;
    duration: number;
    volume: number;
    noise?: number;
    noiseDuration?: number;
    /** Where the noise layer sits — a band, not everything above 2kHz. */
    noiseBand?: { type: BiquadFilterType; freq: number; q?: number };
    /** Rolls the tone's harmonics off above this, Hz. */
    toneLowpass?: number;
  },
) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(opts.volume, when);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + opts.duration);
  gain.connect(dest);

  const osc = ctx.createOscillator();
  osc.type = opts.type;
  osc.frequency.setValueAtTime(opts.freq, when);
  if (opts.endFreq) osc.frequency.exponentialRampToValueAtTime(opts.endFreq, when + opts.duration);
  if (opts.toneLowpass) {
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = opts.toneLowpass;
    osc.connect(lp).connect(gain);
  } else {
    osc.connect(gain);
  }
  osc.start(when);
  osc.stop(when + opts.duration + 0.01);

  if (opts.noise && opts.noise > 0) {
    let noise = noiseCache.get(ctx.sampleRate);
    if (!noise) noiseCache.set(ctx.sampleRate, (noise = noiseBuffer(ctx)));
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const ngain = ctx.createGain();
    const nd = opts.noiseDuration ?? opts.duration * 0.6;
    ngain.gain.setValueAtTime(opts.volume * opts.noise, when);
    ngain.gain.exponentialRampToValueAtTime(0.0001, when + nd);
    const filter = ctx.createBiquadFilter();
    filter.type = opts.noiseBand?.type ?? "highpass";
    filter.frequency.value = opts.noiseBand?.freq ?? 2000;
    if (opts.noiseBand?.q) filter.Q.value = opts.noiseBand.q;
    src.connect(filter).connect(ngain).connect(dest);
    src.start(when);
    src.stop(when + nd + 0.01);
  }
}

const PACKS: Record<SoundPackId, PackVoice> = {
  // A keyswitch is a click in a band plus a little body — NOT a square wave:
  // a 1.4kHz square puts its odd harmonics right on the ear's most sensitive
  // range (2–5kHz), and twenty of those a second is what people call piercing.
  mechanical: {
    play: (ctx, dest, when, volume, pitch) =>
      playTone(ctx, dest, when, {
        type: "triangle",
        freq: 520 * pitch,
        endFreq: 240 * pitch,
        duration: 0.03,
        volume: volume * 0.32,
        toneLowpass: 2400,
        noise: 0.9,
        noiseDuration: 0.016,
        noiseBand: { type: "bandpass", freq: 2600 * pitch, q: 1.1 },
      }),
  },
  soft: {
    play: (ctx, dest, when, volume, pitch) =>
      playTone(ctx, dest, when, {
        type: "sine",
        freq: 620 * pitch,
        endFreq: 400 * pitch,
        duration: 0.05,
        volume: volume * 0.4,
        noise: 0.15,
      }),
  },
  vintage: {
    play: (ctx, dest, when, volume, pitch) =>
      playTone(ctx, dest, when, {
        type: "triangle",
        freq: 1000 * pitch,
        endFreq: 500 * pitch,
        duration: 0.06,
        volume: volume * 0.55,
        noise: 0.5,
        noiseDuration: 0.045,
      }),
  },
  thock: {
    play: (ctx, dest, when, volume, pitch) =>
      playTone(ctx, dest, when, {
        type: "sine",
        freq: 220 * pitch,
        endFreq: 90 * pitch,
        duration: 0.08,
        volume: volume * 0.9,
        noise: 0.25,
        noiseDuration: 0.02,
      }),
  },
  digital: {
    play: (ctx, dest, when, volume, pitch) =>
      playTone(ctx, dest, when, {
        type: "square",
        freq: 1800 * pitch,
        duration: 0.018,
        volume: volume * 0.22,
        toneLowpass: 3200,
      }),
  },
  pop: {
    play: (ctx, dest, when, volume, pitch) =>
      playTone(ctx, dest, when, {
        type: "sine",
        freq: 320 * pitch,
        endFreq: 900 * pitch,
        duration: 0.09,
        volume: volume * 0.7,
      }),
  },
  // A rosewood bar: the fundamental rings, the 4th partial (the bar's tuned
  // overtone) and the mallet die fast. Brighter = a harder mallet.
  marimba: {
    play: (ctx, dest, when, volume, pitch, bright) => {
      const f = C5 * pitch;
      partial(ctx, dest, when, f, volume * 0.55, 0.32 + 0.18 * (1 - bright));
      partial(ctx, dest, when, f * 4, volume * (0.06 + 0.2 * bright), 0.07);
      partial(ctx, dest, when, f * 9.9, volume * 0.06 * bright, 0.018);
      strike(ctx, dest, when, 2800, volume * (0.05 + 0.12 * bright), 0.008);
    },
  },
  // A thumb-piano tine: long, pure, with an inharmonic ping on the attack.
  kalimba: {
    play: (ctx, dest, when, volume, pitch, bright) => {
      const f = C5 * pitch;
      partial(ctx, dest, when, f, volume * 0.5, 0.75);
      partial(ctx, dest, when, f * 2, volume * 0.08, 0.25);
      partial(ctx, dest, when, f * 5.9, volume * (0.05 + 0.12 * bright), 0.05);
      strike(ctx, dest, when, 4200, volume * 0.06 * (0.5 + bright), 0.005, 0.8);
    },
  },
  // A struck glass: bell-like inharmonic partials and a long tail.
  glass: {
    play: (ctx, dest, when, volume, pitch, bright) => {
      const f = C6 * pitch;
      partial(ctx, dest, when, f, volume * 0.32, 1.1, 0.001);
      partial(ctx, dest, when, f * 2.76, volume * 0.12, 0.45, 0.001);
      partial(ctx, dest, when, f * 5.4, volume * 0.08 * (0.3 + bright), 0.2, 0.001);
    },
  },
  // A plucked string: a bright saw whose filter closes as it dies.
  pluck: {
    play: (ctx, dest, when, volume, pitch, bright) => {
      const f = C4 * pitch;
      const g = ctx.createGain();
      g.gain.setValueAtTime(volume * 0.42, when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.55);
      g.connect(dest);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.Q.value = 0.7;
      lp.frequency.setValueAtTime(Math.min(f * (3 + 9 * bright), ctx.sampleRate / 2.2), when);
      lp.frequency.exponentialRampToValueAtTime(f * 1.2, when + 0.3);
      lp.connect(g);
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(f, when);
      osc.connect(lp);
      osc.start(when);
      osc.stop(when + 0.58);
    },
  },
  // A temple block: a short hollow knock, more click the harder it lands.
  wood: {
    play: (ctx, dest, when, volume, pitch, bright) => {
      const f = C5 * pitch;
      playTone(ctx, dest, when, { type: "sine", freq: f * 1.04, endFreq: f, duration: 0.09, volume: volume * 0.6 });
      strike(ctx, dest, when, f * 2.3, volume * (0.12 + 0.3 * bright), 0.03, 6);
    },
  },
};

/**
 * THE WEIGHT — a low impact under a hit as a climax peaks (`cue.weight`). Not
 * pitched with the note: a melody three octaves up still lands on the same
 * floor, which is what makes the top of a build feel heavy instead of thin.
 */
function weightLayer(ctx: BaseAudioContext, dest: AudioNode, when: number, level: number) {
  playTone(ctx, dest, when, { type: "sine", freq: 120, endFreq: 46, duration: 0.16, volume: level, toneLowpass: 400 });
}

// The pack names live with the catalogue in core (one spelling, reachable from
// the exporter); re-exported here so the engine stays the single import for
// anything that plays a pack.
export { SOUND_PACK_LABELS } from "@solomotion/core";

/**
 * THE cue voice — live playback AND the exporter play every fired sound
 * through here, so a keystroke cannot sound one way in preview and another in
 * the file (the exporter used to carry its own bare-oscillator copy of the
 * packs, noise layer and all missing). `gain` is what the mix adds on top —
 * the leveler's trim and any clip duck; `custom` the decoded imported hit.
 */
export function playCue(
  ctx: BaseAudioContext,
  dest: AudioNode,
  cue: Pick<SoundCue, "pack" | "custom" | "volume" | "randomness" | "pitch" | "seed" | "bright" | "weight" | "damp" | "pan" | "tuned">,
  when: number,
  gain: number,
  custom: AudioBuffer | null,
): void {
  const { volume, pitch } = cueVariation(cue);
  const level = volume * gain;
  if (level <= 0) return;
  if (cue.pan) {
    // Where it struck: one panner for the hit and its weight, alive as long as the longest tail.
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, cue.pan));
    panner.connect(dest);
    dest = panner;
  }
  if (cue.weight > 0) weightLayer(ctx, dest, when, level * 0.55 * cue.weight);
  if (cue.custom) {
    // Imported hit sound: its hit point lands ON the cue time — the file's
    // attack leads in.
    if (!custom) return;
    const source = ctx.createBufferSource();
    source.buffer = custom;
    source.playbackRate.value = pitch;
    const g = ctx.createGain();
    g.gain.value = level;
    if (cue.damp) {
      // A damped take: a player's hand on the drum. It rings a fifth of its length at full damp.
      const ring = Math.max(0.12, (custom.duration / pitch) * (1 - 0.8 * cue.damp));
      g.gain.setValueAtTime(level, when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + ring);
    }
    source.connect(g).connect(dest);
    const start = when - cue.custom.hitMs / 1000 / pitch;
    if (start >= ctx.currentTime) source.start(start);
    else source.start(ctx.currentTime, (ctx.currentTime - start) * pitch);
    return;
  }
  PACKS[cue.pack].play(ctx, dest, when, level, pitch, cue.bright);
}

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private graph: MixGraph | null = null;
  private _muted = false;

  /** Must be called from a user gesture at least once (autoplay policy). */
  ensure(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.master.gain.value = this._muted ? 0 : 1;
      this.graph = new MixGraph(this.ctx, this.master, { meters: true });
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** The shared context + the live mix graph every voice and cue routes into. */
  mixBus(): { ctx: AudioContext; graph: MixGraph } | null {
    const ctx = this.ensure();
    return ctx && this.graph ? { ctx, graph: this.graph } : null;
  }

  /**
   * Where an AUDITION plays — past the mix, straight to the output. Hearing a
   * library sound before you place it is not part of the project's sound, so
   * no category, leveler or duck may colour it (and the meters stay honest).
   */
  auditionBus(): { ctx: AudioContext; out: AudioNode } | null {
    const ctx = this.ensure();
    return ctx && this.master ? { ctx, out: this.master } : null;
  }

  /** The live graph WITHOUT waking the context — the meters read it, and must never start audio. */
  peekGraph(): MixGraph | null {
    return this.graph;
  }

  setMuted(muted: boolean) {
    this._muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.01);
    }
  }

  get currentTime(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** The audio hardware clock is advancing — a clock the transport can slave to. */
  get clockRunning(): boolean {
    return this.ctx?.state === "running";
  }

  /**
   * Schedule a cue at an absolute AudioContext time (seconds), through the
   * mix: into its category with the plan's trim and ducks (`mix`), or straight
   * to the master when nothing routes it. A custom hit whose decode is still
   * in flight is skipped; later cues play.
   */
  scheduleCue(cue: SoundCue, whenSec: number, mix: { gain: number; bus: string | null } = { gain: 1, bus: null }) {
    const ctx = this.ensure();
    if (!ctx || !this.graph) return;
    const custom = cue.custom ? getAudioBufferForAsset(cue.custom.assetId) : null;
    playCue(ctx, this.cueGate(ctx, mix.bus), cue, Math.max(whenSec, ctx.currentTime), mix.gain, custom);
  }

  /**
   * THE TRANSPORT GATE. Cues are scheduled AHEAD of the playhead (as far as a
   * slow frame needs), and a scheduled buffer source cannot be recalled one by
   * one without keeping every one. So each run's cues go through one gate per
   * bus; stopping or jumping the transport cuts the gates, which silences every
   * cue still queued behind them, and the next cue opens fresh ones.
   */
  private gates = new Map<string, GainNode>();

  private cueGate(ctx: AudioContext, bus: string | null): AudioNode {
    const key = bus ?? "";
    let gate = this.gates.get(key);
    if (!gate && this.graph) {
      gate = ctx.createGain();
      gate.connect(this.graph.input(bus));
      this.gates.set(key, gate);
    }
    return gate ?? this.graph!.input(bus);
  }

  /** Silence every cue scheduled but not yet heard (pause, seek, wrap). */
  cancelScheduledCues(): void {
    for (const gate of this.gates.values()) {
      try {
        gate.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.gates.clear();
  }

  /** Preview an imported sound (dialog play button). */
  previewCustom(assetId: string, volume = 0.8) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    void ensureAudioBuffer(assetId).then((buffer) => {
      if (!buffer || !ctx || !this.master) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = volume;
      source.connect(gain).connect(this.master);
      source.start(ctx.currentTime);
    });
  }

  /** Immediate preview (inspector buttons). */
  preview(pack: SoundPackId, volume = 0.7, pitch = 1) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    PACKS[pack].play(ctx, this.master, ctx.currentTime, volume, pitch, 0.5);
  }

  /**
   * Hear what a voice does as it fires — its notes and its climax — as core's
   * `auditionPhrase` lays it out, through the SAME `playCue` playback and the
   * export use. Past the mix, like every audition.
   */
  previewPhrase(voice: SoundVoice, intensity: number | "build") {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const master = this.master;
    const phrase = auditionPhrase(voice, intensity);
    const t0 = ctx.currentTime + 0.03;
    const tuned = voice.notes ? true : undefined;
    if (voice.kit) {
      // Each firing its own take, as the hits will play them: decode the kit, then play.
      void Promise.all(voice.kit.takes.map((t) => ensureAudioBuffer(t.assetId))).then(() =>
        phrase.forEach((n, i) => {
          const buffer = n.take ? getAudioBufferForAsset(n.take.assetId) : null;
          if (!n.take || !buffer) return;
          const custom = { assetId: n.take.assetId, hitMs: n.take.hitMs };
          playCue(ctx, master, { ...voice, ...n, custom, tuned, seed: ((i + 1) * 0.618) % 1 }, t0 + 0.1 + n.atMs / 1000, 1, buffer);
        }),
      );
      return;
    }
    const play = (buffer: AudioBuffer | null) => {
      phrase.forEach((n, i) => playCue(ctx, master, { ...voice, ...n, tuned, seed: ((i + 1) * 0.618) % 1 }, t0 + n.atMs / 1000, 1, buffer));
    };
    if (voice.custom) void ensureAudioBuffer(voice.custom.assetId).then((b) => b && play(b));
    else play(null);
  }
}

export const soundEngine = new SoundEngine();

/* ------------------------------------------------------------------------ *
 * Pack waveforms — a synthesized pack, rendered offline into a real buffer.
 * ------------------------------------------------------------------------ */

/** Long enough for every pack's tail (glass rings ~1.1 s) with room spare. */
const PACK_RENDER_SEC = 1.3;

const packBuffers = new Map<SoundPackId, AudioBuffer>();
const packRenders = new Map<SoundPackId, Promise<AudioBuffer | null>>();

/**
 * Render a pack ONCE into an AudioBuffer, so the picker can draw its true
 * waveform with the same painter as an imported file. Packs are synthesized —
 * without this they had no visual at all, and the alternative (hand-drawn
 * squiggles per pack) would be a second description of the same sound that
 * silently rots the moment anyone tweaks a voice.
 */
export function renderPackBuffer(pack: SoundPackId): Promise<AudioBuffer | null> {
  const cached = packBuffers.get(pack);
  if (cached) return Promise.resolve(cached);
  let pending = packRenders.get(pack);
  if (pending) return pending;
  pending = (async () => {
    if (typeof window === "undefined" || !window.OfflineAudioContext) return null;
    const rate = 44100;
    const ctx = new OfflineAudioContext(1, Math.ceil(PACK_RENDER_SEC * rate), rate);
    PACKS[pack].play(ctx, ctx.destination, 0, 1, 1, 0.5);
    const buffer = await ctx.startRendering();
    packBuffers.set(pack, buffer);
    return buffer;
  })();
  packRenders.set(pack, pending);
  return pending;
}

/** Synchronous cache hit, mirroring `getAudioBufferForAsset` — a miss kicks the
 *  render off and returns null, so callers repaint on the promise. */
export function packBufferSync(pack: SoundPackId): AudioBuffer | null {
  return packBuffers.get(pack) ?? null;
}

/** Seconds of actual sound in a rendered buffer — the tail is digital silence,
 *  and a sweep that spends most of its run over nothing looks broken. */
export function audibleSeconds(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  for (let i = data.length - 1; i >= 0; i--) if (Math.abs(data[i]!) > 1e-3) return (i + 1) / buffer.sampleRate;
  return 0;
}
