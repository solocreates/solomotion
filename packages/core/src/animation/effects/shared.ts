import { EFFECT_BLEND_MODES } from "../../schema/layer-effects";
import type { LayerEffect, LayerEffectType } from "../../schema/layer-effects";
import { resolveTemporalStep } from "../temporal";
import { ownClockSec } from "../effect-base";
import type {
  EffectFieldDef,
  EffectFieldGroupDef,
  EffectFieldOption,
  EffectToggleDef,
  EffectTypeDefBase,
} from "../effect-base";

/**
 * What a VISUAL effect kind declares, and the field blocks the families build
 * from. Lives here rather than in `layer-effects.ts` so a family file can
 * import it without importing the registry that imports the families back.
 */


export interface LayerEffectTypeDef extends EffectTypeDefBase<LayerEffect> {
  type: LayerEffectType;
  /**
   * The card's output changes with TIME, not only with its fields — so a
   * still preview is lying about it. Declared once here and read by the effect
   * editor (which runs its own clock so the preview stays alive on a parked
   * playhead) and by anything else that has to know "is this thing moving?".
   *
   * It is a flag rather than "does it carry the temporal clock?" because glass
   * is time-driven through `rippleSpeed` without carrying the clock at all —
   * deriving it from field names would quietly get glass wrong. A PREDICATE
   * narrows it to the instance: glass moves only while its ripple is driven,
   * and a `true` for every pane cost a full document re-render per frame in
   * the effect editor's preview while the user sat paused on a still one.
   */
  timeDriven?: boolean | ((effect: LayerEffect) => boolean);
  /**
   * The picture is tied to the DOCUMENT's pixel grid — a grain cell, a
   * scanline, a halftone dot, a pixelate block is a size in frame pixels that
   * rendering at a finer grid would change. Only such a card pins its layer to
   * document resolution on the stage; every other card scales its fields
   * exactly and renders at screen resolution, so a shadowed or boiled layer
   * stays as crisp as its neighbours when you zoom in.
   */
  gridBound?: boolean;
  /**
   * WHICH PICTURE the card shows at `timeSec`, for a time-driven card whose
   * output changes only in STEPS — a pure function of its temporal step, never
   * of time within one. Equal answers are identical pixels, so a layer whose
   * only motion is such cards holds still between steps, and a card that
   * loops (Line boil's N drawings) repeats pictures every cache can reuse:
   * three drawings are three renders for the whole timeline, not one per
   * frame. Null (or absent) = the card flows continuously here.
   *
   * Read off the card's STATIC fields: `picture-steady` only asks it of cards
   * with no keyed field, and a driver or modulator already makes the whole
   * layer move. See `steppedPicture` for the one implementation.
   */
  picture?: (effect: LayerEffect, timeSec: number) => string | null;
  /**
   * The card samples the pixels BEHIND the layer — the composite beneath it,
   * not only the layer's own.
   *
   * Declared here because the renderer has to answer that question twice, in
   * two files, at two different moments: once at the layer-tree walk (do we
   * build a painter for the scene beneath?) and once when the effect stack runs
   * (do we allocate and fill a backdrop buffer?). Both used to carry their own
   * `type === "glass"` test. Two answers to one question is the bug: a second
   * material would be added to one of them and silently refract nothing in the
   * other, which is exactly the failure that shipped once already.
   *
   * An instance may still opt out — see `layerEffectReadsBackdrop`.
   */
  readsBackdrop?: boolean;
  /**
   * The card is an OBJECT its layer places — a lens, a shockwave — so its px
   * lengths are lengths on the carrier and scale with it (scale the layer to
   * push in and the hole grows with the disk). Every other card's px are the
   * comp's, the same at any layer scale.
   */
  placed?: boolean;
  /**
   * The card CUTS HOLES in an opaque picture by design — a screen's gaps
   * (pixelate cells, halftone marks with no paper), a matte. Its output is
   * not the input recoloured; where it leaves nothing, nothing must show.
   *
   * Read by the adjustment layer, which grades pixels it does not own: it lays
   * its result over the picture it read unless it CONSUMES that picture first.
   * It consumed only for a sizing pose, so an LED board on an adjustment layer
   * showed the original photo in every gap between its dots. A carving card
   * makes it consume (`scope.source: "replace"`, the default), so the gaps show
   * the comp's paper — what the same card shows on a layer or a camera group.
   */
  carves?: boolean;
}

