import { seededRandom } from "../engine";
import { bundleAdjust, projectPx, type BundleProblem } from "./ba";
import { cameraCentre, essentialRansac, homographyRansac, poseFromEssential, refinePose, rotationBetween, toCamera, triangulate, triangulationAngle, IDENTITY_POSE, type Pose } from "./geometry";
import { apply3, matFromQuat, mul3, quatFromMat, slerp, transpose3, vadd, vnorm, vscale, vsub, type V3 } from "./linalg";

/**
 * THE CAMERA SOLVE — from feature tracks to a moving camera, a lens and a
 * point cloud. What SynthEyes, Blender's libmv and After Effects' 3D camera
 * tracker do, in plain TypeScript (core: DOM-free, runs in the analysis
 * worker and in tests).
 *
 *   1. KEYFRAMES. Frames close together see the same thing from the same
 *      place; only frames far enough apart carry depth. Keyframes are picked
 *      where the view has changed enough (shared tracks thinning, features
 *      travelling), and the expensive solve runs on them alone.
 *   2. A PAIR TO START FROM. Among nearby keyframe pairs, the one whose
 *      motion the essential matrix explains well and a homography does NOT
 *      (a pan, a flat wall and a static shot all fit a homography — they hold
 *      no depth to start from), with real parallax.
 *   3. GROW. Each next keyframe is placed against the points already known
 *      (PnP, robust), new points are triangulated where rays meet at a real
 *      angle, and the whole set is bundle-adjusted as it grows.
 *   4. EVERY FRAME. Frames between keyframes are placed against the final
 *      points from an interpolated start — a pose-only refinement each.
 *
 * LENS. Given a focal length, it is held (refined only when `refineFocal`).
 * Unknown, it is SEARCHED: the keyframe solve runs over a ladder of fields of
 * view and the best one is refined with the focal free in the final
 * adjustment. Principal point is the frame centre; no distortion model (the
 * plates people track here are phones and stock — see ADR-tracking).
 *
 * TRIPOD. A camera that only turns sees no depth; there the solve is rotation
 * only and the points are directions. `auto` takes the free solve when a
 * usable pair exists and falls back to tripod when nothing has parallax.
 */

// ── Input: long feature tracks ───────────────────────────────────────────────

/** One feature followed across consecutive frames, positions in PIXELS of `width × height`. */
export interface FeatureTrack {
  /** First frame index. */
  start: number;
  /** x, y per frame from `start`. */
  uv: Float32Array;
  /** Mean luma where it was found (0..255), the point cloud's grey. */
  luma: number;
}

export interface TrackSet {
  width: number;
  height: number;
  frames: number;
  tracks: FeatureTrack[];
}

export const trackLength = (t: FeatureTrack) => t.uv.length / 2;
const alive = (t: FeatureTrack, f: number) => f >= t.start && f < t.start + trackLength(t);
const uAt = (t: FeatureTrack, f: number) => t.uv[2 * (f - t.start)]!;
const vAt = (t: FeatureTrack, f: number) => t.uv[2 * (f - t.start) + 1]!;

// ── Output ───────────────────────────────────────────────────────────────────

export interface CameraSolution {
  mode: "free" | "tripod";
  /** Focal length and principal point, px. */
  f: number;
  cx: number;
  cy: number;
  /** World → camera per frame; null where the frame could not be placed. */
  poses: (Pose | null)[];
  /** Triangulated points (tripod: unit directions), flat xyz. */
  points: Float64Array;
  /** Grey of each point (0..255). */
  pointLuma: Float32Array;
  /** Tracks each point came from (parallel to points/3). */
  pointTrack: Int32Array;
  /** RMS reprojection error over every frame, px. */
  rms: number;
  /** Per-frame RMS, px (NaN where unsolved). */
  frameRms: Float32Array;
  keyframes: number[];
}

export interface SolveOptions {
  mode: "auto" | "free" | "tripod";
  /** Known focal length in px of `width × height`; null searches it. */
  focalPx: number | null;
  /** Refine a known focal in the final adjustment. */
  refineFocal?: boolean;
  seed?: number;
  /** Called between phases: what is happening and how far (0..1). */
  onProgress?: (note: string, fraction: number) => void;
  /** Cancellation. */
  aborted?: () => boolean;
}

