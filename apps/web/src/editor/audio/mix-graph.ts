"use client";

import { audioChainSignature, audioEffectsAt, dbToGain, duckGainAt, duckValueCurve, webAudioAutoMakeupDb, type MixPlan } from "@solomotion/core";
import { buildAudioChain, type AudioChain } from "./audio-effect-chain";

/**
 * THE MIX GRAPH — the categories and the master as real audio nodes, built the
 * same way for the live context and for the exporter's offline one:
 *
 *   voice ─▶ category input ─▶ its effect chain ─▶ dialogue leveler ─▶ duck ─▶ fader ─▶ meter ─┐
 *   unrouted voice ─────────────────────────────────────────────────────────────────▶ fader ─┤
 *                                                   master in ◀──────────────────────────────┘
 *                                                   ─▶ master fader ─▶ limiter ─▶ meter ─▶ out
 *
 * It holds no rules. The mix plan says what each category's gain, duck and
 * chain are; this only turns that into nodes and moves their params — live per
 * tick, or once as automation curves for an offline render. Categories are
 * built lazily on first use, so a project that never routes anything pays for
 * one gain node.
 */

interface BusNodes {
  input: GainNode;
  chain: AudioChain | null;
  chainSig: string;
  /** The dialogue leveler: a slow, soft compressor + its makeup. */
  speech: { comp: DynamicsCompressorNode; makeup: GainNode } | null;
  duck: GainNode;
  fader: GainNode;
  meter: AnalyserNode | null;
}

/** A dialogue leveler, not a squash: slow, soft-kneed, 3:1 on the loud words. */
const SPEECH = { threshold: -26, knee: 18, ratio: 3, attack: 0.012, release: 0.3, makeupDb: 4 };

export class MixGraph {
  private readonly buses = new Map<string, BusNodes>();
  private readonly unrouted: GainNode;
  private readonly masterIn: GainNode;
  private readonly masterFader: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  /**
   * The ceiling itself. A compressor is not a brick wall: a sharp transient (a
   * pop, a hit) is through before its 1 ms attack bites — 32 bouncing balls
   * exported at 104%. This shaper is linear under 90% of the ceiling and eases
   * into it above, so no sample ever passes it.
   */
  private readonly ceiling: WaveShaperNode;
  private ceilingDb = NaN;
  /** Exactly one of these two is open — see `setLimiter`. */
  private readonly limited: GainNode;
  /** Takes back the gain the limiter's compressor adds by itself, BEFORE the ceiling (core › compressor.ts). */
  private readonly limiterTrim: GainNode;
  private readonly limiterBypass: GainNode;
  readonly masterMeters: [AnalyserNode, AnalyserNode] | null;

  constructor(
    private readonly ctx: BaseAudioContext,
    destination: AudioNode,
    private readonly opts: { meters: boolean },
  ) {
    this.masterIn = ctx.createGain();
    this.masterFader = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.08;
    this.ceiling = ctx.createWaveShaper();
    this.ceiling.oversample = "4x";
    this.limited = ctx.createGain();
    this.limiterTrim = ctx.createGain();
    this.limiterBypass = ctx.createGain();
    const out = ctx.createGain();
    this.masterIn.connect(this.masterFader);
    // Both paths exist; `setLimiter` opens exactly one, so switching it on or
    // off mid-playback is a gain move, never a reconnect (which would click).
    this.masterFader.connect(this.limiter).connect(this.limiterTrim).connect(this.ceiling).connect(this.limited).connect(out);
    this.masterFader.connect(this.limiterBypass).connect(out);
    this.limiterBypass.gain.value = 0;
    out.connect(destination);
    if (opts.meters) {
      const split = ctx.createChannelSplitter(2);
      out.connect(split);
      const l = this.analyser();
      const r = this.analyser();
      split.connect(l, 0);
      split.connect(r, 1);
      this.masterMeters = [l, r];
    } else {
      this.masterMeters = null;
    }
    this.unrouted = ctx.createGain();
    this.unrouted.connect(this.masterIn);
  }

  private analyser(): AnalyserNode {
    const a = this.ctx.createAnalyser();
    a.fftSize = 2048;
    a.smoothingTimeConstant = 0;
    return a;
  }

  /** Where a voice connects: its category's input, or straight to the master. */
  input(busId: string | null): AudioNode {
    return busId ? this.bus(busId).input : this.unrouted;
  }

  /** A category's meter (live graphs only), or null until it exists. */
  meter(busId: string): AnalyserNode | null {
    return this.buses.get(busId)?.meter ?? null;
  }

  private bus(id: string): BusNodes {
    let b = this.buses.get(id);
    if (b) return b;
    const ctx = this.ctx;
    b = {
      input: ctx.createGain(),
      chain: null,
      chainSig: "",
      speech: null,
      duck: ctx.createGain(),
      fader: ctx.createGain(),
      meter: this.opts.meters ? this.analyser() : null,
    };
    b.input.connect(b.duck);
    b.duck.connect(b.fader).connect(this.masterIn);
    if (b.meter) b.fader.connect(b.meter);
    this.buses.set(id, b);
    return b;
  }

