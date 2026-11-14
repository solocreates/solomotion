/**
 * WHAT A LIBRARY SOUND BECOMES when it lands in a document.
 *
 * Dropping a sound effect is never just "put the file here". There are four
 * decisions in it that a sound editor makes every single time — where the hit
 * lands relative to the cut, how it comes in and goes out, how loud, and at
 * what pitch — and a library that leaves all four to be redone by hand after
 * every drop is a library you stop using by the fifth sound.
 *
 * So the browser carries DEFAULTS and this turns them into a plan. One
 * function, because the click path and the drag path must produce the same
 * clip: two implementations of "place a sound" is two behaviours that diverge
 * the first time either is touched, and the user experiences that as the panel
 * being unreliable rather than as a bug with a location.
 *
 * Headless and total: no document, no store, no clock. Numbers in, numbers out,
 * so it is testable and so the exporter or a plugin could place a sound the
 * same way without importing the editor.
 */

import { ceilingGain, type EarGuard } from "./audition";
import { dbToGain } from "./envelope";
import type { AudioFade, Easing } from "../schema";

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The knobs a sound lands with. Device-local preferences, not document facts —
 * the same relationship the icons panel's ink and size have to a placed icon.
 *
 * Empty by default, deliberately: a sound effect is a one-shot and the correct
 * default for a one-shot's fade is none. The controls exist because the
 * exceptions (a riser you want to swell, a loop you want to sneak in) are
 * common enough that doing it by hand every time is the thing that wears you
 * down — not because every sound should arrive processed.
 */
export interface SoundDropDefaults {
  fadeInMs: number;
  fadeOutMs: number;
  /** Clip level in dB. 0 = unity. */
  gainDb: number;
  pitchSemitones: number;
  /**
   * Land the sound's TRANSIENT on the drop point instead of its first sample.
   *
   * Every published sound carries a detected `hitMs` — where it actually
   * strikes, past whatever room tone or encoder padding the file begins with.
   * With this on, a whoosh dropped on a cut hits ON the cut, which is what
   * "put the sound here" meant. Off, the file starts here and the hit arrives
   * whenever the file says, which is what every editor does by default and
   * what people spend the next thirty seconds nudging.
   */
  alignHit: boolean;
  /**
   * Carry the EAR GUARD's correction — not your monitoring volume — onto the
   * placed clip's gain.
   *
   * The distinction is the whole reason this is one switch and not two. How
   * loud you are monitoring is not an artistic decision and baking it into a
   * clip would be astonishing. But a sound the guard had to duck by 9 dB to be
   * bearable will need roughly that much to sit in a mix, and re-discovering
   * the number by ear on every import is exactly the tedium this panel exists
   * to remove. Off by default, because the honest default for an import is the
   * file as it is.
   */
  matchAuditionLevel: boolean;
}

export const DEFAULT_SOUND_DROP: SoundDropDefaults = {
  fadeInMs: 0,
  fadeOutMs: 0,
  gainDb: 0,
  pitchSemitones: 0,
  alignHit: true,
  matchAuditionLevel: false,
};

/** The measured facts about the sound being placed. */
export interface SoundDropSubject {
  /** Full file length. Fades are clamped against this. */
  durationMs: number;
  /** Detected transient, ms from the file's start. */
  hitMs: number;
  /**
   * Published perceived loudness in dB. Null means unmeasured — the guard then
   * cannot compute a correction and simply does not apply one, which is the
   * honest failure: guessing would either clip or duck for no reason.
   */
  loudnessDb: number | null;
}

/** Everything the placed clip needs, and nothing it doesn't. */
export interface SoundDropPlan {
  /** Timeline start. May be EARLIER than the drop point when aligning the hit. */
  startMs: number;
  /** Linear multiplier for `AudioClip.gain`. */
  gain: number;
  fadeIn: AudioFade;
  fadeOut: AudioFade;
  pitchSemitones: number;
}

/** The ramp shape both fades use. One curve, so they are visibly a pair. */
const FADE_CURVE: Easing = { kind: "preset", name: "ease-in-out" };

const fade = (durationMs: number): AudioFade => ({ durationMs, curve: FADE_CURVE });

/**
 * Turn a drop into a clip's opening state.
 *
 * Two clamps carry real weight:
 *
 *  • `startMs` never goes negative. Aligning a hit that sits 300 ms into the
 *    file, dropped 100 ms into a composition, would otherwise place the clip
 *    before zero — so the alignment is taken as far as it can go and the hit
 *    lands late rather than the clip landing nowhere.
 *  • the two fades together never exceed the clip. Overlapping ramps multiply,
 *    and a 500 ms fade pair on a 200 ms click is a sound that never reaches
 *    full level — audibly a bug, and one the user would blame on the sound.
 */
export function soundDropPlan(
  subject: SoundDropSubject,
  dropMs: number,
  defaults: SoundDropDefaults = DEFAULT_SOUND_DROP,
  guard: EarGuard = { enabled: false, ceilingDb: 0 },
): SoundDropPlan {
  const startMs = defaults.alignHit
    ? Math.max(0, Math.round(dropMs - subject.hitMs))
    : Math.max(0, Math.round(dropMs));

  // Each fade may claim at most half the clip, so the pair can never overlap
  // however they were configured.
  const half = Math.max(0, subject.durationMs / 2);
  const fadeInMs = Math.round(Math.min(Math.max(0, defaults.fadeInMs), half));
  const fadeOutMs = Math.round(Math.min(Math.max(0, defaults.fadeOutMs), half));

  let gain = dbToGain(defaults.gainDb);
  if (defaults.matchAuditionLevel && guard.enabled) {
    gain *= ceilingGain(subject.loudnessDb, guard.ceilingDb);
  }

  return {
    startMs,
    // The schema's own range. A plan that cannot be stored is not a plan.
    gain: Math.max(0, Math.min(4, gain)),
    fadeIn: fade(fadeInMs),
    fadeOut: fade(fadeOutMs),
    pitchSemitones: Math.max(-24, Math.min(24, Math.round(defaults.pitchSemitones))),
  };
}

/**
 * Does this plan change anything at all?
 *
 * The placement path uses it to skip a second document update when the
 * defaults are the empty ones — which is the common case, and one undo step
 * called "Sound defaults" that did nothing is the kind of litter that makes
 * undo untrustworthy.
 */
export function planIsNeutral(plan: SoundDropPlan): boolean {
  return (
    plan.gain === 1 &&
    plan.fadeIn.durationMs === 0 &&
    plan.fadeOut.durationMs === 0 &&
    plan.pitchSemitones === 0
  );
}
