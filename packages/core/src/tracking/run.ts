import type { RegionTracker, TrackSample, TrackSpan } from "../schema/tracking";
import { isTrackAnchor } from "../schema/tracking";
import { FrameThrottle, type AnalysisFrame, type FrameProvider } from "./engine";
import { poseOf, shortestArc, type RegionPose } from "./pose";
import { sampleTracker } from "./samples";
import { distributeDrift } from "./solve";
import { makeStepper } from "./steppers";
import { regionPolylines } from "./contour";

/**
 * A RUN — one pass of a tracker over its footage: plan what is missing, walk
 * it with a cadence that knows when it doubts itself, hand back samples and
 * the spans they cover.
 *
 * ── What gets solved (`planRun`) ───────────────────────────────────────────
 *
 * The run seeds from what is already TRUSTED — the frame the region was drawn
 * on, every hand correction, and every sample inside a span already covered —
 * and solves only the frames nothing covers yet. So "Track" after a pause picks
 * up where it stopped, "Track forward" from the playhead leaves the past alone,
 * and a correction (`around`) re-solves exactly the stretch between its
 * neighbouring corrections, landing on each and spreading the residual drift
 * across the span between (the Mocha/Resolve correction model, `solve.ts`).
 *
 * ── How it walks (the cadence) ─────────────────────────────────────────────
 *
 * `every` measures every frame. `auto` strides — 1, 2, 4… up to `maxStride` —
 * while the method's own forward–backward check and confidence say the motion
 * is well understood, and halves the stride back down to single frames the
 * moment they do not. A locked-off shot of a sign costs a quarter of the
 * decodes; a whip pan costs exactly as many as it needs. Skipped frames are not
 * stored: the reader interpolates them (Catmull–Rom), and coverage counts them
 * as solved because the measurements either side vouched for the span.
 *
 * ── Stopping is not failing ────────────────────────────────────────────────
 *
 * A stopped run (`signal` aborted) RETURNS what it solved, with coverage up to
 * the last accepted frame — nothing measured is ever thrown away. Pausing is
 * the host's `gate`: the loop awaits it before every step.
 */

export type RunScope =
  | { kind: "all" }
  | { kind: "forward"; fromMs: number }
  | { kind: "backward"; fromMs: number }
  /** Re-solve the neighbourhood of a correction at `ms` — forced, coverage ignored. */
  | { kind: "around"; ms: number };

export interface RunSegment {
  seed: TrackSample;
  /** Times to solve, in walking order. */
  times: number[];
  direction: 1 | -1;
  /** The anchor this walk must land on, if any — what makes its drift measurable. */
  target: TrackSample | null;
}

const EPS = 0.5;

function nearestTime(sorted: number[], t: number): number {
  let best = sorted[0]!;
  for (const v of sorted) if (Math.abs(v - t) < Math.abs(best - t)) best = v;
  return best;
}

function covered(coverage: TrackSpan[], t: number): boolean {
  for (const [a, b] of coverage) if (t >= a - EPS && t <= b + EPS) return true;
  return false;
}