  /** Rewire a category's processing when its STRUCTURE changed (a card added, speech on). */
  private restructure(b: BusNodes, plan: MixPlan, id: string): void {
    const planned = plan.buses.get(id);
    const resolved = planned ? audioEffectsAt(planned.bus.audioEffects, [], 0) : [];
    const sig = `${audioChainSignature(resolved)}|${planned?.evenSpeech ? "s" : ""}`;
    if (sig === b.chainSig) {
      b.chain?.update(resolved, this.ctx.currentTime);
      return;
    }
    b.input.disconnect();
    b.chain?.dispose();
    b.speech?.comp.disconnect();
    b.speech?.makeup.disconnect();
    b.chain = buildAudioChain(this.ctx, resolved);
    b.speech = null;
    let head: AudioNode = b.input;
    if (b.chain) {
      head.connect(b.chain.input);
      head = b.chain.output;
    }
    if (planned?.evenSpeech) {
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = SPEECH.threshold;
      comp.knee.value = SPEECH.knee;
      comp.ratio.value = SPEECH.ratio;
      comp.attack.value = SPEECH.attack;
      comp.release.value = SPEECH.release;
      const makeup = this.ctx.createGain();
      // Net of the gain the node adds by itself (core › compressor.ts): without
      // this the "+4 dB" was ~+10 dB and every narrated export ran hot.
      makeup.gain.value = dbToGain(SPEECH.makeupDb - webAudioAutoMakeupDb(SPEECH.threshold, SPEECH.knee, SPEECH.ratio));
      head.connect(comp).connect(makeup);
      head = makeup;
      b.speech = { comp, makeup };
    }
    head.connect(b.duck);
    b.chainSig = sig;
  }

  private setLimiter(plan: MixPlan, when: number): void {
    const on = !!plan.limiter;
    // A hair under the ceiling: the compressor's knee lets the first overs
    // through by a fraction of a dB.
    if (plan.limiter) {
      this.limiter.threshold.setValueAtTime(plan.limiter.ceilingDb - 1, when);
      this.limiterTrim.gain.setValueAtTime(dbToGain(-webAudioAutoMakeupDb(plan.limiter.ceilingDb - 1, 0, 20)), when);
    }
    if (plan.limiter && plan.limiter.ceilingDb !== this.ceilingDb) {
      this.ceilingDb = plan.limiter.ceilingDb;
      this.ceiling.curve = ceilingCurve(10 ** (plan.limiter.ceilingDb / 20));
    }
    this.limited.gain.setValueAtTime(on ? 1 : 0, when);
    this.limiterBypass.gain.setValueAtTime(on ? 0 : 1, when);
  }

  /**
   * LIVE: move every fader and duck to where the plan says they are at
   * `atMs` of the conducted comp. Cheap enough to call every tick — structure
   * only rebuilds when a category's chain actually changed.
   */
  applyLive(plan: MixPlan, atMs: number): void {
    const now = this.ctx.currentTime;
    const ramp = 0.02;
    this.masterFader.gain.setTargetAtTime(plan.volume, now, ramp);
    this.unrouted.gain.setTargetAtTime(plan.unroutedGain, now, ramp);
    this.setLimiter(plan, now);
    for (const [id, planned] of plan.buses) {
      if (!planned.used && !this.buses.has(id)) continue;
      const b = this.bus(id);
      this.restructure(b, plan, id);
      b.fader.gain.setTargetAtTime(planned.gain, now, ramp);
      b.duck.gain.setTargetAtTime(duckGainAt(planned.duck, atMs), now, ramp);
    }
  }

  /**
   * OFFLINE: the whole render's mix at once — faders as values, each category's
   * duck as an automation curve over [fromMs, fromMs + durationMs) of the comp,
   * starting at context time `t0`.
   */
  scheduleRender(plan: MixPlan, t0: number, fromMs: number, durationMs: number): void {
    this.masterFader.gain.value = plan.volume;
    this.unrouted.gain.value = plan.unroutedGain;
    this.setLimiter(plan, 0);
    for (const [id, planned] of plan.buses) {
      if (!planned.used) continue;
      const b = this.bus(id);
      this.restructure(b, plan, id);
      b.fader.gain.value = planned.gain;
      if (planned.duck) {
        b.duck.gain.setValueCurveAtTime(duckValueCurve(planned.duck, fromMs, durationMs), t0, Math.max(0.001, durationMs / 1000));
      }
    }
  }

  dispose(): void {
    for (const b of this.buses.values()) {
      b.chain?.dispose();
      b.input.disconnect();
      b.fader.disconnect();
    }
    this.buses.clear();
    this.masterIn.disconnect();
  }
}

/**
 * A soft ceiling at `c` (linear): straight through to 0.9c, then eased toward
 * c and never past it. The shaper holds its end values for any input beyond
 * ±1, so an over of any size lands at the ceiling.
 */
function ceilingCurve(c: number): Float32Array<ArrayBuffer> {
  const n = 4097, k = 0.9 * c, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
    out[i] = Math.sign(x) * (a <= k ? a : k + (c - k) * Math.tanh((a - k) / (c - k)));
  }
  return out;
}
