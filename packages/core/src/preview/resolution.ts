import { type BudgetState, budgetFor, initialBudget, type TransportState } from "./render-budget";

/**
 * PREVIEW RESOLUTION — the one knob a professional tool actually turns.
 *
 * After Effects, Resolve, Nuke and Blender all do the same thing and the app
 * did not: they stop previewing at full quality the moment the transport runs,
 * and they put it back the instant you stop. A half-resolution preview is a
 * quarter of the pixels and therefore roughly a quarter of the per-pixel work
 * — blur, grain, glass, goo, grades, every pass in `render/passes/` — which is
 * the difference between a heavy comp that stutters and one that plays.
 *
 * ## The knob is the BACKING STORE, never the render scale
 *
 * This is the trap, and it is worth stating here because this file is where
 * someone will come looking for the dial. `DrawOptions.renderScale` is the
 * DOCUMENT's raster scale: effects have no resolution-independent meaning, so
 * lowering it re-rolls grain, re-seeds film damage and moves glass rims. The
 * picture would CHANGE, not soften — and worse, `renderScale != null` is how
 * the renderer knows it is being run by the exporter, which several caches key
 * off.
 *
 * So the tier is applied as the canvas's device-pixel ratio: render the same
 * frame into fewer device pixels and let the compositor blit it up. Every
 * coordinate downstream is CSS px and does not move, hit rects do not move,
 * and the only difference is softness — which is exactly what a preview tier
 * is supposed to trade.
 *
 * ## What `auto` has to get right
 *
 * Both fixed alternatives are bad: always-full stutters on the projects that
 * need help, and always-half makes every light document permanently soft for
 * no reason. So `auto` is the default, and it is governed — by the SAME
 * hysteresis loop motion blur uses (`observeFrame`), over this ladder. One
 * brain, two readers; a second copy of that loop would drift and the symptom
 * would be a preview that strobes between tiers.
 */

export type PreviewResolution = "eighth" | "quarter" | "half" | "full";

/** Cheapest first — the order `observeFrame` climbs. */
export const PREVIEW_RESOLUTIONS = ["eighth", "quarter", "half", "full"] as const satisfies readonly PreviewResolution[];

/** What the backing store is multiplied by. */
export const PREVIEW_RESOLUTION_SCALE: Record<PreviewResolution, number> = {
  full: 1,
  half: 0.5,
  quarter: 0.25,
  eighth: 0.125,
};

export const PREVIEW_RESOLUTION_LABEL: Record<PreviewResolution, string> = {
  full: "Full",
  half: "Half",
  quarter: "Quarter",
  eighth: "Eighth",
};

/** The user's setting: a pinned rung, or the governor. */
export type PreviewResolutionSetting = PreviewResolution | "auto";

export type PreviewResolutionBudget = BudgetState<PreviewResolution>;

export const INITIAL_PREVIEW_RESOLUTION: PreviewResolutionBudget = initialBudget<PreviewResolution>("full");

/**
 * Where `auto` should START when the transport begins, from what we have
 * already measured rather than from a number somebody liked.
 *
 * The editor has been rendering this document all along, so `frameMs` is a
 * real measurement of a real frame of it. The work is per-pixel, so a tier of
 * scale s costs about `frameMs · s²`; the largest tier that fits inside the
 * frame budget is therefore the one to open at. A light document opens at
 * full and never moves; a heavy one opens where it can actually run instead of
 * spending the first second of every playback discovering that again.
 *
 * Measuring beats assuming here in a way that is easy to check: on a document
 * that renders in 3ms at 30fps this returns `full`, and the "sensible default
 * of half" everyone reaches for would have made it needlessly soft.
 */
export function resolutionWeight(tier: PreviewResolution): number {
  const s = PREVIEW_RESOLUTION_SCALE[tier];
  // Work is per-pixel, so a rung costs the square of its linear scale.
  return s * s;
}

export function initialTierFor(frameMs: number, fps: number, memoryCap: PreviewResolution = "full"): PreviewResolution {
  const capAt = PREVIEW_RESOLUTIONS.indexOf(memoryCap);
  if (!Number.isFinite(frameMs) || frameMs <= 0) return memoryCap;
  const budget = budgetFor(fps);
  for (let i = capAt; i >= 0; i--) {
    const tier = PREVIEW_RESOLUTIONS[i]!;
    const s = PREVIEW_RESOLUTION_SCALE[tier];
    if (frameMs * s * s <= budget) return tier;
  }
  return PREVIEW_RESOLUTIONS[0]!;
}

