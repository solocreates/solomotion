"use client";

import {
  jobWantsColor,
  lazyModule,
  runAnalysisJob,
  type AnalysisJob,
  type AnalysisOutcome,
  type AnalysisProgress,
  type MotionDocument,
  type FrameProvider,
  type Tracker,
  type VisualClip,
} from "@solomotion/core";
import { buildFrameProvider, frameSourceSpec } from "./frame-source";
import { frameTransfer, type FrameSourceSpec, type FromAnalysis, type ToAnalysis } from "./analysis-protocol";
import { NAMES } from "@/editor/names";

/**
 * THE EDITOR'S SIDE OF ANALYSIS — run a job, wherever it can run.
 *
 * Normally that is the analysis worker: one lazy module worker for every
 * solve, spawned on the first track (the activity ring shows "Loading
 * analysis engine" while its chunk arrives), ended after a quiet minute —
 * which is also how its decode cache is freed. The editor keeps only a
 * cheap job record per run and answers `need-frame` for sources the worker
 * cannot decode itself.
 *
 * Where no worker can start, the same `runAnalysisJob` runs here, on a
 * main-thread provider — the answer is identical, only slower to live with.
 */

export interface AnalyzeControl {
  signal: AbortSignal;
  /** Main-thread runs: awaited before every step. */
  gate?: () => Promise<void>;
  /** Worker runs: tell the worker when the run is paused or resumed. Returns an unsubscribe. */
  watchPause?: (onChange: (paused: boolean) => void) => () => void;
}

const IDLE_MS = 60_000;
const HANDSHAKE_MS = 15_000;

interface Pending {
  resolve: (o: AnalysisOutcome) => void;
  reject: (e: Error) => void;
  onProgress?: (p: AnalysisProgress) => void;
  frames: () => Promise<FrameProvider>;
}

class AnalysisEngine {
  private worker: Worker | null = null;
  private starting: Promise<Worker> | null = null;
  private runs = new Map<number, Pending>();
  private nextRun = 1;
  private idle: ReturnType<typeof setTimeout> | null = null;

  /** Spawn (or reuse) the worker; resolves once it says it is ready. */
  start(): Promise<Worker> {
    if (this.worker) return Promise.resolve(this.worker);
    this.starting ??= new Promise<Worker>((resolve, reject) => {
      let w: Worker;
      try {
        w = new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module", name: NAMES.wire.worker("analysis") });
      } catch (e) {
        reject(e as Error);
        return;
      }
      const to = setTimeout(() => {
        w.terminate();
        reject(new Error("The analysis engine did not start"));
      }, HANDSHAKE_MS);
      w.onerror = (e) => {
        clearTimeout(to);
        w.terminate();
        reject(new Error(e.message || "The analysis engine failed to load"));
      };
      w.onmessage = (ev: MessageEvent<FromAnalysis>) => {
        if (ev.data.t !== "ready") return;
        clearTimeout(to);
        w.onmessage = (e: MessageEvent<FromAnalysis>) => this.receive(e.data);
        w.onerror = (e) => this.crash(new Error(e.message || "The analysis engine stopped"));
        this.worker = w;
        resolve(w);
      };
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async run(job: AnalysisJob, spec: FrameSourceSpec, frames: () => Promise<FrameProvider>, control: AnalyzeControl, onProgress?: (p: AnalysisProgress) => void): Promise<AnalysisOutcome> {
    const w = await this.start();
    this.touch();
    const runId = this.nextRun++;
    const unwatch = control.watchPause?.((paused) => this.post({ t: paused ? "pause" : "resume", runId }));
    const stop = () => this.post({ t: "stop", runId });
    control.signal.addEventListener("abort", stop);
    try {
      return await new Promise<AnalysisOutcome>((resolve, reject) => {
        this.runs.set(runId, { resolve, reject, onProgress, frames });
        w.postMessage({ t: "run", runId, job, source: spec } satisfies ToAnalysis);
        if (control.signal.aborted) stop();
      });
    } finally {
      unwatch?.();
      control.signal.removeEventListener("abort", stop);
      this.runs.delete(runId);
      this.touch();
    }
  }

  private post(m: ToAnalysis, transfer: Transferable[] = []) {
    this.worker?.postMessage(m, transfer);
  }

  private receive(m: FromAnalysis) {
    if (m.t === "ready") return;
    const run = this.runs.get(m.runId);
    if (!run) return;
    switch (m.t) {
      case "progress":
        run.onProgress?.(m.progress);
        break;
      case "done":
        run.resolve(m.outcome);
        break;
      case "error": {
        const err = new Error(m.message);
        err.name = m.name;
        run.reject(err);
        break;
      }
      case "need-frame":
        void run
          .frames()
          .then((p) => p.getFrame(m.ms))
          .then(
            (frame) => this.post({ t: "frame", reqId: m.reqId, frame }, frameTransfer(frame)),
            (e: Error) => this.post({ t: "frame", reqId: m.reqId, frame: null, error: e.message }),
          );
        break;
    }
  }

  /** End the worker now (its GPU device is lost, say): the next run starts a fresh one. */
  restart() {
    this.crash(Object.assign(new Error("The analysis engine restarted"), { name: "AbortError" }));
  }

  private crash(err: Error) {
    for (const r of this.runs.values()) r.reject(err);
    this.runs.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  /** Re-arm the idle timer; an idle engine is ended, freeing its decode cache. */
  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.runs.size > 0) return this.touch();
      this.worker?.terminate();
      this.worker = null;
    }, IDLE_MS);
  }
}

