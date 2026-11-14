import { lazyModule, type DepthEngine, type StillDepthPort, type VideoDepthPort } from "@solomotion/core/analysis";
import { DEPTH_FILES, RUNTIME_FILES, engineBytes } from "../engines/files";

/**
 * THE DEPTH NETWORKS — onnxruntime-web, inside the analysis worker.
 *
 *   video  Video Depth Anything Small (Apache-2.0): a per-frame DINOv2-S
 *          encoder (518 × 910 in, four token maps out) and a temporal DPT head
 *          over 32 frames of those tokens. fp16 weights, fp32 I/O.
 *   still  Depth Anything V3 Small (Apache-2.0): one picture in, depth (and a
 *          confidence) out, any size in multiples of 14.
 *
 * NOTHING HERE IS IN THE APP BUNDLE. The weights (~220 MB across the paths)
 * AND the runtime itself (onnxruntime-web's module + its 27 MB wasm) are lazy
 * ENGINES (`engines/files.ts`): fetched on first use, kept in the engines'
 * own cache across app updates, offline after that — the runtime imported
 * from blob URLs of the cached bytes. Bundled, the wasm broke Cloudflare's
 * 25 MiB asset limit and was precached offline for every user, depth or not;
 * shipped in the desktop installer it would be ~220 MB in every download and
 * every update, for a feature many never open.
 *
 * WebGPU first (Metal, D3D12, Vulkan through the browser), WASM otherwise;
 * the backend that answered is reported with the run.
 */

/**
 * Depth Anything 3 comes twice (`engines.json`), measured on an M1: fp32 runs
 * on WebGPU at ~250 ms a frame (the fp16 export trips an onnxruntime WebGPU
 * shader, ResizeBiCubic), while the 8-bit export is the CPU's (~1.6 s; its
 * integer ops have no WebGPU kernels, so on the GPU it is no faster).
 */

type Ort = typeof import("onnxruntime-web/webgpu");

/**
 * The runtime is a lazy module like every heavy part of the app (retries, a
 * named failure), imported by URL so the bundler never sees it — only its
 * types come from the package.
 */
const ORT = lazyModule(
  "onnxruntime-web",
  async () => {
    const quiet = () => {};
    const [main, glue, wasm] = await Promise.all(RUNTIME_FILES.map((u) => engineBytes(u, quiet)));
    const script = (bytes: ArrayBuffer) => URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
    const m = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ script(main!))) as Ort;
    // Blob-imported, it cannot find its siblings by URL: hand it the glue and the binary.
    m.env.wasm.wasmPaths = { mjs: script(glue!) };
    m.env.wasm.wasmBinary = wasm!;
    // A few threads for the WASM fallback; the WebGPU EP needs none.
    m.env.wasm.numThreads = Math.min(4, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2);
    // Node-placement chatter ("some nodes were not assigned…") is not an error.
    m.env.logLevel = "error";
    return m;
  },
  { label: "depth runtime" },
);
const ort = (): Promise<Ort> => ORT.load();

type Session = Awaited<ReturnType<Ort["InferenceSession"]["create"]>>;

const hasGpu = () => typeof navigator !== "undefined" && "gpu" in navigator;

