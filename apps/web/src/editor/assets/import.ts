"use client";

import { BLEND_FILE, explainBlendFile, importModelsAsNestedWorlds, importModelsIntoWorld, isModelFile } from "../world/import";
import { ensureContentFrame } from "../state/clip-actions";
import {
  basisOfTransform,
  CENTER_ANCHOR,
  clipNaturalSize,
  createAsset,
  createId,
  detectImageSequences,
  SEQUENCE_MIME,
  sequenceDurationMs,
  type ImageSequence,
  locateClip,
  mapLocal,
  nestNewClips,
  pruneEmptiedTracks,
  replaceClipInPlace,
  moveClipsToScope,
  VECTOR_SOURCE_TAG,
  reconcileFillClips,
  type Asset,
  type AssetKind,
  type Clip,
  type ImageClip,
  type DocumentStore,
  type MotionDocument,
  compFps,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import { assetsLostAs, clipForAsset, placeClip, type PlaceClipOptions } from "@solomotion/core";
import { ensureAudioBuffer } from "../audio/waveform";
import { useSession } from "../state/session";
import { getAssetBlob, hasAssetBlob, putAssetBlob } from "./asset-store";
import { svgToClips } from "./svg-import";
import { packSequence } from "./sequence-file";
import { ENGINE } from "@/editor/names";

/**
 * File import — the ONE path every drop target and file picker goes through:
 * probe the file's intrinsic metadata, persist the bytes to the blob store,
 * register the asset in the document, and place a ready-made clip. Images,
 * video and audio all ride the same pipeline; SVG currently imports as an
 * image (the vector importer will take that route over).
 */

export function isSvgFile(file: File): boolean {
  return file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
}

/**
 * SVGs without explicit width/height report no intrinsic size to <img> in
 * some browsers — derive them from the viewBox so probing and canvas draws
 * always know the real dimensions.
 */
async function normalizeSvgFile(file: File): Promise<File> {
  try {
    const text = await file.text();
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) return file;
    const explicit = (name: string) => {
      const v = root.getAttribute(name);
      return v !== null && !v.includes("%") && (parseFloat(v) || 0) > 0;
    };
    if (explicit("width") && explicit("height")) return file;
    const vb = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
    const w = vb.length === 4 && vb[2]! > 0 ? vb[2]! : 512;
    const h = vb.length === 4 && vb[3]! > 0 ? vb[3]! : 512;
    root.setAttribute("width", String(w));
    root.setAttribute("height", String(h));
    const out = new XMLSerializer().serializeToString(doc);
    return new File([out], file.name, { type: "image/svg+xml" });
  } catch {
    return file;
  }
}

export function assetKindForFile(file: File): Exclude<AssetKind, "model"> | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  // Some OSes drop files without a mime — fall back to the extension.
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "webp", "gif", "svg", "avif"].includes(ext)) return "image";
  if (["mp4", "webm", "mov", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "aac", "flac"].includes(ext)) return "audio";
  return null;
}

interface ProbeResult {
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

function probeImage(url: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({
        width: img.naturalWidth || 512,
        height: img.naturalHeight || 512,
        durationMs: null,
      });
    img.onerror = () => reject(new Error("Could not decode image"));
    img.src = url;
  });
}

function probeMedia(url: string, kind: "video" | "audio"): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const el = document.createElement(kind);
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      const v = el as HTMLVideoElement;
      resolve({
        width: kind === "video" ? v.videoWidth || null : null,
        height: kind === "video" ? v.videoHeight || null : null,
        durationMs: Number.isFinite(el.duration) ? el.duration * 1000 : null,
      });
      el.src = "";
    };
    el.onerror = () => reject(new Error(`Could not decode ${kind}`));
    el.src = url;
  });
}

