import type { AnimationSpec, AnimationUnit, Easing } from "../schema";
import { revealFromParams, type Reveal } from "./reveal";

/** Visual state of one glyph contributed by an animation, composed additively/multiplicatively. */
export interface GlyphVisual {
  opacity: number;
  dx: number;
  dy: number;
  scale: number;
  rotation: number;
  blur: number;
}

export const GLYPH_IDENTITY: GlyphVisual = { opacity: 1, dx: 0, dy: 0, scale: 1, rotation: 0, blur: 0 };

/**
 * Browser grouping — and the order the categories appear in every picker.
 *
 * Ordered quietest to loudest, the same reading order the transition browser
 * uses, because the two rails sit in the same app and a user who learns one
 * should not have to relearn the other. A fade is what you reach for without
 * thinking; a glitch is a decision.
 *
 * The order and the labels live HERE, next to the presets they describe, and
 * not in the component that happens to draw the rail — the Animate tab and the
 * library both need them, and a second copy is a second answer to "what is this
 * family called".
 */
export type AnimationCategory =
  | "fade"
  | "slide"
  | "scale"
  | "spin"
  | "bounce"
  | "type"
  | "draw"
  | "stylize";

export const ANIMATION_CATEGORY_ORDER: AnimationCategory[] = [
  "fade",
  "slide",
  "scale",
  "spin",
  "bounce",
  "type",
  "draw",
  "stylize",
];

export const ANIMATION_CATEGORY_LABEL: Record<AnimationCategory, string> = {
  fade: "Fades",
  slide: "Slides",
  scale: "Scale",
  spin: "Spins",
  bounce: "Bounce",
  type: "Typing",
  draw: "Draw",
  stylize: "Stylised",
};

export interface PresetParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  /**
   * A CHOICE rather than a quantity: the value is an index into these. Specs
   * store numbers and nothing else, so an enumerated knob is a number with
   * names — and a control that renders from this list rather than a slider.
   */
  options?: readonly { value: number; label: string }[];
  /** Display unit for a quantity (`%` shows a 0–1 value as a percentage). */
  unit?: "%" | "px";
  /**
   * When the knob applies at all, given the other params — a stagger is a
   * property of the staggered order and of nothing else. A hidden knob keeps
   * its value; it is simply not offered.
   */
  when?: (params: Record<string, number>) => boolean;
  /** A tooltip on the label, for a knob whose effect is conditional. */
  hint?: string;
}

export interface AnimationPresetDef {
  id: string;
  label: string;
  /**
   * The family this belongs to. Required, not optional: a preset with no
   * category is one the pickers have to invent a home for, and thirty-four
   * tiles in one undifferentiated grid is the state this field exists to end.
   */
  category: AnimationCategory;
  /** Short marketing-style descriptor shown in the presets gallery. */
  tagline: string;
  /**
   * Where the preset makes sense: "text" = needs glyph units to read (a
   * typewriter on a rectangle is nonsense), "layer" = whole-layer motion
   * only, "both" = any transform-based move that works at either grain.
   * The pickers filter on this; the evaluators are grain-agnostic.
   */
  scope: "text" | "layer" | "both";
  /**
   * What the layer must HAVE for the preset to mean anything. `outline`: a
   * vector path, a shape, or a group holding them — the only layers with a
   * line to draw. Pickers hide a preset whose need the layer cannot meet.
   */
  needs?: "outline";
  defaultUnit: AnimationUnit;
  defaultDurationMs: number;
  defaultStaggerMs: number;
  /**
   * Timing humanisation a NEW spec is born with (ms of per-unit lag). Most
   * presets want 0 — a wave or a slide reads as choreography, and choreography
   * should be exact. A typewriter is the opposite: perfectly even keystrokes
   * are the one thing that makes it read as a machine, so it ships with a
   * human hand by default. Existing documents are untouched (schema default 0).
   */
  defaultJitterMs?: number;
  defaultEasing: Easing;
  params: PresetParamDef[];
  /** t is eased progress 0→1 of a unit appearing. */
  evalIn: (t: number, params: Record<string, number>) => GlyphVisual;
  /** t is eased progress 0→1 of a unit disappearing. Defaults to reversed evalIn. */
  evalOut?: (t: number, params: Record<string, number>) => GlyphVisual;
  /**
   * The REVEAL channel — how much of the layer's outline is inked at eased
   * progress t. Read by the stroke pipeline, never by the compositor; a preset
   * with one usually returns the identity pose from `evalIn`. See
   * `animation/reveal.ts`.
   */
  reveal?: (t: number, params: Record<string, number>) => Reveal;
}

/**
 * Shared motion curves. Written here rather than reached for as easings because
 * they are the SHAPE of a specific preset's motion, not the user's tuning: a
 * swing has to oscillate whatever easing you put on it, and a bounce that a
 * user could ease away is not a bounce.
 */

/** Damped oscillation settling to 0 at t=1. `cycles` half-turns, `damp` decay. */
function wobble(t: number, cycles: number, damp: number): number {
  return Math.sin(t * Math.PI * cycles) * Math.exp(-damp * t) * (1 - t);
}

