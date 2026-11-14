"use client";

import type { FolderRecord, ProjectRecord } from "./project-store";

/**
 * THE SECOND COPY of every project and folder record, in the Origin Private
 * File System.
 *
 * IndexedDB was the only copy of a web project. When the machine crashed mid
 * write (a kernel panic, a power cut), Chromium found its IndexedDB backing
 * store corrupt on the next start and DISCARDED it — every project gone at
 * once, while the media in OPFS survived. OPFS is a different storage engine
 * with atomic writes (a writable stream lands only when it closes), so a record
 * mirrored here outlives the database. The store mirrors every write and, on
 * the first read of a session, puts back whatever the database lost.
 *
 * Writes are coalesced per record (a burst of autosaves is one file write) and
 * flushed when the page is hidden. A delete is mirrored too, so a purged
 * project never comes back.
 */

type Kind = "project" | "folder";
/** A record (metadata) is JSON of the row; a document file is the document's own JSON. */
type Pending = { name: string; text: string | null };

const DIR = "project-mirror";
const FLUSH_MS = 2_000;

let dirPromise: Promise<FileSystemDirectoryHandle | null> | null = null;
function dir(): Promise<FileSystemDirectoryHandle | null> {
  dirPromise ??= (async () => {
    try {
      if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
      const root = await navigator.storage.getDirectory();
      return await root.getDirectoryHandle(DIR, { create: true });
    } catch {
      return null;
    }
  })();
  return dirPromise;
}

/**
 * A project is TWO files, like its two database rows: `project-<id>.json` (the
 * metadata — rewritten by every rename, move and trash) and `doc-<id>.json`
 * (the document — rewritten only by a save). Before v3 the project file held
 * the document too; such a file is still read (`readMirroredRecord`) and is
 * replaced by the pair the first time that project is mirrored again.
 */
const fileName = (kind: Kind, id: string) => `${kind}-${id}.json`;
const docFileName = (id: string) => `doc-${id}.json`;

const pending = new Map<string, Pending>();
let timer = 0;

function schedule(): void {
  if (typeof window === "undefined") return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void flushMirror(), FLUSH_MS);
}

export function mirrorPut(kind: Kind, record: ProjectRecord | FolderRecord): void {
  const name = fileName(kind, record.id);
  pending.set(name, { name, text: JSON.stringify(record) });
  schedule();
}

/** Mirror a project's document. Its text is written as is: it already is the document's JSON. */
export function mirrorPutDoc(id: string, docJson: string): void {
  const name = docFileName(id);
  pending.set(name, { name, text: docJson });
  schedule();
}

export function mirrorDelete(kind: Kind, id: string): void {
  for (const name of kind === "project" ? [fileName(kind, id), docFileName(id)] : [fileName(kind, id)]) {
    pending.set(name, { name, text: null });
  }
  schedule();
}

/** Write everything pending now. Never throws: the mirror must not break a save. */
export async function flushMirror(): Promise<void> {
  if (pending.size === 0) return;
  const d = await dir();
  const batch = [...pending.values()];
  pending.clear();
  if (!d) return;
  for (const p of batch) {
    try {
      if (p.text === null) {
        await d.removeEntry(p.name).catch(() => {});
        continue;
      }
      const handle = await d.getFileHandle(p.name, { create: true });
      const out = await handle.createWritable();
      await out.write(p.text);
      await out.close();
    } catch {
      /* a full disk or a revoked handle: the database copy still stands */
    }
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => void flushMirror());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushMirror();
  });
}

/** Which records and documents the mirror holds — by file NAME, without reading one. */
export async function mirroredIds(): Promise<{ projects: Set<string>; folders: Set<string>; docs: Set<string> }> {
  const out = { projects: new Set<string>(), folders: new Set<string>(), docs: new Set<string>() };
  const d = await dir();
  if (!d) return out;
  try {
    for await (const [name, handle] of (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind !== "file" || !name.endsWith(".json")) continue;
      const m = /^(project|folder|doc)-(.+)\.json$/.exec(name);
      if (!m) continue;
      (m[1] === "project" ? out.projects : m[1] === "folder" ? out.folders : out.docs).add(m[2]!);
    }
  } catch {
    /* no iteration support: nothing to recover */
  }
  return out;
}

async function readText(name: string): Promise<string | null> {
  const d = await dir();
  if (!d) return null;
  try {
    return await (await (await d.getFileHandle(name)).getFile()).text();
  } catch {
    return null;
  }
}

/** One mirrored record, or null when it is missing or torn. */
export async function readMirroredRecord<T>(kind: Kind, id: string): Promise<T | null> {
  const text = await readText(fileName(kind, id));
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** One mirrored document's JSON, or null. */
export function readMirroredDoc(id: string): Promise<string | null> {
  return readText(docFileName(id));
}