/** Inlier distance, px. */
const INLIER_PX = 2.5;
/** Minimum triangulation angle for a new point, degrees. */
const MIN_ANGLE = 1.2;

export class SolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolveError";
  }
}

// ── Keyframes ────────────────────────────────────────────────────────────────

function sharedTracks(set: TrackSet, a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < set.tracks.length; i++) {
    const t = set.tracks[i]!;
    if (alive(t, a) && alive(t, b)) out.push(i);
  }
  return out;
}

function medianFlow(set: TrackSet, ids: number[], a: number, b: number): number {
  if (!ids.length) return 0;
  const d = ids.map((i) => {
    const t = set.tracks[i]!;
    return Math.hypot(uAt(t, a) - uAt(t, b), vAt(t, a) - vAt(t, b));
  });
  d.sort((x, y) => x - y);
  return d[d.length >> 1]!;
}

/** Keyframes where the view has moved on: tracks shared with the last one thin, or features travel far. */
export function pickKeyframes(set: TrackSet, maxKeyframes = 48): number[] {
  const W = Math.max(set.width, set.height);
  const aliveAt = (f: number) => set.tracks.reduce((n, t) => n + (alive(t, f) ? 1 : 0), 0);
  // Wider spacing on long shots, so the keyframe count stays bounded.
  const flowStep = Math.max(0.02, (0.02 * set.frames) / (maxKeyframes * 4));
  // Never further apart than this, however calm the shot: the lens and the path need views.
  const maxGap = Math.max(6, Math.ceil(set.frames / maxKeyframes));
  const kf = [0];
  let last = 0;
  let lastAlive = aliveAt(0);
  for (let f = 1; f < set.frames; f++) {
    const shared = sharedTracks(set, last, f);
    const thin = shared.length < Math.max(24, lastAlive * 0.6);
    const far = medianFlow(set, shared, last, f) > flowStep * W || f - last >= maxGap;
    if (thin || far) {
      const pick = f - 1 > last ? (thin ? f - 1 : f) : f;
      kf.push(pick);
      last = pick;
      lastAlive = aliveAt(pick);
    }
  }
  if (kf[kf.length - 1] !== set.frames - 1) kf.push(set.frames - 1);
  return [...new Set(kf)].sort((a, b) => a - b);
}

// ── The reconstruction state ─────────────────────────────────────────────────

interface Recon {
  set: TrackSet;
  f: number;
  cx: number;
  cy: number;
  poses: (Pose | null)[];
  /** Point per track (or null). */
  X: (V3 | null)[];
  /** Observations judged outliers: key = track*frames + frame. */
  bad: Set<number>;
}

const badKey = (r: Recon, track: number, frame: number) => track * r.set.frames + frame;

function norm(r: Recon, t: FeatureTrack, frame: number): [number, number] {
  return [(uAt(t, frame) - r.cx) / r.f, (vAt(t, frame) - r.cy) / r.f];
}

