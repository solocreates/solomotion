import type { Vec2 } from "../schema/common";
import type { RegionTracker, TrackChannel, TrackMethod } from "../schema/tracking";
import { clamp, seededRandom, type AnalysisFrame } from "./engine";
import { applyHomography, invertHomography, multiplyHomography, poseFromHomography, poseHomography, type Homography, type RegionPose } from "./pose";
import { detectCorners, trackPoints, type LkOptions } from "./cpu/klt";
import { minPointsFor, modelFor, ransac } from "./cpu/fit";
import { buildTemplate, insideRings, searchPose, searchRadiusFor, refineWarp, type Template } from "./cpu/match";
import { colorPose } from "./cpu/color";
import { regionPolylines, regionVertices } from "./contour";

/**
 * ONE STEP OF A SOLVE — "the region was HERE in that frame; where is it in
 * this one?" — answered by whichever method the tracker uses, behind one
 * interface so the run (`run.ts`), its cadence and its doubt checks never
 * branch on the method.
 *
 * Everything here is in ANALYSIS pixels; `run.ts` converts at the boundary.
 *
 * A step returns its own DOUBT: the forward–backward error (track there, track
 * back, see how far from the start it lands) and a confidence. The run uses
 * them to decide whether a skipped stretch can be trusted or has to be walked
 * frame by frame — the method knows how sure it is; the run decides what to do
 * about it.
 */

export interface StepResult {
  pose: RegionPose;
  /** 0..1. */
  confidence: number;
  /** Forward–backward round-trip error, analysis px. 0 when the method has no notion of one. */
  fb: number;
  /** Nothing usable was found: the pose is the prior, held. */
  lost: boolean;
}

export interface Stepper {
  readonly method: Exclude<TrackMethod, "auto">;
  /** Re-seed the appearance model from a frame the pose is trusted on (a seed, an anchor, a strong step). */
  seed(frame: AnalysisFrame, pose: RegionPose): void;
  /** Measure the pose in `next`, given it in `prev`; `guess` is the predicted pose (constant velocity). */
  step(prev: AnalysisFrame, prevPose: RegionPose, next: AnalysisFrame, guess: RegionPose): StepResult;
}

/** Corners a region must offer before `auto` trusts features over correlation. */
const AUTO_MIN_CORNERS = 12;

/** The stepper for a tracker, choosing for `auto` by looking at the seed frame. */
export function makeStepper(tracker: RegionTracker, seedFrame: AnalysisFrame, seedPose: RegionPose): Stepper {
  const method = tracker.solve.method;
  const stepper =
    method === "color"
      ? colorStepper(tracker)
      : method === "luma"
        ? lumaStepper(tracker)
        : method === "features"
          ? featureStepper(tracker)
          : countCorners(tracker, seedFrame, seedPose) >= AUTO_MIN_CORNERS
            ? featureStepper(tracker)
            : lumaStepper(tracker);
  stepper.seed(seedFrame, seedPose);
  return stepper;
}

// ── Features: KLT + RANSAC (the planar workhorse) ────────────────────────────

interface FeatureTuning {
  max: number;
  minDistance: number;
  lk: LkOptions;
  /** Per-feature forward–backward limit, analysis px. */
  fbLimit: number;
  /** RANSAC agreement distance, analysis px. */
  inlierPx: number;
}

function featureTuning(accuracy: number, regionSpan: number): FeatureTuning {
  const a = clamp(accuracy, 0, 1);
  return {
    max: Math.round(48 + a * 160),
    minDistance: clamp(Math.round(regionSpan / 18), 3, 14),
    lk: { half: a >= 0.7 ? 7 : 5, levels: 3, iterations: Math.round(10 + a * 20), epsilon: a >= 0.7 ? 0.01 : 0.03 },
    fbLimit: 1.5 - a * 0.7,
    inlierPx: 2 - a * 0.9,
  };
}

/** The region's flattened rings and bounding box at a pose. */
function regionAt(tracker: RegionTracker, pose: RegionPose): { rings: Vec2[][]; box: { x0: number; y0: number; x1: number; y1: number } } {
  const rings = regionPolylines(tracker.region, pose);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of rings)
    for (const p of ring) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
  return { rings, box: { x0, y0, x1, y1 } };
}

