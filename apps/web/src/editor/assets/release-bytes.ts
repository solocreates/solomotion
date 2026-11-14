"use client";

import type { DocumentStore } from "@solomotion/core";
import { idsInSavedProjects } from "../state/project-store";
import { deleteAssetBlob } from "./asset-store";

/**
 * THE ONE WAY MEDIA BYTES LEAVE THIS DEVICE.
 *
 * Bytes have no second copy (the document is mirrored, its media is not), so
 * an edit that drops an asset never deletes them itself. Five paths used to —
 * deleting from the Media panel, forgetting missing clips, cleaning up a
 * render in place, a linked folder losing a file — each inside an undoable
 * step. Undo brought the asset back with nothing behind it, and every layer on
 * it read "not on this device" until the file was imported again. A
 * duplicated project shares its media by id, so the copy lost it too.
 *
 * Here an id is freed only when nothing can use it: not the document, not any
 * undo or redo step (`DocumentStore.reaches`), not any saved project, trash
 * included. One still reachable is kept and asked again after later edits, so
 * a delete whose undo has scrolled out of history is freed then.
 */
const waiting = new Map<DocumentStore, Set<string>>();

export function releaseAssetBytes(store: DocumentStore, ids: Iterable<string>): void {
  let held = waiting.get(store);
  if (!held) {
    held = new Set();
    waiting.set(store, held);
    const set = held;
    // Asked again after edits, never more than once a few seconds.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = store.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void sweep(store, set).then(() => {
          if (set.size === 0) {
            off();
            waiting.delete(store);
          }
        });
      }, 3000);
    });
  }
  for (const id of ids) held.add(id);
  void sweep(store, held);
}

async function sweep(store: DocumentStore, held: Set<string>): Promise<void> {
  const loose = [...held].filter((id) => !store.reaches(id));
  if (loose.length === 0) return;
  const saved = await idsInSavedProjects(loose);
  for (const id of loose) {
    if (saved.has(id) || store.reaches(id)) continue;
    held.delete(id);
    await deleteAssetBlob(id);
  }
}
