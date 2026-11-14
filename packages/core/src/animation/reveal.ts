import type { LayerAnimationSpec } from "../schema/animation";
import type { VisualClip } from "../schema/clips";
import { evaluateEasing } from "../easing";
import type { PathCommand } from "../vector/geometry";
import { measureCommands } from "../vector/trim";
import { getPreset } from "./presets";

/**
 * DRAW-ON — the stroke reveal, as a layer animation.
 *
 * A pose (`GlyphVisual`) says where a layer IS: opacity, offset, scale, spin,
 * blur. It cannot say how much of a line has been drawn, and it must not learn
 * to: a text glyph, a Lottie transform and an adjustment's mix all read poses,
 * and none of them has an outline. So a reveal is a SECOND CHANNEL of the same
 * preset — same id, same duration, same easing, same in/out edges, same
 * retarget seam, dragged by the same timeline handle — that only a stroke
 * pipeline reads. `layerPoseAt` sees the identity pose and takes its fast
 * path; `layerRevealAt` is the reader that sees the reveal.
 *
 * The vocabulary is After Effects' Trim Paths (Simultaneously / Individually)
 * plus the stagger every SVG draw-on library ships (Vivus' `delayed`): the
 * three ways a set of strands can share one clock.
 */

export type RevealOrder = "together" | "sequence" | "stagger";
export type RevealDirection = "forward" | "backward" | "both";
export type RevealFill = "keep" | "along" | "late";

export interface Reveal {
  /** Eased progress: 0 nothing drawn, 1 fully drawn. */
  progress: number;
  order: RevealOrder;
  /**
   * Stagger only — how far into one strand's share the next one starts, as a
   * fraction of that share: 0 is together, 1 is back to back, above 1 leaves a
   * pause between strands.
   */
  stagger: number;
  /** Draw the bottom piece first (authoring order) or the top piece first. */
  topFirst: boolean;
  /** Where along each strand the ink starts, 0 = start, 1 = end. */
  origin: number;
  /** Which way the ink travels from the origin. */
  direction: RevealDirection;
  /** What the layer's fills do while the outline draws. */
  fill: RevealFill;
  /**
   * Width of the outline synthesised for a layer that has no stroke of its own
   * (frame px). A filled icon still draws on: its silhouette is inked in its
   * fill colour, then the fill arrives per `fill`.
   */
  pen: number;
}

/** Numeric encodings — a spec's params are numbers, so enums are indices. */
export const REVEAL_ORDERS: readonly RevealOrder[] = ["together", "sequence", "stagger"];
export const REVEAL_DIRECTIONS: readonly RevealDirection[] = ["forward", "backward", "both"];
export const REVEAL_FILLS: readonly RevealFill[] = ["keep", "along", "late"];

const pick = <T,>(list: readonly T[], v: number | undefined, fallback: T): T =>
  list[Math.round(v ?? -1)] ?? fallback;

/** Decode a preset's numeric params into a reveal at eased progress `t`. */
export function revealFromParams(t: number, p: Record<string, number>): Reveal {
  return {
    progress: Math.min(1, Math.max(0, t)),
    order: pick(REVEAL_ORDERS, p.order, "sequence"),
    stagger: Math.max(0, p.stagger ?? 0.5),
    topFirst: Math.round(p.topFirst ?? 0) === 1,
    origin: Math.min(1, Math.max(0, p.origin ?? 0)),
    direction: pick(REVEAL_DIRECTIONS, p.direction, "forward"),
    fill: pick(REVEAL_FILLS, p.fill, "late"),
    pen: Math.max(0.25, p.pen ?? 2),
  };
}

/**
 * A window along one strand: `[start, end]` as fractions of its length, plus
 * an `offset` in turns the window is rotated by — which is how the ink can
 * start anywhere along a strand and wrap around a closed one, the way a trim
 * path's offset already does.
 */
export type StrandWindow = readonly [start: number, end: number, offset: number];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * How far along each strand the ink has reached, given every strand's length
 * (in draw order) and the reveal. Pure arithmetic; the same table drives the
 * canvas, the SVG exporter, the Lottie translator and the picker's thumbnail.
 */
export function strandProgress(lengths: readonly number[], reveal: Reveal): number[] {
  const n = lengths.length;
  const p = reveal.progress;
  if (n === 0) return [];
  // Top-first is the same clock read from the other end of the list.
  const ordered = reveal.topFirst ? [...lengths].reverse() : lengths;
  let out: number[];
  if (reveal.order === "together") out = ordered.map(() => p);
  else if (reveal.order === "sequence") {
    // Along the total length: the pen never lifts, so a long strand takes
    // longer than a short one — what a single trimmed path already does.
    const total = ordered.reduce((a, b) => a + b, 0);
    if (total <= 0) out = ordered.map(() => p);
    else {
      let before = 0;
      out = ordered.map((len) => {
        const a = before / total;
        before += len;
        const b = before / total;
        return b <= a ? (p >= b ? 1 : 0) : clamp01((p - a) / (b - a));
      });
    }
  } else {
    // Stagger: every strand takes the same share of the clock, each starting
    // `stagger` shares after the last. 0 collapses to together, 1 is strictly
    // one after another by count, 1.5 leaves half a share of pause between.
    const step = reveal.stagger;
    const d = 1 / (1 + (n - 1) * step);
    out = ordered.map((_, i) => clamp01((p - i * step * d) / d));
  }
  return reveal.topFirst ? out.reverse() : out;
}

