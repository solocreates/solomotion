"use client";

import { identity } from "@/editor/identity";
import {
  collectAssetIds,
  documentFontUsage,
  faceKey,
  makeMotionManifest,
  motionManifestSchema,
  MOTION_PATHS,
  parseDocument,
  serializeDocument,
  type MotionAssetEntry,
  type MotionFontEntry,
  type MotionManifest,
  type MotionDocument,
} from "@solomotion/core";
import { zip, unzip, strToU8, strFromU8, type AsyncZippable, type Unzipped } from "fflate";
import { getAssetBlob, putAssetBlob } from "../assets/asset-store";
import { getCustomFontBlob, installCustomFontBytes, isCustomFamily } from "../stage/render/fonts";
import { ensureDocumentFaces } from "../stage/render/system-fonts";
import { ENGINE } from "@/editor/names";

/**
 * The `.motion` bundle host adapter — the web editor's reader/writer for the
 * portable project file (core defines the manifest contract in io/motion.ts).
 *
 * The whole feature rests on one seam: every media read in the app resolves
 * bytes by asset id through the blob store (assetObjectURL/getAssetBlob).
 * Writing a bundle serializes those bytes next to the document; reading one
 * rehydrates the blob store (and font registry) — so nothing downstream
 * (render, media-cache, sound engine, export) changes. Three "read modes" —
 * from the saved file, from the original source, or externally before saving —
 * all converge on the same by-id lookup.
 */

const MEDIA_LEVEL = 0 as const; // media is already compressed — store, don't re-deflate.