/** What the run will solve, and from where. Empty when nothing is missing (or nothing seeds it). */
export function planRun(tracker: RegionTracker, times: number[], scope: RunScope): RunSegment[] {
  const sorted = [...new Set(times)].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const coverage = tracker.analysis?.coverage ?? [];
  const anchors = tracker.samples.filter(isTrackAnchor);
  const isAnchorAt = (t: number) => anchors.some((a) => Math.abs(a.timeMs - t) < EPS);

  if (scope.kind === "around") {
    const at = anchors.find((a) => Math.abs(a.timeMs - scope.ms) < EPS) ?? sampleAsSeed(tracker, scope.ms);
    if (!at) return [];
    const prev = [...anchors].reverse().find((a) => a.timeMs < at.timeMs - EPS) ?? null;
    const next = anchors.find((a) => a.timeMs > at.timeMs + EPS) ?? null;
    const out: RunSegment[] = [];
    const before = sorted.filter((t) => t < at.timeMs - EPS && (!prev || t > prev.timeMs + EPS));
    if (before.length)
      out.push(prev ? { seed: prev, times: before, direction: 1, target: at } : { seed: at, times: before.reverse(), direction: -1, target: null });
    const after = sorted.filter((t) => t > at.timeMs + EPS && (!next || t < next.timeMs - EPS));
    if (after.length) out.push({ seed: at, times: after, direction: 1, target: next });
    return out;
  }

  // Trusted poses: corrections, the drawn frame, and measurements inside coverage.
  const trusted = new Map<number, TrackSample>();
  for (const s of tracker.samples) if (isTrackAnchor(s) || covered(coverage, s.timeMs)) trusted.set(s.timeMs, s);
  const ref = tracker.samples.find((s) => Math.abs(s.timeMs - tracker.referenceMs) < EPS);
  if (ref) trusted.set(ref.timeMs, ref);
  if (scope.kind !== "all") {
    // Walking from the playhead needs a pose THERE: the one on screen.
    const t = nearestTime(sorted, scope.fromMs);
    if (![...trusted.keys()].some((k) => Math.abs(k - t) < EPS)) {
      const seed = sampleAsSeed(tracker, t);
      if (seed) trusted.set(t, seed);
    }
  }
  if (trusted.size === 0) return [];
  const K = [...trusted.values()].sort((a, b) => a.timeMs - b.timeMs);

  const inScope = (t: number) =>
    scope.kind === "forward" ? t > scope.fromMs - EPS : scope.kind === "backward" ? t < scope.fromMs + EPS : true;
  const todo = sorted.filter((t) => inScope(t) && !covered(coverage, t) && !trusted.has(t) && !K.some((k) => Math.abs(k.timeMs - t) < EPS));
  if (todo.length === 0) return [];

  const out: RunSegment[] = [];
  if (scope.kind === "backward") {
    // Group by the first trusted pose AFTER each time; walk back from it.
    const groups = new Map<number, number[]>();
    for (const t of todo) {
      const j = K.findIndex((k) => k.timeMs > t);
      if (j === -1) continue; // nothing to seed from on the right
      (groups.get(j) ?? groups.set(j, []).get(j)!).push(t);
    }
    for (const [j, ts] of groups) {
      const left = K[j - 1];
      out.push({ seed: K[j]!, times: ts.sort((a, b) => b - a), direction: -1, target: left && isAnchorAt(left.timeMs) ? left : null });
    }
    return out;
  }

  // Forward (and "all"): group by the last trusted pose BEFORE each time.
  const groups = new Map<number, number[]>();
  for (const t of todo) {
    let i = -1;
    for (let k = 0; k < K.length; k++) if (K[k]!.timeMs < t) i = k;
    (groups.get(i) ?? groups.set(i, []).get(i)!).push(t);
  }
  for (const [i, ts] of groups) {
    if (i === -1) {
      if (scope.kind === "forward") continue;
      out.push({ seed: K[0]!, times: ts.sort((a, b) => b - a), direction: -1, target: null });
    } else {
      const right = K[i + 1];
      out.push({ seed: K[i]!, times: ts.sort((a, b) => a - b), direction: 1, target: right && isAnchorAt(right.timeMs) ? right : null });
    }
  }
  return out;
}

/** The pose on screen at a time, as an unpinned seed. */
function sampleAsSeed(tracker: RegionTracker, t: number): TrackSample | null {
  const s = sampleTracker(tracker, t);
  return s ? { ...s, timeMs: t, pinned: [] } : null;
}

export interface RunControl {
  signal: AbortSignal;
  /** Awaited before every step — the host's pause. */
  gate?: () => Promise<void>;
}

export interface RunProgress {
  /** Frames covered so far (skipped ones count — they are covered). */
  done: number;
  total: number;
  sample: TrackSample;
}