/** The window of each strand — progress turned into "which part is inked". */
export function strandWindows(lengths: readonly number[], reveal: Reveal): StrandWindow[] {
  return strandProgress(lengths, reveal).map((w) => windowAt(w, reveal));
}

/**
 * One strand's window for an inked fraction `w`: a span of `w` rotated so it
 * grows out of the origin the way the direction says. Forward from 0 is the
 * plain `[0, w]`; anything else is the same span at another offset, which a
 * closed strand wraps and an open strand splits — the trim stage's contract.
 */
export function windowAt(w: number, reveal: Reveal): StrandWindow {
  const o = reveal.origin;
  if (reveal.direction === "backward") return [0, w, o - w];
  if (reveal.direction === "both") return [0, w, o - w / 2];
  return [0, w, o];
}

/** Opacity multiplier for the layer's fills under this reveal. */
export function revealFillAlpha(reveal: Reveal): number {
  switch (reveal.fill) {
    case "keep":
      return 1;
    case "along":
      return reveal.progress;
    case "late":
      // The fill arrives while the last of the outline is being inked.
      return clamp01((reveal.progress - 0.7) / 0.3);
  }
}

/** Is this the do-nothing reveal (everything inked, fills untouched)? */
export function isFullReveal(reveal: Reveal): boolean {
  return reveal.progress >= 1;
}

/* ------------------------------------------------------------------------- */
/* The layer edge → a reveal                                                 */
/* ------------------------------------------------------------------------- */

/** Does this preset draw an outline (has a reveal channel)? */
export function presetReveals(presetId: string): boolean {
  return getPreset(presetId)?.reveal !== undefined;
}

/** Does the layer carry any reveal-channel animation on either edge? */
export function hasRevealAnimation(clip: VisualClip): boolean {
  return (
    (clip.animIn !== null && presetReveals(clip.animIn.preset)) ||
    (clip.animOut !== null && presetReveals(clip.animOut.preset))
  );
}

/**
 * Does the layer carry a POSE animation — one the compositor has to isolate
 * for? A draw-on paints inside the layer's own strokes and needs no buffer.
 */
export function hasPoseAnimation(clip: VisualClip): boolean {
  return (
    (clip.animIn !== null && !presetReveals(clip.animIn.preset)) ||
    (clip.animOut !== null && !presetReveals(clip.animOut.preset))
  );
}

function evalRevealSpec(
  spec: LayerAnimationSpec,
  localMs: number,
  phase: "in" | "out",
  clipDurationMs: number,
): Reveal | null {
  const def = getPreset(spec.preset);
  if (!def?.reveal) return null;
  const dur = Math.max(1, spec.durationMs);
  const start = phase === "in" ? 0 : Math.max(0, clipDurationMs - dur);
  const raw = Math.min(1, Math.max(0, (localMs - start) / dur));
  if (phase === "in" && raw >= 1) return null;
  if (phase === "out" && raw <= 0) return null;
  const eased = evaluateEasing(spec.easing, raw);
  // An exit is the entrance played backwards: the ink lifts the way it landed.
  return def.reveal(phase === "in" ? eased : evaluateEasing(spec.easing, 1 - raw), spec.params);
}

/**
 * The layer's OWN reveal at a clip-local time, or null when its outline is
 * whole. Mirrors `layerPoseAt` exactly — same edges, same timing arithmetic —
 * so the two channels of one preset can never disagree about when it plays.
 */
export function layerRevealAt(clip: VisualClip, localMs: number): Reveal | null {
  if (!hasRevealAnimation(clip)) return null;
  if (clip.animIn) {
    const r = evalRevealSpec(clip.animIn, localMs, "in", clip.durationMs);
    if (r) return r;
  }
  if (clip.animOut) {
    const r = evalRevealSpec(clip.animOut, localMs, "out", clip.durationMs);
    if (r) return r;
  }
  return null;
}

/* ------------------------------------------------------------------------- */
/* Strand lengths                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Arc length of each subpath in a command list, memoised on the list itself.
 * Command arrays are rebuilt per render, so callers that want the memo to hit
 * pass a STABLE list (a clip's declared geometry compiled once) — see
 * `contourLengths` in `vector/reveal-strands.ts`.
 */
const lengthMemo = new WeakMap<readonly PathCommand[], number[]>();
export function subpathLengths(cmds: readonly PathCommand[]): number[] {
  let hit = lengthMemo.get(cmds);
  if (!hit) {
    hit = measureCommands(cmds);
    lengthMemo.set(cmds, hit);
  }
  return hit;
}
