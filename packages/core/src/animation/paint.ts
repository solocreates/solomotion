import type { KeyframeValue } from "../schema";
import type { GradientStop, Paint } from "../schema/vector";
import { isGradientPaint } from "../schema/vector";
import { effectFieldVisible } from "./effect-base";
import { lerpColor, parseHexColor } from "./properties";
import { PATTERN_COLOR_FIELDS, PATTERN_FIELDS, patternScalar, setPatternScalar } from "../vector/pattern-fields";

/**
 * Paint sub-property addressing — the keyframe engine's window into a Paint.
 * Sub-paths (relative to the "fill"/"stroke" prefix):
 *
 *   color               solid color (the classic path — old keys keep working)
 *   start.x, start.y    gradient start handle (normalized box space)
 *   end.x, end.y        gradient end handle (normalized box space)
 *   stop.<id>.offset    one gradient stop's position (0–1)
 *   stop.<id>.color     one gradient stop's color
 *   pattern.<field>     any field of a pattern paint (see PATTERN_FIELDS)
 *
 * Geometry is one unified pair of points for every gradient type (see the
 * schema note on `gradientGeometryFields`), so a linear/radial/angular switch
 * keeps every geometry + stop key alive. Everything returns undefined / no-ops
 * when the paint's type doesn't carry that field.
 */

const STOP = /^stop\.([^.]+)\.(offset|color)$/;
const POINT = /^(start|end)\.(x|y)$/;
const PATTERN = /^pattern\.(.+)$/;

/**
 * Every sub-path this paint carries right now (`stop.<id>.color`, `start.x`,
 * `pattern.spacing`…) — the enumerating half of `paintProperty`, so the list
 * agents read (`clipAnimatableProperties`) and the resolver can never disagree
 * about what a paint exposes. A pattern lists only the fields its kind draws
 * with (the studio's own `showIf`), so a dot lattice offers no zigzag swing.
 */
export function paintSubPaths(paint: Paint): string[] {
  if (paint.type === "pattern") {
    const spec = paint.pattern as unknown as Record<string, unknown>;
    return [
      ...PATTERN_COLOR_FIELDS.map((c) => `pattern.${c.key}`),
      ...PATTERN_FIELDS.filter((f) => effectFieldVisible(f, spec)).map((f) => `pattern.${f.key}`),
    ];
  }
  if (!isGradientPaint(paint)) return [];
  return [
    "start.x", "start.y", "end.x", "end.y",
    ...paint.stops.flatMap((s) => [`stop.${s.id}.color`, `stop.${s.id}.offset`]),
  ];
}

export function paintProperty(paint: Paint, sub: string): KeyframeValue | undefined {
  // A LINKED paint answers with its override, or with nothing. It cannot answer
  // with the style's value — the style lives in the document and this function
  // has only the paint. Callers that want the inherited value resolve the paint
  // first (`resolvePaint`), which is the one place the two are merged.
  if (paint.type === "variable") return paint.overrides?.[sub];
  if (sub === "color") return paint.type === "solid" ? paint.color : undefined;
  // Pattern fields — `pattern.<field>`, the flat spec's whole surface. Colours
  // and numbers alike, so a stripe's mark colour keyframes exactly as its
  // spacing does and neither needs a path scheme of its own.
  const pat = PATTERN.exec(sub);
  if (pat) {
    if (paint.type !== "pattern") return undefined;
    const key = pat[1]!;
    if (key === "color" || key === "background") return paint.pattern[key];
    return patternScalar(paint.pattern, key);
  }
  // Only gradients carry geometry/stop sub-paths; media/pattern keyframe (later)
  // through their own paths, not these.
  if (!isGradientPaint(paint)) return undefined;
  const pt = POINT.exec(sub);
  if (pt) return paint[pt[1] as "start" | "end"][pt[2] as "x" | "y"];
  const m = STOP.exec(sub);
  if (m) {
    const stop = paint.stops.find((s) => s.id === m[1]);
    if (!stop) return undefined;
    return m[2] === "offset" ? stop.offset : stop.color;
  }
  return undefined;
}