function countCorners(tracker: RegionTracker, frame: AnalysisFrame, pose: RegionPose): number {
  const { rings, box } = regionAt(tracker, pose);
  const span = Math.max(box.x1 - box.x0, box.y1 - box.y0);
  const t = featureTuning(tracker.solve.accuracy, span);
  return detectCorners(frame, box, (x, y) => insideRings(rings, x, y), { max: 64, minDistance: t.minDistance, quality: 0.02, half: 2 }).length;
}

/** The keyframe: a crop of a trusted frame around the region, its pose, and its corners (crop coords). */
interface Key {
  crop: AnalysisFrame;
  ox: number;
  oy: number;
  pose: RegionPose;
  corners: Vec2[];
}

/** Context kept around the region in a key crop — room for the LK window and the pyramid. */
const KEY_MARGIN = 24;

function cropFrame(frame: AnalysisFrame, ox: number, oy: number, w: number, h: number): AnalysisFrame {
  const luma = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(frame.height - 1, Math.max(0, oy + y));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(frame.width - 1, Math.max(0, ox + x));
      luma[y * w + x] = frame.luma[sy * frame.width + sx]!;
    }
  }
  return { width: w, height: h, luma };
}

/** A crop window, frame px. */
interface Roi {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Window edges snap to this grid, so consecutive steps usually share a crop. */
const ROI_GRID = 32;

/**
 * The window a frame-to-frame step needs: both boxes, a margin for motion the
 * prediction missed, and the reach of the LK window at the coarsest level. A
 * window that would cover most of the frame IS the frame — no crop at all.
 */
function roiFor(a: { x0: number; y0: number; x1: number; y1: number }, b: typeof a, lk: LkOptions, fw: number, fh: number): Roi {
  const span = Math.max(a.x1 - a.x0, a.y1 - a.y0, b.x1 - b.x0, b.y1 - b.y0);
  const margin = Math.max(24, span * 0.5) + ((lk.half + 2) << lk.levels);
  const x0 = Math.max(0, Math.floor((Math.min(a.x0, b.x0) - margin) / ROI_GRID) * ROI_GRID);
  const y0 = Math.max(0, Math.floor((Math.min(a.y0, b.y0) - margin) / ROI_GRID) * ROI_GRID);
  const x1 = Math.min(fw, Math.ceil((Math.max(a.x1, b.x1) + margin) / ROI_GRID) * ROI_GRID);
  const y1 = Math.min(fh, Math.ceil((Math.max(a.y1, b.y1) + margin) / ROI_GRID) * ROI_GRID);
  if (!(x1 > x0 && y1 > y0) || (x1 - x0) * (y1 - y0) > fw * fh * 0.6) return { x: 0, y: 0, w: fw, h: fh };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const crops = new WeakMap<AnalysisFrame, { roi: Roi; crop: AnalysisFrame }>();

/** A frame's crop, kept with the frame — the "next" of one step is the "prev" of the next, and its pyramid comes with it. */
function cropOf(frame: AnalysisFrame, roi: Roi): AnalysisFrame {
  if (roi.x === 0 && roi.y === 0 && roi.w === frame.width && roi.h === frame.height) return frame;
  const hit = crops.get(frame);
  if (hit && hit.roi.x === roi.x && hit.roi.y === roi.y && hit.roi.w === roi.w && hit.roi.h === roi.h) return hit.crop;
  const crop = cropFrame(frame, roi.x, roi.y, roi.w, roi.h);
  crops.set(frame, { roi, crop });
  return crop;
}

/** `out(u, v) = frame(map(u, v))`, bilinear — the new frame seen in the key's geometry. */
function warpFrame(frame: AnalysisFrame, map: Homography, w: number, h: number): AnalysisFrame {
  const luma = new Uint8Array(w * h);
  const fw = frame.width;
  const fh = frame.height;
  const src = frame.luma;
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const q = applyHomography(map, { x: u, y: v });
      const x = q.x < 0 ? 0 : q.x > fw - 1.001 ? fw - 1.001 : q.x;
      const y = q.y < 0 ? 0 : q.y > fh - 1.001 ? fh - 1.001 : q.y;
      const x0 = x | 0;
      const y0 = y | 0;
      const fx = x - x0;
      const fy = y - y0;
      const i = y0 * fw + x0;
      const a = src[i]!, b = src[i + 1]!, c = src[i + fw]!, d = src[i + fw + 1]!;
      luma[v * w + u] = a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    }
  }
  return { width: w, height: h, luma };
}