export interface RunResult {
  samples: TrackSample[];
  /** Source spans this run covered. */
  solved: TrackSpan[];
  stopped: boolean;
  /** Frames actually measured vs covered by stride, and how often the cadence backed off. */
  stats: { measured: number; covered: number; doubted: number; method: string | null };
}

/** Confidence below which an `auto` stride is not trusted. */
const DOUBT_CONFIDENCE = 0.45;
/**
 * Below this, even at single-frame stride, a step is not a measurement — the
 * subject left the frame, was covered, or the match is noise. Accepting such
 * steps (and learning velocity from them) is how a track that lost its icon
 * at the frame edge ran off to x = −6 000 at 2% scale: each bad step fed the
 * next guess. A lost step HOLDS the last trusted pose instead.
 */
const LOST_CONFIDENCE = 0.15;
/** A region with less than this share of its box inside the frame has left it. */
const MIN_IN_FRAME = 0.25;
/** A scale change past this factor in one step is a broken fit, not motion. */
const MAX_STEP_SCALE = 1.5;

/** How much of the region's box (analysis px) is inside a `w × h` frame, 0..1. */
function inFrameShare(tracker: RegionTracker, pose: RegionPose, w: number, h: number): number {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of regionPolylines(tracker.region, pose))
    for (const p of ring) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
  const area = (x1 - x0) * (y1 - y0);
  if (!(area > 0)) return 0;
  const ix = Math.max(0, Math.min(x1, w) - Math.max(x0, 0));
  const iy = Math.max(0, Math.min(y1, h) - Math.max(y0, 0));
  return (ix * iy) / area;
}

