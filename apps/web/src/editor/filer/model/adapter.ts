/**
 * The one seam between the headless filer engine and a concrete surface. A
 * surface (projects, later media) implements `FilerAdapter` to load its tree and
 * persist tree operations; everything else — selection, drag, clipboard,
 * marquee, search, the whole UI — is surface-agnostic and lives above this. All
 * ops take/return plain data so they can back onto IndexedDB, a doc mutation, or
 * a network call without the engine caring.
 */

import type { FilerFolder, FilerItem, FilerTree } from "./tree";

/** A trashed group as surfaced in Recently Deleted (root node + its size). */
export interface FilerTrashEntry<T = unknown> {
  node: FilerFolder | FilerItem<T>;
  /** Nodes (root + descendants) that restore / purge together. */
  count: number;
}

export interface FilerAdapter<T = unknown> {
  /** Load the full live tree (all folders + items, not yet filtered by folder). */
  load(): Promise<FilerTree<T>>;

  /** Create a folder and return its new id (so callers can move items into it). */
  createFolder(parentId: string | null, name: string): Promise<string>;
  rename(id: string, name: string): Promise<void>;
  /** Reparent nodes (folders and/or items) into `targetParentId` (null = root). */
  move(ids: string[], targetParentId: string | null): Promise<void>;
  /** Delete nodes. Soft-delete (projects) or hard-remove (media) — surface's call. */
  trash(ids: string[]): Promise<void>;
  /** Primary action for an item (projects: open it in the editor). */
  open(item: FilerItem<T>): void;

  // Optional capabilities — the UI shows a control only when its method exists.
  /** Copy items beside their originals; returns nothing (caller reloads). */
  duplicate?(ids: string[]): Promise<void>;
  /** Recently-Deleted support (soft-delete surfaces only). */
  loadTrash?(): Promise<FilerTrashEntry<T>[]>;
  restore?(rootIds: string[]): Promise<void>;
  purge?(rootIds: string[]): Promise<void>;
}
