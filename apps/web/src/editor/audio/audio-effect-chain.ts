import {
  bitcrushCurve,
  dbToGain,
  generateReverbIr,
  lfoPhaseAt,
  lfoWave,
  reverbIrSignature,
  saturationCurve,
  webAudioAutoMakeupDb,
  type AudioEffectType,
  type LfoShape,
  type ReverbRoom,
  type ResolvedAudioEffect,
  type SaturatorCharacter,
} from "@solomotion/core";
import { makeBiquad, applyBandToNode } from "./eq-chain";

/**
 * THE ONE PLACE A CHAIN BECOMES SOUND.
 *
 * `audioEffectsAt` (core) answers "what are the settings right now". This
 * answers "what nodes make that happen", and it is the only implementation:
 * the live conductor, the offline bake, the exporter and the A/B preview all
 * build their graph here. That is deliberate and load-bearing — the moment a
 * second copy exists, an export starts disagreeing with the audition, and that
 * bug is only discovered after the render.
 *
 * Two levels of change, kept apart because the cost differs by orders of
 * magnitude:
 *
 *   • VALUES move constantly (a keyframed dry/wet, a modulated cutoff) and are
 *     pushed onto existing AudioParams with `setTargetAtTime` — smooth, no
 *     allocation, no clicks.
 *   • STRUCTURE changes rarely (a card added, a band retyped, a room resized)
 *     and rebuilds nodes. `audioChainSignature` is what tells the two apart, so
 *     a convolver is never torn down sixty times a second.
 *
 * Adding an effect is one entry in `BUILDERS`. Nothing else in the audio path
 * changes — not the conductor, not the exporter, not the bake.
 */

/** Smoothing for parameter moves. Long enough to avoid zipper noise, short
 *  enough that scrubbing still feels immediate. */
const GLIDE = 0.03;

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** One effect's live nodes: where sound enters, where it leaves, how to retune. */
export interface EffectNodes {
  input: AudioNode;
  output: AudioNode;
  /**
   * Push new values onto existing params at `now`. Never allocates.
   *
   * `paramsOnly` is the exporter scheduling a whole clip's automation ahead of
   * an offline render: every AudioParam move is a timed event and lands where
   * it should, but a one-off mutation (a waveshaper curve, a filter's type, an
   * LFO's wave, a regenerated room) would apply to the WHOLE render the moment
   * it is made — so in that mode the builders leave them at their opening state.
   */
  update: (fx: ResolvedAudioEffect, now: number, paramsOnly?: boolean) => void;
  dispose: () => void;
}

type Builder = (ctx: BaseAudioContext, fx: ResolvedAudioEffect) => EffectNodes;

/**
 * The dry/wet frame nearly every effect needs: signal splits, one path is
 * processed, and the two are summed. Written once because five cards want it
 * and five hand-rolled copies would drift on the detail that matters — whether
 * `mix: 0` is truly, exactly bypassed.
 */
function wetDry(
  ctx: BaseAudioContext,
  build: (input: AudioNode) => AudioNode,
): { input: GainNode; output: GainNode; dry: GainNode; wet: GainNode; disposeInner: AudioNode[] } {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry).connect(output);
  const processed = build(input);
  processed.connect(wet).connect(output);
  return { input, output, dry, wet, disposeInner: [input, output, dry, wet] };
}

/** Apply a `mix` value to a dry/wet pair. Equal-gain, so 0 is a true bypass. */
function setMix(dry: GainNode, wet: GainNode, mix: number, now: number): void {
  const m = Math.min(1, Math.max(0, mix));
  dry.gain.setTargetAtTime(1 - m, now, GLIDE);
  wet.gain.setTargetAtTime(m, now, GLIDE);
}

// ── EQ ───────────────────────────────────────────────────────────────────────

