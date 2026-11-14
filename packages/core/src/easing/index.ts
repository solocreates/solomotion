import type { Easing, EasingPresetName } from "../schema";

/**
 * Cubic-bezier control points for every named preset — exported so host
 * adapters (After Effects expressions, Fusion, bpy) can reproduce curves
 * exactly, and so the UI can draw them.
 */
export const EASING_PRESET_POINTS: Record<EasingPresetName, [number, number, number, number]> = {
  "ease-out": [0.25, 0.46, 0.45, 0.94],
  "ease-in": [0.55, 0.06, 0.68, 0.19],
  "ease-in-out": [0.65, 0, 0.35, 1],
  "ease-out-quart": [0.25, 1, 0.5, 1],
  "ease-out-expo": [0.16, 1, 0.3, 1],
  "ease-out-back": [0.34, 1.56, 0.64, 1],
  "ease-in-out-back": [0.68, -0.6, 0.32, 1.6],
  "ease-out-elastic": [0.5, 1.75, 0.4, 0.95],
};

export const EASING_PRESET_LABELS: Record<EasingPresetName, string> = {
  "ease-out": "Ease Out",
  "ease-in": "Ease In",
  "ease-in-out": "Ease In Out",
  "ease-out-quart": "Quart Out",
  "ease-out-expo": "Expo Out",
  "ease-out-back": "Back Out",
  "ease-in-out-back": "Back In Out",
  "ease-out-elastic": "Elastic Out",
};

/** Solve cubic-bezier(x1, y1, x2, y2) at progress x using Newton–Raphson with bisection fallback. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  // Newton–Raphson
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = sampleX(t) - x;
    if (Math.abs(err) < 1e-6) return sampleY(t);
    const d = sampleDX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }

  // Bisection fallback
  let lo = 0;
  let hi = 1;
  t = x;
  while (lo < hi) {
    const err = sampleX(t) - x;
    if (Math.abs(err) < 1e-6) break;
    if (err > 0) hi = t;
    else lo = t;
    t = (lo + hi) / 2;
    if (hi - lo < 1e-6) break;
  }
  return sampleY(t);
}

/** Evaluate an easing at t ∈ [0, 1]. Output may overshoot [0, 1] for back/elastic curves. */
export function evaluateEasing(easing: Easing, t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  switch (easing.kind) {
    case "linear":
      return clamped;
    case "hold":
      return clamped < 1 ? 0 : 1;
    case "preset": {
      const [x1, y1, x2, y2] = EASING_PRESET_POINTS[easing.name];
      return cubicBezier(x1, y1, x2, y2, clamped);
    }
    case "bezier": {
      const [x1, y1, x2, y2] = easing.values;
      return cubicBezier(x1, y1, x2, y2, clamped);
    }
  }
}

/**
 * The curve's cubic-bezier control points. A HOLD has none — it is a step, not
 * a curve — so it reports the linear diagonal; anything that must draw or
 * export a hold faithfully asks `isHold` first (the curve editor draws a step,
 * Lottie writes `h: 1`).
 */
export function easingPoints(easing: Easing): [number, number, number, number] {
  switch (easing.kind) {
    case "linear":
    case "hold":
      return [0, 0, 1, 1];
    case "preset":
      return EASING_PRESET_POINTS[easing.name];
    case "bezier":
      return easing.values;
  }
}

export const linear: Easing = { kind: "linear" };
export const hold: Easing = { kind: "hold" };
/** Does this segment jump at its end instead of moving? */
export const isHold = (easing: Easing | undefined): boolean => easing?.kind === "hold";
export const easeOut: Easing = { kind: "preset", name: "ease-out" };
export const easeOutExpo: Easing = { kind: "preset", name: "ease-out-expo" };
export const easeOutBack: Easing = { kind: "preset", name: "ease-out-back" };

/**
 * Cut an easing curve in two at time fraction `ut`, so the halves composed back
 * to back reproduce the original EXACTLY.
 *
 * This is the temporal twin of a de Casteljau split on a path: adding a
 * keyframe in the middle of a segment should change what you can EDIT, not what
 * plays. Copying the whole curve onto both halves — the obvious-looking move —
 * gives each half its own slow-fast-slow, which reads as the layer stalling at a
 * point you only meant to add a handle at.
 *
 * The curve runs (0,0)→(1,1) with the two control points between, so time is the
 * x axis: we solve for the curve parameter where x reaches `ut`, split the
 * control polygon there, then renormalize each half back into its own unit box.
 */
