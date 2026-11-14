"use client";

import {
  analyzeAudio,
  createId,
  instantiateLibrarySnapshot,
  normalizeSnapshot,
  type DocumentStore,
  type LibraryItem,
  type SoundPackId,
  type LibrarySnapshot,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import { putAssetBlob } from "../assets/asset-store";
import { listAppSounds, saveAppSound } from "../audio/app-sounds";
import { ensureAudioBuffer } from "../audio/waveform";
import { audibleSeconds, packBufferSync, renderPackBuffer } from "../audio/sound-engine";
import { audioBufferToWav } from "../export/export-audio";
import { useWorkspace } from "../state/workspace";
import { libraryClient } from "./client";

/**
 * DOWNLOAD = MATERIALISE. The one place an online item becomes a local one.
 *
 * It does not write to a downloads folder, a cache table or a "my library"
 * list. It writes into the store that kind of thing already lives in — a sound
 * becomes a device sound, a component becomes a saved component — and records
 * `originId` so the browser can fold the two cards into one. Anything else is
 * a second answer to "do I have this", and the two answers disagree the first
 * time someone deletes one of them.
 *
 * The derived facts (duration, hit point, waveform) are recomputed here from
 * the ACTUAL bytes with the same `analyzeAudio` the publish script ran, rather
 * than trusted from the manifest. They should agree; if they ever don't, the
 * bytes win, because the bytes are what will play.
 */

export interface DownloadResult {
  item: LibraryItem;
  /** The local id the bytes landed under — an asset id for sounds. */
  localId: string;
}

/** Download a library item's bytes and adopt them onto this device. */
export async function downloadLibraryItem(
  item: LibraryItem,
  signal?: AbortSignal,
): Promise<DownloadResult | null> {
  const client = libraryClient();
  if (!client || !item.blob) return null;

  const blob = await client.blob(item, signal);

  if (item.kind === "sound") {
    const id = createId("asset");
    await putAssetBlob(id, blob);
    // Decode through the SAME cache the timeline uses, so the sound is already
    // warm the instant its card offers to audition it.
    const buffer = await ensureAudioBuffer(id);
    const analysis = buffer
      ? analyzeAudio(buffer.getChannelData(0), buffer.sampleRate)
      : null;
    saveAppSound({
      id,
      name: item.name,
      hitMs: analysis?.hitMs ?? previewHit(item),
      mime: item.blob.mime,
      bytes: item.blob.bytes,
      durationMs: analysis?.durationMs ?? previewDuration(item),
      tags: item.tags,
      peaks: item.preview.type === "peaks" ? item.preview.peaks : null,
      loudnessDb: analysis?.loudnessDb ?? (item.preview.type === "peaks" ? item.preview.loudnessDb : null),
      originId: item.id,
    });
    return { item, localId: id };
  }

  // Everything else ships as a `LibrarySnapshot` — clips, ready to instantiate.
  const snapshot = normalizeSnapshot(JSON.parse(await blob.text()));
  if (!snapshot) throw new Error(`${item.name} is not a usable component`);
  const saved = useWorkspace.getState().addCustomTemplate({
    name: item.name,
    category: item.tags[0] ?? "Library",
    snapshot,
    preview: null,
    originId: item.id,
  });
  return { item, localId: saved.id };
}

function previewHit(item: LibraryItem): number {
  return item.preview.type === "peaks" ? item.preview.hitMs : 0;
}

function previewDuration(item: LibraryItem): number | null {
  return item.preview.type === "peaks" ? item.preview.durationMs : null;
}

/** Download with the app's own progress + failure reporting. */
export async function downloadWithToast(item: LibraryItem): Promise<DownloadResult | null> {
  try {
    const result = await downloadLibraryItem(item);
    if (result) toast(`“${item.name}” added to your library`);
    return result;
  } catch (err) {
    toast(`Couldn’t download “${item.name}” — ${err instanceof Error ? err.message : "network error"}`);
    return null;
  }
}

/** Materialise a snapshot the caller already has (no network). */
export function snapshotClips(snapshot: LibrarySnapshot, frameId: string, startMs: number) {
  return instantiateLibrarySnapshot(snapshot, { frameId, startMs });
}

/* -------------------------------------------------------------------------- */
/* Dragging something you do not own yet                                       */
/* -------------------------------------------------------------------------- */

/**
 * The asset id a library item drags as — allocated NOW, filled in as the bytes
 * arrive.
 *
 * A drag has to start on pointer-down; a download takes a network round trip.
 * Rather than block the gesture (or invent a second, async drop path that the
 * stage and timeline would each have to learn), this writes the document's
 * `Asset` entry immediately from the manifest — which already knows the name,
 * mime, byte size and duration, because those were DERIVED at publish time and
 * not guessed — and streams the bytes into the blob store behind it.
 *
 * So by the time a human has dragged anywhere, `doc.assets` already has the
 * entry both drop handlers look for, and neither of them needed a single line
 * of change. The bytes land a moment later and the waveform fills in, exactly
 * as it does for any other import.
 *
 * Returns null for something with nothing to place — a synthesized pack is a
 * VOICE, not a clip.
 */
export function ensureLibraryAsset(store: DocumentStore, item: LibraryItem): string | null {
  if (item.action?.type === "asset") return item.action.assetId;
  if (item.action?.type === "sound") {
    if (item.action.assetId) return item.action.assetId;
    return item.action.pack ? bakePack(store, item.action.pack, item.name) : null;
  }
  if (!item.blob) return null;

  // Already fetched under some other card? Reuse it; the same bytes must never
  // become two assets.
  const existing = listAppSounds().find((s) => s.originId === item.id);
  const id = existing?.id ?? createId("asset");
  const durationMs = item.preview.type === "peaks" ? item.preview.durationMs : null;

  store.update(`Add ${item.name}`, (d) => {
    if (d.assets.some((a) => a.id === id)) return;
    d.assets.push({
      id,
      kind: assetKindFor(item.blob!.mime),
      name: item.name,
      mime: item.blob!.mime,
      bytes: item.blob!.bytes,
      width: null,
      height: null,
      durationMs,
      fps: null,
      folderId: null,
      origin: null,
    });
  });

  if (!existing) void hydrate(item, id);
  return id;
}

/**
 * A synthesized pack, baked into a real audio asset so it can be DROPPED.
 *
 * A pack is a voice — the thing a sound layer points at — and for that it never
 * needed bytes. But dragging one onto a lane means asking for an audio CLIP,
 * and a clip is a file. So the first time you drag one we render it offline
 * (the same `renderPackBuffer` the picker auditions from), encode it with the
 * exporter's own WAV writer, and adopt it like any other sound. Rendered once
 * per pack, then reused: the asset id is deterministic, so a second drag finds
 * the first one instead of making a twin.
 */
function bakePack(store: DocumentStore, pack: SoundPackId, name: string): string {
  const id = `pack_${pack}`;
  if (store.getState().assets.some((a) => a.id === id)) return id;

  store.update(`Add ${name}`, (d) => {
    if (d.assets.some((a) => a.id === id)) return;
    d.assets.push({
      id,
      kind: "audio",
      name,
      mime: "audio/wav",
      bytes: 0,
      width: null,
      height: null,
      durationMs: null,
      fps: null,
      folderId: null,
      origin: null,
    });
  });

  void (async () => {
    const buffer = packBufferSync(pack) ?? (await renderPackBuffer(pack));
    if (!buffer) return;
    const blob = audioBufferToWav(buffer);
    await putAssetBlob(id, blob);
    const durationMs = Math.round(audibleSeconds(buffer) * 1000);
    store.update("Measure sound", (d) => {
      const asset = d.assets.find((a) => a.id === id);
      if (asset) {
        asset.bytes = blob.size;
        asset.durationMs = durationMs;
      }
    });
  })();

  return id;
}

/** Fetch the bytes into the blob store, then record the sound device-wide. */
async function hydrate(item: LibraryItem, id: string): Promise<void> {
  const client = libraryClient();
  if (!client || !item.blob) return;
  try {
    await putAssetBlob(id, await client.blob(item));
    if (item.kind !== "sound") return;
    const buffer = await ensureAudioBuffer(id);
    const analysis = buffer ? analyzeAudio(buffer.getChannelData(0), buffer.sampleRate) : null;
    saveAppSound({
      id,
      name: item.name,
      hitMs: analysis?.hitMs ?? (item.preview.type === "peaks" ? item.preview.hitMs : 0),
      mime: item.blob.mime,
      bytes: item.blob.bytes,
      durationMs: analysis?.durationMs ?? (item.preview.type === "peaks" ? item.preview.durationMs : null),
      tags: item.tags,
      peaks: item.preview.type === "peaks" ? item.preview.peaks : null,
      loudnessDb: analysis?.loudnessDb ?? (item.preview.type === "peaks" ? item.preview.loudnessDb : null),
      originId: item.id,
    });
  } catch (err) {
    toast(`Couldn’t fetch “${item.name}” — ${err instanceof Error ? err.message : "network error"}`);
  }
}

function assetKindFor(mime: string): "image" | "video" | "audio" {
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";
  return "audio";
}
