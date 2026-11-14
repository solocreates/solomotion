"use client";

import { captureTemplate, type MotionDocument, type Frame, type LibraryKind } from "@solomotion/core";
import { writeMotionBundle } from "../io/motion-file";
import { captureThumbnail } from "../state/project-store";
import type { PublisherIdentity } from "./publisher-identity";

/**
 * PUBLISHING, the one path. The Publish dialog and the agent's
 * `project.publish` both bundle a project and send it here, so a card made by
 * an agent is byte-for-byte the card the dialog makes: same bundle, same
 * poster size, same request. The server route writes it into the content repo;
 * `pnpm library:publish` ships it.
 */

/** A community card's still: wide enough for a retina grid cell, small enough to be one image. */
export const POSTER_EDGE = 1280;

export interface Poster {
  dataUrl: string;
  width: number;
  height: number;
}

export const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "untitled";

export const extOf = (name: string) => (/\.[^.]+$/.exec(name)?.[0] ?? "").toLowerCase();

/** The project as a library bundle (File ▸ Save's format minus what only means something here), and its poster: `frame` at `atMs`. */
export async function bundleProject(doc: MotionDocument, frame: Frame, atMs: number): Promise<{ blob: Blob; poster: Poster | null }> {
  const blob = await writeMotionBundle(captureTemplate(doc), {
    includeMedia: true,
  });
  const dataUrl = captureThumbnail(doc, frame, atMs, POSTER_EDGE);
  const scale = Math.min(1, POSTER_EDGE / Math.max(frame.width, frame.height));
  const poster = dataUrl
    ? {
        dataUrl,
        width: Math.round(frame.width * scale),
        height: Math.round(frame.height * scale),
      }
    : null;
  return { blob, poster };
}

export interface PublishEntry {
  /** File name with extension; the server files it under the pack's kind folder. */
  fileName: string;
  name: string;
  tags: string[];
  blurb: string | null;
  description: string | null;
  hitMs?: number;
}

export interface PublishResult {
  path: string;
  packId: string;
  replaced: boolean;
}

/** POST one item to the content repo. Throws the server's own words on refusal. */
export async function sendToLibrary(
  publisher: PublisherIdentity,
  pack: { id: string; title: string; kind: LibraryKind },
  entry: PublishEntry,
  file: Blob,
  poster: Poster | null,
): Promise<PublishResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const res = await fetch("/api/library/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publisher: { id: publisher.id, secret: publisher.secret },
      pack: {
        ...pack,
        blurb: null,
        license: null,
        attribution: null,
        tags: [],
      },
      entry,
      fileBase64: btoa(binary),
      preview: poster
        ? {
            base64: poster.dataUrl.slice(poster.dataUrl.indexOf(",") + 1),
            ext: poster.dataUrl.startsWith("data:image/webp") ? ".webp" : ".png",
            width: poster.width,
            height: poster.height,
          }
        : null,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    path?: string;
    packId?: string;
    replaced?: boolean;
  };
  if (!res.ok || !data.path) throw new Error(data.error ?? `Publish failed (${res.status})`);
  return {
    path: data.path,
    packId: data.packId ?? pack.id,
    replaced: Boolean(data.replaced),
  };
}

/** Which packs this publisher owns, and whether this server can publish at all. */
export async function publisherPacks(publisher: PublisherIdentity): Promise<{
  available: boolean;
  packs: Array<{ id: string; title: string; kind: string }>;
}> {
  const res = await fetch(`/api/library/publish?id=${encodeURIComponent(publisher.id)}&secret=${encodeURIComponent(publisher.secret)}`);
  if (res.status === 403) throw new Error("This publisher id and secret are not recognised.");
  const data = (await res.json()) as {
    packs?: Array<{ id: string; title: string; kind: string }>;
    available?: boolean;
  };
  return { available: data.available !== false, packs: data.packs ?? [] };
}
