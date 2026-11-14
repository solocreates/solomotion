import {
  applyRenderInPlace,
  canRenderClipInPlace,
  carryContainer,
  clipAudioSignature,
  clipFrameBounds,
  clipHasSound,
  cloneClip,
  compFps,
  createAsset,
  createAssetAudioClip,
  createId,
  createImageClip,
  createTrack,
  createVideoClip,
  expandToDescendants,
  forgetRenderInPlace,
  gcOrphanNestedSources,
  locateClip,
  originalAssets,
  renderInPlaceMeta,
  renderInputSignature,
  revertRenderInPlace,
  SEQUENCE_MIME,
  subtreeRows,
  type Asset,
  type MotionDocument,
  type AudioClip,
  type Clip,
  type DocumentStore,
  type Frame,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import { deleteAssetBlob, getAssetBlob, putAssetBlob } from "../assets/asset-store";
import { releaseAssetBytes } from "../assets/release-bytes";
import { packSequence, verifySequence } from "../assets/sequence-file";
import { audioBufferToWav, renderCompAudioToBuffer } from "../export/export-audio";
import { exportMp4, renderFrameSequence, sequenceFrameCount, withRenderKeepAlive } from "../export/export-media";
import { dropSequence } from "../stage/render/media-cache";
import { ENGINE } from "@/editor/names";

/**
 * RENDER IN PLACE — any layer becomes MEDIA in its own slot, and comes back.
 *
 * The result is ordinary footage in the media library ("Renders" folder): an
 * IMAGE SEQUENCE (WebP — transparent, near-lossless and a fraction of PNG's
 * size, the default for anything drawn — or PNG when it must be lossless) or a
 * VIDEO (MP4, opaque — the default for footage that fills the frame). A layer
 * with sound gets its sound baked beside it, linked. The original — a group
 * with all its rows, a nested clip with its comp — waits in the ledger, and
 * "Switch to original" puts it back exactly (see core `revertRenderInPlace`,
 * which also carries over anything done to the render meanwhile).
 *
 * THE SAFETY CONTRACT, in order, and why nothing here can lose work:
 *  1. The render reads a FROZEN copy of the document. You keep editing.
 *  2. Nothing is written — not the document, not storage — until every frame
 *     exists. A cancel or a crash leaves nothing behind.
 *  3. The file is written, then READ BACK and checked. A bad write is deleted
 *     and reported; the original was never touched.
 *  4. Only then does the layer change, in ONE undo step — and only if the
 *     layer is still what was rendered. Edited meanwhile, the render is thrown
 *     away and you are asked, rather than handed a stale picture.
 *  5. The original is deleted (when you asked for that) LAST, after 1–4.
 *
 * Renders queue, one at a time, and a sequence render takes about ¾ of the
 * main thread so the editor stays usable while it runs.
 */

/** PNG: lossless, transparent. WebP: transparent and several times smaller. Video: opaque. */
export type RenderFormat = "png" | "webp" | "video";

const SEQUENCE_ENCODING: Record<Exclude<RenderFormat, "video">, { type: string; quality?: number }> = {
  png: { type: "image/png" },
  webp: { type: "image/webp", quality: 0.95 },
};
export type RenderScale = 1 | 0.5 | 0.25;

export interface RenderInPlaceSettings {
  format: RenderFormat;
  scale: RenderScale;
  keepOriginal: boolean;
}

/** What the dialog shows before anything runs. */
export interface RenderInPlacePlan {
  clipId: string;
  name: string;
  kind: "picture" | "sound";
  /** The comp the layer is rendered at — the picture's full size. */
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationMs: number;
  /** Bytes of media the original reads — what "don't keep" frees. */
  originalBytes: number;
  /** Where the dialog starts: a sequence keeps transparency; video only when
   *  the layer is footage filling the frame, so nothing beneath is lost. */
  defaultFormat: RenderFormat;
  rerender: boolean;
}

/**
 * The original is kept unless IT is heavy. Deleting it only ever frees the
 * original's own media, so a few shapes or a light nested comp — which weigh
 * almost nothing — always keep their way back, however large the render is.
 */
const HEAVY_ORIGINAL_BYTES = 512 * 1024 ** 2;
/** Rough bytes per pixel per frame, on real motion-design frames (mostly empty alpha). */
const BYTES_PER_PIXEL: Record<RenderFormat, number> = { png: 0.5, webp: 0.08, video: 0.06 };
/** 48 kHz stereo 16-bit. */
const WAV_BYTES_PER_SEC = 48000 * 2 * 2;
/** Of each frame's time, the share a background render takes. */
const BACKGROUND_SHARE = 0.75;
const RENDERS_FOLDER = "Renders";

export function canRenderInPlace(doc: MotionDocument, clip: Clip): boolean {
  return canRenderClipInPlace(doc, clip);
}

/** Rendered, with an original to go back to. */
export function hasOriginal(doc: MotionDocument, clip: Clip): boolean {
  return clip.id in doc.renderedClips;
}

export function planRenderInPlace(doc: MotionDocument, clipId: string): RenderInPlacePlan | null {
  const clip = locateClip(doc, clipId)?.clip;
  if (!clip || !canRenderInPlace(doc, clip)) return null;
  const meta = renderInPlaceMeta(doc, clipId);
  const original = meta?.originalSnapshot ?? clip;
  const bytesOf = (ids: Set<string>) => doc.assets.filter((a) => ids.has(a.id)).reduce((n, a) => n + a.bytes, 0);
  const originalBytes = bytesOf(originalAssets(doc, { originalSnapshot: original, rows: meta?.rows ?? subtreeRows(doc, original) }));
  const frame = doc.frames.find((f) => f.id === clip.frameId);
  if (!frame) return null;
  const fps = renderFps(doc, original, frame);
  const base = { clipId, name: original.name, width: frame.width, height: frame.height, fps, originalBytes, rerender: !!meta };
  if (clip.kind === "audio") {
    return { ...base, kind: "sound", frames: 0, durationMs: clip.durationMs, defaultFormat: "webp" };
  }
  return {
    ...base,
    kind: "picture",
    frames: sequenceFrameCount(doc, frame, { durationMs: clip.durationMs, fps }),
    durationMs: clip.durationMs,
    defaultFormat: fillsFrameOpaquely(doc, original, frame) ? "video" : "webp",
  };
}

export function estimateRenderBytes(plan: RenderInPlacePlan, settings: Pick<RenderInPlaceSettings, "format" | "scale">): number {
  if (plan.kind === "sound") return (plan.durationMs / 1000) * WAV_BYTES_PER_SEC;
  const px = plan.width * plan.height * settings.scale * settings.scale;
  return px * plan.frames * BYTES_PER_PIXEL[settings.format];
}

export function defaultKeepOriginal(plan: RenderInPlacePlan): boolean {
  return plan.originalBytes < HEAVY_ORIGINAL_BYTES;
}

/** A layer on its own frame rate renders at that rate — no frames it never shows. */
function renderFps(doc: MotionDocument, clip: Clip, frame: Frame): number {
  return (clip.kind !== "audio" && clip.fps) || compFps(doc, frame.id);
}

/** Footage covering the whole frame, fully opaque — the one case where an
 *  opaque video render hides nothing that was visible before. */
function fillsFrameOpaquely(doc: MotionDocument, clip: Clip, frame: Frame): boolean {
  if (clip.kind !== "video" || clip.opacity < 1 || clip.blendMode !== "normal" || clip.keyframes.length > 0) return false;
  const b = clipFrameBounds(doc, clip);
  if (!b) return false;
  const hw = frame.width / 2;
  const hh = frame.height / 2;
  return b.minX <= -hw + 0.5 && b.minY <= -hh + 0.5 && b.maxX >= hw - 0.5 && b.maxY >= hh - 0.5;
}

let queue: Promise<void> = Promise.resolve();

/** Queue a render. Resolves when it has finished, failed or been cancelled. */
export function renderClipInPlace(store: DocumentStore, clipId: string, settings: RenderInPlaceSettings): Promise<void> {
  const job = queue.then(() => withRenderKeepAlive(() => runJob(store, clipId, settings)));
  queue = job.catch(() => undefined);
  return job;
}

async function runJob(store: DocumentStore, clipId: string, settings: RenderInPlaceSettings): Promise<void> {
  const clip = locateClip(store.getState(), clipId)?.clip;
  if (!clip) return;
  const abort = new AbortController();
  const cancel = { label: "Cancel", onClick: () => abort.abort() };
  const status = toast.loading(`Rendering “${clip.name}”…`, { action: cancel });
  const retry = { label: "Retry", onClick: () => void renderClipInPlace(store, clipId, settings) };
  try {
    const done =
      clip.kind === "audio"
        ? await renderSound(store, clipId)
        : await renderPicture(store, clipId, settings, abort.signal, (f) =>
            toast.loading(`Rendering “${clip.name}” · ${Math.round(f * 100)}%`, { id: status, action: cancel }),
          );
    if (done === "changed") {
      toast.warning(`“${clip.name}” changed while rendering`, { id: status, action: { ...retry, label: "Render again" } });
      return;
    }
    if (!settings.keepOriginal) await discardOriginal(store, clipId);
    toast.success(`Rendered “${clip.name}” in place`, { id: status });
  } catch (e) {
    if (abort.signal.aborted) toast(`Render cancelled — “${clip.name}” is untouched`, { id: status });
    else toast.error(`Render failed — “${clip.name}” is untouched`, { id: status, description: (e as Error).message, action: retry });
  }
}

// ── Pictures ─────────────────────────────────────────────────────────────────

/**
 * The frozen input: a copy of the document with the ORIGINAL in the slot (a
 * re-render bakes the original, never a render of it), lifted out of any group
 * so it renders in its slot's own space — the group's look is applied once, by
 * the group, around whatever sits in the slot.
 */
function renderInput(doc: MotionDocument, clipId: string): { doc: MotionDocument; clip: Clip; frame: Frame; only: string[] } | null {
  const copy = structuredClone(doc);
  if (renderInPlaceMeta(copy, clipId)) revertRenderInPlace(copy, clipId, { carryEdits: false });
  const loc = locateClip(copy, clipId);
  const frame = loc ? copy.frames.find((f) => f.id === loc.clip.frameId) : undefined;
  if (!loc || !frame) return null;
  loc.track.groupId = null;
  return { doc: copy, clip: loc.clip, frame, only: [clipId, ...expandToDescendants(copy, [clipId])] };
}

async function renderPicture(
  store: DocumentStore,
  clipId: string,
  settings: RenderInPlaceSettings,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<"done" | "changed"> {
  const before = store.getState();
  const signature = renderInputSignature(before, clipId);
  const input = renderInput(before, clipId);
  if (!signature || !input) throw new Error("This layer can't be rendered in place");
  const { clip, frame } = input;
  const fps = renderFps(input.doc, clip, frame);
  const span = { startMs: clip.startMs, durationMs: clip.durationMs, fps, onlyClipIds: input.only, scale: settings.scale };
  const footage = input.only.some((id) => {
    const c = locateClip(input.doc, id)?.clip;
    return c?.kind === "video" || c?.kind === "nested";
  });

  // 1–2. The whole file, in memory, before anything is written.
  let file: Blob;
  let frameCount = 0;
  if (settings.format !== "video") {
    const encoding = SEQUENCE_ENCODING[settings.format];
    const frames: Blob[] = [];
    await renderFrameSequence(
      input.doc,
      frame,
      { ...span, transparent: true, share: BACKGROUND_SHARE, lockMedia: footage, signal, onProgress },
      async (canvas, i) => {
        const still = await new Promise<Blob | null>((r) => canvas.toBlob(r, encoding.type, encoding.quality));
        if (!still) throw new Error(`Frame ${i + 1} would not encode`);
        frames.push(still);
      },
    );
    frameCount = frames.length;
    file = packSequence(
      { fps, width: Math.round(frame.width * settings.scale), height: Math.round(frame.height * settings.scale) },
      frames,
    );
  } else {
    let delivered: Blob | null = null;
    await exportMp4(input.doc, frame, { ...span, includeAudio: false, signal, onProgress, deliver: (b) => (delivered = b) });
    if (!delivered) throw new Error("The video encoder produced nothing");
    file = delivered;
  }
  const sound = await bakeSound(input.doc, clip, frame, input.only);

  // 3. Written, read back, checked. Everything it wrote goes if any of it fails.
  const asset = createAsset({
    kind: settings.format === "video" ? "video" : "image",
    name: `${clip.name} (rendered)`,
    mime: settings.format === "video" ? "video/mp4" : SEQUENCE_MIME.of(ENGINE.ns),
    bytes: file.size,
    // The picture's SIZE is the comp's, whatever the quality: a half-quality
    // render is fewer pixels drawn over the same box, never a smaller layer.
    width: frame.width,
    height: frame.height,
    durationMs: clip.durationMs,
    fps: settings.format === "video" ? null : fps,
  });
  const written: string[] = [];
  try {
    await putAssetBlob(asset.id, file);
    written.push(asset.id);
    const stored = await getAssetBlob(asset.id);
    const ok =
      !!stored &&
      stored.size === file.size &&
      (settings.format === "video" || (await verifySequence(stored, frameCount)));
    if (!ok) throw new Error("The render didn't save correctly");
    if (sound) {
      await putAssetBlob(sound.asset.id, sound.file);
      written.push(sound.asset.id);
    }
  } catch (e) {
    await Promise.all(written.map((id) => deleteAssetBlob(id)));
    throw e;
  }

  // 4. Still the layer we rendered? Then one undo step.
  if (renderInputSignature(store.getState(), clipId) !== signature) {
    await Promise.all(written.map((id) => deleteAssetBlob(id)));
    return "changed";
  }
  let released: string[] = [];
  store.update("Render in place", (d) => {
    const current = locateClip(d, clipId)?.clip;
    if (!current) return;
    const rendered = renderedClipFor(asset, current, settings.format);
    // A re-render keeps whatever was done to the render it replaces.
    if (d.renderedClips[clipId]) carryContainer(current, rendered);
    const folderId = rendersFolder(d);
    d.assets.push({ ...asset, folderId });
    if (sound) d.assets.push({ ...sound.asset, folderId });
    released = applyRenderInPlace(d, clipId, {
      rendered,
      assetId: asset.id,
      sound: sound ? soundClipFor(sound.asset, current) : null,
      signature,
    });
  });
  await collectAssets(store, released);
  return "done";
}

/** The media clip that takes the slot: full-frame, at identity, playing once. */
function renderedClipFor(asset: Asset, like: Clip, format: RenderFormat): Clip {
  const base = { frameId: like.frameId, assetId: asset.id, startMs: like.startMs, durationMs: like.durationMs };
  const playback = { speed: 1, loop: "none" as const, reverse: false, loopLengthMs: null };
  const clip = format === "video" ? createVideoClip(base) : createImageClip(base);
  clip.name = like.name;
  clip.playback = playback;
  return clip;
}

function soundClipFor(asset: Asset, like: Clip): Clip {
  return createAssetAudioClip({
    frameId: like.frameId,
    assetId: asset.id,
    startMs: like.startMs,
    durationMs: like.durationMs,
    name: `${like.name} sound`,
  });
}

/** The layer's own sound, alone — mixed from a copy holding only it. */
async function bakeSound(
  doc: MotionDocument,
  clip: Clip,
  frame: Frame,
  only: string[],
): Promise<{ asset: Asset; file: Blob } | null> {
  if (!only.some((id) => {
    const c = locateClip(doc, id)?.clip;
    return !!c && (c.kind === "video" ? !c.muted : clipHasSound(doc, c));
  })) {
    return null;
  }
  const keep = new Set(only);
  const alone: MotionDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.frameId !== frame.id || keep.has(c.id)) })),
  };
  const mix = await renderCompAudioToBuffer(alone, frame.id, clip.durationMs, 48000, clip.startMs, { raw: true });
  if (!audible(mix)) return null;
  const file = audioBufferToWav(mix);
  const asset = createAsset({ kind: "audio", name: `${clip.name} sound (rendered)`, mime: "audio/wav", bytes: file.size, durationMs: clip.durationMs });
  return { asset, file };
}