export function splitEasing(easing: Easing, ut: number): [Easing, Easing] {
  if (!(ut > 0) || !(ut < 1)) return [easing, easing];
  // A hold split anywhere is two holds: the value still waits for the end.
  if (easing.kind === "hold") return [hold, hold];
  const [x1, y1, x2, y2] = easingPoints(easing);
  // Linear splits into linear at any point — skip the algebra and stay exact.
  if (x1 === 0 && y1 === 0 && x2 === 1 && y2 === 1) return [linear, linear];

  const t = easingParamAtX(x1, x2, ut);
  const pts: Array<[number, number]> = [[0, 0], [x1, y1], [x2, y2], [1, 1]];
  const lerp = (a: [number, number], b: [number, number]): [number, number] => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ];
  const p01 = lerp(pts[0]!, pts[1]!);
  const p12 = lerp(pts[1]!, pts[2]!);
  const p23 = lerp(pts[2]!, pts[3]!);
  const p012 = lerp(p01, p12);
  const p123 = lerp(p12, p23);
  const mid = lerp(p012, p123);

  // Renormalize: each half spans mid−start in x and y, and an easing's own box
  // is always the unit square.
  const norm = (
    p: [number, number],
    o: [number, number],
    sx: number,
    sy: number,
  ): [number, number] => [sx === 0 ? 0 : (p[0] - o[0]) / sx, sy === 0 ? 0 : (p[1] - o[1]) / sy];

  const a = bezierEasing(
    norm(p01, [0, 0], mid[0], mid[1]),
    norm(p012, [0, 0], mid[0], mid[1]),
  );
  const b = bezierEasing(
    norm(p123, mid, 1 - mid[0], 1 - mid[1]),
    norm(p23, mid, 1 - mid[0], 1 - mid[1]),
  );
  return [a, b];
}

/** The curve parameter at which a (0,0)→(1,1) easing's x reaches `x`. */
function easingParamAtX(x1: number, x2: number, x: number): number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = sampleX(t) - x;
    if (Math.abs(err) < 1e-7) return t;
    const d = sampleDX(t);
    if (Math.abs(d) < 1e-7) break;
    t -= err / d;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  while (hi - lo > 1e-7) {
    const err = sampleX(t) - x;
    if (Math.abs(err) < 1e-7) break;
    if (err > 0) hi = t;
    else lo = t;
    t = (lo + hi) / 2;
  }
  return t;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** A bezier easing from two control points, clamped to a legal time axis. */
function bezierEasing(c1: [number, number], c2: [number, number]): Easing {
  const cx = (v: number) => round4(v < 0 ? 0 : v > 1 ? 1 : v);
  return { kind: "bezier", values: [cx(c1[0]), round4(c1[1]), cx(c2[0]), round4(c2[1])] };
}

/**
 * The time fraction at which an easing has advanced `progress` of the way.
 *
 * The inverse of `evaluateEasing`, and the answer to "the layer is at THIS
 * point on its path — when is it there?". Clicking a motion path picks a place
 * in SPACE (a curve parameter); under any non-linear easing the moment the
 * layer reaches it is not the same fraction of the segment's duration, so
 * inserting a key there needs this to place it in time.
 *
 * Bisection, because an easing with overshoot (back, elastic) is not monotonic
 * and Newton can walk off; any solution is a fine answer for a point the user
 * pointed at, and a linear curve short-circuits exactly.
 */
export function easingTimeAtProgress(easing: Easing, progress: number): number {
  if (easing.kind === "linear") return progress;
  if (easing.kind === "hold") return progress > 0 ? 1 : 0;
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (evaluateEasing(easing, mid) < progress) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The instant of MAXIMUM VELOCITY of an easing curve, as a 0..1 fraction of
 * its span — what a viewer reads as "the moment the motion happened".
 *
 * This is the brain behind `SoundAnchor: "peak"`. A thud on a bounce-in
 * belongs where the layer lands, not where it started drifting; an ease-out
 * slide "happens" almost immediately; a linear move has no such moment, so it
 * reports its midpoint. Deriving it from the curve means the sound follows the
 * easing when the easing is edited — the alternative (a stored number) is a
 * second description of the same fact, and it goes stale the first time
 * anybody drags a bezier handle.
 *
 * Sampled rather than solved: `evaluateEasing` covers linear, presets, beziers
 * and steps, and only the bezier family has a closed form. 64 samples resolves
 * the peak to ~1.5% of the span — well under a frame at any sane duration —
 * and the result is memoised per curve, so a stack of sounds on one clip costs
 * one sweep.
 */
const easingPeakCache = new Map<string, number>();

export function easingPeak(easing: Easing): number {
  // A hold happens at its end — the jump is the moment.
  if (easing.kind === "hold") return 1;
  const key = JSON.stringify(easing);
  const hit = easingPeakCache.get(key);
  if (hit !== undefined) return hit;

  const STEPS = 64;
  let bestT = 0.5;
  let bestV = -Infinity;
  let prev = evaluateEasing(easing, 0);
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const value = evaluateEasing(easing, t);
    const velocity = value - prev;
    // `>` not `>=`: on a flat curve (linear, or a step that never moves) every
    // sample ties, and keeping the FIRST winner would report t≈0. Ties resolve
    // to the midpoint below instead, which is the honest answer for "no peak".
    if (velocity > bestV) {
      bestV = velocity;
      bestT = t - 0.5 / STEPS; // centre of the interval the velocity describes
    }
    prev = value;
  }
  // A curve with no variation in velocity has no climax to land on; the middle
  // is the least wrong place to put one.
  const flat = Math.abs(bestV - 1 / STEPS) < 1e-9;
  const peak = flat ? 0.5 : Math.min(1, Math.max(0, bestT));
  easingPeakCache.set(key, peak);
  return peak;
}