function zipAsync(files: AsyncZippable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function unzipAsync(buf: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    unzip(buf, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Font archive path. Families can contain spaces and symbols, so encode them —
 * and a family is several FILES, so the weight and slant are part of the path.
 * A bundle written before faces existed has neither, and its path is the plain
 * family, which is exactly what the default arguments reproduce.
 */
function fontPath(entry: { family: string; weight?: number; italic?: boolean }): string {
  const suffix =
    entry.weight === undefined && entry.italic === undefined
      ? ""
      : `-${entry.weight ?? 400}${entry.italic ? "i" : ""}`;
  return `${MOTION_PATHS.fontsDir}${encodeURIComponent(entry.family)}${suffix}`;
}

export interface WriteBundleOptions {
  includeMedia: boolean;
}

/**
 * Build a `.motion` bundle (a Blob) for the current document. Media/font bytes
 * are re-gathered fresh from the live document every call, so the bundle is an
 * exact mirror — new media is embedded, removed media drops out, no diffing.
 */
export async function writeMotionBundle(doc: MotionDocument, options: WriteBundleOptions): Promise<Blob> {
  const files: AsyncZippable = {
    [MOTION_PATHS.document]: strToU8(serializeDocument(doc)),
  };

  // Asset inventory is always recorded (drives the missing-media UI on read);
  // the bytes are embedded only when includeMedia is on.
  const assetEntries: MotionAssetEntry[] = [];
  for (const id of collectAssetIds(doc)) {
    const meta = doc.assets.find((a) => a.id === id);
    const blob = options.includeMedia || !meta ? await getAssetBlob(id) : null;
    const entry: MotionAssetEntry = meta
      ? { id, kind: meta.kind, name: meta.name, mime: meta.mime, bytes: meta.bytes }
      : {
          // A custom-sound blob not registered in doc.assets — synthesize its entry.
          id,
          kind: "audio",
          name: id,
          mime: blob?.type || "audio/*",
          bytes: blob?.size ?? 0,
        };
    assetEntries.push(entry);
    if (options.includeMedia && blob) {
      files[`${MOTION_PATHS.mediaDir}${id}`] = [await bytesOf(blob), { level: MEDIA_LEVEL }];
    }
  }

  // Embed only user-uploaded fonts the document actually uses; Google fonts
  // re-fetch by name on open, so they never need bundling.
  const fontEntries: MotionFontEntry[] = [];
  if (options.includeMedia) {
    // Per FACE, not per family: a project whose captions are bold shipped a
    // regular-only bundle and opened somewhere else with faux-bold text.
    // `documentFontUsage` says which faces are rendered; `getCustomFontBlob`
    // resolves each to the nearest one actually installed, and the key below
    // de-dupes when several asks resolve to the same file.
    const bundled = new Set<string>();
    for (const use of documentFontUsage(doc)) {
      if (!isCustomFamily(use.family)) continue;
      const font = await getCustomFontBlob(use.family, use.weight, use.italic);
      if (!font) continue;
      const entry = { family: use.family, fileName: font.fileName, weight: font.weight, italic: font.italic };
      const path = fontPath(entry);
      if (bundled.has(path)) continue;
      bundled.add(path);
      fontEntries.push(entry);
      files[path] = [new Uint8Array(font.data), { level: MEDIA_LEVEL }];
    }
  }

  const manifest = makeMotionManifest(doc, {
    ns: ENGINE.ns,
    mediaIncluded: options.includeMedia,
    assets: assetEntries,
    fonts: fontEntries,
  });
  files[MOTION_PATHS.manifest] = strToU8(JSON.stringify(manifest, null, 2));

  const zipped = await zipAsync(files);
  return new Blob([new Uint8Array(zipped)], { type: "application/zip" });
}

export interface OpenedProject {
  doc: MotionDocument;
  manifest: MotionManifest | null;
  /** Asset ids that the bundle referenced but whose bytes are not in this store. */
  missingAssetIds: string[];
}

/**
 * Read a `.motion` bundle: parse (and migrate) the document, rehydrate the blob
 * store with any embedded media, and install embedded custom fonts. After this
 * returns, every by-id media lookup resolves exactly as it did on the machine
 * that saved the bundle.
 */
export async function readMotionBundle(file: File): Promise<OpenedProject> {
  const entries = await unzipAsync(new Uint8Array(await file.arrayBuffer()));

  const docBytes = entries[MOTION_PATHS.document];
  if (!docBytes) throw new Error(`Not a ${identity.name} project — document.json is missing.`);
  const doc = parseDocument(strFromU8(docBytes), ENGINE.ns);

  let manifest: MotionManifest | null = null;
  const manifestBytes = entries[MOTION_PATHS.manifest];
  if (manifestBytes) {
    const parsed = motionManifestSchema.safeParse(JSON.parse(strFromU8(manifestBytes)));
    if (parsed.success) manifest = parsed.data;
  }

  const mimeById = new Map(manifest?.assets.map((a) => [a.id, a.mime]) ?? []);

  // Rehydrate media bytes into the blob store, keyed by asset id.
  for (const path of Object.keys(entries)) {
    if (!path.startsWith(MOTION_PATHS.mediaDir)) continue;
    const id = path.slice(MOTION_PATHS.mediaDir.length);
    if (!id) continue;
    const mime = mimeById.get(id) || "application/octet-stream";
    await putAssetBlob(id, new Blob([new Uint8Array(entries[path]!)], { type: mime }));
  }

  // Install embedded faces exactly as the manifest recorded them.
  for (const font of manifest?.fonts ?? []) {
    const data = entries[fontPath(font)];
    if (!data) continue;
    await installCustomFontBytes(font.family, font.fileName, data.buffer as ArrayBuffer, {
      weight: font.weight ?? 400,
      italic: font.italic ?? false,
    });
  }

  // Google fonts the document uses re-fetch by name.
  ensureDocumentFaces(doc);

  // Which referenced assets still have no bytes (e.g. references-only bundle)?
  const missingAssetIds: string[] = [];
  for (const id of collectAssetIds(doc)) {
    if (!(await getAssetBlob(id))) missingAssetIds.push(id);
  }

  return { doc, manifest, missingAssetIds };
}

/**
 * Open any project file the app produces: a `.motion` bundle, or a bare
 * `.<ns>.json` document (back-compat / interchange). JSON carries no
 * bytes, so its media resolves only from what's already in this device's store.
 */
export async function openProjectFile(file: File): Promise<OpenedProject> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".json")) {
    const doc = parseDocument(await file.text(), ENGINE.ns);
    ensureDocumentFaces(doc);
    const missingAssetIds: string[] = [];
    for (const id of collectAssetIds(doc)) {
      if (!(await getAssetBlob(id))) missingAssetIds.push(id);
    }
    return { doc, manifest: null, missingAssetIds };
  }
  return readMotionBundle(file);
}

export interface ImportBundle {
  doc: MotionDocument;
  /** Media bytes keyed by the INCOMING asset id (pre-merge, pre-re-id). */
  assetBlobs: Map<string, Blob>;
  fonts: { family: string; fileName: string; weight: number; italic: boolean; data: ArrayBuffer }[];
}

