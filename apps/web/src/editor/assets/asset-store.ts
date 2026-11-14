"use client";

/**
 * The asset BLOB store — bytes only. Document JSON stays small: it holds asset
 * metadata (core `Asset`), while the file bodies live here, keyed by asset id.
 *
 * Storage: OPFS (Origin Private File System) when available — the right home
 * for large media in an offline-first app. Falls back to IndexedDB blobs on
 * browsers without OPFS. All reads go through an object-URL cache so render
 * paths never await.
 */

import { isSequenceBlob, openSequence, sequenceFrameBlob } from "./sequence-file";
import { NAMES } from "@/editor/names";

const IDB_NAME = NAMES.databases.assets;
const IDB_STORE = "blobs";

let opfsDirPromise: Promise<FileSystemDirectoryHandle | null> | null = null;

function opfsDir(): Promise<FileSystemDirectoryHandle | null> {
  if (!opfsDirPromise) {
    opfsDirPromise = (async () => {
      try {
        if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
        const root = await navigator.storage.getDirectory();
        return await root.getDirectoryHandle("assets", { create: true });
      } catch {
        return null;
      }
    })();
  }
  return opfsDirPromise;
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
  });
}

async function idbPut(id: string, blob: Blob): Promise<void> {
  const db = await openIdb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(id: string): Promise<Blob | null> {
  const db = await openIdb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(id);
    req.onsuccess = () => resolve((req.result as Blob) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(id: string): Promise<void> {
  const db = await openIdb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Media is the one thing in a project that has no second copy: the document
 * is mirrored (`project-mirror`), its bytes are not. A browser that treats the
 * origin as "best effort" may drop them under storage pressure while a session
 * still holds them decoded — so the media plays and exports until the next
 * load, then is gone. Asking once, on the first write, for persistent storage
 * is the standard defence (Chromium grants it silently to an installed or
 * engaged app; Firefox asks). Refused is fine: the export's media check names
 * anything that went missing, and re-importing the same file restores it.
 */
let persistAsked = false;
function askToPersist(): void {
  if (persistAsked) return;
  persistAsked = true;
  void navigator.storage?.persist?.().catch(() => false);
}

export async function putAssetBlob(id: string, blob: Blob): Promise<void> {
  askToPersist();
  const dir = await opfsDir();
  if (dir) {
    const handle = await dir.getFileHandle(id, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  } else {
    await idbPut(id, blob);
  }
  bytesChanged(id);
}

export async function getAssetBlob(id: string): Promise<Blob | null> {
  const dir = await opfsDir();
  if (dir) {
    try {
      const handle = await dir.getFileHandle(id);
      return await handle.getFile();
    } catch {
      // Not in OPFS — maybe written before OPFS was available.
    }
  }
  try {
    return await idbGet(id);
  } catch {
    return null;
  }
}

/**
 * THE INVARIANT THIS STORE KEEPS: an asset the open document still lists has
 * its bytes. Five callers delete bytes (the release sweep, raster surfaces, a
 * render in place cleaning up…) and each was right on its own; together, a
 * Two Balls build lost three listed sound stems twice in one session, and the
 * export refused them as "not on this device" while the library showed them.
 * Enforced HERE, at the one function bytes leave through, so no caller — this
 * year's or next year's — can break it: a delete of a listed id is refused and
 * named in the console with its caller, never carried out.
 */
let listedNow: (id: string) => boolean = () => false;

/** The document store says which ids are listed (`document-context`). */
export function keepListedAssetBytes(isListed: (id: string) => boolean): void {
  listedNow = isListed;
}

export async function deleteAssetBlob(id: string): Promise<void> {
  if (listedNow(id)) {
    console.warn(`[assets] refused to delete the bytes of ${id}: the open project still lists it`, new Error("deleteAssetBlob caller").stack);
    return;
  }
  bytesChanged(id);
  const dir = await opfsDir();
  if (dir) {
    try {
      await dir.removeEntry(id);
    } catch {
      // Fine — may only exist in IDB.
    }
  }
  try {
    await idbDelete(id);
  } catch {
    // Nothing to delete.
  }
}

/** id → object URL, resolved once and reused for the session. */
const urlCache = new Map<string, Promise<string | null>>();

/**
 * Object URL for an asset's bytes. `mimeHint` matters: OPFS round-trips return
 * a File with an EMPTY `type`, and `<img>` won't render an SVG (or other
 * text-based image) from a typeless blob URL — browsers don't content-sniff SVG
 * into <img> for security. Re-wrapping the blob with the known asset mime fixes
 * SVGs (and is harmless for binary formats that sniff fine on their own).
 */
export function assetObjectURL(id: string, mimeHint?: string): Promise<string | null> {
  let cached = urlCache.get(id);
  if (!cached) {
    cached = getAssetBlob(id).then(async (blob) => {
      if (!blob) return null;
      // An image SEQUENCE answers every "show me this image" with its first
      // frame — library cards, posters, the still that stands in while its
      // frames decode — so nothing that treats it as a picture needs to know.
      if (await isSequenceBlob(blob)) return URL.createObjectURL(sequenceFrameBlob(await openSequence(blob), 0));
      const typed = !blob.type && mimeHint ? new Blob([blob], { type: mimeHint }) : blob;
      return URL.createObjectURL(typed);
    });
    urlCache.set(id, cached);
  }
  return cached;
}

const bytesListeners = new Set<(id: string) => void>();

/**
 * Hear when an asset's bytes are written or deleted. Every cache made FROM the
 * bytes — decoded pictures, video elements, decoded sound — subscribes here,
 * so a relink or a restore under the same id reaches all of them; a caller
 * that had to remember each cache by name forgot the audio one, and a sound
 * that once failed to decode stayed "undecodable" after its file came back.
 */
export function onAssetBytesChanged(cb: (id: string) => void): () => void {
  bytesListeners.add(cb);
  return () => bytesListeners.delete(cb);
}

function bytesChanged(id: string): void {
  void urlCache.get(id)?.then((u) => u && URL.revokeObjectURL(u));
  urlCache.delete(id);
  for (const cb of bytesListeners) cb(id);
}

/** True when an asset's bytes are present in this device's store. */
export async function hasAssetBlob(id: string): Promise<boolean> {
  return (await getAssetBlob(id)) !== null;
}