export function setPaintProperty(paint: Paint, sub: string, value: KeyframeValue): void {
  /**
   * Writing to a LINKED paint records an OVERRIDE.
   *
   * This one branch is the whole write half of the override model, and it is
   * why nothing else had to change: every surface that edits a paint — the
   * picker, the gradient rail, the pattern studio, record mode, a modulator —
   * already funnels through here with a sub-path. Before this, all of them
   * wrote into a reference that carries no colour, no stops and no pattern to
   * receive the value, and it vanished without a sound.
   */
  if (paint.type === "variable") {
    if (typeof value === "string" || typeof value === "number") {
      (paint.overrides ??= {})[sub] = value;
    }
    return;
  }
  if (sub === "color") {
    if (paint.type === "solid" && typeof value === "string") paint.color = value;
    return;
  }
  const pat = PATTERN.exec(sub);
  if (pat) {
    if (paint.type !== "pattern") return;
    const key = pat[1]!;
    if (key === "color" || key === "background") {
      if (typeof value === "string") paint.pattern[key] = value;
      return;
    }
    if (typeof value === "number") setPatternScalar(paint.pattern, key, value);
    return;
  }
  if (!isGradientPaint(paint)) return;
  const pt = POINT.exec(sub);
  if (pt && typeof value === "number") {
    paint[pt[1] as "start" | "end"][pt[2] as "x" | "y"] = value;
    return;
  }
  const m = STOP.exec(sub);
  if (m) {
    const stop = paint.stops.find((s) => s.id === m[1]);
    if (!stop) return;
    if (m[2] === "offset" && typeof value === "number") stop.offset = Math.min(1, Math.max(0, value));
    else if (m[2] === "color" && typeof value === "string") stop.color = value;
  }
}

/**
 * Apply every sampled keyframe under `prefix` onto a copy of the base paint —
 * how the renderer builds the paint it actually draws. `prefix` is the entry's
 * addressable root: `fill.<paintId>` for a fill, `stroke.<strokeId>` for a
 * stroke's paint. The bare prefix itself addresses the solid color.
 */
export function paintWithSampled(
  base: Paint,
  prefix: string,
  sampled: Record<string, KeyframeValue>,
): Paint {
  let out: Paint | null = null;
  for (const key of Object.keys(sampled)) {
    let sub: string;
    if (key === prefix) sub = "color";
    else if (key.startsWith(prefix + ".")) sub = key.slice(prefix.length + 1);
    else continue;
    // Entry-level scalars live on the fill/stroke entry, not inside the paint.
    if (sub === "width" || sub === "opacity" || sub === "dashLength" || sub === "dashGap") continue;
    out ??= structuredClone(base);
    setPaintProperty(out, sub, sampled[key]!);
  }
  return out ?? base;
}

/** The gradient's color at an offset — new stops land IN the ramp, not on a default. */
export function gradientColorAt(stops: GradientStop[], offset: number): string {
  const sorted = [...stops].sort((a, b) => a.offset - b.offset);
  if (sorted.length === 0) return "#ffffff";
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (offset <= first.offset) return first.color;
  if (offset >= last.offset) return last.color;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (offset >= a.offset && offset <= b.offset) {
      const t = b.offset === a.offset ? 0 : (offset - a.offset) / (b.offset - a.offset);
      // Var tokens can't blend — hold the nearer stop.
      if (!parseHexColor(a.color) || !parseHexColor(b.color)) return t < 0.5 ? a.color : b.color;
      return lerpColor(a.color, b.color, t);
    }
  }
  return last.color;
}

// ── Style-link overrides ─────────────────────────────────────────────────────
//
// The read half of the model whose write half is `setPaintProperty` above. It
// deliberately mirrors the text scope's `overrideEntries` / `isOverridden` /
// `clearOverride` trio: a linked fill and a caption's focus scope are the same
// idea — a sparse map of paths laid over an inherited base — so they should be
// the same three questions, asked the same way, or the two will drift into two
// mental models for one concept.

/** One property this entry has taken over from the style it links to. */
export interface PaintOverride {
  /** The paint sub-path (`start.x`, `stop.<id>.color`, `pattern.spacing`). */
  path: string;
  value: string | number;
}

/** Everything this entry overrides, or an empty list. Pure read — it can never
 *  report an override that isn't there, whichever panel is asking. */
export function paintOverrides(paint: Paint): PaintOverride[] {
  if (paint.type !== "variable" || !paint.overrides) return [];
  return Object.entries(paint.overrides).map(([path, value]) => ({ path, value }));
}

/** Is this exact property mine, or still the style's? THE question a field's
 *  revert dot asks. */
export function isPaintOverridden(paint: Paint, sub: string): boolean {
  return paint.type === "variable" && paint.overrides?.[sub] !== undefined;
}

/** Hand ONE property back to the style. Removes the map when it empties, so a
 *  link that overrides nothing carries nothing into the file — the same rule
 *  `modulators` and `keyframes` follow. */
export function clearPaintOverride(paint: Paint, sub: string): void {
  if (paint.type !== "variable" || !paint.overrides) return;
  delete paint.overrides[sub];
  if (Object.keys(paint.overrides).length === 0) delete paint.overrides;
}

/** Hand every property back — "reset to the style". */
export function clearPaintOverrides(paint: Paint): void {
  if (paint.type === "variable") delete paint.overrides;
}
