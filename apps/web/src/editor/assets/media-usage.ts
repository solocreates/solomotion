"use client";

import { assetsUsedByFrame, deleteClip, type Asset, type Clip, type DocumentStore, type MotionDocument } from "@solomotion/core";
import { getAssetBlob, hasAssetBlob } from "./asset-store";
import { releaseAssetBytes } from "./release-bytes";
import { useSession } from "../state/session";

/**
 * The clip ⇄ asset link, in one place. Clips reference imported media by id
 * (image/video → `assetId`, audio → `source.assetId`); this is what lets the
 * library be the single point to replace, relink or delete a file across every
 * clip that uses it. These pure helpers answer "what uses this?" and "what's
 * used but not in the library?" so one UI can show affected clips, focus them,
 * and offer re-import — for media delete, the orphan banner and Save alike.
 */

export interface ClipRef {
  clipId: string;
  frameId: string;
  trackId: string;
  assetId: string;
  name: string;
  kind: Clip["kind"];
  startMs: number;
}

/** The asset a clip is backed by, if any. */
export function clipAssetId(clip: Clip): string | null {
  if (clip.kind === "image" || clip.kind === "video") return clip.assetId;
  if (clip.kind === "audio" && clip.source.type === "asset") return clip.source.assetId;
  return null;
}

function walkClips(doc: MotionDocument, fn: (clip: Clip, trackId: string, assetId: string) => void): void {
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      const assetId = clipAssetId(clip);
      if (assetId) fn(clip, track.id, assetId);
    }
  }
}

function toRef(clip: Clip, trackId: string, assetId: string): ClipRef {
  return { clipId: clip.id, frameId: clip.frameId, trackId, assetId, name: clip.name || clip.kind, kind: clip.kind, startMs: clip.startMs };
}

/** Every clip backed by one of `assetIds`. */
export function clipsUsingAssets(doc: MotionDocument, assetIds: Set<string>): ClipRef[] {
  const out: ClipRef[] = [];
  walkClips(doc, (clip, trackId, assetId) => {
    if (assetIds.has(assetId)) out.push(toRef(clip, trackId, assetId));
  });
  return out;
}

/** Clips whose backing asset is NOT in the library — read from cached bytes,
 * so they play but won't survive a save/bundle until re-imported. */
export function orphanClipRefs(doc: MotionDocument): ClipRef[] {
  const known = new Set(doc.assets.map((a) => a.id));
  const out: ClipRef[] = [];
  walkClips(doc, (clip, trackId, assetId) => {
    if (!known.has(assetId)) out.push(toRef(clip, trackId, assetId));
  });
  return out;
}

/**
 * Media a render of this comp needs whose bytes are NOT on this device — the
 * check every export runs before it renders. Without it a lost file did not
 * fail anything: its sound dropped out of the mix and the export shipped a
 * silent soundtrack that "verified 0% peak", which is how a finished film
 * reached its author with no sound. Named here, the export refuses instead and
 * says which files to bring back.
 */
export async function missingMedia(doc: MotionDocument, frameId: string): Promise<Asset[]> {
  const used = assetsUsedByFrame(doc, frameId);
  const present = await Promise.all(used.map((id) => hasAssetBlob(id)));
  return used.filter((_, i) => !present[i]).map((id) => doc.assets.find((a) => a.id === id)!);
}

/** Resolve node ids (media folders and/or assets) to the asset ids they cover. */
export function assetIdsUnder(doc: MotionDocument, nodeIds: string[]): Set<string> {
  const folderIds = new Set<string>();
  const assetIds = new Set<string>();
  const walk = (parentId: string) => {
    for (const f of doc.mediaFolders) if (f.parentId === parentId) { folderIds.add(f.id); walk(f.id); }
  };
  for (const id of nodeIds) {
    if (doc.mediaFolders.some((f) => f.id === id)) {
      folderIds.add(id);
      walk(id);
    } else if (doc.assets.some((a) => a.id === id)) {
      assetIds.add(id);
    }
  }
  for (const a of doc.assets) if (a.folderId && folderIds.has(a.folderId)) assetIds.add(a.id);
  return assetIds;
}