/** SHA-256 of a file, hex — what an asset's `sha256` records. */
export async function fingerprint(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The assets these bytes once were, when their own are gone from this device
 * — every byte-less copy of this file, restored under the ids the project
 * already uses (the rule is core's `assetsLostAs`). Returns the copy the
 * project uses most, or null when the file is new here.
 */
async function restoreLostCopies(store: DocumentStore, file: File, kind: AssetKind, sha256: string): Promise<Asset | null> {
  const doc = store.getState();
  const sized = doc.assets.filter((a) => a.bytes === file.size && a.kind === kind);
  if (!sized.length) return null;
  const present = new Set<string>();
  for (const a of sized) if (await hasAssetBlob(a.id)) present.add(a.id);
  let text: string | null = null;
  const uses = (id: string) => (text ??= JSON.stringify(doc)).split(`"${id}"`).length - 1;
  const lost = assetsLostAs(sized, { kind, bytes: file.size, name: file.name, sha256 }, (id) => present.has(id), uses);
  const targets = lost.map((a) => ({ assetId: a.id, kind: a.kind, name: a.name }));
  if (!lost.length || !(await linkFileToAssets(store, targets, file, sha256))) return null;
  return store.getState().assets.find((a) => a.id === lost[0]!.id) ?? null;
}

/** Persist a file's bytes and register it as a document asset. */
export async function importFileAsAsset(store: DocumentStore, file: File): Promise<Asset | null> {
  const kind = assetKindForFile(file);
  if (!kind) return null;
  const sha256 = await fingerprint(file);
  const restored = await restoreLostCopies(store, file, kind, sha256);
  if (restored) return restored;
  if (isSvgFile(file)) file = await normalizeSvgFile(file);

  const url = URL.createObjectURL(file);
  let probe: ProbeResult;
  try {
    probe = kind === "image" ? await probeImage(url) : await probeMedia(url, kind);
  } catch {
    toast.error(`Couldn't read “${file.name}”`);
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }

  const asset = createAsset({
    kind,
    name: file.name,
    mime: file.type || "application/octet-stream",
    bytes: file.size,
    width: probe.width,
    height: probe.height,
    durationMs: probe.durationMs,
  });
  asset.sha256 = sha256;
  await putAssetBlob(asset.id, file);
  // The decoded audio buffer is the ONLY reliable duration for sound — an
  // HTMLMediaElement over-reports it for VBR MP3 (the clip then runs longer than
  // the audio and its waveform "ends sooner"). Decode once at import and let the
  // buffer be ground truth, so clip length, split and waveform all agree.
  if (kind === "audio") {
    const buffer = await ensureAudioBuffer(asset.id).catch(() => null);
    if (buffer && buffer.duration > 0.05) asset.durationMs = Math.round(buffer.duration * 1000);
  }
  store.update("Import asset", (d) => void d.assets.push(asset));
  return asset;
}

export interface ImportTarget {
  frameId: string;
  startMs: number;
  /** Canvas position (frame-center relative) — omit for timeline drops. */
  x?: number;
  y?: number;
  /** Where the created clips land in the track stack (same seam as library drops). */
  placement?: PlaceClipOptions;
}

/**
 * The clip(s) an asset becomes when placed — the ONE rule for "a video always
 * brings its sound."
 *
 * A video imports as ONE clip that owns its own soundtrack. That is the modern
 * convention (Final Cut, CapCut, Premiere's linked clip) and it is the right
 * default: footage is cut picture-first, and a second lane nobody asked for is
 * two things to keep in sync by hand from the very first drop.
 *
 * This used to split every video into a muted picture clip plus a linked audio
 * clip. The split was doing real work — an audio clip has the fader, fades, EQ
 * and waveform a video clip does not — but it was doing it *unasked*, and it
 * was doing it on a probe that only sometimes answered: the split was gated on
 * decoding the whole file, so the same video landed as one clip or two
 * depending on the container, the engine and the timing. One import, two
 * shapes, chosen by chance, is a worse foundation than either shape.
 *
 * So the split became a verb you reach for — `separateClipAudio`, in core,
 * with `rejoinClipAudio` as its exact inverse — and the import has one answer.
 * Non-video assets were always one clip and still are.
 *
 * One asset, one clip — the plural return this used to have existed only to
 * carry the split, so it went with it.
 */
export function buildAssetClip(
  asset: Asset,
  target: ImportTarget,
  frameSize: { width: number; height: number },
): Clip {
  const clip = clipForAsset(asset, target, frameSize);
  // Warm the decode for a video's sound so the waveform strip and the mix are
  // ready by the time the clip is on screen. Deliberately NOT awaited: the
  // placement no longer depends on the answer, and awaiting it was exactly what
  // made a slow or undecodable file change what got created.
  if (clip.kind === "video") void ensureAudioBuffer(asset.id).catch(() => null);
  return clip;
}

/** Where the primary clip's lane resolves — a fixed option, or a resolver that
 *  reads the live doc + the built clip (e.g. "the lane above the selection"). */
type PlacementResolver = PlaceClipOptions | ((doc: MotionDocument, primary: Clip) => PlaceClipOptions | undefined);

/**
 * Place an asset at a target — the single entry point every drop surface and
 * click-to-place uses, so the Media library, the stage, the timeline and the
 * flipbook sheet cannot diverge about what dropping a file creates. Returns the
 * created clip id.
 *
 * Async only because callers already treat it that way; nothing here awaits.
 */
export async function placeAssetClips(
  store: DocumentStore,
  asset: Asset,
  target: ImportTarget,
  frameSize: { width: number; height: number },
  placement?: PlacementResolver,
): Promise<string[]> {
  const clip = buildAssetClip(asset, target, frameSize);
  store.update(`Add ${asset.kind}`, (d) => {
    placeClip(d, clip, typeof placement === "function" ? placement(d, clip) : placement);
  });
  useSession.getState().select([clip.id]);
  return [clip.id];
}

/**
 * Import dropped/picked files and place a clip per file at the target. Files
 * land in sequence (each after the previous one's span) so a multi-drop stays
 * readable on the timeline. Returns the created clip ids.
 */
export async function importFilesAsClips(
  store: DocumentStore,
  files: File[],
  target: ImportTarget,
): Promise<string[]> {
  const created: string[] = [];
  // 3D files: into a world as objects, into a flat comp as a nested world.
  if (files.some((f) => BLEND_FILE.test(f.name))) explainBlendFile();
  const models = files.filter(isModelFile);
  if (models.length) {
    const frame = store.getState().frames.find((f) => f.id === target.frameId);
    if (frame?.world) created.push(...(await importModelsIntoWorld(store, frame.id, models, [target.x ?? 0, 0, -(target.y ?? 0)])));
    else created.push(...(await importModelsAsNestedWorlds(store, target, models)));
  }
  const media = files.filter((f) => assetKindForFile(f) !== null);
  if (media.length === 0) return created;
  let at = target.startMs;

  // DaVinci-style image-sequence detection: a batch of sequentially-named raster
  // images collapses into ONE playable clip + a media-library folder. SVGs are
  // excluded (they import as individual editable vector clips).
  const rasterImages = media.filter((f) => assetKindForFile(f) === "image" && !isSvgFile(f));
  const scan = detectImageSequences(rasterImages.map((f) => f.name));
  const inSequence = new Set(scan.sequences.flatMap((s) => s.files));
  for (const seq of scan.sequences) {
    const seqFiles = seq.files
      .map((name) => rasterImages.find((f) => f.name === name))
      .filter((f): f is File => f !== undefined);
    const res = await importImageSequence(store, seqFiles, seq, { ...target, startMs: at });
    if (res) {
      created.push(res.clipId);
      at += res.durationMs;
    }
  }

  for (const file of media.filter((f) => !inSequence.has(f.name))) {
    // SVG imports as ONE image clip — the browser renders the markup natively,
    // so every fill, gradient, mask and stylesheet is pixel-correct. Right-click
    // the clip for "Convert to editable vectors" when you want the paths.
    const asset = await importFileAsAsset(store, file);
    if (!asset) continue;
    const frame = ensureContentFrame(store, target.frameId);

    // A video imports as ONE clip carrying its own sound; "Separate audio"
    // splits it when you want the sound as sound. `buildAssetClip` is the ONE
    // place that rule lives — the same clip every drop/click path creates.
    const clip = buildAssetClip(asset, { ...target, frameId: frame.id, startMs: at }, frame);
    store.update(`Add ${asset.kind}`, (d) => placeClip(d, clip, target.placement));
    created.push(clip.id);
    at = clip.startMs + clip.durationMs;
  }

  if (created.length > 0) {
    useSession.getState().select(created);
    toast(`Imported ${created.length} item${created.length > 1 ? "s" : ""}`);
  }
  return created;
}

/**
 * Import a folder INTO the media library, rebuilt as real media bins: create a
 * folder named after what was dropped/picked (and any nested subfolders), then
 * import each importable file into the folder it came from. Loose (non-foldered)
 * files land in `parentId` with no bin, so a plain multi-file drop is unchanged.
 * Reuses the ONE asset importer — no divergent import logic. Returns the count.
 */
export async function importFolderTree(
  store: DocumentStore,
  files: import("./folder-import").DroppedFile[],
  parentId: string | null,
): Promise<number> {
  const importable = files.filter((f) => assetKindForFile(f.file) !== null);
  if (importable.length === 0) {
    if (files.length) toast.error("Nothing importable in that folder");
    return 0;
  }

  // Build the folder hierarchy from the relative-path prefixes ("" = parentId),
  // then map each file to the folder it belongs in.
  const dirId = new Map<string, string | null>([["", parentId]]);
  const newFolders: { id: string; name: string; parentId: string | null }[] = [];
  const ensureDir = (dirPath: string): string | null => {
    if (dirId.has(dirPath)) return dirId.get(dirPath) as string | null;
    const segs = dirPath.split("/");
    const parentPath = segs.slice(0, -1).join("/");
    const pid = ensureDir(parentPath);
    const id = createId("mfolder");
    dirId.set(dirPath, id);
    newFolders.push({ id, name: segs[segs.length - 1]!, parentId: pid });
    return id;
  };
  const targets = importable.map((f) => ({
    file: f.file,
    folderId: ensureDir(f.relPath.split("/").slice(0, -1).join("/")),
  }));

  if (newFolders.length) {
    store.update("Import folder", (d) => {
      for (const nf of newFolders) d.mediaFolders.push({ ...nf, linked: null });
    });
  }

  // Per folder, so a render's frames become one sequence in the folder they
  // came from.
  let count = 0;
  const byFolder = new Map<string | null, File[]>();
  for (const t of targets) byFolder.set(t.folderId, [...(byFolder.get(t.folderId) ?? []), t.file]);
  for (const [folderId, folderFiles] of byFolder) {
    const assets = await importFilesAsAssets(store, folderFiles);
    count += assets.length;
    if (folderId && assets.length) {
      store.update("Import folder", (d) => {
        for (const asset of assets) {
          const a = d.assets.find((x) => x.id === asset.id);
          if (a) a.folderId = folderId;
        }
      });
    }
  }

  if (count > 0) {
    const rootName = newFolders[0]?.name;
    toast(
      rootName
        ? `Imported ${count} file${count > 1 ? "s" : ""} into “${rootName}”`
        : `Added ${count} file${count > 1 ? "s" : ""} to media`,
    );
  }
  return count;
}

/**
 * Import numbered stills as ONE image-sequence asset — the frames packed into
 * one file with their original bytes (nothing re-encoded), timed at `fps`.
 * It is an image that changes over time, so it is placed, played, trimmed,
 * sped and looped like footage with no special case anywhere. Returns null if
 * the first frame can't be read.
 */
export async function importSequenceAsset(
  store: DocumentStore,
  files: File[],
  name: string,
  fps: number,
): Promise<Asset | null> {
  if (files.length === 0) return null;
  let width: number;
  let height: number;
  try {
    const first = await createImageBitmap(files[0]!);
    width = first.width;
    height = first.height;
    first.close();
  } catch {
    toast.error(`Couldn't read “${files[0]!.name}”`);
    return null;
  }
  const file = packSequence({ fps, width, height }, files);
  const asset = createAsset({
    kind: "image",
    name,
    mime: SEQUENCE_MIME.of(ENGINE.ns),
    bytes: file.size,
    width,
    height,
    durationMs: sequenceDurationMs(files.length, fps),
    fps,
  });
  await putAssetBlob(asset.id, file);
  store.update("Import sequence", (d) => void d.assets.push(asset));
  return asset;
}

/**
 * Files → media, the ONE way: numbered stills become one sequence each, every
 * other file imports as itself. Every surface that brings files in without
 * placing them — the media library, a dropped folder — goes through here, so
 * a render's 400 PNGs never land as 400 library items.
 */
export async function importFilesAsAssets(store: DocumentStore, files: File[]): Promise<Asset[]> {
  const out: Asset[] = [];
  const stills = files.filter((f) => assetKindForFile(f) === "image" && !isSvgFile(f));
  const scan = detectImageSequences(stills.map((f) => f.name));
  const inSequence = new Set(scan.sequences.flatMap((q) => q.files));
  const fps = compFps(store.getState(), useSession.getState().activeFrameId);
  for (const seq of scan.sequences) {
    const seqFiles = seq.files.map((n) => stills.find((f) => f.name === n)).filter((f): f is File => !!f);
    const asset = await importSequenceAsset(store, seqFiles, sequenceName(seq), fps);
    if (asset) out.push(asset);
  }
  for (const file of files) {
    if (inSequence.has(file.name)) continue;
    const asset = await importFileAsAsset(store, file);
    if (asset) out.push(asset);
  }
  return out;
}

/** A detected sequence's display name: `shot [0001-0120].png`. */
function sequenceName(seq: ImageSequence): string {
  const num = (f: string) => f.slice(0, f.length - seq.ext.length).match(/(\d+)$/)?.[1] ?? "";
  return `${seq.base} [${num(seq.files[0]!)}-${num(seq.files.at(-1)!)}]${seq.ext}`;
}

/** Import a detected sequence and place it as one clip at the target. */
async function importImageSequence(
  store: DocumentStore,
  seqFiles: File[],
  seq: ImageSequence,
  target: ImportTarget,
): Promise<{ clipId: string; durationMs: number } | null> {
  // Timed on the grid of the comp it lands in — a sequence dropped into a
  // 12fps sheet plays one image per 12fps frame. Change it in the inspector.
  const asset = await importSequenceAsset(store, seqFiles, sequenceName(seq), compFps(store.getState(), target.frameId));
  if (!asset) return null;
  const frame = ensureContentFrame(store, target.frameId);
  const clip = buildAssetClip(asset, { ...target, frameId: frame.id }, frame);
  store.update("Add sequence", (d) => placeClip(d, clip, target.placement));
  return { clipId: clip.id, durationMs: clip.durationMs };
}

/**
 * Replace the media behind a clip: pick a new file of the same kind, import
 * it as an asset and re-point the clip — timing, transform, keyframes and
 * effects all stay. Works for image, video and imported-audio clips.
 */
export async function replaceClipAsset(store: DocumentStore, clipId: string): Promise<void> {
  const loc = locateClip(store.getState(), clipId);
  if (!loc) return;
  const kind =
    loc.clip.kind === "image" ? "image" : loc.clip.kind === "video" ? "video" : loc.clip.kind === "audio" ? "audio" : null;
  if (!kind) return;

  const input = document.createElement("input");
  input.type = "file";
  input.accept = `${kind}/*`;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (assetKindForFile(file) !== kind) {
      toast.error(`Pick a ${kind} file`);
      return;
    }
    const asset = await importFileAsAsset(store, file);
    if (!asset) return;
    store.update(`Replace ${kind}`, (d) => {
      const l = locateClip(d, clipId);
      if (!l) return;
      if (l.clip.kind === "image" || l.clip.kind === "video") l.clip.assetId = asset.id;
      else if (l.clip.kind === "audio") l.clip.source = { type: "asset", assetId: asset.id };
    });
    toast(`Replaced with “${file.name}”`);
  };
  input.click();
}

/**
 * Relink a missing asset: pick a replacement file and store its bytes under the
 * SAME asset id, so every clip already pointing at this asset recovers at once.
 * This is the recovery path for a references-only bundle opened elsewhere. The
 * asset's technical metadata (size/mime/dimensions/duration) updates to the new
 * file; its name and identity stay.
 */
export function relinkAssetBytes(store: DocumentStore, assetId: string): void {
  const asset = store.getState().assets.find((a) => a.id === assetId);
  if (!asset) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = `${asset.kind}/*`;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (file && (await linkFileToAsset(store, { assetId: asset.id, kind: asset.kind, name: asset.name }, file))) toast.success(`Relinked “${asset.name}”`);
  };
  input.click();
}