const buildEq: Builder = (ctx, fx) => {
  const input = ctx.createGain();
  const output = ctx.createGain();
  let nodes: BiquadFilterNode[] = fx.bands.map((b) => makeBiquad(ctx, b));
  let head: AudioNode = input;
  for (const n of nodes) {
    head.connect(n);
    head = n;
  }
  head.connect(output);

  return {
    input,
    output,
    // The band COUNT and types are structure (handled by a rebuild upstream);
    // here we only re-point frequency/gain/Q, which is what a swept filter needs.
    update: (next, now) => {
      for (let i = 0; i < nodes.length && i < next.bands.length; i++) {
        const node = nodes[i]!;
        const b = next.bands[i]!;
        node.frequency.setTargetAtTime(b.freqHz, now, GLIDE);
        node.Q.setTargetAtTime(b.q, now, GLIDE);
        node.gain.setTargetAtTime(
          node.type === "peaking" || node.type === "lowshelf" || node.type === "highshelf" ? b.gainDb : 0,
          now,
          GLIDE,
        );
      }
    },
    dispose: () => {
      for (const n of nodes) n.disconnect();
      nodes = [];
      input.disconnect();
      output.disconnect();
    },
  };
};

// ── Reverb ───────────────────────────────────────────────────────────────────

/**
 * How long the room must sit still before the impulse response is regenerated.
 * Long enough that a wall-drag costs nothing; short enough that letting go
 * feels immediate. The OLD response keeps playing meanwhile, so the reverb
 * never drops out mid-gesture.
 */
const IR_SETTLE_MS = 140;

const buildReverb: Builder = (ctx, fx) => {
  const preDelay = ctx.createDelay(1);
  const lowCut = ctx.createBiquadFilter();
  const highCut = ctx.createBiquadFilter();
  const convolver = ctx.createConvolver();
  lowCut.type = "highpass";
  highCut.type = "lowpass";
  convolver.normalize = false; // the generator already normalises; see reverb-ir.

  // The impulse response IS the room — generated from the dimensions, so the
  // 3D editor and the ear are looking at one model. Regenerating it is the one
  // genuinely expensive thing an audio card can do (hundreds of thousands of
  // samples), so it happens when the room SETTLES, not while it is moving.
  convolver.buffer = irBuffer(ctx, fx);
  let irSig = reverbIrSignature(roomOf(fx), ctx.sampleRate);
  let settle: ReturnType<typeof setTimeout> | null = null;

  const frame = wetDry(ctx, (input) => {
    input.connect(preDelay);
    preDelay.connect(lowCut).connect(highCut).connect(convolver);
    return convolver;
  });

  const apply = (next: ResolvedAudioEffect, now: number, paramsOnly = false) => {
    const nv = next.values;
    const wanted = reverbIrSignature(roomOf(next), ctx.sampleRate);
    if (wanted !== irSig && !paramsOnly) {
      irSig = wanted;
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => {
        settle = null;
        // Re-check: the room may have moved again while we waited.
        if (reverbIrSignature(roomOf(next), ctx.sampleRate) !== irSig) return;
        try {
          convolver.buffer = irBuffer(ctx, next);
        } catch {
          // A disposed context mid-settle is normal; the voice is gone.
        }
      }, IR_SETTLE_MS);
    }
    preDelay.delayTime.setTargetAtTime(num(nv.preDelayMs, 20) / 1000, now, GLIDE);
    lowCut.frequency.setTargetAtTime(num(nv.lowCutHz, 120), now, GLIDE);
    highCut.frequency.setTargetAtTime(num(nv.highCutHz, 9000), now, GLIDE);
    setMix(frame.dry, frame.wet, num(nv.mix, 0.3), now);
  };
  apply(fx, ctx.currentTime);

  return {
    input: frame.input,
    output: frame.output,
    update: apply,
    dispose: () => {
      if (settle) clearTimeout(settle);
      for (const n of [preDelay, lowCut, highCut, convolver, ...frame.disposeInner]) n.disconnect();
    },
  };
};

/** The room the card describes. ONE reader, so the change-detector and the
 *  generator can never disagree about what "the same room" means. */
