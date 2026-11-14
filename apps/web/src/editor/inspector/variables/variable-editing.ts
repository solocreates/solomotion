import {
  VARIABLE_TRACK_KEY,
  adjacentKeyframe,
  hasKeyframeAt,
  removeKeyframesKeepingValue,
  sampleKeyframeTrack,
  setKeyframe,
  variableValueAt,
  type Keyframe,
  type Variable,
} from "@solomotion/core";

/**
 * Headless editing rules for a (possibly keyframed) variable — the ONE place
 * both the Variables window and the Variables node write through, so a variable
 * animates identically wherever you touch it. Every function MUTATES a draft
 * variable (call inside `store.update`). Variables are doc-global, so times are
 * the raw document playhead — no clip-start offset — and the conventional track
 * key is `"value"`, which lets every core keyframe primitive work unchanged.
 */

/** A variable's live value at a time (sampled when animated, else the literal). */
export function variableDisplayValue(v: Variable, playheadMs: number): Variable["value"] {
  return variableValueAt(v, playheadMs);
}

/** Whether this variable carries an animation track. */
export function isVariableAnimated(v: Variable): boolean {
  return !!v.keyframes && v.keyframes.length > 0;
}

/** A key sits exactly at the playhead. */
export function variableHasKeyAt(v: Variable, playheadMs: number): boolean {
  return !!v.keyframes && hasKeyframeAt(v.keyframes, playheadMs, VARIABLE_TRACK_KEY);
}

/**
 * Write a new value. When the variable is animated, this sets (or updates) the
 * key at the playhead — so scrubbing then editing builds animation naturally,
 * like record mode; otherwise it edits the static literal. Mutates the draft.
 */
export function applyVariableValue(v: Variable, value: Variable["value"], playheadMs: number): void {
  // A PAINT is not one keyable value — its animation lives on `value.<sub>`
  // tracks (a stop's colour, a handle, a pattern's angle), each set from the
  // paint editor's own diamonds. Editing the paint itself always edits the
  // base, which is exactly how editing a clip's fill behaves.
  if (v.type !== "paint" && isVariableAnimated(v)) {
    if (!v.keyframes) v.keyframes = [];
    setKeyframe(v.keyframes, VARIABLE_TRACK_KEY, playheadMs, value as string | number);
  } else {
    (v as { value: Variable["value"] }).value = value;
  }
}

/**
 * Toggle a keyframe at the playhead. Adding the FIRST key seeds the current
 * literal as the value (so the animation starts from what you see) and keeps the
 * literal as the resting value; removing the last key drops the track. Mutates.
 */
export function toggleVariableKeyframe(v: Variable, playheadMs: number): void {
  if (!v.keyframes) v.keyframes = [];
  const track = v.keyframes.find((t) => t.property === VARIABLE_TRACK_KEY);
  const existing = track?.keys.find((k) => Math.abs(k.timeMs - playheadMs) < 1);
  if (existing) {
    bakingRemoval(v, playheadMs, (k) => k.id === existing.id);
    return;
  }
  const sampled = track ? sampleKeyframeTrack(track, playheadMs) : undefined;
  if (v.type === "paint") return; // keyed through its sub-paths, not this one
  setKeyframe(v.keyframes, VARIABLE_TRACK_KEY, playheadMs, sampled ?? v.value);
}

/** Remove the whole animation track (Reset keyframes). Mutates. */
export function clearVariableKeyframes(v: Variable, playheadMs: number): void {
  bakingRemoval(v, playheadMs, () => true);
}

/**
 * Un-keying a variable, one rule: the literal INHERITS the animated value at
 * the playhead as the last key goes. A variable feeds live fields all over the
 * document, so falling back to a stale pre-animation literal would visibly
 * re-style every bound layer — the same jump `removeClipKeyframes` prevents on
 * clips, here with the literal as the bake target.
 */
function bakingRemoval(
  v: Variable,
  playheadMs: number,
  match: (key: Keyframe) => boolean,
): void {
  if (!v.keyframes) return;
  removeKeyframesKeepingValue(v.keyframes, playheadMs, match, (_property, value) => {
    // The track only ever holds this variable's own type, so the sampled value
    // is assignable by construction — the union is what needs the cast.
    (v as { value: Variable["value"] }).value = value as Variable["value"];
  });
  if (v.keyframes.length === 0) delete v.keyframes;
}

/** The time of the neighbouring key in a direction, or null. */
export function adjacentVariableKey(v: Variable, playheadMs: number, dir: "prev" | "next"): number | null {
  if (!v.keyframes) return null;
  return adjacentKeyframe(v.keyframes, playheadMs, dir, VARIABLE_TRACK_KEY)?.timeMs ?? null;
}
