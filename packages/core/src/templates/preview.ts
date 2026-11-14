import { evalSpecAtUnit } from "../animation/evaluate";
import type { GlyphVisual } from "../animation/presets";
import { segmentTextCached, unitIndexOf, unitCountOf } from "../text/segment";
import { animationSpanMs, unitSeed } from "../text/schedule";
import type { AnimationSpec, AnimationUnit } from "../schema";
import type { TemplatePalette } from "./prefs";

/**
 * THE PREVIEW PLAN — how a look's sample text breaks into animating pieces,
 * and where each piece is at a given instant.
 *
 * It lives in core, headless, for the reason every preview in this app
 * eventually learns: a card that draws itself from its own idea of the motion
 * is a picture that is WRONG, and wrong in the most expensive way — it looks
 * fine, so nobody checks it against the canvas until a user does. Everything
 * here delegates: the segmentation is the segmenter's, the per-unit timing is
 * the schedule's, the pose is `evalSpecAtUnit` — the same function the stage
 * and the exporter call. There is no second implementation to drift.
 */

/** One animating piece of the specimen: the text to draw and its unit ordinal. */
export interface LookUnit {
  /** Position in the returned list — a stable React key. */
  key: number;
  text: string;
  /** Ordinal within the animation's unit grain; what the stagger is keyed on. */
  index: number;
}

/**
 * Split `text` into runs at the animation's grain.
 *
 * Whitespace rides the unit before it (that is `unitIndexOf`'s rule, not a
 * decision made here), which is why grouping consecutive graphemes by unit
 * index yields contiguous runs and no separate whitespace pieces to lay out.
 * A newline stays inside its run and is rendered by `white-space: pre-wrap`,
 * so a two-line look previews on two lines.
 */
export function lookUnits(text: string, unit: AnimationUnit): LookUnit[] {
  const seg = segmentTextCached(text);
  const out: LookUnit[] = [];
  let current: LookUnit | null = null;
  for (let i = 0; i < seg.graphemes.length; i++) {
    const index = unitIndexOf(seg, i, unit);
    if (!current || current.index !== index) {
      current = { key: out.length, text: "", index };
      out.push(current);
    }
    current.text += seg.graphemes[i]!.char;
  }
  return out;
}

/** How many units the grain sees — the cohort size the stagger divides. */
export function lookUnitCount(text: string, unit: AnimationUnit): number {
  return unitCountOf(segmentTextCached(text), unit);
}

/**
 * The pose of one unit at `localMs`. A thin, named face over the evaluator so a
 * preview never has to know about cohorts, anchors or phases it does not have.
 */
export function lookPoseAt(
  spec: AnimationSpec,
  unitIndex: number,
  unitCount: number,
  localMs: number,
  /** Salt for the spec's own jitter/scatter — any stable string will do. */
  id = "preview",
): GlyphVisual {
  const seed = unitSeed(id, "in", 0, unitIndex);
  return evalSpecAtUnit(spec, unitIndex, unitCount, localMs, "in", 0, seed);
}

/**
 * How long the whole specimen takes to finish arriving, jitter included — what
 * a looping preview measures its cycle against. A card that loops on a fixed
 * duration cuts a slow cascade off halfway and holds a fast pop on a still
 * frame for a second; both read as broken rather than as slow or fast.
 */
export function lookSpanMs(spec: AnimationSpec | null, unitCount: number): number {
  if (!spec) return 0;
  return spec.delayMs + animationSpanMs(spec, unitCount) + spec.jitterMs;
}

// ── What a look is previewed ON ──────────────────────────────────────────────

/** Relative luminance (0 black, 1 white) of a `#RRGGBB` / `#RRGGBBAA`. */
export function colorLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})/i.exec(hex);
  if (!m) return 0.5;
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The ground a look should be previewed on, or null to use the surface's own.
 *
 * A third of a hundred looks are authored for a LIGHT backdrop — ink on paper,
 * biro on a page, a black news band, a marker on a whiteboard — and previewing
 * those on the app's dark tile shows an empty rectangle. Which is worse than a
 * bad preview: it reads as a broken card, and the looks it hits are exactly the
 * quiet, typographic ones that most need to be seen to be chosen.
 *
 * The palette already answers this. `shade` is by definition the neutral that
 * makes the identity legible, so a DARK identity means `shade` is the light one
 * and it is the ground the look was drawn against. Derived, not stored — which
 * is what makes it follow a recolour: drop a near-black brand ink into the
 * colour dial and every card flips to paper by itself.
 */
export function lookGround(palette: TemplatePalette): string | null {
  return colorLuminance(palette.ink) < 0.4 ? palette.shade : null;
}