function roomOf(fx: ResolvedAudioEffect): ReverbRoom {
  const v = fx.values;
  return {
    widthM: num(v.widthM, 12),
    heightM: num(v.heightM, 4),
    lengthM: num(v.lengthM, 20),
    preDelayMs: 0, // the pre-delay is a real node, not baked into the response
    decaySec: num(v.decaySec, 1.8),
    diffusion: num(v.diffusion, 0.7),
    damping: num(v.damping, 0.4),
    modulation: num(v.modulation, 0.2),
    distance: num(v.distance, 0.35),
    erLevel: num(v.erLevel, 1),
    tailLevel: num(v.tailLevel, 1),
  };
}

/** Generate the room's IR and wrap it as an AudioBuffer for the convolver. */
function irBuffer(ctx: BaseAudioContext, fx: ResolvedAudioEffect): AudioBuffer {
  const ir = generateReverbIr(roomOf(fx), ctx.sampleRate);
  const buffer = ctx.createBuffer(2, ir.left.length, ctx.sampleRate);
  buffer.copyToChannel(ir.left, 0);
  buffer.copyToChannel(ir.right, 1);
  return buffer;
}

// ── Echo ─────────────────────────────────────────────────────────────────────

const buildEcho: Builder = (ctx, fx) => {
  const pingPong = fx.flags.pingPong === true;
  const maxDelay = 5;
  const delayL = ctx.createDelay(maxDelay);
  const delayR = ctx.createDelay(maxDelay);
  const feedback = ctx.createGain();
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  const merger = ctx.createChannelMerger(2);

  const frame = wetDry(ctx, (input) => {
    if (pingPong) {
      // Repeats cross the image: L feeds R feeds L, so each bounce alternates.
      input.connect(delayL);
      delayL.connect(merger, 0, 0);
      delayL.connect(tone).connect(feedback).connect(delayR);
      delayR.connect(merger, 0, 1);
      delayR.connect(delayL);
      return merger;
    }
    input.connect(delayL);
    delayL.connect(tone).connect(feedback).connect(delayL);
    return delayL;
  });

  const apply = (next: ResolvedAudioEffect, now: number) => {
    const nv = next.values;
    const t = Math.min(maxDelay, Math.max(0.01, num(nv.timeMs, 320) / 1000));
    // Ping-pong halves the tap so a full L→R cycle equals the stated time.
    delayL.delayTime.setTargetAtTime(pingPong ? t / 2 : t, now, GLIDE);
    delayR.delayTime.setTargetAtTime(t / 2, now, GLIDE);
    feedback.gain.setTargetAtTime(Math.min(0.95, Math.max(0, num(nv.feedback, 0.35))), now, GLIDE);
    tone.frequency.setTargetAtTime(num(nv.toneHz, 6000), now, GLIDE);
    setMix(frame.dry, frame.wet, num(nv.mix, 0.25), now);
  };
  apply(fx, ctx.currentTime);

  return {
    input: frame.input,
    output: frame.output,
    update: apply,
    dispose: () => {
      for (const n of [delayL, delayR, feedback, tone, merger, ...frame.disposeInner]) n.disconnect();
    },
  };
};

// ── Compressor ───────────────────────────────────────────────────────────────

const buildCompressor: Builder = (ctx, fx) => {
  const comp = ctx.createDynamicsCompressor();
  const makeup = ctx.createGain();

  const frame = wetDry(ctx, (input) => {
    input.connect(comp).connect(makeup);
    return makeup;
  });

  const apply = (next: ResolvedAudioEffect, now: number) => {
    const nv = next.values;
    comp.threshold.setTargetAtTime(num(nv.thresholdDb, -24), now, GLIDE);
    comp.ratio.setTargetAtTime(Math.max(1, num(nv.ratio, 4)), now, GLIDE);
    comp.knee.setTargetAtTime(Math.max(0, num(nv.kneeDb, 24)), now, GLIDE);
    // WebAudio takes seconds; the card speaks the milliseconds engineers use.
    comp.attack.setTargetAtTime(Math.max(0, num(nv.attackMs, 10) / 1000), now, GLIDE);
    comp.release.setTargetAtTime(Math.max(0.001, num(nv.releaseMs, 180) / 1000), now, GLIDE);
    // The card's makeup is the WHOLE makeup: net of what the node adds by itself.
    const auto = webAudioAutoMakeupDb(num(nv.thresholdDb, -24), Math.max(0, num(nv.kneeDb, 24)), Math.max(1, num(nv.ratio, 4)));
    makeup.gain.setTargetAtTime(dbToGain(num(nv.makeupDb, 0) - auto), now, GLIDE);
    setMix(frame.dry, frame.wet, num(nv.mix, 1), now);
  };
  apply(fx, ctx.currentTime);

  return {
    input: frame.input,
    output: frame.output,
    update: apply,
    dispose: () => {
      for (const n of [comp, makeup, ...frame.disposeInner]) n.disconnect();
    },
  };
};

