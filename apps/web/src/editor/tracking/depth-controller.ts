"use client";

import { create } from "zustand";
import { MDF, clipBox, createDepthTracker, createLayerEffect, findVisualClip, moveIntoWorld, setDepthSolve, type DepthSolve, type DocumentStore, type LayerEffect } from "@solomotion/core";
import { openWorldFrame } from "../world/make-3d";
import { useSession } from "../state/session";
import { startTrack } from "./track-controller";

/**
 * Depth's actions — each one labelled update. The run itself is an ordinary
 * track run (`startTrack` → the analysis worker → the depth store), so it
 * shares the transport, the activity ring and the coverage strip.
 */

/** A depth tracker on this footage, running at once. */
export function findDepthOf(store: DocumentStore, clipId: string): string | null {
  let id = "";
  store.update("Find depth", (d) => {
    id = createDepthTracker(d, { clipId })?.id ?? "";
  });
  if (!id) return null;
  useSession.getState().setActiveTracker(id);
  void startTrack(store, id);
  return id;
}

export function patchDepthSolve(store: DocumentStore, trackerId: string, patch: Partial<DepthSolve>): void {
  store.update("Depth settings", (d) => setDepthSolve(d, trackerId, patch));
}

/**
 * A depth card on a layer: Fog or Lens blur on the footage itself, "Behind"
 * on a layer above it (reading the footage's depth). Selects the layer so the
 * card is in front of you to tune.
 */
export function addDepthEffect(store: DocumentStore, clipId: string, type: "fog" | "lensBlur" | "depthMatte", footageId?: string): void {
  store.update(type === "fog" ? "Fog" : type === "lensBlur" ? "Lens blur" : "Behind", (d) => {
    const clip = findVisualClip(d, clipId);
    if (!clip) return;
    const fx = createLayerEffect(type) as Extract<LayerEffect, { type: "fog" | "lensBlur" | "depthMatte" }>;
    if (footageId && footageId !== clipId) fx.source = footageId;
    clip.effects.push(fx);
  });
  useSession.getState().select([clipId]);
}

/**
 * STILL → RELIEF — the picture stands up in 3D on its own depth: moved into a
 * world (if it is not in one), given Displace › Its depth, which refines the
 * card and pushes the near things toward the camera. Near / Far / Curve on
 * the card shape it; Strength is how deep. One undo step.
 */
export function makeRelief(store: DocumentStore, clipId: string): void {
  let worldId: string | null = null;
  store.update("Relief", (d) => {
    const clip = findVisualClip(d, clipId);
    if (!clip) return;
    const home = d.frames.find((f) => f.id === clip.frameId);
    worldId = home?.world ? home.id : (moveIntoWorld(d, [clipId], "Relief")?.frameId ?? null);
    const moved = findVisualClip(d, clipId);
    if (!worldId || !moved) return;
    const relief = { ...MDF.create("displace"), source: "depth", strength: Math.round(clipBox(d, moved).width * 0.25), midlevel: 0, near: 0, far: 1, curve: 1 };
    moved.modifiers = [...(moved.modifiers ?? []), relief];
  });
  const id = worldId as string | null;
  if (id) openWorldFrame(store, id, [clipId]);
}

/** Whether the stage shows the active depth tracker's map over its footage. */
export const useDepthView = create<{ show: boolean; set: (show: boolean) => void }>((set) => ({ show: false, set: (show) => set({ show }) }));
