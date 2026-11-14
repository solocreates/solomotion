import type { EffectFieldDef, EffectFieldGroupDef } from "../animation/effect-base";
import { PATTERN_KINDS, type PatternKind, type PatternSpec } from "../schema/vector";

/**
 * THE description of a pattern — one registry, and the reason the Pattern
 * Studio, the keyframe engine, the binding menu and the modulator badges all
 * know about a new knob the moment it is named here.
 *
 * Same contract as `STROKE_FIELDS` (`EffectFieldDef[]`) for the same reason:
 * the app already has ONE renderer for that shape, and it brings sliders,
 * diamonds, drivers, presets and reset with it. A bespoke pattern panel would
 * have re-earned all of that by hand and then drifted from it.
 *
 * `key` is the suffix `fill.<id>.pattern.<key>` uses everywhere else, so a
 * field added here is animatable, bindable and modulatable with nothing else
 * written anywhere.
 *
 * `showIf` is how a kind declares which fields it uses — the FLAT spec's other
 * half. A field a kind cannot use is absent, never greyed, matching the effect
 * editor and the stroke panel.
 */

export const PATTERN_FIELD_GROUPS: EffectFieldGroupDef[] = [
  { id: "marks", label: "Marks" },
  // Collapsed: the lattice is how the tiling is PLACED (scale, angle, aspect,
  // phase), and it is dialled far less often than the marks themselves. Open by
  // default it doubled the studio's height for five rows most edits never
  // touch, which is what pushed the colour rows off the bottom of the panel.
  { id: "lattice", label: "Lattice", collapsed: true },
  { id: "variation", label: "Variation", collapsed: true },
];

/** Kinds that draw a discrete, repeating MARK — the ones `stagger` can shift
 *  into a brick lattice and `jitter` can scatter. */
const LATTICE_KINDS: PatternKind[] = ["dots", "squares", "triangles", "checks"];
/** Kinds whose marks have square corners worth rounding. */
const ROUNDABLE: PatternKind[] = ["checks", "squares", "cross", "zigzag"];
/** Everything except the image tile, which has no procedural marks at all. */
const PROCEDURAL: PatternKind[] = PATTERN_KINDS.filter((k) => k !== "image");
const WITH_THICKNESS: PatternKind[] = PROCEDURAL.filter((k) => k !== "checks" && k !== "triangles");

export const PATTERN_FIELDS: EffectFieldDef[] = [
  // -- Marks --
  {
    key: "spacing", label: "Spacing", kind: "number", group: "marks", min: 1, max: 400, step: 1, unit: "px",
    hint: "The period - one stripe to the next, one dot to the next.",
    showIf: { key: "kind", equals: PROCEDURAL },
  },
  {
    key: "thickness", label: "Weight", kind: "number", group: "marks", min: 0, max: 400, step: 0.5, unit: "px",
    hint: "How much of each period is painted.",
    showIf: { key: "kind", equals: WITH_THICKNESS },
  },
  {
    key: "amplitude", label: "Swing", kind: "number", group: "marks", min: 0, max: 200, step: 0.5,
    hint: "How far the line swings off its centre; the grain's contrast for noise.",
    showIf: { key: "kind", equals: ["zigzag", "waves", "noise"] },
  },
  {
    key: "roundness", label: "Round", kind: "number", group: "marks", min: 0, max: 1, step: 0.01, unit: "%",
    showIf: { key: "kind", equals: ROUNDABLE },
  },

  // -- Lattice --
  {
    key: "scale", label: "Scale", kind: "number", group: "lattice", min: 0.02, max: 20, step: 0.01, unit: "x",
    hint: "Multiplies every length. THE size knob - keyframe this one.",
  },
  { key: "angleDeg", label: "Angle", kind: "number", group: "lattice", min: -360, max: 360, step: 1, unit: "°", bipolar: true },
  {
    key: "aspect", label: "Aspect", kind: "number", group: "lattice", min: 0.1, max: 10, step: 0.01, unit: "x",
    hint: "Tile height over width. Squash the lattice without touching the marks.",
    showIf: { key: "kind", equals: PROCEDURAL },
  },
  {
    key: "offsetX", label: "Offset X", kind: "number", group: "lattice", min: -400, max: 400, step: 1, unit: "px",
    bipolar: true, hint: "Slides the tiling under the shape. Keyframe it to scroll.",
  },
  { key: "offsetY", label: "Offset Y", kind: "number", group: "lattice", min: -400, max: 400, step: 1, unit: "px", bipolar: true },

  // -- Variation --
  {
    key: "stagger", label: "Stagger", kind: "number", group: "variation", min: 0, max: 1, step: 0.01, unit: "%",
    hint: "Shifts alternate rows. 50% is a brick lay.",
    showIf: { key: "kind", equals: LATTICE_KINDS },
  },
  {
    key: "jitter", label: "Jitter", kind: "number", group: "variation", min: 0, max: 1, step: 0.01, unit: "%",
    hint: "Knocks each mark off the lattice. Seeded, so it never boils.",
    showIf: { key: "kind", equals: LATTICE_KINDS },
  },
  {
    key: "seed", label: "Seed", kind: "number", group: "variation", min: 0, max: 9999, step: 1,
    showIf: { key: "kind", equals: [...LATTICE_KINDS, "noise"] },
  },
];

/** The numeric fields, so a scalar write can refuse anything else without a
 *  second list of names to keep in step. */
const NUMERIC = new Set(PATTERN_FIELDS.map((f) => f.key));

/** Read one numeric field off a spec by its `pattern.<key>` suffix. */
export function patternScalar(p: PatternSpec, key: string): number | undefined {
  if (!NUMERIC.has(key)) return undefined;
  const v = (p as unknown as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}

/** Write one numeric field onto a spec, clamped to its registry range. */
export function setPatternScalar(p: PatternSpec, key: string, value: number): void {
  const field = PATTERN_FIELDS.find((f) => f.key === key);
  if (!field) return;
  const lo = field.min ?? -Infinity;
  const hi = field.max ?? Infinity;
  const v = Math.min(hi, Math.max(lo, value));
  (p as unknown as Record<string, number>)[key] = key === "seed" ? Math.round(v) : v;
}

/** The colour slots, in the order the studio shows them. Named here so the
 *  keyframe path synthesizer and the studio agree on what is a colour. */
export const PATTERN_COLOR_FIELDS = [
  { key: "color", label: "Mark" },
  { key: "background", label: "Ground" },
] as const;

/** Human labels for the kind switcher. */
export const PATTERN_KIND_LABELS: Record<PatternKind, string> = {
  stripes: "Stripes",
  grid: "Grid",
  checks: "Checks",
  dots: "Dots",
  squares: "Squares",
  cross: "Hatch",
  triangles: "Triangles",
  zigzag: "Zigzag",
  waves: "Waves",
  noise: "Noise",
  image: "Image",
};

/** The fields a kind actually uses - the flat spec's other half, resolved once
 *  so the studio, a preset capture and a reset all read the same answer. */
export function patternFieldsFor(kind: PatternKind): EffectFieldDef[] {
  return PATTERN_FIELDS.filter((f) => !f.showIf || f.showIf.equals.includes(kind));
}