// ── Saturator ────────────────────────────────────────────────────────────────

const buildSaturator: Builder = (ctx, fx) => {
  const shaper = ctx.createWaveShaper();
  const tone = ctx.createBiquadFilter();
  const out = ctx.createGain();
  tone.type = "lowpass";
  shaper.oversample = "4x"; // waveshaping without this aliases audibly
  shaper.curve = saturationCurve(
    (fx.values.character as SaturatorCharacter) ?? "tape",
    num(fx.values.driveDb, 8),
  );
  let curveSig = `${fx.values.character}:${num(fx.values.driveDb, 8)}`;

  const frame = wetDry(ctx, (input) => {
    input.connect(shaper).connect(tone).connect(out);
    return out;
  });

  const apply = (next: ResolvedAudioEffect, now: number, paramsOnly = false) => {
    const nv = next.values;
    // The CURVE is 2048 floats — only rebuild it when its shape actually moves.
    const sig = `${nv.character}:${num(nv.driveDb, 8)}`;
    if (sig !== curveSig && !paramsOnly) {
      shaper.curve = saturationCurve((nv.character as SaturatorCharacter) ?? "tape", num(nv.driveDb, 8));
      curveSig = sig;
    }
    tone.frequency.setTargetAtTime(num(nv.toneHz, 12000), now, GLIDE);
    out.gain.setTargetAtTime(dbToGain(num(nv.outputDb, 0)), now, GLIDE);
    setMix(frame.dry, frame.wet, num(nv.mix, 1), now);
  };
  apply(fx, ctx.currentTime);

  return {
    input: frame.input,
    output: frame.output,
    update: apply,
    dispose: () => {
      for (const n of [shaper, tone, out, ...frame.disposeInner]) n.disconnect();
    },
  };
};

// ── LFOs ─────────────────────────────────────────────────────────────────────

const shapeOf = (v: unknown): LfoShape => (v === "triangle" || v === "square" || v === "sawtooth" ? v : "sine");

interface Lfo {
  osc: OscillatorNode;
  set: (shape: LfoShape, rateHz: number, now: number, paramsOnly: boolean) => void;
  dispose: () => void;
}

/**
 * A native LFO in phase with the CLIP: its periodic wave is rotated to where
 * the cycle is at the instant the chain was built (`lfoWave`), so a preview
 * started mid-clip and an export started at zero wobble in step. The rotation
 * is relative to the oscillator's own running phase, so a later change of
 * shape keeps that same rotation.
 */
function makeLfo(ctx: BaseAudioContext, shape: LfoShape, rateHz: number, localMs: number): Lfo {
  const osc = ctx.createOscillator();
  const phase0 = lfoPhaseAt(rateHz, localMs);
  const wave = (s: LfoShape) => {
    const { real, imag } = lfoWave(s, phase0);
    return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
  };
  let current = shape;
  osc.setPeriodicWave(wave(shape));
  osc.frequency.value = Math.max(0, rateHz);
  osc.start();
  return {
    osc,
    set: (s, rate, now, paramsOnly) => {
      if (s !== current && !paramsOnly) {
        current = s;
        osc.setPeriodicWave(wave(s));
      }
      osc.frequency.setTargetAtTime(Math.max(0, rate), now, GLIDE);
    },
    dispose: () => {
      try {
        osc.stop();
      } catch {
        // Already stopped with its context.
      }
      osc.disconnect();
    },
  };
}

