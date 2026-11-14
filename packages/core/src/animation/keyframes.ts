import { createId } from "../ids";
import { evaluateEasing } from "../easing";
import type { Easing, Keyframe, KeyframeRange, KeyframeTrack, KeyframeValue } from "../schema";
import { isGeometryValue } from "../schema";
import { lerpColor, parseHexColor, propertyDef } from "./properties";
import { lerpSubpaths } from "../vector/geometry";

/** Whole-clip (null) vs. a specific grapheme slice — equal when both match. */
export function sameKeyframeRange(a: KeyframeRange | null, b: KeyframeRange | null): boolean {
  if (a === null || b === null) return a === b;
  return a.start === b.start && a.end === b.end;
}

/**
 * Keyframe engine. Tracks live on clips (times relative to clip start).
 * Values interpolate according to the property's registry kind:
 * numbers lerp, colors blend, discrete values hold. The easing of the
 * segment between two keys belongs to the key it leaves.
 */

function interpolate(property: string, a: Keyframe, b: Keyframe, t: number): KeyframeValue {
  return lerpKeyframeValue(property, a.value, b.value, t);
}

/**
 * BLEND two values of one property — the single rule for "what is halfway
 * between these?", shared by a keyframe segment and a caption's state crossing.
 * Split out from `interpolate` so the second caller could not become a second
 * interpolator: two answers to this question drift, and the drift shows up as
 * a colour that eases in one place and cuts in another.
 */
export function lerpKeyframeValue(
  property: string,
  from: KeyframeValue,
  to: KeyframeValue,
  t: number,
): KeyframeValue {
  // The registry can force a property discrete (weight, italic, text content);
  // otherwise the VALUE decides how it blends. This is what lets any property —
  // including effect-stack fields with no registry entry — animate for free:
  // numbers lerp, hex colors blend, everything else holds.
  if (propertyDef(property)?.kind === "discrete") return t < 1 ? from : to;
  if (typeof from === "number" && typeof to === "number") {
    return from + (to - from) * t;
  }
  if (typeof from === "string" && typeof to === "string") {
    if (parseHexColor(from) && parseHexColor(to)) return lerpColor(from, to, t);
  }
  // Path geometry: point-wise morph when structures match, else hold. A sampled
  // curve is also an array and is NOT geometry — it holds, like every other
  // non-interpolating value.
  if (isGeometryValue(from) && isGeometryValue(to)) {
    const morphed = lerpSubpaths(from, to, t);
    if (morphed) return morphed;
  }
  // Mismatched types or non-color strings: hold until the next key.
  return t < 1 ? from : to;
}

/** Sample a keyframe track at a clip-relative time. Undefined if the track has no keys. */
export function sampleKeyframeTrack(track: KeyframeTrack, timeMs: number): KeyframeValue | undefined {
  const keys = track.keys;
  if (keys.length === 0) return undefined;
  const first = keys[0]!;
  if (timeMs <= first.timeMs) return first.value;
  const last = keys[keys.length - 1]!;
  if (timeMs >= last.timeMs) return last.value;

  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (timeMs >= a.timeMs && timeMs <= b.timeMs) {
      const span = b.timeMs - a.timeMs;
      const t = span <= 0 ? 1 : (timeMs - a.timeMs) / span;
      return interpolate(track.property, a, b, evaluateEasing(a.easing, t));
    }
  }
  return last.value;
}

/**
 * Sample every whole-clip keyframed property at once. Range-scoped tracks are
 * excluded — they animate a text slice, not the clip-level pose (see
 * `sampleRangeStyles`).
 */
/**
 * Does the segment from `track.keys[i]` to the next key hold ONE value the
 * whole way? Every blend above is `from + (to − from)·f` — numbers, colours,
 * morphs, discrete holds alike — so equal ends hold whatever the easing does,
 * overshoot included. The one exception is position under spatial tangents:
 * that segment travels a curve and may come back to where it left, so both
 * position tracks answer no while any tangent exists.
 *
 * This is how "is this layer moving?" tells a HOLD from a move: a hold, ease,
 * hold state timeline is still for most of its life, not from its first key
 * to its last.
 */
export function keySegmentHolds(tracks: KeyframeTrack[], track: KeyframeTrack, i: number): boolean {
  const a = track.keys[i];
  const b = track.keys[i + 1];
  if (!a || !b) return true;
  if (!track.range && (track.property === "x" || track.property === "y") && hasSpatialTangents(tracks)) return false;
  return sameKeyValue(a.value, b.value);
}