async function session(url: string, note: (s: string) => void, label: string, opts: { gpu: boolean; external?: { url: string; path: string } } = { gpu: hasGpu() }): Promise<{ s: Session; backend: string }> {
  const m = await ort();
  const bytes = await engineBytes(url, (f) => note(`Downloading ${label} — ${Math.round(f * 100)}%`));
  const external = opts.external ? [{ path: opts.external.path, data: new Uint8Array(await engineBytes(opts.external.url, (f) => note(`Downloading ${label} — ${Math.round(f * 100)}%`))) }] : undefined;
  note(`Starting ${label}`);
  if (opts.gpu) {
    try {
      return { s: await m.InferenceSession.create(bytes, { executionProviders: ["webgpu"], graphOptimizationLevel: "all", logSeverityLevel: 3, ...(external && { externalData: external }) }), backend: "webgpu" };
    } catch {
      // A device that refuses the model (an old GPU, a lost adapter): the same model on the CPU.
    }
  }
  return { s: await m.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all", logSeverityLevel: 3, ...(external && { externalData: external }) }), backend: "wasm" };
}

// ── The engines, kept while the worker lives (a correction's re-run reuses them) ──

let video: Promise<VideoDepthPort & { backend: string }> | null = null;
let still: Promise<StillDepthPort & { backend: string }> | null = null;

const W = 910;
const H = 518;
const T = 32;
const TOKENS = 2405 * 384;

function videoEngine(note: (s: string) => void): Promise<VideoDepthPort & { backend: string }> {
  video ??= (async () => {
    const m = await ort();
    const [encUrl, headUrl] = DEPTH_FILES.video;
    const enc = await session(encUrl, note, "depth model (1 of 2)");
    const head = await session(headUrl, note, "depth model (2 of 2)");
    // The head's input, one window deep: four stacked token maps (~470 MB while a depth run is live).
    const feats = [0, 1, 2, 3].map(() => new Float32Array(T * TOKENS));
    const port: VideoDepthPort & { backend: string } = {
      backend: enc.backend,
      width: W,
      height: H,
      window: T,
      // Video Depth Anything predicts relative inverse depth: bigger is nearer.
      sense: "disparity" as const,
      async encode(rgb: Float32Array, slot: number) {
        const out = await enc.s.run({ pixels: new m.Tensor("float32", rgb, [1, 3, H, W]) });
        ["feat1", "feat2", "feat3", "feat4"].forEach((name, k) => feats[k]!.set(out[name]!.data as Float32Array, slot * TOKENS));
      },
      async head() {
        const out = await head.s.run({
          feat1: new m.Tensor("float32", feats[0]!, [T, 2405, 384]),
          feat2: new m.Tensor("float32", feats[1]!, [T, 2405, 384]),
          feat3: new m.Tensor("float32", feats[2]!, [T, 2405, 384]),
          feat4: new m.Tensor("float32", feats[3]!, [T, 2405, 384]),
        });
        const d = out.depth!.data as Float32Array;
        return Array.from({ length: T }, (_, i) => d.slice(i * W * H, (i + 1) * W * H));
      },
      carry(from: number, count: number) {
        for (const f of feats) f.copyWithin(0, from * TOKENS, (from + count) * TOKENS);
      },
    };
    return port;
  })().catch((e) => {
    video = null;
    throw e;
  });
  return video;
}

function stillEngine(note: (s: string) => void): Promise<StillDepthPort & { backend: string }> {
  still ??= (async () => {
    const m = await ort();
    const f = DEPTH_FILES;
    const s = hasGpu()
      ? await session(f.stillGpu.graph, note, "depth model", { gpu: true, external: { url: f.stillGpu.data, path: f.stillGpu.dataPath } })
      : await session(f.stillCpu, note, "depth model", { gpu: false });
    const port: StillDepthPort & { backend: string } = {
      backend: s.backend,
      // Depth Anything 3 predicts depth: bigger is farther.
      sense: "depth" as const,
      sizeFor(width: number, height: number) {
        const k = 504 / Math.max(width, height);
        const r14 = (v: number) => Math.max(14, Math.round((v * k) / 14) * 14);
        return { width: r14(width), height: r14(height) };
      },
      async estimate(rgb: Float32Array, width: number, height: number) {
        const out = await s.s.run({ pixel_values: new m.Tensor("float32", rgb, [1, 1, 3, height, width]) });
        return Float32Array.from(out.predicted_depth!.data as Float32Array);
      },
    };
    return port;
  })().catch((e) => {
    still = null;
    throw e;
  });
  return still;
}

/**
 * The analysis port: the engine a depth job needs, made (or reused) on demand.
 * Footage gets the temporal head when the host says this device may try it,
 * else the still model per frame (steadied in core).
 */
export async function depthEngineFor(model: "video" | "still", temporal: boolean, note: (s: string) => void): Promise<DepthEngine> {
  const port = model === "video" && temporal ? await videoEngine(note) : await stillEngine(note);
  note(`Depth model on ${port.backend === "webgpu" ? "the GPU" : "the CPU"}`);
  return "window" in port ? { video: port } : { still: port };
}

/** Drop the sessions and their buffers (the worker is about to idle out anyway). */
export function releaseDepthEngines(): void {
  video = null;
  still = null;
}
