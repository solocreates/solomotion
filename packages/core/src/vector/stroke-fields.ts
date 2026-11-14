import type { EffectFieldDef, EffectFieldGroupDef } from "../animation/effect-base";
import { STROKE_MARKER_KINDS, type StrokeStyle } from "../schema/vector";
import { setStrokeScalar, strokeScalar } from "./stroke";

/**
 * THE description of a line — one registry, and the reason a vector brush and a
 * layer's stroke can stop being two features.
 *
 * They were always the same object described twice: a brush said "taper 14px,
 * round cap, jitter 0.2" and a stroke said "taper 20%, round cap, wave 3px",
 * and neither could express the other's half. This table is the single
 * vocabulary both now speak, so the Brush Studio and the stroke editor render
 * the SAME panel from the SAME defs, and a brush you save shows up as a stroke
 * set because it literally is one.
 *
 * It is `EffectFieldDef[]` on purpose rather than a new shape. That contract
 * already carries label, range, step, unit, hint, group and `showIf`, and the
 * app already has one renderer for it — the effect editor window — which brings
 * sliders, keyframe diamonds, modulator badges, presets and reset along for
 * free. A bespoke stroke panel would have re-earned all of that by hand and
 * then drifted from it.
 *
 * `key` is the same suffix `stroke.<id>.<key>` uses everywhere else, so a field
 * added here is animatable, bindable and modulatable with nothing else written.
 */

export const STROKE_FIELD_GROUPS: EffectFieldGroupDef[] = [
  { id: "line", label: "Line" },
  { id: "ends", label: "Ends" },
  { id: "dash", label: "Dash" },
  { id: "trim", label: "Trim" },
  { id: "taper", label: "Taper" },
  { id: "wave", label: "Wave", collapsed: true },
];

const markerOptions = STROKE_MARKER_KINDS.map((k) => ({
  value: k,
  label: k === "none" ? "None" : k === "arrow-line" ? "Line arrow" : k[0]!.toUpperCase() + k.slice(1),
}));

export const STROKE_FIELDS: EffectFieldDef[] = [
  // ── Line ──
  { key: "width", label: "Width", kind: "number", group: "line", min: 0, max: 200, step: 0.5, unit: "px" },
  { key: "opacity", label: "Opacity", kind: "number", group: "line", min: 0, max: 1, step: 0.01, unit: "%" },
  {
    key: "align", label: "Align", kind: "select", group: "line",
    hint: "Which side of the outline the width sits on.",
    options: [
      { value: "center", label: "Center" },
      { value: "inside", label: "Inside" },
      { value: "outside", label: "Outside" },
    ],
  },

  // ── Ends ──
  {
    key: "cap", label: "Cap", kind: "select", group: "ends",
    options: [
      { value: "butt", label: "Flat" },
      { value: "round", label: "Round" },
      { value: "square", label: "Square" },
    ],
  },
  {
    key: "join", label: "Corner", kind: "select", group: "ends",
    options: [
      { value: "miter", label: "Sharp" },
      { value: "round", label: "Round" },
      { value: "bevel", label: "Bevel" },
    ],
  },
  {
    key: "markers.start.kind", label: "Start", kind: "select", group: "ends",
    hint: "Endpoint decoration. Open paths only — a closed shape has no ends.",
    options: markerOptions,
  },
  {
    key: "markers.start.size", label: "Start size", kind: "number", group: "ends",
    min: 0, max: 20, step: 0.1, unit: "×",
    showIf: { key: "markers.start.kind", equals: STROKE_MARKER_KINDS.filter((k) => k !== "none") },
  },
  { key: "markers.end.kind", label: "End", kind: "select", group: "ends", options: markerOptions },
  {
    key: "markers.end.size", label: "End size", kind: "number", group: "ends",
    min: 0, max: 20, step: 0.1, unit: "×",
    showIf: { key: "markers.end.kind", equals: STROKE_MARKER_KINDS.filter((k) => k !== "none") },
  },

  // ── Dash ──
  { key: "dashLength", label: "Dash", kind: "number", group: "dash", min: 0, max: 200, step: 1, unit: "px" },
  { key: "dashGap", label: "Gap", kind: "number", group: "dash", min: 0, max: 200, step: 1, unit: "px" },
  {
    key: "dashOffset", label: "Offset", kind: "number", group: "dash", min: -400, max: 400, step: 1, unit: "px",
    bipolar: true, hint: "Slides the pattern along the line. Keyframe it for marching ants.",
  },

  // ── Trim ──
  {
    key: "trim.start", label: "Start", kind: "number", group: "trim", min: 0, max: 1, step: 0.01, unit: "%",
    hint: "Draws only this slice of the outline. Each stroke trims on its own.",
  },
  { key: "trim.end", label: "End", kind: "number", group: "trim", min: 0, max: 1, step: 0.01, unit: "%" },
  {
    key: "trim.offset", label: "Offset", kind: "number", group: "trim", min: -2, max: 2, step: 0.01, unit: "%",
    bipolar: true, hint: "Rotates the window around the path — a chase around a closed shape.",
  },

  // ── Taper ──
  {
    key: "profile.startWidth", label: "Start width", kind: "number", group: "taper", min: 0, max: 4, step: 0.01, unit: "%",
    hint: "Width at the start, as a share of the stroke width. 100% is uniform.",
  },
  { key: "profile.endWidth", label: "End width", kind: "number", group: "taper", min: 0, max: 4, step: 0.01, unit: "%" },
  { key: "profile.startLength", label: "Start length", kind: "number", group: "taper", min: 0, max: 1, step: 0.01, unit: "%" },
  { key: "profile.endLength", label: "End length", kind: "number", group: "taper", min: 0, max: 1, step: 0.01, unit: "%" },
  {
    key: "profile.ease", label: "Ease", kind: "number", group: "taper", min: -1, max: 1, step: 0.01,
    bipolar: true, hint: "Negative eases into the taper, positive eases out of it.",
  },

  // ── Wave ──
  {
    key: "wave.amplitude", label: "Amount", kind: "number", group: "wave", min: 0, max: 200, step: 0.5, unit: "px",
    hint: "Displaces the line along its own normal. 0 keeps it exact.",
  },
  { key: "wave.wavelength", label: "Length", kind: "number", group: "wave", min: 1, max: 400, step: 1, unit: "px" },
  {
    key: "wave.roughness", label: "Rough", kind: "number", group: "wave", min: 0, max: 1, step: 0.01, unit: "%",
    hint: "0 is a clean sine, 100% a hand-drawn wobble.",
  },
  {
    key: "wave.phase", label: "Phase", kind: "number", group: "wave", min: -8, max: 8, step: 0.01, bipolar: true,
    hint: "Keyframe it to crawl the wave along the stroke.",
  },
  { key: "wave.seed", label: "Seed", kind: "number", group: "wave", min: 0, max: 9999, step: 1 },
];

