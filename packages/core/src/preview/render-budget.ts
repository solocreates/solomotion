import type { MotionBlurPolicy } from "../animation/shutter";
import type { MotionBlurSampling } from "../schema/motion-blur";
import { POLICY_FAST, POLICY_FULL, POLICY_OFF } from "../animation/shutter";

/**
 * THE GOVERNOR — measured frame cost in, quality tier out.
 *
 * Motion blur is the first thing in this app that can cost more than the frame
 * it is drawn into, so it is the first thing that needs an answer to "what
 * happens when this is too slow". The answer is NOT a dialog. A tool that stops
 * to ask permission mid-drag has already ruined the drag, and one that silently
 * gets slower has hidden the only fact you needed. So the app degrades on a
 * declared ladder and then SAYS it did — one chip in the stage controls that
 * changes colour. See `PreviewQuality` for the ladder.
 *
 * Deliberately NOT an activity monitor. We cannot read GPU time from a 2D
 * canvas honestly, and a number nobody can trust is worse than no number.
 * What we CAN measure exactly is how long our own frame took, which is the
 * number the decision actually turns on. `preview/profiler.ts` covers the
 * companion question — WHICH layer spent it.
 */

/**
 * The tiers a preview surface can run at, cheapest first. `auto` is not a tier
 * — it is the policy that PICKS one, and it is the default because the two
 * honest alternatives are both bad: always-full stutters on heavy projects,
 * and always-off means you never see the blur you are about to ship.
 */
export type PreviewQuality = "off" | "fast" | "full";

/** What the stage is doing right now. The governor's other input. */
export type TransportState = "idle" | "playing" | "scrubbing";

export interface BudgetState<Q extends string = PreviewQuality> {
  /** The tier currently in force. */
  quality: Q;
  /** True when the GOVERNOR lowered it, not the user. Drives the amber chip. */
  degraded: boolean;
  /** Smoothed frame cost, ms. */
  frameMs: number;
}

/** A governed state parked at `quality`, with nothing measured yet. */
export function initialBudget<Q extends string>(quality: Q): BudgetState<Q> {
  return { quality, degraded: false, frameMs: 0 };
}

export const INITIAL_BUDGET: BudgetState = initialBudget<PreviewQuality>("full");

/**
 * How much of a frame interval we are willing to spend before stepping down.
 * Well under 1.0: a frame that exactly fills its interval has no headroom for
 * the compositor, the audio thread or React, and will drop frames anyway.
 */
const SPEND_LIMIT = 0.8;
/**
 * And how far below that it must sit before stepping back up. The gap is the
 * whole point — without hysteresis a frame sitting near the limit oscillates
 * between tiers and the picture visibly strobes, which is worse than either
 * tier. Drop fast, recover slow.
 */
const RECOVER_LIMIT = 0.5;
/** Frames of sustained headroom before recovering. Dropping needs only one. */
const RECOVER_FRAMES = 45;

/** The per-frame budget, in ms, for a comp at this rate. */
export function budgetFor(fps: number): number {
  return (1000 / Math.max(1, fps)) * SPEND_LIMIT;
}

/**
 * Motion blur's ladder, cheapest first. A LADDER IS AN ARGUMENT, not a constant
 * in here, and that is the whole reason there is one governor rather than two:
 * preview RESOLUTION needs the identical hysteresis — drop on one slow frame,
 * recover only after sustained headroom — over a completely different set of
 * rungs. Two copies of this loop would drift the first time either one learned
 * something, and the symptom would be a preview that strobes between tiers.
 */
export const MOTION_BLUR_LADDER = ["off", "fast", "full"] as const satisfies readonly PreviewQuality[];

/**
 * Fold one measured frame into the governor's state.
 *
 * Pure: state in, state out, no clock and no storage of its own — so the stage
 * owns the loop and this owns the decision, and a test can drive a hundred
 * frames through it in a microsecond.
 */
export function observeFrame<Q extends string>(
  prev: BudgetState<Q>,
  sampleMs: number,
  fps: number,
  /** The user's ceiling. The governor may go below it, never above. */
  ceiling: Q,
  recoverCounter: { frames: number },
  /** The rungs this reader climbs, cheapest first. */
  ladder: readonly Q[],
  /**
   * What a rung costs RELATIVE to the sample — and the reason this governor
   * does not oscillate.
   *
   * `sampleMs` must be normalised to a common basis (for resolution: the cost
   * at full), because the measurement is taken at whatever rung is currently
   * in force and is therefore not comparable with itself. Without that, the
   * loop is: drop a tier, the frame is measured four times cheaper, the
   * recovery test passes trivially, climb back, the frame is expensive again,
   * drop. The picture visibly strobes on a period of `RECOVER_FRAMES`, which
   * is worse than either tier and is exactly the failure this exists to stop.
   *
   * With weights, RECOVERY IS TESTED AGAINST THE RUNG BEING CLIMBED TO rather
   * than the one being stood on, so a tier is only regained when it would
   * genuinely fit. Defaults to 1 for every rung, which is the behaviour a
   * ladder without a cost model (motion blur) already had.
   */
  weightOf: (rung: Q) => number = () => 1,
): BudgetState<Q> {
  // Exponential smoothing — one slow frame (a font load, a video seek, a GC
  // pause) must not knock the whole preview down a tier.
  const frameMs = prev.frameMs === 0 ? sampleMs : prev.frameMs * 0.8 + sampleMs * 0.2;
  const budget = budgetFor(fps);
  const ceilIndex = ladder.indexOf(ceiling);
  let index = Math.min(ladder.indexOf(prev.quality), ceilIndex);

  if (frameMs * weightOf(ladder[index]!) > budget && index > 0) {
    index--;
    recoverCounter.frames = 0;
  } else if (
    index < ceilIndex &&
    frameMs * weightOf(ladder[index + 1]!) < budget * (RECOVER_LIMIT / SPEND_LIMIT)
  ) {
    recoverCounter.frames++;
    if (recoverCounter.frames >= RECOVER_FRAMES) {
      index++;
      recoverCounter.frames = 0;
    }
  } else {
    recoverCounter.frames = 0;
  }

  const quality = ladder[index]!;
  return { quality, degraded: index < ceilIndex, frameMs };
}

/**
 * The stage's policy for one frame — the third level of the three-level model,
 * resolved from what the user asked for and what the machine can do.
 *
 * The transport rule is the interesting half, and it is deliberately the
 * opposite of the naive one:
 *
 *   PARKED    full.  This is where you JUDGE the look, and it costs one render
 *                    you were already doing. Turning blur off when the picture
 *                    is still is turning it off exactly when it is free.
 *   PLAYING   fast.  You cannot resolve smear detail at 30fps, so the cheap
 *                    tier is not a compromise here — it is the same picture.
 *   SCRUBBING off.   Scrubbing is navigation, not evaluation.
 */
export function stagePolicy(quality: PreviewQuality, transport: TransportState): MotionBlurPolicy {
  if (quality === "off") return POLICY_OFF;
  if (transport === "scrubbing") return POLICY_OFF;
  if (transport === "playing" || quality === "fast") return POLICY_FAST;
  return POLICY_FULL;
}

/**
 * An export is a render, not a playback: it has time, and this is the one
 * moment the extra samples are unambiguously worth paying for. `off` remains
 * available for the same reason the comp master does — sometimes you need the
 * crisp version.
 */
export function exportPolicy(enabled: boolean, maxTier: MotionBlurSampling = "content"): MotionBlurPolicy {
  if (!enabled) return POLICY_OFF;
  return maxTier === "content" ? POLICY_FULL : { kind: "capped", maxTier };
}
