import type { TrackChannel, TrackSample } from "../schema/tracking";
import { isTrackAnchor } from "../schema/tracking";
import { shortestArc } from "./pose";

/**
 * THE SOLVE PLAN — where analysis starts, which way it goes, and what happens to
 * the error it accumulates.
 *
 * Before v77 this did not exist: analysis walked from the clip's first frame to
 * its last, forward, once. Three things were wrong with that, and they are the
 * three complaints that made tracking feel broken rather than merely imperfect.
 *
 * 1. THE FRAME YOU ARE LOOKING AT IS THE ONLY ONE THAT MATTERS. You pause on the
 *    face, you draw around the face, you press track. Matching that outline
 *    against frame zero — a frame you never saw, where the face may not be — is
 *    not a subtle inaccuracy; it is tracking the wrong thing. Solving RADIATES
 *    from `referenceMs` in both directions.
 *
 * 2. A CORRECTION SHOULD FIX ITS NEIGHBOURHOOD, NOT ONE FRAME. Dragging the
 *    outline back onto the object at frame 200 used to pin frame 200 and leave
 *    199 and 201 exactly as wrong as they were. Anchors SPLIT the timeline into
 *    segments, each re-solved from its own anchor with its own template — so one
 *    correction repairs everything downstream of it.
 *
 * 3. TWO CORRECTIONS DEFINE A TARGET, AND THE ERROR BETWEEN THEM IS KNOWN. When
 *    a segment is solved forward from anchor A and anchor B says where it should
 *    have arrived, the residual at B is measured drift. Spreading it back across
 *    the segment — weighted by arc position, so the anchors stay exact — turns
 *    "it slips a bit in the middle" into a track that hits both ends. This is
 *    what a person means by "re-calculate knowing what went wrong", and it is
 *    the standard planar-tracking correction (Mocha, Resolve) rather than
 *    something invented here.
 *
 * Pure and headless. The PLAN (what to solve, from which seed) lives in
 * `run.ts` since v101, beside the walk that uses it; this file keeps the two
 * corrections every plan relies on.
 */

/**
 * Spread a segment's terminal error back across it.
 *
 * `solved` are the samples the engine produced for one segment, in time order;
 * `target` is the anchor the run should have landed on. The residual is measured
 * at the frame closest to the target and removed with a weight that ramps from 0
 * at the seed to 1 at the target — so the anchors stay exactly where the user
 * put them and the middle absorbs the correction, which is where the error
 * actually accumulated.
 *
 * Rotation is corrected on the shortest arc; scale multiplicatively, because
 * scale error compounds rather than adds and an additive fix over-corrects a
 * shrinking object by exactly the ratio it shrank.
 */
export function distributeDrift(solved: TrackSample[], seed: TrackSample, target: TrackSample): void {
  if (solved.length === 0) return;
  const end = solved[solved.length - 1]!;
  const span = end.timeMs - seed.timeMs;
  if (span === 0) return;

  const dx = target.x - end.x;
  const dy = target.y - end.y;
  const dRot = shortestArc(end.rotation, target.rotation);
  const kScale = end.scale > 0 ? target.scale / end.scale : 1;
  const dSkew = (target.skew ?? 0) - (end.skew ?? 0);
  const dGx = (target.perspective?.x ?? 0) - (end.perspective?.x ?? 0);
  const dGy = (target.perspective?.y ?? 0) - (end.perspective?.y ?? 0);

  if (dx === 0 && dy === 0 && dRot === 0 && kScale === 1 && dSkew === 0 && dGx === 0 && dGy === 0) return;

  for (const s of solved) {
    // A pinned channel is the user's; drift correction is a measurement fix and
    // has no business overwriting one.
    const w = (s.timeMs - seed.timeMs) / span;
    if (!s.pinned.includes("position")) {
      s.x += dx * w;
      s.y += dy * w;
    }
    if (!s.pinned.includes("rotation")) s.rotation += dRot * w;
    if (!s.pinned.includes("scale")) {
      const k = 1 + (kScale - 1) * w;
      s.scale *= k;
      if (s.scaleY != null) s.scaleY *= k;
    }
    if (!s.pinned.includes("skew")) s.skew = (s.skew ?? 0) + dSkew * w;
    if (!s.pinned.includes("perspective") && (dGx !== 0 || dGy !== 0)) {
      s.perspective = { x: (s.perspective?.x ?? 0) + dGx * w, y: (s.perspective?.y ?? 0) + dGy * w };
    }
  }
}


/**
 * Merge a fresh bake with the anchors from the previous one — the invariant that
 * makes re-solving safe: the machine re-measures, your hand stays.
 *
 * Per-CHANNEL rather than per-sample, which is the v77 change and the whole
 * point of `pinned`. Pinning the position at a frame used to freeze its scale
 * and rotation too, so the one thing you fixed by hand became the one frame the
 * solver could never improve.
 */
export function mergeAnchors(previous: TrackSample[], fresh: TrackSample[], eps = 0.5): TrackSample[] {
  const anchors = previous.filter(isTrackAnchor);
  if (anchors.length === 0) return fresh;
  const out = fresh.map((f) => {
    const a = anchors.find((m) => Math.abs(m.timeMs - f.timeMs) < eps);
    return a ? applyPins(f, a) : f;
  });
  // An anchor with no fresh sample at its time (the cadence changed) survives.
  for (const a of anchors) {
    if (!out.some((f) => Math.abs(f.timeMs - a.timeMs) < eps)) out.push(a);
  }
  out.sort((x, y) => x.timeMs - y.timeMs);
  return out;
}

/** Overlay only the channels the user pinned; everything else is the fresh solve. */
function applyPins(fresh: TrackSample, anchor: TrackSample): TrackSample {
  const has = (c: TrackChannel) => anchor.pinned.includes(c);
  return {
    ...fresh,
    x: has("position") ? anchor.x : fresh.x,
    y: has("position") ? anchor.y : fresh.y,
    scale: has("scale") ? anchor.scale : fresh.scale,
    scaleY: has("scale") ? anchor.scaleY : fresh.scaleY,
    rotation: has("rotation") ? anchor.rotation : fresh.rotation,
    skew: has("skew") ? anchor.skew : fresh.skew,
    perspective: has("perspective") ? anchor.perspective : fresh.perspective,
    warp: has("shape") ? anchor.warp : fresh.warp,
    confidence: anchor.pinned.length ? 1 : fresh.confidence,
    pinned: anchor.pinned,
  };
}