// ── The tier a run opens at ─────────────────────────────────────────────────

/**
 * WHAT A COMP'S RUNS HAVE TAUGHT US — its own, never another comp's.
 *
 * `proven` is the sharpest tier a run of it has played to the end at;
 * `ceiling`, the tier a sharper probe stepped down from (null: none failed);
 * `measuredMs`, the cost of a frame AT `proven`, as measured — never scaled.
 *
 * Why a memory and not a prediction: the prediction was the part that was
 * wrong. Scaling a cost measured at an eighth up by 1/s² to "what full would
 * cost" assumes every millisecond is per-pixel; with layers served from the
 * cache most of a frame is fixed overhead, so a 9 ms frame at an eighth read
 * as 576 ms at full and — a run only ever steps down — a scene that draws in
 * 9 ms played as a smear for good. It also came from the PREVIOUS run,
 * whatever comp that was: one slow cover put every later run at an eighth.
 */
export interface TierMemory {
  proven: PreviewResolution;
  ceiling: PreviewResolution | null;
  measuredMs: number;
}

/** A run whose frames cost under this share of the budget is worth one sharper probe. */
const PROBE_HEADROOM = 0.4;

/** Can this comp play without its cached frames — its proven run (or, never played, its parked frame) well inside the budget? */
export function playsLive(memory: TierMemory | null, parkedMs: number, fps: number): boolean {
  return (memory ? memory.measuredMs : parkedMs) < budgetFor(fps) * PROBE_HEADROOM;
}

/**
 * Where a run opens, and the lowest it may fall to. Never played: predicted
 * from the parked frame. Otherwise the proven tier — or ONE tier sharper when
 * the proven run had headroom and that tier has not already failed, in which
 * case the run may only fall back as far as the proven tier.
 */
export function openingTier(memory: TierMemory | null, parkedMs: number, fps: number, cap: PreviewResolution = "full"): { tier: PreviewResolution; floor: PreviewResolution } {
  const lowest = PREVIEW_RESOLUTIONS[0]!;
  const capAt = PREVIEW_RESOLUTIONS.indexOf(cap);
  if (!memory) return { tier: initialTierFor(parkedMs, fps, cap), floor: lowest };
  const proven = Math.min(capAt, PREVIEW_RESOLUTIONS.indexOf(memory.proven));
  const probe = proven + 1;
  const blocked = memory.ceiling !== null && probe >= PREVIEW_RESOLUTIONS.indexOf(memory.ceiling);
  if (probe <= capAt && !blocked && playsLive(memory, parkedMs, fps)) {
    return { tier: PREVIEW_RESOLUTIONS[probe]!, floor: PREVIEW_RESOLUTIONS[proven]! };
  }
  return { tier: PREVIEW_RESOLUTIONS[proven]!, floor: lowest };
}

/** What a finished run teaches: where it ended is proven; where it opened, if it stepped down from there, is a ceiling. */
export function closeRun(memory: TierMemory | null, opened: PreviewResolution, ended: PreviewResolution, measuredMs: number): TierMemory {
  const fell = PREVIEW_RESOLUTIONS.indexOf(ended) < PREVIEW_RESOLUTIONS.indexOf(opened);
  return { proven: ended, ceiling: fell ? opened : (memory?.ceiling ?? null), measuredMs };
}

// ── What a tier costs to KEEP ───────────────────────────────────────────────

/** Bytes of one cached composite of a `width`×`height` comp at this tier. */
export function cachedFrameBytes(width: number, height: number, tier: PreviewResolution): number {
  const s = PREVIEW_RESOLUTION_SCALE[tier];
  return Math.max(1, Math.round(width * s)) * Math.max(1, Math.round(height * s)) * 4;
}

/** Bytes a minute of cache costs at this tier — what the resolution menu shows. */
export function cacheBytesPerMinute(width: number, height: number, fps: number, tier: PreviewResolution): number {
  return cachedFrameBytes(width, height, tier) * Math.max(1, fps) * 60;
}

