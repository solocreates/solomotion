"use client";

import {
  applyLinkedDiff,
  createId,
  diffLinkedFolder,
  removedRelPaths,
  type DocumentStore,
  type LinkedFolder,
  type ScannedFile,
  type SyncedFile,
} from "@solomotion/core";
import { create } from "zustand";
import { type DirectoryRef, type FolderScanFile } from "@solomotion/platform";
import { platform } from "@/editor/platform";
import { toast } from "@/lib/toast";
import { assetKindForFile, importFileAsAsset, linkFileToAsset } from "./import";
import { appFileToFile } from "./app-file";
import { releaseAssetBytes } from "./release-bytes";
import { clipAssetId } from "./media-usage";

/**
 * Linked media folders — a media-library folder that mirrors a real folder on
 * disk and stays in sync. This is the app-side ORCHESTRATOR: it wires the
 * headless diff brain (`diffLinkedFolder`, core) to the platform folder port
 * (pick/scan/watch, web + native) and the ONE import pipeline. All filesystem
 * reach is behind `platform.folder`; all sync math is core — this file only
 * moves files through the importer and folds the result back into the index.
 */

/** In-progress sync state, so the UI can show a spinner + disable actions. */
interface LinkedSyncState {
  /** Folder ids currently syncing. */
  syncing: Set<string>;
  begin(id: string): void;
  end(id: string): void;
}
export const useLinkedSync = create<LinkedSyncState>((set) => ({
  syncing: new Set(),
  begin: (id) => set((s) => ({ syncing: new Set(s.syncing).add(id) })),
  end: (id) =>
    set((s) => {
      const next = new Set(s.syncing);
      next.delete(id);
      return { syncing: next };
    }),
}));

/** Live watch teardown fns, keyed by folder id — outside React so they persist. */
const watchers = new Map<string, () => void>();

/** True when a folder can be linked for live re-scan on this host. */
export function canLinkFolders(): boolean {
  return platform.folder.canLink();
}

const scanned = (f: FolderScanFile): ScannedFile => ({ relPath: f.relPath, mtimeMs: f.mtimeMs, size: f.size });

/**
 * The heart of sync: scan the ref, diff it against the folder's index, then
 * import what's new/changed and forget what's gone — as few document writes as
 * possible, ending with the index + timestamp refreshed. `interactive` allows a
 * permission re-request (only true when triggered by a user gesture).
 */
async function runSync(store: DocumentStore, folderId: string, interactive: boolean): Promise<void> {
  const folder = store.getState().mediaFolders.find((f) => f.id === folderId);
  const linked = folder?.linked;
  if (!linked) return;
  if (useLinkedSync.getState().syncing.has(folderId)) return; // no overlap

  useLinkedSync.getState().begin(folderId);
  try {
    if (interactive && !(await platform.folder.ensureAccess(linked.ref))) {
      toast.error(`Grant access to “${linked.ref.name}” to sync it`);
      return;
    }
    const files = await platform.folder.scan(linked.ref);
    // No files AND an empty index usually means access lapsed, not an empty
    // folder — don't wipe a populated index on a failed scan.
    if (files.length === 0 && Object.keys(linked.index).length > 0 && !interactive) return;

    const byPath = new Map(files.map((f) => [f.relPath, f]));
    const diff = diffLinkedFolder(linked.index, files.map(scanned));

    const synced: SyncedFile[] = [];

    // NEW files → import as fresh assets in this folder.
    for (const add of diff.added) {
      const src = byPath.get(add.relPath);
      if (!src) continue;
      const asset = await importFileAsAsset(store, await appFileToFile(src));
      if (!asset) continue;
      store.update("Sync folder", (d) => {
        const a = d.assets.find((x) => x.id === asset.id);
        if (a) a.folderId = folderId;
      });
      synced.push({ relPath: add.relPath, assetId: asset.id, mtimeMs: add.mtimeMs, size: add.size });
    }

    // CHANGED files → re-point the SAME asset id to the new bytes (every clip
    // using it updates at once).
    for (const chg of diff.changed) {
      const src = byPath.get(chg.relPath);
      if (!src) continue;
      const file = await appFileToFile(src);
      const kind = assetKindForFile(file);
      if (!kind) continue;
      const ok = await linkFileToAsset(store, { assetId: chg.assetId, kind, name: file.name }, file);
      if (ok) synced.push({ relPath: chg.relPath, assetId: chg.assetId, mtimeMs: chg.mtimeMs, size: chg.size });
    }

    // REMOVED on disk → drop from the library only when no clip uses it (a used
    // asset stays so its clip keeps playing), and always drop from the index.
    const gonePaths = removedRelPaths(linked.index, files.map(scanned));
    if (diff.removedAssetIds.length) {
      const d = store.getState();
      const used = new Set<string>();
      for (const t of d.tracks) for (const c of t.clips) {
        const id = clipAssetId(c);
        if (id) used.add(id);
      }
      const removable = diff.removedAssetIds.filter((id) => !used.has(id));
      if (removable.length) {
        const set = new Set(removable);
        store.update("Sync folder", (dd) => {
          dd.assets = dd.assets.filter((a) => !set.has(a.id));
        });
        releaseAssetBytes(store, removable);
      }
    }

    // Fold the result into the folder's index + stamp the sync time.
    store.update("Sync folder", (d) => {
      const f = d.mediaFolders.find((x) => x.id === folderId);
      if (f?.linked) {
        f.linked.index = applyLinkedDiff(f.linked.index, synced, gonePaths);
        f.linked.syncedAt = new Date().toISOString();
      }
    });

    const changes = diff.added.length + diff.changed.length + diff.removedAssetIds.length;
    if (interactive) {
      toast(changes === 0 ? `“${linked.ref.name}” is up to date` : `Synced “${linked.ref.name}” · ${changes} change${changes === 1 ? "" : "s"}`);
    }
  } catch {
    if (interactive) toast.error("Couldn't sync the folder");
  } finally {
    useLinkedSync.getState().end(folderId);
  }
}

