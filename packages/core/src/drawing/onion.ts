import { locateFrame, ownerNestedOf } from "../timeline/ops";
import { captureCursor, captureFps, captureFrameTimes, captureLocalMs } from "./capture";
import { frameStepMs } from "../timeline/fps";
import { cellDrawing, flipbookOnionSlot, flipbookRows } from "./flipbook";
import type { MotionDocument, Clip, NestedClip } from "../schema";

/**
 * Onion skinning — the headless plan of WHAT ghosts to draw; the stage
 * renders it. Settings live app-level (a view preference, like guides): the
 * onion tool's popover edits them, every flipbook reads them.
 */
export interface OnionSettings {
  enabled: boolean;
  /** How many cells to ghost behind / ahead. */
  prevCount: number;
  nextCount: number;
  /**
   * Ghost tints. `null` (the default) is the HOST's choice: the editor derives
   * them from its theme (the accent ahead, its complement behind), so a
   * re-themed studio never ghosts in someone else's red and green. A colour
   * here is a person's explicit pick and wins.
   */
  prevColor: string | null;
  nextColor: string | null;
  /** Alpha of the NEAREST ghost; each step further fades by `falloff`. */
  opacity: number;
  falloff: number;
  /** 0 = ghosts keep their real colors, 1 = fully tinted silhouettes. */
  tintStrength: number;
  /** Wrap around looping rows (the ghost before frame 1 is the last frame). */
  loopWrap: boolean;
}

export const DEFAULT_ONION_SETTINGS: OnionSettings = {
  enabled: false,
  prevCount: 2,
  nextCount: 1,
  prevColor: null,
  nextColor: null,
  opacity: 0.35,
  falloff: 0.55,
  tintStrength: 0.65,
  loopWrap: true,
};

/**
 * One ghost to composite, tinted, under the live art. Two sources, because
 * The app has two ways to draw frame-by-frame and onion skinning must mean the
 * same thing in both:
 *
 *  - `drawing`: a neighbouring flipbook cell's drawing comp (the sheet model).
 *  - `capture`: a neighbouring CAPTURE frame of one recorded layer (the
 *    draw-on-a-clip model) - rendered by drawing that clip alone at the
 *    neighbour's time, so pose, effects and opacity all match the live layer
 *    for free.
 *
 * A union rather than two ghost types: the fade/tint/ordering rules are the
 * ghost's business and are written exactly once, below.
 */
interface OnionGhostBase {
  /** Negative = frames behind, positive = ahead (1 = adjacent). */
  offset: number;
  /** `null`: the host tints it (see `OnionSettings.prevColor`). */
  color: string | null;
  alpha: number;
}
export type OnionGhost =
  | (OnionGhostBase & { source: "drawing"; drawingFrameId: string })
  | (OnionGhostBase & { source: "capture"; clipId: string; frameId: string; timeMs: number });

/** Ghost alpha `step` frames away from the live one (1 = adjacent). */
function ghostAlpha(step: number, settings: OnionSettings): number {
  return settings.opacity * Math.pow(settings.falloff, step - 1);
}

/** Farthest first, so nearer ghosts composite over farther ones. */
function byDistance(ghosts: OnionGhost[]): OnionGhost[] {
  return ghosts.sort((a, b) => Math.abs(b.offset) - Math.abs(a.offset));
}

/**
 * THE neighbor-walk shared by every onion entry point: from two anchor indices
 * (the first prev/next neighbor around a slot), fade cells outward by distance.
 * The anchors already exclude the slot's own cell, so this never ghosts the
 * frame you're on. Undrawn cells are skipped; looping rows wrap.
 */
function ghostsFromAnchors(
  doc: MotionDocument,
  cells: Clip[],
  prevAnchor: number,
  nextAnchor: number,
  wrap: boolean,
  settings: OnionSettings,
): OnionGhost[] {
  const ghosts: OnionGhost[] = [];
  const push = (rawIndex: number, offset: number, color: string | null) => {
    let i = rawIndex;
    if (i < 0 || i >= cells.length) {
      if (!wrap) return;
      i = ((i % cells.length) + cells.length) % cells.length;
    }
    const neighbor = cells[i];
    if (!neighbor) return;
    const source = cellDrawing(doc, neighbor);
    if (!source) return;
    const alpha = ghostAlpha(Math.abs(offset), settings);
    if (alpha < 0.01) return;
    ghosts.push({ source: "drawing", drawingFrameId: source.id, offset, color, alpha });
  };
  for (let k = 0; k < settings.prevCount; k++) push(prevAnchor - k, -(k + 1), settings.prevColor);
  for (let k = 0; k < settings.nextCount; k++) push(nextAnchor + k, k + 1, settings.nextColor);
  return byDistance(ghosts);
}

/**
 * Onion ghosts for a RECORDED layer - the draw-on-a-clip twin of `onionGhosts`.
 * Walks the clip's capture keys around the playhead and asks the renderer to
 * draw that one clip at each neighbour's time. Same counts, same colors, same
 * falloff as the flipbook: onion skinning is one setting, one look, everywhere.
 *
 * Returns [] for a clip that isn't recording, or when the playhead sits outside
 * it - there is no frame to be "between".
 */
