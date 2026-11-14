"use client";

import {
  addWorldClip,
  frameIntoWorld,
  isSpatialClip,
  locateClip,
  moveIntoWorld,
  type MotionDocument,
  type DocumentStore,
  type Frame,
  type NestedClip,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import { useSession } from "../state/session";
import { contentFrameIn } from "../state/clip-actions";
import { useWorldUi } from "./state";

/**
 * THE WAYS INTO 3D — one module, so the inspector's 3D button, "+ Clip › 3D
 * world", the layer menu, the navigator and the pages list all do the same
 * thing and land you in the same place: inside the world, in the viewport.
 *
 *   a layer / a group / several  → they move into a new world nested where
 *                                  they were (core `moveIntoWorld`)
 *   a frame (the main one too)   → everything in it moves into a world nested
 *                                  full-frame; the frame stays as the wrapper
 *                                  (core `frameIntoWorld`)
 *   + Clip › 3D world            → a fresh starter world as a layer
 *                                  (core `addWorldClip`)
 */

/** Open a world in the viewport, wherever it lives: inside the comp that nests it, or as an artboard of its own. */
export function openWorldFrame(store: DocumentStore, worldId: string, select: string[] = []): void {
  const doc = store.getState();
  const world = doc.frames.find((f) => f.id === worldId);
  if (!world?.world) return;
  const session = useSession.getState();
  // A selection from the comp you came from means nothing inside the world
  // (the inspector would show a layer you are no longer standing beside).
  session.select(select);
  session.revealFrame(worldId);
  // A root world artboard opens on purpose (a nested one opens by being entered).
  if (!worldHost(doc, worldId)) useWorldUi.getState().set({ openId: worldId });
}

/** The nested layer that shows a world, if one does. */
export function worldHost(doc: MotionDocument, worldId: string): NestedClip | null {
  for (const t of doc.tracks) for (const c of t.clips) if (c.kind === "nested" && c.sourceFrameId === worldId) return c;
  return null;
}

export interface WorldEntry {
  frame: Frame;
  host: NestedClip | null;
  /** Where it shows: the comp nesting it, or null for a root artboard. */
  parent: Frame | null;
}

/** Every world in the project, with where it lives — the navigator's and the pages list's source. */
export function worldEntries(doc: MotionDocument): WorldEntry[] {
  return doc.frames
    .filter((f) => f.world)
    .map((frame) => {
      const host = worldHost(doc, frame.id);
      return { frame, host, parent: host ? (doc.frames.find((f) => f.id === host.frameId) ?? null) : null };
    });
}

/** "+ Clip › 3D world": a starter world from the playhead, then straight in. */
export function addWorldAtPlayhead(store: DocumentStore): void {
  const session = useSession.getState();
  let made: { nestedId: string; frameId: string } | null = null;
  store.update("Add 3D world", (d) => {
    made = addWorldClip(d, contentFrameIn(d).id, { startMs: Math.max(0, session.playheadMs) });
  });
  const m = made as { nestedId: string; frameId: string } | null;
  if (!m) return;
  openWorldFrame(store, m.frameId);
  toast("A 3D world — ⇧A adds, G R S move, Tab edits", { description: "Esc or the back arrow steps out to the comp." });
}

/** Layers, groups or a mix: into a new world where they were, then in. */
export function makeClips3d(store: DocumentStore, ids: string[]): void {
  const doc = store.getState();
  const movable = ids.filter((id) => {
    const c = locateClip(doc, id)?.clip;
    return !!c && c.kind !== "audio" && !isSpatialClip(c) && !doc.frames.find((f) => f.id === c.frameId)?.world;
  });
  if (movable.length === 0) return;
  let moved: { nestedId: string; frameId: string } | null = null;
  store.update("Make 3D", (d) => void (moved = moveIntoWorld(d, movable, "3D world")));
  const m = moved as { nestedId: string; frameId: string } | null;
  if (!m) return void toast.error("Those layers can't move into a world");
  openWorldFrame(store, m.frameId);
  toast("In 3D — the same picture, now with depth", { description: "Orbit to see it; give layers Thickness in the inspector." });
}

/** A whole frame: its content into a world nested full-frame, the frame kept as the wrapper. */
export function makeFrame3d(store: DocumentStore, frameId: string): void {
  let made: { nestedId: string; frameId: string } | null = null;
  store.update("Make frame 3D", (d) => void (made = frameIntoWorld(d, frameId)));
  const m = made as { nestedId: string; frameId: string } | null;
  if (!m) return;
  openWorldFrame(store, m.frameId);
  toast("The frame's content is a 3D world now", { description: "The frame stays your artboard; the world lives inside it." });
}
