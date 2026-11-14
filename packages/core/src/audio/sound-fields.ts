import type { Clip, ClipKind, KeyframeTrack, KeyframeValue, SoundLayer } from "../schema";
import { CLIP_KINDS } from "../clip-registry";
import type { AnimatablePropertyDef } from "../animation/properties";
import { sampleKeyframeTrack } from "../animation/keyframes";

/**
 * A SOUND ENTRY'S CLIMAX AS A PROPERTY PATH — `snd.<id>.intensity` (v103), the
 * family the property registry, `paths.ts` and the instance enumerator each
 * delegate ONE call to (the `key.<id>` pattern, `shape-keys/fields.ts`). So
 * "climax at 16 s" is two keys through `keyframes_set`, listed by
 * `layer_properties`, drawn in the curve editor and drivable by a node, with
 * no code of its own anywhere.
 *
 * The base slot is `SoundLayer.intensity`.
 */

export const SOUND_PATH = /^snd\.([^.]+)\.intensity$/;

export function soundIntensityPath(id: string): string {
  return `snd.${id}.intensity`;
}

/** The registry row for a `snd.<id>.intensity` path. Every clip kind carries a sound stack. */
export function soundPropertyDef(key: string): AnimatablePropertyDef | undefined {
  if (!SOUND_PATH.test(key)) return undefined;
  return {
    key,
    label: "Intensity",
    kind: "number",
    group: "audio",
    identity: 0,
    compose: "replace",
    appliesTo: Object.keys(CLIP_KINDS) as ClipKind[],
    min: 0,
    max: 1,
    step: 0.01,
  };
}

export function isSoundPath(path: string): boolean {
  return path.startsWith("snd.") && SOUND_PATH.test(path);
}

const entryOf = (clip: Clip, path: string): SoundLayer | undefined => {
  const m = SOUND_PATH.exec(path);
  return m ? clip.sounds.find((s) => s.id === m[1]) : undefined;
};

/** An entry's base intensity; `undefined` when the entry is not there. */
export function getSoundProperty(clip: Clip, path: string): KeyframeValue | undefined {
  return entryOf(clip, path)?.intensity;
}

/** Write an entry's base intensity (clamped 0..1). False when the path is not a sound path. */
export function setSoundProperty(clip: Clip, path: string, value: KeyframeValue): boolean {
  if (!SOUND_PATH.test(path)) return false;
  const v = typeof value === "boolean" ? (value ? 1 : 0) : value;
  const entry = entryOf(clip, path);
  if (entry && typeof v === "number" && Number.isFinite(v)) entry.intensity = Math.min(1, Math.max(0, v));
  return true;
}

/** Every intensity path a clip exposes, entry by entry. */
export function soundClipPaths(clip: Clip): Array<{ path: string; entry: SoundLayer }> {
  return (Array.isArray(clip.sounds) ? clip.sounds : []).map((entry) => ({ path: soundIntensityPath(entry.id), entry }));
}

/**
 * An entry's intensity as a function of CLIP-LOCAL time: its keys when it has
 * them, else its base value. Resolved once per entry, so a stream of hundreds
 * of firings samples one track instead of re-reading every key on the clip.
 */
export function soundIntensitySampler(clip: Clip, entry: SoundLayer): (clipLocalMs: number) => number {
  const path = soundIntensityPath(entry.id);
  const track: KeyframeTrack | undefined = clip.keyframes.find((k) => k.property === path && !k.range && k.keys.length > 0);
  if (!track) return () => entry.intensity;
  return (ms) => {
    const v = sampleKeyframeTrack(track, ms);
    return typeof v === "number" ? Math.min(1, Math.max(0, v)) : entry.intensity;
  };
}
