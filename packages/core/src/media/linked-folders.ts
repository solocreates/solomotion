import type { LinkedFolder, LinkedIndexEntry } from "../schema/assets";

/**
 * The headless brain for keeping a media folder in sync with a real on-disk
 * folder. Pure and platform-free: it works over fingerprints (relative path +
 * mtime + size), never touching the filesystem, a handle, or the asset store —
 * so it's identical on web and native and trivially testable. The app layer
 * feeds it a scan and acts on the diff (import added/changed, forget removed).
 */

/** One file found on disk during a scan — the platform's job to produce. */
export interface ScannedFile {
  /** Path relative to the linked root, POSIX-separated. The stable dedup key. */
  relPath: string;
  mtimeMs: number;
  size: number;
}

/** What changed since the last sync — the app imports/forgets accordingly. */
export interface LinkedFolderDiff {
  /** Paths not seen before → import as new assets. */
  added: ScannedFile[];
  /** Paths whose bytes changed (mtime or size) → re-import onto the SAME asset id. */
  changed: Array<ScannedFile & { assetId: string }>;
  /** Asset ids whose source file is gone from disk. */
  removedAssetIds: string[];
  /** Count of files present and unchanged (UI / no-op fast path). */
  unchanged: number;
}

/** True when a scanned file differs from what the index recorded for its path. */
function isChanged(entry: LinkedIndexEntry, file: ScannedFile): boolean {
  return entry.mtimeMs !== file.mtimeMs || entry.size !== file.size;
}

/**
 * Diff a fresh directory scan against a linked folder's stored index. Dedupe is
 * by path first, then mtime+size — so re-syncing an unchanged folder does
 * nothing, a touched file re-imports in place (keeping its asset id so every
 * clip using it updates at once), and a deleted file surfaces as a removable
 * asset. Nothing here mutates the folder; {@link applyLinkedDiff} does that once
 * the app has created the new asset ids.
 */
export function diffLinkedFolder(index: LinkedFolder["index"], scan: ScannedFile[]): LinkedFolderDiff {
  const diff: LinkedFolderDiff = { added: [], changed: [], removedAssetIds: [], unchanged: 0 };
  const seen = new Set<string>();

  for (const file of scan) {
    seen.add(file.relPath);
    const entry = index[file.relPath];
    if (!entry) diff.added.push(file);
    else if (isChanged(entry, file)) diff.changed.push({ ...file, assetId: entry.assetId });
    else diff.unchanged++;
  }

  for (const [relPath, entry] of Object.entries(index)) {
    if (!seen.has(relPath)) diff.removedAssetIds.push(entry.assetId);
  }
  return diff;
}

/** A file the app imported/updated during a sync, ready to fold into the index. */
export interface SyncedFile {
  relPath: string;
  assetId: string;
  mtimeMs: number;
  size: number;
}

/**
 * Produce the next index after a sync: keep every unchanged/updated entry, add
 * the freshly-imported ones, and drop entries for the given removed paths. Pure
 * — the caller assigns the result back onto `folder.index` inside a store
 * update. `removedRelPaths` is derived from the same scan (paths in the old
 * index no longer present).
 */
export function applyLinkedDiff(
  index: LinkedFolder["index"],
  synced: SyncedFile[],
  removedRelPaths: string[],
): LinkedFolder["index"] {
  const next: LinkedFolder["index"] = { ...index };
  for (const path of removedRelPaths) delete next[path];
  for (const f of synced) next[f.relPath] = { assetId: f.assetId, mtimeMs: f.mtimeMs, size: f.size };
  return next;
}

/** Relative paths in the index whose file vanished from a scan (for index cleanup). */
export function removedRelPaths(index: LinkedFolder["index"], scan: ScannedFile[]): string[] {
  const seen = new Set(scan.map((f) => f.relPath));
  return Object.keys(index).filter((p) => !seen.has(p));
}