/**
 * KLT + RANSAC, frame to frame AND against a keyframe.
 *
 * Frame-to-frame alone drifts: every step's sub-pixel error is inherited by the
 * next, so a perfect-looking track is a few pixels off after ten seconds. So
 * each step is measured twice. Frame to frame gives a robust ESTIMATE (small
 * motion, fresh appearance); then the KEYFRAME's own corners are tracked
 * straight into the new frame from that estimate, and if enough of them agree
 * that answer wins — it has no history to inherit. When the subject has turned
 * or grown too far from the keyframe for its corners to match, the keyframe
 * moves to the last trusted frame and the walk carries on. Drift becomes
 * bounded instead of accumulating.
 */
function featureStepper(tracker: RegionTracker): Stepper {
  const model = modelFor(tracker.solve.channels);
  const need = Math.max(minPointsFor(model) + 2, 6);
  // Seeded per tracker, so a re-solve of the same frames lands on the same answer.
  let hash = 0;
  for (let i = 0; i < tracker.id.length; i++) hash = (hash * 31 + tracker.id.charCodeAt(i)) | 0;
  const random = seededRandom(hash);
  let key: Key | null = null;

  const cornersAt = (frame: AnalysisFrame, pose: RegionPose) => {
    const { rings, box } = regionAt(tracker, pose);
    const span = Math.max(box.x1 - box.x0, box.y1 - box.y0);
    const t = featureTuning(tracker.solve.accuracy, span);
    return { t, pts: detectCorners(frame, box, (x, y) => insideRings(rings, x, y), { max: t.max, minDistance: t.minDistance, quality: 0.01, half: 2 }) };
  };

  const rekey = (frame: AnalysisFrame, pose: RegionPose) => {
    const { rings, box } = regionAt(tracker, pose);
    const ox = Math.floor(box.x0) - KEY_MARGIN;
    const oy = Math.floor(box.y0) - KEY_MARGIN;
    const w = Math.ceil(box.x1 - box.x0) + KEY_MARGIN * 2;
    const h = Math.ceil(box.y1 - box.y0) + KEY_MARGIN * 2;
    const crop = cropFrame(frame, ox, oy, w, h);
    const span = Math.max(box.x1 - box.x0, box.y1 - box.y0);
    const t = featureTuning(tracker.solve.accuracy, span);
    const corners = detectCorners(crop, { x0: 0, y0: 0, x1: w - 1, y1: h - 1 }, (x, y) => insideRings(rings, x + ox, y + oy), {
      max: t.max,
      minDistance: t.minDistance,
      quality: 0.01,
      half: 2,
    });
    key = { crop, ox, oy, pose, corners };
  };

  /** Move `from` (points in `a`) into `b` and fit the motion; null when the crowd does not agree. */
  const measure = (a: AnalysisFrame, from: Vec2[], b: AnalysisFrame, predict: Homography | null, t: FeatureTuning, checkFb: boolean) => {
    const seeds = predict
      ? from.map((p) => {
          const q = applyHomography(predict, p);
          return { x: q.x - p.x, y: q.y - p.y };
        })
      : null;
    const fwd = trackPoints(a, b, from, seeds, t.lk);
    const okIdx: number[] = [];
    for (let i = 0; i < from.length; i++) if (fwd.ok[i]) okIdx.push(i);
    if (okIdx.length < need) return null;
    const src: Vec2[] = [];
    const dst: Vec2[] = [];
    let fb = 0;
    if (checkFb) {
      // Forward–backward: every survivor is tracked home again.
      const there = okIdx.map((i) => fwd.points[i]!);
      const back = trackPoints(b, a, there, okIdx.map((i) => ({ x: from[i]!.x - fwd.points[i]!.x, y: from[i]!.y - fwd.points[i]!.y })), t.lk);
      const fbs: number[] = [];
      for (let k = 0; k < okIdx.length; k++) {
        if (!back.ok[k]) continue;
        const i = okIdx[k]!;
        const e = Math.hypot(back.points[k]!.x - from[i]!.x, back.points[k]!.y - from[i]!.y);
        fbs.push(e);
        if (e > t.fbLimit) continue;
        src.push(from[i]!);
        dst.push(fwd.points[i]!);
      }
      fb = median(fbs);
    } else {
      for (const i of okIdx) {
        src.push(from[i]!);
        dst.push(fwd.points[i]!);
      }
    }
    if (src.length < need) return { fit: null, fb, tried: from.length };
    return { fit: ransac(model, src, dst, t.inlierPx, random), fb, tried: from.length };
  };

  return {
    method: "features",
    seed(frame, pose) {
      rekey(frame, pose);
    },
    step(prev, prevPose, next, guess) {
      const { t, pts: from } = cornersAt(prev, prevPose);
      if (from.length < need) return { pose: guess, confidence: 0, fb: Infinity, lost: true };
      const prevH = poseHomography(prevPose);
      const prevInv = invertHomography(prevH);
      const predict = prevInv ? multiplyHomography(poseHomography(guess), prevInv) : null;

      // 1. Frame to frame: the robust estimate — measured in a crop around
      //    where the region was and where it is predicted, never the whole
      //    frame. Pyramids and gradients over 1280×720 were most of a step;
      //    the region's neighbourhood is all LK can reach anyway.
      const roi = roiFor(regionAt(tracker, prevPose).box, regionAt(tracker, guess).box, t.lk, prev.width, prev.height);
      const to: Homography = [1, 0, -roi.x, 0, 1, -roi.y, 0, 0, 1];
      const back: Homography = [1, 0, roi.x, 0, 1, roi.y, 0, 0, 1];
      const f2f = measure(
        cropOf(prev, roi),
        roi.x || roi.y ? from.map((p) => ({ x: p.x - roi.x, y: p.y - roi.y })) : from,
        cropOf(next, roi),
        predict ? multiplyHomography(to, multiplyHomography(predict, back)) : null,
        t,
        true,
      );
      if (!f2f?.fit || f2f.fit.inlierCount < need) return { pose: guess, confidence: 0, fb: f2f?.fb ?? Infinity, lost: true };
      const estimate = poseFromHomography(multiplyHomography(multiplyHomography(back, multiplyHomography(f2f.fit.model, to)), prevH));
      if (!estimate) return { pose: guess, confidence: 0, fb: f2f.fb, lost: true };
      let pose = constrain(estimate, prevPose, tracker.solve.channels);
      let fit = f2f.fit;
      let tried = f2f.tried;

      // 2. Against the keyframe, through the estimate: warp the new frame back
      //    into the key's geometry, then measure only what is left. The key's
      //    corners never see a rotation, a zoom or a perspective — the warp
      //    already removed it — so they match however far the subject has
      //    turned, and the answer inherits nothing from the steps between.
      const k = key as Key | null;
      if (k && k.corners.length >= need) {
        const keyH = poseHomography(k.pose);
        const keyInv = invertHomography(keyH);
        const keyToNext = keyInv ? multiplyHomography(poseHomography(pose), keyInv) : null;
        if (keyToNext) {
          const shift: Homography = [1, 0, k.ox, 0, 1, k.oy, 0, 0, 1];
          const unshift: Homography = [1, 0, -k.ox, 0, 1, -k.oy, 0, 0, 1];
          const warped = warpFrame(next, multiplyHomography(keyToNext, shift), k.crop.width, k.crop.height);
          const viaKey = measure(k.crop, k.corners, warped, null, t, false);
          const agrees = viaKey?.fit && viaKey.fit.inlierCount >= need && viaKey.fit.inlierCount / k.corners.length >= 0.5;
          if (agrees) {
            const keyToNextRefined = multiplyHomography(keyToNext, multiplyHomography(shift, multiplyHomography(viaKey!.fit!.model, unshift)));
            const refined = poseFromHomography(multiplyHomography(keyToNextRefined, keyH));
            if (refined) {
              pose = constrain(refined, prevPose, tracker.solve.channels);
              fit = viaKey!.fit!;
              tried = viaKey!.tried;
            }
            // Resampling a much smaller or larger subject blurs the key; refresh it.
            if (Math.abs(Math.log(pose.scale / k.pose.scale)) > 0.5) rekey(next, pose);
          } else {
            // The appearance has moved on (light, a turn in depth): the last trusted frame becomes the key.
            rekey(prev, prevPose);
          }
        }
      }

      const ratio = fit.inlierCount / Math.max(1, tried);
      const support = clamp(fit.inlierCount / (need * 3), 0, 1);
      const precision = clamp(1 - fit.rms / (t.inlierPx * 1.5), 0, 1);
      return { pose, confidence: clamp(ratio * 0.5 + support * 0.3 + precision * 0.2, 0, 1), fb: f2f.fb, lost: false };
    },
  };
}

