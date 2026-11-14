import type { CameraSolution, CameraTracker, TrackSpan } from "../../schema/tracking";
import type { FrameProvider } from "../engine";
import type { RunControl } from "../run";
import { DEFAULT_FEATURES, followFeatures } from "./features";
import { cameraCentre } from "./geometry";
import { quatFromMat, transpose3 } from "./linalg";
import { SENSOR_MM, solveCamera, type CameraSolution as RawSolution } from "./solve";

/**
 * A CAMERA RUN — the whole shot, end to end: follow features through every
 * frame, solve, and hand back the solution in the document's shape. Runs in
 * the analysis worker; the following phase reports per frame, the solve per
 * phase.
 */

export interface CameraRunResult {
  solution: CameraSolution;
  /** The source span the solve covered. */
  solved: TrackSpan[];
  stats: { tracks: number; points: number; keyframes: number; trackMs: number; solveMs: number };
}

/** The lens the solve is told about, px of the plate — or null to find it. */
export function knownFocalPx(tracker: CameraTracker, width: number, height: number): number | null {
  const mm = tracker.solve.focalLength;
  return mm ? (mm * Math.max(width, height)) / SENSOR_MM : null;
}

export async function runCameraSolve(
  provider: FrameProvider,
  tracker: CameraTracker,
  control: RunControl,
  onProgress?: (p: { done: number; total: number; note: string }) => void,
): Promise<CameraRunResult> {
  if (provider.still) throw Object.assign(new Error("A still has no camera motion to solve."), { name: "SolveError" });
  const times = provider.times;
  const t0 = Date.now();
  // Following is most of the wall time on real footage; it reports per frame (70% of the bar).
  const set = await followFeatures(provider, times, { ...DEFAULT_FEATURES, target: tracker.solve.features }, control, (done, total) =>
    onProgress?.({ done: Math.round((done / total) * 700), total: 1000, note: `Following features — frame ${done} of ${total}` }),
  );
  const trackMs = Date.now() - t0;
  const raw = solveCamera(set, {
    mode: tracker.solve.mode,
    focalPx: knownFocalPx(tracker, set.width, set.height),
    aborted: () => control.signal.aborted,
    onProgress: (note, fraction) => onProgress?.({ done: 700 + Math.round(fraction * 300), total: 1000, note }),
  });
  return {
    solution: toDocument(raw, times, set.width, set.height),
    solved: [[times[0]!, times[times.length - 1]!]],
    stats: { tracks: set.tracks.length, points: raw.points.length / 3, keyframes: raw.keyframes.length, trackMs, solveMs: Date.now() - t0 - trackMs },
  };
}

/** The solver's per-frame poses → the document's flat, gap-skipping shape (rounded: a document is not a float dump). */
export function toDocument(raw: RawSolution, times: readonly number[], width: number, height: number): CameraSolution {
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  const outTimes: number[] = [];
  const poses: number[] = [];
  const frameError: number[] = [];
  raw.poses.forEach((p, i) => {
    if (!p) return;
    const q = quatFromMat(transpose3(p.R));
    const c = cameraCentre(p);
    outTimes.push(times[i]!);
    poses.push(...q.map(r6), ...c.map(r6));
    const e = raw.frameRms[i]!;
    frameError.push(Number.isFinite(e) ? Math.round(e * 1000) / 1000 : raw.rms);
  });
  return {
    mode: raw.mode,
    width,
    height,
    focalPx: r6(raw.f),
    times: outTimes,
    poses,
    frameError,
    points: Array.from(raw.points, r6),
    pointLuma: Array.from(raw.pointLuma, (v) => Math.round(v)),
    error: Math.round(raw.rms * 1000) / 1000,
  };
}