export async function runTracker(
  provider: FrameProvider,
  tracker: RegionTracker,
  scope: RunScope,
  control: RunControl,
  onProgress?: (p: RunProgress) => void,
): Promise<RunResult> {
  const stats = { measured: 0, covered: 0, doubted: 0, method: null as string | null };
  if (provider.still) {
    // A still shows the same pixels at every time: the drawn pose is the whole answer.
    const all = provider.times;
    return { samples: [], solved: all.length ? [[all[0]!, all[all.length - 1]!]] : [], stopped: false, stats };
  }
  const segments = planRun(tracker, provider.times, scope);
  const total = segments.reduce((n, s) => n + s.times.length, 0);
  const s = provider.scale;
  const cadence = tracker.solve.cadence;
  const auto = cadence.mode === "auto";
  const throttle = new FrameThrottle();
  const samples: TrackSample[] = [];
  const solved: TrackSpan[] = [];
  let done = 0;
  let stopped = false;

  for (const seg of segments) {
    if (control.signal.aborted) {
      stopped = true;
      break;
    }
    const seedFrame = await provider.getFrame(seg.seed.timeMs);
    let prevPose = toAnalysis(poseOf(seg.seed), s);
    const stepper = makeStepper(tracker, seedFrame, prevPose);
    stats.method ??= stepper.method;
    let prevFrame: AnalysisFrame = seedFrame;
    let prevTime = seg.seed.timeMs;
    let velocity: Velocity | null = null;
    let k = 1;
    let idx = -1;
    const produced: TrackSample[] = [];
    // Seeds that were not stored (a playhead seed) become measurements of their own.
    if (!tracker.samples.some((x) => Math.abs(x.timeMs - seg.seed.timeMs) < EPS)) produced.push({ ...seg.seed });

    while (idx < seg.times.length - 1) {
      await control.gate?.();
      if (control.signal.aborted) {
        stopped = true;
        break;
      }
      await throttle.tick();
      const j = Math.min(idx + (auto ? k : 1), seg.times.length - 1);
      const t = seg.times[j]!;
      const frame = await provider.getFrame(t);
      const guess = velocity ? extrapolate(prevPose, velocity, t - prevTime) : prevPose;
      const res = stepper.step(prevFrame, prevPose, frame, guess);
      stats.measured++;
      const doubted = res.lost || res.confidence < DOUBT_CONFIDENCE || res.fb > cadence.doubtPx * (j - idx);
      if (auto && doubted && j - idx > 1) {
        // Not sure across this stride: walk it in smaller steps.
        stats.doubted++;
        k = Math.max(1, Math.floor((j - idx) / 2));
        continue;
      }
      // TRUSTED, or held: only a real measurement may move the track. Trust is
      // judged on the EFFECTIVE confidence — the match discounted by its
      // round trip — the number that is stored and read back. Judging on the
      // match alone let a fit that failed its round trip shrink a region at
      // the frame edge to a fifth of its size, a little every frame.
      const fbPenalty = Number.isFinite(res.fb) ? Math.max(0.2, 1 - res.fb / Math.max(0.1, cadence.doubtPx * 4)) : 0.2;
      const effective = res.confidence * fbPenalty;
      const ratio = res.pose.scale / Math.max(1e-6, prevPose.scale);
      const trusted =
        !res.lost &&
        effective >= LOST_CONFIDENCE &&
        ratio < MAX_STEP_SCALE &&
        ratio > 1 / MAX_STEP_SCALE &&
        inFrameShare(tracker, res.pose, frame.width, frame.height) >= MIN_IN_FRAME;
      const pose = trusted ? res.pose : prevPose;
      const sample = toSample(pose, t, trusted ? effective : 0, s);
      produced.push(sample);
      done += j - idx;
      stats.covered += j - idx;
      onProgress?.({ done, total, sample });
      // Velocity learns only from trusted steps; a held one forgets it, so a
      // lost subject is never extrapolated off into space.
      velocity = trusted ? velocityOf(prevPose, pose, t - prevTime) : null;
      prevFrame = frame;
      prevPose = pose;
      prevTime = t;
      idx = j;
      if (auto && !doubted) k = Math.min(cadence.maxStride, k * 2);
      else if (auto) k = 1;
    }

    const complete = idx >= seg.times.length - 1;
    if (complete && seg.target) distributeDrift(produced.filter((p) => !p.pinned.length), seg.seed, seg.target);
    samples.push(...produced);
    if (idx >= 0) {
      const a = seg.seed.timeMs;
      // A walk that reached its anchor covers the anchor too — otherwise every
      // correction left a one-frame hole in coverage that read as "not tracked".
      const b = complete && seg.target ? seg.target.timeMs : seg.times[idx]!;
      solved.push([Math.min(a, b), Math.max(a, b)]);
    }
    if (stopped) break;
  }

  samples.sort((x, y) => x.timeMs - y.timeMs);
  return { samples, solved, stopped, stats };
}

// ── Analysis ↔ source space ──────────────────────────────────────────────────

function toAnalysis(p: RegionPose, s: number): RegionPose {
  return { ...p, x: p.x * s, y: p.y * s, scale: p.scale * s, scaleY: p.scaleY == null ? null : p.scaleY * s };
}

function toSample(p: RegionPose, timeMs: number, confidence: number, s: number): TrackSample {
  return {
    timeMs,
    x: p.x / s,
    y: p.y / s,
    scale: p.scale / s,
    scaleY: p.scaleY == null ? null : p.scaleY / s,
    rotation: p.rotation,
    skew: p.skew ?? 0,
    perspective: p.perspective ?? null,
    warp: p.warp ?? null,
    confidence: Math.max(0, Math.min(1, confidence)),
    pinned: [],
  };
}

// ── Prediction: constant velocity ────────────────────────────────────────────

interface Velocity {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

function velocityOf(a: RegionPose, b: RegionPose, dt: number): Velocity | null {
  if (!(Math.abs(dt) > 0)) return null;
  return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt, scale: (b.scale - a.scale) / dt, rotation: shortestArc(a.rotation, b.rotation) / dt };
}

function extrapolate(p: RegionPose, v: Velocity, dt: number): RegionPose {
  const scale = p.scale + v.scale * dt;
  return { ...p, x: p.x + v.x * dt, y: p.y + v.y * dt, scale: scale > 0 ? scale : p.scale, rotation: p.rotation + v.rotation * dt };
}
