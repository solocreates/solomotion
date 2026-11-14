import type { LevelerSettings, SoundCharacter } from "../schema";

/**
 * THE SMART LEVELER'S TASTE — where each kind of sound should sit, and how
 * each is judged. Numbers a mixing engineer would recognise: dialogue on the
 * online-delivery anchor, music a few dB under it so words stay on top,
 * effects judged by their loudest moment, ambience felt more than heard.
 *
 * Relative, not absolute: the limiter owns the ceiling, these own the balance.
 */
export const CHARACTER_TARGET_LUFS: Record<SoundCharacter, number> = {
  voice: -16,
  music: -20,
  sfx: -19,
  ambience: -28,
};

/** "Level everything" — one target for every sound, for a mix with no categories yet. */
export const LEVEL_ALL_TARGET_LUFS = -18;

/**
 * Rapid-fire sounds — typing, ticks, a counter's clicks — are TEXTURE, and sit
 * this far under a one-shot effect. A keystroke at the level of a door slam,
 * twenty times a second, is the "annoying" in annoying typing sounds.
 */
export const TEXTURE_OFFSET_DB = -7;

/** How far the leveler will ever move a sound, dB. Beyond this it is a mistake, not a level. */
const MAX_CUT_DB = 30;
const MAX_LIFT_DB = 12;

/**
 * How a character is MEASURED. Speech and music live in their average — a take
 * is as loud as its gated integrated loudness. An effect lives in its peak
 * moment: a whoosh averaged over its own silence reads quiet, and levelling
 * it by that average is how effects end up blasting.
 */
export function measureKindOf(character: SoundCharacter | null): "integrated" | "peak" {
  return character === "sfx" ? "peak" : "integrated";
}

/** The loudness this sound should end up at. */
export function levelerTargetLufs(
  character: SoundCharacter | null,
  settings: Pick<LevelerSettings, "mode">,
  busTargetLufs: number | null = null,
): number {
  if (settings.mode === "all" || !character) return LEVEL_ALL_TARGET_LUFS;
  return busTargetLufs ?? CHARACTER_TARGET_LUFS[character];
}

/**
 * The trim for one sound, dB: how far from its target it measured, filtered
 * by the two switches (tame loud / lift quiet) and scaled by strength. Near
 * silence is left alone — lifting a silent file to −16 LUFS is lifting noise.
 */
export function levelerTrimDb(measuredLufs: number, targetLufs: number, s: LevelerSettings): number {
  if (!s.enabled || !Number.isFinite(measuredLufs) || measuredLufs < -60) return 0;
  let d = targetLufs - measuredLufs;
  if (!s.tameLoud) d = Math.max(0, d);
  if (!s.liftQuiet) d = Math.min(0, d);
  d = Math.max(-MAX_CUT_DB, Math.min(MAX_LIFT_DB, d));
  return d * Math.max(0, Math.min(1, s.strength));
}

/**
 * The loudness of a STREAM of short hits — what a person hears when a sound
 * fires `hitsPerWindow` times in one 400ms momentary window: the single hit's
 * loudness plus the energy of the repeats. It is how the leveler tells a
 * keystroke from a stampede of them.
 */
export function streamLoudness(singleHitLufs: number, meanVolume: number, hitsPerWindow: number): number {
  if (!Number.isFinite(singleHitLufs) || meanVolume <= 0) return -Infinity;
  return singleHitLufs + 20 * Math.log10(meanVolume) + 10 * Math.log10(Math.max(1, hitsPerWindow));
}
