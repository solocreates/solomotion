import type { Easing } from "../schema/common";
import type { Transition } from "../schema/transitions";
import { evaluateEasing } from "../easing";
import { GLYPH_IDENTITY, type GlyphVisual } from "./presets";

/**
 * The transition REGISTRY — one headless vocabulary for every cut effect,
 * shared by the renderer, the timeline badge, the preset browser previews and
 * both exporters.
 *
 * THE key design call: a transition evaluates to ONE shape, `TransitionMixOp`,
 * whatever family it belongs to. A cross-dissolve, a clock wipe and a "slide
 * apart" all describe themselves as: a pose for A, a pose for B, an optional
 * stencil revealing B over A, and an optional flat colour veil. The poses are
 * `GlyphVisual` — the SAME type layer animations produce — so the renderer
 * applies them with the code path `withLayer` already uses. No second motion
 * vocabulary was invented for transitions.
 *
 * "Pair" vs "true mix" therefore stops being a data distinction and becomes a
 * pure OPTIMIZATION + EXPORT-FIDELITY hint, derived by `isSeparableMix`:
 *   • separable (no stencil, no veil) → the two clips can be painted as
 *     ordinary layers carrying their poses. No offscreen buffers, and the SVG
 *     and Lottie exporters bake it as two layer animations at FULL fidelity.
 *   • non-separable → the two-buffer composite path, reported as a fidelity
 *     degradation by the vector exporters.
 * Adding a preset never touches either consumer.
 */

/** A stencil that reveals B over A. `progress` 0 = all A, 1 = all B. */
export type WipeSpec =
  /** Straight edge sweeping along `angleDeg` (0 = left→right, 90 = top→bottom). */
  | { kind: "linear"; angleDeg: number; progress: number; softness: number }
  /** Iris from a normalized centre (0..1 of the frame). */
  | { kind: "circle"; cx: number; cy: number; progress: number; softness: number }
  /** Radial sweep from `startDeg`, clockwise. */
  | { kind: "clock"; cx: number; cy: number; startDeg: number; progress: number; softness: number }
  /** Two edges opening apart from the centre line along `angleDeg`. */
  | { kind: "barn"; angleDeg: number; progress: number; softness: number };

/** Everything a transition asks the compositor to do at one instant. */
export interface TransitionMixOp {
  /** Outgoing clip's pose (opacity/offset/scale/rotation/blur). */
  a: GlyphVisual;
  /** Incoming clip's pose. */
  b: GlyphVisual;
  /** Stencil revealing B over A; null = plain alpha compositing. */
  wipe: WipeSpec | null;
  /** Flat colour veil over the mixed result, 0..1 (dip to colour). */
  veil: number;
}

export interface TransitionParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  /** Render the knob as a direction dial instead of a slider. */
  kind?: "angle";
}

/** Browser grouping — also the order categories appear in the preset rail. */
export type TransitionCategory = "dissolve" | "wipe" | "motion" | "stylize";

/**
 * How a transition behaves on an AUDIO seam. Every visual op still has to
 * decide what the sound does, so this is declared rather than guessed: audio
 * seams offer only presets that carry it, and the crossfade curve is the
 * preset's own choice. `equal-power` holds perceived loudness across the cut
 * (the correct default); `linear` sums to unity for phase-coherent material;
 * `dip` ducks through silence, matching a dip-to-colour on the picture.
 */
export type AudioCrossfadeCurve = "equal-power" | "linear" | "dip";

