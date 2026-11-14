import { depthModelFor, runAnalysisJob, type AnalysisFrame, type AnalysisOutcome, type FrameProvider } from "@solomotion/core/analysis";
import { depthEngineFor } from "./depth-models";
import { openDecodedFrames, type DecodedFrames } from "./decoded-frames";
import type { FrameSourceSpec, FromAnalysis, ToAnalysis } from "./analysis-protocol";

/**
 * THE ANALYSIS WORKER — where every solve runs: region tracks today, the
 * camera solve and depth after them. Pure compute and decoding, no DOM.
 *
 * Frames are decoded HERE (WebCodecs through mediabunny, the same module the
 * main thread used) and kept in a byte-budgeted cache per source, so a
 * correction's re-solve finds its neighbourhood already decoded and the main
 * thread never reads a pixel back. A source the decoder refuses is asked of
 * the editor frame by frame (`need-frame`).
 *
 * The editor ends this worker when it has been idle a while — that is how the
 * decode cache is released, all at once and for certain.
 */

/** The slice of the worker global this needs (the app compiles against the DOM lib, not the worker one). */
interface WorkerScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((ev: MessageEvent<ToAnalysis>) => void) | null;
}
const scope = self as unknown as WorkerScope;
const post = (m: FromAnalysis, transfer: Transferable[] = []) => scope.postMessage(m, transfer);

interface Run {
  ctrl: AbortController;
  paused: boolean;
  wake: Array<() => void>;
}

const runs = new Map<number, Run>();
/** Decoded sources by key; a couple at most (two plates being tracked). */
const decoders = new Map<string, Promise<DecodedFrames | null>>();
const MAX_SOURCES = 2;

let nextReq = 1;
const frameWaits = new Map<number, { resolve: (f: AnalysisFrame) => void; reject: (e: Error) => void }>();

function decoderFor(spec: NonNullable<FrameSourceSpec["decode"]>, times: number[], color: boolean): Promise<DecodedFrames | null> {
  const hit = decoders.get(spec.key);
  if (hit) {
    // Most recently used goes to the back of the eviction line.
    decoders.delete(spec.key);
    decoders.set(spec.key, hit);
    return hit;
  }
  const opening = openDecodedFrames(spec.blob, { width: spec.width, height: spec.height, color, times, stepMs: spec.stepMs });
  decoders.set(spec.key, opening);
  while (decoders.size > MAX_SOURCES) {
    const [key, old] = decoders.entries().next().value!;
    decoders.delete(key);
    void old.then((d) => d?.dispose());
  }
  return opening;
}

function remoteFrame(runId: number, ms: number): Promise<AnalysisFrame> {
  const reqId = nextReq++;
  return new Promise((resolve, reject) => {
    frameWaits.set(reqId, { resolve, reject });
    post({ t: "need-frame", runId, reqId, ms });
  });
}

async function providerFor(runId: number, source: FrameSourceSpec): Promise<FrameProvider> {
  const decoded = source.decode ? await decoderFor(source.decode, source.times, source.color) : null;
  if (!decoded && source.decode) decoders.delete(source.decode.key);
  return {
    sourceWidth: source.sourceWidth,
    sourceHeight: source.sourceHeight,
    scale: source.scale,
    times: source.times,
    still: source.still,
    getFrame: (ms) => (decoded ? decoded.getFrame(ms) : remoteFrame(runId, ms)),
  };
}

async function run(m: Extract<ToAnalysis, { t: "run" }>) {
  const state: Run = { ctrl: new AbortController(), paused: false, wake: [] };
  runs.set(m.runId, state);
  try {
    const provider = await providerFor(m.runId, m.source);
    const gate = () => (state.paused && !state.ctrl.signal.aborted ? new Promise<void>((r) => state.wake.push(r)) : Promise.resolve());
    const outcome = await runAnalysisJob(
      provider,
      m.job,
      { signal: state.ctrl.signal, gate },
      (progress) => post({ t: "progress", runId: m.runId, progress }),
      { depth: (tracker, still, temporal, note) => depthEngineFor(depthModelFor(tracker, still), temporal, note) },
    );
    post({ t: "done", runId: m.runId, outcome }, outcomeTransfer(outcome));
  } catch (err) {
    const e = err as Error;
    post({ t: "error", runId: m.runId, name: e?.name ?? "Error", message: e?.message ?? String(err) });
  } finally {
    runs.delete(m.runId);
  }
}

/** Depth maps are megabytes each: they move to the editor, never copy. */
function outcomeTransfer(o: AnalysisOutcome): Transferable[] {
  return o.kind === "depth" ? o.result.maps.map((m) => m.buffer as ArrayBuffer) : [];
}

function wake(r: Run) {
  for (const go of r.wake.splice(0)) go();
}

scope.onmessage = (ev: MessageEvent<ToAnalysis>) => {
  const m = ev.data;
  switch (m.t) {
    case "run":
      void run(m);
      break;
    case "pause": {
      const r = runs.get(m.runId);
      if (r) r.paused = true;
      break;
    }
    case "resume": {
      const r = runs.get(m.runId);
      if (r) {
        r.paused = false;
        wake(r);
      }
      break;
    }
    case "stop": {
      const r = runs.get(m.runId);
      if (r) {
        r.ctrl.abort();
        wake(r);
      }
      break;
    }
    case "frame": {
      const w = frameWaits.get(m.reqId);
      if (!w) break;
      frameWaits.delete(m.reqId);
      if (m.frame) w.resolve(m.frame);
      else w.reject(new Error(m.error ?? "Frame unavailable"));
      break;
    }
    case "release":
      for (const d of decoders.values()) void d.then((x) => x?.dispose());
      decoders.clear();
      break;
  }
};

post({ t: "ready" });
