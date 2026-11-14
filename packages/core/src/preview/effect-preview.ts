import type { LayerEffect } from "../schema";
import type { PreviewResolutionSetting } from "./resolution";

/**
 * THE EFFECT EDITOR'S PREVIEW — the decisions, without a canvas.
 *
 * The preview is a CLIENT of the render pipeline, not a second renderer: the
 * scene around the layer is baked once (the stage's incremental scene), the
 * cards beneath the one you are editing are a kept prefix (the stage's steady
 * prefix, pinned at your card), and only your card's clock moves. What is left
 * to decide is policy, and policy lives here so it can be tested:
 *
 *   · WHAT is previewed — the card alone, the stack up to it, or all of it;
 *     the scene around the layer, the scene beneath it, or the layer alone.
 *   · HOW LONG the moving loop is before it repeats from memory.
 *   · WHEN it may render, and when it is too heavy to play unasked.
 */

/** Which cards the preview runs. */
export type EffectPreviewStack = "solo" | "through" | "all";
/** What surrounds the layer. */
export type EffectPreviewScene = "scene" | "beneath" | "alone";

export interface EffectPreviewSettings {
  stack: EffectPreviewStack;
  scene: EffectPreviewScene;
  resolution: PreviewResolutionSetting;
  /** Stop a moving preview that cannot keep up, until you press play. */
  pauseWhenHeavy: boolean;
}

/**
 * THROUGH, not ALL, by default: the stage already shows the whole stack, and
 * the preview's reason to exist is the card you are judging — a heavy blur
 * above it would hide exactly what you are tuning, and would cost a render
 * per tick for the privilege. When the card is the top one (the common case,
 * you just added it) the two are the same picture.
 */
export const DEFAULT_EFFECT_PREVIEW: EffectPreviewSettings = {
  stack: "through",
  scene: "scene",
  resolution: "auto",
  pauseWhenHeavy: true,
};

/**
 * The layer's cards as the preview runs them. Identity-preserving: the cards
 * kept are the same objects, so a kept prefix beneath the card stays valid
 * (`stackPrefixUnchanged`), and "all" returns the list itself.
 * An id the stack does not hold (a per-glyph card) leaves it untouched.
 */
export function previewStack<E extends LayerEffect>(effects: readonly E[], effectId: string, stack: EffectPreviewStack): readonly E[] {
  const at = effects.findIndex((e) => e.id === effectId);
  if (at < 0 || stack === "all") return effects;
  if (stack === "solo") return [effects[at]!];
  return at === effects.length - 1 ? effects : effects.slice(0, at + 1);
}

/** Loops shorter than this flicker; longer ones only cost memory. */
const MIN_LOOP_MS = 500;
const MAX_LOOP_MS = 6000;
/** A random card (grain, dust, noise) has no period — two seconds reads as endless. */
const RANDOM_LOOP_MS = 2000;
/** A one-shot sweep holds its end state briefly before the pass replays. */
const ONE_SHOT_HOLD_MS = 600;

/**
 * HOW LONG THE PREVIEW RUNS BEFORE IT REPEATS — and therefore how many frames
 * it keeps. A card with a SWEEP (shine, a wipe) has a true period, its pass
 * plus its pause; cut shorter and the loop shows half a pass. Everything else
 * is either random (a period would be a lie either way) or driven by
 * something without one, and gets a fixed loop.
 */
export function effectPreviewLoopMs(fx: LayerEffect | undefined): number {
  const f = fx as unknown as Record<string, unknown> | undefined;
  let ms = RANDOM_LOOP_MS;
  if (f && typeof f.duration === "number" && typeof f.delay === "number" && typeof f.loop === "boolean" && f.duration > 0) {
    ms = (f.duration + f.delay) * 1000 + (f.loop ? 0 : ONE_SHOT_HOLD_MS);
  }
  return Math.min(MAX_LOOP_MS, Math.max(MIN_LOOP_MS, ms));
}

/** Whole frames in a loop at `frameMs`. */
export function loopFrameCount(loopMs: number, frameMs: number): number {
  return Math.max(1, Math.round(loopMs / Math.max(1, frameMs)));
}

// ── The pacer ────────────────────────────────────────────────────────────────

/**
 * The share of wall-clock time the preview may spend rendering. Lower than the
 * stage's own (0.5): the preview is the thing beside the work, and the stage,
 * the timeline and the editor you are dragging in must keep the rest.
 */
export const PREVIEW_DUTY = 0.35;
/** Renders cheaper than this are never paced. */
const FREE_MS = 4;
/** Weight of the newest cost sample. */
const COST_ALPHA = 0.3;
/** Renders measured before a verdict on "heavy" — the first is a cold cache. */
const HEAVY_SAMPLES = 2;
/** A loop that builds in less than this just plays — a short wait, then memory. */
const HEAVY_BUILD_MS = 600;

/**
 * WHEN MAY THE PREVIEW RENDER, AND IS IT TOO HEAVY TO PLAY?
 *
 * Pure: times are handed in, so the policy is tested rather than hoped for.
 *
 * Pacing is the render budget's rule applied to the preview: after a render
 * that cost C, wait C·(1/duty − 1) before the next. Nothing is lost by waiting
 * — the preview's clock waits WITH it, so the first lap of a heavy loop plays
 * slower than real time and every lap after it plays from memory.
 *
 * "Heavy" is a loop that is slow to BUILD (see `heavy`). Playing one unasked
 * would spend a third of the machine for seconds on a picture nobody
 * requested; it waits for a press of play instead.
 */
export class PreviewPacer {
  private cost = 0;
  private samples = 0;
  private lastEnd = -Infinity;

  /** Record a render that started at `startMs` and ended at `endMs`. */
  note(startMs: number, endMs: number): void {
    const ms = Math.max(0, endMs - startMs);
    this.cost = this.samples === 0 ? ms : this.cost * (1 - COST_ALPHA) + ms * COST_ALPHA;
    this.samples++;
    this.lastEnd = endMs;
  }

  mayRender(nowMs: number): boolean {
    if (this.cost <= FREE_MS) return true;
    return nowMs - this.lastEnd >= this.cost * (1 / PREVIEW_DUTY - 1);
  }

  /**
   * Too heavy to play unasked — known only after a couple of renders.
   *
   * Heavy is about the LOOP, not the frame. A 3-drawing boil that costs 80ms a
   * picture builds its whole loop in a quarter of a second and then plays from
   * memory forever; holding it because one render is slower than one frame
   * was wrong. So: a render slower than a frame AND a loop of `pictures`
   * distinct renders that would take longer than `HEAVY_BUILD_MS` to build.
   */
  heavy(frameMs: number, pictures = Infinity): boolean {
    return this.samples >= HEAVY_SAMPLES && this.cost > frameMs && this.cost * pictures > HEAVY_BUILD_MS;
  }

  costMs(): number {
    return this.cost;
  }

  /** What was learned belongs to the old picture. */
  reset(): void {
    this.cost = 0;
    this.samples = 0;
  }
}