/**
 * Point an asset id at a file's bytes — creating the library row if it doesn't
 * exist yet (the orphan-recovery case) or updating it in place (a normal
 * relink). One path for the file-picker "Replace" and drag-drop-onto-a-card.
 * Returns whether the file was accepted.
 */
export function linkFileToAsset(store: DocumentStore, target: LinkTarget, input: File): Promise<boolean> {
  return linkFileToAssets(store, [target], input);
}

type LinkTarget = { assetId: string; kind: AssetKind; name: string };

/** `linkFileToAsset` for several ids at once (copies of one lost file): one probe, one undo step. */
async function linkFileToAssets(store: DocumentStore, targets: LinkTarget[], input: File, sha256?: string): Promise<boolean> {
  const kind = assetKindForFile(input);
  const want = targets[0]!.kind;
  if (!kind || kind !== want) {
    toast.error(`Pick ${want === "audio" ? "an" : "a"} ${want} file`);
    return false;
  }
  const digest = sha256 ?? (await fingerprint(input));
  let file = input;
  if (isSvgFile(file)) file = await normalizeSvgFile(file);

  const url = URL.createObjectURL(file);
  let probe: ProbeResult;
  try {
    probe = kind === "image" ? await probeImage(url) : await probeMedia(url, kind);
  } catch {
    toast.error(`Couldn't read “${file.name}”`);
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }

  for (const t of targets) await putAssetBlob(t.assetId, file);
  store.update("Relink media", (d) => {
    for (const target of targets) {
      const existing = d.assets.find((a) => a.id === target.assetId);
      if (existing) {
        existing.mime = file.type || existing.mime;
        existing.bytes = file.size;
        existing.sha256 = digest;
        existing.width = probe.width ?? existing.width;
        existing.height = probe.height ?? existing.height;
        existing.durationMs = probe.durationMs ?? existing.durationMs;
      } else {
        d.assets.push({
          id: target.assetId,
          kind: target.kind,
          name: target.name || file.name,
          mime: file.type || (target.kind === "video" ? "video/mp4" : target.kind === "audio" ? "audio/mpeg" : "image/png"),
          bytes: file.size,
          sha256: digest,
          width: probe.width,
          height: probe.height,
          durationMs: probe.durationMs,
          fps: null,
          folderId: null,
          origin: null,
        });
      }
    }
  });
  return true;
}