function sameKeyValue(a: KeyframeValue, b: KeyframeValue): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  // Arrays (a sampled curve, an outline): structural, and rare enough that a
  // serialised compare once per clip object is nothing.
  return JSON.stringify(a) === JSON.stringify(b);
}

export function sampleKeyframes(
  tracks: KeyframeTrack[],
  timeMs: number,
): Record<string, KeyframeValue> {
  const out: Record<string, KeyframeValue> = {};
  for (const track of tracks) {
    if (track.range) continue;
    const value = sampleKeyframeTrack(track, timeMs);
    if (value !== undefined) out[track.property] = value;
  }
  applySpatialPosition(tracks, timeMs, out);
  return out;
}

// ── Spatial position (motion paths) ──────────────────────────────────────────
//
// x/y stay independent scalar tracks — until a position key carries spatial
// tangents (schema `Keyframe.spatial`, stored on the X track's key). Then the
// segment between two position keys is a 2D cubic Bézier: time still eases
// through the segment's easing, but the POINT travels the curve. This is the
// one seam every consumer (canvas, exports, overlays) samples through, and it
// is Lottie's exact ti/to model. Segments without tangents keep the original
// independent per-axis behavior, so existing documents render byte-identical.

/** The whole-clip x/y position tracks, when both exist with keys. */
export function positionTracks(
  tracks: KeyframeTrack[],
): { x: KeyframeTrack; y: KeyframeTrack } | null {
  let x: KeyframeTrack | undefined;
  let y: KeyframeTrack | undefined;
  for (const t of tracks) {
    if (t.range || t.keys.length === 0) continue;
    if (t.property === "x") x = t;
    else if (t.property === "y") y = t;
  }
  return x && y ? { x, y } : null;
}

/** Whether any position key curves its path (fast gate for the spatial seam). */
export function hasSpatialTangents(tracks: KeyframeTrack[]): boolean {
  const pos = positionTracks(tracks);
  return !!pos && pos.x.keys.some((k) => k.spatial && (k.spatial.in || k.spatial.out));
}

/** Union of both position tracks' key times, sorted, deduped within ±0.5ms. */
export function motionKeyTimes(x: KeyframeTrack, y: KeyframeTrack): number[] {
  const times = [...x.keys, ...y.keys].map((k) => k.timeMs).sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of times) {
    if (out.length === 0 || t - out[out.length - 1]! >= 0.5) out.push(t);
  }
  return out;
}

const keyAt = (track: KeyframeTrack, timeMs: number): Keyframe | undefined =>
  track.keys.find((k) => Math.abs(k.timeMs - timeMs) < 0.5);

/**
 * Override sampled x/y with the spatial-curve position when the segment under
 * `timeMs` has tangents. The motion ops keep x/y keys time-aligned; unaligned
 * keys still work (the missing axis samples its own track at the boundary).
 */
function applySpatialPosition(
  tracks: KeyframeTrack[],
  timeMs: number,
  out: Record<string, KeyframeValue>,
): void {
  const pos = positionTracks(tracks);
  if (!pos || !pos.x.keys.some((k) => k.spatial && (k.spatial.in || k.spatial.out))) return;

  const times = motionKeyTimes(pos.x, pos.y);
  if (times.length < 2 || timeMs <= times[0]! || timeMs >= times[times.length - 1]!) return;

  for (let i = 0; i < times.length - 1; i++) {
    const ta = times[i]!;
    const tb = times[i + 1]!;
    if (timeMs < ta || timeMs > tb) continue;

    const aKey = keyAt(pos.x, ta);
    const bKey = keyAt(pos.x, tb);
    const tOut = aKey?.spatial?.out ?? null;
    const tIn = bKey?.spatial?.in ?? null;
    if (!tOut && !tIn) return; // linear segment → independent sampling stands

    const num = (v: KeyframeValue | undefined): number => (typeof v === "number" ? v : 0);
    const ax = num(sampleKeyframeTrack(pos.x, ta));
    const ay = num(sampleKeyframeTrack(pos.y, ta));
    const bx = num(sampleKeyframeTrack(pos.x, tb));
    const by = num(sampleKeyframeTrack(pos.y, tb));
    const c1x = ax + (tOut?.x ?? (bx - ax) / 3);
    const c1y = ay + (tOut?.y ?? (by - ay) / 3);
    const c2x = bx + (tIn?.x ?? (ax - bx) / 3);
    const c2y = by + (tIn?.y ?? (ay - by) / 3);

    const span = tb - ta;
    const raw = span <= 0 ? 1 : (timeMs - ta) / span;
    // One temporal easing steers both axes (the x key's, the spatial carrier).
    const u = evaluateEasing((aKey ?? keyAt(pos.y, ta))?.easing ?? { kind: "linear" }, raw);
    const v = 1 - u;
    out["x"] = v * v * v * ax + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u * u * u * bx;
    out["y"] = v * v * v * ay + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u * u * u * by;
    return;
  }
}