// ── Filter ───────────────────────────────────────────────────────────────────

const FILTER_MODES = new Set<BiquadFilterType>(["lowpass", "highpass", "bandpass", "notch"]);

const buildFilter: Builder = (ctx, fx) => {
  const filter = ctx.createBiquadFilter();
  const lfo = makeLfo(ctx, shapeOf(fx.values.lfoShape), num(fx.values.lfoRateHz), fx.localMs);
  // The LFO moves the cutoff in CENTS through `detune`, so its depth is in
  // octaves whatever the cutoff — a sweep that sounds even, high or low.
  const depth = ctx.createGain();
  lfo.osc.connect(depth).connect(filter.detune);
  const frame = wetDry(ctx, (input) => {
    input.connect(filter);
    return filter;
  });

  const apply = (next: ResolvedAudioEffect, now: number, paramsOnly = false) => {
    const nv = next.values;
    const mode = (FILTER_MODES.has(nv.mode as BiquadFilterType) ? nv.mode : "lowpass") as BiquadFilterType;
    if (!paramsOnly && filter.type !== mode) filter.type = mode;
    filter.frequency.setTargetAtTime(Math.min(20000, Math.max(20, num(nv.cutoffHz, 1200))), now, GLIDE);
    // WebAudio reads Q as decibels of resonance on the pass types and as a
    // bandwidth on the others; the card speaks one resonance for all four.
    const res = Math.max(0.1, num(nv.resonance, 1));
    filter.Q.setTargetAtTime(mode === "lowpass" || mode === "highpass" ? 20 * Math.log10(res) : res, now, GLIDE);
    const rate = num(nv.lfoRateHz);
    lfo.set(shapeOf(nv.lfoShape), rate, now, paramsOnly);
    depth.gain.setTargetAtTime(rate > 0 ? num(nv.lfoDepth) * 1200 : 0, now, GLIDE);
    setMix(frame.dry, frame.wet, num(nv.mix, 1), now);
  };
  apply(fx, ctx.currentTime);

  return {
    input: frame.input,
    output: frame.output,
    update: apply,
    dispose: () => {
      lfo.dispose();
      for (const n of [filter, depth, ...frame.disposeInner]) n.disconnect();
    },
  };
};

// ── Chorus ───────────────────────────────────────────────────────────────────

const buildChorus: Builder = (ctx, fx) => {
  const delayL = ctx.createDelay(0.1);
  const delayR = ctx.createDelay(0.1);
  const fbL = ctx.createGain();
  const fbR = ctx.createGain();
  const swingL = ctx.createGain();
  const swingR = ctx.createGain();
  const merger = ctx.createChannelMerger(2);
  const lfo = makeLfo(ctx, shapeOf(fx.values.shape), num(fx.values.rateHz, 0.8), fx.localMs);
  lfo.osc.connect(swingL).connect(delayL.delayTime);
  lfo.osc.connect(swingR).connect(delayR.delayTime);

  const frame = wetDry(ctx, (input) => {
    input.connect(delayL);
    input.connect(delayR);
    // Feedback through the delay itself — the loop WebAudio allows.
    delayL.connect(fbL).connect(delayL);
    delayR.connect(fbR).connect(delayR);
    delayL.connect(merger, 0, 0);
    delayR.connect(merger, 0, 1);
    return merger;
  });

  const apply = (next: ResolvedAudioEffect, now: number, paramsOnly = false) => {
    const nv = next.values;
    const base = Math.max(0.5, num(nv.delayMs, 18)) / 1000;
    // The swing never reaches past zero delay: a negative time would clamp and click.
    const swing = Math.min(num(nv.depthMs, 4) / 1000, base * 0.98);
    const spread = Math.min(1, Math.max(0, num(nv.spread, 0.8)));
    delayL.delayTime.setTargetAtTime(base, now, GLIDE);
    delayR.delayTime.setTargetAtTime(base, now, GLIDE);
    swingL.gain.setTargetAtTime(swing, now, GLIDE);
    // Width: the right side drifts with the left at 0, against it at 1.
    swingR.gain.setTargetAtTime(swing * (1 - 2 * spread), now, GLIDE);
    const fb = Math.min(0.95, Math.max(0, num(nv.feedback)));
    fbL.gain.setTargetAtTime(fb, now, GLIDE);
    fbR.gain.setTargetAtTime(fb, now, GLIDE);
    lfo.set(shapeOf(nv.shape), num(nv.rateHz, 0.8), now, paramsOnly);
    setMix(frame.dry, frame.wet, num(nv.mix, 0.5), now);
  };
  apply(fx, ctx.currentTime);

  return {
    input: frame.input,
    output: frame.output,
    update: apply,
    dispose: () => {
      lfo.dispose();
      for (const n of [delayL, delayR, fbL, fbR, swingL, swingR, merger, ...frame.disposeInner]) n.disconnect();
    },
  };
};