/** Jump to a clip: open its comp's timeline at its start and select it. */
export function focusClip(ref: ClipRef): void {
  useSession.getState().openTimeline(ref.frameId, ref.startMs);
  useSession.getState().select([ref.clipId]);
}

/** Set of asset ids still referenced by any clip. */
function assetsInUse(doc: MotionDocument): Set<string> {
  const used = new Set<string>();
  walkClips(doc, (_clip, _trackId, assetId) => used.add(assetId));
  return used;
}

/**
 * Forget clips entirely — delete the clips AND drop their now-unused media
 * (library row + bytes). This is the "remove from everywhere" escape hatch for
 * clips whose media is gone; no confirm, undoable in one step.
 */
export function forgetRefs(store: DocumentStore, refs: ClipRef[]): void {
  if (refs.length === 0) return;
  const clipIds = new Set(refs.map((r) => r.clipId));
  const assetIds = new Set(refs.map((r) => r.assetId));
  store.update("Forget clips", (d) => {
    for (const id of clipIds) deleteClip(d, id);
    const used = assetsInUse(d);
    d.assets = d.assets.filter((a) => !(assetIds.has(a.id) && !used.has(a.id)));
  });
  releaseAssetBytes(store, assetIds);
}

/** Forget every clip whose media isn't in the library. */
export function forgetAllOrphans(store: DocumentStore): void {
  forgetRefs(store, orphanClipRefs(store.getState()));
}

/** Probe a blob's intrinsic size/duration for a re-created asset row. */
function probeBlob(
  blob: Blob,
  kind: "image" | "video" | "audio",
): Promise<{ width: number | null; height: number | null; durationMs: number | null }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const done = (r: { width: number | null; height: number | null; durationMs: number | null }) => {
      URL.revokeObjectURL(url);
      resolve(r);
    };
    if (kind === "image") {
      const img = new Image();
      img.onload = () => done({ width: img.naturalWidth || null, height: img.naturalHeight || null, durationMs: null });
      img.onerror = () => done({ width: null, height: null, durationMs: null });
      img.src = url;
    } else if (kind === "video") {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () =>
        done({ width: v.videoWidth || null, height: v.videoHeight || null, durationMs: v.duration ? Math.round(v.duration * 1000) : null });
      v.onerror = () => done({ width: null, height: null, durationMs: null });
      v.src = url;
    } else {
      const a = new Audio();
      a.preload = "metadata";
      a.onloadedmetadata = () => done({ width: null, height: null, durationMs: a.duration ? Math.round(a.duration * 1000) : null });
      a.onerror = () => done({ width: null, height: null, durationMs: null });
      a.src = url;
    }
  });
}

/**
 * Re-create library asset rows for orphan clips whose bytes are still on this
 * device, so the media becomes a first-class, saveable, replaceable library
 * item again. Returns how many were recovered (the rest have no local bytes and
 * need a manual relink). One undo step.
 */
export async function reimportOrphanAssets(store: DocumentStore): Promise<number> {
  const orphans = orphanClipRefs(store.getState());
  // One row per assetId; keep the first clip's name/kind.
  const byAsset = new Map<string, ClipRef>();
  for (const ref of orphans) if (!byAsset.has(ref.assetId)) byAsset.set(ref.assetId, ref);

  const rows: Asset[] = [];
  for (const [assetId, ref] of byAsset) {
    const blob = await getAssetBlob(assetId);
    if (!blob) continue;
    const kind = ref.kind === "video" ? "video" : ref.kind === "audio" ? "audio" : "image";
    const { width, height, durationMs } = await probeBlob(blob, kind);
    rows.push({
      id: assetId,
      kind,
      name: ref.name || "Recovered media",
      mime: blob.type || (kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "image/png"),
      bytes: blob.size,
      width,
      height,
      durationMs,
      fps: null,
      folderId: null,
      origin: null,
    });
  }
  if (rows.length === 0) return 0;
  store.update("Import into library", (d) => {
    const have = new Set(d.assets.map((a) => a.id));
    for (const row of rows) if (!have.has(row.id)) d.assets.push(row);
  });
  return rows.length;
}
