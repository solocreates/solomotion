import { evaluateEasing } from "../easing";
import { propertyHasKeys, sampleKeyframes, sampleNumber } from "../animation/keyframes";
import type { AudioClip, SoundCharacter, VideoClip } from "../schema";

/**
 * The audio gain envelope — THE headless contract for how loud a clip is at any
 * clip-local moment. Everything audible reads this one function: live preview
 * (media-conductor), export (both WebM and MP4 paths), the waveform drawn on
 * timeline clips, and the volume-bar overlay. It composes two layers, Resolve's
 * model exactly:
 *
 *   level(t) = gain(t) × fadeIn(t) × fadeOut(t)
 *
 * where gain(t) is the keyframed `gain` track (or the base value when unkeyed)
 * and the fades are edge ramps with their own easing curves. Because fades
 * MULTIPLY the automation instead of writing keys into it, dragging a fade
 * handle never destroys keyframes and both stay independently editable.
 */

/** dB → linear voltage gain (0 dB = 1). */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Linear gain → dB. 0 maps to -Infinity; guard for display. */
export function gainToDb(gain: number): number {
  return gain <= 0 ? -Infinity : 20 * Math.log10(gain);
}

/** The combined fade-in × fade-out factor at a clip-local time (0..1). */
export function fadeFactorAt(
  clip: Pick<AudioClip, "durationMs" | "fadeIn" | "fadeOut">,
  localMs: number,
): number {
  let f = 1;
  const fin = clip.fadeIn.durationMs;
  if (fin > 0 && localMs < fin) {
    f *= evaluateEasing(clip.fadeIn.curve, Math.max(0, localMs / fin));
  }
  const fout = clip.fadeOut.durationMs;
  if (fout > 0 && localMs > clip.durationMs - fout) {
    f *= evaluateEasing(clip.fadeOut.curve, Math.max(0, (clip.durationMs - localMs) / fout));
  }
  return Math.min(1, Math.max(0, f));
}

/** The clip's audible level at a clip-local time (keyframes × fades). */
export function audioGainAt(clip: AudioClip, localMs: number): number {
  const keyed = sampleNumber(sampleKeyframes(clip.keyframes, localMs), "gain");
  return Math.max(0, keyed ?? clip.gain) * fadeFactorAt(clip, localMs);
}

/** Whether the level CHANGES over time (keys or fades) — constant clips skip curve scheduling. */
export function hasGainAutomation(clip: AudioClip): boolean {
  return (
    propertyHasKeys(clip.keyframes, "gain") ||
    clip.fadeIn.durationMs > 0 ||
    clip.fadeOut.durationMs > 0
  );
}

/**
 * Sample the whole envelope at a fixed step — feeds `setValueCurveAtTime` on
 * export so the rendered file carries the exact same automation the preview
 * played. Always ≥ 2 values (the AudioParam contract).
 */
export function sampleGainEnvelope(clip: AudioClip, stepMs = 25): Float32Array {
  const n = Math.max(2, Math.ceil(clip.durationMs / stepMs) + 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = audioGainAt(clip, Math.min(clip.durationMs, i * stepMs));
  }
  return out;
}

/** A video clip's audible volume at a clip-local time (keyframed `volume`). */
export function videoVolumeAt(clip: VideoClip, localMs: number): number {
  const keyed = sampleNumber(sampleKeyframes(clip.keyframes, localMs), "volume");
  return Math.min(1, Math.max(0, keyed ?? clip.volume));
}

/**
 * Whether this audio clip keeps its pitch when sped up/down. Anything in a
 * VOICE category always does; everything else follows the `keepPitch` flag.
 * THE one predicate every surface reads so a voice can never chipmunk — live
 * (element `preservesPitch`), export and the bake all agree. Pass the resolved
 * route's character when you have it (a voice inside a comp tagged Dialogue
 * carries no tag of its own).
 */
export function audioKeepsPitch(clip: AudioClip, character?: SoundCharacter | null): boolean {
  return character === "voice" || clip.soundBus === "voice" || clip.keepPitch;
}

/** An audio clip's pitch shift (semitones) at a clip-local time — keyframable. */
export function audioPitchAt(clip: AudioClip, localMs: number): number {
  const keyed = sampleNumber(sampleKeyframes(clip.keyframes, localMs), "pitch");
  return keyed ?? clip.pitchSemitones;
}

/** Semitones → a linear frequency ratio (12 semitones = 2×). */
export function semitonesToRatio(semitones: number): number {
  return Math.pow(2, semitones / 12);
}
