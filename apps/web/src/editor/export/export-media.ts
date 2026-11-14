"use client";

import { identity } from "@/editor/identity";
import { prepareWorldsForExport } from "../world/loader";
import {
  frameDurationMs,
  frameFps,
  collectFontFamilies,
  parseDocument,
  serializeDocument,
  type DocumentStore,
  type Frame,
  type MotionDocument,
  normalizeFps,
  avcCodecLadder,
  avcColourCodes,
  patchAvcCColour,
  frameHasAudio,
  qualityBitrate,
  videoQuality,
  type VideoQualityId,
} from "@solomotion/core";
import type { ArrayBufferTarget as ArrayBufferTargetType } from "mp4-muxer";
import { compRenderTimeMs, exportPolicy } from "@solomotion/core";
import { saveExport, type SaveSink } from "./save";
import { drawFrameContent } from "../stage/render/draw-frame";
import { prepareEffectPassesForExport } from "../stage/render/passes/registry";
import { lockMediaForExport, prepareAnimatedImagesForExport, prepareImagesForExport, prepareVideoFramesForExport, syncVideoFrames } from "../stage/render/media-cache";
import { prepareSurfacesForExport } from "../drawing/raster-store";
import { documentFacesReady, ensureDocumentFaces } from "../stage/render/system-fonts";
import { parseProgressiveMp4Audio, toMuxableAacTrack } from "@solomotion/core";
import {
  audioBufferPeak,
  audioBufferToWav,
  measureMix,
  type MixLoudness,
  renderCompAudioToBuffer,
  audioBufferToPcm16,
  scheduleCompAudioInto,
} from "./export-audio";
import { aacBounceSupported, recordMixAsAac, type RecordFailure } from "./aac-bounce";
import { ENGINE, NAMES } from "@/editor/names";

/**
 * WHAT THIS DEVICE CAN DO ABOUT SOUND, in one readable line.
 *
 * The export panel shows it BEFORE you export. It exists because the bug that
 * led here — "exports have no sound and there is nothing in the logs" — was
 * unanswerable from a phone, where the only place the answer was written is a
 * console the device cannot show. Now the device says it out loud.
 */
export function audioEncoderSummary(): string {
  const webcodecs = typeof AudioEncoder !== "undefined";
  const recorder = aacBounceSupported();
  if (webcodecs) return recorder ? "WebCodecs, or live recording" : "WebCodecs";
  if (recorder) return "live recording (no WebCodecs encoder)";
  return "none — this browser cannot encode audio";
}
import { soundEngine } from "../audio/sound-engine";
import { prepareSpeechForExport } from "../speech/speech-host";
import { prepareSoundForExport } from "../audio/sound-host";
import { prepareDepthForExport } from "../tracking/depth-store";

/**
 * Export pipeline. Every visual format renders through the exact same
 * drawFrameContent path as the live preview — what you see is what ships.
 *
 *  MP4          frame-accurate offline render (WebCodecs + mp4-muxer), AAC audio
 *  PNG sequence frame-accurate, zipped (stored, PNGs are already compressed)
 *  WebM         realtime capture (MediaRecorder) — the broad-compat fallback
 *  PNG          the current frame at full resolution
 *  JSON         the document itself — the interchange format
 */

/** Every file this module makes leaves through the one save door (see ./save), or the caller's own. */
function saveFile(options: Pick<VideoExportOptions, "save">, blob: Blob, filename: string): void {
  (options.save ?? saveExport)(blob, filename);
}

function safeName(name: string): string {
  return name.replace(/[^\w\d-]+/g, "-").replace(/^-+|-+$/g, "") || NAMES.files.fallbackName;
}

function makeCanvas(
  width: number,
  height: number,
  opaque = false,
): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: !opaque });
  if (!ctx) throw new Error("Canvas 2D unavailable");
  return [canvas, ctx];
}

export interface VideoExportOptions {
  /** Render this many ms; defaults to the frame's effective duration. */
  durationMs?: number;
  /** Offset the render window's start (working-range export); default 0. */
  startMs?: number;
  includeAudio?: boolean;
  /** Output resolution multiplier (1 = native frame size); default 1. */
  scale?: number;
  /** Frames per second override for stepping/encoding; default the frame fps. */
  fps?: number;
  /** Constant-quality tier for MP4; the WebM fallback derives its bitrate from
   *  it too. Default `high`. See `VIDEO_QUALITY_TIERS`. */
  quality?: VideoQualityId;
  /** Explicit video bitrate in bits/sec. Only used when the browser offers no
   *  quantizer control — `quality` is the setting. */
  videoBitrate?: number;
  /** Audio bitrate in bits/sec (MP4); default 192 kbps. */
  audioBitrate?: number;
  /**
   * HOW THE SOUND GETS INTO AN MP4.
   *
   * `auto` encodes the offline mix with WebCodecs and falls back to recording
   * when that does not hold up. `live` skips straight to recording the audio
   * graph — the same one you hear on play — which is slower by the length of
   * the comp and is the one path that cannot disagree with playback.
   *
   * It exists because a user should never be stuck waiting for someone else to
   * correctly diagnose their device. WebKit exports came back silent through
   * every automatic route while the recorded route worked, so the recorded
   * route is offered as a choice rather than only as a rescue.
   */
  audioCapture?: "auto" | "live";
  /**
   * Layer-scoped export: draw ONLY these clips (see DrawOptions.only).
   * Combined with `region` this is how a layer/group/selection exports
   * through the exact same pipeline as a whole frame.
   */
  onlyClipIds?: string[];
  /** Crop rectangle in frame space; default = the whole frame. */
  region?: { x: number; y: number; width: number; height: number };
  /** Transparent canvas (skip the frame background). PNG/GIF respect alpha. */
  transparent?: boolean;
  /**
   * MOTION BLUR (v56) — the render-setting level of the three-level model. It
   * can only ever turn the comp's own shutters OFF, never on: a layer that is
   * not blurring in the preview will not start because of an export flag.
   *
   * Defaults to ON, and to the full `content` tier, because an export is a
   * render and not a playback. This is the one moment the extra samples are
   * unambiguously worth paying for — nobody is waiting on a frame budget, and
   * the result is the thing that ships.
   */
  motionBlur?: boolean;
  /** Output file base name (no extension); default `<doc>-<frame>`. */
  fileName?: string;
  /** Hand the finished file to the caller instead of downloading it — how a
   *  render in place keeps its video as project media. MP4 only. */
  deliver?: (file: Blob) => void;
  /** Where the finished file goes — default the browser's downloads. A batch
   *  or the agent's export passes its own (`collectSaves`). */
  save?: SaveSink;
  onProgress?: (fraction: number) => void;
  /** Told, before the first frame, what could not be made ready in time (a font that would not load). */
  onReadiness?: (readiness: RenderReadiness) => void;
  /**
   * Live render preview: called with the freshly-drawn export canvas after each
   * frame, so a panel can blit exactly what's being encoded (not a static
   * snapshot). The canvas is reused every frame — read/copy it synchronously.
   */
  onFrame?: (canvas: HTMLCanvasElement, timeMs: number) => void;
  signal?: AbortSignal;
}

/** The drawable rect of an export (region crop or the whole frame). */
function exportRegion(frame: Frame, options: VideoExportOptions) {
  return options.region ?? { x: 0, y: 0, width: frame.width, height: frame.height };
}

/** Output file base name. */
function fileBase(doc: MotionDocument, frame: Frame, options: VideoExportOptions): string {
  return options.fileName ? safeName(options.fileName) : `${safeName(doc.name)}-${safeName(frame.name)}`;
}

/**
 * The ONE per-frame draw for every exporter: clears the region and renders
 * through the same drawFrameContent as the live preview — scoped to the
 * export's clips.
 *
 * It does NOT paint the artboard itself. It used to, and then told the renderer
 * to skip its own background — which meant the document said "this frame has no
 * background" to everything downstream that asks. Materials ask: liquid glass
 * refracts the scene BENEATH a layer, rebuilt from the document rather than
 * scraped off the canvas, so it rebuilt an empty one and every export came back
 * with the glass flat while the stage looked right. Frame gradients and frame
 * borders were being dropped by the same shortcut. The renderer owns the frame
 * box; the exporter owns the region and the alpha.
 */
function drawExportFrame(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  timeMs: number,
  options: VideoExportOptions,
): void {
  const region = exportRegion(frame, options);
  const only = options.onlyClipIds?.length ? new Set(options.onlyClipIds) : null;
  ctx.save();
  ctx.clearRect(region.x, region.y, region.width, region.height);
  // The export's frame-rate override re-rates the comp being rendered (root
  // only — nested comps keep their own rate). Undefined = the comp's own rate.
  drawFrameContent(ctx, doc, frame, timeMs, {
    only,
    transparent: options.transparent === true,
    fpsOverride: options.fps ?? null,
    // Rasterise effects at the OUTPUT scale: a 2× render deserves a 2× grain
    // and a 2× glass rim, not a frame-resolution one blown up.
    renderScale: outputDims(frame, options).scale,
    // A deliverable: no preview cache may take a buffer from this walk.
    exporting: true,
    // An export renders at full quality by default — see `motionBlur` above.
    motionBlur: exportPolicy(options.motionBlur !== false),
  });
  ctx.restore();
}

function exportSpan(doc: MotionDocument, frame: Frame, options: VideoExportOptions): number {
  return options.durationMs ?? frameDurationMs(doc, frame);
}

function exportStartMs(options: VideoExportOptions): number {
  return Math.max(0, options.startMs ?? 0);
}

