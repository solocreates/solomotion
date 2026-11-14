import { z } from "zod";

/**
 * AUDIO EFFECTS — the sound half of the effect model.
 *
 * A clip carries a STACK of audio effects exactly as it carries a stack of
 * layer effects: an ordered list of instances, each with a stable id, each
 * field keyframable at `afx.<id>.<field>`, each projected onto the node board
 * as a card in a chain. Everything that makes the visual stack work — the
 * floating editor, presets, property transfer, modulators, drivers, record
 * mode — is generic over `BaseEffect`, so sound gets all of it by declaring
 * itself here rather than by growing a third silo.
 *
 * ORDER IS THE SIGNAL CHAIN. Compressor-then-reverb and reverb-then-compressor
 * are audibly different, and the list order is how the user says which one they
 * meant. That is the same contract the visual stack has, and it is what makes
 * the node projection honest rather than decorative.
 *
 * Every kind here maps onto NATIVE WebAudio nodes (see `audio/effects/`), so
 * live preview, the offline bake and the exporter run ONE graph builder. There
 * is no second implementation of "what does this effect do" to drift.
 */

const audioEffectBase = {
  id: z.string(),
  enabled: z.boolean().default(true),
};

/**
 * An LFO's shape — the four an `OscillatorNode` plays natively, so a card's
 * drawn modulation and its sound are the same wave (core `lfoValue`).
 */
export const lfoShapeSchema = z.enum(["sine", "triangle", "square", "sawtooth"]);
export type LfoShape = z.infer<typeof lfoShapeSchema>;

/**
 * The LFO a card carries to move its main control on its own — rate, depth in
 * OCTAVES (a sweep is musical in octaves, not hertz), and shape. Rate 0 or
 * depth 0 is "no LFO": still, and swept only by keys.
 */
function lfoFields(defaults: { rateHz: number; depth: number }) {
  return {
    lfoRateHz: z.number().min(0).max(20).default(defaults.rateHz),
    lfoDepth: z.number().min(0).max(6).default(defaults.depth),
    lfoShape: lfoShapeSchema.default("sine"),
  };
}

/** The filter shape of one parametric EQ band (RBJ biquad family). */
export const eqBandTypeSchema = z.enum([
  "lowshelf",
  "peaking",
  "highshelf",
  "lowpass",
  "highpass",
  "notch",
]);
export type EqBandType = z.infer<typeof eqBandTypeSchema>;

/**
 * ONE parametric EQ band — a single RBJ biquad. `gainDb` shapes shelves/peaks
 * (ignored by the pass/notch types, which cut by frequency + Q).
 *
 * Bands are a LIST inside the effect, addressed by id, so a curve with any
 * number of bands keyframes at `afx.<effectId>.band.<bandId>.<gain|freq|q>`
 * with no growth in the property registry — the same per-id convention fills,
 * strokes and gradient stops already use.
 */
export const audioEqBandSchema = z.object({
  id: z.string(),
  type: eqBandTypeSchema.default("peaking"),
  freqHz: z.number().min(20).max(20000).default(1000),
  gainDb: z.number().min(-24).max(24).default(0),
  q: z.number().min(0.05).max(18).default(0.707),
  enabled: z.boolean().default(true),
});
export type AudioEqBand = z.infer<typeof audioEqBandSchema>;