function audible(buffer: AudioBuffer): boolean {
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i += 16) if (Math.abs(data[i]!) > 1e-4) return true;
  }
  return false;
}

/** The media library's "Renders" folder — made the first time it is needed. */
function rendersFolder(d: MotionDocument): string {
  const existing = d.mediaFolders.find((f) => f.parentId === null && f.name === RENDERS_FOLDER);
  if (existing) return existing.id;
  const id = createId("mfolder");
  d.mediaFolders.push({ id, name: RENDERS_FOLDER, parentId: null, linked: null });
  return id;
}

// ── Sound ────────────────────────────────────────────────────────────────────

/** Audio renders as a SWAP: the clip becomes one playing its own baked sound. */
async function renderSound(store: DocumentStore, clipId: string): Promise<"done" | "changed"> {
  const doc = store.getState();
  const signature = renderInputSignature(doc, clipId);
  const meta = renderInPlaceMeta(doc, clipId);
  const current = locateClip(doc, clipId)?.clip;
  // A re-render bakes the ORIGINAL, never the render of it.
  const source = (meta ? meta.originalSnapshot : current) as Clip | undefined;
  if (!signature || !source || source.kind !== "audio" || source.source.type !== "asset") {
    throw new Error("Only imported sound renders in place");
  }
  const buffer = await renderAudioClipBuffer(doc, source);
  const file = audioBufferToWav(buffer);
  const asset = createAsset({ kind: "audio", name: `${source.name} (rendered)`, mime: "audio/wav", bytes: file.size, durationMs: source.durationMs });
  await putAssetBlob(asset.id, file);
  if ((await getAssetBlob(asset.id))?.size !== file.size) {
    await deleteAssetBlob(asset.id);
    throw new Error("The render didn't save correctly");
  }
  if (renderInputSignature(store.getState(), clipId) !== signature) {
    await deleteAssetBlob(asset.id);
    return "changed";
  }
  let released: string[] = [];
  store.update("Render in place", (d) => {
    const now = locateClip(d, clipId)?.clip;
    if (!now) return;
    const rendered = createAssetAudioClip({ frameId: source.frameId, assetId: asset.id, startMs: now.startMs, durationMs: source.durationMs, name: `${source.name} (rendered)` });
    rendered.audioMix = cloneClip(source).audioMix;
    if (source.soundBus) rendered.soundBus = source.soundBus;
    d.assets.push({ ...asset, folderId: rendersFolder(d) });
    released = applyRenderInPlace(d, clipId, { rendered, assetId: asset.id, sound: null, signature: clipAudioSignature(source) });
  });
  await collectAssets(store, released);
  return "done";
}