/** Triangulate tracks with no point yet, from the given registered frames. */
function triangulateNew(r: Recon, frames: number[], minViews = 2): number {
  let made = 0;
  for (let i = 0; i < r.set.tracks.length; i++) {
    if (r.X[i]) continue;
    const t = r.set.tracks[i]!;
    const views = frames.filter((f) => r.poses[f] && alive(t, f) && !r.bad.has(badKey(r, i, f)));
    if (views.length < minViews) continue;
    // Use a spread of views: the ends and up to four between.
    const pick = views.length <= 6 ? views : [0, 1, 2, 3, 4, 5].map((k) => views[Math.round((k * (views.length - 1)) / 5)]!);
    const poses = pick.map((f) => r.poses[f]!);
    const xy: number[] = [];
    for (const f of pick) xy.push(...norm(r, t, f));
    const X = triangulate(poses, xy);
    if (!X) continue;
    if (triangulationAngle(poses.map(cameraCentre), X) < MIN_ANGLE) continue;
    let ok = true;
    for (const f of views) {
      const c = toCamera(r.poses[f]!, X);
      if (c[2] <= 0) {
        ok = false;
        break;
      }
      const e = Math.hypot((r.f * c[0]) / c[2] + r.cx - uAt(t, f), (r.f * c[1]) / c[2] + r.cy - vAt(t, f));
      if (e > INLIER_PX * 2) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    r.X[i] = X;
    made++;
  }
  return made;
}

/** Bundle-adjust the registered `frames` and every point they see; drop what still disagrees. */
function adjust(r: Recon, frames: number[], opts: { fixFirst: number; focal: boolean; rotationOnly?: boolean; iterations?: number }): number {
  const reg = frames.filter((f) => r.poses[f]);
  const camOf = new Map(reg.map((f, k) => [f, k]));
  const ptOf = new Map<number, number>();
  const cam: number[] = [];
  const pt: number[] = [];
  const uv: number[] = [];
  const obsTrack: number[] = [];
  for (let i = 0; i < r.set.tracks.length; i++) {
    const X = r.X[i];
    if (!X) continue;
    const t = r.set.tracks[i]!;
    const seen = reg.filter((f) => alive(t, f) && !r.bad.has(badKey(r, i, f)));
    if (seen.length < (opts.rotationOnly ? 1 : 2)) continue;
    const j = ptOf.size;
    ptOf.set(i, j);
    for (const f of seen) {
      cam.push(camOf.get(f)!);
      pt.push(j);
      uv.push(uAt(t, f), vAt(t, f));
      obsTrack.push(i);
    }
  }
  if (cam.length < 12) return Infinity;
  const points = new Float64Array(ptOf.size * 3);
  for (const [i, j] of ptOf) points.set(r.X[i]!, 3 * j);
  const problem: BundleProblem = {
    poses: reg.map((f) => r.poses[f]!),
    fixed: reg.map((f) => f === opts.fixFirst),
    points,
    cam: Int32Array.from(cam),
    pt: Int32Array.from(pt),
    uv: Float64Array.from(uv),
    f: r.f,
    cx: r.cx,
    cy: r.cy,
    solveFocal: opts.focal,
    rotationOnly: !!opts.rotationOnly,
    huberPx: INLIER_PX,
  };
  const out = bundleAdjust(problem, opts.iterations ?? 30);
  reg.forEach((f, k) => (r.poses[f] = problem.poses[k]!));
  for (const [i, j] of ptOf) r.X[i] = [problem.points[3 * j]!, problem.points[3 * j + 1]!, problem.points[3 * j + 2]!];
  r.f = problem.f;
  // Outliers: observations beyond the inlier distance leave; points left with too few go.
  for (let k = 0; k < cam.length; k++) if (out.errors[k]! > INLIER_PX * 2) r.bad.add(badKey(r, obsTrack[k]!, reg[cam[k]!]!));
  for (const [i] of ptOf) {
    const t = r.set.tracks[i]!;
    const good = reg.filter((f) => alive(t, f) && !r.bad.has(badKey(r, i, f))).length;
    if (good < (opts.rotationOnly ? 1 : 2)) r.X[i] = null;
  }
  return out.rms;
}

/** Correspondences between two frames, normalised, for the tracks given. */
function pairPoints(r: Recon, ids: number[], a: number, b: number): { A: Float64Array; B: Float64Array } {
  const A = new Float64Array(ids.length * 2);
  const B = new Float64Array(ids.length * 2);
  ids.forEach((i, k) => {
    const t = r.set.tracks[i]!;
    A.set(norm(r, t, a), 2 * k);
    B.set(norm(r, t, b), 2 * k);
  });
  return { A, B };
}

interface InitPair {
  a: number;
  b: number;
  score: number;
}

/** The keyframe pair the reconstruction starts from — or null when nothing carries depth. */
function findInitPair(r: Recon, kf: number[], rand: () => number): InitPair | null {
  const W = Math.max(r.set.width, r.set.height);
  let best: InitPair | null = null;
  for (let i = 0; i < kf.length; i++) {
    for (let d = 1; d <= 4 && i + d < kf.length; d++) {
      const a = kf[i]!;
      const b = kf[i + d]!;
      const ids = sharedTracks(r.set, a, b);
      if (ids.length < 30) continue;
      const flow = medianFlow(r.set, ids, a, b);
      if (flow < 0.02 * W) continue;
      const { A, B } = pairPoints(r, ids, a, b);
      const E = essentialRansac(A, B, INLIER_PX / r.f, 256, rand);
      if (!E || E.count < 30) continue;
      const H = homographyRansac(A, B, (INLIER_PX * 1.5) / r.f, 192, rand);
      const ratio = H ? H.count / E.count : 0;
      // A homography that explains (nearly) everything means a pan or a plane: no depth.
      if (ratio > 0.88) continue;
      const score = E.count * Math.min(1, flow / (0.08 * W)) * (1 - ratio);
      if (!best || score > best.score) best = { a, b, score };
    }
  }
  return best;
}

/** Reconstruct the keyframes at focal `f`. Null when no pair could start it. */
function reconstructKeyframes(set: TrackSet, kf: number[], f: number, rand: () => number, opts: { pair: InitPair; refineFocal: boolean; aborted?: () => boolean; limit?: number }): Recon | null {
  const r: Recon = { set, f, cx: set.width / 2, cy: set.height / 2, poses: Array(set.frames).fill(null), X: Array(set.tracks.length).fill(null), bad: new Set() };
  const pair = opts.pair;
  const ids = sharedTracks(set, pair.a, pair.b);
  const { A, B } = pairPoints(r, ids, pair.a, pair.b);
  const E = essentialRansac(A, B, INLIER_PX / r.f, 512, rand);
  if (!E) return null;
  const rel = poseFromEssential(E.model, A, B, E.inliers);
  if (!rel || rel.front < 24) return null;
  r.poses[pair.a] = IDENTITY_POSE();
  r.poses[pair.b] = rel.pose;
  ids.forEach((i, k) => {
    if (!E.inliers[k]) r.bad.add(badKey(r, i, pair.b));
  });
  triangulateNew(r, [pair.a, pair.b]);
  adjust(r, [pair.a, pair.b], { fixFirst: pair.a, focal: false });

  // Grow outward from the pair, nearest keyframe first, adjusting as the set grows.
  const registered = new Set([pair.a, pair.b]);
  const ia = kf.indexOf(pair.a);
  const ib = kf.indexOf(pair.b);
  // Keyframes between the pair first, then alternating outward.
  const queue: number[] = [];
  for (let k = ia + 1; k < ib; k++) queue.push(kf[k]!);
  for (let lo = ia - 1, hi = ib + 1; lo >= 0 || hi < kf.length; lo--, hi++) {
    if (hi < kf.length) queue.push(kf[hi]!);
    if (lo >= 0) queue.push(kf[lo]!);
  }
  let since = 0;
  for (const frame of queue) {
    if (opts.aborted?.()) return null;
    if (opts.limit && registered.size >= opts.limit) break;
    const near = [...registered].sort((x, y) => Math.abs(x - frame) - Math.abs(y - frame))[0]!;
    if (!placeFrame(r, frame, r.poses[near]!)) continue;
    registered.add(frame);
    triangulateNew(r, [...registered].sort((x, y) => x - y));
    if (++since >= 4) {
      adjust(r, [...registered], { fixFirst: pair.a, focal: false, iterations: 12 });
      since = 0;
    }
  }
  const regs = [...registered].sort((x, y) => x - y);
  adjust(r, regs, { fixFirst: pair.a, focal: opts.refineFocal });
  triangulateNew(r, regs);
  adjust(r, regs, { fixFirst: pair.a, focal: opts.refineFocal });
  return r;
}

/** Place one frame against the known points, from a starting pose. False when too little agrees. */
function placeFrame(r: Recon, frame: number, start: Pose, minInliers = 12): boolean {
  const X: number[] = [];
  const xy: number[] = [];
  const which: number[] = [];
  for (let i = 0; i < r.set.tracks.length; i++) {
    const p = r.X[i];
    const t = r.set.tracks[i]!;
    if (!p || !alive(t, frame)) continue;
    X.push(...p);
    xy.push(...norm(r, t, frame));
    which.push(i);
  }
  if (which.length < minInliers) return false;
  const fit = refinePose(start, X, xy, INLIER_PX / r.f);
  if (fit.count < minInliers || fit.count < which.length * 0.35) return false;
  r.poses[frame] = fit.pose;
  which.forEach((i, k) => {
    if (!fit.inliers[k]) r.bad.add(badKey(r, i, frame));
  });
  return true;
}

function interpolatePose(a: Pose, b: Pose, t: number): Pose {
  const ca = cameraCentre(a);
  const cb = cameraCentre(b);
  const q = slerp(quatFromMat(a.R), quatFromMat(b.R), t);
  const R = matFromQuat(q);
  const c = vadd(ca, vscale(vsub(cb, ca), t));
  return { R, t: vscale(apply3(R, c), -1) };
}

/** Score of a keyframe solve — RMS px, with a penalty for keyframes it could not place. */
function reconScore(r: Recon, kf: number[], expected = kf.length): number {
  let sq = 0;
  let n = 0;
  for (const f of kf) {
    const pose = r.poses[f];
    if (!pose) continue;
    for (let i = 0; i < r.set.tracks.length; i++) {
      const X = r.X[i];
      const t = r.set.tracks[i]!;
      if (!X || !alive(t, f) || r.bad.has(badKey(r, i, f))) continue;
      const q = projectPx(pose, X, r.f, r.cx, r.cy);
      if (!q) continue;
      sq += (q[0] - uAt(t, f)) ** 2 + (q[1] - vAt(t, f)) ** 2;
      n++;
    }
  }
  const placed = Math.min(1, kf.filter((f) => r.poses[f]).length / Math.max(1, expected));
  const rms = n ? Math.sqrt(sq / n) : Infinity;
  // Fewer placed keyframes or fewer kept observations is a worse lens, not a better one.
  return rms / Math.max(0.05, placed * placed);
}

/** At most `n` of `list`, evenly spread, first and last kept. */
function subsample(list: number[], n: number): number[] {
  if (list.length <= n) return list;
  return [...new Set(Array.from({ length: n }, (_, k) => list[Math.round((k * (list.length - 1)) / (n - 1))]!))];
}

/** The lens a world camera is measured in: mm across a 36 mm sensor on the frame's long side. */
export const SENSOR_MM = 36;

/** Focal length (px) from a horizontal field of view across the long edge. */
export const focalFromFov = (fovDeg: number, longEdge: number) => longEdge / 2 / Math.tan((fovDeg * Math.PI) / 360);

// ── Tripod ───────────────────────────────────────────────────────────────────

function bearing(r: Recon, t: FeatureTrack, f: number): V3 {
  const [x, y] = norm(r, t, f);
  return vnorm([x, y, 1]);
}

/** Rotation-only reconstruction of the keyframes at focal `f`. */
function reconstructTripod(set: TrackSet, kf: number[], f: number, rand: () => number, refineFocal: boolean): Recon | null {
  const r: Recon = { set, f, cx: set.width / 2, cy: set.height / 2, poses: Array(set.frames).fill(null), X: Array(set.tracks.length).fill(null), bad: new Set() };
  r.poses[kf[0]!] = IDENTITY_POSE();
  for (let k = 1; k < kf.length; k++) {
    const a = kf[k - 1]!;
    const b = kf[k]!;
    const ids = sharedTracks(set, a, b);
    if (ids.length < 8 || !r.poses[a]) continue;
    const da = ids.map((i) => bearing(r, set.tracks[i]!, a));
    const db = ids.map((i) => bearing(r, set.tracks[i]!, b));
    // RANSAC over 3-point Kabsch fits, then refit on the inliers.
    let best: { R: number[]; inl: number[] } | null = null;
    const thr = INLIER_PX / f;
    for (let it = 0; it < 96; it++) {
      const s = [0, 0, 0].map(() => Math.floor(rand() * ids.length));
      if (s[0] === s[1] || s[1] === s[2] || s[0] === s[2]) continue;
      const Rr = rotationBetween(s.map((q) => da[q]!), s.map((q) => db[q]!));
      const inl: number[] = [];
      for (let q = 0; q < ids.length; q++) {
        const p = apply3(Rr, da[q]!);
        if (Math.hypot(p[0] / p[2] - db[q]![0] / db[q]![2], p[1] / p[2] - db[q]![1] / db[q]![2]) < thr) inl.push(q);
      }
      if (!best || inl.length > best.inl.length) best = { R: Rr, inl };
    }
    if (!best || best.inl.length < 8) continue;
    const Rrel = rotationBetween(best.inl.map((q) => da[q]!), best.inl.map((q) => db[q]!));
    r.poses[b] = { R: mul3(Rrel, r.poses[a]!.R), t: [0, 0, 0] };
  }
  // Directions: the mean world ray of each track over the keyframes that see it.
  for (let i = 0; i < set.tracks.length; i++) {
    const t = set.tracks[i]!;
    let acc: V3 = [0, 0, 0];
    let n = 0;
    for (const fr of kf) {
      const pose = r.poses[fr];
      if (!pose || !alive(t, fr)) continue;
      acc = vadd(acc, apply3(transpose3(pose.R), bearing(r, t, fr)));
      n++;
    }
    if (n >= 2) r.X[i] = vnorm(acc);
  }
  const regs = kf.filter((fr) => r.poses[fr]);
  if (regs.length < 2) return null;
  adjust(r, regs, { fixFirst: kf[0]!, focal: false, rotationOnly: true });
  adjust(r, regs, { fixFirst: kf[0]!, focal: refineFocal, rotationOnly: true });
  return r;
}

/** Place a frame of a tripod shot: the rotation carrying the known directions onto what it sees. */
function placeTripodFrame(r: Recon, frame: number, start: Pose): boolean {
  const dirs: V3[] = [];
  const seen: V3[] = [];
  const which: number[] = [];
  for (let i = 0; i < r.set.tracks.length; i++) {
    const X = r.X[i];
    const t = r.set.tracks[i]!;
    if (!X || !alive(t, frame)) continue;
    dirs.push(X);
    seen.push(bearing(r, t, frame));
    which.push(i);
  }
  if (dirs.length < 6) return false;
  let R = start.R;
  const thr = (INLIER_PX * 2) / r.f;
  for (let round = 0; round < 3; round++) {
    const keep: number[] = [];
    for (let q = 0; q < dirs.length; q++) {
      const p = apply3(R, dirs[q]!);
      if (p[2] > 0 && Math.hypot(p[0] / p[2] - seen[q]![0] / seen[q]![2], p[1] / p[2] - seen[q]![1] / seen[q]![2]) < thr * (round === 0 ? 4 : 1)) keep.push(q);
    }
    if (keep.length < 6) return false;
    R = rotationBetween(keep.map((q) => dirs[q]!), keep.map((q) => seen[q]!));
  }
  r.poses[frame] = { R, t: [0, 0, 0] };
  for (let q = 0; q < dirs.length; q++) {
    const p = apply3(R, dirs[q]!);
    if (!(p[2] > 0) || Math.hypot(p[0] / p[2] - seen[q]![0] / seen[q]![2], p[1] / p[2] - seen[q]![1] / seen[q]![2]) > thr) r.bad.add(badKey(r, which[q]!, frame));
  }
  return true;
}

// ── Everything together ──────────────────────────────────────────────────────

/** The fields of view (degrees, across the long edge) tried when the lens is unknown — 14 mm to 135 mm on full frame. */
const FOV_LADDER = [15, 22, 30, 38, 46, 54, 63, 72, 82, 95];

export function solveCamera(set: TrackSet, options: SolveOptions): CameraSolution {
  const rand = seededRandom(options.seed ?? 7);
  const progress = options.onProgress ?? (() => {});
  const long = Math.max(set.width, set.height);
  const kf = pickKeyframes(set);
  if (kf.length < 2) throw new SolveError("The shot is too short to solve.");

  const tryMode = (mode: "free" | "tripod"): { r: Recon; score: number } | null => {
    // The ladder runs on a subset of keyframes (the pair and its neighbours): it ranks lenses, it does not need the whole shot.
    const ladderKf = mode === "tripod" ? subsample(kf, 16) : kf;
    // Which pair carries depth hardly depends on the lens: choose it once, at the known lens or a middling one.
    let pair: InitPair | null = null;
    if (mode === "free") {
      const probe: Recon = { set, f: options.focalPx ?? focalFromFov(50, long), cx: set.width / 2, cy: set.height / 2, poses: [], X: [], bad: new Set() };
      pair = findInitPair(probe, kf, rand);
      if (!pair) return null;
    }
    const build = (f: number, refine: boolean, quick = false) =>
      mode === "free"
        ? reconstructKeyframes(set, kf, f, rand, { pair: pair!, refineFocal: refine, aborted: options.aborted, limit: quick ? 12 : undefined })
        : reconstructTripod(set, quick ? ladderKf : kf, f, rand, refine);
    if (options.focalPx) {
      const r = build(options.focalPx, !!options.refineFocal);
      return r ? { r, score: reconScore(r, kf) } : null;
    }
    // Search the lens: hold each focal on the ladder, keep the best two, free the focal from each.
    const tried: Array<{ f: number; score: number }> = [];
    FOV_LADDER.forEach((fov, k) => {
      if (options.aborted?.()) return;
      progress(mode === "free" ? "Finding the lens" : "Finding the lens (tripod)", k / FOV_LADDER.length);
      const f = focalFromFov(fov, long);
      const r = build(f, false, true);
      if (r) tried.push({ f, score: reconScore(r, mode === "tripod" ? ladderKf : kf, mode === "tripod" ? ladderKf.length : Math.min(12, kf.length)) });
    });
    if (!tried.length) return null;
    tried.sort((a, b) => a.score - b.score);
    let best: { r: Recon; score: number } | null = null;
    for (const t of tried.slice(0, 2)) {
      const r = build(t.f, true);
      if (!r) continue;
      const score = reconScore(r, kf);
      if (!best || score < best.score) best = { r, score };
    }
    return best;
  };

  let mode: "free" | "tripod" = options.mode === "tripod" ? "tripod" : "free";
  progress("Solving keyframes", 0);
  let got = mode === "free" ? tryMode("free") : null;
  if (!got && options.mode !== "free") {
    mode = "tripod";
    got = tryMode("tripod");
  }
  if (options.aborted?.()) throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
  if (!got) {
    throw new SolveError(
      options.mode === "free"
        ? "No two frames see the scene from far enough apart. If the camera only turns, solve it as a tripod shot."
        : "Not enough features to follow through the shot.",
    );
  }
  const r = got.r;

  // Every frame: from the bracketing keyframes' interpolated pose.
  progress("Placing every frame", 0.85);
  const regs = kf.filter((f) => r.poses[f]);
  for (let f = 0; f < set.frames; f++) {
    if (r.poses[f]) continue;
    let lo = -1;
    let hi = -1;
    for (const k of regs) {
      if (k < f) lo = k;
      else if (hi === -1 && k > f) hi = k;
    }
    const start = lo >= 0 && hi >= 0 ? interpolatePose(r.poses[lo]!, r.poses[hi]!, (f - lo) / (hi - lo)) : r.poses[lo >= 0 ? lo : hi]!;
    if (!start) continue;
    if (mode === "tripod") placeTripodFrame(r, f, start);
    else if (!placeFrame(r, f, start, 8)) r.poses[f] = null;
  }
  if (mode === "free") {
    // More points from all placed frames (denser cloud, steadier in-betweens), then one more pose pass.
    const placed = Array.from({ length: set.frames }, (_, f) => f).filter((f) => r.poses[f]);
    triangulateNew(r, placed, 2);
    for (const f of placed) if (!kf.includes(f)) placeFrame(r, f, r.poses[f]!, 8);
  }

  // Report.
  const frameRms = new Float32Array(set.frames).fill(NaN);
  let sq = 0;
  let n = 0;
  for (let f = 0; f < set.frames; f++) {
    const pose = r.poses[f];
    if (!pose) continue;
    let fs = 0;
    let fn = 0;
    for (let i = 0; i < set.tracks.length; i++) {
      const X = r.X[i];
      const t = set.tracks[i]!;
      if (!X || !alive(t, f) || r.bad.has(badKey(r, i, f))) continue;
      const q = projectPx(pose, X, r.f, r.cx, r.cy);
      if (!q) continue;
      const e2 = (q[0] - uAt(t, f)) ** 2 + (q[1] - vAt(t, f)) ** 2;
      fs += e2;
      fn++;
    }
    frameRms[f] = fn ? Math.sqrt(fs / fn) : NaN;
    sq += fs;
    n += fn;
  }
  const ids = r.X.map((x, i) => (x ? i : -1)).filter((i) => i >= 0);
  const points = new Float64Array(ids.length * 3);
  const pointLuma = new Float32Array(ids.length);
  ids.forEach((i, k) => {
    points.set(r.X[i]!, 3 * k);
    pointLuma[k] = set.tracks[i]!.luma;
  });
  progress("Solved", 1);
  return {
    mode,
    f: r.f,
    cx: r.cx,
    cy: r.cy,
    poses: r.poses,
    points,
    pointLuma,
    pointTrack: Int32Array.from(ids),
    rms: n ? Math.sqrt(sq / n) : Infinity,
    frameRms,
    keyframes: kf,
  };
}