function outputFps(doc: MotionDocument, frame: Frame, options: VideoExportOptions): number {
  // NOT rounded to an integer: 23.976 and 29.97 are real delivery rates, and
  // rounding them silently shipped 24/30 with a drifting soundtrack.
  return normalizeFps(options.fps ?? frameFps(doc, frame));
}

/** Even, positive output dimensions after the scale multiplier. */
function outputDims(frame: Frame, options: VideoExportOptions): { width: number; height: number; scale: number } {
  const region = exportRegion(frame, options);
  const scale = Math.max(0.05, options.scale ?? 1);
  const width = Math.max(2, Math.round(region.width * scale));
  const height = Math.max(2, Math.round(region.height * scale));
  return { width, height, scale };
}

/**
 * A canvas at the scaled output size, with the context pre-scaled (and the
 * export region translated into view) so the same native-coordinate
 * `drawExportFrame` fills it (save/restore inside compose).
 *
 * `opaque` drops the alpha channel. H.264 and the WebM profiles we record have
 * nowhere to put alpha, so an RGBA surface there buys nothing and costs a
 * premultiply/un-premultiply round trip whose 8-bit rounding error lands
 * exactly on antialiased edges — the pixels a video codec is least able to
 * hide. Video renders opaque; PNG and GIF keep their alpha.
 */
function makeScaledCanvas(
  frame: Frame,
  options: VideoExportOptions,
  surface: { even?: boolean; opaque?: boolean } = {},
): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const region = exportRegion(frame, options);
  let { width, height } = outputDims(frame, options);
  if (surface.even) {
    width -= width % 2;
    height -= height % 2;
  }
  const [canvas, ctx] = makeCanvas(width, height, surface.opaque);
  ctx.scale(width / region.width, height / region.height);
  ctx.translate(-region.x, -region.y);
  return [canvas, ctx];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
}

/** Yield without setTimeout: background tabs throttle timers to ≥1s ticks,
 * which would crawl a backgrounded render — MessageChannel tasks are exempt. */
const yieldToUi = (() => {
  if (typeof MessageChannel === "undefined") return () => new Promise<void>((r) => setTimeout(r, 0));
  const channel = new MessageChannel();
  const waiting: Array<() => void> = [];
  channel.port1.onmessage = () => waiting.shift()?.();
  return () =>
    new Promise<void>((r) => {
      waiting.push(r);
      channel.port2.postMessage(0);
    });
})();

/**
 * Yield when the page has been busy long enough to matter — by TIME, never by
 * frame count. "Every 10 frames" was a few milliseconds on a simple comp and
 * half a minute on a heavy one (glass, materials, motion blur at 1–3 s a
 * frame), and for that half minute the page heard nothing: an agent's
 * `export.wait` answered at 53 s instead of 25, the client gave up at 60, and
 * the tab could not follow its link to a new hub, so the agent was told no
 * tab was linked. Yielding after any frame that took longer than a slice
 * keeps the socket, the timers and the UI answering at most one frame late.
 */
let lastYield = 0;
const YIELD_SLICE_MS = 24;
async function yieldIfDue(): Promise<void> {
  if (performance.now() - lastYield < YIELD_SLICE_MS) return;
  await yieldToUi();
  lastYield = performance.now();
}

/** Hold a Web Lock while `fn` renders: Chrome exempts lock-holding pages from
 * intensive timer throttling and tab freezing, so an export keeps running
 * while the tab is hidden or the user works in another window. */
export function withRenderKeepAlive<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks?.request) return fn();
  return locks.request(`${NAMES.wire.renderLock}${Date.now()}-${Math.random()}`, fn) as Promise<T>;
}

// ── JSON (the interchange format) ────────────────────────────────────────────

export function exportJson(doc: MotionDocument): void {
  const blob = new Blob([serializeDocument(doc)], { type: "application/json" });
  saveExport(blob, `${safeName(doc.name)}${NAMES.files.jsonExport}`);
}

export function importJson(store: DocumentStore): Promise<MotionDocument> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error("No file selected"));
      try {
        const doc = parseDocument(await file.text(), ENGINE.ns);
        ensureDocumentFaces(doc);
        store.replace(doc);
        resolve(doc);
      } catch (err) {
        reject(err);
      }
    };
    input.click();
  });
}

/**
 * Everything HEARD (and seen), ready before stepping frames: every sound a
 * visualizer, `sound()` or a Sound node listens to has its analysis, every
 * voice a mouth follows has its track, and every depth map an effect reads is
 * in memory — so no exported frame shows the pending silence, the resting
 * mouth or an unfogged plate. Same contract as the image and video steps.
 */
async function prepareHeardForExport(doc: MotionDocument): Promise<void> {
  await Promise.all([prepareSoundForExport(doc), prepareSpeechForExport(doc), prepareDepthForExport(doc)]);
}

/** What a render could not get ready in time — said, never silently drawn around. */
export interface RenderReadiness {
  /** Families still drawing in a fallback face after the wait. */
  fontsPending: string[];
}

/**
 * EVERYTHING A RENDER DRAWS, READY — the one list, before the first frame.
 *
 * It was written out at every entry point (the still, the PNG sequence, the
 * lossless master, MP4), five copies of one list, and when type joined the
 * things a render must wait for, nothing had a single place to put it. Each
 * entry point now calls this; video frames, which are per instant, stay with
 * the frame loop.
 */
export async function prepareDocumentForExport(doc: MotionDocument, frame: Frame): Promise<RenderReadiness> {
  // Fonts load over the network alongside everything else; they are awaited last.
  // The faces THIS comp draws (its nested comps' too): another comp's font is no reason to wait, or to warn.
  const fonts = documentFacesReady(doc, frame.id);
  await prepareAnimatedImagesForExport(doc);
  await prepareImagesForExport(doc);
  await prepareSurfacesForExport(doc);
  await prepareEffectPassesForExport(doc);
  await prepareWorldsForExport(doc);
  await prepareHeardForExport(doc);
  const fontsPending = await fonts;
  if (fontsPending.length) console.warn(`[export] drawing ${fontsPending.join(", ")} in a fallback face: the font did not load in time.`);
  return { fontsPending };
}

// ── PNG (one frame — whole comp or a layer region, any scale) ────────────────

export async function exportPng(
  doc: MotionDocument,
  frame: Frame,
  timeMs: number,
  options: VideoExportOptions = {},
): Promise<void> {
  const canvas = await renderStill(doc, frame, timeMs, options);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) throw new Error("PNG encode failed");
  saveFile(options, blob, `${fileBase(doc, frame, options)}.png`);
}

/**
 * ONE FRAME, RENDERED — every media dependency prepared, then drawn through
 * the exporter's own `drawExportFrame`. The still export and the agent's eyes
 * (`view.render`) are this one function, so what the agent judges is exactly
 * what the user would export: materials, video frames, paint and all.
 */
export async function renderStill(
  doc: MotionDocument,
  frame: Frame,
  timeMs: number,
  options: VideoExportOptions = {},
): Promise<HTMLCanvasElement> {
  // Prepare media for the instant the frame SHOWS (a still's, for a static one).
  timeMs = compRenderTimeMs(doc, frame.id, timeMs);
  const [canvas, ctx] = makeScaledCanvas(frame, options);
  const unlock = lockMediaForExport();
  try {
    options.onReadiness?.(await prepareDocumentForExport(doc, frame));
    await prepareVideoFramesForExport(doc, frame, timeMs);
    drawExportFrame(ctx, doc, frame, timeMs, options);
  } finally {
    unlock();
  }
  return canvas;
}

// ── PNG sequence (zip of numbered frames) ────────────────────────────────────

/**
 * THE LOSSLESS MASTER — a QuickTime .mov of the exact PNG frames, with PCM
 * sound. No video encoder, no audio encoder, nothing platform-specific.
 *
 * Every other video path hands the pictures to a codec and gets back an
 * approximation: H.264 is 4:2:0, which stores colour at half resolution in both
 * directions, and on hard-edged graphics that — not the bitrate, not the
 * quantizer, not the browser — is the whole of the visible loss. This path
 * doesn't approximate anything. The frames go in byte for byte, so what comes
 * out of the file is what `Export → Current frame (PNG)` would have given you,
 * every frame, with alpha if the export is transparent.
 *
 * It is also the only video export whose sound is guaranteed on every device:
 * the audio is the offline mix as PCM, so WebKit's broken AAC path and
 * Firefox's Opus-in-MP4 fallback (silent in QuickTime, Safari, iOS and most
 * NLEs) are both simply not in the picture.
 *
 * The cost is size — a master is 100–400 Mbps, the same ballpark as ProRes 4444
 * — and that is the correct trade for something you hand to an editor, archive,
 * or re-encode later. It is not the file you upload.
 */
export function exportLosslessMov(
  doc: MotionDocument,
  frame: Frame,
  options: VideoExportOptions = {},
): Promise<{ audioIncluded: boolean; loudness: MixLoudness | null }> {
  return withRenderKeepAlive(() => runLosslessMovExport(doc, frame, options));
}

/** How much of the progress bar the audio bounce owns. */
const MOV_AUDIO_SHARE = 0.1;