export interface TransitionDef {
  id: string;
  label: string;
  /** Short descriptor shown on the browser card. */
  tagline: string;
  category: TransitionCategory;
  /** Crossfade curve on an audio seam; null = picture only. */
  audio: AudioCrossfadeCurve | null;
  /** Whether the preset paints a colour veil (exposes the colour swatch). */
  usesColor?: boolean;
  /**
   * The preset's two halves are two SEPARATE events rather than one continuous
   * handover — a dip goes out to colour and then back in from it, so its middle
   * is the "nothing" state rather than the halfway blend.
   *
   * It only matters on a LONE edge (a clip head or tail with no partner), where
   * playing the whole arch would hide the clip for the first half and then pop
   * it on — the bug this flag exists to name. Such a transition plays only the
   * half that belongs to its own side, so "fade up from black" runs from the
   * clip's first frame instead of from its middle.
   *
   * Every other family (dissolve, wipe, slide, zoom) already ramps its side
   * monotonically across the whole span, so it plays full-domain and needs no
   * flag: the missing partner is simply nothing behind.
   */
  splitAtCut?: boolean;
  defaultDurationMs: number;
  defaultEasing: Easing;
  params: TransitionParamDef[];
  /** `t` is EASED progress 0→1 across the whole span. */
  evalMix: (t: number, params: Record<string, number>) => TransitionMixOp;
}

const pose = (partial: Partial<GlyphVisual>): GlyphVisual => ({ ...GLYPH_IDENTITY, ...partial });

/** Straight alpha crossfade with optional per-side extras. */
const blend = (a: Partial<GlyphVisual>, b: Partial<GlyphVisual>): TransitionMixOp => ({
  a: pose(a),
  b: pose(b),
  wipe: null,
  veil: 0,
});

/** A stencil op: both clips sit still, the stencil does the work. */
const stencil = (wipe: WipeSpec): TransitionMixOp => ({
  a: GLYPH_IDENTITY,
  b: GLYPH_IDENTITY,
  wipe,
  veil: 0,
});

/** Unit vector for a direction param in degrees (0 = →, 90 = ↓). */
function dir(angleDeg: number): { x: number; y: number } {
  const r = (angleDeg * Math.PI) / 180;
  return { x: Math.cos(r), y: Math.sin(r) };
}

/** Symmetric "out then in" ramp used by dips — 0 at both ends, 1 at the middle. */
const arch = (t: number) => 1 - Math.abs(t * 2 - 1);

const DIST: TransitionParamDef = {
  key: "distance",
  label: "Distance",
  min: 0,
  max: 200,
  step: 1,
  defaultValue: 100,
};
const ANGLE: TransitionParamDef = {
  key: "angle",
  label: "Direction",
  min: 0,
  max: 360,
  step: 1,
  defaultValue: 180,
  kind: "angle",
};
const SOFT: TransitionParamDef = {
  key: "softness",
  label: "Softness",
  min: 0,
  max: 100,
  step: 1,
  defaultValue: 12,
};