/** A grapheme slice's sampled property values at a time (range-scoped keyframes). */
export interface RangeStyleSample {
  start: number;
  end: number;
  values: Record<string, KeyframeValue>;
}

/**
 * Sample all range-scoped tracks at a time, grouped by their slice. Feeds the
 * per-glyph style resolver so a keyframed color/weight/size on one word or
 * letter run renders independently of the rest of the clip.
 */
export function sampleRangeStyles(tracks: KeyframeTrack[], timeMs: number): RangeStyleSample[] {
  const byRange = new Map<string, RangeStyleSample>();
  for (const track of tracks) {
    if (!track.range) continue;
    const value = sampleKeyframeTrack(track, timeMs);
    if (value === undefined) continue;
    const key = `${track.range.start}:${track.range.end}`;
    let entry = byRange.get(key);
    if (!entry) {
      entry = { start: track.range.start, end: track.range.end, values: {} };
      byRange.set(key, entry);
    }
    entry.values[track.property] = value;
  }
  return [...byRange.values()];
}

/** Numeric-only view of sampled keyframes (transform math wants numbers). */
export function sampleNumber(
  sampled: Record<string, KeyframeValue>,
  property: string,
): number | undefined {
  const v = sampled[property];
  return typeof v === "number" ? v : undefined;
}

/**
 * Insert or replace a keyframe at `timeMs` (mutates the tracks array — call
 * inside a document update). Creates the property track if needed.
 */
export function setKeyframe(
  tracks: KeyframeTrack[],
  property: string,
  timeMs: number,
  value: KeyframeValue,
  easing: Easing = { kind: "preset", name: "ease-in-out" },
  range: KeyframeRange | null = null,
): Keyframe {
  let track = tracks.find((t) => t.property === property && sameKeyframeRange(t.range, range));
  if (!track) {
    track = { id: createId("ktrack"), property, range, keys: [] };
    tracks.push(track);
  }
  const existing = track.keys.find((k) => Math.abs(k.timeMs - timeMs) < 1);
  if (existing) {
    existing.value = value;
    return existing;
  }
  const key: Keyframe = { id: createId("key"), timeMs, value, easing };
  track.keys.push(key);
  track.keys.sort((a, b) => a.timeMs - b.timeMs);
  return key;
}

/**
 * THE delete-keyframes brain: drop matching keys and leave the thing looking
 * EXACTLY as it looks right now (After Effects / Blender semantics).
 *
 * Un-keying is not a rewind. The moment a track loses its last key the value
 * falls back to the base slot — which still holds whatever it held before the
 * animation was made, so the layer visibly jumps. So: sample each affected
 * track at `atMs` BEFORE removing anything, and when a track ends up empty,
 * hand that held value to `bake` to become the new resting value. Tracks that
 * keep keys are untouched — they are still animated, and their value at `atMs`
 * legitimately changes.
 *
 * Host-agnostic on purpose (`bake` is the only writer): clips bake into
 * `setClipProperty`, variables into their literal, motion keys into the base
 * transform. Returns the number of keys removed. Mutates `tracks`.
 */
export function removeKeyframesKeepingValue(
  tracks: KeyframeTrack[],
  atMs: number,
  match: (key: Keyframe, track: KeyframeTrack) => boolean,
  bake: (property: string, value: KeyframeValue, track: KeyframeTrack) => void,
): number {
  let removed = 0;
  for (let i = tracks.length - 1; i >= 0; i--) {
    const track = tracks[i]!;
    const doomed = new Set<string>();
    for (const key of track.keys) if (match(key, track)) doomed.add(key.id);
    if (doomed.size === 0) continue;
    // Sample first — after the splice the answer is a different (or no) curve.
    const held = sampleKeyframeTrack(track, atMs);
    track.keys = track.keys.filter((k) => !doomed.has(k.id));
    removed += doomed.size;
    if (track.keys.length > 0) continue;
    tracks.splice(i, 1);
    if (held !== undefined) bake(track.property, held, track);
  }
  return removed;
}

export function findKeyframe(
  tracks: KeyframeTrack[],
  keyId: string,
): { track: KeyframeTrack; key: Keyframe } | null {
  for (const track of tracks) {
    const key = track.keys.find((k) => k.id === keyId);
    if (key) return { track, key };
  }
  return null;
}