/**
 * THE SHARPEST TIER WHOSE RANGE FITS IN MEMORY — Auto's second input.
 *
 * Speed is not the only way a preview tier can be wrong. A range built at Full
 * that does not fit in the cache's allowance is a range that is never whole:
 * the bar fills and rolls away behind the playhead, and every loop renders
 * again. So Auto opens at no sharper than the tier at which the range being
 * played actually fits — the choice a non-technical person would make if they
 * knew the numbers, made for them. Eighth when even that does not fit: the
 * rolling cache takes it from there.
 */
export function tierFittingMemory(
  width: number,
  height: number,
  frames: number,
  budgetBytes: number,
): PreviewResolution {
  for (let i = PREVIEW_RESOLUTIONS.length - 1; i >= 0; i--) {
    const tier = PREVIEW_RESOLUTIONS[i]!;
    if (cachedFrameBytes(width, height, tier) * Math.max(1, frames) <= budgetBytes) return tier;
  }
  return PREVIEW_RESOLUTIONS[0]!;
}

export interface PreviewResolutionInputs {
  setting: PreviewResolutionSetting;
  /** What the governor settled on — only consulted under `auto`. */
  governed: PreviewResolution;
  transport: TransportState;
  /**
   * Hold the preview tier while PAUSED, instead of snapping back to full.
   *
   * Off by default, and it should stay that way: the still frame is the thing
   * a person is judging, so it has to be true, and it costs exactly one render
   * they were going to pay for anyway. The switch exists for projects where
   * that one render is seconds long and every pause would stall — which is a
   * real situation and a bad default.
   */
  holdWhilePaused: boolean;
}

export interface PreviewResolutionDecision {
  /** What to render THIS frame at. */
  tier: PreviewResolution;
  /**
   * What the transport would run at — which is a different question whenever
   * the stage is parked, because parked is always true and playing is not.
   *
   * The frame cache turns on this rather than on `tier`, and that is the whole
   * reason a green bar survives being paused. Cached frames are pixels at ONE
   * resolution; if the cache followed `tier`, then pausing (full) and playing
   * (half) would be two different pictures of every instant, the tier would be
   * part of what makes a cached frame valid, and every play/pause would throw
   * the range away. So the cache reads and writes ONLY while the frame being
   * rendered is the frame playback would use — a parked full-quality render is
   * a one-off for your eyes, not an entry, and it leaves the build alone.
   */
  playbackTier: PreviewResolution;
  /** Not full — the chip is coloured, whoever chose it. */
  reduced: boolean;
  /** The GOVERNOR chose it, not the user. Worth saying out loud in the popover. */
  degraded: boolean;
}

/**
 * The tier for this frame, from what the user asked for and what the transport
 * is doing.
 *
 * PAUSED IS TRUE. That rule comes first and beats the governor, because a
 * preview tier is a trade you make against motion and there is no motion: a
 * soft still frame is not a cheaper picture, it is a wrong one, and the whole
 * reason to judge a frame is that it is the frame you will ship.
 */
export function resolvePreviewResolution(i: PreviewResolutionInputs): PreviewResolutionDecision {
  const playbackTier = i.setting === "auto" ? i.governed : i.setting;
  const paused = i.transport === "idle";
  const tier = paused && !i.holdWhilePaused ? "full" : playbackTier;
  return {
    tier,
    playbackTier,
    reduced: tier !== "full",
    degraded: i.setting === "auto" && tier !== "full",
  };
}

/**
 * THE SOFTEST TIER THAT STILL SHOWS EVERY PIXEL ON SCREEN — Auto's third input,
 * and After Effects' own definition of "Auto" resolution.
 *
 * `displayScale` is device pixels per comp pixel as the comp is shown (zoom ×
 * devicePixelRatio). A portrait comp viewed at 19% on a 2× display shows 0.38
 * device px per comp px, so rendering — and caching — it at Full is paying for
 * sixteen times the pixels anybody can see. Asked once when a run begins, so
 * zooming mid-play changes nothing and a built range stays valid.
 */
export function tierForDisplay(displayScale: number): PreviewResolution {
  if (!Number.isFinite(displayScale) || displayScale <= 0) return "full";
  for (const tier of PREVIEW_RESOLUTIONS) {
    if (PREVIEW_RESOLUTION_SCALE[tier] >= displayScale) return tier;
  }
  return "full";
}

/** The softer of two tiers. */
export function minTier(a: PreviewResolution, b: PreviewResolution): PreviewResolution {
  return PREVIEW_RESOLUTIONS.indexOf(a) <= PREVIEW_RESOLUTIONS.indexOf(b) ? a : b;
}