/** Open a file picker and relink `target` to the chosen file. */
export function pickAndLinkFile(store: DocumentStore, target: { assetId: string; kind: AssetKind; name: string }): void {
  const el = document.createElement("input");
  el.type = "file";
  el.accept = `${target.kind}/*`;
  el.onchange = async () => {
    const file = el.files?.[0];
    if (file && (await linkFileToAsset(store, target, file))) toast.success(`Linked “${target.name}”`);
  };
  el.click();
}

/** True when a clip is an image backed by SVG markup (convertible to paths). */
export function isSvgImageClip(doc: { assets: Asset[] }, clip: Clip): boolean {
  if (clip.kind !== "image") return false;
  const asset = doc.assets.find((a) => a.id === clip.assetId);
  return !!asset && (/svg/i.test(asset.mime) || /\.svg$/i.test(asset.name));
}

/**
 * Everything an SVG conversion needs BEFORE it touches the document: the bytes,
 * the shapes, and the image's pose folded onto each path.
 *
 * Split out because the two callers place the result differently — one lays the
 * paths out flat, one wraps them in a vector group — and both must do it in a
 * SINGLE update. Opening an SVG used to run two: "Convert to vectors", then
 * "Open SVG for editing". Undo landed you on a pile of loose paths that was
 * never anyone's intent, and you had to press it twice to get your image back.
 */
