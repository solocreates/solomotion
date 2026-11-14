import { createEffectRegistry, type EffectTypeDefBase } from "../../animation/effect-base";
import { createId } from "../../ids";
import { defaultEqBands, EQ_PRESETS } from "../eq";
import type { AudioEffect, AudioEffectType, AudioEqBand } from "../../schema/audio-effects";

/**
 * THE AUDIO EFFECT REGISTRY — the sound domain's entry in the shared effect
 * model. It declares the kinds and their field metadata, and gets everything
 * else from `createEffectRegistry`: keyframe paths (`afx.<id>.<field>`),
 * factory defaults, palette filtering, the stack summary badge, and with them
 * the floating editor, presets, property transfer, modulators, drivers, record
 * mode and the node card. Adding an effect is a schema arm, an entry here and
 * one builder in the web chain (`BUILDERS`, exhaustive over the type, so a
 * kind without a sound fails the build) — no UI, no node code.
 *
 * The field metadata is doing real work. `group` splits a twenty-control reverb
 * into the sections a mixing engineer expects; `unit` and `hint` mean the
 * generated rows read like a designed panel; `min`/`max` bound the knob arc.
 * A card nobody hand-wrote still looks hand-made, which is the whole return on
 * the registry.
 */

/** A named starting point for one effect kind, shown in the card's preset row. */
export interface AudioEffectPreset {
  id: string;
  label: string;
  /** One line — what it is FOR, not what it sets. */
  hint: string;
  /** Field values to write over the instance's base (never touches keyframes). */
  patch: Record<string, unknown>;
}

/**
 * The audio domain's def. Adds `presets` on top of the shared base — domain
 * metadata, exactly as the layer registry adds `timeDriven`.
 */
export interface AudioEffectTypeDef extends EffectTypeDefBase<AudioEffect> {
  presets?: readonly AudioEffectPreset[];
}

const pct = { min: 0, max: 1, step: 0.01, unit: "%" } as const;

/** The four LFO shapes, as a select's options — the oscillator's own. */
const lfoShapeOptions = [
  { value: "sine", label: "Sine", hint: "Smooth" },
  { value: "triangle", label: "Triangle", hint: "Even, linear sweep" },
  { value: "square", label: "Square", hint: "Jumps between two" },
  { value: "sawtooth", label: "Saw", hint: "Rises, then snaps back" },
];

/** A card's own LFO rows, in its Movement group. `what` names what it moves. */
function lfoRows(what: string) {
  return [
    { key: "lfoRateHz", label: "Rate", kind: "number", min: 0, max: 20, step: 0.01, unit: "Hz", group: "lfo", hint: `How fast the ${what.toLowerCase()} moves on its own. 0 holds it still.` },
    { key: "lfoDepth", label: "Depth", kind: "number", min: 0, max: 6, step: 0.05, unit: "oct", group: "lfo", hint: "How far it swings, in octaves either way." },
    { key: "lfoShape", label: "Shape", kind: "select", options: lfoShapeOptions, group: "lfo" },
  ] as const;
}

