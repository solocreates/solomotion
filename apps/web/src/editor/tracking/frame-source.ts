import { analysisScale, clipSourcePhaseAt, compFps, lumaFromRgba, type AnalysisFrame, type MotionDocument, type FrameProvider, type Tracker, type VisualClip } from "@solomotion/core";
import { assetObjectURL, getAssetBlob } from "../assets/asset-store";
import { openDecodedFrames } from "./decoded-frames";
import type { FrameSourceSpec } from "./analysis-protocol";
import { getImageForAsset, isAnimatedImageMime, animatedImageFrameAtRaw } from "../stage/render/media-cache";

/**
 * FRAMES FOR A SOLVE — the app half of core's `FrameProvider`.
 *
 * A tracker belongs to its footage, so frames are asked for by SOURCE time
 * (ms into the media), never by a clip's local time: the decode is a plain seek
 * into the file. Frames are drawn at ANALYSIS size (`solve.analysisEdge`) and
 * handed over as a luma plane — a quarter of RGBA — with RGBA kept only when
 * the solve keys colour. Nothing is retained here between frames: what a run
 * keeps is its own business.
 *
 * Video decodes frame-exactly through WebCodecs (`decoded-frames.ts`, batched
 * in the run's direction); a codec it cannot open falls back to a dedicated,
 * muted `<video>` that never fights the stage's playback element.
 */

interface Grabber {
  width: number;
  height: number;
  still: boolean;
  /** Draw the source at `sourceMs` into `ctx` at `w × h`. */
  draw(sourceMs: number, ctx: CanvasRenderingContext2D, w: number, h: number): Promise<void>;
  dispose(): void;
}

async function videoGrabber(asset: MotionDocument["assets"][number]): Promise<Grabber> {
  const url = await assetObjectURL(asset.id, asset.mime);
  if (!url) throw new Error("Video bytes unavailable");
  const el = document.createElement("video");
  el.muted = true;
  el.playsInline = true;
  el.preload = "auto";
  el.crossOrigin = "anonymous";
  el.src = url;
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("Video load timed out")), 15000);
    el.onloadeddata = () => {
      clearTimeout(to);
      resolve();
    };
    el.onerror = () => {
      clearTimeout(to);
      reject(new Error("Video decode failed"));
    };
  });
  const seek = (sec: number): Promise<void> =>
    new Promise((resolve) => {
      const clamped = Math.max(0, Math.min(sec, el.duration || sec));
      if (Math.abs(el.currentTime - clamped) < 1e-3) return resolve();
      // A seek that never lands (decode stall, out of range) must not hang the
      // run — resolve after a grace period and measure whatever is showing.
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        el.removeEventListener("seeked", finish);
        clearTimeout(to);
        resolve();
      };
      const to = setTimeout(finish, 1500);
      el.addEventListener("seeked", finish);
      el.currentTime = clamped;
    });
  return {
    width: el.videoWidth || asset.width || 640,
    height: el.videoHeight || asset.height || 360,
    still: false,
    async draw(sourceMs, ctx, w, h) {
      await seek(sourceMs / 1000);
      ctx.drawImage(el, 0, 0, w, h);
    },
    dispose() {
      el.removeAttribute("src");
      el.load();
    },
  };
}

async function imageGrabber(asset: MotionDocument["assets"][number]): Promise<Grabber> {
  const width = asset.width || 320;
  const height = asset.height || 180;
  if (isAnimatedImageMime(asset.mime, asset.name)) {
    return {
      width,
      height,
      still: false,
      async draw(sourceMs, ctx, w, h) {
        const bmp = animatedImageFrameAtRaw(asset.id, sourceMs);
        if (bmp) ctx.drawImage(bmp, 0, 0, w, h);
      },
      dispose() {},
    };
  }
  let img = getImageForAsset(asset.id, asset.mime);
  if (!img) {
    const url = await assetObjectURL(asset.id, asset.mime);
    img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Image decode failed"));
      el.src = url ?? "";
    });
  }
  const pic = img;
  return { width, height, still: true, async draw(_ms, ctx, w, h) { ctx.drawImage(pic, 0, 0, w, h); }, dispose() {} };
}

/**
 * The source span a clip shows — what "track the clip" means — from its first
 * to its last frame through its own time map (trim, speed, reverse).
 */
export function clipSourceSpan(doc: MotionDocument, clip: VisualClip): [number, number] {
  const a = clipSourcePhaseAt(doc, clip, 0).sourceMs;
  const b = clipSourcePhaseAt(doc, clip, Math.max(0, clip.durationMs - 1)).sourceMs;
  return [Math.min(a, b), Math.max(a, b)];
}

/** Hard ceiling on one run's frame grid — an hour at 30 fps. Runs never hold frames, so this guards time, not memory. */
const MAX_FRAMES = 108_000;

/** The frame grid a run walks: the source's own frames across the span `clip` shows. */
function frameGrid(doc: MotionDocument, tracker: Tracker, clip: VisualClip, still: boolean): { times: number[]; stepMs: number } {
  const asset = doc.assets.find((a) => a.id === tracker.source.assetId);
  const [from, to] = clipSourceSpan(doc, clip);
  const fps = asset?.fps ?? compFps(doc, clip.frameId);
  const stepMs = 1000 / Math.max(1, fps);
  if (still) return { times: [Math.max(0, trackerReferenceMs(tracker))], stepMs };
  const count = Math.min(MAX_FRAMES, Math.max(1, Math.floor((to - from) / stepMs) + 1));
  // Frames are addressed on the source's own grid, so a re-run lands on the same instants.
  const first = Math.ceil(from / stepMs - 1e-6);
  return { times: Array.from({ length: count }, (_, i) => Math.round((first + i) * stepMs * 1000) / 1000), stepMs };
}