// ── Phaser ───────────────────────────────────────────────────────────────────

const buildPhaser: Builder = (ctx, fx) => {
  const count = Math.max(2, Math.round(num(Number(fx.values.stages), 6)));
  const stages = Array.from({ length: count }, () => {
    const f = ctx.createBiquadFilter();
    f.type = "allpass";
    f.Q.value = 0.7;
    return f;
  });
  const lfo = makeLfo(ctx, shapeOf(fx.values.lfoShape), num(fx.values.lfoRateHz, 0.4), fx.localMs);
  const depth = ctx.createGain();
  lfo.osc.connect(depth);
  for (const st of stages) depth.connect(st.detune);
  // A feedback loop needs a delay to exist at all; one render quantum is the
  // least WebAudio allows, and short enough to read as resonance.
  const loop = ctx.createDelay(0.01);
  const fb = ctx.createGain();

  const frame = wetDry(ctx, (input) => {
    let head: AudioNode = input;
    for (const st of stages) {
      head.connect(st);
      head = st;
    }
    head.connect(fb).connect(loop).connect(stages[0]!);
    return head;
  });

  const apply = (next: ResolvedAudioEffect, now: number, paramsOnly = false) => {
    const nv = next.values;
    const center = Math.min(8000, Math.max(60, num(nv.centerHz, 900)));
    for (const st of stages) st.frequency.setTargetAtTime(center, now, GLIDE);
    const rate = num(nv.lfoRateHz, 0.4);
    lfo.set(shapeOf(nv.lfoShape), rate, now, paramsOnly);
    depth.gain.setTargetAtTime(rate > 0 ? num(nv.lfoDepth, 2) * 1200 : 0, now, GLIDE);
    fb.gain.setTargetAtTime(Math.min(0.9, Math.max(0, num(nv.feedback, 0.4))), now, GLIDE);
    setMix(frame.dry, frame.wet, num(nv.mix, 0.5), now);
  };
  apply(fx, ctx.currentTime);

  return {
    input: frame.input,
    output: frame.output,
    update: apply,
    dispose: () => {
      lfo.dispose();
      for (const n of [...stages, depth, loop, fb, ...frame.disposeInner]) n.disconnect();
    },
  };
};

// ── Tremolo ──────────────────────────────────────────────────────────────────

/**
 * An input that is always TWO channels: a mono source arrives as L = R.
 * Without it a splitter maps mono discretely (the right side goes silent) and
 * a stereo panner treats mono with its equal-power law (3 dB down at centre),
 * so a card meant to move the image would first change the level.
 */
function stereoInput(ctx: BaseAudioContext): GainNode {
  const g = ctx.createGain();
  g.channelCount = 2;
  g.channelCountMode = "explicit";
  g.channelInterpretation = "speakers";
  return g;
}