export const TRANSITION_PRESETS: TransitionDef[] = [
  // ── Dissolve ──────────────────────────────────────────────────────────────
  {
    id: "cross-dissolve",
    label: "Cross Dissolve",
    tagline: "Both frames mixed through the cut",
    category: "dissolve",
    audio: "equal-power",
    defaultDurationMs: 600,
    defaultEasing: { kind: "linear" },
    params: [],
    // Both layers are visible at once at partial opacity — the classic. NOT
    // separable in spirit, but it IS in maths: source-over of A then B at
    // 1-t / t reproduces it exactly, so it takes the fast path for free.
    evalMix: (t) => blend({ opacity: 1 }, { opacity: t }),
  },
  {
    id: "fade",
    label: "Fade",
    tagline: "A leaves before B arrives",
    category: "dissolve",
    audio: "equal-power",
    defaultDurationMs: 500,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [],
    // Deliberately different from a dissolve: neither clip is ever half-mixed
    // with the other, so whatever sits BEHIND them shows through the middle.
    evalMix: (t) => blend({ opacity: Math.max(0, 1 - t * 2) }, { opacity: Math.max(0, t * 2 - 1) }),
  },
  {
    id: "dip-to-color",
    label: "Dip to Colour",
    tagline: "Through black (or any colour)",
    category: "dissolve",
    audio: "dip",
    usesColor: true,
    splitAtCut: true,
    defaultDurationMs: 700,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [],
    evalMix: (t) => ({
      a: pose({ opacity: t < 0.5 ? 1 : 0 }),
      b: pose({ opacity: t < 0.5 ? 0 : 1 }),
      wipe: null,
      veil: arch(t),
    }),
  },
  {
    id: "blur-dissolve",
    label: "Blur Dissolve",
    tagline: "Defocus through the mix",
    category: "dissolve",
    audio: "equal-power",
    defaultDurationMs: 700,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [{ key: "blur", label: "Blur", min: 0, max: 80, step: 1, defaultValue: 24 }],
    evalMix: (t, p) => {
      const max = p.blur ?? 24;
      return blend({ opacity: 1, blur: t * max }, { opacity: t, blur: (1 - t) * max });
    },
  },

  {
    id: "additive-dissolve",
    label: "Additive Dissolve",
    tagline: "Blooms bright through the middle",
    category: "dissolve",
    audio: "equal-power",
    defaultDurationMs: 700,
    defaultEasing: { kind: "linear" },
    params: [{ key: "bloom", label: "Bloom", min: 0, max: 100, step: 1, defaultValue: 55 }],
    // Both clips hold opacity ABOVE the crossfade sum through the middle, so
    // the overlap adds instead of averaging. That is the whole difference from
    // a cross dissolve, and it is why film opticals ran hot at the join:
    // `1 - t` and `t` sum to 1, these sum to 1 + bloom·arch(t).
    evalMix: (t, p) => {
      const bloom = ((p.bloom ?? 55) / 100) * arch(t);
      return blend({ opacity: Math.min(1, 1 - t + bloom) }, { opacity: Math.min(1, t + bloom) });
    },
  },
  {
    id: "soft-dissolve",
    label: "Soft Dissolve",
    tagline: "Defocuses only as it hands over",
    category: "dissolve",
    audio: "equal-power",
    defaultDurationMs: 800,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [{ key: "blur", label: "Softness", min: 0, max: 60, step: 1, defaultValue: 14 }],
    // Blur peaks at the handover and is ZERO at both ends, so neither clip is
    // ever soft while it is the only thing on screen — the failure that makes a
    // blurred dissolve read as a rendering fault rather than as a choice.
    evalMix: (t, p) => {
      const soft = (p.blur ?? 14) * arch(t);
      return blend({ opacity: 1 - t, blur: soft }, { opacity: t, blur: soft });
    },
  },
  // ── Wipe ──────────────────────────────────────────────────────────────────
  {
    id: "linear-wipe",
    label: "Wipe",
    tagline: "A straight edge sweeps B in",
    category: "wipe",
    audio: "equal-power",
    defaultDurationMs: 600,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [ANGLE, SOFT],
    evalMix: (t, p) =>
      stencil({ kind: "linear", angleDeg: p.angle ?? 180, progress: t, softness: p.softness ?? 12 }),
  },
  {
    id: "iris",
    label: "Iris",
    tagline: "Circle opens onto the next shot",
    category: "wipe",
    audio: "equal-power",
    defaultDurationMs: 650,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [
      { key: "cx", label: "Centre X", min: 0, max: 100, step: 1, defaultValue: 50 },
      { key: "cy", label: "Centre Y", min: 0, max: 100, step: 1, defaultValue: 50 },
      SOFT,
    ],
    evalMix: (t, p) =>
      stencil({
        kind: "circle",
        cx: (p.cx ?? 50) / 100,
        cy: (p.cy ?? 50) / 100,
        progress: t,
        softness: p.softness ?? 12,
      }),
  },
  {
    id: "clock-wipe",
    label: "Clock Wipe",
    tagline: "Radial sweep around the centre",
    category: "wipe",
    audio: "equal-power",
    defaultDurationMs: 700,
    defaultEasing: { kind: "linear" },
    params: [{ ...ANGLE, label: "Start", defaultValue: 270 }, { ...SOFT, defaultValue: 2 }],
    evalMix: (t, p) =>
      stencil({
        kind: "clock",
        cx: 0.5,
        cy: 0.5,
        startDeg: p.angle ?? 270,
        progress: t,
        softness: p.softness ?? 2,
      }),
  },
  {
    id: "barn-door",
    label: "Barn Door",
    tagline: "Splits open from the middle",
    category: "wipe",
    audio: "equal-power",
    defaultDurationMs: 650,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [ANGLE, SOFT],
    evalMix: (t, p) =>
      stencil({ kind: "barn", angleDeg: p.angle ?? 180, progress: t, softness: p.softness ?? 12 }),
  },

  {
    id: "iris-close",
    label: "Iris Close",
    tagline: "Circle shuts down onto the next shot",
    category: "wipe",
    audio: "equal-power",
    defaultDurationMs: 650,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [
      { key: "cx", label: "Centre X", min: 0, max: 100, step: 1, defaultValue: 50 },
      { key: "cy", label: "Centre Y", min: 0, max: 100, step: 1, defaultValue: 50 },
      SOFT,
    ],
    // The stencil always reveals B, so closing an iris is the same shape making
    // the same sweep with `1 - t` — not a second stencil kind. A "close" arm in
    // `WipeSpec` would be a second way to say one thing, and the compositor
    // would have to learn it.
    evalMix: (t, p) =>
      stencil({
        kind: "circle",
        cx: (p.cx ?? 50) / 100,
        cy: (p.cy ?? 50) / 100,
        progress: 1 - t,
        softness: p.softness ?? 12,
      }),
  },
  {
    id: "wedge-wipe",
    label: "Wedge",
    tagline: "Two blades sweep round from the centre",
    category: "wipe",
    audio: "equal-power",
    defaultDurationMs: 750,
    defaultEasing: { kind: "linear" },
    params: [{ ...ANGLE, label: "Start", defaultValue: 270 }, { ...SOFT, defaultValue: 2 }],
    // A clock sweep run at double rate: the eye reads two opposing blades
    // because the stencil closes on both sides of the start line at once.
    evalMix: (t, p) =>
      stencil({
        kind: "clock",
        cx: 0.5,
        cy: 0.5,
        startDeg: p.angle ?? 270,
        progress: Math.min(1, t * 2),
        softness: p.softness ?? 2,
      }),
  },
  // ── Motion ────────────────────────────────────────────────────────────────
  {
    id: "push",
    label: "Push",
    tagline: "B shoves A off the frame",
    category: "motion",
    audio: "equal-power",
    defaultDurationMs: 550,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [ANGLE, { ...DIST, label: "Travel %", max: 200, defaultValue: 100 }],
    evalMix: (t, p) => {
      const d = dir(p.angle ?? 180);
      const travel = (p.distance ?? 100) / 100;
      return blend(
        { dx: -d.x * t * travel, dy: -d.y * t * travel },
        { dx: d.x * (1 - t) * travel, dy: d.y * (1 - t) * travel },
      );
    },
  },
  {
    id: "slide",
    label: "Slide Over",
    tagline: "B slides across a static A",
    category: "motion",
    audio: "equal-power",
    defaultDurationMs: 550,
    defaultEasing: { kind: "preset", name: "ease-out-expo" },
    params: [ANGLE, { ...DIST, label: "Travel %", max: 200, defaultValue: 100 }],
    evalMix: (t, p) => {
      const d = dir(p.angle ?? 180);
      const travel = (p.distance ?? 100) / 100;
      return blend({}, { dx: d.x * (1 - t) * travel, dy: d.y * (1 - t) * travel });
    },
  },
  {
    id: "slide-apart",
    label: "Slide Apart",
    tagline: "A exits, B enters behind it",
    category: "motion",
    audio: "equal-power",
    defaultDurationMs: 600,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [ANGLE, { ...DIST, label: "Travel %", max: 200, defaultValue: 60 }],
    evalMix: (t, p) => {
      const d = dir(p.angle ?? 180);
      const travel = (p.distance ?? 60) / 100;
      // Each side fades on its own half, so neither is ever mixed with the
      // other — the separable, export-perfect member of the motion family.
      return blend(
        { opacity: Math.max(0, 1 - t * 2), dx: -d.x * t * travel, dy: -d.y * t * travel },
        { opacity: Math.max(0, t * 2 - 1), dx: d.x * (1 - t) * travel, dy: d.y * (1 - t) * travel },
      );
    },
  },
  {
    id: "whip-pan",
    label: "Whip Pan",
    tagline: "Fast push with directional smear",
    category: "motion",
    audio: "equal-power",
    defaultDurationMs: 420,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [ANGLE, { key: "blur", label: "Smear", min: 0, max: 120, step: 1, defaultValue: 48 }],
    evalMix: (t, p) => {
      const d = dir(p.angle ?? 180);
      const smear = (p.blur ?? 48) * arch(t);
      return blend(
        { dx: -d.x * t, dy: -d.y * t, blur: smear },
        { dx: d.x * (1 - t), dy: d.y * (1 - t), blur: smear },
      );
    },
  },
  {
    id: "zoom",
    label: "Zoom",
    tagline: "Punch through into the next shot",
    category: "motion",
    audio: "equal-power",
    defaultDurationMs: 500,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [
      { key: "amount", label: "Amount", min: 0, max: 200, step: 1, defaultValue: 60 },
      { key: "blur", label: "Blur", min: 0, max: 80, step: 1, defaultValue: 18 },
    ],
    evalMix: (t, p) => {
      const amt = (p.amount ?? 60) / 100;
      const blurPx = (p.blur ?? 18) * arch(t);
      return blend(
        { opacity: 1, scale: 1 + amt * t, blur: blurPx },
        { opacity: t, scale: 1 - amt * (1 - t), blur: blurPx },
      );
    },
  },

  {
    id: "roll",
    label: "Roll",
    tagline: "Tumbles over into the next shot",
    category: "motion",
    audio: "equal-power",
    defaultDurationMs: 620,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [ANGLE, { key: "turns", label: "Rotation", min: 15, max: 360, step: 5, defaultValue: 75 }],
    evalMix: (t, p) => {
      const d = dir(p.angle ?? 180);
      const deg = p.turns ?? 75;
      // Travel and rotation share one clock, so a shot leaves along the axis it
      // is turning about. That is what makes it read as a tumble rather than a
      // slide with a spin bolted on.
      return blend(
        { dx: -d.x * t, dy: -d.y * t, rotation: deg * t, scale: 1 - 0.15 * t },
        { dx: d.x * (1 - t), dy: d.y * (1 - t), rotation: -deg * (1 - t), scale: 1 - 0.15 * (1 - t) },
      );
    },
  },
  // ── Stylize ───────────────────────────────────────────────────────────────
  {
    id: "pop",
    label: "Pop",
    tagline: "A shrinks away, B springs in",
    category: "stylize",
    audio: "equal-power",
    defaultDurationMs: 550,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [{ key: "amount", label: "Amount", min: 0, max: 100, step: 1, defaultValue: 55 }],
    evalMix: (t, p) => {
      const amt = (p.amount ?? 55) / 100;
      return blend(
        { opacity: Math.max(0, 1 - t * 2), scale: 1 - amt * t },
        { opacity: Math.max(0, t * 2 - 1), scale: 1 - amt * (1 - t) },
      );
    },
  },
  {
    id: "spin",
    label: "Spin",
    tagline: "Rotates out and back in",
    category: "stylize",
    audio: "equal-power",
    defaultDurationMs: 650,
    defaultEasing: { kind: "preset", name: "ease-in-out" },
    params: [{ key: "turns", label: "Rotation", min: 15, max: 720, step: 5, defaultValue: 90 }],
    evalMix: (t, p) => {
      const deg = p.turns ?? 90;
      return blend(
        { opacity: Math.max(0, 1 - t * 2), rotation: deg * t, scale: 1 - 0.35 * t },
        { opacity: Math.max(0, t * 2 - 1), rotation: -deg * (1 - t), scale: 1 - 0.35 * (1 - t) },
      );
    },
  },
  {
    id: "dip-to-white",
    label: "Flash",
    tagline: "Blows out to white and back",
    category: "stylize",
    audio: "equal-power",
    usesColor: true,
    splitAtCut: true,
    defaultDurationMs: 380,
    defaultEasing: { kind: "preset", name: "ease-out" },
    params: [],
    evalMix: (t) => ({
      a: pose({ opacity: 1 }),
      b: pose({ opacity: t }),
      wipe: null,
      // Sharper than a dip: the veil spikes at the cut instead of ramping.
      veil: Math.pow(arch(t), 0.6),
    }),
  },
  {
    id: "glitch-cut",
    label: "Glitch",
    tagline: "Tears sideways through the join",
    category: "stylize",
    audio: "linear",
    defaultDurationMs: 340,
    defaultEasing: { kind: "linear" },
    params: [{ key: "amount", label: "Displace", min: 0, max: 100, step: 1, defaultValue: 45 }],
    // DETERMINISTIC jitter, hashed from `t` rather than drawn from
    // `Math.random`. One frame is evaluated many times — the renderer, the
    // scrubbed preview, each export pass — and a random offset would disagree
    // with itself between them, so the export would not match the preview.
    // Quantising to 12 steps is what makes it read as a tear rather than noise.
    evalMix: (t, p) => {
      const amt = (p.amount ?? 45) / 100;
      const step = Math.floor(t * 12);
      const hash = Math.abs((Math.sin(step * 12.9898) * 43758.5453) % 1);
      const kick = (hash - 0.5) * 2 * amt * arch(t);
      return blend(
        { opacity: Math.max(0, 1 - t * 1.6), dx: kick },
        { opacity: Math.max(0, t * 1.6 - 0.6), dx: -kick },
      );
    },
  },
  {
    id: "shake-cut",
    label: "Shake",
    tagline: "Knocks the frame across the cut",
    category: "stylize",
    audio: "equal-power",
    defaultDurationMs: 420,
    defaultEasing: { kind: "linear" },
    params: [
      { key: "amount", label: "Travel", min: 0, max: 100, step: 1, defaultValue: 30 },
      { key: "cycles", label: "Cycles", min: 1, max: 12, step: 1, defaultValue: 5 },
    ],
    // One sine sampled by both clips in antiphase, enveloped by `arch` so the
    // frame is dead still at both ends of the span — a shake that is still
    // moving when the transition ends reads as a dropped frame.
    evalMix: (t, p) => {
      const amt = (p.amount ?? 30) / 100;
      const swing = Math.sin(t * Math.PI * 2 * (p.cycles ?? 5)) * amt * arch(t);
      return blend({ opacity: 1 - t, dx: swing }, { opacity: t, dx: -swing });
    },
  },
];

