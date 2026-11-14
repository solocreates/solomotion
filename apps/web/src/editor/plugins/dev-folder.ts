"use client";

import { toast } from "@/lib/toast";
import { installPlugin, type InstallResult } from "./install";

/**
 * Developer live-reload. When a plugin is imported from a folder (Chromium FS
 * Access API), we keep its directory handle in memory for the session and poll
 * the files' modified times; any change re-installs the plugin, so the open
 * window picks it up instantly — the Figma-in-Electron workflow, in the browser.
 *
 * Handles are session-only (not persisted): after a refresh a dev re-connects
 * the folder, which also re-grants permission cleanly. No IDB handle storage, no
 * stale-permission dance.
 */

const handles = new Map<string, FileSystemDirectoryHandle>();
const lastSeen = new Map<string, number>();

export function rememberDevHandle(id: string, handle: FileSystemDirectoryHandle): void {
  handles.set(id, handle);
  lastSeen.delete(id); // re-baseline on next tick
}

export function hasDevHandle(id: string): boolean {
  return handles.has(id);
}

export function forgetDevHandle(id: string): void {
  handles.delete(id);
  lastSeen.delete(id);
}

export async function reloadFromFolder(id: string): Promise<InstallResult | null> {
  const handle = handles.get(id);
  if (!handle) return null;
  return installPlugin({ kind: "folder", handle, folderName: handle.name });
}

/** Minimal directory shape — the DOM lib omits the async iterators. */
interface DirEntryHandle {
  kind: "file" | "directory";
  name: string;
  getFile?: () => Promise<File>;
  entries?: () => AsyncIterableIterator<[string, DirEntryHandle]>;
}

/** Newest lastModified across the folder — cheap (metadata only, no byte reads). */
async function newestMtime(dir: FileSystemDirectoryHandle): Promise<number> {
  let newest = 0;
  async function walk(handle: DirEntryHandle): Promise<void> {
    if (!handle.entries) return;
    for await (const [name, child] of handle.entries()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      if (child.kind === "file" && child.getFile) {
        newest = Math.max(newest, (await child.getFile()).lastModified);
      } else if (child.kind === "directory") {
        await walk(child);
      }
    }
  }
  await walk(dir as unknown as DirEntryHandle);
  return newest;
}

/** Start the global dev-folder watcher. Returns a stop function. */
export function startDevWatch(): () => void {
  let stopped = false;
  const tick = async () => {
    for (const [id, handle] of handles) {
      try {
        const mtime = await newestMtime(handle);
        const prev = lastSeen.get(id);
        if (prev === undefined) {
          lastSeen.set(id, mtime);
        } else if (mtime > prev) {
          lastSeen.set(id, mtime);
          const res = await reloadFromFolder(id);
          if (res) toast.success(`Reloaded “${res.name}”`);
        }
      } catch {
        // Folder went away / permission lost — drop it silently.
        forgetDevHandle(id);
      }
    }
    if (!stopped) timer = window.setTimeout(tick, 1200);
  };
  let timer = window.setTimeout(tick, 1200);
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}