async function runLosslessMovExport(
  doc: MotionDocument,
  frame: Frame,
  options: VideoExportOptions,
): Promise<{ audioIncluded: boolean; loudness: MixLoudness | null }> {
  const durationMs = exportSpan(doc, frame, options);
  const start = exportStartMs(options);
  const fps = outputFps(doc, frame, options);
  const frameCount = Math.max(1, Math.round((durationMs / 1000) * fps));
  // Transparency survives all the way here: a 32-bit sample description is what
  // tells QuickTime the PNGs carry an alpha channel.
  const [canvas, ctx] = makeScaledCanvas(frame, options);

  const wantsAudio = options.includeAudio !== false && frameHasAudio(doc, frame.id);
  let pcm: { pcm: Uint8Array; sampleRate: number; channels: number } | null = null;
  let loudness: MixLoudness | null = null;
  if (wantsAudio) {
    try {
      const buffer = await renderCompAudioToBuffer(doc, frame.id, durationMs, MIX_SAMPLE_RATE, start);
      pcm = audioBufferToPcm16(buffer);
      loudness = measureMix(buffer);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw err;
      // The picture is not held hostage by the sound — and PCM is the one audio
      // path with nothing in it that can fail quietly, so this is loud.
      console.error(`[${identity.ns}] master audio mix failed`, err);
    }
    options.onProgress?.(MOV_AUDIO_SHARE);
  }

  // The muxer loads on demand — the same deal the zip encoder gets in the PNG
  // sequence: nobody carries the master's code until they ask for a master.
  const { ArrayBufferMovTarget, MovMuxer, patchMdatSize } = await import("@solomotion/core");
  const target = new ArrayBufferMovTarget();
  const muxer = new MovMuxer(target, {
    video: {
      width: canvas.width,
      height: canvas.height,
      fps,
      depth: options.transparent ? 32 : 24,
      compressorName: `${identity.name} PNG`,
    },
    ...(pcm ? { audio: { sampleRate: pcm.sampleRate, channels: pcm.channels, bitDepth: 16 } } : {}),
  });

  const videoShare = pcm ? 1 - MOV_AUDIO_SHARE : 1;
  const videoBase = pcm ? MOV_AUDIO_SHARE : 0;
  const unlock = lockMediaForExport();
  try {
    options.onReadiness?.(await prepareDocumentForExport(doc, frame));
    for (let i = 0; i < frameCount; i++) {
      throwIfAborted(options.signal);
      const t = start + (i / fps) * 1000;
      await prepareVideoFramesForExport(doc, frame, t);
      drawExportFrame(ctx, doc, frame, t, options);
      options.onFrame?.(canvas, t);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (!blob) throw new Error(`PNG encode failed at frame ${i}`);
      muxer.addVideoFrame(new Uint8Array(await blob.arrayBuffer()));
      options.onProgress?.(videoBase + ((i + 1) / frameCount) * videoShare);
      await yieldIfDue();
    }
  } finally {
    unlock();
  }
  if (pcm) muxer.addAudioSamples(pcm.pcm);
  muxer.finalize();
  const file = patchMdatSize(target.buffer(), muxer.mdatPatch);
  console.info(
    `[${identity.ns}] MOV master · ${canvas.width}x${canvas.height} @ ${fps} · ` +
      `${frameCount} PNG frames${pcm ? ` · PCM ${pcm.sampleRate} Hz` : " · no audio"} · ` +
      `${(file.length / 1e6).toFixed(1)} MB`,
  );
  saveFile(options, new Blob([file.slice().buffer], { type: "video/quicktime" }), `${fileBase(doc, frame, options)}.mov`);
  return { audioIncluded: pcm !== null, loudness };
}

export function exportPngSequence(
  doc: MotionDocument,
  frame: Frame,
  options: VideoExportOptions = {},
): Promise<void> {
  return withRenderKeepAlive(() => runPngSequenceExport(doc, frame, options));
}

async function runPngSequenceExport(
  doc: MotionDocument,
  frame: Frame,
  options: VideoExportOptions,
): Promise<void> {
  // fflate loads on demand — nobody pays for the zip encoder until they zip.
  const { Zip, ZipPassThrough } = await import("fflate");
  const frameCount = sequenceFrameCount(doc, frame, options);

  const chunks: Uint8Array[] = [];
  let zipDone: () => void = () => undefined;
  let zipFail: (e: Error) => void = () => undefined;
  const finished = new Promise<void>((resolve, reject) => {
    zipDone = resolve;
    zipFail = reject;
  });
  const zip = new Zip((err, chunk, final) => {
    if (err) return zipFail(err);
    if (chunk) chunks.push(chunk);
    if (final) zipDone();
  });

  const digits = String(frameCount).length;
  await renderFrameSequence(doc, frame, options, async (canvas, i) => {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error(`PNG encode failed at frame ${i}`);
    const data = new Uint8Array(await blob.arrayBuffer());
    // Stored (no re-compression): PNG payloads are already deflated.
    const entry = new ZipPassThrough(`frame-${String(i).padStart(digits, "0")}.png`);
    zip.add(entry);
    entry.push(data, true);
  });
  zip.end();
  await finished;

  saveFile(options, 
    new Blob(chunks as BlobPart[], { type: "application/zip" }),
    `${fileBase(doc, frame, options)}-png-seq.zip`,
  );
}

/** How many pictures a frame-by-frame render of this span makes. */
export function sequenceFrameCount(doc: MotionDocument, frame: Frame, options: VideoExportOptions = {}): number {
  return Math.max(1, Math.round((exportSpan(doc, frame, options) / 1000) * outputFps(doc, frame, options)));
}

/**
 * THE frame-by-frame render loop for every consumer that wants pictures rather
 * than a video file — the PNG sequence, and render in place. Exact media (every
 * seek verified), the same draw as the stage, one canvas reused; `onFrame`
 * reads it before the next frame overwrites it.
 *
 * `share` is how much of the main thread the loop may take (0–1). A render
 * someone is WAITING on takes it all; a background render (render in place)
 * sleeps in proportion to each frame's cost, so the editor stays responsive
 * while it runs. Media is locked only when the comp holds footage — nothing
 * else a render reads is shared with the stage.
 */
export async function renderFrameSequence(
  doc: MotionDocument,
  frame: Frame,
  options: VideoExportOptions & { share?: number; lockMedia?: boolean },
  onFrame: (canvas: HTMLCanvasElement, index: number, timeMs: number) => Promise<void>,
): Promise<void> {
  const start = exportStartMs(options);
  const fps = outputFps(doc, frame, options);
  const frameCount = sequenceFrameCount(doc, frame, options);
  const share = Math.min(1, Math.max(0.1, options.share ?? 1));
  const [canvas, ctx] = makeScaledCanvas(frame, options);
  const unlock = options.lockMedia === false ? () => undefined : lockMediaForExport();
  try {
    options.onReadiness?.(await prepareDocumentForExport(doc, frame));
    for (let i = 0; i < frameCount; i++) {
      throwIfAborted(options.signal);
      const began = performance.now();
      const t = start + (i / fps) * 1000;
      await prepareVideoFramesForExport(doc, frame, t);
      drawExportFrame(ctx, doc, frame, t, options);
      options.onFrame?.(canvas, t);
      await onFrame(canvas, i, t);
      options.onProgress?.((i + 1) / frameCount);
      if (share < 1) {
        const rest = ((performance.now() - began) * (1 - share)) / share;
        await new Promise<void>((r) => setTimeout(r, Math.min(250, rest)));
      } else {
        await yieldIfDue();
      }
    }
  } finally {
    unlock();
  }
}

// ── MP4 (frame-accurate offline render via WebCodecs) ────────────────────────

export function mp4Supported(): boolean {
  return typeof VideoEncoder !== "undefined";
}

/**
 * The H.264 configuration to render with — CONSTANT QUALITY FIRST.
 *
 * Exports came back with bright specks strewn across flat backgrounds behind
 * anything that moved, denser the faster it moved, clearing a beat after the
 * motion stopped and returning the moment it started again. The same document
 * exported as a GIF or a PNG sequence was spotless, and whether it happened at
 * all depended on the machine.
 *
 * That shape of fault is rate control. GIF and PNG are intra-only — every frame
 * stands alone, so there is nothing to get wrong. H.264 predicts each frame from
 * the last and spends a *budget* on the difference, and the budget is a guess
 * the encoder makes about how many bits the next second deserves. Fast motion
 * eats that guess: the encoder pours bits into the moving edge and quantises the
 * background so coarsely that stray coefficients survive in blocks that should
 * be flat — one bright speck each, on a gradient that shows everything. They sit
 * in the prediction chain until a keyframe clears them, which is the beat you
 * see after the shape stops. How badly a given encoder mis-guesses is its own
 * business, which is why one computer was fine and another was not.
 *
 * So stop asking for a bitrate. A master render has no pipe to fit; it should
 * name a quality and cost whatever it costs. `bitrateMode: "quantizer"` does
 * exactly that — the quantizer is passed per frame and there is no budget to
 * mis-spend — and it is how every professional encoder exports.
 *
 * The ladder, best first: constant quality before bitrate, and within each,
 * software before the GPU. An export is offline work, so there is nothing to buy
 * with latency, and a CPU encoder gives every machine the same file.
 */
/**
 * PROBE A VIDEO CONFIG WITHOUT TRUSTING THE PROBE TO RETURN.
 *
 * `isConfigSupported` is specified to REJECT — with a `TypeError` — for a
 * config the implementation considers invalid, and only to resolve
 * `{ supported: false }` for one it considers valid but cannot do. Which side
 * of that line a given dictionary member falls on is the implementation's
 * call, and Safari draws it in a different place from Chrome: it rejects
 * `bitrateMode: "quantizer"` outright rather than answering "no".
 *
 * The ladder below probes quantizer FIRST, because for an offline render a
 * quality is the right thing to ask for and a bitrate is not. So on iOS the
 * very first rung threw, the throw escaped the whole ladder, and the export
 * died with a bare `TypeError` — before ever reaching the plain variable-bitrate
 * config that device would have accepted. Every project, however simple.
 *
 * A ladder whose rungs may reject has to treat rejection as a rung that did
 * not hold. The audio probe beside this one already did; the video probe did
 * not, and that asymmetry is the bug — the same question answered two ways in
 * one file.
 */