/** Where a tracker's solve starts on a still — its drawn frame, or the start for kinds that draw nothing. */
function trackerReferenceMs(tracker: Tracker): number {
  return "referenceMs" in tracker ? tracker.referenceMs : 0;
}

/**
 * WHAT THE WORKER NEEDS to decode a tracker's footage itself — the file, the
 * analysis size and the grid — or `decode: null` when only the editor can
 * draw it (a still, an animated image, a video whose size is unknown).
 * `fallback` builds the editor-side provider the worker asks frames of then.
 */
export async function frameSourceSpec(
  doc: MotionDocument,
  tracker: Tracker,
  clip: VisualClip,
  color: boolean,
): Promise<{ spec: FrameSourceSpec; fallback: () => Promise<{ provider: FrameProvider; dispose: () => void }> }> {
  const asset = doc.assets.find((a) => a.id === tracker.source.assetId);
  if (!asset) throw new Error("The footage is missing from this project.");
  const fallback = () => buildEditorProvider(doc, tracker, clip, color);
  if (asset.kind === "video" && asset.width && asset.height) {
    const blob = await getAssetBlob(asset.id);
    const scale = analysisScale(asset.width, asset.height, analysisEdgeOf(tracker));
    const width = Math.max(1, Math.round(asset.width * scale));
    const height = Math.max(1, Math.round(asset.height * scale));
    const { times, stepMs } = frameGrid(doc, tracker, clip, false);
    if (blob)
      return {
        spec: {
          sourceWidth: asset.width,
          sourceHeight: asset.height,
          scale,
          times,
          still: false,
          color,
          decode: { key: `${asset.id}|${width}x${height}|${color ? "rgba" : "luma"}`, blob, width, height, stepMs },
        },
        fallback,
      };
  }
  // The editor draws these; it reports the geometry once it has opened the source.
  const built = await fallback();
  const { provider } = built;
  return {
    spec: { sourceWidth: provider.sourceWidth, sourceHeight: provider.sourceHeight, scale: provider.scale, times: provider.times, still: provider.still, color, decode: null },
    fallback: async () => built,
  };
}

/** The long edge a tracker's frames are analysed at. Depth asks for what its models take in (910 / 504, resampled there). */
export function analysisEdgeOf(tracker: Tracker): number {
  return tracker.kind === "depth" ? 960 : tracker.solve.analysisEdge;
}

/**
 * A provider over `tracker`'s footage, on the source's frame grid across the
 * span `clip` shows, on THIS thread — what runs when no analysis worker could
 * start. `dispose` releases the decode element; call it on every exit path.
 */
export async function buildFrameProvider(
  doc: MotionDocument,
  tracker: Tracker,
  clip: VisualClip,
  color: boolean,
): Promise<{ provider: FrameProvider; dispose: () => void }> {
  const asset = doc.assets.find((a) => a.id === tracker.source.assetId);
  if (!asset) throw new Error("The footage is missing from this project.");
  // Frame-exact WebCodecs first, for video whose size the project knows.
  if (asset.kind === "video" && asset.width && asset.height) {
    const blob = await getAssetBlob(asset.id);
    const scale = analysisScale(asset.width, asset.height, analysisEdgeOf(tracker));
    const w = Math.max(1, Math.round(asset.width * scale));
    const h = Math.max(1, Math.round(asset.height * scale));
    const { times, stepMs } = frameGrid(doc, tracker, clip, false);
    const decoded = blob ? await openDecodedFrames(blob, { width: w, height: h, color, times, stepMs }) : null;
    if (decoded) {
      return {
        provider: { sourceWidth: asset.width, sourceHeight: asset.height, scale, times, still: false, getFrame: (ms) => decoded.getFrame(ms) },
        dispose: () => decoded.dispose(),
      };
    }
  }
  return buildEditorProvider(doc, tracker, clip, color);
}

/** The `<video>` / image path: frames drawn by the editor, one seek each. */
async function buildEditorProvider(
  doc: MotionDocument,
  tracker: Tracker,
  clip: VisualClip,
  color: boolean,
): Promise<{ provider: FrameProvider; dispose: () => void }> {
  const asset = doc.assets.find((a) => a.id === tracker.source.assetId);
  if (!asset) throw new Error("The footage is missing from this project.");
  const grabber = asset.kind === "video" ? await videoGrabber(asset) : asset.kind === "image" ? await imageGrabber(asset) : null;
  if (!grabber) throw new Error(`Can't track ${asset.kind} — pick a video or image.`);

  const scale = analysisScale(grabber.width, grabber.height, analysisEdgeOf(tracker));
  const w = Math.max(1, Math.round(grabber.width * scale));
  const h = Math.max(1, Math.round(grabber.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const { times } = frameGrid(doc, tracker, clip, grabber.still);

  const provider: FrameProvider = {
    sourceWidth: grabber.width,
    sourceHeight: grabber.height,
    scale,
    times,
    still: grabber.still,
    async getFrame(sourceMs): Promise<AnalysisFrame> {
      await grabber.draw(sourceMs, ctx, w, h);
      const rgba = ctx.getImageData(0, 0, w, h).data;
      return { width: w, height: h, luma: lumaFromRgba(rgba, w, h), ...(color ? { rgba } : {}) };
    },
  };
  return {
    provider,
    dispose: () => {
      grabber.dispose();
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}