// ── Shared field blocks ──────────────────────────────────────────────────────
// Written once and spread into every card that needs them. Four cards declaring
// their own "Seed / Rate / Jitter" rows is four chances for the labels, ranges
// and hints to drift apart — and the fields are the user's mental model of the
// feature, so drift there is drift in the feature itself.

const BLEND_LABELS: Record<(typeof EFFECT_BLEND_MODES)[number], string> = {
  "source-over": "Normal",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  "soft-light": "Soft light",
  "hard-light": "Hard light",
  "color-dodge": "Color dodge",
  "color-burn": "Color burn",
  difference: "Difference",
  lighter: "Add",
};

const BLEND_OPTIONS: EffectFieldOption[] = EFFECT_BLEND_MODES.map((value) => ({ value, label: BLEND_LABELS[value] }));

/** The blend-mode row, identical on every card that composites over its layer. */
export function blendField(group?: string): EffectFieldDef {
  return {
    key: "blend",
    label: "Blend",
    kind: "select",
    options: BLEND_OPTIONS,
    group,
    hint: "How the generated texture combines with the layer. Overlay and Soft light keep the midtones and let blacks and whites resist — the way emulsion behaves.",
  };
}

/**
 * THE stepped `picture` for a card on the temporal clock: its step index, or
 * its place in a loop of `loopField` drawings. `when` narrows it to instances
 * that really are stepped (noise is, until it drifts). Reads the clock exactly
 * as the renderer does — `resolveTemporalStep` over seed/rate/jitter/stutter.
 */
export function steppedPicture(opts: {
  loopField?: string;
  when?: (effect: LayerEffect) => boolean;
} = {}): (effect: LayerEffect, timeSec: number) => string | null {
  return (effect, timeSec) => {
    if (opts.when && !opts.when(effect)) return null;
    const v = effect as unknown as Record<string, number>;
    const { index } = resolveTemporalStep(
      { seed: Math.round(Number(v.seed) || 0), rate: Number(v.rate) || 24, jitter: Number(v.jitter) || 0, stutter: Number(v.stutter) || 0 },
      ownClockSec(effect, timeSec),
    );
    const loop = opts.loopField ? Math.max(0, Math.round(Number(v[opts.loopField]) || 0)) : 0;
    return String(loop > 0 ? ((index % loop) + loop) % loop : index);
  };
}

/** Rows that only mean something while the card moves on its own. */
export const WHILE_MOVING = { key: "animate", equals: [true] } as const;

/**
 * THE `Animate` SWITCH — the master row of every self-moving card's clock
 * section (`ownMotion` in the schema). The rows it gates hide when it is off,
 * and the editor puts a switch other rows depend on first in its section.
 */
export function animateToggle(group: string): EffectToggleDef {
  return {
    key: "animate",
    label: "Animate",
    group,
    hint: "Off, it holds one look for the whole clip. Keys still play.",
  };
}

/** The temporal-clock rows. See `animation/temporal.ts` for the model. */
export function temporalFields(group = "time"): EffectFieldDef[] {
  return [
    {
      key: "rate",
      label: "Rate",
      kind: "number",
      min: 0.1,
      max: 120,
      step: 0.1,
      unit: "hz",
      group,
      showIf: WHILE_MOVING,
      hint: "How many times a second the texture re-rolls. 24 holds each look for a film frame; raise it to your project's fps for a fresh roll every frame; drop it below 8 for a hand-cranked stutter.",
    },
    {
      key: "jitter",
      label: "Jitter",
      kind: "number",
      min: 0,
      max: 1,
      step: 0.01,
      group,
      showIf: WHILE_MOVING,
      hint: "Randomness of TIME itself — how irregular the re-roll beats are. 0 is a metronome, 1 is a slipping projector.",
    },
    {
      key: "stutter",
      label: "Stutter",
      kind: "number",
      min: 0,
      max: 1,
      step: 0.01,
      group,
      showIf: WHILE_MOVING,
      hint: "Chance that a beat holds the previous look instead of rolling a new one — a frame sticking in the gate.",
    },
    {
      key: "seed",
      label: "Seed",
      kind: "number",
      min: 0,
      max: 99999,
      step: 1,
      group,
      hint: "Which look. Nudge it to re-roll one you don't like; what you export is exactly what you approved.",
    },
  ];
}