async function videoConfigSupported(config: VideoEncoderConfig): Promise<boolean> {
  try {
    const { supported } = await VideoEncoder.isConfigSupported(config);
    return supported ?? false;
  } catch {
    // Rejected: this engine will not even consider the config. That is a "no",
    // not a reason to abandon the search.
    return false;
  }
}

async function pickAvcConfig(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
  quantizer: number,
): Promise<{ config: VideoEncoderConfig; hardware: boolean; quantizer: number | null }> {
  for (const bitrateMode of ["quantizer", "variable"] as const) {
    // A level carries a bitrate ceiling. In quantizer mode there is no bitrate
    // to declare, so a level sized to the *fallback* number would be a ceiling
    // on the quality we just asked for — an encoder that enforces its declared
    // level would clamp Master back into exactly the noise this replaced. Size
    // the level with headroom; a slightly higher level costs nothing.
    const codecs = avcCodecLadder(width, height, fps, bitrateMode === "quantizer" ? bitrate * 4 : bitrate);
    for (const hardwareAcceleration of ["prefer-software", "no-preference"] as const) {
      for (const codec of codecs) {
        const config: VideoEncoderConfig = {
          codec,
          width,
          height,
          framerate: fps,
          hardwareAcceleration,
          // An offline render: let the encoder reorder and look ahead.
          latencyMode: "quality",
          bitrateMode,
          alpha: "discard",
          // In quantizer mode a bitrate is meaningless — omitting it is how the
          // encoder is told there is no budget, only a quality.
          ...(bitrateMode === "variable" ? { bitrate } : {}),
        };
        const supported = await videoConfigSupported(config);
        // Configure with OUR config, never the echoed one: the returned config
        // is normalised, and a normalisation that drops `hardwareAcceleration`
        // would silently undo the only line here that chooses an encoder.
        if (supported) {
          return {
            config,
            hardware: hardwareAcceleration !== "prefer-software",
            quantizer: bitrateMode === "quantizer" ? quantizer : null,
          };
        }
      }
    }
  }
  // Everything on the ladder was refused. Name the size, because on a phone the
  // usual cause is a resolution the hardware encoder will not take — which is
  // actionable, unlike "export failed".
  throw new Error(
    `No H.264 encoder configuration this browser accepts at ${width}×${height}. ` +
      `Try a smaller size, or export WebM.`,
  );
}

/**
 * SAY THE COLOUR SPACE TWICE — in the container AND in the bitstream.
 *
 * WebCodecs reports the colour space of what it encoded, and `mp4-muxer` turns
 * that into the MP4's `colr` box, so a player that reads the container gets the
 * right picture (Chrome does). The H.264 stream inside carries the same fact in
 * its SPS, and the browser encoders write "unspecified" there — so a reader
 * that trusts the bitstream has to guess, guesses by picture size, and lands on
 * BT.601 for every vertical export. BT.601 maths on BT.709 pixels is the pink
 * that comes back darker and more orange than the PNG of the same frame.
 *
 * Measured on a 1080×1920 export: untagged, a #FF4E6A pill decodes to #EE3768;
 * with the SPS tagged, #FD4C67 — the PNG, to within the rounding that
 * limited-range 8-bit YUV costs.
 *
 * It restates the encoder's own answer and nothing else: with no reported
 * colour space there is no fact to copy, and the description is passed through
 * untouched.
 */
function tagBitstreamColour(meta: EncodedVideoChunkMetadata | undefined): EncodedVideoChunkMetadata | undefined {
  const config = meta?.decoderConfig;
  const description = config?.description;
  if (!meta || !config || !description) return meta;
  const colour = avcColourCodes(config.colorSpace);
  if (!colour) return meta;
  const bytes = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
  const patched = patchAvcCColour(bytes, colour);
  if (patched === bytes) return meta;
  return { ...meta, decoderConfig: { ...config, description: patched } };
}

export interface Mp4ExportResult {
  audioIncluded: boolean;
  audioCodec: "aac" | "opus" | null;
  /**
   * WHICH AUDIO PATH RAN, in one sentence, for a human to read.
   *
   * A phone has no console. "Exports have no sound and there is nothing in the
   * logs" is not a bug report anyone can act on — not because the reporter did
   * anything wrong, but because the only place the answer was written is a
   * place that device cannot show. So the answer comes back with the export and
   * the panel puts it on screen.
   */
  audioReport: string;
  /** The loudness of the mix in the file; null when there is none, or it could not be measured here. */
  loudness: MixLoudness | null;
  /** The H.264 config the browser actually accepted, and whether it is the
   *  GPU's encoder. Reported because "which encoder made this file" is the
   *  first question any future report of export artefacts has to answer. */
  video: { codec: string; hardware: boolean; quantizer: number | null };
}

export function exportMp4(
  doc: MotionDocument,
  frame: Frame,
  options: VideoExportOptions = {},
): Promise<Mp4ExportResult> {
  return withRenderKeepAlive(() => runMp4Export(doc, frame, options));
}

async function runMp4Export(
  doc: MotionDocument,
  frame: Frame,
  options: VideoExportOptions,
): Promise<Mp4ExportResult> {
  if (!mp4Supported()) throw new Error("This browser has no WebCodecs video encoder — export WebM instead");

  // mp4-muxer loads on demand — the editor never pays for it until an export.
  const { ArrayBufferTarget, Muxer } = await import("mp4-muxer");
  const durationMs = exportSpan(doc, frame, options);
  const start = exportStartMs(options);
  const fps = outputFps(doc, frame, options);
  const frameCount = Math.max(1, Math.round((durationMs / 1000) * fps));
  // H.264 requires even dimensions — the scaled canvas rounds to even.
  const [canvas, ctx] = makeScaledCanvas(frame, options, { even: true, opaque: true });
  const width = canvas.width;
  const height = canvas.height;
  const audioBitrate = options.audioBitrate ?? 192_000;

  // AUDIO FIRST, AND PROVEN FIRST.
  //
  // The audio track is settled — encoded, muxed on its own, read back, and
  // measured against the mix — BEFORE a single video frame is drawn.
  //
  // It used to be settled afterwards, which meant discovering a bad audio track
  // only once the whole picture had been encoded, and repairing it by throwing
  // that picture away and encoding every frame a second time. A minute of video
  // re-rendered to fix a four-second soundtrack. The audio is the cheap part and
  // the only part that fails here; proving it first makes the repair cost
  // seconds instead of the whole export, and there is no reason the video pass
  // should ever run twice.
  let audio: EncodedMp4Audio | null = null;
  let audioReport = "Audio wasn't requested";
  let loudness: MixLoudness | null = null;
  if (options.includeAudio) {
    try {
      const proven = await proveAudioTrack(Muxer, ArrayBufferTarget, {
        doc,
        frameId: frame.id,
        durationMs,
        startMs: start,
        bitrate: audioBitrate,
        capture: options.audioCapture ?? "auto",
        signal: options.signal,
        onProgress: (f) => options.onProgress?.(f * AUDIO_SHARE),
      });
      audio = proven.audio;
      audioReport = proven.report;
      loudness = proven.loudness;
    } catch (err) {
      // A cancel is a cancel; anything else about the SOUND must not destroy
      // the picture. The result reports it and the panel says so — a silent
      // export you were told about beats no export at all.
      if ((err as Error)?.name === "AbortError") throw err;
      console.error(`[${identity.ns}] export audio failed`, err);
      audioReport = `Audio failed: ${(err as Error)?.message ?? String(err)}`;
    }
    options.onProgress?.(AUDIO_SHARE);
  }


  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width, height },
    // The track header must describe the samples we actually have. The
    // recorder rung encodes at the device's own rate (44.1 kHz on a phone),
    // and a header claiming 48 kHz over 44.1 kHz samples plays back slow and
    // detuned — the kind of wrong that sounds like a broken export.
    ...(audio
      ? { audio: { codec: audio.codec, numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate } }
      : {}),
    fastStart: "in-memory",
  });

  let encoderError: Error | null = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, tagBitstreamColour(meta)),
    error: (e) => {
      encoderError = e instanceof Error ? e : new Error(String(e));
    },
  });
  const quality = videoQuality(options.quality);
  const video = await pickAvcConfig(
    width,
    height,
    fps,
    options.videoBitrate ?? qualityBitrate(options.quality, width, height, fps),
    quality.quantizer,
  );
  videoEncoder.configure(video.config);
  // The one line that turns "my export looks noisy" into a diagnosis.
  console.info(
    `[${identity.ns}] MP4 ${video.config.codec} ${video.hardware ? "GPU" : "software"} · ` +
      `${width}×${height} @ ${fps} · ` +
      (video.quantizer !== null
        ? `q${video.quantizer} (${quality.label})`
        : `${((video.config.bitrate ?? 0) / 1e6).toFixed(1)} Mbps (no quantizer control)`),
  );

  const audioShare = audio ? AUDIO_SHARE : 0;
  const microsPerFrame = 1_000_000 / fps;
  /**
   * Keyframe cadence, in FRAMES. It used to be `i % (fps * 2)`, which is only
   * ever 0 at i=0 for the fractional delivery rates (23.976, 29.97) this app
   * supports — so those renders shipped with a single keyframe at the head and
   * let one bad P-frame ride the whole prediction chain to the end of the clip.
   */
  const gop = Math.max(1, Math.round(fps * 2));
  try {
    const unlock = lockMediaForExport();
    try {
      options.onReadiness?.(await prepareDocumentForExport(doc, frame));
      for (let i = 0; i < frameCount; i++) {
        throwIfAborted(options.signal);
        if (encoderError) throw encoderError;
        const t = start + (i / fps) * 1000;
        await prepareVideoFramesForExport(doc, frame, t);
        drawExportFrame(ctx, doc, frame, t, options);
        options.onFrame?.(canvas, t);
        const videoFrame = new VideoFrame(canvas, {
          timestamp: Math.round(i * microsPerFrame),
          duration: Math.round(microsPerFrame),
          alpha: "discard",
        });
        videoEncoder.encode(videoFrame, {
          keyFrame: i % gop === 0,
          // Constant quality: the quantizer IS the setting, every frame.
          ...(video.quantizer !== null ? { avc: { quantizer: video.quantizer } } : {}),
        });
        videoFrame.close();
        // Backpressure: don't let the encode queue outrun the encoder.
        while (videoEncoder.encodeQueueSize > 4) await yieldToUi();
        options.onProgress?.(audioShare + ((i + 1) / frameCount) * (1 - audioShare));
        await yieldIfDue();
      }
    } finally {
      unlock();
    }
    await videoEncoder.flush();
    if (encoderError) throw encoderError;
  } finally {
    // A cancelled/failed export must not strand a hardware encoder.
    if (videoEncoder.state !== "closed") videoEncoder.close();
  }

  if (audio) {
    // The SAME call the rehearsal made, so the track that was proven is the
    // track that ships. Two spellings of "write this audio" would be two
    // things to keep in step, and the proof would stop meaning anything.
    addAudioTrack(muxer, audio);
    options.onProgress?.(1);
  }

  muxer.finalize();
  const { buffer } = muxer.target as ArrayBufferTargetType;

  // ── THE FINISHED FILE, ONE LAST TIME ──────────────────────────────────────
  //
  // The audio track was already proven on its own before any of the picture was
  // drawn, so this is a backstop rather than the safety net: it confirms that
  // adding the video track did not disturb the sound. There is deliberately no
  // repair here any more. A repair at this point could only mean re-encoding
  // every frame, and the whole reason the proof moved earlier is that the
  // picture should never have to be rendered twice to fix the sound.
  if (audio) {
    const peak = await decodedAudioPeak(buffer);
    if (peak !== null) audioReport += `, ${pct(peak)} in the finished file`;
  }

  // Logged HERE, not before the mux — the earlier line printed a report that
  // did not yet include whether the finished file plays, which is the half
  // anyone reading it actually needs.
  console.info(`[${identity.ns}] ${audioReport}`);
  const mp4 = new Blob([buffer], { type: "video/mp4" });
  if (options.deliver) options.deliver(mp4);
  else saveFile(options, mp4, `${fileBase(doc, frame, options)}.mp4`);
  return {
    audioIncluded: audio !== null,
    audioCodec: audio?.codec ?? null,
    audioReport,
    loudness,
    video: { codec: video.config.codec, hardware: video.hardware, quantizer: video.quantizer },
  };
}

