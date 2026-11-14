"use client";
import { NAMES } from "@/editor/names";

/**
 * WHERE A FINISHED EXPORT GOES — the one door every exporter hands its file to.
 *
 * Every exporter used to end in its own `<a download>` click, which made them
 * impossible to compose: exporting three frames meant three downloads, and
 * nothing could gather them. Now each one ends in its options' `save` — the
 * browser's downloads (`saveExport`) unless the caller passed its own — and a
 * batch runs the ordinary single-frame exporters inside `collectSaves`, giving
 * each the batch's sink. No exporter knows it is part of a batch, so there is
 * no second, drifting "multi" version of any of them.
 *
 * The sink is PASSED, never installed. It used to be one module-level
 * collector that every `saveExport` checked: an export the agent's bridge gave
 * up on kept rendering in the page and kept holding it, so every later export
 * failed with "An export batch is already collecting files" until a reload —
 * and two exports at once would have shared one list. A sink in the options
 * belongs to its own call and dies with it.
 */

export interface SavedFile {
  name: string;
  blob: Blob;
}

/** Receives a finished file. */
export type SaveSink = (blob: Blob, filename: string) => void;

/** The default sink: hand a finished file to the user, as a download. */
export function saveExport(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Run `fn` with a sink of its own and return every file it saved there,
 * instead of downloading them. Any number may run at once; each gets only
 * its own files.
 */
export async function collectSaves(fn: (save: SaveSink) => Promise<unknown>): Promise<SavedFile[]> {
  const files: SavedFile[] = [];
  await fn((blob, name) => void files.push({ name, blob }));
  return files;
}

/** Filename-safe version of a user-facing name. */
export function safeFileName(name: string): string {
  return name.replace(/[^\w\d-]+/g, "-").replace(/^-+|-+$/g, "") || NAMES.files.fallbackName;
}

/**
 * Zip files into one download. Stored, not deflated — images, video and PDFs
 * are compressed already, and a second pass costs time for nothing. Names are
 * kept unique (a second "Cover.png" becomes "Cover-2.png").
 */
export async function saveZip(files: SavedFile[], zipName: string): Promise<void> {
  const { Zip, ZipPassThrough } = await import("fflate");
  const chunks: Uint8Array[] = [];
  const done = new Promise<void>((resolve, reject) => {
    const zip = new Zip((err, chunk, final) => {
      if (err) return reject(err);
      if (chunk) chunks.push(chunk);
      if (final) resolve();
    });
    const used = new Set<string>();
    void (async () => {
      for (const f of files) {
        const dot = f.name.lastIndexOf(".");
        const stem = dot > 0 ? f.name.slice(0, dot) : f.name;
        const ext = dot > 0 ? f.name.slice(dot) : "";
        let name = f.name;
        for (let n = 2; used.has(name); n++) name = `${stem}-${n}${ext}`;
        used.add(name);
        const entry = new ZipPassThrough(name);
        zip.add(entry);
        entry.push(new Uint8Array(await f.blob.arrayBuffer()), true);
      }
      zip.end();
    })().catch(reject);
  });
  await done;
  saveExport(new Blob(chunks as BlobPart[], { type: "application/zip" }), zipName);
}