export async function buildSvgVectorClips(
  store: DocumentStore,
  clipId: string,
): Promise<{ result: NonNullable<ReturnType<typeof svgToClips>>; clip: ImageClip } | null> {
  const doc = store.getState();
  const loc = locateClip(doc, clipId);
  if (loc?.clip.kind !== "image") return null;
  const clip = loc.clip;
  const asset = doc.assets.find((a) => a.id === clip.assetId);
  if (!asset) return null;
  const blob = await getAssetBlob(asset.id);
  if (!blob) {
    toast.error("The SVG bytes are missing from the media store");
    return null;
  }
  const result = svgToClips(await blob.text(), asset.name, {
    frameId: clip.frameId,
    startMs: clip.startMs,
    durationMs: clip.durationMs,
    x: 0,
    y: 0,
  });
  if (!result) {
    toast.error("No editable vector shapes in this SVG");
    return null;
  }
  // Preserve the image's pose EXACTLY — through core's one local→world map
  // (`basisOfTransform` + `mapLocal`), not a second hand-rolled T·R·S.
  //
  // The hand-rolled one carried x, y, uniform scale and rotation, and silently
  // dropped `scaleY`, both skews and — the visible one — the PIVOT. A layer's
  // position is where its PIVOT sits, so an SVG with a pivot anywhere but the
  // centre had its whole artwork jump by the pivot's offset the moment you
  // opened it for editing: exactly the "converting moves my layer" bug, and the
  // reason converting felt like something being done TO the file rather than
  // the file being opened. Non-uniform scale and skew went the same way.
  //
  // The offsets `svgToClips` produced are in the SVG's own user units measured
  // from the artwork's centre, which IS the image's local box space, so they
  // drop straight into `mapLocal` with nothing to reconcile.
  const nat = clipNaturalSize(doc, clip);
  const basis = nat ? basisOfTransform(clip.transform, nat) : null;
  for (const c of result.clips) {
    if (c.kind !== "path") continue;
    const t = clip.transform;
    const d = basis
      ? mapLocal(c.transform.x, c.transform.y, basis)
      : { x: c.transform.x * t.scale, y: c.transform.y * t.scale };
    c.transform.x = Math.round(t.x + d.x);
    c.transform.y = Math.round(t.y + d.y);
    c.transform.scale = t.scale;
    c.transform.scaleY = t.scaleY;
    c.transform.rotation = t.rotation;
    c.transform.skewX = t.skewX;
    c.transform.skewY = t.skewY;
    // The pieces are new layers about their own art: a centred pivot is the
    // right default, and inheriting the image's fraction would name a point in
    // a box that no longer exists.
    c.transform.anchor = { ...CENTER_ANCHOR };
  }
  return { result, clip };
}