/** A ball dropped: three decreasing bounces, landing at 1. */
function bounceCurve(t: number): number {
  if (t < 0.4) return (t / 0.4) ** 2;
  if (t < 0.72) return 1 - 0.28 * Math.sin(((t - 0.4) / 0.32) * Math.PI);
  if (t < 0.92) return 1 - 0.1 * Math.sin(((t - 0.72) / 0.2) * Math.PI);
  return 1 - 0.03 * Math.sin(((t - 0.92) / 0.08) * Math.PI);
}

/**
 * A deterministic stutter in 0..1 — the "is it on or off yet" flicker of a tube
 * warming up. Deterministic and not random because a preview that differs from
 * the render is worse than no preview, and an export has to reproduce exactly
 * what the stage showed.
 */
function stutter(t: number, steps: number): number {
  const i = Math.floor(t * steps);
  const on = (i * 2654435761) % 3 !== 0;
  return t > 0.86 ? 1 : on ? Math.min(1, t * 1.4) : 0;
}

/** A hash-free zig in -1..1 — glitch displacement that repeats identically. */
function zig(t: number, steps: number): number {
  const i = Math.floor(t * steps);
  return (((i * 1103515245 + 12345) >> 8) % 200) / 100 - 1;
}

const v = (partial: Partial<GlyphVisual>): GlyphVisual => ({ ...GLYPH_IDENTITY, ...partial });

