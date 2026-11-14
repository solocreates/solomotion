import { create } from "zustand";
import {
  clipEnd,
  flipbookOf,
  flipbookRows,
  locateClip,
  pasteFlipbookCellsAt,
  type DocumentStore,
} from "@solomotion/core";
import { cloneSurfacePixels } from "./raster-store";

/**
 * The flipbook sheet's cell clipboard — cut/copy of cell ids with paste
 * semantics (Finder-style): cut then paste MOVES the originals, copy then
 * paste deep-duplicates them (own drawing, own surfaces). A cut set renders
 * dimmed in the sheet until it's pasted or cleared (⎋). Held here, not in the
 * document — it's ephemeral UI state, same footing as the generic clip
 * clipboard in clip-actions.ts, just scoped to cells so paste can apply the
 * flipbook's own row/ripple rules instead of a generic clip drop.
 */
interface FlipbookClipboardState {
  mode: "cut" | "copy" | null;
  cellIds: string[];
}

export const useFlipbookClipboard = create<FlipbookClipboardState>(() => ({
  mode: null,
  cellIds: [],
}));

export function copyFlipbookCells(cellIds: string[]): void {
  if (cellIds.length === 0) return;
  useFlipbookClipboard.setState({ mode: "copy", cellIds });
}

export function cutFlipbookCells(cellIds: string[]): void {
  if (cellIds.length === 0) return;
  useFlipbookClipboard.setState({ mode: "cut", cellIds });
}

export function clearFlipbookClipboard(): void {
  useFlipbookClipboard.setState({ mode: null, cellIds: [] });
}

/** Where a paste lands: right after a cell, exactly on a void slot, or (when
 *  neither applies) appended at the end of the sheet's first row. */
export type FlipbookPasteTarget = { afterCellId: string } | { trackId: string; atMs: number } | null;

/**
 * Resolve the pending clipboard against `flipbookId` and commit the paste at
 * `target`. Returns the ids of the cells now sitting in the sheet (select
 * them), or null if there was nothing pasteable. A cut clears itself once it
 * lands; a copy can paste again.
 */
export function pasteFlipbookClipboard(
  store: DocumentStore,
  flipbookId: string,
  target: FlipbookPasteTarget,
): string[] | null {
  const clipboard = useFlipbookClipboard.getState();
  if (!clipboard.mode || clipboard.cellIds.length === 0) return null;

  const doc = store.getState();
  const validIds = clipboard.cellIds.filter((id) => {
    const loc = locateClip(doc, id);
    return !!loc && loc.clip.kind === "nested" && flipbookOf(doc, loc.clip.frameId)?.id === flipbookId;
  });
  if (validIds.length === 0) {
    clearFlipbookClipboard();
    return null;
  }

  // Resolve the target into a concrete row + ms — an explicit void slot, right
  // after a specific cell, or (nothing selected) the end of the first row.
  const rows = flipbookRows(doc, flipbookId);
  let trackId: string;
  let atMs: number;
  if (target && "trackId" in target) {
    trackId = target.trackId;
    atMs = target.atMs;
  } else if (target && "afterCellId" in target) {
    const loc = locateClip(doc, target.afterCellId);
    if (!loc) return null;
    trackId = loc.track.id;
    atMs = clipEnd(loc.clip);
  } else {
    const row = rows[0];
    if (!row) return null;
    trackId = row.track.id;
    atMs = row.span?.endMs ?? 0;
  }

  let pastedIds: string[] | null = null;
  const surfaceCopies: Array<{ from: string; to: string }> = [];
  store.update(clipboard.mode === "cut" ? "Move frames" : "Paste frames", (d) => {
    const result = pasteFlipbookCellsAt(d, flipbookId, validIds, trackId, atMs, clipboard.mode === "cut" ? "move" : "copy");
    if (result) {
      pastedIds = result.clipIds;
      surfaceCopies.push(...result.surfaceCopies);
    }
  });

  for (const { from, to } of surfaceCopies) {
    const raster = store
      .getState()
      .tracks.flatMap((t) => t.clips)
      .find((c) => c.kind === "raster" && c.surfaceId === to);
    if (raster?.kind === "raster") cloneSurfacePixels(from, to, raster.width, raster.height);
  }

  if (clipboard.mode === "cut") clearFlipbookClipboard();
  return pastedIds;
}