/**
 * Move a keyframe in time (clamped ≥ 0), keeping the track sorted. Landing on
 * another key of the same track (±1ms) replaces it — one time, one key —
 * UNLESS `merge: false`: mid-gesture moves must not destroy keys they merely
 * pass over (clamping at a clip edge stacks keys transiently; the caller
 * merges once on drop via `mergeCoincidentKeyframes`). Mutates.
 */
export function moveKeyframe(
  tracks: KeyframeTrack[],
  keyId: string,
  timeMs: number,
  opts?: { merge?: boolean },
): boolean {
  const found = findKeyframe(tracks, keyId);
  if (!found) return false;
  const t = Math.max(0, timeMs);
  if (opts?.merge !== false) {
    found.track.keys = found.track.keys.filter(
      (k) => k.id === keyId || Math.abs(k.timeMs - t) >= 1,
    );
  }
  found.key.timeMs = t;
  found.track.keys.sort((a, b) => a.timeMs - b.timeMs);
  return true;
}

/**
 * The drop-commit for merge-less drags: for every track, collapse keys that
 * ended up within ±1ms of a key in `keepIds` — the kept (dragged) key wins;
 * among coincident kept keys the first survives. Returns removed count.
 */
export function mergeCoincidentKeyframes(tracks: KeyframeTrack[], keepIds: Set<string>): number {
  let removed = 0;
  for (let ti = tracks.length - 1; ti >= 0; ti--) {
    const track = tracks[ti]!;
    if (!track.keys.some((k) => keepIds.has(k.id))) continue;
    const survivors: Keyframe[] = [];
    // Kept keys first so they win ties, then everything else; stable by time.
    const ordered = [...track.keys].sort((a, b) => {
      const ka = keepIds.has(a.id) ? 0 : 1;
      const kb = keepIds.has(b.id) ? 0 : 1;
      return ka - kb || a.timeMs - b.timeMs;
    });
    for (const k of ordered) {
      if (survivors.some((s) => Math.abs(s.timeMs - k.timeMs) < 1)) {
        removed++;
        continue;
      }
      survivors.push(k);
    }
    track.keys = survivors.sort((a, b) => a.timeMs - b.timeMs);
  }
  return removed;
}

/** Every key sitting at a time (±0.5ms) across all tracks — for unified moves. */
export function keyframesAtTime(
  tracks: KeyframeTrack[],
  timeMs: number,
): Array<{ track: KeyframeTrack; key: Keyframe }> {
  const out: Array<{ track: KeyframeTrack; key: Keyframe }> = [];
  for (const track of tracks) {
    for (const key of track.keys) {
      if (Math.abs(key.timeMs - timeMs) < 0.5) out.push({ track, key });
    }
  }
  return out;
}

/** Change the easing of the segment leaving a keyframe. Mutates. */
export function setKeyframeEasing(tracks: KeyframeTrack[], keyId: string, easing: Easing): boolean {
  const found = findKeyframe(tracks, keyId);
  if (!found) return false;
  found.key.easing = easing;
  return true;
}

/**
 * Nearest key strictly before / after a time, for ◀ ▶ keyframe navigation.
 * `property` limits the search to one track; omit it to search all tracks.
 */
export function adjacentKeyframe(
  tracks: KeyframeTrack[],
  timeMs: number,
  direction: "prev" | "next",
  property?: string,
): Keyframe | null {
  let best: Keyframe | null = null;
  const epsilon = 1;
  for (const track of tracks) {
    if (property !== undefined && track.property !== property) continue;
    for (const key of track.keys) {
      if (direction === "prev" ? key.timeMs < timeMs - epsilon : key.timeMs > timeMs + epsilon) {
        if (
          !best ||
          (direction === "prev" ? key.timeMs > best.timeMs : key.timeMs < best.timeMs)
        ) {
          best = key;
        }
      }
    }
  }
  return best;
}

/**
 * Whether a whole-clip property is keyframe-driven. Range-scoped tracks don't
 * count — they animate a slice, not the clip-level value the inspector shows.
 */
export function propertyHasKeys(tracks: KeyframeTrack[], property: string): boolean {
  return tracks.some((t) => !t.range && t.property === property && t.keys.length > 0);
}

/** Whether any track has a key at (±1ms) the given time. */
export function hasKeyframeAt(tracks: KeyframeTrack[], timeMs: number, property?: string): boolean {
  return tracks.some(
    (t) =>
      (property === undefined || t.property === property) &&
      t.keys.some((k) => Math.abs(k.timeMs - timeMs) < 1),
  );
}