/**
 * Convert an SVG image clip into editable path clips in place: same frame,
 * same timing, same pose. The image clip goes away; the asset stays.
 */
export async function convertSvgImageToVectors(store: DocumentStore, clipId: string): Promise<string | null> {
  const built = await buildSvgVectorClips(store, clipId);
  if (!built) return null;
  const { result } = built;
  store.update("Convert to vectors", (d) => {
    // The paths take the IMAGE's own lane and slot — the first in its place,
    // the rest directly below. Placing them through the generic first-fit
    // scanner instead spread them across whatever lanes happened to be free,
    // which re-ordered the comp, pushed the artwork to the top of the stack and
    // (via carrier auto-prune) took the emptied lane with it. Converting a
    // layer is not permission to rearrange the timeline around it.
    replaceClipInPlace(d, clipId, result.clips);
    if (result.group) moveClipsToScope(d, result.members, result.group.id);
  });
  useSession.getState().select(result.clips.map((c) => c.id));
  toast(`Converted to ${result.clips.length} editable path${result.clips.length > 1 ? "s" : ""}`);
  return result.group?.id ?? null;
}

/**
 * Open an SVG image as an editable VECTOR GROUP: convert it to vector paths and
 * precompose them into their own comp — which is all a vector group is, a
 * nested clip whose inside happens to be artwork.
 *
 * Nothing about the canvas changes. The pixels stay where they were (the pose
 * is carried through core's one local→world map, pivot and all), the SVG stays
 * ONE clip on the parent timeline, and the open timeline is untouched: the only
 * evidence is that the layer now opens in the Layers panel, with a row per
 * piece that carries its own fill, transform, effects and keyframes.
 *
 * The paths fill the comp so they always span the clip's duration (trim it from
 * the parent and they follow). No frame is duplicated; making it a reusable
 * unit is still the explicit Create component / Detach action.
 */