const buildTremolo: Builder = (ctx, fx) => {
  const input = stereoInput(ctx);
  const amp = ctx.createGain();
  const panner = ctx.createStereoPanner();
  const toAmp = ctx.createGain();
  const toPan = ctx.createGain();
  const lfo = makeLfo(ctx, shapeOf(fx.values.shape), num(fx.values.rateHz, 5), fx.localMs);
  lfo.osc.connect(toAmp).connect(amp.gain);
  lfo.osc.connect(toPan).connect(panner.pan);
  input.connect(amp).connect(panner);

  const apply = (next: ResolvedAudioEffect, now: number, paramsOnly = false) => {
    const nv = next.values;
    const depth = Math.min(1, Math.max(0, num(nv.depth, 0.6)));
    const pan = nv.target === "pan";
    // Volume swings between 1 and 1 − depth: centred on 1 − depth/2.
    amp.gain.setTargetAtTime(pan ? 1 : 1 - depth / 2, now, GLIDE);
    toAmp.gain.setTargetAtTime(pan ? 0 : depth / 2, now, GLIDE);
    toPan.gain.setTargetAtTime(pan ? depth : 0, now, GLIDE);
    lfo.set(shapeOf(nv.shape), num(nv.rateHz, 5), now, paramsOnly);
  };
  apply(fx, ctx.currentTime);

  return {
    input,
    output: panner,
    update: apply,
    dispose: () => {
      lfo.dispose();
      for (const n of [input, amp, panner, toAmp, toPan]) n.disconnect();
    },
  };
};

// ── Ring mod ─────────────────────────────────────────────────────────────────

const buildRingMod: Builder = (ctx, fx) => {
  const ring = ctx.createGain();
  ring.gain.value = 0; // the carrier IS the gain: signal × tone
  const carrier = makeLfo(ctx, shapeOf(fx.values.shape), num(fx.values.frequencyHz, 40), fx.localMs);
  carrier.osc.connect(ring.gain);
  const frame = wetDry(ctx, (input) => {
    input.connect(ring);
    return ring;
  });

  const apply = (next: ResolvedAudioEffect, now: number, paramsOnly = false) => {
    const nv = next.values;
    carrier.set(shapeOf(nv.shape), Math.min(4000, Math.max(1, num(nv.frequencyHz, 40))), now, paramsOnly);
    setMix(frame.dry, frame.wet, num(nv.mix, 1), now);
  };
  apply(fx, ctx.currentTime);

  return {
    input: frame.input,
    output: frame.output,
    update: apply,
    dispose: () => {
      carrier.dispose();
      for (const n of [ring, ...frame.disposeInner]) n.disconnect();
    },
  };
};

// ── Bitcrush ─────────────────────────────────────────────────────────────────

const buildBitcrush: Builder = (ctx, fx) => {
  const shaper = ctx.createWaveShaper();
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  shaper.oversample = "none"; // the aliasing is the sound
  const sigOf = (v: ResolvedAudioEffect["values"]) => `${Math.round(num(v.bits, 6) * 10)}:${Math.round(num(v.driveDb) * 2)}`;
  shaper.curve = bitcrushCurve(num(fx.values.bits, 6), num(fx.values.driveDb));
  let curveSig = sigOf(fx.values);
  const frame = wetDry(ctx, (input) => {
    input.connect(shaper).connect(tone);
    return tone;
  });

  const apply = (next: ResolvedAudioEffect, now: number, paramsOnly = false) => {
    const nv = next.values;
    const sig = sigOf(nv);
    if (sig !== curveSig && !paramsOnly) {
      shaper.curve = bitcrushCurve(num(nv.bits, 6), num(nv.driveDb));
      curveSig = sig;
    }
    tone.frequency.setTargetAtTime(Math.min(20000, Math.max(200, num(nv.toneHz, 5000))), now, GLIDE);
    setMix(frame.dry, frame.wet, num(nv.mix, 1), now);
  };
  apply(fx, ctx.currentTime);

  return {
    input: frame.input,
    output: frame.output,
    update: apply,
    dispose: () => {
      for (const n of [shaper, tone, ...frame.disposeInner]) n.disconnect();
    },
  };
};

