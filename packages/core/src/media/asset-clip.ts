import type { Asset, Clip } from "../schema";
import { createAssetAudioClip, createImageClip, createVideoClip } from "../factories";
import { isSequenceMime } from "./sequence";
import { isAnimatedImageMime } from "../preview/picture-steady";

/**
 * ONE ASSET → ONE CLIP. The rule every door that places media shares — a drop
 * on the stage, the timeline, the Media library, a generated file the agent
 * brings in — so none of them can disagree about what a video or a GIF becomes.
 * It lived in the web importer until the headless API needed the same answer.
 */

export interface AssetClipTarget {
  frameId: string;
  startMs: number;
  /** Comp space, centre origin. */
  x?: number;
  y?: number;
}

/** Build the right clip kind for an asset, scaled to sit comfortably in the frame. */
export function clipForAsset(
  asset: Asset,
  target: AssetClipTarget,
  frameSize: { width: number; height: number },
): Clip {
  const base = {
    frameId: target.frameId,
    assetId: asset.id,
    name: asset.name.replace(/\.[^.]+$/, ""),
    startMs: target.startMs,
    x: target.x ?? 0,
    y: target.y ?? 0,
  };
  if (asset.kind === "image") {
    // A sequence runs its own length and plays once, like footage; a GIF
    // loops, as the format does everywhere else.
    const sequence = isSequenceMime(asset.mime);
    const clip = createImageClip({ ...base, durationMs: sequence ? (asset.durationMs ?? 5000) : 5000 });
    clip.transform.scale = fitScale(asset, frameSize);
    if (sequence) {
      clip.playback = { speed: 1, loop: "none", reverse: false, loopLengthMs: null };
      return clip;
    }
    // Animated formats (gif/apng/webp) get a real playback contract — same
    // speed/loop/reverse/loopLengthMs as video — seeded to "loop" so nothing
    // changes for existing always-looping gif behavior until touched.
    if (isAnimatedImageMime(asset.mime, asset.name)) {
      clip.playback = { speed: 1, loop: "loop", reverse: false, loopLengthMs: null };
    }
    return clip;
  }
  if (asset.kind === "video") {
    const clip = createVideoClip({ ...base, durationMs: asset.durationMs ?? 5000 });
    clip.transform.scale = fitScale(asset, frameSize);
    return clip;
  }
  return createAssetAudioClip({
    ...base,
    durationMs: asset.durationMs ?? 5000,
    soundBus: guessAudioBus(asset.name),
  });
}

/**
 * A light name heuristic for routing imported audio into a built-in category.
 * Voice clips get keep-pitch locked on and the dialogue leveler; it's one click
 * to change in the inspector, so a wrong guess costs nothing — this just picks
 * a sensible default so "my narration chipmunks when I speed it up" never
 * happens. Undefined = routed by default.
 */
function guessAudioBus(name: string): string | undefined {
  const n = name.toLowerCase();
  if (/\b(voice|vocal|vo|narrat|speech|dialog|dialogue|voiceover|podcast|mic|record)/.test(n)) return "voice";
  if (/\b(music|song|track|beat|score|bgm|instrumental|melody|loop)/.test(n)) return "music";
  if (/\b(ambien|room ?tone|atmos|backgr|crowd|wind|rain|forest|city)/.test(n)) return "ambience";
  if (/\b(sfx|whoosh|swoosh|click|pop|hit|impact|boom|ding|beep|swipe|riser)/.test(n)) return "sfx";
  return undefined;
}

/**
 * How big a new picture lands: never upscaled, and with a little room — ~90%
 * of the frame — so a photo dropped on a comp reads as a thing placed on it.
 *
 * Unless it is the comp's own SHAPE. A plate, a full-frame render, a
 * background at (or above) the comp's size was meant to FILL it, and at 0.9 it
 * left a ~50 px band of comp background round the edge that read as a bug. A
 * picture whose aspect matches the comp's within 1% lands exactly filling it
 * (or, smaller than the comp, at its own size).
 */
const FRAME_SHAPED = 0.01;
export function fitScale(asset: Pick<Asset, "width" | "height">, frame: { width: number; height: number }): number {
  const w = asset.width ?? 512;
  const h = asset.height ?? 512;
  const fill = Math.min(frame.width / w, frame.height / h);
  const sameShape = Math.abs(w / h / (frame.width / frame.height) - 1) <= FRAME_SHAPED;
  // Comp-shaped: fill it, or at a smaller size stay native (never upscaled).
  if (sameShape) return Math.min(1, fill);
  return Math.min(1, fill * 0.9);
}