/** Default clock values, spread into each `create()` beside its own defaults. */
export function temporalDefaults(over: { rate?: number; jitter?: number; stutter?: number; seed?: number } = {}) {
  return { seed: over.seed ?? 1, rate: over.rate ?? 24, jitter: over.jitter ?? 0, stutter: over.stutter ?? 0 };
}

/** The section header the clock fields render under, in every card. */
export const TIME_GROUP: EffectFieldGroupDef = { id: "time", label: "Time" };



/**
 * The two rows every SELF-DRIVING card carries: how long one pass takes and how
 * long it waits first. Written once so a shine, a lightning strike and anything
 * that travels later cannot disagree about what "1.6 seconds" means — and so
 * every one of them animates from a PRESET, with no keyframes to author.
 *
 * `position` is deliberately NOT in here even though it is part of the same
 * clock: each card wants its own label for it ("Position" on a shine reads
 * differently from "Strike" on a bolt) and its own place in the field order.
 */
export function sweepFields(group?: string): EffectFieldDef[] {
  return [
    {
      key: "duration",
      label: "Duration",
      kind: "number",
      min: 0,
      max: 120,
      step: 0.05,
      unit: "s",
      group,
      showIf: WHILE_MOVING,
      hint: "Seconds for one full pass, taken from the clip's own time. Set it to 0 to park the pass wherever Position says and drive it by hand.",
    },
    {
      key: "delay",
      label: "Delay",
      kind: "number",
      min: 0,
      max: 120,
      step: 0.05,
      unit: "s",
      group,
      showIf: WHILE_MOVING,
      hint: "Stillness before each pass. Two cards with different delays is how you get a second sweep chasing the first.",
    },
  ];
}

/** Default sweep-clock values, spread into a `create()` beside its own. */
export function sweepDefaults(over: { position?: number; duration?: number; delay?: number; loop?: boolean } = {}) {
  return {
    position: over.position ?? 0.5,
    duration: over.duration ?? 1.6,
    delay: over.delay ?? 0,
    loop: over.loop ?? true,
  };
}

/** The section header the sweep fields render under. */
export const TRAVEL_GROUP: EffectFieldGroupDef = { id: "travel", label: "Travel" };

/** The `Loop` switch, identical on every card that carries the sweep clock. */
export const LOOP_TOGGLE: EffectToggleDef = {
  key: "loop",
  label: "Loop",
  group: "travel",
  showIf: WHILE_MOVING,
  hint: "Run the pass over and over. Off, it happens once and stays finished.",
};

/**
 * The `Inside` switch — clip what this card paints to the layer's own
 * silhouette. Shared because the answer is the same on every card that paints
 * something new over a layer, and because a stack where half the cards spell it
 * `inside` and half spell it `clip` is a stack nobody can preset across.
 */
export const INSIDE_TOGGLE = {
  key: "inside",
  label: "Inside layer",
  hint: "Keep what this card paints inside the layer's own shape. Off, it fills the whole region.",
} as const;

/** The master wet/dry row every rich card carries. */
export function mixField(group?: string): EffectFieldDef {
  return {
    key: "mix",
    label: "Mix",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    group,
    hint: "Blends the whole card over the untouched layer.",
  };
}

/**
 * Layer kinds that carry SOURCE PIXELS — the ones an effect can key, sample or
 * reconstruct from, as opposed to layers whose picture the renderer draws. The
 * one list behind every `appliesTo` that means "needs real footage".
 */
export const PIXEL_SOURCES = ["image", "video"] as const;
