"use client";

import { BRIDGE } from "./bridge";
import { identity } from "@/editor/identity";
import { z } from "zod";
import {
  ApiError,
  clipForAsset,
  locateClip,
  placeClip,
  resolveTargetFrame,
  type Asset,
  type AssetOrigin,
  type MotionDocument,
  type Clip,
  type CommandRuntime,
  type Frame,
} from "@solomotion/core";
import { pcmToWav } from "@solomotion/agent";
import { importFileAsAsset } from "../assets/import";
import { getAssetBlob } from "../assets/asset-store";
import { ensureAudioBuffer } from "../audio/waveform";
import { attachmentFile, getAttachment } from "./attachments";

/**
 * MEDIA IN AND OUT for host verbs: resolve "this thing" (a layer, an asset, an
 * attachment) to bytes, bring bytes back in as an asset with its origin, put
 * an asset on the timeline, swap a layer's media in place. Every AI verb —
 * generate, cut out, upscale, isolate, transcribe — speaks through these, so
 * none of them re-decides what a layer's source is or where a result lands.
 */

export function frameAt(rt: CommandRuntime, frameId?: string): Frame {
  return resolveTargetFrame(rt, frameId ?? null);
}

export const placeInput = z
  .object({
    frameId: z.string().optional(),
    startMs: z.number().min(0).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    durationMs: z.number().positive().optional(),
    above: z.string().optional(),
  })
  .optional()
  .describe("Also put it on the timeline. Omitted = only add it to the Media library.");

export type PlaceInput = z.infer<typeof placeInput>;

export const AI_FOLDER = "AI generated";

function ensureFolder(d: MotionDocument, name: string): string {
  const existing = d.mediaFolders.find((f) => f.name === name && !f.parentId);
  if (existing) return existing.id;
  const id = `mfolder_${Date.now().toString(36)}`;
  d.mediaFolders.push({ id, name, parentId: null, linked: null });
  return id;
}

/**
 * The asset already holding exactly these bytes, if any. An agent that
 * rebuilds a scene imports the same files every run; a byte-identical match is
 * the same media, so it is reused rather than piling up copies. Only assets of
 * the same size are read, so a fresh file costs nothing.
 */
async function sameBytes(rt: CommandRuntime, file: File): Promise<Asset | null> {
  const candidates = rt.doc().assets.filter((a) => a.bytes === file.size);
  if (!candidates.length) return null;
  const mine = new Uint8Array(await file.arrayBuffer());
  for (const a of candidates) {
    const blob = await getAssetBlob(a.id);
    if (!blob || blob.size !== file.size) continue;
    const theirs = new Uint8Array(await blob.arrayBuffer());
    if (theirs.every((b, i) => b === mine[i])) return a;
  }
  return null;
}

/**
 * Import bytes as an asset (probed like any drop), then file it and stamp its
 * origin. Bytes already in the project are that asset (and bytes an asset
 * lost go back to it — `importFileAsAsset`).
 */
export async function importBytes(rt: CommandRuntime, file: File, opts: { folder?: string; origin?: AssetOrigin }): Promise<Asset> {
  const asset = (await sameBytes(rt, file)) ?? (await importFileAsAsset(rt.store, file));
  if (!asset) throw new ApiError(`"${file.name}" could not be read as image, video or audio.`);
  if (opts.folder || opts.origin) {
    rt.write("File media", (d) => {
      const a = d.assets.find((x) => x.id === asset.id);
      if (!a) return;
      if (opts.folder) a.folderId = ensureFolder(d, opts.folder);
      if (opts.origin) a.origin = opts.origin;
    });
  }
  return rt.doc().assets.find((a) => a.id === asset.id) ?? asset;
}

/**
 * THE error for media whose bytes are gone from this device — the same words
 * from every verb that meets it (export, analyze, inspect, any AI verb), so an
 * agent learns one fix: import the same files again, which restores them under
 * their old ids (`importFileAsAsset`).
 */
/** What a `saveTo` input means, for every verb that writes a file through the bridge. */
export const SAVE_TO_DESCRIPTION =
  `Write the file HERE on the machine your MCP client runs on: a file path, or a folder ending in /. Absolute, or relative to its working folder. Your session's ${identity.name} bridge writes it; without saveTo it writes to your Downloads folder.`;