export const AUDIO_EFFECT_TYPES: AudioEffectTypeDef[] = [
  // ── EQ ─────────────────────────────────────────────────────────────────────
  {
    type: "eq",
    label: "Equalizer",
    // Three decades of frequency have to be legible at once or the curve is a
    // decoration. This is the widest card in the app for that reason alone.
    // A HEIGHT, not just a width. The sound cards lay their picture and their
    // knobs out as two full-height columns that scroll independently, and a
    // column can only be "the height of the window" if the window has one — an
    // `auto` height would collapse the layout it is supposed to size.
    editor: { width: 780, height: 520 },
    blurb: "Shape the tone — cut rumble, lift presence, tame harshness.",
    category: "eq",
    tags: ["filter", "tone", "bass", "treble", "highpass", "lowpass"],
    // Bands are a LIST, not fixed fields, so this card has no generated rows —
    // it renders the draggable response curve instead. The per-band values are
    // still fully keyframable, at `afx.<id>.band.<bandId>.<gain|freq|q>`.
    fields: [],
    presets: EQ_PRESETS.map((p) => ({
      id: p.id,
      label: p.label,
      hint: p.hint,
      patch: { bands: p.bands() },
    })),
    create: () => ({ id: createId("afx"), type: "eq", enabled: true, bands: defaultEqBands() }),
  },

  // ── Reverb ─────────────────────────────────────────────────────────────────
  {
    type: "reverb",
    label: "Reverb",
    // A room you drag, beside four groups of knobs.
    editor: { width: 760, height: 560 },
    blurb: "Put the sound in a room you can see and resize.",
    category: "space",
    tags: ["room", "hall", "space", "ambience", "convolution", "plate"],
    groups: [
      { id: "room", label: "Room" },
      { id: "tail", label: "Decay" },
      { id: "tone", label: "Tone", collapsed: true },
      { id: "levels", label: "Levels", collapsed: true },
    ],
    fields: [
      { key: "mix", label: "Dry / wet", kind: "number", ...pct, hint: "How much of the room you hear against the untouched sound." },

      { key: "widthM", label: "Width", kind: "number", min: 1, max: 60, step: 0.1, unit: "m", group: "room" },
      { key: "heightM", label: "Height", kind: "number", min: 1, max: 30, step: 0.1, unit: "m", group: "room" },
      { key: "lengthM", label: "Length", kind: "number", min: 1, max: 60, step: 0.1, unit: "m", group: "room" },
      { key: "distance", label: "Distance", kind: "number", ...pct, group: "room", hint: "How far the source stands from you — trades direct sound for room." },

      { key: "preDelayMs", label: "Pre-delay", kind: "number", min: 0, max: 500, step: 1, unit: "ms", group: "tail", hint: "Silence before the tail starts. A little keeps speech intelligible." },
      { key: "decaySec", label: "Decay", kind: "number", min: 0.1, max: 20, step: 0.05, unit: "s", group: "tail", hint: "Seconds for the tail to fall 60 dB." },
      { key: "diffusion", label: "Diffusion", kind: "number", ...pct, group: "tail", hint: "Discrete slapback at 0, a smooth wash at 100." },
      { key: "damping", label: "Damping", kind: "number", ...pct, group: "tail", hint: "How fast the top end is absorbed — carpet against tile." },
      { key: "modulation", label: "Modulation", kind: "number", ...pct, group: "tail", hint: "Detunes the tail so long decays never ring metallically." },

      { key: "lowCutHz", label: "Low cut", kind: "number", min: 20, max: 2000, step: 1, unit: "Hz", group: "tone" },
      { key: "highCutHz", label: "High cut", kind: "number", min: 1000, max: 20000, step: 10, unit: "Hz", group: "tone" },

      { key: "erLevel", label: "Reflections", kind: "number", min: 0, max: 2, step: 0.01, group: "levels", hint: "The room's SHAPE — the first bounce off each wall." },
      { key: "tailLevel", label: "Tail", kind: "number", min: 0, max: 2, step: 0.01, group: "levels", hint: "The room's SIZE — the diffuse wash after the reflections." },
    ],
    presets: [
      { id: "room", label: "Small room", hint: "Tight and close", patch: { widthM: 5, heightM: 2.7, lengthM: 6, decaySec: 0.5, preDelayMs: 8, diffusion: 0.6, damping: 0.5, mix: 0.2 } },
      { id: "studio", label: "Studio", hint: "Controlled, neutral", patch: { widthM: 8, heightM: 3.4, lengthM: 10, decaySec: 0.9, preDelayMs: 14, diffusion: 0.7, damping: 0.45, mix: 0.22 } },
      { id: "hall", label: "Concert hall", hint: "Wide and long", patch: { widthM: 26, heightM: 14, lengthM: 40, decaySec: 2.6, preDelayMs: 32, diffusion: 0.85, damping: 0.3, mix: 0.34 } },
      { id: "cathedral", label: "Cathedral", hint: "Enormous, slow", patch: { widthM: 34, heightM: 26, lengthM: 58, decaySec: 6.5, preDelayMs: 48, diffusion: 0.95, damping: 0.2, mix: 0.42 } },
      { id: "plate", label: "Plate", hint: "Dense, bright vocal sheen", patch: { widthM: 4, heightM: 2, lengthM: 4, decaySec: 1.9, preDelayMs: 6, diffusion: 1, damping: 0.15, modulation: 0.35, mix: 0.3 } },
      { id: "chamber", label: "Chamber", hint: "Warm and woody", patch: { widthM: 10, heightM: 4.5, lengthM: 12, decaySec: 1.4, preDelayMs: 20, diffusion: 0.75, damping: 0.55, mix: 0.28 } },
      { id: "ambience", label: "Ambience", hint: "Barely there, just glue", patch: { widthM: 6, heightM: 3, lengthM: 7, decaySec: 0.35, preDelayMs: 4, diffusion: 0.5, damping: 0.6, mix: 0.12 } },
    ],
    create: () => ({
      id: createId("afx"), type: "reverb", enabled: true,
      widthM: 12, heightM: 4, lengthM: 20,
      preDelayMs: 20, decaySec: 1.8, diffusion: 0.7, damping: 0.4, modulation: 0.2,
      distance: 0.35, erLevel: 1, tailLevel: 1,
      lowCutHz: 120, highCutHz: 9000, mix: 0.3,
    }),
  },

  // ── Echo ───────────────────────────────────────────────────────────────────
  {
    type: "echo",
    label: "Echo",
    // The taps diagram plus six knobs — wide enough for both, no wider.
    editor: { width: 620, height: 400 },
    blurb: "Distinct repeats that fade — slapback, tape, ping-pong.",
    category: "space",
    tags: ["delay", "slapback", "tape", "repeat", "ping pong"],
    fields: [
      { key: "mix", label: "Dry / wet", kind: "number", ...pct },
      { key: "timeMs", label: "Time", kind: "number", min: 10, max: 4000, step: 1, unit: "ms", hint: "Gap between repeats." },
      { key: "feedback", label: "Feedback", kind: "number", min: 0, max: 0.95, step: 0.01, unit: "%", hint: "How much of each repeat feeds the next. Near 95% it almost never stops." },
      { key: "toneHz", label: "Tone", kind: "number", min: 200, max: 20000, step: 10, unit: "Hz", hint: "Repeats darken as they fade, the way tape does." },
    ],
    toggles: [
      { key: "pingPong", label: "Ping-pong", hint: "Repeats alternate left and right." },
    ],
    presets: [
      { id: "slapback", label: "Slapback", hint: "One tight rockabilly bounce", patch: { timeMs: 110, feedback: 0.12, toneHz: 7000, pingPong: false, mix: 0.28 } },
      { id: "tape", label: "Tape echo", hint: "Warm, darkening repeats", patch: { timeMs: 380, feedback: 0.42, toneHz: 3800, pingPong: false, mix: 0.3 } },
      { id: "pingpong", label: "Ping-pong", hint: "Bounces across the image", patch: { timeMs: 300, feedback: 0.45, toneHz: 8000, pingPong: true, mix: 0.32 } },
      { id: "ambient", label: "Ambient wash", hint: "Long, nearly endless", patch: { timeMs: 700, feedback: 0.75, toneHz: 4200, pingPong: true, mix: 0.4 } },
      { id: "doubler", label: "Doubler", hint: "Thickens a single take", patch: { timeMs: 42, feedback: 0, toneHz: 12000, pingPong: false, mix: 0.4 } },
    ],
    create: () => ({
      id: createId("afx"), type: "echo", enabled: true,
      timeMs: 320, feedback: 0.35, toneHz: 6000, pingPong: false, mix: 0.25,
    }),
  },

  // ── Compressor ─────────────────────────────────────────────────────────────
  {
    type: "compressor",
    label: "Compressor",
    editor: { width: 640, height: 430 },
    blurb: "Hold the level steady — and the limiter that stops peaks dead.",
    category: "dynamics",
    tags: ["limiter", "leveler", "normalize", "dynamics", "loudness", "ducking"],
    groups: [{ id: "timing", label: "Timing" }, { id: "output", label: "Output" }],
    fields: [
      { key: "thresholdDb", label: "Threshold", kind: "number", min: -60, max: 0, step: 0.5, unit: "dB", hint: "Level above which the sound starts being held back." },
      { key: "ratio", label: "Ratio", kind: "number", min: 1, max: 20, step: 0.1, unit: "×", hint: "How hard. 2–4 evens things out; 12+ is a limiter." },
      { key: "attackMs", label: "Attack", kind: "number", min: 0, max: 1000, step: 0.1, unit: "ms", group: "timing", hint: "How fast it clamps down. Fast kills transients." },
      { key: "releaseMs", label: "Release", kind: "number", min: 1, max: 2000, step: 1, unit: "ms", group: "timing", hint: "How fast it lets go. Too fast breathes." },
      { key: "kneeDb", label: "Knee", kind: "number", min: 0, max: 40, step: 0.5, unit: "dB", group: "timing", hint: "Soft bends gradually into compression; hard snaps." },
      { key: "makeupDb", label: "Makeup", kind: "number", min: -24, max: 24, step: 0.5, unit: "dB", bipolar: true, group: "output", hint: "Gain back what the squeeze took." },
      { key: "mix", label: "Dry / wet", kind: "number", ...pct, group: "output", hint: "Blend the untouched sound back in — parallel compression." },
    ],
    presets: [
      { id: "limiter", label: "Limiter", hint: "Nothing gets past the ceiling", patch: { thresholdDb: -3, ratio: 20, attackMs: 0.5, releaseMs: 60, kneeDb: 0, makeupDb: 0, mix: 1 } },
      { id: "leveler", label: "Voice leveler", hint: "Even, broadcast-steady speech", patch: { thresholdDb: -22, ratio: 3, attackMs: 12, releaseMs: 220, kneeDb: 20, makeupDb: 4, mix: 1 } },
      { id: "glue", label: "Glue", hint: "Pulls a mix together gently", patch: { thresholdDb: -18, ratio: 2, attackMs: 30, releaseMs: 300, kneeDb: 24, makeupDb: 2, mix: 1 } },
      { id: "punch", label: "Punch", hint: "Lets transients through, holds the rest", patch: { thresholdDb: -20, ratio: 4, attackMs: 35, releaseMs: 120, kneeDb: 8, makeupDb: 3, mix: 1 } },
      { id: "parallel", label: "Parallel squash", hint: "Density without losing life", patch: { thresholdDb: -34, ratio: 12, attackMs: 1, releaseMs: 90, kneeDb: 6, makeupDb: 6, mix: 0.45 } },
    ],
    create: () => ({
      id: createId("afx"), type: "compressor", enabled: true,
      thresholdDb: -24, ratio: 4, attackMs: 10, releaseMs: 180,
      kneeDb: 24, makeupDb: 0, mix: 1,
    }),
  },

  // ── Saturator ──────────────────────────────────────────────────────────────
  {
    type: "saturator",
    label: "Saturator",
    editor: { width: 600, height: 430 },
    blurb: "Analogue warmth and drive — tape, tube, or outright fuzz.",
    category: "character",
    tags: ["distortion", "drive", "warmth", "tape", "tube", "overdrive", "fuzz"],
    fields: [
      { key: "driveDb", label: "Drive", kind: "number", min: 0, max: 36, step: 0.5, unit: "dB", hint: "How hard the signal is pushed into the curve." },
      {
        key: "character", label: "Character", kind: "select",
        options: [
          { value: "tape", label: "Tape", hint: "Soft, rounded compression" },
          { value: "tube", label: "Tube", hint: "Warm even harmonics" },
          { value: "diode", label: "Diode", hint: "Gritty asymmetric bite" },
          { value: "hard", label: "Hard clip", hint: "Blunt digital edge" },
        ],
        hint: "The curve — what makes these sound like different devices, not one device louder.",
      },
      { key: "toneHz", label: "Tone", kind: "number", min: 200, max: 20000, step: 10, unit: "Hz", hint: "Rolls off the fizz the drive adds up top." },
      { key: "outputDb", label: "Output", kind: "number", min: -24, max: 12, step: 0.5, unit: "dB", bipolar: true },
      { key: "mix", label: "Dry / wet", kind: "number", ...pct },
    ],
    presets: [
      { id: "warm", label: "Warm", hint: "Barely there, just thicker", patch: { driveDb: 5, character: "tape", toneHz: 13000, outputDb: -1, mix: 0.6 } },
      { id: "tape", label: "Tape", hint: "Glued and rounded", patch: { driveDb: 11, character: "tape", toneHz: 10000, outputDb: -2, mix: 1 } },
      { id: "tube", label: "Tube drive", hint: "Rich and singing", patch: { driveDb: 16, character: "tube", toneHz: 9000, outputDb: -3, mix: 1 } },
      { id: "grit", label: "Grit", hint: "Broken speaker character", patch: { driveDb: 24, character: "diode", toneHz: 5200, outputDb: -5, mix: 0.85 } },
      { id: "destroy", label: "Destroy", hint: "Fully crushed", patch: { driveDb: 34, character: "hard", toneHz: 4000, outputDb: -7, mix: 1 } },
    ],
    create: () => ({
      id: createId("afx"), type: "saturator", enabled: true,
      driveDb: 8, character: "tape", toneHz: 12000, outputDb: 0, mix: 1,
    }),
  },

  // ── Filter ─────────────────────────────────────────────────────────────────
  {
    type: "filter",
    label: "Filter",
    editor: { width: 620, height: 470 },
    blurb: "One resonant filter to sweep — wah, wobble, through a wall, opening into the drop.",
    category: "eq",
    tags: ["lowpass", "highpass", "bandpass", "wah", "wobble", "sweep", "muffle", "telephone", "resonance", "cutoff"],
    groups: [{ id: "lfo", label: "Movement" }],
    fields: [
      { key: "mode", label: "Type", kind: "select", options: [
        { value: "lowpass", label: "Low-pass", hint: "Keeps the lows — muffled, far away" },
        { value: "highpass", label: "High-pass", hint: "Keeps the highs — thin, small" },
        { value: "bandpass", label: "Band-pass", hint: "Keeps one band — radio, phone, wah" },
        { value: "notch", label: "Notch", hint: "Cuts one band out" },
      ] },
      { key: "cutoffHz", label: "Cutoff", kind: "number", min: 20, max: 20000, step: 1, unit: "Hz", hint: "Where it cuts. Key it to sweep." },
      { key: "resonance", label: "Resonance", kind: "number", min: 0.1, max: 24, step: 0.1, hint: "A peak at the cutoff. High values whistle." },
      ...lfoRows("Cutoff"),
      { key: "mix", label: "Dry / wet", kind: "number", ...pct },
    ],
    presets: [
      { id: "muffled", label: "Next room", hint: "Through a wall", patch: { mode: "lowpass", cutoffHz: 650, resonance: 0.8, lfoDepth: 0, mix: 1 } },
      { id: "underwater", label: "Underwater", hint: "Dull and swaying", patch: { mode: "lowpass", cutoffHz: 380, resonance: 3, lfoRateHz: 0.35, lfoDepth: 0.6, lfoShape: "sine", mix: 1 } },
      { id: "telephone", label: "Telephone", hint: "Small and boxy", patch: { mode: "bandpass", cutoffHz: 1700, resonance: 0.9, lfoDepth: 0, mix: 1 } },
      { id: "wah", label: "Auto-wah", hint: "Vocal, quacking sweep", patch: { mode: "bandpass", cutoffHz: 900, resonance: 6, lfoRateHz: 2, lfoDepth: 1.6, lfoShape: "triangle", mix: 1 } },
      { id: "wobble", label: "Wobble", hint: "Bass-music throb", patch: { mode: "lowpass", cutoffHz: 260, resonance: 9, lfoRateHz: 4, lfoDepth: 3, lfoShape: "sine", mix: 1 } },
      { id: "thin", label: "Thin", hint: "No body, all edge", patch: { mode: "highpass", cutoffHz: 1500, resonance: 0.7, lfoDepth: 0, mix: 1 } },
    ],
    create: () => ({
      id: createId("afx"), type: "filter", enabled: true,
      mode: "lowpass", cutoffHz: 1200, resonance: 1, lfoRateHz: 0, lfoDepth: 0, lfoShape: "sine", mix: 1,
    }),
  },

  // ── Chorus ─────────────────────────────────────────────────────────────────
  {
    type: "chorus",
    label: "Chorus",
    editor: { width: 620, height: 470 },
    blurb: "A drifting copy — chorus, flanger, vibrato, a wider double.",
    category: "modulation",
    tags: ["flanger", "vibrato", "ensemble", "doubler", "wide", "modulation", "jet"],
    fields: [
      { key: "mix", label: "Dry / wet", kind: "number", ...pct },
      { key: "delayMs", label: "Delay", kind: "number", min: 0.5, max: 60, step: 0.1, unit: "ms", hint: "Short (1–5) flanges, longer (15–30) choruses." },
      { key: "depthMs", label: "Depth", kind: "number", min: 0, max: 20, step: 0.1, unit: "ms", hint: "How far the copy drifts." },
      { key: "rateHz", label: "Rate", kind: "number", min: 0.01, max: 12, step: 0.01, unit: "Hz" },
      { key: "shape", label: "Shape", kind: "select", options: lfoShapeOptions },
      { key: "feedback", label: "Feedback", kind: "number", min: 0, max: 0.95, step: 0.01, unit: "%", hint: "Feeds the copy back in — the flanger's jet." },
      { key: "spread", label: "Width", kind: "number", ...pct, hint: "The two sides drift apart, so it spreads across the image." },
    ],
    presets: [
      { id: "chorus", label: "Chorus", hint: "Lush and shimmering", patch: { delayMs: 18, depthMs: 4, rateHz: 0.8, shape: "sine", feedback: 0.15, spread: 0.8, mix: 0.5 } },
      { id: "ensemble", label: "Ensemble", hint: "A choir from one voice", patch: { delayMs: 26, depthMs: 7, rateHz: 0.35, shape: "triangle", feedback: 0.05, spread: 1, mix: 0.55 } },
      { id: "flanger", label: "Flanger", hint: "Sweeping comb", patch: { delayMs: 2.5, depthMs: 2, rateHz: 0.25, shape: "triangle", feedback: 0.6, spread: 0.5, mix: 0.5 } },
      { id: "jet", label: "Jet", hint: "A plane overhead", patch: { delayMs: 1.2, depthMs: 1, rateHz: 0.12, shape: "sine", feedback: 0.85, spread: 0.3, mix: 0.55 } },
      { id: "vibrato", label: "Vibrato", hint: "Pitch wavers, no dry", patch: { delayMs: 6, depthMs: 3, rateHz: 5.5, shape: "sine", feedback: 0, spread: 0, mix: 1 } },
      { id: "wide", label: "Wide double", hint: "Bigger without moving", patch: { delayMs: 22, depthMs: 0.6, rateHz: 0.2, shape: "sine", feedback: 0, spread: 1, mix: 0.45 } },
    ],
    create: () => ({
      id: createId("afx"), type: "chorus", enabled: true,
      delayMs: 18, depthMs: 4, rateHz: 0.8, shape: "sine", feedback: 0.15, spread: 0.8, mix: 0.5,
    }),
  },

  // ── Phaser ─────────────────────────────────────────────────────────────────
  {
    type: "phaser",
    label: "Phaser",
    editor: { width: 620, height: 470 },
    blurb: "Notches swirling through the sound — space-age, liquid.",
    category: "modulation",
    tags: ["phase", "swirl", "sweep", "modulation", "liquid"],
    groups: [{ id: "lfo", label: "Movement" }],
    fields: [
      { key: "mix", label: "Dry / wet", kind: "number", ...pct },
      { key: "stages", label: "Stages", kind: "select", options: [
        { value: "4", label: "4", hint: "Gentle, two notches" },
        { value: "6", label: "6", hint: "Classic" },
        { value: "8", label: "8", hint: "Deeper" },
        { value: "12", label: "12", hint: "Dense, liquid" },
      ] },
      { key: "centerHz", label: "Centre", kind: "number", min: 60, max: 8000, step: 1, unit: "Hz", hint: "Where the notches sit at rest." },
      { key: "feedback", label: "Feedback", kind: "number", min: 0, max: 0.9, step: 0.01, unit: "%", hint: "Sharper, more vocal notches." },
      ...lfoRows("Notches"),
    ],
    presets: [
      { id: "classic", label: "Classic", hint: "Slow swirl", patch: { stages: "6", centerHz: 900, feedback: 0.4, lfoRateHz: 0.4, lfoDepth: 2, lfoShape: "sine", mix: 0.5 } },
      { id: "liquid", label: "Liquid", hint: "Deep and wet", patch: { stages: "12", centerHz: 700, feedback: 0.7, lfoRateHz: 0.2, lfoDepth: 3, lfoShape: "triangle", mix: 0.6 } },
      { id: "fast", label: "Fast", hint: "Rotary-speaker spin", patch: { stages: "4", centerHz: 1200, feedback: 0.3, lfoRateHz: 5, lfoDepth: 1.2, lfoShape: "sine", mix: 0.5 } },
    ],
    create: () => ({
      id: createId("afx"), type: "phaser", enabled: true,
      stages: "6", centerHz: 900, lfoRateHz: 0.4, lfoDepth: 2, lfoShape: "sine", feedback: 0.4, mix: 0.5,
    }),
  },

  // ── Tremolo ────────────────────────────────────────────────────────────────
  {
    type: "tremolo",
    label: "Tremolo",
    editor: { width: 600, height: 430 },
    blurb: "The level or the position swung by a rhythm — tremolo, auto-pan, helicopter.",
    category: "modulation",
    tags: ["autopan", "pan", "pulse", "helicopter", "gate", "rhythm", "volume"],
    fields: [
      { key: "target", label: "Moves", kind: "select", options: [
        { value: "volume", label: "Volume", hint: "Tremolo — the level pulses" },
        { value: "pan", label: "Pan", hint: "Auto-pan — it swings left and right" },
      ] },
      { key: "rateHz", label: "Rate", kind: "number", min: 0.05, max: 40, step: 0.01, unit: "Hz" },
      { key: "depth", label: "Depth", kind: "number", ...pct },
      { key: "shape", label: "Shape", kind: "select", options: lfoShapeOptions },
    ],
    presets: [
      { id: "tremolo", label: "Tremolo", hint: "Vintage amp pulse", patch: { target: "volume", rateHz: 5, depth: 0.6, shape: "sine" } },
      { id: "chop", label: "Chop", hint: "Hard on-off gate", patch: { target: "volume", rateHz: 8, depth: 1, shape: "square" } },
      { id: "autopan", label: "Auto-pan", hint: "Slow side to side", patch: { target: "pan", rateHz: 0.5, depth: 0.8, shape: "sine" } },
      { id: "helicopter", label: "Helicopter", hint: "Rotor thump", patch: { target: "volume", rateHz: 14, depth: 0.85, shape: "sawtooth" } },
    ],
    create: () => ({
      id: createId("afx"), type: "tremolo", enabled: true,
      target: "volume", rateHz: 5, depth: 0.6, shape: "sine",
    }),
  },

  // ── Ring mod ───────────────────────────────────────────────────────────────
  {
    type: "ringMod",
    label: "Ring mod",
    editor: { width: 600, height: 400 },
    blurb: "The sound times a tone — robots, metal, aliens.",
    category: "character",
    tags: ["robot", "dalek", "metallic", "alien", "sci-fi", "voice"],
    fields: [
      { key: "mix", label: "Dry / wet", kind: "number", ...pct },
      { key: "frequencyHz", label: "Frequency", kind: "number", min: 1, max: 4000, step: 1, unit: "Hz", hint: "Low is a robot, high is metal." },
      { key: "shape", label: "Shape", kind: "select", options: lfoShapeOptions },
    ],
    presets: [
      { id: "robot", label: "Robot", hint: "The classic sci-fi voice", patch: { frequencyHz: 30, shape: "sine", mix: 1 } },
      { id: "android", label: "Android", hint: "Cleaner, still synthetic", patch: { frequencyHz: 90, shape: "sine", mix: 0.7 } },
      { id: "metal", label: "Metal", hint: "Clanging, bell-like", patch: { frequencyHz: 440, shape: "sine", mix: 1 } },
      { id: "alien", label: "Alien", hint: "Unrecognisable", patch: { frequencyHz: 1300, shape: "square", mix: 0.8 } },
    ],
    create: () => ({
      id: createId("afx"), type: "ringMod", enabled: true,
      frequencyHz: 40, shape: "sine", mix: 1,
    }),
  },

  // ── Bitcrush ───────────────────────────────────────────────────────────────
  {
    type: "bitcrush",
    label: "Bitcrush",
    editor: { width: 600, height: 430 },
    blurb: "Fewer levels, narrower band — 8-bit games, old radios, broken speakers.",
    category: "character",
    tags: ["lofi", "8-bit", "retro", "radio", "crush", "digital", "chiptune", "decimate"],
    fields: [
      { key: "mix", label: "Dry / wet", kind: "number", ...pct },
      { key: "bits", label: "Bits", kind: "number", min: 1, max: 16, step: 0.1, hint: "16 is clean. 4 and below falls apart." },
      { key: "toneHz", label: "Tone", kind: "number", min: 200, max: 20000, step: 10, unit: "Hz", hint: "The band left — where an old converter would cut." },
      { key: "driveDb", label: "Drive", kind: "number", min: 0, max: 24, step: 0.5, unit: "dB", hint: "Hits the crush harder." },
    ],
    presets: [
      { id: "8bit", label: "8-bit", hint: "Game console", patch: { bits: 5, toneHz: 7000, driveDb: 3, mix: 1 } },
      { id: "radio", label: "Old radio", hint: "Narrow, crackling", patch: { bits: 7, toneHz: 3200, driveDb: 6, mix: 1 } },
      { id: "broken", label: "Broken speaker", hint: "Torn and fizzy", patch: { bits: 3, toneHz: 4500, driveDb: 12, mix: 0.85 } },
      { id: "grit", label: "Grit", hint: "A little digital dirt", patch: { bits: 9, toneHz: 12000, driveDb: 0, mix: 0.5 } },
    ],
    create: () => ({
      id: createId("afx"), type: "bitcrush", enabled: true,
      bits: 6, toneHz: 5000, driveDb: 0, mix: 1,
    }),
  },

  // ── Stereo ─────────────────────────────────────────────────────────────────
  {
    type: "stereo",
    label: "Stereo",
    editor: { width: 560, height: 380 },
    blurb: "Width and position — mono to extra-wide, left to right.",
    category: "space",
    tags: ["width", "pan", "mono", "wide", "image", "balance"],
    fields: [
      { key: "width", label: "Width", kind: "number", min: 0, max: 2, step: 0.01, hint: "0 is mono, 1 as recorded, 2 twice as wide." },
      { key: "pan", label: "Pan", kind: "number", min: -1, max: 1, step: 0.01, bipolar: true, hint: "Left to right." },
    ],
    presets: [
      { id: "mono", label: "Mono", hint: "Centred, focused", patch: { width: 0, pan: 0 } },
      { id: "wide", label: "Wide", hint: "Fills the sides", patch: { width: 1.6, pan: 0 } },
      { id: "left", label: "Left", hint: "Off to one side", patch: { width: 0.6, pan: -0.6 } },
      { id: "right", label: "Right", hint: "Off to the other", patch: { width: 0.6, pan: 0.6 } },
    ],
    create: () => ({ id: createId("afx"), type: "stereo", enabled: true, width: 1, pan: 0 }),
  },
];