/** Channels the solve does not own come back from the previous pose — a constraint, not a suggestion. */
function constrain(pose: RegionPose, prior: RegionPose, channels: readonly TrackChannel[]): RegionPose {
  const has = (c: TrackChannel) => channels.includes(c);
  return {
    x: pose.x,
    y: pose.y,
    scale: has("scale") ? pose.scale : prior.scale,
    scaleY: has("scale") && (has("skew") || has("perspective")) ? pose.scaleY : prior.scaleY,
    rotation: has("rotation") ? pose.rotation : prior.rotation,
    skew: has("skew") ? (pose.skew ?? 0) : (prior.skew ?? 0),
    perspective: has("perspective") ? (pose.perspective ?? null) : (prior.perspective ?? null),
    warp: prior.warp ?? null,
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return Infinity;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

// ── Luma: masked NCC (small, low-texture targets) ────────────────────────────

function lumaStepper(tracker: RegionTracker): Stepper {
  let template: Template | null = null;
  let seedFrame: AnalysisFrame | null = null;
  let seedPose: RegionPose | null = null;
  const solveWarp = tracker.solve.channels.includes("shape");
  const vertices = solveWarp ? regionVertices(tracker.region) : [];
  return {
    method: "luma",
    seed(frame, pose) {
      template = buildTemplate(frame, tracker.region, pose);
      seedFrame = frame;
      seedPose = pose;
    },
    step(prev, prevPose, next, guess) {
      if (!template) template = buildTemplate(prev, tracker.region, prevPose);
      const radius = searchRadiusFor(tracker.region, tracker.solve, prevPose);
      const hit = searchPose(next, template, guess, tracker.solve, radius);
      const pose = constrain(hit, prevPose, tracker.solve.channels);
      // Round trip: lift the found patch, search for it back in prev.
      const back = searchPose(prev, buildTemplate(next, tracker.region, pose), prevPose, tracker.solve, Math.max(4, radius >> 2));
      const fb = Math.hypot(back.x - prevPose.x, back.y - prevPose.y);
      const confidence = clamp(hit.score, 0, 1);
      if (solveWarp && seedFrame && seedPose) pose.warp = refineWarp(next, seedFrame, vertices, pose, seedPose, tracker.solve);
      // Drift-guarded re-template: only a strong match becomes the new appearance.
      if (tracker.solve.adaptive && confidence > 0.82) template = buildTemplate(next, tracker.region, pose);
      return { pose, confidence, fb, lost: confidence <= 0.05 };
    },
  };
}

// ── Colour: weighted centroid ────────────────────────────────────────────────

function colorStepper(tracker: RegionTracker): Stepper {
  return {
    method: "color",
    seed() {},
    step(_prev, prevPose, next, guess) {
      const hit = colorPose(next, tracker.region, tracker.solve, guess);
      const { score, ...pose } = hit;
      return { pose: constrain(pose, prevPose, tracker.solve.channels), confidence: clamp(score, 0, 1), fb: 0, lost: score <= 0 };
    },
  };
}
