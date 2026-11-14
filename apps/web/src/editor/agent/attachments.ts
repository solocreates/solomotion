"use client";

import { BRIDGE } from "./bridge";
import { identity } from "@/editor/identity";
import { z } from "zod";
import { ApiError } from "@solomotion/core";
import { dbGet, dbPut } from "./db";

/**
 * Files handed to the agent. The bytes are stored ONCE, by id, in the agent's
 * IndexedDB; the transcript only ever carries the id and a description. A tool
 * that needs the file (import it as media, install it as a font, look inside a
 * video) reads it from here — nothing is downloaded or uploaded twice.
 */

export interface StoredAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  blob: Blob;
  addedAt: number;
}

export async function putAttachment(file: File | Blob, name?: string): Promise<StoredAttachment> {
  const record: StoredAttachment = {
    id: `att_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: name ?? (file instanceof File ? file.name : "file"),
    type: file.type || guessType(name ?? (file instanceof File ? file.name : "")),
    size: file.size,
    blob: file,
    addedAt: Date.now(),
  };
  await dbPut("attachments", record.id, record);
  return record;
}

export async function getAttachment(id: string): Promise<StoredAttachment | null> {
  return (await dbGet<StoredAttachment>("attachments", id)) ?? null;
}

export function attachmentFile(a: StoredAttachment): File {
  return new File([a.blob], a.name, { type: a.type });
}

/**
 * WHERE A FILE COMES FROM — one input for every command that takes a file:
 * something the user attached in the chat, a URL, or a file on the machine
 * the agent runs on.
 *
 * The last is the one a browser tab cannot reach on its own, and the one every
 * agent working from a folder of voice, sound and art hit first. The MCP
 * bridge runs beside those files: it reads `localPath` there and hands the
 * bytes over as `localFile`, so the tab never touches the disk and no server
 * or CORS dance is needed.
 */
export const fileSourceInput = {
  attachmentId: z.string().optional(),
  url: z.string().optional().describe("An http(s) URL, or a path on this app (`/templates/…`)."),
  localPath: z
    .string()
    .optional()
    .describe(`A file on the machine your MCP client runs on — absolute, or relative to its working folder. The ${identity.name} bridge reads it.`),
  localFile: z
    .object({ name: z.string(), base64: z.string() })
    .optional()
    .describe("Set by the bridge from localPath. Do not write it."),
};

export interface FileSource {
  attachmentId?: string;
  url?: string;
  localPath?: string;
  localFile?: { name: string; base64: string };
  name?: string;
}

/** The file a `fileSourceInput` names, as a `File`. */
export async function fileFromSource(input: FileSource): Promise<File> {
  if (input.localFile) {
    const bin = atob(input.localFile.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const name = input.name ?? input.localFile.name;
    return new File([bytes], name, { type: guessType(input.localFile.name) });
  }
  if (input.localPath) {
    // The bridge reads a localPath from the call it is given; one it never saw arrives here unread.
    throw new ApiError(
      `The ${identity.name} bridge did not read ${input.localPath}: a localPath is read only in a call the agent makes — never inside a script — and a bridge before 3.8 reads it only at the top level of a call (not inside api_batch).`,
      `Pass localPath in the call itself (or a url). If it was, update this session's bridge: \`npx -y ${BRIDGE.package}@latest\` in its MCP config, then restart its ${BRIDGE.name} server; ${BRIDGE.statusTool} shows every bridge's version.`,
    );
  }
  if (input.attachmentId) {
    const a = await getAttachment(input.attachmentId);
    if (!a) throw new ApiError(`No attachment "${input.attachmentId}".`);
    return attachmentFile(a);
  }
  if (input.url) {
    let url: URL;
    try {
      url = new URL(input.url, location.href);
    } catch {
      throw new ApiError(`"${input.url}" is not a URL.`);
    }
    const res = await fetch(url).catch(() => null);
    if (!res?.ok) {
      throw new ApiError(
        "Could not download that URL from the browser.",
        "The site may block cross-origin downloads. A file on your machine: pass localPath instead.",
      );
    }
    const blob = await res.blob();
    return new File([blob], input.name ?? decodeURIComponent(url.pathname.split("/").pop() || "download"), { type: blob.type });
  }
  throw new ApiError("Give a localPath, an attachmentId or a url.");
}

/** What kind of thing a file is, for deciding how the model receives it. */
export type AttachmentClass = "image" | "text" | "audio" | "video" | "font" | "other";

const TEXT_EXT = /\.(md|mdx|txt|json|csv|tsv|ya?ml|xml|srt|vtt|css|html?|svg|js|ts)$/i;

export function classify(name: string, type: string): AttachmentClass {
  if (/^image\/(png|jpe?g|webp|gif)$/.test(type)) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (/\.(ttf|otf|woff2?)$/i.test(name) || type.startsWith("font/")) return "font";
  if (type.startsWith("text/") || type === "application/json" || TEXT_EXT.test(name)) return "text";
  return "other";
}

function guessType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
    ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
    md: "text/markdown", txt: "text/plain", json: "application/json", csv: "text/csv", srt: "text/plain", vtt: "text/vtt",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Read an image file as base64 (no prefix), downscaled so the long edge is at most `maxEdge`. */
export async function imageToBase64(blob: Blob, maxEdge = 1568): Promise<{ data: string; mediaType: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return { ...canvasToBase64(canvas, blob.type === "image/png" ? "image/png" : "image/jpeg"), width: w, height: h };
}

export function canvasToBase64(canvas: HTMLCanvasElement, mediaType = "image/jpeg"): { data: string; mediaType: string } {
  const url = canvas.toDataURL(mediaType, 0.86);
  return { data: url.slice(url.indexOf(",") + 1), mediaType };
}