/**
 * The audio domain's registry. `afx` is the keyframe prefix, so every field of
 * every card above animates at `afx.<effectId>.<field>` with no further work.
 */
export const AFX = createEffectRegistry<AudioEffect, AudioEffectTypeDef>(
  "audio",
  "afx",
  AUDIO_EFFECT_TYPES,
);

/**
 * Apply a preset's bands to an EQ card WITHOUT orphaning its keyframes.
 *
 * A preset is a new curve, and the naive write (replace the list, drop every
 * `afx.<fx>.band.*` track) silently destroys automation the user spent time on
 * — the exact behaviour the old EQ panel had. Bands are addressed BY ID, so
 * reusing the existing ids positionally means a keyframed band-1 gain keeps
 * animating band 1 through a preset change. Extra preset bands take fresh ids;
 * bands the preset does not reach simply disappear, and only THOSE tracks are
 * left dangling (the card prunes them when a band is deleted).
 *
 * Presets set the value the keyframes move around, exactly as they do for the
 * visual stack. Applying one is never destructive.
 */
export function mergeEqPresetBands(
  existing: readonly AudioEqBand[],
  incoming: readonly AudioEqBand[],
): AudioEqBand[] {
  return incoming.map((band, i) => ({ ...band, id: existing[i]?.id ?? band.id }));
}

/** Presets declared for one effect kind (the card's preset row). */
export function audioEffectPresets(type: AudioEffectType): readonly AudioEffectPreset[] {
  return AFX.def(type)?.presets ?? [];
}