/** The engine, arriving lazily and SAYING so — its first start is what the activity ring names. */
const ENGINE = lazyModule(
  "analysis-engine",
  async () => {
    if (typeof Worker === "undefined") throw Object.assign(new Error("Workers unavailable"), { name: "NotSupportedError" });
    const engine = new AnalysisEngine();
    await engine.start();
    return engine;
  },
  { label: "analysis engine", retries: 0 },
);

/** Set once a worker failed to start in this session, so later runs go straight to the main thread. */
let workerRefused = false;

/** `localStorage["<ns>.analysis"] = "main"` runs solves on the main thread — to compare, or to debug one. */
function forcedMainThread(): boolean {
  try {
    return localStorage.getItem(NAMES.storage.analysisOnMain) === "main";
  } catch {
    return false;
  }
}

/**
 * Run `job` over `tracker`'s footage as `clip` shows it. Worker first; the
 * main thread when no worker can start. Throws `AbortError` only through the
 * job's own stop semantics — a stopped run RESOLVES with what it solved.
 */
export async function analyze(
  doc: MotionDocument,
  tracker: Tracker,
  clip: VisualClip,
  job: AnalysisJob,
  control: AnalyzeControl,
  onProgress?: (p: AnalysisProgress) => void,
): Promise<AnalysisOutcome> {
  const color = jobWantsColor(job);
  let engine: AnalysisEngine | null = null;
  if (!workerRefused && !forcedMainThread()) {
    try {
      engine = await ENGINE.load();
    } catch {
      workerRefused = true;
    }
  }
  if (engine && job.kind === "depth" && job.temporal) {
    // The video head needs more GPU memory than many machines have (an 8 GB M1 cannot hold it):
    // tried once per machine; refused, the worker restarts on a fresh device and the shot runs per frame, steadied.
    if (temporalRefused()) return analyze(doc, tracker, clip, { ...job, temporal: false }, control, onProgress);
    try {
      return await runOn(engine, doc, tracker, clip, job, color, control, onProgress);
    } catch (e) {
      if (!isGpuExhausted(e)) throw e;
      refuseTemporal();
      engine.restart();
      onProgress?.({ done: 0, total: 1, note: "This GPU can't hold the video model — per frame instead" });
      return analyze(doc, tracker, clip, { ...job, temporal: false }, control, onProgress);
    }
  }
  if (engine) return runOn(engine, doc, tracker, clip, job, color, control, onProgress);
  const { provider, dispose } = await buildFrameProvider(doc, tracker, clip, color);
  try {
    return await runAnalysisJob(provider, job, { signal: control.signal, gate: control.gate }, onProgress);
  } finally {
    dispose();
  }
}

const TEMPORAL_KEY = NAMES.storage.depthTemporal;
function temporalRefused(): boolean {
  try {
    return localStorage.getItem(TEMPORAL_KEY) === "refused";
  } catch {
    return false;
  }
}
function refuseTemporal(): void {
  try {
    localStorage.setItem(TEMPORAL_KEY, "refused");
  } catch {
    // Private mode: refused for this session only, through the retry.
  }
}
/** The GPU (or WASM) ran out of room — a device limit, not a bug in the run. */
function isGpuExhausted(e: unknown): boolean {
  return /Device was lost|Insufficient Memory|OutOfMemory|bad_alloc|out of memory|restarted/i.test(String((e as Error)?.message ?? e));
}

async function runOn(
  engine: AnalysisEngine,
  doc: MotionDocument,
  tracker: Tracker,
  clip: VisualClip,
  job: AnalysisJob,
  color: boolean,
  control: AnalyzeControl,
  onProgress?: (p: AnalysisProgress) => void,
): Promise<AnalysisOutcome> {
  {
    const { spec, fallback } = await frameSourceSpec(doc, tracker, clip, color);
    let opening: Promise<{ provider: FrameProvider; dispose: () => void }> | null = null;
    const open = () => (opening ??= fallback());
    // A source only the editor can draw is already open; make sure it is released.
    if (!spec.decode) void open();
    try {
      return await engine.run(job, spec, () => open().then((b) => b.provider), control, onProgress);
    } finally {
      if (opening) void (opening as Promise<{ dispose: () => void }>).then((b) => b.dispose(), () => {});
    }
  }
}