export async function openSvgClipAsVectors(store: DocumentStore, clipId: string): Promise<void> {
  const built = await buildSvgVectorClips(store, clipId);
  if (!built) return;
  const { result, clip } = built;
  const name = clip.name;
  const assetId = clip.assetId;

  let nestedId: string | null = null;
  store.update("Open SVG for editing", (d) => {
    // Built as a group in ONE step: the paths are born inside the new comp and
    // the group takes the IMAGE's own lane and slot. The old route placed every
    // path in the parent first, moved them all straight back out, and pruned
    // the lanes it had just made — which is where the empty "zombie" lanes in
    // the root timeline came from. Converting a layer is not permission to
    // rearrange the timeline around it, and it should not churn it either.
    nestedId = nestNewClips(d, clip.frameId, result.clips, { name, slotClipId: clipId });
    if (!nestedId) return;
    if (result.group) moveClipsToScope(d, result.members, result.group.id);
    for (const c of result.clips) {
      const placed = locateClip(d, c.id)?.clip;
      if (placed) placed.fillDuration = true; // paths span the comp (follow when trimmed)
    }
    const nestedClip = locateClip(d, nestedId)?.clip;
    if (nestedClip?.kind !== "nested") return;
    reconcileFillClips(d, nestedClip.sourceFrameId);
    // Stamp the provenance so navigation calls this what it is ("vector
    // artwork", pen-tool badge) instead of one more anonymous "Nested".
    const source = d.frames.find((f) => f.id === nestedClip.sourceFrameId);
    if (source) {
      source.sourceTag = VECTOR_SOURCE_TAG;
      source.svgAssetId = assetId;
      source.name = name || "Vectors";
    }
  });
  if (!nestedId) return;

  // Do NOT drill in. Opening artwork for editing is a request to SEE inside it,
  // not to go and live there — and drilling re-scoped the timeline, moved the
  // playhead and dropped the breadcrumb to answer it. The layer becomes a
  // vector group, its pieces appear under it in the Layers panel, the pixels do
  // not move and the timeline stays exactly where it was. That is the whole
  // promise; double-click is still there for when you actually want to go in.
  const session = useSession.getState();
  session.select([nestedId]);
  session.setNestedExpanded(nestedId, true);
  toast(`Opened “${name}” — ${result.clips.length} editable path${result.clips.length > 1 ? "s" : ""}`);
}