export const ANIMATION_PRESETS: AnimationPresetDef[] = [
  {
    id: "typewriter",
    category: "type",
    scope: "text",
    label: "Typewriter",
    tagline: "Instant per-character reveal",
    defaultUnit: "letter",
    defaultDurationMs: 1,
    defaultStaggerMs: 60,
    defaultJitterMs: 55,
    defaultEasing: { kind: "linear" },
    params: [],
    evalIn: (t) => v({ opacity: t > 0 ? 1 : 0 }),
    evalOut: (t) => v({ opacity: t >= 1 ? 0 : 1 }),
  },
  {
    id: "fade-up",
    category: "fade",
    scope: "both",
    label: "Fade Up",
    tagline: "Soft rise with fade",
    defaultUnit: "word",
    defaultDurationMs: 450,
    defaultStaggerMs: 90,
    defaultEasing: { kind: "preset", name: "ease-out-quart" },
    params: [{ key: "distance", label: "Distance", min: 0, max: 200, step: 1, defaultValue: 36 }],
    evalIn: (t, p) => v({ opacity: t, dy: (1 - t) * (p.distance ?? 36) }),
  },
  {
    id: "blur-in",
    category: "fade",
    scope: "both",
    label: "Blur In",
    tagline: "Focus pull into place",
    defaultUnit: "word",
    defaultDurationMs: 550,
    defaultStaggerMs: 110,
    defaultEasing: { kind: "preset", name: "ease-out" },
    params: [{ key: "blur", label: "Blur", min: 0, max: 60, step: 1, defaultValue: 18 }],
    evalIn: (t, p) => v({ opacity: t, blur: (1 - t) * (p.blur ?? 18) }),
  },
  {
    id: "slide-down",
    category: "slide",
    scope: "both",
    label: "Slide Down",
    tagline: "Drop in from above",
    defaultUnit: "letter",
    defaultDurationMs: 400,
    defaultStaggerMs: 40,
    defaultEasing: { kind: "preset", name: "ease-out-expo" },
    params: [{ key: "distance", label: "Distance", min: 0, max: 300, step: 1, defaultValue: 60 }],
    evalIn: (t, p) => v({ opacity: Math.min(1, t * 2), dy: -(1 - t) * (p.distance ?? 60) }),
  },
  {
    id: "pop-in",
    category: "scale",
    scope: "both",
    label: "Pop In",
    tagline: "Scale up with overshoot",
    defaultUnit: "word",
    defaultDurationMs: 500,
    defaultStaggerMs: 100,
    defaultEasing: { kind: "preset", name: "ease-out-back" },
    params: [{ key: "from", label: "Start scale %", min: 0, max: 100, step: 1, defaultValue: 40 }],
    evalIn: (t, p) => {
      const from = (p.from ?? 40) / 100;
      return v({ opacity: Math.min(1, t * 2.5), scale: from + (1 - from) * t });
    },
  },
  {
    id: "bounce-in",
    category: "bounce",
    scope: "both",
    label: "Bounce In",
    tagline: "Springy landing",
    defaultUnit: "letter",
    defaultDurationMs: 600,
    defaultStaggerMs: 50,
    defaultEasing: { kind: "preset", name: "ease-out-elastic" },
    params: [{ key: "distance", label: "Distance", min: 0, max: 200, step: 1, defaultValue: 44 }],
    evalIn: (t, p) => v({ opacity: Math.min(1, t * 3), dy: (1 - t) * (p.distance ?? 44) }),
  },
  {
    id: "wave",
    category: "type",
    scope: "text",
    label: "Wave",
    tagline: "Rolling rise across the line",
    defaultUnit: "letter",
    defaultDurationMs: 500,
    defaultStaggerMs: 35,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [{ key: "height", label: "Height", min: 0, max: 120, step: 1, defaultValue: 28 }],
    evalIn: (t, p) => v({ opacity: t, dy: Math.sin(Math.min(t, 1) * Math.PI) * -(p.height ?? 28) * (1 - t) - 0 }),
  },
  {
    id: "flip-up",
    category: "spin",
    scope: "both",
    label: "Flip Up",
    tagline: "Rotational snap into place",
    defaultUnit: "letter",
    defaultDurationMs: 450,
    defaultStaggerMs: 45,
    defaultEasing: { kind: "preset", name: "ease-out-back" },
    params: [{ key: "angle", label: "Angle", min: 0, max: 180, step: 1, defaultValue: 70 }],
    evalIn: (t, p) => v({ opacity: Math.min(1, t * 2), rotation: (1 - t) * (p.angle ?? 70), scale: 0.7 + 0.3 * t }),
  },
  {
    id: "fade",
    category: "fade",
    label: "Fade",
    tagline: "Clean dissolve",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 400,
    defaultStaggerMs: 80,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [],
    evalIn: (t) => v({ opacity: t }),
  },
  {
    id: "slide-left",
    category: "slide",
    label: "Slide Left",
    tagline: "Glide in from the right",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 450,
    defaultStaggerMs: 80,
    defaultEasing: { kind: "preset", name: "ease-out-expo" },
    params: [{ key: "distance", label: "Distance", min: 0, max: 400, step: 1, defaultValue: 60 }],
    evalIn: (t, p) => v({ opacity: Math.min(1, t * 2), dx: (1 - t) * (p.distance ?? 60) }),
  },
  {
    id: "slide-right",
    category: "slide",
    label: "Slide Right",
    tagline: "Glide in from the left",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 450,
    defaultStaggerMs: 80,
    defaultEasing: { kind: "preset", name: "ease-out-expo" },
    params: [{ key: "distance", label: "Distance", min: 0, max: 400, step: 1, defaultValue: 60 }],
    evalIn: (t, p) => v({ opacity: Math.min(1, t * 2), dx: -(1 - t) * (p.distance ?? 60) }),
  },
  {
    id: "zoom-out",
    category: "scale",
    label: "Zoom Out",
    tagline: "Settle down from large",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 500,
    defaultStaggerMs: 90,
    defaultEasing: { kind: "preset", name: "ease-out-quart" },
    params: [{ key: "from", label: "Start scale %", min: 100, max: 400, step: 1, defaultValue: 170 }],
    evalIn: (t, p) => {
      const from = (p.from ?? 170) / 100;
      return v({ opacity: t, scale: from + (1 - from) * t });
    },
  },
  {
    id: "spin-in",
    category: "spin",
    label: "Spin In",
    tagline: "Rotate up to attention",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 550,
    defaultStaggerMs: 90,
    defaultEasing: { kind: "preset", name: "ease-out-back" },
    params: [{ key: "turns", label: "Angle", min: 0, max: 360, step: 5, defaultValue: 120 }],
    evalIn: (t, p) => v({ opacity: Math.min(1, t * 2), rotation: -(1 - t) * (p.turns ?? 120), scale: 0.5 + 0.5 * t }),
  },
  {
    id: "whip",
    category: "stylize",
    label: "Whip",
    tagline: "Fast pass with motion blur",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 350,
    defaultStaggerMs: 60,
    defaultEasing: { kind: "preset", name: "ease-out-expo" },
    params: [
      { key: "distance", label: "Distance", min: 0, max: 500, step: 1, defaultValue: 120 },
      { key: "blur", label: "Blur", min: 0, max: 40, step: 1, defaultValue: 12 },
    ],
    evalIn: (t, p) => v({ opacity: Math.min(1, t * 3), dx: (1 - t) * (p.distance ?? 120), blur: (1 - t) * (p.blur ?? 12) }),
  },
  {
    id: "drift",
    category: "slide",
    label: "Drift",
    tagline: "Slow cinematic float",
    scope: "layer",
    defaultUnit: "line",
    defaultDurationMs: 1200,
    defaultStaggerMs: 0,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [
      { key: "distance", label: "Distance", min: 0, max: 200, step: 1, defaultValue: 28 },
      { key: "zoom", label: "Zoom %", min: 100, max: 160, step: 1, defaultValue: 106 },
    ],
    evalIn: (t, p) => {
      const zoom = (p.zoom ?? 106) / 100;
      return v({ opacity: t, dy: (1 - t) * (p.distance ?? 28), scale: zoom + (1 - zoom) * t });
    },
  },

  // ── Fades ──────────────────────────────────────────────────────────────────
  {
    id: "fade-down",
    category: "fade",
    label: "Fade Down",
    tagline: "Settles down into place",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 450,
    defaultStaggerMs: 90,
    defaultEasing: { kind: "preset", name: "ease-out-quart" },
    params: [{ key: "distance", label: "Distance", min: 0, max: 200, step: 1, defaultValue: 36 }],
    evalIn: (t, p) => v({ opacity: t, dy: -(1 - t) * (p.distance ?? 36) }),
  },
  {
    id: "soft-focus",
    category: "fade",
    label: "Soft Focus",
    tagline: "Dreamy bloom into sharpness",
    scope: "both",
    defaultUnit: "line",
    defaultDurationMs: 900,
    defaultStaggerMs: 0,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [
      { key: "blur", label: "Blur", min: 0, max: 60, step: 1, defaultValue: 26 },
      { key: "from", label: "Start scale %", min: 100, max: 160, step: 1, defaultValue: 108 },
    ],
    evalIn: (t, p) => {
      const from = (p.from ?? 108) / 100;
      return v({ opacity: Math.min(1, t * 1.6), blur: (1 - t) * (p.blur ?? 26), scale: from + (1 - from) * t });
    },
  },

  // ── Slides ─────────────────────────────────────────────────────────────────
  {
    id: "slide-up",
    category: "slide",
    label: "Slide Up",
    tagline: "Rises in from below",
    scope: "both",
    defaultUnit: "letter",
    defaultDurationMs: 400,
    defaultStaggerMs: 40,
    defaultEasing: { kind: "preset", name: "ease-out-expo" },
    params: [{ key: "distance", label: "Distance", min: 0, max: 300, step: 1, defaultValue: 60 }],
    evalIn: (t, p) => v({ opacity: Math.min(1, t * 2), dy: (1 - t) * (p.distance ?? 60) }),
  },
  {
    id: "fly-in",
    category: "slide",
    label: "Fly In",
    tagline: "Arrives from a corner",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 550,
    defaultStaggerMs: 70,
    defaultEasing: { kind: "preset", name: "ease-out-expo" },
    params: [
      { key: "x", label: "Across", min: -600, max: 600, step: 5, defaultValue: -160 },
      { key: "y", label: "Down", min: -600, max: 600, step: 5, defaultValue: 120 },
    ],
    evalIn: (t, p) => v({ opacity: Math.min(1, t * 2), dx: (1 - t) * (p.x ?? -160), dy: (1 - t) * (p.y ?? 120) }),
  },
  {
    id: "nudge",
    category: "slide",
    label: "Nudge",
    tagline: "A short, quiet settle",
    scope: "both",
    defaultUnit: "line",
    defaultDurationMs: 260,
    defaultStaggerMs: 40,
    defaultEasing: { kind: "preset", name: "ease-out-quart" },
    params: [{ key: "distance", label: "Distance", min: 0, max: 60, step: 1, defaultValue: 10 }],
    evalIn: (t, p) => v({ opacity: Math.min(1, t * 2.5), dy: (1 - t) * (p.distance ?? 10) }),
  },
  {
    id: "slide-through",
    category: "slide",
    label: "Slide Through",
    tagline: "In one side, out the other",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 500,
    defaultStaggerMs: 70,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [{ key: "distance", label: "Distance", min: 0, max: 600, step: 5, defaultValue: 140 }],
    // The one preset whose exit is not its entrance reversed: a conveyor keeps
    // going. Reversing it would send the layer back where it came from, which
    // is a different — and much less useful — idea.
    evalIn: (t, p) => v({ opacity: Math.min(1, t * 2), dx: (1 - t) * (p.distance ?? 140) }),
    evalOut: (t, p) => v({ opacity: Math.max(0, 1 - t * 1.6), dx: -t * (p.distance ?? 140) }),
  },

  // ── Scale ──────────────────────────────────────────────────────────────────
  {
    id: "scale-in",
    category: "scale",
    label: "Scale In",
    tagline: "Grows up from nothing",
    scope: "both",
    defaultUnit: "letter",
    defaultDurationMs: 420,
    defaultStaggerMs: 40,
    defaultEasing: { kind: "preset", name: "ease-out-quart" },
    params: [{ key: "from", label: "Start scale %", min: 0, max: 100, step: 1, defaultValue: 0 }],
    evalIn: (t, p) => {
      const from = (p.from ?? 0) / 100;
      return v({ opacity: Math.min(1, t * 3), scale: from + (1 - from) * t });
    },
  },
  {
    id: "punch",
    category: "scale",
    label: "Punch",
    tagline: "Hard impact, blurred edges",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 320,
    defaultStaggerMs: 50,
    defaultEasing: { kind: "preset", name: "ease-out-expo" },
    params: [
      { key: "from", label: "Start scale %", min: 100, max: 400, step: 5, defaultValue: 190 },
      { key: "blur", label: "Blur", min: 0, max: 40, step: 1, defaultValue: 14 },
    ],
    evalIn: (t, p) => {
      const from = (p.from ?? 190) / 100;
      return v({ opacity: Math.min(1, t * 3), scale: from + (1 - from) * t, blur: (1 - t) * (p.blur ?? 14) });
    },
  },
  {
    id: "grow",
    category: "scale",
    label: "Grow",
    tagline: "Barely there, on purpose",
    scope: "both",
    defaultUnit: "line",
    defaultDurationMs: 700,
    defaultStaggerMs: 60,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [{ key: "from", label: "Start scale %", min: 50, max: 100, step: 1, defaultValue: 92 }],
    evalIn: (t, p) => {
      const from = (p.from ?? 92) / 100;
      return v({ opacity: t, scale: from + (1 - from) * t });
    },
  },

  // ── Spins ──────────────────────────────────────────────────────────────────
  {
    id: "roll-in",
    category: "spin",
    label: "Roll In",
    tagline: "Rolls in along its own path",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 700,
    defaultStaggerMs: 80,
    defaultEasing: { kind: "preset", name: "ease-out-quart" },
    params: [
      { key: "distance", label: "Distance", min: 0, max: 600, step: 5, defaultValue: 180 },
      { key: "turns", label: "Turns", min: 0, max: 1080, step: 15, defaultValue: 360 },
    ],
    // Rotation and travel share one `t`, which is what makes it read as ROLLING
    // rather than as a spin and a slide that happen to overlap.
    evalIn: (t, p) =>
      v({
        opacity: Math.min(1, t * 3),
        dx: -(1 - t) * (p.distance ?? 180),
        rotation: -(1 - t) * (p.turns ?? 360),
      }),
  },
  {
    id: "swing",
    category: "spin",
    label: "Swing",
    tagline: "Hangs, then settles level",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 900,
    defaultStaggerMs: 90,
    defaultEasing: { kind: "linear" },
    params: [{ key: "angle", label: "Angle", min: 0, max: 90, step: 1, defaultValue: 24 }],
    evalIn: (t, p) => v({ opacity: Math.min(1, t * 4), rotation: wobble(t, 3, 2.2) * (p.angle ?? 24) }),
  },
  {
    id: "flip-down",
    category: "spin",
    label: "Flip Down",
    tagline: "Tips forward into place",
    scope: "both",
    defaultUnit: "letter",
    defaultDurationMs: 450,
    defaultStaggerMs: 45,
    defaultEasing: { kind: "preset", name: "ease-out-back" },
    params: [{ key: "angle", label: "Angle", min: 0, max: 180, step: 1, defaultValue: 70 }],
    evalIn: (t, p) => v({ opacity: Math.min(1, t * 2), rotation: -(1 - t) * (p.angle ?? 70), scale: 0.7 + 0.3 * t }),
  },

  // ── Bounce ─────────────────────────────────────────────────────────────────
  {
    id: "drop",
    category: "bounce",
    label: "Drop",
    tagline: "Falls in and bounces to rest",
    scope: "both",
    defaultUnit: "letter",
    defaultDurationMs: 800,
    defaultStaggerMs: 55,
    // The bounce is IN the curve, so the easing stays linear — an ease on top
    // would squash the landings unevenly and the ball would lose its weight.
    defaultEasing: { kind: "linear" },
    params: [{ key: "distance", label: "Height", min: 0, max: 400, step: 5, defaultValue: 120 }],
    evalIn: (t, p) => v({ opacity: Math.min(1, t * 5), dy: -(1 - bounceCurve(t)) * (p.distance ?? 120) }),
  },
  {
    id: "rubber",
    category: "bounce",
    label: "Rubber",
    tagline: "Overshoots, wobbles, holds",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 750,
    defaultStaggerMs: 70,
    defaultEasing: { kind: "linear" },
    params: [{ key: "amount", label: "Amount", min: 0, max: 80, step: 1, defaultValue: 26 }],
    evalIn: (t, p) =>
      v({ opacity: Math.min(1, t * 5), scale: 1 + wobble(t, 3, 2.6) * ((p.amount ?? 26) / 100) }),
  },

  // ── Typing ─────────────────────────────────────────────────────────────────
  {
    id: "cascade",
    category: "type",
    label: "Cascade",
    tagline: "Letters fall one after another",
    scope: "text",
    defaultUnit: "letter",
    defaultDurationMs: 520,
    defaultStaggerMs: 45,
    defaultEasing: { kind: "preset", name: "ease-out-back" },
    params: [
      { key: "distance", label: "Distance", min: 0, max: 300, step: 1, defaultValue: 80 },
      { key: "tilt", label: "Tilt", min: 0, max: 90, step: 1, defaultValue: 20 },
    ],
    evalIn: (t, p) =>
      v({
        opacity: Math.min(1, t * 2.5),
        dy: -(1 - t) * (p.distance ?? 80),
        rotation: (1 - t) * (p.tilt ?? 20),
      }),
  },
  {
    id: "ripple",
    category: "type",
    label: "Ripple",
    tagline: "A pulse travelling down the line",
    scope: "text",
    defaultUnit: "letter",
    defaultDurationMs: 600,
    defaultStaggerMs: 30,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [{ key: "amount", label: "Amount", min: 0, max: 100, step: 1, defaultValue: 45 }],
    evalIn: (t, p) =>
      v({ opacity: Math.min(1, t * 3), scale: 1 + Math.sin(Math.min(t, 1) * Math.PI) * ((p.amount ?? 45) / 100) * (1 - t) }),
  },
  {
    id: "flicker-on",
    category: "type",
    label: "Flicker On",
    tagline: "A tube warming up",
    scope: "both",
    defaultUnit: "letter",
    defaultDurationMs: 700,
    defaultStaggerMs: 40,
    defaultEasing: { kind: "linear" },
    params: [{ key: "steps", label: "Steps", min: 3, max: 40, step: 1, defaultValue: 14 }],
    evalIn: (t, p) => v({ opacity: stutter(t, Math.round(p.steps ?? 14)) }),
  },

  // ── Stylised ───────────────────────────────────────────────────────────────
  {
    id: "glitch",
    category: "stylize",
    label: "Glitch",
    tagline: "Torn signal snapping into sync",
    scope: "both",
    defaultUnit: "letter",
    defaultDurationMs: 550,
    defaultStaggerMs: 30,
    defaultEasing: { kind: "linear" },
    params: [
      { key: "distance", label: "Tear", min: 0, max: 200, step: 1, defaultValue: 44 },
      { key: "steps", label: "Steps", min: 3, max: 40, step: 1, defaultValue: 12 },
    ],
    evalIn: (t, p) => {
      const steps = Math.round(p.steps ?? 12);
      const decay = 1 - t;
      return v({
        opacity: stutter(t, steps),
        dx: zig(t, steps) * (p.distance ?? 44) * decay,
        dy: zig(t + 0.37, steps) * (p.distance ?? 44) * 0.25 * decay,
      });
    },
  },
  {
    id: "strobe",
    category: "stylize",
    label: "Strobe",
    tagline: "Pulses in, then holds",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 600,
    defaultStaggerMs: 60,
    defaultEasing: { kind: "linear" },
    params: [{ key: "pulses", label: "Pulses", min: 1, max: 12, step: 1, defaultValue: 5 }],
    evalIn: (t, p) => {
      const n = Math.max(1, Math.round(p.pulses ?? 5));
      // Square wave whose duty cycle opens as it goes, so it resolves to solid
      // instead of stopping mid-blink.
      return v({ opacity: (t * n) % 1 < 0.35 + 0.65 * t ? Math.min(1, t * 1.5) : 0 });
    },
  },
  {
    id: "smear",
    category: "stylize",
    label: "Smear",
    tagline: "Resolves out of a heavy blur",
    scope: "both",
    defaultUnit: "line",
    defaultDurationMs: 600,
    defaultStaggerMs: 0,
    defaultEasing: { kind: "preset", name: "ease-out-expo" },
    params: [
      { key: "blur", label: "Blur", min: 0, max: 80, step: 1, defaultValue: 40 },
      { key: "distance", label: "Drift", min: 0, max: 200, step: 1, defaultValue: 30 },
    ],
    evalIn: (t, p) =>
      v({ opacity: Math.min(1, t * 2), blur: (1 - t) * (p.blur ?? 40), dx: (1 - t) * (p.distance ?? 30) }),
  },

  // ── Added: gaps the families had ──────────────────────────────────────────
  {
    id: "unblur-up",
    category: "fade",
    label: "Lift",
    tagline: "Rises out of a defocus",
    scope: "both",
    defaultUnit: "line",
    defaultDurationMs: 620,
    defaultStaggerMs: 70,
    defaultEasing: { kind: "preset", name: "ease-out-quart" },
    params: [
      { key: "distance", label: "Rise", min: 0, max: 200, step: 2, defaultValue: 44 },
      { key: "blur", label: "Blur", min: 0, max: 40, step: 1, defaultValue: 12 },
    ],
    // Blur clears FASTER than the travel finishes (t³ against t), so the type is
    // already legible while it is still settling. Focus resolving at the same
    // moment motion stops reads as a render catching up, not as a move.
    evalIn: (t, p) =>
      v({
        opacity: Math.min(1, t * 2),
        dy: (1 - t) * (p.distance ?? 44),
        blur: (1 - t) ** 3 * (p.blur ?? 12),
      }),
  },
  {
    id: "fade-through",
    category: "fade",
    label: "Fade Through",
    tagline: "Out, a beat of nothing, back",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 520,
    defaultStaggerMs: 40,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [{ key: "hold", label: "Gap", min: 0, max: 60, step: 1, defaultValue: 25 }],
    // A dead band in the middle where nothing is drawn. Material's shared-axis
    // transition is built on this: the eye accepts a swap it never saw overlap,
    // and refuses one where two states were briefly both true.
    evalIn: (t, p) => {
      const gap = (p.hold ?? 25) / 100;
      const start = 0.5 + gap / 2;
      return v({ opacity: t < start ? 0 : (t - start) / (1 - start) });
    },
  },
  {
    id: "slide-stagger",
    category: "slide",
    label: "Deal",
    tagline: "Dealt in from one side",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 480,
    defaultStaggerMs: 110,
    defaultEasing: { kind: "preset", name: "ease-out-expo" },
    params: [
      { key: "distance", label: "Distance", min: 0, max: 600, step: 5, defaultValue: 220 },
      { key: "tilt", label: "Tilt", min: 0, max: 45, step: 1, defaultValue: 8 },
    ],
    // The tilt unwinds on the same clock as the travel, so each unit lands flat
    // exactly as it stops — the reason a dealt card looks dealt.
    evalIn: (t, p) =>
      v({
        opacity: Math.min(1, t * 2.5),
        dx: -(1 - t) * (p.distance ?? 220),
        rotation: -(1 - t) * (p.tilt ?? 8),
      }),
  },
  {
    id: "settle",
    category: "bounce",
    label: "Settle",
    tagline: "Overshoots once and rests",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 720,
    defaultStaggerMs: 60,
    defaultEasing: { kind: "linear" },
    params: [
      { key: "distance", label: "Drop", min: 0, max: 300, step: 5, defaultValue: 90 },
      { key: "damping", label: "Damping", min: 1, max: 12, step: 1, defaultValue: 5 },
    ],
    // A real damped oscillator — e^(-dt)·cos(ωt) — rather than an ease curve
    // shaped to look like one. Easing is linear on purpose: the physics IS the
    // curve, and composing the two would damp it twice and kill the overshoot.
    //
    // The `(1 - t)` envelope is not decoration. Exponential decay is asymptotic:
    // at t=1 it still holds e^(-5)·cos(3π) ≈ -0.007, which is 0.6px of offset
    // left on the layer FOREVER once the entrance is over. Every entrance must
    // land exactly on the identity pose, and the registry test enforces it.
    evalIn: (t, p) => {
      const d = p.damping ?? 5;
      const rest = Math.exp(-d * t) * Math.cos(t * Math.PI * 3) * (1 - t);
      return v({ opacity: Math.min(1, t * 4), dy: rest * (p.distance ?? 90) });
    },
  },
  {
    id: "breathe",
    category: "scale",
    label: "Breathe",
    tagline: "Swells in and holds",
    scope: "both",
    defaultUnit: "line",
    defaultDurationMs: 900,
    defaultStaggerMs: 90,
    defaultEasing: { kind: "preset", name: "ease-out-quart" },
    params: [{ key: "from", label: "Start scale %", min: 60, max: 100, step: 1, defaultValue: 82 }],
    evalIn: (t, p) => {
      const from = (p.from ?? 82) / 100;
      // Opacity leads the scale so it is readable before it is the right size —
      // arriving at both together makes small type look like it failed to load.
      return v({ opacity: Math.min(1, t * 1.6), scale: from + (1 - from) * t });
    },
  },
  {
    id: "pendulum",
    category: "spin",
    label: "Pendulum",
    tagline: "Swings down and steadies",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 820,
    defaultStaggerMs: 70,
    defaultEasing: { kind: "linear" },
    params: [
      { key: "angle", label: "Swing", min: 5, max: 90, step: 1, defaultValue: 35 },
      { key: "damping", label: "Damping", min: 1, max: 12, step: 1, defaultValue: 4 },
    ],
    // The same damped oscillator as Settle, on rotation instead of position —
    // envelope included, for the same reason: a residual tilt that never
    // resolves is worse than no swing at all. One piece of maths, two presets,
    // which is why they feel related rather than merely both being "bouncy".
    evalIn: (t, p) => {
      const swing = Math.exp(-(p.damping ?? 4) * t) * Math.cos(t * Math.PI * 3) * (1 - t);
      return v({ opacity: Math.min(1, t * 4), rotation: swing * (p.angle ?? 35) });
    },
  },
  {
    id: "shutter",
    category: "stylize",
    label: "Shutter",
    tagline: "Snaps on in hard steps",
    scope: "both",
    defaultUnit: "word",
    defaultDurationMs: 420,
    defaultStaggerMs: 50,
    defaultEasing: { kind: "linear" },
    params: [{ key: "steps", label: "Steps", min: 2, max: 12, step: 1, defaultValue: 5 }],
    // Quantised opacity — the animation runs on its own coarse frame rate. The
    // steps have to be visible to read as a choice, which is why the range
    // starts at 2 and not at 1.
    evalIn: (t, p) => {
      const steps = Math.max(2, Math.round(p.steps ?? 5));
      return v({ opacity: Math.ceil(t * steps) / steps });
    },
  },
  {
    id: "trace",
    category: "type",
    scope: "text",
    label: "Trace",
    tagline: "Draws on left to right",
    defaultUnit: "letter",
    defaultDurationMs: 260,
    defaultStaggerMs: 34,
    defaultJitterMs: 0,
    defaultEasing: { kind: "preset", name: "ease-out" },
    params: [{ key: "rise", label: "Rise", min: 0, max: 40, step: 1, defaultValue: 10 }],
    // Typewriter's neighbour, and deliberately not a variant of it: this one
    // fades and lifts each letter instead of switching it on, which is what a
    // hand drawing type looks like versus a machine printing it.
    evalIn: (t, p) => v({ opacity: t, dy: (1 - t) * (p.rise ?? 10) }),
  },
  {
    id: "draw",
    category: "draw",
    scope: "layer",
    needs: "outline",
    label: "Draw On",
    tagline: "The outline inks itself",
    defaultUnit: "line",
    defaultDurationMs: 900,
    defaultStaggerMs: 0,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [
      {
        key: "order",
        label: "Order",
        min: 0,
        max: 2,
        step: 1,
        defaultValue: 1,
        options: [
          { value: 0, label: "Together" },
          { value: 1, label: "One by one" },
          { value: 2, label: "Staggered" },
        ],
      },
      {
        key: "stagger",
        label: "Stagger",
        min: 0,
        max: 2,
        step: 0.05,
        defaultValue: 0.5,
        unit: "%",
        when: (p) => Math.round(p.order ?? 1) === 2,
      },
      {
        key: "topFirst",
        label: "Pieces",
        min: 0,
        max: 1,
        step: 1,
        defaultValue: 0,
        options: [
          { value: 0, label: "Bottom first" },
          { value: 1, label: "Top first" },
        ],
        when: (p) => Math.round(p.order ?? 1) !== 0,
      },
      { key: "origin", label: "Start at", min: 0, max: 1, step: 0.01, defaultValue: 0, unit: "%" },
      {
        key: "direction",
        label: "Direction",
        min: 0,
        max: 2,
        step: 1,
        defaultValue: 0,
        options: [
          { value: 0, label: "Forward" },
          { value: 1, label: "Backward" },
          { value: 2, label: "Both ways" },
        ],
      },
      {
        key: "fill",
        label: "Fill",
        min: 0,
        max: 2,
        step: 1,
        defaultValue: 2,
        options: [
          { value: 0, label: "Keep" },
          { value: 1, label: "Fade along" },
          { value: 2, label: "Fade late" },
        ],
      },
      {
        key: "pen",
        label: "Pen",
        min: 0.5,
        max: 12,
        step: 0.5,
        defaultValue: 2,
        unit: "px",
        hint: "For a layer with no stroke of its own: its silhouette is inked at this width while it draws.",
      },
    ],
    // The pose is the identity: the drawing happens in the stroke pipeline.
    evalIn: () => GLYPH_IDENTITY,
    reveal: revealFromParams,
  },
];


