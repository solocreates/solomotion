"use client";

import type { LibrarySnapshot } from "@solomotion/core";
import type { DragPreview, LibraryDrag } from "./session";
import { useWorkspace } from "./workspace";

/**
 * WHERE a `snapshot` drag's clips come from.
 *
 * Two sources answer one question. A SAVED component lives in the workspace
 * library and is addressed by its item id. Anything else a panel wants to drop
 * — an icon the icons plugin just built, a shape a future plugin generates —
 * is registered here for the life of the gesture and addressed by the ticket
 * it gets back. The receivers never learn which; they ask `resolveDragSnapshot`
 * and place what comes back through the ONE `placeSnapshot` seam.
 *
 * The transient table is tiny and self-cleaning: a ticket is dropped once the
 * drag ends (`releaseDragSnapshot`, called from the drag-out controller) or
 * when a later registration replaces it. Nothing here is persisted — a drag
 * is a mode you are in, not a thing you keep.
 */

interface Transient {
  name: string;
  snapshot: LibrarySnapshot;
}

const transient = new Map<string, Transient>();
let seq = 0;

/** Register clips for one drag; returns the id to put on the payload. */
export function registerDragSnapshot(name: string, snapshot: LibrarySnapshot): string {
  const id = `drag:${++seq}`;
  transient.set(id, { name, snapshot });
  return id;
}

/** Forget a transient snapshot — the drag it was made for is over. */
export function releaseDragSnapshot(id: string): void {
  transient.delete(id);
}

/** The clips behind a `snapshot` drag id, from whichever source holds them. */
export function resolveDragSnapshot(id: string): Transient | null {
  const live = transient.get(id);
  if (live) return live;
  const saved = useWorkspace.getState().customTemplates.find((t) => t.id === id);
  return saved ? { name: saved.name, snapshot: saved.snapshot } : null;
}

/**
 * The payload for dragging freshly built clips out of a panel — what a plugin
 * hands `startDragOut`. Registers the snapshot and names it in one call, so
 * the two cannot drift apart.
 */
export function snapshotDrag(
  name: string,
  snapshot: LibrarySnapshot,
  preview?: DragPreview,
): NonNullable<LibraryDrag> {
  return { kind: "snapshot", id: registerDragSnapshot(name, snapshot), label: name, preview };
}
