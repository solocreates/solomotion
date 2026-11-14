"use client";
import { identity } from "@/editor/identity";
import { NAMES } from "@/editor/names";

/**
 * Where a project saves to on disk. The File System Access API lets us keep a
 * live `FileSystemFileHandle` and OVERWRITE the same `.motion` file on ⌘S — a
 * real "save in place". Handles are structured-cloneable, so we persist them
 * per project in IndexedDB (alongside the remembered "include media" choice and
 * file name). Browsers without the API (Firefox/Safari) store a handle-less
 * target and fall back to a fresh download each save.
 */

/** Minimal typings for the File System Access API (not in the base DOM lib). */
interface FsPermissionDescriptor {
  mode?: "read" | "readwrite";
}
interface FsFileHandle extends FileSystemFileHandle {
  queryPermission?: (d?: FsPermissionDescriptor) => Promise<PermissionState>;
  requestPermission?: (d?: FsPermissionDescriptor) => Promise<PermissionState>;
}
interface FilePickerTypes {
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}
interface SaveFilePickerOptions extends FilePickerTypes {
  suggestedName?: string;
}
interface OpenFilePickerOptions extends FilePickerTypes {
  multiple?: boolean;
}
type WindowWithFsa = Window & {
  showSaveFilePicker?: (opts?: SaveFilePickerOptions) => Promise<FsFileHandle>;
  showOpenFilePicker?: (opts?: OpenFilePickerOptions) => Promise<FsFileHandle[]>;
};

export interface SaveTarget {
  projectId: string;
  /** The on-disk file handle, or null in download-only browsers. */
  handle: FsFileHandle | null;
  includeMedia: boolean;
  fileName: string;
}

const DB_NAME = NAMES.databases.saveTargets;
const STORE = "targets";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "projectId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
  });
}

export async function getSaveTarget(projectId: string): Promise<SaveTarget | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    return await new Promise<SaveTarget | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(projectId);
      req.onsuccess = () => resolve((req.result as SaveTarget) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function putSaveTarget(target: SaveTarget): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(target);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Non-fatal — we just won't remember the target next session.
  }
}

/** Is the File System Access "save file" picker available (true in-place saves)? */
export function canUseFilePicker(): boolean {
  return typeof window !== "undefined" && typeof (window as WindowWithFsa).showSaveFilePicker === "function";
}

/** Prompt for a save location; returns the handle, or null if the user cancels. */
export async function pickSaveFile(suggestedName: string): Promise<FsFileHandle | null> {
  const picker = (window as WindowWithFsa).showSaveFilePicker;
  if (!picker) return null;
  try {
    return await picker({
      suggestedName,
      types: [{ description: `${identity.name} project`, accept: { "application/zip": [".motion"] } }],
    });
  } catch {
    return null; // AbortError when the user dismisses the dialog.
  }
}

/** Is the File System Access "open file" picker available (writable handle on open)? */
export function canUseOpenPicker(): boolean {
  return typeof window !== "undefined" && typeof (window as WindowWithFsa).showOpenFilePicker === "function";
}

/**
 * Open a project file THROUGH the File System Access picker, so we keep a
 * writable handle to it — that's what lets ⌘S later overwrite the very file the
 * user opened (a plain <input> never yields a writable handle). Null on cancel.
 */
export async function pickOpenFile(): Promise<{ handle: FsFileHandle; file: File } | null> {
  const picker = (window as WindowWithFsa).showOpenFilePicker;
  if (!picker) return null;
  try {
    const [handle] = await picker({
      types: [{ description: `${identity.name} project`, accept: { "application/zip": [".motion"], "application/json": [".json"] } }],
      multiple: false,
    });
    if (!handle) return null;
    return { handle, file: await handle.getFile() };
  } catch {
    return null; // AbortError when the user dismisses the dialog.
  }
}

/** Ensure we can write to a stored handle, re-requesting permission if needed. */
export async function ensureHandlePermission(handle: FsFileHandle): Promise<boolean> {
  const opts: FsPermissionDescriptor = { mode: "readwrite" };
  try {
    if (handle.queryPermission && (await handle.queryPermission(opts)) === "granted") return true;
    if (handle.requestPermission && (await handle.requestPermission(opts)) === "granted") return true;
    return !handle.queryPermission; // no permission API → nothing to gate on.
  } catch {
    return false;
  }
}

export async function writeBlobToHandle(handle: FsFileHandle, blob: Blob): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/** Trigger a browser download (the fallback when there's no file handle). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Filesystem-safe base name (matches the export pipeline's convention). */
export function safeName(name: string): string {
  return name.replace(/[^\w\d-]+/g, "-").replace(/^-+|-+$/g, "") || NAMES.files.fallbackName;
}