/** Bake a single audio clip's FULL sound (envelope + EQ + fades + pitch / speed
 * / reverse) to a buffer, by rendering it alone through the export pipeline. */
async function renderAudioClipBuffer(doc: MotionDocument, source: AudioClip): Promise<AudioBuffer> {
  const clip = cloneClip(source) as AudioClip;
  clip.startMs = 0;
  clip.audioMix = { volume: 1, muted: false }; // master stays on the NEW clip
  const track = createTrack("rip");
  track.clips = [clip];
  return renderCompAudioToBuffer({ ...doc, tracks: [track] }, clip.frameId, clip.durationMs, 48000, 0, { raw: true });
}

// ── Keeping, going back ──────────────────────────────────────────────────────

/** "Keep original" off: forget the original and free what only it used. */
async function discardOriginal(store: DocumentStore, clipId: string): Promise<void> {
  let freed: string[] = [];
  store.update("Remove original", (d) => {
    freed = forgetRenderInPlace(d, clipId);
    gcOrphanNestedSources(d);
  });
  await collectAssets(store, freed);
}

/** Back to the original — sound or picture — and collect the render. */
export async function switchToOriginal(store: DocumentStore, clipId: string): Promise<void> {
  let released: string[] = [];
  let wrapped = false;
  store.update("Switch to original", (d) => {
    const result = revertRenderInPlace(d, clipId);
    released = result?.released ?? [];
    wrapped = result?.wrapped ?? false;
  });
  await collectAssets(store, released);
  if (wrapped) toast("Original restored — your changes to the render are on its nested clip");
}

/**
 * The document as it would be with every render switched back — for an export
 * set to re-render from originals. The same revert "Switch to original" runs,
 * on a copy, so the export shows exactly what switching back would.
 */
export function withOriginals(doc: MotionDocument): MotionDocument {
  const copy = structuredClone(doc);
  for (const id of Object.keys(copy.renderedClips)) revertRenderInPlace(copy, id);
  return copy;
}

/**
 * Delete assets nothing refers to any more — from the document and from
 * storage. "Refers to" is answered by the whole document (the render ledger
 * included), not a list of known fields: an id that appears anywhere keeps its
 * bytes. A stray reference costs some storage; a missed one would cost media.
 */
async function collectAssets(store: DocumentStore, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const doc = store.getState();
  const text = JSON.stringify({ ...doc, assets: [] });
  const unused = [...new Set(ids)].filter((id) => !text.includes(id));
  if (unused.length === 0) return;
  store.update("Clean up rendered media", (d) => {
    d.assets = d.assets.filter((a) => !unused.includes(a.id));
  });
  for (const id of unused) dropSequence(id);
  releaseAssetBytes(store, unused);
}
