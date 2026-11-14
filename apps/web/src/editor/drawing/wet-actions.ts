"use client";

import { locateClip, type MotionDocument, type DocumentStore } from "@solomotion/core";
import {
  dryLayer,
  hasWetPaint,
  onFilmSettled,
  surfaceForClip,
  surfaceIsBusy,
  wetLog,
} from "./raster-store";

/**
 * DRY THE PAINT — the command behind the options bar's Dry button.
 *
 * Wet paint lives on the water film, not in the layer's pixels, so drying is
 * the moment it becomes pixels. That makes it the undoable event: a wet stroke
 * commits nothing when the pen lifts (the wash is still moving), and this is
 * where a history step is finally worth taking.
 *
 * It dries EVERY wet layer in one step rather than asking which one, because
 * "dry my painting" is the request people actually have — and a wash that
 * bled across two layers should not need two commands to settle.
 */
export function dryWetPaint(store: DocumentStore, doc: MotionDocument, label = "Dry paint"): number {
  if (!hasWetPaint()) return 0;

  const targets: Array<{ id: string; rev: number }> = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "raster") continue;
      const surface = surfaceForClip(clip);
      // A film, wet or settled. Skipping settled ones is what let a wash that
      // dried on its own sit outside the bitmap forever — see `dryIntoSurface`.
      if (!surface.wet || surfaceIsBusy(surface.id)) continue;
      // `dryLayer` flattens the film into the bitmap and journals the change,
      // so the document only has to catch its `rev` up to the pixels.
      if (dryLayer(clip)) targets.push({ id: clip.id, rev: clip.rev + 1 });
    }
  }
  if (targets.length === 0) return 0;

  store.update(label, (d) => {
    for (const t of targets) {
      const located = locateClip(d, t.id);
      if (located?.clip.kind === "raster") located.clip.rev = t.rev;
    }
  });
  wetLog("dry-command", { layers: targets.length });
  return targets.length;
}

/**
 * WATER EVAPORATES WHETHER OR NOT YOU PRESS THE BUTTON.
 *
 * Drying was modelled as a command, so the simulation running a wash to nothing
 * on its own had no way to finish the job: the pigment stayed in the film, the
 * bitmap never saw it, and the paint was left in a state where the eraser could
 * not touch it, merge-down ignored it, the wand could not select it and undo
 * had no record of it. "I waited for it to dry and the eraser does nothing."
 *
 * So the simulation announces the moment instead, and it lands in the SAME
 * seam the button uses — one flatten path, one history step, no second way for
 * paint to become pixels. Mounted once beside the surface↔document sync,
 * because that is the other half of this exact relationship.
 */
export function watchSettlingPaint(store: DocumentStore): () => void {
  return onFilmSettled(() => dryWetPaint(store, store.getState(), "Paint dried"));
}
