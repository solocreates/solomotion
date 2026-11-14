import type { Easing, Keyframe, KeyframeTrack, SpatialTangents, Vec2 } from "../schema";
import { mirrorTangent } from "../tangents";
import { easingTimeAtProgress, splitEasing } from "../easing";
import {
  motionKeyTimes,
  positionTracks,
  removeKeyframesKeepingValue,
  sameKeyframeRange,
  sampleKeyframeTrack,
  setKeyframe,
} from "./keyframes";

/**
 * Motion paths — the 2D view of a clip's x/y keyframes.
 *
 * The MODEL stays the two scalar tracks (nothing new to migrate, every
 * keyframe surface keeps working); this module is the one brain that reads
 * them as a sequence of 2D motion keys and writes them back — always as
 * time-ALIGNED x/y pairs, with spatial tangents carried on the x key
 * (schema `Keyframe.spatial`). Sampling lives in keyframes.ts (the spatial
 * seam inside `sampleKeyframes`); everything geometric and every edit
 * operation lives here. All ops mutate — call inside a document update.
 */

/** Anything with position keyframes and a base transform (every visual clip). */
export interface MotionHost {
  keyframes: KeyframeTrack[];
  transform: { x: number; y: number };
}

/** One 2D position key: the x/y pair (or lone axis key) at one time. */
export interface MotionKey {
  timeMs: number;
  x: number;
  y: number;
  /** Curve handles, relative to (x, y). Null side = linear on that side. */
  tIn: Vec2 | null;
  tOut: Vec2 | null;
  /** Easing of the segment LEAVING this key (the x key's — the 2D carrier). */
  easing: Easing;
  xKeyId: string | null;
  yKeyId: string | null;
}

const keyNear = (track: KeyframeTrack | undefined, timeMs: number): Keyframe | undefined =>
  track?.keys.find((k) => Math.abs(k.timeMs - timeMs) < 0.5);

function axisTracks(tracks: KeyframeTrack[]): { x?: KeyframeTrack; y?: KeyframeTrack } {
  const out: { x?: KeyframeTrack; y?: KeyframeTrack } = {};
  for (const t of tracks) {
    if (t.range || t.keys.length === 0) continue;
    if (t.property === "x") out.x = t;
    else if (t.property === "y") out.y = t;
  }
  return out;
}

/**
 * The clip's motion keys, merged from both axis tracks (a lone-axis key reads
 * the other axis from its own track's held value or the base transform).
 */
export function motionKeysOf(host: MotionHost): MotionKey[] {
  const { x: xt, y: yt } = axisTracks(host.keyframes);
  if (!xt && !yt) return [];
  const times =
    xt && yt
      ? motionKeyTimes(xt, yt)
      : (xt ?? yt)!.keys.map((k) => k.timeMs);

  return times.map((t) => {
    const xk = keyNear(xt, t);
    const yk = keyNear(yt, t);
    const num = (v: unknown, fb: number) => (typeof v === "number" ? v : fb);
    return {
      timeMs: t,
      x: num(xt ? sampleKeyframeTrack(xt, t) : undefined, host.transform.x),
      y: num(yt ? sampleKeyframeTrack(yt, t) : undefined, host.transform.y),
      tIn: xk?.spatial?.in ?? null,
      tOut: xk?.spatial?.out ?? null,
      easing: (xk ?? yk)?.easing ?? { kind: "linear" },
      xKeyId: xk?.id ?? null,
      yKeyId: yk?.id ?? null,
    };
  });
}