/** What `where` says when a file went to the browser instead: handed over, never known to have landed. */
export const BROWSER_DOWNLOAD =
  `handed to the browser as a download, NOT confirmed (an embedded or busy browser can drop it). Export through the ${identity.name} bridge to get a real path.`;

/** The caller's file writer, or the one refusal that says why there is none. */
export function requireDelivery(rt: CommandRuntime): NonNullable<CommandRuntime["deliver"]> {
  if (rt.deliver) return rt.deliver;
  throw new ApiError(
    `The bridge linked to this tab cannot write files, so \`saveTo\` has nowhere to go (a bridge before 3.7 cannot — with several sessions it is the one holding port ${BRIDGE.port}, maybe another session's).`,
    `Restart every agent session's ${BRIDGE.name} MCP server on ${BRIDGE.package}@latest (or close the old ones), or omit saveTo and the file goes to the browser's downloads.`,
  );
}

export function bytesMissing(assets: Array<Pick<Asset, "id" | "name">>): ApiError {
  const named = assets.map((a) => `${a.name} (${a.id})`).join(", ");
  return new ApiError(
    assets.length ? `${assets.length === 1 ? "This media's file is" : `${assets.length} media files are`} not on this device: ${named}.` : "That media's file is not on this device.",
    "Import the same file again (media.import with its localPath, or drop it on the Media library): it goes back under the same id and every layer using it plays again. Or relink it in the Media panel.",
  );
}

export function placeAsset(rt: CommandRuntime, asset: Asset, place: PlaceInput): string | null {
  if (!place) return null;
  const frame = frameAt(rt, place.frameId);
  let id: string | null = null;
  rt.write(`Place ${asset.name}`, (d) => {
    const clip = clipForAsset(asset, { frameId: frame.id, startMs: place.startMs ?? rt.session.playheadMs(), x: place.x, y: place.y }, frame);
    if (place.durationMs) clip.durationMs = place.durationMs;
    // Settled like every API birth — reuse a free lane at that z (see `layer.create`).
    placeClip(d, clip, { ...(place.above ? { aboveClipId: place.above } : {}), landing: "settle" });
    id = clip.id;
  });
  return id;
}

// ── Resolving "this" to bytes ────────────────────────────────────────────────

export type MediaKind = "image" | "video" | "audio";

export interface MediaSource {
  blob: Blob;
  kind: MediaKind;
  /** The asset behind it, when there is one (the parent of anything made from it). */
  assetId: string | null;
  /** The layer it was asked of, when it was a layer. */
  clip: Clip | null;
}

const kindOfType = (type: string): MediaKind | null =>
  type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : type.startsWith("audio/") ? "audio" : null;

function assetIdOfClip(clip: Clip): string | null {
  if (clip.kind === "image" || clip.kind === "video") return clip.assetId;
  if (clip.kind === "audio" && clip.source.type === "asset") return clip.source.assetId;
  return null;
}

/** A layer id, an asset id or an attachment id → its bytes. */
export async function mediaOf(rt: CommandRuntime, id: string, accept?: MediaKind[]): Promise<MediaSource> {
  const want = accept?.join(" or ") ?? "media";
  const att = await getAttachment(id);
  if (att) {
    const file = attachmentFile(att);
    const kind = kindOfType(file.type);
    if (!kind || (accept && !accept.includes(kind))) throw new ApiError(`That attachment is not ${want}.`);
    return { blob: file, kind, assetId: null, clip: null };
  }
  const doc = rt.doc();
  const loc = locateClip(doc, id);
  const assetId = loc ? assetIdOfClip(loc.clip) : doc.assets.some((a) => a.id === id) ? id : null;
  if (!assetId) {
    throw new ApiError(
      loc ? `Layer "${loc.clip.name}" has no ${want} of its own (it is a ${loc.clip.kind} layer).` : `Nothing called "${id}".`,
      "Pass an image, video or audio layer, an asset id from media.list, or an attachment id.",
    );
  }
  const asset = doc.assets.find((a) => a.id === assetId);
  const blob = await getAssetBlob(assetId);
  if (!asset || !blob) throw bytesMissing(asset ? [asset] : []);
  const kind = asset.kind as MediaKind;
  if (accept && !accept.includes(kind)) throw new ApiError(`That is ${kind}, not ${want}.`);
  return { blob: blob.type ? blob : new Blob([blob], { type: asset.mime }), kind, assetId, clip: loc?.clip ?? null };
}