export const audioEffectSchema = z.discriminatedUnion("type", [
  /**
   * Parametric EQ — an unbounded list of biquads. The only audio effect whose
   * substance is a LIST rather than a fixed field set, which is why it keeps a
   * bespoke editor (the draggable response curve) instead of generated rows.
   */
  z.object({
    ...audioEffectBase,
    type: z.literal("eq"),
    bands: z.array(audioEqBandSchema).default([]),
  }),

  /**
   * Reverb — a convolution built from a room you can SEE.
   *
   * The dimensions are not decoration: width/height/length drive the generated
   * impulse response (early-reflection pattern and modal density), `decaySec`
   * sets the tail, `damping` rolls the top off as it decays, `diffusion` smears
   * the reflections. That is what lets the 3D room editor be honest — dragging
   * a wall genuinely re-renders the IR rather than nudging a cosmetic number.
   *
   * Room SIZE is deliberately absent: it is the volume of the three dimensions,
   * so storing it too would be a second fact about one thing, free to disagree.
   */
  z.object({
    ...audioEffectBase,
    type: z.literal("reverb"),
    widthM: z.number().min(1).max(60).default(12),
    heightM: z.number().min(1).max(30).default(4),
    lengthM: z.number().min(1).max(60).default(20),
    /** Silence before the tail starts — distance to the first wall. */
    preDelayMs: z.number().min(0).max(500).default(20),
    /** RT60: seconds for the tail to fall 60 dB. */
    decaySec: z.number().min(0.1).max(20).default(1.8),
    /** 0 = discrete slapback reflections, 1 = a smooth wash. */
    diffusion: z.number().min(0).max(1).default(0.7),
    /** High-frequency absorption over the tail — soft furnishings vs tile. */
    damping: z.number().min(0).max(1).default(0.4),
    /** Tail pitch wobble; keeps long decays from ringing metallically. */
    modulation: z.number().min(0).max(1).default(0.2),
    /** How far the source sits from the listener — trades direct for tail. */
    distance: z.number().min(0).max(1).default(0.35),
    /** Level of the early reflections (the room's shape). */
    erLevel: z.number().min(0).max(2).default(1),
    /** Level of the diffuse tail (the room's size). */
    tailLevel: z.number().min(0).max(2).default(1),
    lowCutHz: z.number().min(20).max(2000).default(120),
    highCutHz: z.number().min(1000).max(20000).default(9000),
    /** Dry/wet blend. 0 = bypassed, 1 = the reverb alone. */
    mix: z.number().min(0).max(1).default(0.3),
  }),

  /**
   * Echo — DISCRETE repeats, which is why it is not a reverb preset. A reverb
   * answers "what room is this in"; an echo answers "how many times do I hear
   * it again". They are different instruments and share no controls but mix.
   */
  z.object({
    ...audioEffectBase,
    type: z.literal("echo"),
    timeMs: z.number().min(10).max(4000).default(320),
    /** How much of each repeat feeds the next. 0.95+ approaches self-oscillation. */
    feedback: z.number().min(0).max(0.95).default(0.35),
    /** Low-pass inside the feedback loop — repeats darken as they fade, like tape. */
    toneHz: z.number().min(200).max(20000).default(6000),
    /** Repeats alternate left/right. The classic widening trick. */
    pingPong: z.boolean().default(false),
    mix: z.number().min(0).max(1).default(0.25),
  }),

  /**
   * Compressor — and the app's answer to "keep this within a volume".
   *
   * A limiter is this with a high ratio and a fast attack, and a leveler is
   * this with a low ratio and a slow one, so both ship as PRESETS rather than
   * as separate cards that would duplicate every control. True loudness
   * normalisation is an offline analysis of the whole clip, not a real-time
   * node, and is deliberately not modelled here as if it were one.
   */
  z.object({
    ...audioEffectBase,
    type: z.literal("compressor"),
    thresholdDb: z.number().min(-60).max(0).default(-24),
    ratio: z.number().min(1).max(20).default(4),
    attackMs: z.number().min(0).max(1000).default(10),
    releaseMs: z.number().min(1).max(2000).default(180),
    /** Softness of the bend into compression, in dB. */
    kneeDb: z.number().min(0).max(40).default(24),
    /** Gain back after the squeeze. */
    makeupDb: z.number().min(-24).max(24).default(0),
    /** Parallel compression: blend the squashed signal under the untouched one. */
    mix: z.number().min(0).max(1).default(1),
  }),

  /**
   * Saturator — analogue warmth. A waveshaper curve plus a tone tilt; the
   * `character` field picks the curve, which is the one thing that makes a
   * tape, a tube and a fuzz sound like different devices rather than like the
   * same device at three drive settings.
   */
  z.object({
    ...audioEffectBase,
    type: z.literal("saturator"),
    driveDb: z.number().min(0).max(36).default(8),
    character: z.enum(["tape", "tube", "diode", "hard"]).default("tape"),
    toneHz: z.number().min(200).max(20000).default(12000),
    outputDb: z.number().min(-24).max(12).default(0),
    mix: z.number().min(0).max(1).default(1),
  }),

  /**
   * Filter — one resonant filter you can sweep, by hand (keys) or by its own
   * LFO. The EQ shapes tone; this is the instrument: a wah, a wobble, a voice
   * through a wall, a build that opens up into the drop.
   */
  z.object({
    ...audioEffectBase,
    type: z.literal("filter"),
    mode: z.enum(["lowpass", "highpass", "bandpass", "notch"]).default("lowpass"),
    cutoffHz: z.number().min(20).max(20000).default(1200),
    resonance: z.number().min(0.1).max(24).default(1),
    ...lfoFields({ rateHz: 0, depth: 0 }),
    mix: z.number().min(0).max(1).default(1),
  }),

  /**
   * Chorus — a copy of the sound on a short delay that drifts. A few
   * milliseconds with feedback is a FLANGER, a deep drift with no dry is
   * VIBRATO: the same machine at different settings, so they are presets of
   * this card rather than three cards with one set of controls between them.
   */
  z.object({
    ...audioEffectBase,
    type: z.literal("chorus"),
    delayMs: z.number().min(0.5).max(60).default(18),
    depthMs: z.number().min(0).max(20).default(4),
    rateHz: z.number().min(0.01).max(12).default(0.8),
    shape: lfoShapeSchema.default("sine"),
    feedback: z.number().min(0).max(0.95).default(0.15),
    /** 0 = both sides drift together, 1 = in opposition — the width. */
    spread: z.number().min(0).max(1).default(0.8),
    mix: z.number().min(0).max(1).default(0.5),
  }),

  /** Phaser — notches swept through the spectrum by a chain of all-pass stages. */
  z.object({
    ...audioEffectBase,
    type: z.literal("phaser"),
    /** Stage count is the colour: more stages, more notches. */
    stages: z.enum(["4", "6", "8", "12"]).default("6"),
    centerHz: z.number().min(60).max(8000).default(900),
    ...lfoFields({ rateHz: 0.4, depth: 2 }),
    feedback: z.number().min(0).max(0.9).default(0.4),
    mix: z.number().min(0).max(1).default(0.5),
  }),

  /** Tremolo — the level (or the position) swung by an LFO: tremolo, auto-pan, helicopter. */
  z.object({
    ...audioEffectBase,
    type: z.literal("tremolo"),
    target: z.enum(["volume", "pan"]).default("volume"),
    rateHz: z.number().min(0.05).max(40).default(5),
    depth: z.number().min(0).max(1).default(0.6),
    shape: lfoShapeSchema.default("sine"),
  }),

  /**
   * Ring mod — the sound multiplied by a tone. Low and sine it is the robot
   * voice everyone means; higher it turns metallic, then alien.
   */
  z.object({
    ...audioEffectBase,
    type: z.literal("ringMod"),
    frequencyHz: z.number().min(1).max(4000).default(40),
    shape: lfoShapeSchema.default("sine"),
    mix: z.number().min(0).max(1).default(1),
  }),

  /** Bitcrush — fewer levels and a narrower band: games, old radios, broken speakers. */
  z.object({
    ...audioEffectBase,
    type: z.literal("bitcrush"),
    bits: z.number().min(1).max(16).default(6),
    /** The band left after the crush — where a lower sample rate would cut. */
    toneHz: z.number().min(200).max(20000).default(5000),
    driveDb: z.number().min(0).max(24).default(0),
    mix: z.number().min(0).max(1).default(1),
  }),

  /** Stereo — width (mono to extra-wide) and where it sits left to right. */
  z.object({
    ...audioEffectBase,
    type: z.literal("stereo"),
    /** 0 = mono, 1 = as recorded, 2 = twice as wide. */
    width: z.number().min(0).max(2).default(1),
    pan: z.number().min(-1).max(1).default(0),
  }),
]);

export type AudioEffect = z.infer<typeof audioEffectSchema>;
export type AudioEffectType = AudioEffect["type"];
