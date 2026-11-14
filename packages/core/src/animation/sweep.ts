/**
 * THE SWEEP CLOCK — the second way an effect moves on its own.
 *
 * `temporal.ts` next door models a card that RE-ROLLS (grain, damage, static):
 * a seeded step function of time. This one models a card that TRAVELS: a 0→1
 * ramp with a duration, a delay and a decision about repeating. A shine
 * crossing a logo, a bolt drawing itself in, a wipe running edge to edge —
 * all the same ramp.
 *
 * WHY THIS EXISTS AT ALL, given that keyframes could do it: because a PRESET
 * cannot carry keyframes. The preset library is a value patch compared by value
 * (`activePreset` stores no id, deliberately), so anything a preset ships has
 * to be a number on the card. Making duration a number is what lets "Chrome
 * sweep" arrive already moving, retime with the clip when you drag its edge,
 * and still tell you it is the preset you are on after you nudge the width.
 * A stored keyframe track would have failed all three.
 *
 * `position` ADDS to the ramp rather than being replaced by it — the same
 * contract as glass's `ripplePhase` + `rippleSpeed`. Automatic costs nothing to
 * author; manual is never taken away.
 */

export interface SweepClock {
  /** Authored position, keyframeable. Added to whatever the ramp produces. */
  position: number;
  /** Seconds for one pass. 0 disables the ramp entirely. */
  duration: number;
  /** Seconds of stillness before each pass. */
  delay: number;
  /** Repeat, or run once and stay finished. */
  loop: boolean;
}

/**
 * Where the sweep sits at `timeSec`, in the card's own 0..1 travel space
 * (values outside that range are meaningful — the band is off-layer there).
 *
 * With `duration` at 0 this is just `position`, which is what makes the manual
 * path free: no branch at the call site, no second "mode" field on the card.
 */
export function sweepAt(clock: SweepClock, timeSec: number): number {
  const { position, duration, delay, loop } = clock;
  if (!(duration > 0)) return position;
  const cycle = duration + Math.max(0, delay);
  const t = timeSec;
  if (t < delay) return position;
  const elapsed = t - delay;
  if (!loop) return position + Math.min(1, elapsed / duration);
  const phase = ((elapsed % cycle) + cycle) % cycle;
  // The gap sits AFTER the pass, not before it, and the value HOLDS at 1
  // through it. A band that finishes, snaps back to the start and sits there
  // waiting reads as a stutter; one that leaves the layer and stays gone reads
  // as a pause, which is what a repeating sweep is supposed to look like.
  return position + (phase >= duration ? 1 : phase / duration);
}

/** Pull the clock out of a resolved value bag (see `resolveEffectValues`). */
export function sweepClockOf(v: Record<string, number | string>, loop: boolean): SweepClock {
  return {
    position: Number(v.position) || 0,
    duration: Math.max(0, Number(v.duration) || 0),
    delay: Math.max(0, Number(v.delay) || 0),
    loop,
  };
}