const BY_ID = new Map(TRANSITION_PRESETS.map((p) => [p.id, p]));

export function getTransitionPreset(id: string): TransitionDef | undefined {
  return BY_ID.get(id);
}

/** Presets valid on an audio seam (they declare a crossfade curve). */
export function audioTransitionPresets(): TransitionDef[] {
  return TRANSITION_PRESETS.filter((p) => p.audio !== null);
}

/** Default colour a veil paints when the transition has none of its own. */
export function defaultVeilColor(presetId: string): string {
  return presetId === "dip-to-white" ? "#ffffff" : "#000000";
}

/** Fresh params for a preset (all knobs at their declared defaults). */
export function transitionParamsFor(presetId: string): Record<string, number> {
  const def = getTransitionPreset(presetId);
  return Object.fromEntries((def?.params ?? []).map((p) => [p.key, p.defaultValue]));
}

/**
 * Switch a transition to another preset WITHOUT throwing away the user's
 * tuning — duration, split and easing carry over, and any knob the new preset
 * also declares keeps its value. Mirrors `retargetLayerSpec` exactly, because
 * "change the effect, keep my timing" is the same promise in both places.
 */
export function retargetTransition(prev: Transition, presetId: string): Transition {
  const fresh = transitionParamsFor(presetId);
  const carried: Record<string, number> = { ...fresh };
  for (const key of Object.keys(fresh)) {
    const v = prev.params[key];
    if (typeof v === "number") carried[key] = v;
  }
  return { ...prev, preset: presetId, params: carried };
}