export function captureOnionGhosts(
  doc: MotionDocument,
  clipId: string,
  playheadMs: number,
  settings: OnionSettings,
): OnionGhost[] {
  if (!settings.enabled) return [];
  const found = locateClipCapture(doc, clipId);
  if (!found) return [];
  const { clip, keys } = found;
  if (playheadMs < clip.startMs || playheadMs > clip.startMs + clip.durationMs) return [];

  // Two anchors, exactly like the flipbook walk: the first neighbour on each
  // side of what is on screen. Standing ON a frame, that frame is the art and
  // its neighbours are ±1. Standing in the GAP after frame i, frame i is what
  // shows and the stroke would be born between i and i+1 — so i itself is the
  // previous neighbour, not the current frame.
  const fps = captureFps(doc, clip);
  const cursor = captureCursor(keys, captureLocalMs(doc, clip, playheadMs), fps);
  const prevAnchor = cursor.onFrame ? cursor.index - 1 : cursor.index;
  const nextAnchor = cursor.index + 1;

  // Render each ghost HALF A FRAME into its own hold. Landing exactly on the key
  // time is a coin-flip: the render clock floors, so a key stored a hair below
  // its grid instant would resolve to the frame BEFORE it and every ghost would
  // point one frame too far back. Mid-hold is unambiguous for any key, however
  // it was written.
  const halfFrame = frameStepMs(fps) / 2;
  const ghosts: OnionGhost[] = [];
  const push = (index: number, offset: number, color: string | null) => {
    const at = keys[index];
    if (at === undefined) return;
    const alpha = ghostAlpha(Math.abs(offset), settings);
    if (alpha < 0.01) return;
    ghosts.push({
      source: "capture",
      clipId: clip.id,
      frameId: clip.frameId,
      timeMs: clip.startMs + at + halfFrame,
      offset,
      color,
      alpha,
    });
  };
  for (let k = 0; k < settings.prevCount; k++) push(prevAnchor - k, -(k + 1), settings.prevColor);
  for (let k = 0; k < settings.nextCount; k++) push(nextAnchor + k, k + 1, settings.nextColor);
  return byDistance(ghosts);
}

/** The clip + its ascending capture frame times, or null when it isn't recording. */
function locateClipCapture(
  doc: MotionDocument,
  clipId: string,
): { clip: Clip; keys: number[] } | null {
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.id !== clipId) continue;
      if (clip.kind === "audio") return null;
      const keys = captureFrameTimes(clip.keyframes);
      return keys.length > 0 ? { clip, keys } : null;
    }
  }
  return null;
}

/**
 * The ghosts for the drawing being edited (drilled INTO a cell's canvas). Finds
 * the cell that owns the drawing, then walks its row's neighbors. Returns []
 * when the drawing isn't a flipbook cell — onion skin simply doesn't apply.
 */
export function onionGhosts(
  doc: MotionDocument,
  drawingFrameId: string,
  settings: OnionSettings,
): OnionGhost[] {
  if (!settings.enabled) return [];
  const drawing = locateFrame(doc, drawingFrameId);
  if (!drawing || drawing.mode === "flipbook") return [];
  const cell = ownerNestedOf(doc, drawingFrameId);
  if (!cell) return [];
  const flipbook = locateFrame(doc, cell.frameId);
  if (!flipbook || flipbook.mode !== "flipbook") return [];

  const row = flipbookRows(doc, flipbook.id).find((r) => r.cells.some((c) => c.id === cell.id));
  if (!row) return [];
  const index = row.cells.findIndex((c) => c.id === cell.id);
  if (index < 0) return [];

  const wrap = settings.loopWrap && row.track.loop !== "none" && row.cells.length > 1;
  return ghostsFromAnchors(doc, row.cells, index - 1, index + 1, wrap, settings);
}

/** Onion ghosts + the co-located cell whose pose positions them on the sheet. */
export interface FlipbookOnionPlan {
  ghosts: OnionGhost[];
  anchorCell: NestedClip;
}

/**
 * Onion ghosts for the flipbook SHEET view — resolves the current slot (a drawn
 * cell, an empty gap, or a selected void) and ghosts the surrounding frames
 * through the nearest drawn cell's pose. This is what makes onion skinning show
 * on EMPTY cells, where there's no drawing of your own to anchor to.
 */
export function flipbookOnionAt(
  doc: MotionDocument,
  flipbookId: string,
  playheadMs: number,
  selectedClipIds: readonly string[],
  voidTrackId: string | null,
  voidMs: number | null,
  settings: OnionSettings,
): FlipbookOnionPlan | null {
  if (!settings.enabled) return null;
  const slot = flipbookOnionSlot(doc, flipbookId, playheadMs, selectedClipIds, voidTrackId, voidMs);
  if (!slot || !slot.anchorCell) return null;
  const wrap = settings.loopWrap && slot.row.track.loop !== "none" && slot.row.cells.length > 1;
  const ghosts = ghostsFromAnchors(doc, slot.row.cells, slot.prevAnchor, slot.nextAnchor, wrap, settings);
  if (ghosts.length === 0) return null;
  return { ghosts, anchorCell: slot.anchorCell };
}
