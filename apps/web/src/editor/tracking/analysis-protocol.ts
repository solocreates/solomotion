import type { AnalysisFrame, AnalysisJob, AnalysisOutcome, AnalysisProgress } from "@solomotion/core/analysis";

/**
 * The wire between the editor and the analysis worker — plain, cloneable
 * messages. Frames that cross it are TRANSFERRED (their buffers move, never
 * copy).
 */

/**
 * Where a job's frames come from. `decode` is the normal case: the worker
 * opens the file with WebCodecs itself, so decoding, readback and the frame
 * cache all live off the main thread. Without it — a still, an animated
 * image, or a codec the worker's decoder refuses — the worker asks the
 * editor for each frame (`need-frame`), which draws it with a `<video>` or
 * an image as before.
 */
export interface FrameSourceSpec {
  sourceWidth: number;
  sourceHeight: number;
  /** Analysis px per source px. */
  scale: number;
  times: number[];
  still: boolean;
  /** Frames carry RGBA as well as luma. */
  color: boolean;
  decode: {
    /** The cache identity: same key, same decoded planes (asset + analysis size + colour). */
    key: string;
    blob: Blob;
    width: number;
    height: number;
    stepMs: number;
  } | null;
}

export type ToAnalysis =
  | { t: "run"; runId: number; job: AnalysisJob; source: FrameSourceSpec }
  | { t: "pause"; runId: number }
  | { t: "resume"; runId: number }
  | { t: "stop"; runId: number }
  | { t: "frame"; reqId: number; frame: AnalysisFrame | null; error?: string }
  /** Drop every cached decode (memory pressure, or the asset changed). */
  | { t: "release" };

export type FromAnalysis =
  | { t: "ready" }
  | { t: "progress"; runId: number; progress: AnalysisProgress }
  | { t: "need-frame"; runId: number; reqId: number; ms: number }
  | { t: "done"; runId: number; outcome: AnalysisOutcome }
  | { t: "error"; runId: number; name: string; message: string };

/** The buffers a frame owns — what `postMessage` should transfer. */
export function frameTransfer(frame: AnalysisFrame | null): Transferable[] {
  if (!frame) return [];
  const out: Transferable[] = [frame.luma.buffer as ArrayBuffer];
  if (frame.rgba && frame.rgba.buffer !== frame.luma.buffer) out.push(frame.rgba.buffer as ArrayBuffer);
  return out;
}
