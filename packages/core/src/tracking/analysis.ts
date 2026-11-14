import type { CameraTracker, DepthTracker, RegionTracker, TrackSample } from "../schema/tracking";
import type { FrameProvider } from "./engine";
import { runTracker, type RunControl, type RunResult, type RunScope } from "./run";
import { runCameraSolve, type CameraRunResult } from "./camera/run-camera";
import { runDepth, type DepthEngine, type DepthRunResult } from "./depth/run-depth";

/**
 * WHAT THE ANALYSIS WORKER RUNS — one job union, one runner, used on both
 * sides of the thread boundary.
 *
 * The app sends a JOB (a tracker snapshot and what to do with it) and a frame
 * source; the worker builds a `FrameProvider` over that source and calls
 * `runAnalysisJob`. Where a worker cannot start (an old engine, a CSP), the
 * app calls the very same function on the main thread with its own provider —
 * so there is one implementation of every solve, and the worker is only WHERE
 * it runs, never a second copy of HOW.
 *
 * Everything in a job and its outcome is structured-cloneable plain data: a
 * tracker is a zod-parsed document object, a result is samples and spans.
 *
 * This file is also the `@solomotion/core/analysis` entry: the worker imports
 * the solvers from here and nothing else, so it does not pull the document,
 * the renderer contract or the API into its bundle.
 */

export type AnalysisJob =
  | { kind: "region"; tracker: RegionTracker; scope: RunScope }
  /** Follow features through the whole plate and solve its camera. */
  | { kind: "camera"; tracker: CameraTracker }
  /** Every frame through a depth model, into nearness maps that agree across the shot. */
  | { kind: "depth"; tracker: DepthTracker; temporal: boolean };

export type AnalysisOutcome =
  | { kind: "region"; result: RunResult }
  | { kind: "camera"; result: CameraRunResult }
  | { kind: "depth"; result: DepthRunResult };

/**
 * What a job may need from its host beyond frames: the depth network (run
 * by onnxruntime in the worker). Core never imports a model runtime.
 */
export interface AnalysisPorts {
  /** The networks a depth job may use. `temporal`: the video head may be tried (the host knows whether this device holds it). */
  depth?: (tracker: DepthTracker, still: boolean, temporal: boolean, onNote: (note: string) => void) => Promise<DepthEngine>;
}

export interface AnalysisProgress {
  done: number;
  total: number;
  /** What the solve is doing, in a person's words ("Following features", "Refining"). */
  note?: string;
  /** Region runs: the latest measured frame, so the outline can ride the footage. */
  sample?: TrackSample;
}

export async function runAnalysisJob(
  provider: FrameProvider,
  job: AnalysisJob,
  control: RunControl,
  onProgress?: (p: AnalysisProgress) => void,
  ports: AnalysisPorts = {},
): Promise<AnalysisOutcome> {
  switch (job.kind) {
    case "region": {
      const result = await runTracker(provider, job.tracker, job.scope, control, (p) =>
        onProgress?.({ done: p.done, total: p.total, sample: p.sample }),
      );
      return { kind: "region", result };
    }
    case "camera":
      return { kind: "camera", result: await runCameraSolve(provider, job.tracker, control, onProgress) };
    case "depth": {
      if (!ports.depth) throw Object.assign(new Error("Depth needs the analysis engine's models."), { name: "SolveError" });
      const engine = await ports.depth(job.tracker, provider.still, job.temporal, (note) => onProgress?.({ done: 0, total: 1, note }));
      return { kind: "depth", result: await runDepth(provider, job.tracker, engine, control, onProgress) };
    }
  }
}

/** Does this job read colour (so frames must carry RGBA, not luma alone)? */
export function jobWantsColor(job: AnalysisJob): boolean {
  return job.kind === "depth" || (job.kind === "region" && job.tracker.solve.method === "color");
}

export { lumaFromRgba, analysisScale, type AnalysisFrame, type FrameProvider } from "./engine";
export type { RunControl, RunResult, RunScope } from "./run";
export type { CameraRunResult } from "./camera/run-camera";
export { depthModelFor, type DepthEngine, type DepthRunResult, type VideoDepthPort, type StillDepthPort, type DepthSense } from "./depth/run-depth";
export { lazyModule } from "../lazy";
export { yieldNow } from "../runtime/chunk";