/**
 * The loudest sample this engine can decode out of a finished MP4 — the export
 * listening to its own work.
 *
 * Returns null when the bytes could not be decoded at all, which is NOT a
 * verdict: plenty of engines decline to pull audio out of a container that also
 * holds video, and treating that as failure would throw away good exports on
 * machines where nothing was ever wrong. Only a successful decode that comes
 * back flat is evidence, and it is conclusive.
 *
 * Decoding happens on an `OfflineAudioContext` so it needs no user gesture and
 * touches none of the app's live audio.
 */
async function decodedAudioPeak(bytes: ArrayBuffer): Promise<number | null> {
  // READ OUR OWN FILE BACK, WITH OUR OWN READER.
  //
  // This used to ask `decodeAudioData`, and on the one device where the answer
  // mattered it declined — some engines simply refuse to pull audio out of a
  // container that also holds video — so the verification that was meant to
  // catch a silent export reported "could not be verified" and shipped it.
  // Delegating the question to something entitled to refuse is not a check.
  //
  // So the audio track is lifted out of the finished MP4 by
  // `parseProgressiveMp4Audio` and decoded frame by frame with `AudioDecoder`,
  // which is available wherever the encoder that made those frames is. A reader
  // of our own does not get to decline.
  const track = parseProgressiveMp4Audio(new Uint8Array(bytes));
  if (track) {
    const peak = await decodedPeakOfFrames(
      track.samples,
      track.description,
      track.sampleRate,
      track.numberOfChannels,
    );
    if (peak !== null) return peak;
  }
  // Last resort for a file our reader did not recognise.
  if (typeof OfflineAudioContext === "undefined") return null;
  try {
    // decodeAudioData detaches its input; the export still needs these bytes.
    const copy = bytes.slice(0);
    const decoded = await new OfflineAudioContext(1, 1, MIX_SAMPLE_RATE).decodeAudioData(copy);
    return audioBufferPeak(decoded);
  } catch {
    return null;
  }
}

/**
 * The mix is bounced at 48 kHz because that is the delivery rate for video.
 * The ENCODED result may not be — see `EncodedMp4Audio.sampleRate`.
 */
const MIX_SAMPLE_RATE = 48000;
/** The slice of the progress bar the audio pass owns before frames start. */
const AUDIO_SHARE = 0.08;

/**
 * Encoded audio, in the ONE shape the muxer is fed with — raw frames plus the
 * format they are in. Both rungs below produce it: WebCodecs chunks are copied
 * out, MediaRecorder frames are read out. Unifying here is what stops the
 * muxing site from growing a branch per source, and it is also what forces the
 * sample rate to travel WITH the samples instead of being assumed.
 */
interface EncodedMp4Audio {
  codec: "aac" | "opus";
  sampleRate: number;
  numberOfChannels: number;
  /** AudioSpecificConfig / Opus head, when the encoder supplied one. */
  description: Uint8Array | null;
  samples: Array<{ data: Uint8Array; timestampUs: number; durationUs: number }>;
}

async function audioConfigSupported(codec: string, sampleRate: number, bitrate: number): Promise<boolean> {
  try {
    const s = await AudioEncoder.isConfigSupported({
      codec,
      sampleRate,
      numberOfChannels: 2,
      bitrate,
    });
    return s.supported ?? false;
  } catch {
    return false;
  }
}

/**
 * GET AAC (OR OPUS) FOR THE MUXER — a ladder, because "how does this machine
 * turn a mix into frames?" has three right answers and no way to know which
 * without asking, and because the FIRST question is not about encoders at all.
 *
 *  0. Bounce offline and MEASURE it. The exporter mixes through an
 *     `OfflineAudioContext`, which is a different renderer from the one
 *     playback uses. When those disagree — audible on the timeline, silent in
 *     the file — every stage after this one succeeds on silence: the encoder
 *     encodes it, the muxer writes it, the export reports done. Nothing is
 *     wrong anywhere downstream, so nothing downstream can be fixed. A bounce
 *     that peaks at nothing while the comp claims sound is therefore not a
 *     result; it is a renderer to stop using.
 *  1. WebCodecs AAC over that bounce — every desktop engine, and Safari 26+.
 *     Offline, so it is fast and sample-exact.
 *  2. WebCodecs Opus. Chrome will declare AAC supported and then emit nothing;
 *     Opus-in-MP4 is legal but QuickTime plays it silent, so it is a fallback,
 *     not a peer.
 *  3. Record the LIVE graph as AAC. Reached when there is no `AudioEncoder`
 *     (iPhone and iPad before Safari 26), when the encoders produced nothing,
 *     or when the offline bounce came back silent. It costs one wall-clock
 *     pass and it is the only rung that cannot disagree with playback, because
 *     it IS playback — same context, same nodes, routed to a recorder.
 *
 * Every rung reports what it did, in words, because on the device where this
 * matters most there is no console to read.
 */