/**
 * The mix at a NORMALIZED progress across the transition span (0 = fully the
 * outgoing clip, 1 = fully the incoming one). Easing is applied here so every
 * consumer — renderer, timeline preview, browser card — curves identically.
 */
/**
 * Which participants a transition actually has. A lone clip edge is the SAME
 * record with one side null (see the schema), so the mix has to be told — the
 * preset cannot see the timeline.
 */
export interface TransitionSides {
  a: boolean;
  b: boolean;
}

const BOTH_SIDES: TransitionSides = { a: true, b: true };

export function transitionMixAt(
  tr: Transition,
  progress: number,
  sides: TransitionSides = BOTH_SIDES,
): TransitionMixOp {
  const def = getTransitionPreset(tr.preset);
  const raw = Math.min(1, Math.max(0, progress));
  if (!def) return blend({ opacity: 1 - raw }, { opacity: raw });
  const eased = evaluateEasing(tr.easing, raw);
  if (!def.splitAtCut || (sides.a && sides.b)) return def.evalMix(eased, tr.params);

  // A lone edge of a `splitAtCut` preset plays its OWN half of the arch,
  // stretched over the whole span: an outgoing tail runs [0 → ½] (out to
  // colour), an incoming head runs [½ → 1] (in from it). Playing the full
  // domain instead is what made "fade up from black" on a single clip start
  // halfway through it.
  const half = sides.a ? eased / 2 : 0.5 + eased / 2;
  const op = def.evalMix(half, tr.params);
  // With no partner behind it the VEIL is the entire effect, so the surviving
  // clip is held fully opaque — the preset's own mid-arch opacity step exists
  // only to hand over between two pictures, and there is only one here.
  return { ...op, a: pose({ ...op.a, opacity: 1 }), b: pose({ ...op.b, opacity: 1 }) };
}