/** A path needs somewhere to go: two or more position keys. */
export function clipHasMotionPath(host: MotionHost): boolean {
  return motionKeysOf(host).length >= 2;
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/**
 * Absolute cubic control points of the segment a→b. Linear sides fall back to
 * the straight-line thirds, so a one-sided curve still bends smoothly and a
 * fully linear segment yields an exact straight line.
 */
export function motionSegmentControls(
  a: MotionKey,
  b: MotionKey,
): { c1: Vec2; c2: Vec2; curved: boolean } {
  return {
    c1: {
      x: a.x + (a.tOut?.x ?? (b.x - a.x) / 3),
      y: a.y + (a.tOut?.y ?? (b.y - a.y) / 3),
    },
    c2: {
      x: b.x + (b.tIn?.x ?? (a.x - b.x) / 3),
      y: b.y + (b.tIn?.y ?? (a.y - b.y) / 3),
    },
    curved: !!(a.tOut || b.tIn),
  };
}

/** Point on the segment a→b at curve parameter u ∈ [0, 1]. */
export function motionPointAt(a: MotionKey, b: MotionKey, u: number): Vec2 {
  const { c1, c2 } = motionSegmentControls(a, b);
  const v = 1 - u;
  return {
    x: v * v * v * a.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * b.x,
    y: v * v * v * a.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * b.y,
  };
}

/**
 * Move the point at parameter `u` of segment a→b by (dx, dy) — the
 * grab-the-curve-and-pull gesture. Returns the segment's new RELATIVE
 * tangents (a.out, b.in), computed minimum-norm from the segment's current
 * geometry so repeated calls with a running delta from a gesture-start
 * snapshot stay stable.
 */
export function bentSegmentTangents(
  a: MotionKey,
  b: MotionKey,
  u: number,
  dx: number,
  dy: number,
): { aOut: Vec2; bIn: Vec2 } {
  const { c1, c2 } = motionSegmentControls(a, b);
  const t = Math.min(0.9, Math.max(0.1, u));
  const w1 = 3 * (1 - t) * (1 - t) * t;
  const w2 = 3 * (1 - t) * t * t;
  const denom = w1 * w1 + w2 * w2;
  const k1 = w1 / denom;
  const k2 = w2 / denom;
  return {
    aOut: { x: c1.x + dx * k1 - a.x, y: c1.y + dy * k1 - a.y },
    bIn: { x: c2.x + dx * k2 - b.x, y: c2.y + dy * k2 - b.y },
  };
}

/**
 * The tangents that make segment a→b a THROWN ARC: a parabola whose highest
 * point is `arc` px above the higher end (negative: a sag `−arc` px below the
 * lower end — a swing, a dip). Null for `arc` 0: a straight line.
 *
 * The control polygon is a quadratic raised to a cubic, its control point over
 * the chord's midpoint — so x is linear in the curve parameter and y is a
 * parabola in it. Because the motion-path sampler maps time to the curve
 * parameter through the segment's easing, a LINEAR easing makes this exact
 * ballistics: constant sideways speed, gravity up and down. One key per
 * landing replaces a frame-by-frame bake of the same hop, and dragging either
 * key re-throws it.
 *
 * The apex of a quadratic through ya and yb with control qy sits at
 * ya − (ya − qy)² / (ya − 2qy + yb); solving that for a chosen apex e gives
 * qy = e ∓ √((ya − e)(yb − e)).
 */
export function arcTangents(a: Vec2, b: Vec2, arc: number): { aOut: Vec2; bIn: Vec2 } | null {
  if (!arc) return null;
  const e = arc > 0 ? Math.min(a.y, b.y) - arc : Math.max(a.y, b.y) - arc;
  const q = { x: (a.x + b.x) / 2, y: e + (arc > 0 ? -1 : 1) * Math.sqrt((a.y - e) * (b.y - e)) };
  return {
    aOut: { x: ((q.x - a.x) * 2) / 3, y: ((q.y - a.y) * 2) / 3 },
    bIn: { x: ((q.x - b.x) * 2) / 3, y: ((q.y - b.y) * 2) / 3 },
  };
}

/** De Casteljau split of segment a→b at u: the new key's position + tangents. */
export function splitMotionSegment(
  a: MotionKey,
  b: MotionKey,
  u: number,
): { pos: Vec2; aOut: Vec2; mIn: Vec2; mOut: Vec2; bIn: Vec2 } {
  const { c1, c2 } = motionSegmentControls(a, b);
  const lerp = (p: Vec2, q: Vec2): Vec2 => ({ x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u });
  const p01 = lerp({ x: a.x, y: a.y }, c1);
  const p12 = lerp(c1, c2);
  const p23 = lerp(c2, { x: b.x, y: b.y });
  const p012 = lerp(p01, p12);
  const p123 = lerp(p12, p23);
  const pos = lerp(p012, p123);
  return {
    pos,
    aOut: { x: p01.x - a.x, y: p01.y - a.y },
    mIn: { x: p012.x - pos.x, y: p012.y - pos.y },
    mOut: { x: p123.x - pos.x, y: p123.y - pos.y },
    bIn: { x: p23.x - b.x, y: p23.y - b.y },
  };
}

// ── Edit operations (mutate inside a document update) ────────────────────────

function trackFor(host: MotionHost, property: "x" | "y"): KeyframeTrack | undefined {
  return host.keyframes.find((t) => t.property === property && sameKeyframeRange(t.range, null));
}

/**
 * Materialize the aligned x/y key pair at a time — the invariant every spatial
 * edit relies on. Missing keys are planted at the axis's current value there
 * (held/base), so ensuring never changes what renders. Returns the x key (the
 * spatial carrier).
 */
export function ensureMotionKey(host: MotionHost, timeMs: number, easing?: Easing): Keyframe {
  const num = (v: unknown, fb: number) => (typeof v === "number" ? v : fb);
  const xt = trackFor(host, "x");
  const yt = trackFor(host, "y");
  let xk = keyNear(xt, timeMs);
  const yk = keyNear(yt, timeMs);
  if (!xk) {
    const value = num(xt ? sampleKeyframeTrack(xt, timeMs) : undefined, host.transform.x);
    xk = setKeyframe(host.keyframes, "x", timeMs, value, easing ?? yk?.easing);
  }
  if (!yk) {
    const value = num(yt ? sampleKeyframeTrack(yt, timeMs) : undefined, host.transform.y);
    setKeyframe(host.keyframes, "y", timeMs, value, easing ?? xk.easing);
  }
  return xk;
}

/** Move a motion key's anchor. Tangents are relative, so handles ride along. */
export function setMotionAnchor(host: MotionHost, timeMs: number, x: number, y: number): void {
  ensureMotionKey(host, timeMs);
  setKeyframe(host.keyframes, "x", timeMs, x);
  setKeyframe(host.keyframes, "y", timeMs, y);
}

/**
 * Write one curve handle of the key at `timeMs`. A plain write moves only that
 * side; `mirror` brings the opposite handle along, balanced. Callers driving a
 * live drag should get `mirror` from `resolveTangentDrag`, so the ⌥ rule is the
 * same one the vector nodes obey.
 */
export function setMotionTangent(
  host: MotionHost,
  timeMs: number,
  end: "in" | "out",
  v: Vec2 | null,
  mirror = false,
): void {
  const xk = ensureMotionKey(host, timeMs);
  const prev: SpatialTangents = xk.spatial ?? { in: null, out: null };
  const partner = mirror && v ? mirrorTangent(v) : null;
  const next: SpatialTangents = {
    in: end === "in" ? v : partner ?? prev.in,
    out: end === "out" ? v : partner ?? prev.out,
  };
  xk.spatial = next.in || next.out ? next : null;
}

/** Bend the segment a→b so its point at `u` moves by the gesture delta. */
export function bendMotionSegment(
  host: MotionHost,
  a: MotionKey,
  b: MotionKey,
  u: number,
  dx: number,
  dy: number,
): void {
  const bent = bentSegmentTangents(a, b, u, dx, dy);
  setMotionTangent(host, a.timeMs, "out", bent.aOut);
  setMotionTangent(host, b.timeMs, "in", bent.bIn);
}

/**
 * Insert a motion key ON the segment a→b at parameter u.
 *
 * The path's SHAPE is preserved exactly when curved (de Casteljau split); a
 * linear segment stays two straight lines. The new key lands at the
 * parameter-proportional time.
 *
 * Its TIMING is then re-derived, and that is the whole trick. Copying the
 * segment's easing onto both halves — which is what this used to do — gives you
 * a layer that decelerates INTO the new point and accelerates back out of it: a
 * stall that appears at a point you only meant to add a handle at. Re-easing the
 * two touching segments off the shared monotone speed brain makes the motion
 * flow THROUGH the new key instead, so adding a point changes the shape you can
 * edit without changing the motion you already had.
 *
 * Only those two segments are rewritten; easing you set elsewhere is left alone.
 */
export function insertMotionKey(host: MotionHost, a: MotionKey, b: MotionKey, u: number): number {
  // `u` is a place in SPACE — where on the curve the click landed. Under a
  // non-linear easing the layer does not reach it at that same fraction of the
  // segment's duration, so the key's TIME comes from inverting the easing.
  // Conflating the two is what used to drop the key at the wrong moment and
  // visibly retime the move.
  const ut = easingTimeAtProgress(a.easing, u);
  const timeMs = a.timeMs + (b.timeMs - a.timeMs) * ut;
  const { curved } = motionSegmentControls(a, b);
  const split = splitMotionSegment(a, b, u);
  // The segment's easing is CUT at that moment, not copied to both halves.
  // Copying gives each half its own slow-fast-slow, so the layer stalls at a
  // point you only meant to add a handle at; the two cut halves compose back to
  // exactly the original timing instead.
  const [easeA, easeB] = splitEasing(a.easing, ut);
  setKeyframe(host.keyframes, "x", timeMs, split.pos.x, easeB).easing = easeB;
  setKeyframe(host.keyframes, "y", timeMs, split.pos.y, easeB).easing = easeB;
  // `setKeyframe` treats easing as a value for a NEW key and leaves an existing
  // key's own curve alone — the right call when a drag is re-keying a position,
  // and the reason the leading half has to be assigned outright here. Both axes
  // get it: a linear segment eases each axis independently, and on a spatial one
  // the x key is the carrier, so writing both is correct either way.
  setKeyframe(host.keyframes, "x", a.timeMs, a.x).easing = easeA;
  setKeyframe(host.keyframes, "y", a.timeMs, a.y).easing = easeA;
  if (curved) {
    setMotionTangent(host, a.timeMs, "out", split.aOut);
    setMotionTangent(host, timeMs, "in", split.mIn);
    setMotionTangent(host, timeMs, "out", split.mOut);
    setMotionTangent(host, b.timeMs, "in", split.bIn);
  }
  return timeMs;
}

/**
 * Toggle a motion key between corner (no tangents — straight into and out of
 * the anchor) and smooth (Catmull-Rom tangents through its neighbors, the
 * "make it flow" auto-curve).
 */
export function toggleMotionSmooth(host: MotionHost, timeMs: number): void {
  const xk = ensureMotionKey(host, timeMs);
  if (xk.spatial && (xk.spatial.in || xk.spatial.out)) {
    xk.spatial = null;
    return;
  }
  const keys = motionKeysOf(host);
  const i = keys.findIndex((k) => Math.abs(k.timeMs - timeMs) < 0.5);
  if (i === -1) return;
  const cur = keys[i]!;
  const prev = keys[i - 1] ?? cur;
  const next = keys[i + 1] ?? cur;
  // Catmull-Rom: the tangent runs parallel to the prev→next chord. End keys
  // point at their lone neighbor (a gentle third of the way).
  const dir = { x: (next.x - prev.x) / 6, y: (next.y - prev.y) / 6 };
  if (dir.x === 0 && dir.y === 0) return;
  xk.spatial = {
    in: i > 0 ? { x: -dir.x, y: -dir.y } : null,
    out: i < keys.length - 1 ? { x: dir.x, y: dir.y } : null,
  };
}

/**
 * Remove the x/y key pair at a time (the path point disappears). Deleting the
 * LAST point bakes the held position into the base transform, so the layer
 * stays where the path left it instead of snapping back to its pre-animation
 * spot — the same rule as every other un-key (see `removeClipKeyframes`).
 */
export function deleteMotionKey(host: MotionHost, timeMs: number): void {
  const doomed = new Set<string>();
  for (const axis of ["x", "y"] as const) {
    const key = keyNear(trackFor(host, axis), timeMs);
    if (key) doomed.add(key.id);
  }
  if (doomed.size === 0) return;
  removeKeyframesKeepingValue(
    host.keyframes,
    // A track only empties when this was its last key, and a lone key holds the
    // same value at every time — so sampling at the deleted point is exact.
    timeMs,
    (k) => doomed.has(k.id),
    (property, value) => {
      if (typeof value === "number" && (property === "x" || property === "y")) {
        host.transform[property] = value;
      }
    },
  );
}