async function encodeMp4Audio(
  doc: MotionDocument,
  frameId: string,
  durationMs: number,
  startMs: number,
  bitrate: number,
  capture: "auto" | "live",
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void,
): Promise<{ audio: EncodedMp4Audio | null; report: string; mixPeak: number; mix: AudioBuffer | null }> {
  const notes: string[] = [];

  // Nothing audible in the comp at all — say so and skip every rung. Without
  // this, rung 3 would spend a wall-clock pass recording a silence that is
  // correct, which is a slow way to be right.
  if (!frameHasAudio(doc, frameId)) return { audio: null, report: "No audio in this comp", mixPeak: 0, mix: null };

  // ── 0. The offline bounce, and whether to believe it ──────────────────────
  // Asked for the recorded route directly: don't render a mix nobody will use.
  let bounce: AudioBuffer | null = null;
  let bouncePeak = 0;
  if (capture === "live") notes.push("recording requested");
  // 48 kHz is the delivery rate for video and the right thing to ask for. But
  // an offline renderer asked for a rate its hardware does not run at has to
  // resample, and that is one of the places a WebKit offline mix has been seen
  // to come back empty. So a silent first bounce is retried at the device's OWN
  // rate before the renderer is written off — if that one has signal the export
  // stays offline, fast and sample-exact.
  //
  // The device's rate is asked for LAZILY, only once 48 kHz has come back
  // empty. Reading it means touching the audio engine, and the engine
  // constructs its context on first touch — a side effect no export that is
  // working should pay for.
  for (let attemptIndex = 0; capture === "auto" && attemptIndex < 2; attemptIndex++) {
    const rate = attemptIndex === 0 ? MIX_SAMPLE_RATE : soundEngine.mixBus()?.ctx.sampleRate;
    if (!rate || (attemptIndex === 1 && rate === MIX_SAMPLE_RATE)) break;
    throwIfAborted(signal);
    try {
      const attempt = await renderCompAudioToBuffer(doc, frameId, durationMs, rate, startMs);
      const peak = audioBufferPeak(attempt);
      if (!bounce || peak > bouncePeak) {
        bounce = attempt;
        bouncePeak = peak;
      }
      if (peak > 0) break;
      notes.push(`offline mix silent at ${rate} Hz`);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw err;
      notes.push(`offline mix failed at ${rate} Hz (${(err as Error)?.name ?? "Error"})`);
    }
  }
  const silentBounce = bounce !== null && bouncePeak <= 0;
  // State the mix level ALWAYS. Reported only on failure, it could not be used
  // to tell "the encoder was fed silence" from "the encoder ate the signal" —
  // which is exactly the question that mattered.
  if (bounce) notes.push(`mix peak ${(bouncePeak * 100).toFixed(0)}%`);

  // ── 1–2. WebCodecs, over a bounce worth encoding ──────────────────────────
  if (bounce && !silentBounce && typeof AudioEncoder !== "undefined") {
    for (const { webCodec, muxCodec } of [
      { webCodec: "mp4a.40.2", muxCodec: "aac" as const },
      { webCodec: "opus", muxCodec: "opus" as const },
    ]) {
      throwIfAborted(signal);
      if (!(await audioConfigSupported(webCodec, bounce.sampleRate, bitrate))) {
        notes.push(`${webCodec} unsupported`);
        continue;
      }
      try {
        const encoded = await encodeAudioChunks(bounce, webCodec, muxCodec, bitrate, signal);
        if (encoded) {
          const bytes = encoded.audio.samples.reduce((n, s) => n + s.data.length, 0);
          const detail = [
            `${encoded.audio.samples.length} frames, ${(bytes / 1024).toFixed(0)} KB`,
            ...encoded.notes,
            ...notes,
          ].join("; ");
          return {
            audio: encoded.audio,
            report: `Audio: WebCodecs ${muxCodec.toUpperCase()} at ${encoded.audio.sampleRate} Hz (${detail})`,
            mixPeak: bouncePeak,
            mix: bounce,
          };
        }
        notes.push(`${webCodec} encoded nothing`);
      } catch (err) {
        if ((err as Error).name === "AbortError") throw err;
        notes.push(`${webCodec} failed`);
      }
    }
  } else if (typeof AudioEncoder === "undefined") {
    notes.push("no WebCodecs AudioEncoder");
  }

  // ── 3. Record the live graph ──────────────────────────────────────────────
  throwIfAborted(signal);
  const recorded = await recordMixAsAac(
    (ctx, dest) => scheduleCompAudioInto(ctx, dest, doc, frameId, durationMs, startMs),
    durationMs,
    bitrate,
    signal,
    onProgress,
  );
  if (recorded.ok) {
    // THROUGH THE SAME DOOR. These frames used to reach the muxer unvalidated,
    // which is why a defect could exist that only this route could hit —
    // WebKit's recorder opens its first fragment 64 samples in, an MP4 track
    // must open at zero, and the export died at the muxer with
    // "received DTS = 0.001333" instead of rescuing anything.
    const track = toMuxableAacTrack(
      recorded.track.samples.map((s) => ({ ...s, durationUs: s.durationUs })),
      recorded.track.sampleRate,
      recorded.track.description,
    );
    if (track) {
      const detail = [
        `${track.frames.length} frames, ${(track.totalBytes / 1024).toFixed(0)} KB`,
        ...track.notes,
        ...notes,
      ].join("; ");
      return {
        audio: {
          codec: "aac",
          sampleRate: track.sampleRate,
          numberOfChannels: track.channels,
          description: track.description,
          samples: track.frames,
        },
        report: `Audio: AAC recorded live at ${track.sampleRate} Hz (${detail})`,
        mixPeak: bouncePeak,
        mix: bounce,
      };
    }
    notes.push("the recording carried no frames");
  } else {
    notes.push(RECORD_FAILURES[recorded.reason]);
  }
  return { audio: null, report: `No audio — ${notes.join("; ")}`, mixPeak: bouncePeak, mix: bounce };
}

/** Plain-language reasons a live recording did not happen. */
const RECORD_FAILURES: Record<RecordFailure, string> = {
  "no-recorder": "this browser can't record AAC",
  "no-audio-context": "no audio context",
  "context-suspended": "the audio context wouldn't start (play something once, then export)",
  "no-data": "the recorder produced no data",
  unreadable: "the recording couldn't be read back",
  cancelled: "cancelled",
};

/**
 * Encode a bounce with WebCodecs, and put what comes back into the shape an
 * MP4 actually requires.
 *
 * The encoder succeeding is not the same as the frames being muxable, and the
 * gap between those two is silent — which is how an export gets to report
 * `WebCodecs AAC, offline mix at 48000 Hz` and still play with no sound. Two
 * things have to be true that a `configure()` call cannot guarantee:
 *
 *  - **The frames are raw.** `AacEncoderConfig.format: "aac"` is asked for
 *    explicitly here, which is the correct and sufficient thing to do on an
 *    engine that honours it. `normalizeAacFrames` checks anyway, because an
 *    engine that ignores it hands back ADTS-framed AAC that the `esds` box
 *    then describes wrongly, and nothing downstream can tell.
 *  - **The samples have durations.** `EncodedAudioChunk.duration` is nullable.
 *    Zero-duration samples make a zero-length track, and a zero-length track
 *    is silent no matter how good the audio inside it is.
 *
 * Returns null when the encoder produced nothing, so the ladder falls through.
 */
async function encodeAudioChunks(
  buffer: AudioBuffer,
  codec: string,
  muxCodec: "aac" | "opus",
  bitrate: number,
  signal?: AbortSignal,
): Promise<{ audio: EncodedMp4Audio; notes: string[] } | null> {
  let encoderError: Error | null = null;
  const raw: Array<{ data: Uint8Array; timestampUs: number; durationUs: number | null }> = [];
  let description: Uint8Array | null = null;
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => {
      const desc = meta?.decoderConfig?.description;
      if (desc && !description) description = copyBytes(desc);
      // COPY THE BYTES, AND CHECK THAT ANY CAME OUT.
      //
      // The one thing four rounds of this bug never measured. A chunk that
      // reports its count and its timing correctly but carries NO PAYLOAD
      // produces a file that is right in every observable way and silent: the
      // frame count matches the project length, the durations are real, the
      // container validates, Apple's own decoder opens it — and every packet
      // in it is empty. `byteLength`/`copyTo` are the only step here that can
      // fail without saying anything, so they are the only step left that can
      // explain a file where nothing else is wrong.
      const data = new Uint8Array(chunk.byteLength);
      try {
        chunk.copyTo(data);
      } catch {
        // A chunk that will not surrender its bytes is not a frame.
        return;
      }
      if (data.length === 0) return;
      raw.push({ data, timestampUs: chunk.timestamp, durationUs: chunk.duration ?? null });
    },
    error: (e) => {
      encoderError = e instanceof Error ? e : new Error(String(e));
    },
  });
  const sampleRate = buffer.sampleRate;
  audioEncoder.configure({
    codec,
    sampleRate,
    numberOfChannels: 2,
    bitrate,
    // Say which framing we want. An MP4 stores raw frames and describes them
    // once in `esds`; ADTS repeats the description on every frame and belongs
    // in a stream, not a container.
    ...(muxCodec === "aac" ? { aac: { format: "aac" as const } } : {}),
  });

  try {
    const total = buffer.length;
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    const chunkFrames = sampleRate; // 1s per AudioData
    for (let offset = 0; offset < total; offset += chunkFrames) {
      throwIfAborted(signal);
      if (encoderError) throw encoderError;
      const frames = Math.min(chunkFrames, total - offset);
      const planar = new Float32Array(frames * 2);
      planar.set(left.subarray(offset, offset + frames), 0);
      planar.set(right.subarray(offset, offset + frames), frames);
      const data = new AudioData({
        format: "f32-planar",
        sampleRate,
        numberOfFrames: frames,
        numberOfChannels: 2,
        timestamp: Math.round((offset / sampleRate) * 1_000_000),
        data: planar,
      });
      audioEncoder.encode(data);
      data.close();
      while (audioEncoder.encodeQueueSize > 4) await yieldToUi();
    }
    await audioEncoder.flush();
    if (encoderError) throw encoderError;
    if (raw.length === 0) return null;

    // An AAC frame at any usable bitrate is tens to hundreds of bytes. A
    // stream averaging less than a handful is not audio that happens to be
    // quiet — it is an encoder whose output never reached us, and muxing it
    // would produce exactly the well-formed silent file this is here to stop.
    // Returning null drops to the next rung, which records the live graph.
    const payloadBytes = raw.reduce((n, c) => n + c.data.length, 0);
    if (payloadBytes < raw.length * 8) {
      console.warn(
        `[${identity.ns}] ${codec} reported ${raw.length} chunks carrying only ${payloadBytes} bytes — ` +
          `treating as no output`,
      );
      return null;
    }

    const notes: string[] = [];
    if (muxCodec === "aac") {
      // ONE DOOR. Every invariant an MP4 audio track has to satisfy — bytes,
      // framing, durations, a track that opens at zero, and a format read from
      // the bitstream rather than from the request — lives in core and applies
      // to BOTH sources of frames. See `toMuxableAacTrack`.
      const track = toMuxableAacTrack(raw, sampleRate, description);
      if (!track) return null;
      notes.push(...track.notes);

      // ── DOES THE ENCODER'S OWN OUTPUT STILL HAVE THE AUDIO IN IT? ────────
      //
      // The mix has a level, the encoder returns correctly-timed frames, and
      // the container is provably fine (Apple's own decoder reads it) — so if
      // the file is still silent, the signal was lost BETWEEN the mix and the
      // frames, and nothing downstream can find that. An encoder is the one
      // component here that can be asked to prove itself: decode its output
      // and listen. `AudioDecoder` ships wherever `AudioEncoder` does.
      const encodedPeak = await decodedPeakOfFrames(
        track.frames,
        track.description,
        track.sampleRate,
        track.channels,
      );
      if (encodedPeak !== null) notes.push(`encoded peak ${(encodedPeak * 100).toFixed(0)}%`);
      // Silent output from a mix that was NOT silent is the encoder losing the
      // signal. Returning null drops to the rung that records the live graph.
      if (encodedPeak !== null && encodedPeak <= 0.0005) {
        console.warn(`[${identity.ns}] the AAC encoder's own output decodes silent — falling through`);
        return null;
      }
      return {
        audio: {
          codec: "aac",
          sampleRate: track.sampleRate,
          numberOfChannels: track.channels,
          description: track.description,
          samples: track.frames,
        },
        notes,
      };
    }

    // Opus in MP4 is the degraded fallback and only Chrome reaches it, but a
    // sample still needs a length: 20 ms is Opus's default frame.
    return {
      audio: {
        codec: "opus",
        sampleRate,
        numberOfChannels: 2,
        description,
        samples: raw.map((c) => ({ ...c, durationUs: c.durationUs || 20_000 })),
      },
      notes,
    };
  } finally {
    if (audioEncoder.state !== "closed") audioEncoder.close();
  }
}