/** The enum fields, so `strokeField` can route without a second list. */
const ENUM_KEYS = new Set(["align", "cap", "join", "markers.start.kind", "markers.end.kind"]);

/**
 * Read any field of the registry off a stroke. Numbers go through the scalar
 * table in `stroke.ts`; enums are the handful this file names. One reader, so
 * the editor, the preview and the preset capture cannot disagree.
 */
export function strokeField(s: StrokeStyle, key: string): number | string {
  switch (key) {
    case "align": return s.align;
    case "cap": return s.cap;
    case "join": return s.join;
    case "markers.start.kind": return s.markers.start.kind;
    case "markers.end.kind": return s.markers.end.kind;
    default: return strokeScalar(s, key) ?? 0;
  }
}

/** Write any field of the registry onto a stroke, clamped/validated. */
export function setStrokeField(s: StrokeStyle, key: string, value: number | string): void {
  if (!ENUM_KEYS.has(key)) {
    if (typeof value === "number") setStrokeScalar(s, key, value);
    return;
  }
  const v = String(value);
  switch (key) {
    case "align":
      if (v === "center" || v === "inside" || v === "outside") s.align = v;
      return;
    case "cap":
      if (v === "butt" || v === "round" || v === "square") s.cap = v;
      return;
    case "join":
      if (v === "miter" || v === "round" || v === "bevel") s.join = v;
      return;
    case "markers.start.kind":
    case "markers.end.kind": {
      const kind = STROKE_MARKER_KINDS.find((k) => k === v);
      if (!kind) return;
      if (key === "markers.start.kind") s.markers.start.kind = kind;
      else s.markers.end.kind = kind;
      return;
    }
  }
}

/** Every registry field's value on a stroke — feeds preset capture and reset. */
export function strokeFieldValues(s: StrokeStyle): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const f of STROKE_FIELDS) out[f.key] = strokeField(s, f.key);
  return out;
}

/**
 * The fields a BRUSH does not get to set. A brush's `width` is its size slider
 * and its `opacity` is its own; both are per-gesture, not part of the look, and
 * showing them twice in the studio would be two controls for one number.
 */
export const BRUSH_HIDDEN_STROKE_FIELDS = new Set(["width", "opacity", "align"]);
