import { lazyModule, lumaFromRgba, yieldNow, type AnalysisFrame } from "@solomotion/core/analysis";

/**
 * FRAME-EXACT DECODING FOR ANALYSIS — WebCodecs through mediabunny, lazily.
 *
 * The `<video>` path pays a SEEK per frame: set `currentTime`, wait for
 * `seeked`, draw. On a 1080p plate that measured ~170 ms a frame, so 180
 * frames took half a minute, almost all of it waiting — and the frame a seek
 * lands on is the browser's guess, not the file's frame.
 *
 * Here frames are decoded in BATCHES along the run's direction: a request for
 * t decodes the next stretch of the grid (t, t+1, … forward; …, t−1, t
 * backward) in one sorted pass, each packet decoded at most once
 * (`canvasesAtTimestamps`), and parks the analysis planes in a byte-budgeted
 * cache. A backward walk costs one keyframe seek per batch instead of one per
 * frame, and a re-solve after a correction finds its neighbourhood already
 * decoded.
 *
 * The decoder library is a lazy module (`Loading video decoder` in the activity
 * ring the first time). Anything it cannot open — no WebCodecs, a codec the
 * device lacks — returns null, and the caller falls back to `<video>`.
 *
 * It runs on either thread: inside the analysis worker (the normal home — the
 * readback and the cache live off the main thread) or on the main thread when
 * no worker could start. Nothing here touches `document`.
 */

const MEDIABUNNY = lazyModule("mediabunny", () => import("mediabunny"), { label: "video decoder" });

/** Frames decoded per request, in the walking direction. */
const BATCH = 24;
/** Analysis planes kept per source — luma is 1 byte/px, so ~110 frames at 1280×720. */
const BUDGET_BYTES = 96 * 1024 * 1024;

export interface DecodedFrames {
  width: number;
  height: number;
  getFrame(sourceMs: number): Promise<AnalysisFrame>;
  dispose(): void;
}

/** A 2D canvas to read pixels back through — offscreen where it exists (always in a worker). */
function readbackCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export async function openDecodedFrames(
  blob: Blob,
  opts: { width: number; height: number; color: boolean; times: readonly number[]; stepMs: number },
): Promise<DecodedFrames | null> {
  if (typeof VideoDecoder === "undefined") return null;
  let mb: typeof import("mediabunny");
  try {
    mb = await MEDIABUNNY.load();
  } catch {
    return null;
  }
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) {
      input.dispose?.();
      return null;
    }
    const { width: w, height: h, color, times, stepMs } = opts;
    const sink = new mb.CanvasSink(track, { width: w, height: h, fit: "fill", poolSize: 2 });
    // One read-friendly canvas: the sink's own canvases may live on the GPU,
    // where `getImageData` is a stall per frame.
    const scratch = readbackCanvas(w, h);
    const ctx = scratch.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!ctx) {
      input.dispose?.();
      return null;
    }

    const cache = new Map<number, AnalysisFrame>();
    const bytesPer = w * h * (color ? 5 : 1);
    const capacity = Math.max(BATCH * 2, Math.floor(BUDGET_BYTES / bytesPer));
    let last: number | null = null;
    let chain: Promise<unknown> = Promise.resolve();

    const indexOf = (ms: number) => {
      let lo = 0;
      let hi = times.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid]! < ms - 0.5) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };

    const decode = async (batch: number[]) => {
      // "The last frame starting at or before t" — ask half a frame late, so a
      // grid time that rounds a hair early still lands on its own frame.
      const stamps = batch.map((ms) => (ms + stepMs * 0.5) / 1000);
      let i = 0;
      let slice = performance.now();
      for await (const wrapped of sink.canvasesAtTimestamps(stamps)) {
        // A batch is two dozen frames of readback; the editor paints between them.
        if (performance.now() - slice > 12) {
          await yieldNow();
          slice = performance.now();
        }
        const ms = batch[i++]!;
        ctx.clearRect(0, 0, w, h);
        if (wrapped) ctx.drawImage(wrapped.canvas, 0, 0, w, h);
        const rgba = ctx.getImageData(0, 0, w, h).data;
        cache.set(ms, { width: w, height: h, luma: lumaFromRgba(rgba, w, h), ...(color ? { rgba } : {}) });
        while (cache.size > capacity) cache.delete(cache.keys().next().value!);
      }
    };

    const fetchAround = async (ms: number) => {
      const dir = last === null || ms >= last ? 1 : -1;
      const at = indexOf(ms);
      const batch: number[] = [];
      for (let k = 0; batch.length < BATCH; k++) {
        const t = times[at + dir * k];
        if (t === undefined) break;
        if (!cache.has(t)) batch.push(t);
      }
      if (!batch.includes(ms) && !cache.has(ms)) batch.push(ms);
      await decode(batch.sort((a, b) => a - b));
    };

    return {
      width: w,
      height: h,
      getFrame(ms) {
        const run = chain.then(async () => {
          let f = cache.get(ms);
          if (!f) {
            await fetchAround(ms);
            f = cache.get(ms);
          } else {
            // Touch: most-recently used goes to the back of the eviction line.
            cache.delete(ms);
            cache.set(ms, f);
          }
          last = ms;
          if (!f) throw new Error("Frame could not be decoded");
          return f;
        });
        chain = run.catch(() => {});
        return run;
      },
      dispose() {
        cache.clear();
        scratch.width = scratch.height = 0;
        input.dispose?.();
      },
    };
  } catch {
    input.dispose?.();
    return null;
  }
}