// ── Stereo ───────────────────────────────────────────────────────────────────

const buildStereo: Builder = (ctx, fx) => {
  const input = stereoInput(ctx);
  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(2);
  const panner = ctx.createStereoPanner();
  // L' = a·L + b·R and R' = a·R + b·L, with a = (1 + w)/2 and b = (1 − w)/2:
  // 0 folds to mono, 1 is untouched, 2 subtracts each side from the other.
  const ll = ctx.createGain();
  const rl = ctx.createGain();
  const rr = ctx.createGain();
  const lr = ctx.createGain();
  input.connect(split);
  split.connect(ll, 0).connect(merge, 0, 0);
  split.connect(rl, 1).connect(merge, 0, 0);
  split.connect(rr, 1).connect(merge, 0, 1);
  split.connect(lr, 0).connect(merge, 0, 1);
  merge.connect(panner);

  const apply = (next: ResolvedAudioEffect, now: number) => {
    const nv = next.values;
    const w = Math.min(2, Math.max(0, num(nv.width, 1)));
    const a = (1 + w) / 2;
    const b = (1 - w) / 2;
    ll.gain.setTargetAtTime(a, now, GLIDE);
    rr.gain.setTargetAtTime(a, now, GLIDE);
    rl.gain.setTargetAtTime(b, now, GLIDE);
    lr.gain.setTargetAtTime(b, now, GLIDE);
    panner.pan.setTargetAtTime(Math.min(1, Math.max(-1, num(nv.pan))), now, GLIDE);
  };
  apply(fx, ctx.currentTime);

  return {
    input,
    output: panner,
    update: apply,
    dispose: () => {
      for (const n of [input, split, merge, panner, ll, rl, rr, lr]) n.disconnect();
    },
  };
};

/**
 * The pluggable seam: a new effect is one entry here. Exhaustive over the
 * type, so a kind declared in the schema without a sound fails the build
 * instead of going silently quiet.
 */
const BUILDERS: Record<AudioEffectType, Builder> = {
  eq: buildEq,
  reverb: buildReverb,
  echo: buildEcho,
  compressor: buildCompressor,
  saturator: buildSaturator,
  filter: buildFilter,
  chorus: buildChorus,
  phaser: buildPhaser,
  tremolo: buildTremolo,
  ringMod: buildRingMod,
  bitcrush: buildBitcrush,
  stereo: buildStereo,
};

// ── The chain ────────────────────────────────────────────────────────────────

/** A whole clip's chain, wired in stack order. */
export interface AudioChain {
  input: AudioNode;
  output: AudioNode;
  update: (chain: readonly ResolvedAudioEffect[], now: number, paramsOnly?: boolean) => void;
  dispose: () => void;
}

/**
 * Wire a resolved chain into native nodes, IN ORDER — the list order is the
 * signal path, which is the whole reason the stack is ordered.
 *
 * Returns null for an empty chain so callers connect their source straight
 * through and pay nothing for a clip with no effects.
 */
export function buildAudioChain(
  ctx: BaseAudioContext,
  chain: readonly ResolvedAudioEffect[],
): AudioChain | null {
  if (chain.length === 0) return null;
  const built: EffectNodes[] = [];
  for (const fx of chain) {
    const builder = BUILDERS[fx.type];
    if (builder) built.push(builder(ctx, fx));
  }
  if (built.length === 0) return null;

  for (let i = 0; i < built.length - 1; i++) built[i]!.output.connect(built[i + 1]!.input);

  return {
    input: built[0]!.input,
    output: built[built.length - 1]!.output,
    update: (next, now, paramsOnly) => {
      // Positional: the caller only calls this when the SIGNATURE matched, so
      // the two lists describe the same graph in the same order.
      for (let i = 0; i < built.length && i < next.length; i++) built[i]!.update(next[i]!, now, paramsOnly);
    },
    dispose: () => {
      for (const n of built) n.dispose();
    },
  };
}