const registry = new Map(ANIMATION_PRESETS.map((p) => [p.id, p]));

/**
 * Presets matching a search, grouped into their categories in browse order.
 *
 * THE grouping, headless, so the Animate tab's gallery and anything else that
 * lists animations arrive at the same shelves in the same order from the same
 * search — the mirror of `groupedTransitions`, and the reason a picker is a
 * `.map` over this rather than its own opinion about what belongs together.
 *
 * The caller hands in the list because scope filtering is theirs: a layer picker
 * has no business offering a typewriter.
 */
export function groupedAnimationPresets(
  presets: readonly AnimationPresetDef[],
  query = "",
): Array<{ category: AnimationCategory; presets: AnimationPresetDef[] }> {
  const q = query.trim().toLowerCase();
  const match = (p: AnimationPresetDef) =>
    !q ||
    p.label.toLowerCase().includes(q) ||
    p.tagline.toLowerCase().includes(q) ||
    ANIMATION_CATEGORY_LABEL[p.category].toLowerCase().includes(q);
  return ANIMATION_CATEGORY_ORDER.map((category) => ({
    category,
    presets: presets.filter((p) => p.category === category && match(p)),
  })).filter((g) => g.presets.length > 0);
}

/** Presets that read at glyph grain — the text Animate tab's gallery. */
export const TEXT_ANIMATION_PRESETS = ANIMATION_PRESETS.filter((p) => p.scope !== "layer");
/** Presets that make sense on a whole layer — every other clip's gallery. */
export const LAYER_ANIMATION_PRESETS = ANIMATION_PRESETS.filter((p) => p.scope !== "text");