/** Kick a sync (user-triggered = interactive: may re-prompt for access). */
export function syncLinkedFolder(store: DocumentStore, folderId: string, interactive = true): Promise<void> {
  return runSync(store, folderId, interactive);
}

/** Begin watching a linked folder for on-disk changes (native; no-op on web). */
function startWatch(store: DocumentStore, folderId: string, ref: DirectoryRef): void {
  watchers.get(folderId)?.();
  watchers.set(
    folderId,
    platform.folder.watch(ref, () => void runSync(store, folderId, false)),
  );
}

/**
 * Link a NEW folder: pick a directory, create the mirroring media folder, do the
 * first sync, and start watching. Returns the new folder id (or null if the pick
 * was cancelled / unsupported).
 */
export async function linkFolder(store: DocumentStore, parentId: string | null): Promise<string | null> {
  const ref = await platform.folder.pick();
  if (!ref) return null;

  const folderId = createId("mfolder");
  // Normalize the ref into the doc's serializable shape (path is always defined).
  const linked: LinkedFolder = {
    ref: { id: ref.id, name: ref.name, path: ref.path ?? null },
    index: {},
    syncedAt: null,
  };
  store.update("Link folder", (d) => {
    d.mediaFolders.push({ id: folderId, name: ref.name, parentId, linked });
  });
  await runSync(store, folderId, true);
  startWatch(store, folderId, ref);
  return folderId;
}

/** Stop syncing a folder: drop the live handle/watch, keep the imported assets. */
export async function unlinkFolder(store: DocumentStore, folderId: string): Promise<void> {
  const folder = store.getState().mediaFolders.find((f) => f.id === folderId);
  const ref = folder?.linked?.ref;
  watchers.get(folderId)?.();
  watchers.delete(folderId);
  if (ref) await platform.folder.forget(ref);
  store.update("Unlink folder", (d) => {
    const f = d.mediaFolders.find((x) => x.id === folderId);
    if (f) f.linked = null;
  });
  if (ref) toast(`Unlinked “${ref.name}” — its media stays in the library`);
}

/**
 * Resume watches for every linked folder in the freshly-loaded document (native
 * only — web has no watch and re-scans on focus). Call once after a project
 * opens. Idempotent.
 */
export function resumeLinkedWatches(store: DocumentStore): void {
  for (const f of store.getState().mediaFolders) {
    if (f.linked && !watchers.has(f.id)) startWatch(store, f.id, f.linked.ref);
  }
}

/**
 * Re-scan all linked folders — the web's stand-in for a filesystem watch, wired
 * to window focus. Non-interactive so it never nags for permission; a lapsed
 * handle just skips until the user hits Sync.
 */
export function rescanLinkedFoldersOnFocus(store: DocumentStore): void {
  for (const f of store.getState().mediaFolders) {
    if (f.linked) void runSync(store, f.id, false);
  }
}