/**
 * Read a bundle for MERGING into an open project — the sibling of
 * `readMotionBundle`, but it never writes the blob store. A merge re-ids every
 * incoming asset, so its bytes must be written under the NEW ids AFTER the
 * merge (the host does that with `mergeDocument`'s assetIdMap). Writing here
 * would key bytes under the old ids — and worse, could clobber a target asset
 * that happens to share an id. So this returns the bytes in memory instead.
 */
export async function readBundleForImport(file: File): Promise<ImportBundle> {
  if (file.name.toLowerCase().endsWith(".json")) {
    return { doc: parseDocument(await file.text(), ENGINE.ns), assetBlobs: new Map(), fonts: [] };
  }
  const entries = await unzipAsync(new Uint8Array(await file.arrayBuffer()));
  const docBytes = entries[MOTION_PATHS.document];
  if (!docBytes) throw new Error(`Not a ${identity.name} file — document.json is missing.`);
  const doc = parseDocument(strFromU8(docBytes), ENGINE.ns);

  let manifest: MotionManifest | null = null;
  const manifestBytes = entries[MOTION_PATHS.manifest];
  if (manifestBytes) {
    const parsed = motionManifestSchema.safeParse(JSON.parse(strFromU8(manifestBytes)));
    if (parsed.success) manifest = parsed.data;
  }
  const mimeById = new Map(manifest?.assets.map((a) => [a.id, a.mime]) ?? []);

  const assetBlobs = new Map<string, Blob>();
  for (const path of Object.keys(entries)) {
    if (!path.startsWith(MOTION_PATHS.mediaDir)) continue;
    const id = path.slice(MOTION_PATHS.mediaDir.length);
    if (!id) continue;
    const mime = mimeById.get(id) || "application/octet-stream";
    assetBlobs.set(id, new Blob([new Uint8Array(entries[path]!)], { type: mime }));
  }

  const fonts: ImportBundle["fonts"] = [];
  for (const font of manifest?.fonts ?? []) {
    const data = entries[fontPath(font)];
    if (!data) continue;
    fonts.push({
      family: font.family,
      fileName: font.fileName,
      weight: font.weight ?? 400,
      italic: font.italic ?? false,
      data: data.buffer as ArrayBuffer,
    });
  }

  return { doc, assetBlobs, fonts };
}

export interface BundleSizeEstimate {
  docBytes: number;
  imageBytes: number;
  videoBytes: number;
  audioBytes: number;
  fontBytes: number;
  mediaBytes: number;
  total: number;
}

/**
 * Estimate a bundle's on-disk size without building it — sums the source byte
 * counts already recorded in asset metadata (with a blob-size fallback for
 * sound-only ids), plus embedded font sizes and the serialized document.
 */
export async function estimateBundleSize(
  doc: MotionDocument,
  options: WriteBundleOptions,
): Promise<BundleSizeEstimate> {
  const docBytes = strToU8(serializeDocument(doc)).byteLength;
  const est: BundleSizeEstimate = {
    docBytes,
    imageBytes: 0,
    videoBytes: 0,
    audioBytes: 0,
    fontBytes: 0,
    mediaBytes: 0,
    total: docBytes,
  };
  if (!options.includeMedia) return est;

  for (const id of collectAssetIds(doc)) {
    const meta = doc.assets.find((a) => a.id === id);
    const bytes = meta ? meta.bytes : ((await getAssetBlob(id))?.size ?? 0);
    if (meta?.kind === "image") est.imageBytes += bytes;
    else if (meta?.kind === "video") est.videoBytes += bytes;
    else est.audioBytes += bytes; // audio + sound-only blobs
    est.mediaBytes += bytes;
  }

  // Mirrors the bundler above, face for face, so the estimate is the size.
  const counted = new Set<string>();
  for (const use of documentFontUsage(doc)) {
    if (!isCustomFamily(use.family)) continue;
    const font = await getCustomFontBlob(use.family, use.weight, use.italic);
    if (!font) continue;
    const key = faceKey(use.family, font.weight, font.italic);
    if (counted.has(key)) continue;
    counted.add(key);
    est.fontBytes += font.data.byteLength;
  }

  est.total = est.docBytes + est.mediaBytes + est.fontBytes;
  return est;
}