/**
 * Can this instant be painted by drawing A and B as ordinary posed layers,
 * with no offscreen buffers? True whenever nothing needs to see BOTH images at
 * once as pixels — i.e. no stencil and no veil. The renderer takes the cheap
 * path on it, and the SVG/Lottie exporters bake it losslessly as a pair of
 * layer animations. A preset can be separable at some instants and not others
 * (a veil that only lifts mid-span), so this is asked per frame, not per
 * preset — cheap, and always correct.
 */
export function isSeparableMix(op: TransitionMixOp): boolean {
  return op.wipe === null && op.veil <= 0.001;
}

/** Does the preset EVER need the two-buffer path? Drives export fidelity notes. */
export function presetNeedsCompositor(presetId: string): boolean {
  const def = getTransitionPreset(presetId);
  if (!def) return false;
  const params = transitionParamsFor(presetId);
  for (let i = 0; i <= 10; i++) {
    if (!isSeparableMix(def.evalMix(i / 10, params))) return true;
  }
  return false;
}

/**
 * Equal-power (or linear / dipped) crossfade gains at a normalized progress.
 * ONE brain for every audio seam: the live conductor, the waveform overlay and
 * both export paths multiply their clip gain by these, exactly the way the fade
 * envelope already multiplies instead of writing keys — so a crossfade never
 * destroys a clip's own automation.
 */
export function crossfadeGains(curve: AudioCrossfadeCurve, progress: number): { a: number; b: number } {
  const t = Math.min(1, Math.max(0, progress));
  if (curve === "linear") return { a: 1 - t, b: t };
  if (curve === "dip") {
    // Both sides reach silence at the cut — the audible twin of a dip to black.
    return { a: Math.max(0, 1 - t * 2), b: Math.max(0, t * 2 - 1) };
  }
  return { a: Math.cos((t * Math.PI) / 2), b: Math.sin((t * Math.PI) / 2) };
}