export function getPreset(id: string): AnimationPresetDef | undefined {
  return registry.get(id);
}

/** Build a full AnimationSpec from a preset's defaults. */
export function specFromPreset(presetId: string): AnimationSpec {
  const def = registry.get(presetId) ?? ANIMATION_PRESETS[0]!;
  const params: Record<string, number> = {};
  for (const p of def.params) params[p.key] = p.defaultValue;
  return {
    preset: def.id,
    unit: def.defaultUnit,
    durationMs: def.defaultDurationMs,
    staggerMs: def.defaultStaggerMs,
    delayMs: 0,
    jitterMs: def.defaultJitterMs ?? 0,
    scatterPx: 0,
    scatterDeg: 0,
    easing: def.defaultEasing,
    params,
  };
}

/**
 * Start from a preset's default params, but keep the previous value for every
 * knob the new preset ALSO declares — so switching presets preserves shared
 * tuning (distance, intensity…) instead of resetting it. THE param-merge every
 * "retarget to another preset" helper uses (text + layer specs alike).
 */
export function carryMatchingParams(
  freshParams: Record<string, number>,
  prevParams: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...freshParams };
  for (const key of Object.keys(freshParams)) {
    if (key in prevParams) out[key] = prevParams[key]!;
  }
  return out;
}

/**
 * Switch an existing text animation to another preset WITHOUT discarding the
 * user's tuning: duration, stagger, unit and easing carry over, and any param
 * the new preset also declares keeps its value. `prev` null → the preset's
 * defaults. Mirrors `retargetLayerSpec` (layer-animation.ts) — one behavior for
 * every "change the animation mode" control.
 */
export function retargetAnimSpec(prev: AnimationSpec | null, presetId: string): AnimationSpec {
  const fresh = specFromPreset(presetId);
  if (!prev) return fresh;
  return {
    ...fresh,
    durationMs: prev.durationMs,
    staggerMs: prev.staggerMs,
    delayMs: prev.delayMs,
    // Humanisation is tuning, not identity — it survives a preset swap exactly
    // like duration and stagger do.
    jitterMs: prev.jitterMs,
    scatterPx: prev.scatterPx,
    scatterDeg: prev.scatterDeg,
    unit: prev.unit,
    easing: prev.easing,
    params: carryMatchingParams(fresh.params, prev.params),
  };
}