type MuxerCtor = typeof import("mp4-muxer").Muxer;
type TargetCtor = typeof import("mp4-muxer").ArrayBufferTarget;

interface ProveAudioInput {
  doc: MotionDocument;
  frameId: string;
  durationMs: number;
  startMs: number;
  bitrate: number;
  capture: "auto" | "live";
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/**
 * SETTLE THE AUDIO TRACK BEFORE ANY VIDEO IS DRAWN.
 *
 * The candidate frames are muxed into a throwaway audio-only MP4, read back
 * with our own reader, decoded, and measured against the mix that produced
 * them. That is the same question the finished export asks — "does this file
 * sound like its mix?" — asked at the point where the answer is still cheap.
 *
 * Why here rather than at the end: the audio is the only part of this export
 * that fails, and it is by far the smallest. Asking afterwards meant repairing
 * a four-second soundtrack by re-encoding a minute of video. Asking first makes
 * a failed candidate cost a few hundred milliseconds, and means the video pass
 * runs exactly once no matter which route the sound ends up taking.
 *
 * The audio-only file is a faithful rehearsal: same muxer, same track config,
 * same frames, same reader. The only thing it leaves out is the video track,
 * which is the one part already known to be fine.
 */
async function proveAudioTrack(
  Muxer: MuxerCtor,
  ArrayBufferTarget: TargetCtor,
  input: ProveAudioInput,
): Promise<{ audio: EncodedMp4Audio | null; report: string; loudness: MixLoudness | null }> {
  // The loudness of the mix the track carries: its offline bounce, which is the
  // mix (a recorded track is the same graph played live). A bounce that came
  // back silent while the file has sound is a renderer that failed here, and
  // that mix is not known: null.
  const loudnessOf = (t: { mix: AudioBuffer | null; peak: number | null; audio: EncodedMp4Audio | null }): MixLoudness | null => {
    if (!t.audio) return null;
    const measured = t.mix ? measureMix(t.mix) : null;
    if (measured && !("silent" in measured)) return measured;
    return (t.peak ?? 0) > 0 ? null : { silent: true };
  };
  const attempt = async (capture: "auto" | "live") => {
    const encoded = await encodeMp4Audio(
      input.doc,
      input.frameId,
      input.durationMs,
      input.startMs,
      input.bitrate,
      capture,
      input.signal,
      input.onProgress,
    );
    if (!encoded.audio) return { ...encoded, peak: null as number | null };
    const rehearsal = new Muxer({
      target: new ArrayBufferTarget(),
      audio: {
        codec: encoded.audio.codec,
        numberOfChannels: encoded.audio.numberOfChannels,
        sampleRate: encoded.audio.sampleRate,
      },
      fastStart: "in-memory",
    });
    addAudioTrack(rehearsal, encoded.audio);
    rehearsal.finalize();
    const peak = await decodedAudioPeak((rehearsal.target as ArrayBufferTargetType).buffer);
    return { ...encoded, peak };
  };

  const first = await attempt(input.capture);
  // A file has to sound like the mix that made it. "Not digital silence" is too
  // weak a test when the level going in is known; nothing in this pipeline
  // legitimately attenuates by 12 dB.
  const failed =
    first.audio !== null &&
    first.peak !== null &&
    first.mixPeak > 0 &&
    first.peak < first.mixPeak * 0.25;

  if (!failed || input.capture === "live") {
    return {
      audio: first.audio,
      report: first.audio ? `${first.report}${peakNote(first.peak)}` : first.report,
      loudness: loudnessOf(first),
    };
  }

  // The encoded route does not survive muxing on this engine. Recording the
  // live graph does. Costs one wall-clock pass over the sound — and nothing at
  // all of the picture, which has not been touched yet.
  console.warn(`[${identity.ns}] the encoded audio does not survive muxing here — recording the sound instead`);
  const second = await attempt("live");
  if (!second.audio) return { audio: first.audio, report: `${first.report}${peakNote(first.peak)}`, loudness: loudnessOf(first) };
  return {
    audio: second.audio,
    loudness: loudnessOf(second),
    report:
      `${second.report}${peakNote(second.peak)} — the encoded mix muxed at ` +
      `${pct(first.peak)} against a ${pct(first.mixPeak)} mix, so the sound was recorded instead`,
  };
}

const pct = (value: number | null) => (value === null ? "?" : `${(value * 100).toFixed(0)}%`);
const peakNote = (peak: number | null) =>
  peak === null ? ", playback here could not be verified" : `, verified ${pct(peak)} peak`;

/** Write an encoded track's frames into a muxer, description on the first. */
function addAudioTrack(muxer: InstanceType<MuxerCtor>, audio: EncodedMp4Audio): void {
  // The description rides the FIRST sample, exactly as WebCodecs metadata
  // would — the muxer can synthesise one, but the encoder's own is the truth.
  const meta: EncodedAudioChunkMetadata | undefined = audio.description
    ? {
        decoderConfig: {
          codec: audio.codec === "aac" ? "mp4a.40.2" : "opus",
          numberOfChannels: audio.numberOfChannels,
          sampleRate: audio.sampleRate,
          description: audio.description,
        },
      }
    : undefined;
  audio.samples.forEach((s, i) =>
    muxer.addAudioChunkRaw(s.data, "key", s.timestampUs, s.durationUs, i === 0 ? meta : undefined),
  );
}

/**
 * Decode encoded AAC frames and report the loudest sample in them.
 *
 * The encoder proving its own work. Returns null when this engine has no
 * `AudioDecoder`, or the config is refused, or nothing came back — none of
 * which is evidence of anything, so none of which changes the export. Only a
 * decode that SUCCEEDS and comes back flat is a verdict.
 */
async function decodedPeakOfFrames(
  frames: Array<{ data: Uint8Array; timestampUs: number; durationUs: number }>,
  description: Uint8Array | null,
  sampleRate: number,
  numberOfChannels: number,
): Promise<number | null> {
  if (typeof AudioDecoder === "undefined" || frames.length === 0) return null;
  const config: AudioDecoderConfig = {
    codec: "mp4a.40.2",
    sampleRate,
    numberOfChannels,
    ...(description ? { description } : {}),
  };
  try {
    const { supported } = await AudioDecoder.isConfigSupported(config);
    if (!supported) return null;
  } catch {
    return null;
  }

  let peak = 0;
  let decoded = 0;
  let failed = false;
  const decoder = new AudioDecoder({
    output: (data) => {
      decoded++;
      try {
        const scratch = new Float32Array(data.numberOfFrames);
        // Plane 0 is enough: a mix silent in one channel and loud in the other
        // is not a failure mode any of this can produce.
        data.copyTo(scratch, { planeIndex: 0, format: "f32-planar" });
        for (let i = 0; i < scratch.length; i++) {
          const v = scratch[i]! < 0 ? -scratch[i]! : scratch[i]!;
          if (v > peak) peak = v;
        }
      } catch {
        failed = true;
      } finally {
        data.close();
      }
    },
    error: () => {
      failed = true;
    },
  });
  try {
    decoder.configure(config);
    for (const frame of frames) {
      if (failed) break;
      decoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: frame.timestampUs,
          duration: frame.durationUs,
          data: frame.data,
        }),
      );
    }
    await decoder.flush();
  } catch {
    return null;
  } finally {
    if (decoder.state !== "closed") decoder.close();
  }
  return failed || decoded === 0 ? null : peak;
}