// ── Sound for speech jobs ────────────────────────────────────────────────────

/**
 * The part of a sound that actually PLAYS, and how its time maps to the comp.
 * A layer contributes only its trimmed window, at its speed — so a transcript
 * of a layer is in comp time, and pauses found in it can be cut directly.
 */
export interface SoundWindow {
  buffer: AudioBuffer;
  fromMs: number;
  toMs: number;
  /** Source ms → comp ms (identity for an asset or attachment). */
  toComp: (sourceMs: number) => number;
  clip: Clip | null;
  assetId: string | null;
}

async function decode(blob: Blob): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, 1, 44_100);
  try {
    return await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw new ApiError("Could not decode that sound in the browser.");
  }
}

export async function soundOf(rt: CommandRuntime, id: string): Promise<SoundWindow> {
  const src = await mediaOf(rt, id, ["audio", "video"]);
  const buffer = (src.assetId ? await ensureAudioBuffer(src.assetId) : null) ?? (await decode(src.blob));
  const totalMs = buffer.duration * 1000;
  const clip = src.clip;
  if (!clip || (clip.kind !== "audio" && clip.kind !== "video")) {
    return { buffer, fromMs: 0, toMs: totalMs, toComp: (ms) => ms, clip: null, assetId: src.assetId };
  }
  const speed = Math.abs(clip.playback?.speed ?? 1) || 1;
  const trimIn = clip.trimInMs ?? 0;
  const toMs = Math.min(totalMs, trimIn + clip.durationMs * speed);
  return { buffer, fromMs: trimIn, toMs, toComp: (ms) => clip.startMs + (ms - trimIn) / speed, clip, assetId: src.assetId };
}

/**
 * Mono 16 kHz WAV chunks of a window — what every speech model wants, a tenth
 * the size of the source, and under OpenAI's 25 MB per request at 10 minutes.
 */
export async function speechChunks(w: SoundWindow, maxChunkMs: number): Promise<Array<{ blob: Blob; fromMs: number }>> {
  const RATE = 16_000;
  const out: Array<{ blob: Blob; fromMs: number }> = [];
  for (let from = w.fromMs; from < w.toMs - 1; from += maxChunkMs) {
    const to = Math.min(w.toMs, from + maxChunkMs);
    const frames = Math.max(1, Math.ceil(((to - from) / 1000) * RATE));
    const ctx = new OfflineAudioContext(1, frames, RATE);
    const node = ctx.createBufferSource();
    node.buffer = w.buffer;
    node.connect(ctx.destination);
    node.start(0, from / 1000, (to - from) / 1000);
    const rendered = await ctx.startRendering();
    const f32 = rendered.getChannelData(0);
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i]! * 32767)));
    out.push({ blob: pcmToWav(new Uint8Array(i16.buffer), RATE), fromMs: from });
  }
  return out;
}

// ── Swapping a layer's media ─────────────────────────────────────────────────

/**
 * Point a layer at new media, in place — the edit, the cut-out, the upscale
 * replaces what the layer SHOWS and nothing else: its transform, timing,
 * effects and keys stay. A visual that changed pixel size keeps its size on
 * the canvas (scale compensates), so a 2× upscale looks the same, only sharper.
 */
export function swapLayerMedia(rt: CommandRuntime, clipId: string, asset: Asset, label: string): void {
  rt.write(label, (d) => {
    const loc = locateClip(d, clipId);
    if (!loc) return;
    const c = loc.clip;
    if (c.kind === "image" || c.kind === "video") {
      const before = d.assets.find((a) => a.id === c.assetId);
      if (before?.width && asset.width && before.width !== asset.width) {
        const k = before.width / asset.width;
        c.transform.scale *= k;
        if (c.transform.scaleY != null) c.transform.scaleY *= k;
      }
      c.assetId = asset.id;
    } else if (c.kind === "audio" && c.source.type === "asset") {
      c.source.assetId = asset.id;
    } else throw new ApiError(`A ${c.kind} layer has no media to replace.`);
  });
}
