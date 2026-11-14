import { z } from "zod";

/**
 * The blocks every layer-effect arm is built from — written once here so that
 * thirty-odd cards cannot drift into thirty-odd ideas of what "enabled",
 * "blend" or "animate this" mean.
 *
 * Each FAMILY file beside this one exports a tuple of zod arms; `layer-effects.ts`
 * is the assembly point that welds them into the one discriminated union. That
 * shape is deliberate and it is the answer to "what does this cost when there
 * are a hundred effects": a new family is a new file plus one spread, and the
 * family boundary is also the boundary of the renderer chunk that gets lazily
 * imported when a document actually uses one (see `stage/render/passes/`).
 */

export const layerEffectBase = {
  id: z.string(),
  enabled: z.boolean().default(true),
  /**
   * The LOOK this card belongs to — the id of a `group` card earlier in the
   * same list (see `animation/effect-groups.ts`). Absent on a loose card, which
   * is every card a document wrote before looks were groups, so old stacks
   * parse to exactly what they were.
   */
  group: z.string().optional(),
};

/**
 * The TEMPORAL CLOCK every time-varying effect carries — one shape, spread into
 * each schema, so grain, film damage, scanlines, noise, lightning and glitch
 * cannot drift into six subtly different ideas of "animate this". The maths
 * behind these four numbers is `animation/temporal.ts`; see that file for why a
 * film gate (and not the render loop) is the model.
 *
 * `seed` is the field that makes the whole family honest: without it a random
 * effect renders differently every session, so the export never matches the
 * preview. It is stored, not derived, precisely because the user must be able
 * to re-roll a look they don't like and then keep it forever.
 */
export const temporalClock = {
  /** Which universe of randomness. Re-roll it to get a different look. */
  seed: z.number().int().min(0).max(99999).default(1),
  /** Re-rolls per second. 24 = a film gate; raise it to your fps for per-frame. */
  rate: z.number().min(0.1).max(120).default(24),
  /** 0..1 — how irregular the re-roll boundaries are (randomness of time itself). */
  jitter: z.number().min(0).max(1).default(0),
  /** 0..1 — chance a step holds the previous state (a stuck frame). */
  stutter: z.number().min(0).max(1).default(0),
};

/**
 * The SWEEP CLOCK — the other way an effect moves on its own.
 *
 * The temporal clock above re-rolls a look; this one TRAVELS one. A shine
 * crossing a logo, a bolt striking, a wipe running edge to edge: all of them
 * are a 0→1 ramp with a duration, a delay and a decision about whether it
 * repeats. Stating it once means every travelling card agrees about what
 * "1.6 seconds" means, and — the part that matters for presets — a preset can
 * ship a MOVING look without carrying a single keyframe.
 *
 * `position` still keyframes like any other field. `duration` ADDS to it from
 * the clip's own local time, exactly the way glass's `rippleSpeed` adds to
 * `ripplePhase`: the automatic path costs nothing to author, and the manual
 * path is never taken away.
 */
export const sweepClock = {
  /** Where the sweep sits, 0 = before the layer, 1 = past it. Keyframe it. */
  position: z.number().min(-1).max(2).default(0.5),
  /** Seconds for one full pass. 0 parks it wherever `position` says. */
  duration: z.number().min(0).max(120).default(1.6),
  /** Seconds of stillness before each pass. */
  delay: z.number().min(0).max(120).default(0),
  /** Run the pass over and over instead of once. */
  loop: z.boolean().default(true),
};

/**
 * DOES THE CARD MOVE ON ITS OWN — the one switch every self-moving card
 * carries, whichever clock moves it (a re-roll, a sweep, a speed, a drift).
 *
 * A separate fact from `rate` or `speed`, for the reason a paint's eye is
 * separate from its opacity: holding a card still must not destroy the motion
 * you dialled, and letting it go must bring that motion back. Off, the card's
 * OWN clock stops at its first instant (`ownClockSec`); keyframes and
 * modulators are not its own motion and keep playing.
 *
 * The default is per card, and it is a taste call made once here: a card whose
 * point IS motion (film damage, glitch, a shine, a boil) arrives moving; a
 * card that is mostly a SURFACE (grain, noise, rough edges) arrives still.
 * Moving full-frame texture is what tires the eye under type, and it is the
 * costliest picture there is for a video codec — every frame new detail.
 */
export function ownMotion(moves: boolean) {
  return { animate: z.boolean().default(moves) };
}

/**
 * Canvas composite operations, as a keyframeable enum. Values ARE the canvas
 * op strings, so the renderer assigns them straight to `globalCompositeOperation`
 * — no translation table to fall out of step with the picker.
 */
export const EFFECT_BLEND_MODES = [
  "source-over",
  "multiply",
  "screen",
  "overlay",
  "soft-light",
  "hard-light",
  "color-dodge",
  "color-burn",
  "difference",
  "lighter",
] as const;
export type EffectBlendMode = (typeof EFFECT_BLEND_MODES)[number];
export const blendMode = z.enum(EFFECT_BLEND_MODES);