/** A detached copy of a WebCodecs description, whichever shape it arrives in. */
function copyBytes(source: AllowSharedBufferSource): Uint8Array {
  const view = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
  return new Uint8Array(view); // copy: the encoder may reuse its buffer
}

// ── Realtime capture (MediaRecorder — the broad-compat fallback) ─────────────

/**
 * WHAT THIS RECORDER CAN ACTUALLY WRITE — asked, not assumed.
 *
 * This used to probe three WebM types and, when all three failed, hand
 * MediaRecorder `undefined` and label whatever came back as `video/webm` in a
 * `.webm` file. On Safari all three DO fail — WebKit's MediaRecorder writes
 * MP4, not WebM — so an iPhone export produced an MP4 wearing a WebM name and
 * a WebM mime type, which iOS then refused to open. The format the user was
 * told to choose "for sound" was the one that could not be played at all.
 *
 * So: probe MP4 too, and take the container from `recorder.mimeType` rather
 * than from what we hoped for. WebM stays first because it is what every
 * engine that has it prefers and what desktop users already have; MP4 is the
 * rung underneath, and it is the one Safari lands on.
 */
const REALTIME_TYPES = {
  video: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4;codecs=avc1", "video/mp4"],
  av: [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4",
  ],
} as const;

function pickRealtimeMimeType(withAudio: boolean): string {
  if (typeof MediaRecorder === "undefined") return "";
  return REALTIME_TYPES[withAudio ? "av" : "video"].find((c) => MediaRecorder.isTypeSupported(c)) ?? "";
}

/** The container a realtime capture would land in on this engine, or null when
 *  it cannot record at all. Drives the export panel's format label, so the
 *  button never promises an extension the browser will not produce. */
export function realtimeContainer(withAudio: boolean): "webm" | "mp4" | null {
  const mime = pickRealtimeMimeType(withAudio);
  if (!mime) return typeof MediaRecorder === "undefined" ? null : "webm";
  return mime.startsWith("video/mp4") ? "mp4" : "webm";
}

/** `video/mp4;codecs=…` → `mp4`. The file's name has to match its insides. */
function containerExtension(mimeType: string): "webm" | "mp4" {
  return /^video\/mp4/i.test(mimeType) ? "mp4" : "webm";
}

export async function exportWebm(
  doc: MotionDocument,
  frame: Frame,
  options: VideoExportOptions = {},
): Promise<"webm" | "mp4"> {
  const durationMs = exportSpan(doc, frame, options);
  const start = exportStartMs(options);
  const fps = outputFps(doc, frame, options);

  const [canvas, ctx] = makeScaledCanvas(frame, options, { opaque: true });
  // Realtime capture can't await per-frame; warm the static assets up front so
  // the recording never opens on a blank flash.
  options.onReadiness?.(await prepareDocumentForExport(doc, frame));
  drawExportFrame(ctx, doc, frame, start, options);

  const stream = canvas.captureStream(fps);

  /**
   * Optional audio: synth cues + imported media, mixed into the recording.
   *
   * Through the app's OWN context, not a fresh one. iOS only lets an
   * `AudioContext` make sound after a user gesture has unlocked it, and by the
   * time this runs — several awaits after the click that started the export —
   * a newly constructed context starts suspended and records silence. The
   * engine's context has been unlocked since the first sound the app played.
   *
   * It is borrowed, never closed: the mix node is disconnected at the end and
   * the stream's tracks are stopped, but closing the shared context would take
   * the editor's audio down with it for the rest of the session.
   */
  let mixOut: { master: GainNode; dest: MediaStreamAudioDestinationNode } | null = null;
  if (options.includeAudio) {
    const bus = soundEngine.mixBus();
    if (bus) {
      if (bus.ctx.state === "suspended") await bus.ctx.resume().catch(() => undefined);
      const dest = bus.ctx.createMediaStreamDestination();
      const master = bus.ctx.createGain();
      master.connect(dest);
      await scheduleCompAudioInto(bus.ctx, master, doc, frame.id, durationMs, start);
      for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
      mixOut = { master, dest };
    }
  }

  const mimeType = pickRealtimeMimeType(!!options.includeAudio && mixOut !== null);
  const recorder = new MediaRecorder(stream, {
    mimeType: mimeType || undefined,
    videoBitsPerSecond:
      options.videoBitrate ?? qualityBitrate(options.quality, canvas.width, canvas.height, fps),
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);

  const done = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  recorder.start(250);
  const startWall = performance.now();

  await new Promise<void>((resolve, reject) => {
    const frameLoop = () => {
      if (options.signal?.aborted) {
        reject(new DOMException("Export cancelled", "AbortError"));
        return;
      }
      const elapsed = performance.now() - startWall;
      const t = Math.min(elapsed, durationMs);
      // Realtime capture: videos PLAY (force past any stepped-export lock).
      syncVideoFrames(doc, frame, start + t, true, true);
      drawExportFrame(ctx, doc, frame, start + t, options);
      options.onFrame?.(canvas, start + t);
      options.onProgress?.(t / durationMs);
      if (elapsed >= durationMs) resolve();
      else requestAnimationFrame(frameLoop);
    };
    requestAnimationFrame(frameLoop);
  }).finally(() => {
    recorder.stop();
    mixOut?.master.disconnect();
    for (const track of mixOut?.dest.stream.getAudioTracks() ?? []) track.stop();
  });

  await done;
  // `recorder.mimeType` is what was RECORDED — the requested type when it was
  // honoured, and the engine's own choice when we had to pass none. Naming the
  // blob and the file from it is the difference between a playable export and
  // an MP4 called `.webm` that nothing will open.
  const recordedType = recorder.mimeType || mimeType || "video/webm";
  const ext = containerExtension(recordedType);
  saveFile(options, new Blob(chunks, { type: recordedType }), `${fileBase(doc, frame, options)}.${ext}`);
  return ext;
}

// ── GIF (animated, quantized — the share-anywhere format) ────────────────────

export function exportGif(
  doc: MotionDocument,
  frame: Frame,
  options: VideoExportOptions = {},
): Promise<void> {
  return withRenderKeepAlive(() => runGifExport(doc, frame, options));
}

async function runGifExport(
  doc: MotionDocument,
  frame: Frame,
  options: VideoExportOptions,
): Promise<void> {
  // gifenc loads on demand — nobody pays for the GIF encoder until they use it.
  const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
  const durationMs = exportSpan(doc, frame, options);
  const start = exportStartMs(options);
  const fps = outputFps(doc, frame, options);
  const frameCount = Math.max(1, Math.round((durationMs / 1000) * fps));
  const [canvas, ctx] = makeScaledCanvas(frame, options);
  const delay = Math.max(2, Math.round(100 / fps)); // GIF delays are centiseconds
  const gif = GIFEncoder();

  const unlock = lockMediaForExport();
  try {
    options.onReadiness?.(await prepareDocumentForExport(doc, frame));
    for (let i = 0; i < frameCount; i++) {
      throwIfAborted(options.signal);
      const t = start + (i / fps) * 1000;
      await prepareVideoFramesForExport(doc, frame, t);
      drawExportFrame(ctx, doc, frame, t, options);
      options.onFrame?.(canvas, t);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // Transparent exports quantize with an alpha-aware format + a reserved
      // transparent palette slot; opaque stays on the fast rgb565 path.
      if (options.transparent) {
        const palette = quantize(data, 255, { format: "rgba4444" });
        const index = applyPalette(data, palette, "rgba4444");
        const transparentIndex = palette.length;
        (palette as number[][]).push([0, 0, 0, 0]);
        for (let px = 0, ai = 3; px < index.length; px++, ai += 4) {
          if (data[ai]! < 128) index[px] = transparentIndex;
        }
        gif.writeFrame(index, canvas.width, canvas.height, {
          palette,
          delay,
          transparent: true,
          transparentIndex,
          dispose: 2,
        });
      } else {
        const palette = quantize(data, 256);
        const index = applyPalette(data, palette);
        gif.writeFrame(index, canvas.width, canvas.height, { palette, delay });
      }
      options.onProgress?.((i + 1) / frameCount);
      await yieldIfDue();
    }
  } finally {
    unlock();
  }
  gif.finish();
  saveFile(options, 
    new Blob([gif.bytes() as BlobPart], { type: "image/gif" }),
    `${fileBase(doc, frame, options)}.gif`,
  );
}

// ── Audio only (the bounce as a WAV) ─────────────────────────────────────────

export async function exportAudioOnly(
  doc: MotionDocument,
  frame: Frame,
  options: VideoExportOptions = {},
): Promise<{ report: string; loudness: MixLoudness }> {
  const durationMs = exportSpan(doc, frame, options);
  const start = exportStartMs(options);
  const buffer = await renderCompAudioToBuffer(doc, frame.id, durationMs, MIX_SAMPLE_RATE, start);
  options.onProgress?.(1);
  saveFile(options, audioBufferToWav(buffer), `${fileBase(doc, frame, options)}.wav`);
  // WAV is the offline mix and nothing else — no encoder, no muxer, no video.
  // So a silent WAV out of a comp that has sound points at exactly one thing,
  // and it is worth saying: this is the fastest way to tell a broken renderer
  // apart from a broken encoder.
  const peak = audioBufferPeak(buffer);
  const loudness = measureMix(buffer);
  if (peak <= 0 && frameHasAudio(doc, frame.id)) {
    return { report: "The mix rendered silent on this device — the offline renderer, not the encoder", loudness };
  }
  return { report: `Audio: offline mix at ${buffer.sampleRate} Hz, peak ${(peak * 100).toFixed(0)}%`, loudness };
}
