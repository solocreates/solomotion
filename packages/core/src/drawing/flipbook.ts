import { createId } from "../ids";
import { cloneCompRows } from "../components";
import { createFrame, createNestedClip, createRasterClip, createTrack } from "../factories";
import { internalPageId, isInternalPage } from "../pages";
import {
  cellFrameCount,
  compFps,
  frameFps,
  frameIndexToMs,
  frameStepMs,
  msToFrameIndex,
} from "../timeline/fps";
import {
  clipEnd,
  clipNaturalSourceSpanMs,
  isClipLocked,
  locateClip,
  locateFrame,
  ownerNestedOf,
  reconcileFillClips,
  reissueClipIds,
  sortTrackClips,
} from "../timeline/ops";
import type {
  Clip,
  Frame,
  LoopMode,
  NestedClip,
  RasterClip,
  Track,
  MotionDocument,
} from "../schema";

/**
 * The flipbook brain — ONE headless model consumed by the sheet panel, the
 * renderer's row-loop seam, onion skinning and thumbnails. A flipbook is a
 * frame with role "flipbook"; its TRACKS are rows and its CLIPS are cells.
 * A cell is a nested clip whose source is a role-"drawing" frame, and a
 * drawing's clips are its layers (raster paint, paths, shapes, text). So a
 * flipbook is comps all the way down: navigation, the layers panel, undo,
 * export and playback already know how to walk it — this module only adds
 * the frame-by-frame VOCABULARY (rows, cells, frame counts) over that.
 */

// ── Time: the row-loop seam ─────────────────────────────────────────────────

/**
 * A track's content span within one comp (first cell start → last cell end).
 * Null when the lane holds no clips of that comp.
 */
export function trackSpanMs(track: Track, compId: string): { startMs: number; endMs: number } | null {
  let start = Infinity;
  let end = 0;
  for (const clip of track.clips) {
    if (clip.frameId !== compId) continue;
    start = Math.min(start, clip.startMs);
    end = Math.max(end, clipEnd(clip));
  }
  return end > 0 ? { startMs: start, endMs: end } : null;
}

/**
 * THE track-loop time seam (v32): map comp time through a track's loop mode so
 * the lane's content span repeats to fill the comp. Rendering, hit-testing,
 * the sheet's ghost repeats and export all call this one function — the row
 * can never play one way and draw another. Returns the time to use for the
 * track's clips (identity for `loop: "none"` or outside a meaningful span).
 */
export function trackLocalTime(track: Track, compId: string, timeMs: number): number {
  if (track.loop === "none") return timeMs;
  const span = trackSpanMs(track, compId);
  if (!span) return timeMs;
  const len = span.endMs - span.startMs;
  if (len <= 0) return timeMs;
  const rel = timeMs - span.startMs;
  if (rel <= 0) return timeMs;
  if (track.loop === "loop") return span.startMs + (rel % len);
  // pingpong
  const period = len * 2;
  const p = rel % period;
  return span.startMs + (p <= len ? p : period - p);
}

// ── Reading the sheet ───────────────────────────────────────────────────────

/** One row of the sheet: a track and its cells (sorted by start). */
export interface FlipbookRow {
  track: Track;
  cells: Clip[];
  /** Content span (null for an empty spare row). */
  span: { startMs: number; endMs: number } | null;
}

/** True when this frame opens as a flipbook sheet. */
export function isFlipbookFrame(frame: Frame | null | undefined): boolean {
  return frame?.mode === "flipbook";
}


/**
 * The rows of a flipbook, top-to-bottom in track order: tracks holding this
 * comp's clips, plus empty spare lanes homed here (same scoping rule as the
 * timeline view).
 */
export function flipbookRows(doc: MotionDocument, flipbookId: string): FlipbookRow[] {
  const rows: FlipbookRow[] = [];
  for (const track of doc.tracks) {
    const cells = track.clips.filter((c) => c.frameId === flipbookId);
    if (cells.length === 0 && track.homeCompId !== flipbookId) continue;
    cells.sort((a, b) => a.startMs - b.startMs);
    rows.push({ track, cells, span: trackSpanMs(track, flipbookId) });
  }
  return rows;
}

/**
 * Duration of ONE animation frame in this sheet, ms (its grid unit). A thin
 * bind of the comp's rate to the grid helper — the sheet's arithmetic reads
 * better with the frame in hand than with a rate. `cellFrameCount` (the hold
 * count) lives in ../timeline/fps beside it.
 */
export function sheetStepMs(doc: MotionDocument, frame: Frame): number {
  return frameStepMs(frameFps(doc, frame));
}

// ── The grid: a cell occupies WHOLE FRAMES, and its ms are derived from that ─

/**
 * THE SPAN of the sheet frames `[index, index + hold)`, in milliseconds.
 *
 * This is the only legal way to write a cell's `startMs`/`durationMs`, and the
 * reason it has to exist is the defect that has haunted this feature from the
 * start: *"I am standing on frame 2 and the stage is painting frame 1"*, on
 * some indices and not others, differently at every rate.
 *
 * A cell was timed by ACCUMULATING milliseconds — `startMs = clipEnd(prev)`,
 * `durationMs = step * hold` — with `step = 1000 / fps`. At 12fps that makes
 * cell 1 start at 83.33333333333333. But a comp only ever EXISTS at the grid
 * instants {@link frameIndexToMs} names, and those are stored to 3dp: the render
 * clock resolves frame 1 to 83.333, which is a third of a thousandth of a
 * millisecond BEFORE that cell begins. So the renderer's ordinary span test
 * said "cell 1 is not live yet" and painted cell 0 on cell 1's own frame —
 * while the sheet, the breadcrumb and the paint target all said cell 1.
 *
 * It looked random because it depends on which way `index × step` rounds at
 * 3dp: at 12fps indices 1, 4, 7, 10… fall short and break, 2, 5, 8… round up
 * and work, 3, 6, 9… are exact. Every rate has its own pattern. That is the
 * "some frames show and some don't" that no amount of staring at the drawing
 * code could ever explain.
 *
 * Derive both ends from {@link frameIndexToMs} and the problem cannot recur:
 * a start is bit-for-bit the instant the render clock resolves to, and a cell's
 * end is bit-for-bit the next cell's start, so two gapless cells can neither
 * overlap nor leave a crack between them.
 */
export function cellSpanMs(fps: number, index: number, holdFrames: number): {
  startMs: number;
  durationMs: number;
} {
  const from = Math.max(0, Math.round(index));
  const hold = Math.max(1, Math.round(holdFrames));
  const startMs = frameIndexToMs(from, fps);
  return { startMs, durationMs: frameIndexToMs(from + hold, fps) - startMs };
}

/**
 * Put every cell of a sheet back ON the grid: each keeps the frame index it
 * already falls on and the hold it already has, and its milliseconds are
 * re-derived from those. Idempotent, gap-preserving, and order-preserving —
 * two cells that would land on the same index (an overlap that should never
 * have been written) are pushed apart rather than stacked.
 *
 * Runs from {@link reconcileFlipbook}, which every sheet mutation already ends
 * with, so no writer has to remember the grid — which is the point, because
 * eight of them did their own `Math.round(ms / step) * step` and they did not
 * agree. It is also the repair for documents already carrying drifted times.
 */
export function alignFlipbookToGrid(doc: MotionDocument, flipbookId: string): boolean {
  const sheet = locateFrame(doc, flipbookId);
  if (!sheet) return false;
  const fps = frameFps(doc, sheet);
  let changed = false;
  for (const row of flipbookRows(doc, flipbookId)) {
    let floor = 0; // the first index still free on this row
    for (const cell of row.cells) {
      const index = Math.max(floor, msToFrameIndex(cell.startMs, fps));
      const hold = cellFrameCount(doc, sheet, cell);
      const span = cellSpanMs(fps, index, hold);
      if (cell.startMs !== span.startMs || cell.durationMs !== span.durationMs) {
        cell.startMs = span.startMs;
        cell.durationMs = span.durationMs;
        changed = true;
      }
      floor = index + hold;
    }
  }
  return changed;
}

/**
 * EVERYTHING THAT MUST BE TRUE OF A SHEET after any edit to it, in one call.
 *
 * Cells sit on the grid, and the owner clip is never shorter than the sheet it
 * holds. Both are invariants rather than operations — no caller should have to
 * know they exist, and the two mutations that did remember one but not the
 * other are how a sheet ended up half-repaired.
 */
export function reconcileFlipbook(doc: MotionDocument, flipbookId: string): void {
  alignFlipbookToGrid(doc, flipbookId);
  syncFlipbookLoopSpan(doc, flipbookId);
}

/**
 * THE CELL A ROW SHOWS at comp time `timeMs` (loop applied), or null.
 *
 * It must agree with the RENDERER, and for a long time it did not. The renderer
 * decides which cell paints the ordinary way — a clip covers an instant when
 * that instant is inside its span — on a time the render clock has already
 * quantised onto the comp's frame grid. This function used a different rule:
 *
 *     t >= cell.startMs - 0.5 && t < clipEnd(cell) - 0.5
 *
 * which is not a widened window but a SHIFTED one: both bounds moved down by
 * half a millisecond, so the window described a span half a millisecond to the
 * left of the cell it named. At 12fps a step is 83.333…ms and a playhead
 * landing just under a boundary fell inside that shift — this said "cell N+1"
 * while the renderer said "cell N".
 *
 * That disagreement is the whole of *"I am standing on frame 2 and the canvas
 * is showing frame 1"*: the sheet, the breadcrumb, the layers panel and the
 * paint target all follow THIS, and only the picture follows the renderer. It
 * looked random because whether a given index lands inside the shift depends on
 * the drift accumulated at that index at that rate.
 *
 * So ask the question a sheet actually asks. A sheet is a sequence of whole
 * frames, so "which cell is this" is a question about an INDEX, and an index is
 * an integer: {@link msToFrameIndex} is the same floor-with-tolerance the render
 * clock uses, so the two cannot land on different sides of a boundary however
 * the boundary was arrived at.
 */
export function rowCellAt(
  doc: MotionDocument,
  flipbookId: string,
  row: FlipbookRow,
  timeMs: number,
): Clip | null {
  const sheet = locateFrame(doc, flipbookId);
  if (!sheet) return null;
  const fps = frameFps(doc, sheet);
  const at = msToFrameIndex(trackLocalTime(row.track, flipbookId, timeMs), fps);
  for (const cell of row.cells) {
    const from = msToFrameIndex(cell.startMs, fps);
    if (at >= from && at < from + cellFrameCount(doc, sheet, cell)) return cell;
  }
  return null;
}

/**
 * The frame a cell SHOWS — its drawing — or null for a non-nested/missing one.
 *
 * Any mode: a cell is usually a static drawing, but one that moves is a
 * timeline and is just as much that cell's drawing (paint lands in it, onion
 * skin ghosts it, copy clones it). A nested SHEET is not a drawing — it has
 * cells of its own — so it answers null and the sheet treats it as opaque.
 */
export function cellDrawing(doc: MotionDocument, cell: Clip): Frame | null {
  if (cell.kind !== "nested") return null;
  const f = locateFrame(doc, cell.sourceFrameId);
  return f && f.mode !== "flipbook" ? f : null;
}

/**
 * The flipbook a frame belongs to — itself if it IS a flipbook, else walking up
 * its owners until one is (a cell drawing → its flipbook), else null. THE test
 * for "is this frame internal to a flipbook", so tabs/navigation can treat the
 * whole flipbook as ONE unit: its cells are never standalone timelines.
 */
export function flipbookOf(doc: MotionDocument, frameId: string): Frame | null {
  let cur = locateFrame(doc, frameId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    if (cur.mode === "flipbook") return cur;
    seen.add(cur.id);
    const owner = ownerNestedOf(doc, cur.id);
    cur = owner ? locateFrame(doc, owner.frameId) : null;
  }
  return null;
}

/**
 * The sheet that is the CLOCK of where you stand: a flipbook itself, or the one
 * whose cell you are inside — as long as everything between is STATIC. A still
 * has no clock of its own, so the sheet above it keeps time (you flip drawings
 * from inside one). A timeline has its own: stand in an animated cell and you
 * see ITS timeline, with the sheet one step up the breadcrumb. Null outside.
 */
export function flipbookInContext(doc: MotionDocument, activeFrameId: string | null): Frame | null {
  let cur = activeFrameId ? locateFrame(doc, activeFrameId) : null;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    if (cur.mode === "flipbook") return cur;
    if (cur.mode !== "static") return null;
    seen.add(cur.id);
    const owner = ownerNestedOf(doc, cur.id);
    cur = owner ? locateFrame(doc, owner.frameId) : null;
  }
  return null;
}

/**
 * When `activeFrameId` is a flipbook CELL's drawing you've drilled into, the
 * flipbook + the cell clip that reaches it — the seam for scrubbing in
 * flipbook-GLOBAL time (keyboard transport, playback) exactly like the sheet
 * ruler's mouse drag. Null when you're in the flipbook itself or outside one.
 * The flipbook is the single time authority for all its cells, so a scrub is
 * never trapped inside one cell's local span — it crosses cell boundaries and
 * ascends back to the flipbook, same rule for mouse and keyboard alike.
 */
export function drilledFlipbookCell(
  doc: MotionDocument,
  activeFrameId: string | null,
): { flipbook: Frame; cell: Clip } | null {
  if (!activeFrameId) return null;
  const flipbook = flipbookInContext(doc, activeFrameId);
  if (!flipbook || flipbook.id === activeFrameId) return null; // in the flipbook itself
  for (const track of doc.tracks) {
    for (const cell of track.clips) {
      if (cell.frameId === flipbook.id && cell.kind === "nested" && cell.sourceFrameId === activeFrameId) {
        return { flipbook, cell };
      }
    }
  }
  return null;
}

// ── Creating ────────────────────────────────────────────────────────────────

export interface CreateDrawingInput {
  /** The comp the drawing's clip lands in. */
  parentFrameId: string;
  startMs: number;
  durationMs: number;
  name?: string;
  width: number;
  height: number;
  /** Seed the drawing with one pixel layer (default true). */
  withRasterLayer?: boolean;
  /** Canvas placement. Flipbook cells pass the FLIPBOOK's own x/y so every
   *  frame sits co-located INSIDE it — focusing a frame then needs no camera
   *  move (they overlap exactly), instead of scattering across the nested page. */
  x?: number;
  y?: number;
}

export interface CreatedDrawing {
  clip: NestedClip;
  drawing: Frame;
  rasterLayer: RasterClip | null;
  /** The carrier track created inside the drawing for its layers. */
  layerTrack: Track | null;
}

/**
 * Create a drawing comp + the nested clip that shows it in a parent. Mutates
 * `doc` (call inside a document update) but does NOT place `clip` — callers
 * place it with their own lane logic (placeClip / a specific flipbook row).
 * By default a drawing is born STATIC (one frame of life, `fillDuration`
 * layers) with a single pixel layer ready to paint.
 */
export function createDrawing(doc: MotionDocument, input: CreateDrawingInput): CreatedDrawing {
  const slot = input.x != null && input.y != null ? { x: input.x, y: input.y } : nextNestedSlot(doc);
  const drawing = createFrame({
    name: input.name ?? "Drawing",
    mode: "static",
    width: input.width,
    height: input.height,
    background: "#00000000", // transparent — the parent shows through
    overflow: 1,
    pageId: internalPageId(doc),
    x: slot.x,
    y: slot.y,
    // A cell inherits the sheet's grid at birth (a drawing made in a 12fps
    // flipbook is a 12fps drawing), so painting inside it steps on the same
    // frames the sheet shows. Seeded, not linked — it owns its rate after.
    fps: compFps(doc, input.parentFrameId),
  });
  doc.frames.push(drawing);

  let rasterLayer: RasterClip | null = null;
  let layerTrack: Track | null = null;
  if (input.withRasterLayer !== false) {
    rasterLayer = createRasterClip({
      frameId: drawing.id,
      width: input.width,
      height: input.height,
      durationMs: input.durationMs,
      name: "Layer 1",
      // A drawing comp's layers ARE the drawing: they span it, always.
      fillDuration: true,
    });
    layerTrack = createTrack("Layers");
    layerTrack.clips.push(rasterLayer);
    doc.tracks.unshift(layerTrack);
  }

  const clip = createNestedClip({
    frameId: input.parentFrameId,
    sourceFrameId: drawing.id,
    startMs: input.startMs,
    durationMs: input.durationMs,
    name: drawing.name,
  });
  return { clip, drawing, rasterLayer, layerTrack };
}

/** Stack new nested-page frames in a loose grid so they never pile up. */
function nextNestedSlot(doc: MotionDocument): { x: number; y: number } {
  const page = doc.pages.find((p) => p.name === "Nested");
  const frames = page ? doc.frames.filter((f) => f.pageId === page.id) : [];
  const col = frames.length % 6;
  const row = Math.floor(frames.length / 6);
  return { x: col * 1400, y: 4000 + row * 2200 };
}

export interface CreateFlipbookInput {
  parentFrameId: string;
  startMs: number;
  width: number;
  height: number;
  /** Flipbook fps (its own grid — defaults to 12, the animator's classic). */
  fps?: number;
  /** Frames the first cell holds (default 1). */
  initialHoldFrames?: number;
  name?: string;
}

export interface CreatedFlipbook {
  clip: NestedClip;
  flipbook: Frame;
  firstCell: CreatedDrawing;
  rowTrack: Track;
}

/**
 * Default visible sheet length for a FRESH flipbook — Dreams-style, you see a
 * generous empty canvas immediately instead of a single 1-frame sliver. Only
 * seeded at creation (an explicit `durationMs` override, same field the
 * sheet's own EndBar edits); existing flipbooks keep whatever they already
 * have (null = auto-hug, unaffected by this default).
 */
export const DEFAULT_SHEET_FRAMES = 30;

/**
 * Create a flipbook comp with one row and one drawing cell, plus the nested
 * clip that plays it in the parent. Flipbooks default to LOOP playback — a
 * two-frame bounce should just cycle, per animator instinct.
 */
export function createFlipbook(doc: MotionDocument, input: CreateFlipbookInput): CreatedFlipbook {
  const fps = input.fps ?? 12;
  const flipbook = createFrame({
    name: input.name ?? "Flipbook",
    mode: "flipbook",
    width: input.width,
    height: input.height,
    background: "#00000000",
    overflow: 1,
    fps,
    pageId: internalPageId(doc),
    x: nextNestedSlot(doc).x,
    y: nextNestedSlot(doc).y,
  });
  flipbook.loop = "loop";
  doc.frames.push(flipbook);

  const step = 1000 / fps;
  const hold = Math.max(1, input.initialHoldFrames ?? 1);
  const firstCell = createDrawing(doc, {
    parentFrameId: flipbook.id,
    startMs: 0,
    durationMs: step * hold,
    width: input.width,
    height: input.height,
    name: "Frame 1",
    x: flipbook.x,
    y: flipbook.y,
  });
  const rowTrack = createTrack("Row 1", flipbook.id);
  rowTrack.clips.push(firstCell.clip);
  doc.tracks.unshift(rowTrack);
  // Pinned to a generous default (not null/auto-hug) so the sheet shows its
  // full void canvas right away — the user can always drag the end bar (same
  // field) to shrink or grow it later, exactly like any other frame.
  flipbook.durationMs = step * DEFAULT_SHEET_FRAMES;

  const clip = createNestedClip({
    frameId: input.parentFrameId,
    sourceFrameId: flipbook.id,
    startMs: input.startMs,
    durationMs: Math.max(step * DEFAULT_SHEET_FRAMES, step * hold, 2000),
    name: flipbook.name,
    playback: { loop: "loop" },
  });
  return { clip, flipbook, firstCell, rowTrack };
}

// ── Sheet mutations ─────────────────────────────────────────────────────────
//
// A flipbook's `durationMs` is no longer force-synced to content after every
// mutation below — it's a plain per-frame override (null = auto, hugs content
// via `frameDurationMs`/`frameContentDurationMs`; see ops.ts) exactly like any
// other frame. The sheet's own end bar (FlipbookPanel, reusing the Timeline's
// `EndBar`/`DurationField`) is the only thing that ever pins it now.

/**
 * Append a new blank drawing cell at the end of a row (the sheet's "+"). The
 * new cell inherits the row's last cell hold, defaulting to 1 frame.
 */
export function addFlipbookCell(
  doc: MotionDocument,
  flipbookId: string,
  trackId: string,
  holdFrames?: number,
): CreatedDrawing | null {
  const fb = locateFrame(doc, flipbookId);
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!fb || !track || fb.mode !== "flipbook") return null;
  const fps = frameFps(doc, fb);
  const cells = track.clips.filter((c) => c.frameId === flipbookId).sort((a, b) => a.startMs - b.startMs);
  const last = cells[cells.length - 1];
  const hold = Math.max(1, holdFrames ?? (last ? cellFrameCount(doc, fb, last) : 1));
  // Index-addressed, never `clipEnd(last)`: the new cell begins on the frame
  // after the last one ENDS ON, which is a fact about frames (see cellSpanMs).
  const at = last ? msToFrameIndex(last.startMs, fps) + cellFrameCount(doc, fb, last) : 0;
  const span = cellSpanMs(fps, at, hold);
  const created = createDrawing(doc, {
    parentFrameId: flipbookId,
    startMs: span.startMs,
    durationMs: span.durationMs,
    width: fb.width,
    height: fb.height,
    name: `Frame ${cells.length + 1}`,
    x: fb.x,
    y: fb.y,
  });
  track.clips.push(created.clip);
  sortTrackClips(track);
  reconcileFlipbook(doc, flipbookId);
  return created;
}

/**
 * Insert a new blank drawing cell at a specific frame-quantized time in a
 * row — the sheet's void-slot "Add frame here". Clamped against immediate
 * siblings so it can never overlap them (gaps stay first-class, same
 * contract as `moveFlipbookCell`); callers only invoke this on a slot already
 * confirmed empty (`rowCellAt` returned null), so room for at least one
 * frame is guaranteed.
 */
export function addFlipbookCellAt(
  doc: MotionDocument,
  flipbookId: string,
  trackId: string,
  atMs: number,
  holdFrames?: number,
): CreatedDrawing | null {
  const fb = locateFrame(doc, flipbookId);
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!fb || !track || fb.mode !== "flipbook") return null;
  const fps = frameFps(doc, fb);
  const step = frameStepMs(fps);
  const cells = track.clips.filter((c) => c.frameId === flipbookId).sort((a, b) => a.startMs - b.startMs);
  const hold = Math.max(1, holdFrames ?? 1);
  // Whole-frame arithmetic throughout: the slot, the neighbours it has to fit
  // between, and the result. Milliseconds only ever come back out at the end.
  const want = Math.max(0, Math.round(atMs / step));
  let lo = 0;
  let hi = Infinity;
  for (const c of cells) {
    const from = msToFrameIndex(c.startMs, fps);
    const to = from + cellFrameCount(doc, fb, c);
    if (to <= want) lo = Math.max(lo, to);
    else if (from >= want) hi = Math.min(hi, from);
  }
  const at = Math.min(Math.max(want, lo), Math.max(lo, hi - hold));
  const span = cellSpanMs(fps, at, hold);
  const created = createDrawing(doc, {
    parentFrameId: flipbookId,
    startMs: span.startMs,
    durationMs: span.durationMs,
    width: fb.width,
    height: fb.height,
    name: `Frame ${cells.length + 1}`,
    x: fb.x,
    y: fb.y,
  });
  track.clips.push(created.clip);
  sortTrackClips(track);
  reconcileFlipbook(doc, flipbookId);
  return created;
}

/**
 * A FLIPBOOK'S OWNER CLIP IS NEVER SHORTER THAN THE SHEET IT HOLDS.
 *
 * A flipbook is a nested clip in its parent, and a nested clip renders only
 * inside its own span. So a sheet that grew past that span had cells nothing
 * could ever draw: the thumbnail in the sheet was right (it renders the cell
 * directly), the layers panel listed the artwork, the selection box sat around
 * it — and the stage painted nothing, because the parent's clock had already
 * left the clip behind. "Some frames show and some don't", with the boundary
 * sitting exactly at the owner's end.
 *
 * It used to bail out whenever `playback.loopLengthMs` was set, on the reading
 * that an explicit override should win. That conflated two different facts. The
 * loop CYCLE is how long one repeat lasts; the clip's BOX is how long the clip
 * exists in its parent. Choosing a cycle is not a statement that half your
 * drawing should stop rendering, and nobody has ever meant it as one.
 *
 * Grow-only, so a deliberate resize longer than the content is still honoured —
 * the invariant is a floor, not an equality.
 */
export function syncFlipbookLoopSpan(doc: MotionDocument, flipbookId: string): void {
  const owner = ownerNestedOf(doc, flipbookId);
  if (!owner || owner.kind !== "nested") return;
  const natural = clipNaturalSourceSpanMs(doc, owner);
  if (natural > owner.durationMs) owner.durationMs = natural;
}

/**
 * Heal a flipbook saved before its invariants were held — the same idempotent
 * repair `coLocateFlipbookCells` is for layout. Returns true when it changed
 * something, so a caller can skip a no-op history entry.
 *
 * Both halves of {@link reconcileFlipbook} are repairs as well as invariants.
 * Documents exist with thirty frames of drawing inside a one-second box, whose
 * later cells nothing can ever draw; and documents exist whose cell times were
 * accumulated in milliseconds rather than derived from the grid, so a third of
 * their frames paint their predecessor. Both must come back whole on open
 * rather than staying half-broken until somebody edits the sheet.
 */
export function healFlipbookSpan(doc: MotionDocument, flipbookId: string): boolean {
  const owner = ownerNestedOf(doc, flipbookId);
  const before = owner?.kind === "nested" ? owner.durationMs : null;
  const regridded = alignFlipbookToGrid(doc, flipbookId);
  syncFlipbookLoopSpan(doc, flipbookId);
  return regridded || (before !== null && owner?.kind === "nested" && owner.durationMs !== before);
}


/**
 * The flipbook's WHOLE-sheet loop mode — ONE value shown two ways: the comp's
 * own `loop` (how the sheet plays when you're inside it) and the parent nested
 * clip's `playback.loop` (how the flipbook repeats where it sits in the root).
 * They are the same knob, so reading and writing go through here; a change in
 * the sheet header and a change on the parent clip stay in lock-step.
 */
export function flipbookLoopMode(doc: MotionDocument, flipbookId: string): LoopMode {
  const owner = ownerNestedOf(doc, flipbookId);
  if (owner?.kind === "nested") return owner.playback.loop;
  return locateFrame(doc, flipbookId)?.loop ?? "none";
}

export function setFlipbookLoop(doc: MotionDocument, flipbookId: string, mode: LoopMode): void {
  const fb = locateFrame(doc, flipbookId);
  if (fb) fb.loop = mode;
  const owner = ownerNestedOf(doc, flipbookId);
  if (owner?.kind === "nested") owner.playback = { ...owner.playback, loop: mode };
}

/**
 * Co-locate every cell drawing ON TOP of the flipbook (same x/y) — the layout
 * invariant that makes focusing a frame need no camera move. Idempotent; heals
 * older flipbooks whose cells were scattered across the nested page. Returns
 * true if anything moved (callers can skip a no-op history entry).
 */
export function coLocateFlipbookCells(doc: MotionDocument, flipbookId: string): boolean {
  const fb = locateFrame(doc, flipbookId);
  if (!fb) return false;
  let moved = false;
  for (const row of flipbookRows(doc, flipbookId)) {
    for (const cell of row.cells) {
      const drawing = cellDrawing(doc, cell);
      if (drawing && (drawing.x !== fb.x || drawing.y !== fb.y)) {
        drawing.x = fb.x;
        drawing.y = fb.y;
        moved = true;
      }
    }
  }
  return moved;
}

/** Add a new empty row (spare lane homed to the flipbook), below existing rows. */
export function addFlipbookRow(doc: MotionDocument, flipbookId: string): Track {
  const rows = flipbookRows(doc, flipbookId);
  const track = createTrack(`Row ${rows.length + 1}`, flipbookId);
  const lastRow = rows[rows.length - 1];
  const at = lastRow ? doc.tracks.indexOf(lastRow.track) + 1 : doc.tracks.length;
  doc.tracks.splice(at, 0, track);
  return track;
}

/**
 * Deep-duplicate a cell: a NEW drawing comp with cloned layers, inserted
 * right after the original (later cells in the row ripple down). Raster
 * layers get fresh surface ids — the returned `surfaceCopies` tell the
 * app-side surface store which pixels to clone (core never touches pixels).
 * Every cloned layer shares a `mirrorId` with its original (stamping the
 * original on first duplication), which is what mirror selection reads.
 */
export interface DuplicatedCell {
  clip: NestedClip;
  drawing: Frame;
  surfaceCopies: Array<{ from: string; to: string }>;
}

/**
 * Deep-clone a cell into a fresh, UNPLACED nested clip + drawing comp (own
 * layers, own raster surfaces under fresh ids — pixel copy is the caller's
 * job, core never touches pixels). The shared clone primitive behind cell
 * duplication and cell-clipboard copy/paste, so both ever clone a cell
 * exactly one way.
 */
function cloneFlipbookCell(doc: MotionDocument, cell: NestedClip): DuplicatedCell | null {
  const source = locateFrame(doc, cell.sourceFrameId);
  if (!source || source.mode === "flipbook") return null;

  const copy = cloneDrawingComp(doc, source);
  const clip = reissueClipIds(cell) as NestedClip;
  clip.sourceFrameId = copy.drawing.id;
  clip.name = copy.drawing.name;
  // Mirror lineage on the CELL too, so whole duplicated frames match up.
  if (!cell.mirrorId) cell.mirrorId = createId("mirror");
  clip.mirrorId = cell.mirrorId;
  return { clip, drawing: copy.drawing, surfaceCopies: copy.surfaceCopies };
}

export function duplicateFlipbookCell(doc: MotionDocument, cellId: string): DuplicatedCell | null {
  const loc = locateClip(doc, cellId);
  if (!loc || loc.clip.kind !== "nested") return null;
  const cell = loc.clip;
  const cloned = cloneFlipbookCell(doc, cell);
  if (!cloned) return null;
  cloned.clip.startMs = clipEnd(cell);

  // Ripple this row's later cells down to make room.
  for (const c of loc.track.clips) {
    if (c.frameId === cell.frameId && c.startMs >= cloned.clip.startMs && c.id !== cell.id) {
      c.startMs += cloned.clip.durationMs;
    }
  }
  loc.track.clips.push(cloned.clip);
  sortTrackClips(loc.track);
  reconcileFlipbook(doc, cell.frameId);
  return cloned;
}

/**
 * Insert copies (or, for a cut, the ORIGINAL cells moved) of `cellIds`
 * starting at an exact time in a GIVEN row — the flipbook sheet's clipboard
 * paste, landing wherever the user aimed: right after a selected cell, or
 * exactly on a selected VOID slot. Pasted cells are gapless AMONG
 * THEMSELVES (keeping the clipboard's relative order/holds), but the target
 * row is never repacked — every existing cell at/after the insertion point
 * simply RIPPLES forward by the pasted span (a pure shift), so every gap
 * already in the row, before or after the insertion point, survives
 * untouched. A cut vacates its old spot and leaves it exactly as a gap —
 * gaps are first-class, there is nothing to "close". Returns the ids of the
 * cells now sitting in the target row (fresh for a copy, the same ids for a
 * move) plus any raster surface copies the caller needs to clone pixels for.
 */
export interface FlipbookPasteResult {
  clipIds: string[];
  surfaceCopies: Array<{ from: string; to: string }>;
}

export function pasteFlipbookCellsAt(
  doc: MotionDocument,
  flipbookId: string,
  cellIds: string[],
  trackId: string,
  atMs: number,
  mode: "copy" | "move",
): FlipbookPasteResult | null {
  const fb = locateFrame(doc, flipbookId);
  if (!fb || fb.mode !== "flipbook") return null;
  const step = sheetStepMs(doc, fb);
  const start = Math.max(0, Math.round(atMs / step) * step);

  const rows = flipbookRows(doc, flipbookId);
  const anchorRowIdx = rows.findIndex((r) => r.track.id === trackId);
  if (anchorRowIdx < 0) return null;

  // Source cells in their current visual (row-major) order, so a paste keeps
  // the clipboard's relative sequence regardless of selection order.
  const wanted = new Set(cellIds);
  const ordered = rows.flatMap((r) => r.cells).filter((c): c is NestedClip => c.kind === "nested" && wanted.has(c.id));
  if (ordered.length === 0) return null;

  // Which source row each cell came from — a copy/cut spanning MULTIPLE rows
  // keeps its shape: each source row lands the same number of rows below the
  // target row that it sat below its own topmost source row. A single row
  // (or a single cell) collapses to offset 0 for everything, i.e. it just
  // lands wholesale in the target row — unchanged from before this existed.
  const sourceRowOf = new Map<string, number>();
  rows.forEach((r, i) => {
    for (const c of r.cells) if (wanted.has(c.id)) sourceRowOf.set(c.id, i);
  });
  const primaryRow = Math.min(...sourceRowOf.values());
  const byOffset = new Map<number, NestedClip[]>();
  for (const c of ordered) {
    const offset = (sourceRowOf.get(c.id) ?? primaryRow) - primaryRow;
    const bucket = byOffset.get(offset);
    if (bucket) bucket.push(c);
    else byOffset.set(offset, [c]);
  }

  const surfaceCopies: Array<{ from: string; to: string }> = [];
  const allResultClips: NestedClip[] = [];
  const trackByRow = new Map<number, Track>(rows.map((r, i) => [i, r.track]));

  for (const [offset, cells] of [...byOffset.entries()].sort((a, b) => a[0] - b[0])) {
    const targetRowIdx = anchorRowIdx + offset;
    // Ran past the last row — grow the sheet rather than drop cells.
    for (let i = trackByRow.size; i <= targetRowIdx; i++) {
      trackByRow.set(i, addFlipbookRow(doc, flipbookId));
    }
    const targetTrack = trackByRow.get(targetRowIdx)!;

    // Preserve this row's EXACT internal arrangement — including any gaps
    // between the copied cells themselves — by anchoring every cell to its
    // ms offset from the group's own earliest cell, not by repacking them
    // gapless against each other. `cells` is already startMs-ascending
    // (row-major traversal of `flipbookRows`), and each clip's `startMs`
    // still holds its ORIGINAL value at this point (cloning/splicing here
    // doesn't touch it) — read it before overwriting below.
    const groupMinStart = Math.min(...cells.map((c) => c.startMs));
    const placed: Array<{ clip: NestedClip; relStart: number }> = [];

    if (mode === "copy") {
      for (const cell of cells) {
        const relStart = cell.startMs - groupMinStart;
        const cloned = cloneFlipbookCell(doc, cell);
        if (!cloned) continue;
        placed.push({ clip: cloned.clip, relStart });
        surfaceCopies.push(...cloned.surfaceCopies);
      }
    } else {
      for (const cell of cells) {
        const relStart = cell.startMs - groupMinStart;
        const loc = locateClip(doc, cell.id);
        if (!loc) continue;
        const idx = loc.track.clips.indexOf(loc.clip);
        if (idx < 0) continue;
        loc.track.clips.splice(idx, 1);
        placed.push({ clip: loc.clip as NestedClip, relStart });
      }
    }
    if (placed.length === 0) continue;
    // The pasted block's FULL width, gaps included — not the summed cell
    // durations, which would understate it whenever the source had gaps.
    const pastedSpan = Math.max(...placed.map((p) => p.relStart + p.clip.durationMs));

    // Make room: ripple every OTHER cell already at/after the insertion
    // point forward by exactly the pasted block's width, never a full
    // repack.
    for (const c of targetTrack.clips) {
      if (c.frameId !== flipbookId || placed.some((p) => p.clip === c)) continue;
      if (c.startMs >= start - 0.5) c.startMs += pastedSpan;
    }
    for (const p of placed) {
      p.clip.startMs = start + p.relStart;
      if (!targetTrack.clips.includes(p.clip)) targetTrack.clips.push(p.clip);
    }
    sortTrackClips(targetTrack);
    allResultClips.push(...placed.map((p) => p.clip));
  }

  if (allResultClips.length === 0) return null;
  reconcileFlipbook(doc, flipbookId);
  return { clipIds: allResultClips.map((c) => c.id), surfaceCopies };
}

/**
 * DEEP-CLONE A COMP — its frame, its layers, and everything they contain.
 *
 * "Everything they contain" is the part that was missing and the part that
 * matters. `reissueClipIds` gives a clip a fresh identity; it does not and
 * cannot remap CONTAINMENT, because containment is a fact about the SET being
 * copied, not about any one clip in it. So the old copy left every cloned
 * layer's `groupId` pointing at a group clip in the ORIGINAL frame, and every
 * cloned nested clip's `sourceFrameId` pointing at the ORIGINAL's inner comp.
 *
 * The result is a duplicate that is not a duplicate:
 *
 *   • the original's group now "contains" the copy's layers, which live in a
 *     different frame — so `clipsInGroup` returns clips from two comps and
 *     anything that walks the layer tree paints or hides the wrong ones;
 *   • two cells share one inner comp, so editing either changes both;
 *   • deleting the copy leaves the original's group pointing at clips that are
 *     gone, which is why a fresh cell could still come up wearing the previous
 *     frame's artwork.
 *
 * A copy is a closed set or it is corruption. Every id minted here goes into
 * one map, and every reference INTO the set is rewritten through it: `groupId`,
 * `linkGroupId`, and a nested clip's `sourceFrameId` — the last by recursing,
 * so a comp inside a comp inside a cell copies all the way down. References
 * OUT of the set (a component master, an asset) are left alone, which is
 * exactly right: those are shared on purpose.
 */
export function cloneDrawingComp(
  doc: MotionDocument,
  source: Frame,
): { drawing: Frame; surfaceCopies: Array<{ from: string; to: string }> } {
  const surfaceCopies: Array<{ from: string; to: string }> = [];
  const drawing = cloneFrameContents(doc, source, surfaceCopies, new Set(), bumpFrameName(source.name));
  return { drawing, surfaceCopies };
}

/**
 * One comp copied whole, recursing into the comps its own layers open into.
 *
 * `guard` is the cycle break: a comp that (however it happened) contains
 * itself would otherwise recurse until the stack gives out. A guarded clip
 * keeps pointing at the shared original, which is the safe way to be wrong.
 */
function cloneFrameContents(
  doc: MotionDocument,
  source: Frame,
  surfaceCopies: Array<{ from: string; to: string }>,
  guard: Set<string>,
  name?: string,
): Frame {
  // Co-located with the source: a duplicated cell overlaps its original inside
  // the flipbook (same x/y), so focusing it needs no camera move.
  const frame: Frame = {
    ...source,
    id: createId("frame"),
    name: name ?? source.name,
    guides: source.guides.map((g) => ({ ...g })),
  };
  doc.frames.push(frame);
  guard.add(source.id);

  // The rows, their groups, links and cuts are the one comp clone's
  // (`cloneCompRows`); what is a drawing's own rides the hook.
  cloneCompRows(doc, source.id, frame.id, (clip, clone) => {
    // Stamp lineage on the ORIGINAL first so both sides share it.
    if (!clip.mirrorId) clip.mirrorId = createId("mirror");
    clone.mirrorId = clip.mirrorId;
    if (clone.kind === "raster") {
      const fresh = createId("surface");
      surfaceCopies.push({ from: clone.surfaceId, to: fresh });
      clone.surfaceId = fresh;
    }
    // A comp INSIDE this one is part of the copy, so it is copied too.
    if (clone.kind === "nested" && !guard.has(clone.sourceFrameId)) {
      const inner = doc.frames.find((f) => f.id === clone.sourceFrameId);
      // A COMPONENT master is shared on purpose — an instance of it stays an
      // instance of it, which is the whole point of components.
      if (inner && inner.component == null) {
        clone.sourceFrameId = cloneFrameContents(doc, inner, surfaceCopies, new Set(guard)).id;
      }
    }
  });
  return frame;
}

/** "Frame 3" → "Frame 4"; anything else gets a " copy" suffix. */
function bumpFrameName(name: string): string {
  const m = /^(.*?)(\d+)$/.exec(name.trim());
  if (m) return `${m[1]}${Number(m[2]) + 1}`;
  return `${name} copy`;
}

/**
 * Set a cell's hold (duration in animation frames). Rippling later cells in
 * the row keeps them from suddenly overlapping — but gaps are first-class
 * (see `moveFlipbookCell`), so this ripples by the exact DELTA (re-quantized
 * to the frame grid to self-heal any earlier sub-ms float drift, not a full
 * gapless cursor repack) — a gap a user dragged into place stays exactly the
 * width they left it, it just slides along with everything after the resize.
 */
export function setCellHoldFrames(doc: MotionDocument, cellId: string, holdFrames: number): boolean {
  const loc = locateClip(doc, cellId);
  if (!loc) return false;
  const fb = locateFrame(doc, loc.clip.frameId);
  if (!fb) return false;
  const step = sheetStepMs(doc, fb);
  const current = cellFrameCount(doc, fb, loc.clip);
  return resizeFlipbookCellHold(doc, cellId, Math.max(1, Math.round(holdFrames)) - current, step);
}

/**
 * Resize a cell's hold by a relative frame delta — push/pull, collision-
 * safe, void-aware. Only cells actually TOUCHING the resized cell's edge (in
 * a chain — a touches b touches c...) move with it, growing pushes them
 * forward and shrinking pulls them back, so a 0 gap always stays a 0 gap. A
 * real gap (void) absorbs the change first and is never crossed on its
 * own — UNLESS growth consumes it entirely and the resized cell's new edge
 * reaches the next cell, at which point pushing resumes from there. This is
 * a simple left-to-right sweep, cell by cell, comparing each one's ORIGINAL
 * gap to a running `frontier` (the previous cell's new end): a touching
 * cell (gap 0) is rigidly pinned to the frontier; a gapped cell only moves
 * if the frontier has grown past its original position — which is exactly
 * "never overlap, never invent a push a real gap could still absorb."
 */
export function resizeFlipbookCellHold(
  doc: MotionDocument,
  cellId: string,
  deltaFrames: number,
  stepMs?: number,
): boolean {
  const loc = locateClip(doc, cellId);
  if (!loc) return false;
  const fb = locateFrame(doc, loc.clip.frameId);
  if (!fb) return false;
  const step = stepMs ?? sheetStepMs(doc, fb);
  const oldDur = loc.clip.durationMs;
  const newDur = Math.max(step, oldDur + deltaFrames * step);
  if (Math.abs(newDur - oldDur) < 0.01) return false;
  const oldEnd = loc.clip.startMs + oldDur;
  loc.clip.durationMs = newDur;

  const after = loc.track.clips
    .filter((c) => c.id !== cellId && c.frameId === loc.clip.frameId && c.startMs >= oldEnd - 0.5)
    .sort((a, b) => a.startMs - b.startMs);

  let frontier = loc.clip.startMs + newDur;
  let prevOriginalEnd = oldEnd;
  for (const c of after) {
    const touching = c.startMs - prevOriginalEnd < 0.5;
    const wantStart = touching ? frontier : Math.max(c.startMs, frontier);
    prevOriginalEnd = c.startMs + c.durationMs; // capture BEFORE overwriting startMs below
    const quantized = Math.max(0, Math.round(wantStart / step) * step);
    if (Math.abs(quantized - c.startMs) >= 0.5) c.startMs = quantized;
    frontier = c.startMs + c.durationMs;
  }
  sortTrackClips(loc.track);
  // A cell's drawing layers are `fill` clips — stretch them with the hold.
  if (loc.clip.kind === "nested") reconcileFillClips(doc, loc.clip.sourceFrameId);
  reconcileFlipbook(doc, loc.clip.frameId);
  return true;
}

/**
 * Tidy the WHOLE flipbook: every row repacks gapless, cursor-first. Only
 * for the "nothing selected" case — the void slot's "Remove gaps" reaches
 * for this when there's no selection to scope to; a cell (or a real
 * selection) always uses `removeGapsBetweenSelected` instead.
 */
export function removeAllFlipbookGaps(doc: MotionDocument, flipbookId: string): boolean {
  const fb = locateFrame(doc, flipbookId);
  if (!fb) return false;
  let changed = false;
  for (const row of flipbookRows(doc, flipbookId)) {
    let cursor = 0;
    let rowChanged = false;
    for (const c of row.cells) {
      if (Math.abs(c.startMs - cursor) >= 0.5) {
        c.startMs = cursor;
        rowChanged = true;
      }
      cursor += c.durationMs;
    }
    if (rowChanged) {
      sortTrackClips(row.track);
      changed = true;
    }
  }
  if (changed) reconcileFlipbook(doc, flipbookId);
  return changed;
}

/**
 * Close the gaps BETWEEN the SELECTED cells only — never the whole sheet.
 * Each row with 2+ selected cells packs just those cells gapless (the
 * first stays exactly where it is; each later one snaps right after the
 * previous SELECTED one) — every other cell, every other row, is left
 * untouched. Refuses to move a selected cell into an unselected one caught
 * between two selected cells, rather than overlap it.
 */
export function removeGapsBetweenSelected(doc: MotionDocument, flipbookId: string, cellIds: string[]): boolean {
  const fb = locateFrame(doc, flipbookId);
  if (!fb) return false;
  const wanted = new Set(cellIds);
  let changed = false;
  for (const row of flipbookRows(doc, flipbookId)) {
    const selected = row.cells.filter((c) => wanted.has(c.id)).sort((a, b) => a.startMs - b.startMs);
    if (selected.length < 2) continue;
    let rowChanged = false;
    let cursor = selected[0]!.startMs + selected[0]!.durationMs;
    for (let i = 1; i < selected.length; i++) {
      const c = selected[i]!;
      if (Math.abs(c.startMs - cursor) >= 0.5) {
        const blocked = row.cells.some(
          (o) => !wanted.has(o.id) && o.startMs < cursor + c.durationMs - 0.5 && clipEnd(o) > cursor + 0.5,
        );
        if (!blocked) {
          c.startMs = cursor;
          rowChanged = true;
        }
      }
      cursor = c.startMs + c.durationMs;
    }
    if (rowChanged) {
      sortTrackClips(row.track);
      changed = true;
    }
  }
  if (changed) reconcileFlipbook(doc, flipbookId);
  return changed;
}

/**
 * Delete a cell, closing the gap (later cells ripple back). The drawing comp
 * is deleted with it when nothing else references it. Returns the surface ids
 * that became orphans so the app can free their pixels.
 */
export function deleteFlipbookCell(doc: MotionDocument, cellId: string): string[] | null {
  const loc = locateClip(doc, cellId);
  if (!loc) return null;
  const cell = loc.clip;
  const idx = loc.track.clips.indexOf(cell);
  loc.track.clips.splice(idx, 1);
  // Leaves a gap, not a ripple — gaps are first-class now, there's nothing
  // to "close". Shifting every later cell back used to silently destroy
  // every OTHER gap in the row the moment anything was deleted.

  const orphanSurfaces: string[] = [];
  if (cell.kind === "nested") {
    const stillUsed = doc.tracks.some((t) =>
      t.clips.some((c) => c.kind === "nested" && c.sourceFrameId === cell.sourceFrameId),
    );
    const source = locateFrame(doc, cell.sourceFrameId);
    if (!stillUsed && source && source.mode !== "flipbook" && isInternalPage(source.pageId) && source.component == null) {
      for (const track of doc.tracks) {
        for (const c of track.clips) {
          if (c.frameId === source.id && c.kind === "raster") orphanSurfaces.push(c.surfaceId);
        }
      }
      const fi = doc.frames.findIndex((f) => f.id === source.id);
      if (fi >= 0 && doc.frames.length > 1) {
        doc.frames.splice(fi, 1);
        for (const track of doc.tracks) {
          track.clips = track.clips.filter((c) => c.frameId !== source.id);
        }
      }
    }
  }
  return orphanSurfaces;
}

/*
 * FOUR PLACEMENT BRAINS LIVED HERE, and they are gone.
 *
 * `moveFlipbookCell` slid a cell and stopped dead at its neighbour.
 * `placeFlipbookCell` swapped with a single blocker and REFUSED outright if the
 * drop straddled two. `reorderFlipbookCell` / `reorderFlipbookCells` repacked
 * the row gapless by sequence index, destroying every deliberate gap in it.
 *
 * Four answers to "where does this cell go", chosen by which gesture happened
 * to call — so a drag behaved differently depending on whether one cell or two
 * were selected, and "it only moves when it already fits" was the accurate
 * description of all of them.
 *
 * `flipbook-drag.ts` answers once, and it is the same answer the sheet DRAWS
 * while your finger is still down: insert, push what you land on forward, let a
 * real gap absorb the push, never displace anything onto somebody else's frame.
 * A preview that does not predict the commit is worse than no preview, and that
 * is only achievable with one implementation.
 */

/*
 * `trimFlipbookCellStart` lived here and is gone with the other four placement
 * brains. Trimming a start is `planFlipbookCellResize(…, "start", …)` in
 * flipbook-drag.ts — the same plan the sheet draws while your finger is down,
 * rather than a second rule that ran only on release.
 */

// ── The active cell + paint context (SELECTION first, playhead fallback) ─────

/**
 * THE rule that makes drawing on a flipbook reliable — one function, four
 * consumers (the paint target, the sheet highlight, onion skinning, and the
 * selection-sync seam). Standing on a flipbook you never "enter" a cell to
 * draw on it; the ACTIVE cell is:
 *
 *   1. the SELECTED frame, if one is selected — the cell you picked in the
 *      sheet, or the cell whose drawing owns a layer you picked in the layers
 *      list. A deliberate pick wins outright and is NEVER overridden by where
 *      the playhead happens to sit (this is the fix for strokes "jumping" to a
 *      neighbouring frame: selection used to pick only the ROW, and the
 *      playhead still chose the cell inside it).
 *   2. otherwise the cell UNDER THE PLAYHEAD (the childest grandchild) —
 *      selected-row priority so a chosen row stays chosen while you scrub.
 *
 * Selecting and scrubbing are kept in lock-step by `flipbookSelectionSync`, so
 * these two rules resolve to the same cell in practice; rule 1 simply
 * guarantees the pen can never disagree with the selection for even a frame.
 */
export function activeFlipbookCell(
  doc: MotionDocument,
  flipbookId: string,
  playheadMs: number,
  selectedClipIds: readonly string[],
): NestedClip | null {
  const rows = flipbookRows(doc, flipbookId);

  // 1 — an explicit pick (cell, or a layer inside a cell's drawing) wins.
  for (const id of selectedClipIds) {
    const cell = selectedCellOf(doc, rows, id);
    if (cell && cellDrawing(doc, cell)) return cell;
  }

  // 2 — else the cell under the playhead.
  return cellUnderPlayhead(doc, flipbookId, playheadMs, selectedClipIds, rows);
}

/**
 * The cell physically under the playhead — the PLAYHEAD-first view (selected
 * row keeps priority so a chosen row stays chosen while you scrub). This is
 * what `flipbookSelectionSync` chases so that scrubbing/stepping/pausing move
 * the selection to the frame you land on; `activeFlipbookCell` prefers an
 * explicit selection over it, and the two converge because the sync keeps the
 * selection sitting on the playhead cell.
 */
function cellUnderPlayhead(
  doc: MotionDocument,
  flipbookId: string,
  playheadMs: number,
  selectedClipIds: readonly string[],
  rows = flipbookRows(doc, flipbookId),
): NestedClip | null {
  const selectedRow = rows.find((r) =>
    r.cells.some((c) => selectedClipIds.some((id) => selectedCellOf(doc, rows, id) === c)),
  );
  const ordered = selectedRow ? [selectedRow, ...rows.filter((r) => r !== selectedRow)] : rows;
  for (const row of ordered) {
    const cell = rowCellAt(doc, flipbookId, row, playheadMs);
    if (cell?.kind === "nested" && cellDrawing(doc, cell)) return cell;
  }
  return null;
}

/**
 * The cell (of these rows) a selected clip belongs to — the cell itself, or
 * the cell whose drawing holds the selected LAYER. This is what lets a pick in
 * the scoped layers list aim the pen at a specific frame's specific layer.
 */
export function selectedCellOf(doc: MotionDocument, rows: FlipbookRow[], selectedId: string): NestedClip | null {
  for (const row of rows) {
    const cell = row.cells.find((c) => c.id === selectedId);
    if (cell?.kind === "nested") return cell;
  }
  const loc = locateClip(doc, selectedId);
  if (loc) {
    for (const row of rows) {
      const cell = row.cells.find(
        (c) => c.kind === "nested" && c.sourceFrameId === loc.clip.frameId,
      );
      if (cell?.kind === "nested") return cell;
    }
  }
  return null;
}

/**
 * WHICH CELLS A SELECTION NAMES — the headless rule behind ⌘C/⌘X/Delete on a
 * flipbook, and the answer to *"I had a layer selected on the canvas, I pressed
 * Delete, and it deleted the whole frame"*.
 *
 * A cell and the artwork inside it are two different things to select, and the
 * ids alone cannot tell them apart: clicking a cell in the sheet SELECTS ITS
 * PAINT LAYER (so the pen, the layers list and the inspector all land on the
 * thing you are about to draw on — see `cellPaintTargetId`). So a layer id
 * means "this frame" in one context and "this rectangle" in another, and the
 * old rule resolved every layer id up to its cell unconditionally: on the
 * canvas, inside the cell, with a rectangle selected, Delete took the frame.
 *
 * What tells them apart is WHERE THE GESTURE CAME FROM, which is a fact the
 * caller has and the ids do not:
 *
 *   the id IS a cell                       → a cell, always.
 *   standing inside that cell, from the
 *     CANVAS                               → a layer. Leave it alone.
 *   standing inside it, from the SHEET     → the cell. The sheet's own
 *                                            selection is frames.
 *   standing outside it (layers panel,
 *     sheet, anywhere)                     → the cell it belongs to.
 *
 * Returns the cell ids, or an empty array when the selection names no frames —
 * which is the signal for ⌘C/⌘X/Delete to fall through to the ordinary clip
 * clipboard, exactly as they do everywhere else in the app.
 */
export function flipbookCellsInSelection(
  doc: MotionDocument,
  flipbookId: string,
  selectedClipIds: readonly string[],
  /** The comp the user is standing in — `targetFrameId` of the edit path. */
  standingFrameId: string | null,
  /** Whether the gesture belongs to the sheet (frames) or the canvas (artwork). */
  from: "sheet" | "canvas",
): string[] {
  const rows = flipbookRows(doc, flipbookId);
  const out: string[] = [];
  for (const id of selectedClipIds) {
    const cell = selectedCellOf(doc, rows, id);
    if (!cell) continue;
    const isCellItself = cell.id === id;
    const inside = standingFrameId != null && cell.sourceFrameId === standingFrameId;
    if (!isCellItself && inside && from === "canvas") continue;
    if (!out.includes(cell.id)) out.push(cell.id);
  }
  return out;
}

/**
 * The clip a flipbook cell's selection should point at: the drawing's topmost
 * paintable layer (raster/path/shape) — so selecting a cell focuses its CHILD
 * in the layers list and the pen lands on that layer — or the cell itself when
 * the drawing has no paintable layer yet.
 */
export function cellPaintTargetId(doc: MotionDocument, cell: NestedClip): string {
  const drawing = cellDrawing(doc, cell);
  if (!drawing) return cell.id;
  for (const track of doc.tracks) {
    if (track.hidden || track.locked) continue;
    for (const clip of track.clips) {
      if (
        clip.frameId === drawing.id &&
        (clip.kind === "raster" || clip.kind === "path" || clip.kind === "shape") &&
        !clip.hidden &&
        !clip.locked
      ) {
        return clip.id;
      }
    }
  }
  return cell.id;
}

/**
 * The selection a flipbook should hold so the pen, the sheet highlight and the
 * layers list ALL point at the same cell: the child paint layer of the active
 * cell. Returns the new selection, or null when the current one already
 * targets that cell (a deliberate cell/layer pick stands) or there's no cell
 * under the playhead. ONE seam so scrub, step, pause and add-cell all keep
 * selection ⇔ playhead in sync — the reason rule 1 and rule 2 above agree.
 */
export function flipbookSelectionSync(
  doc: MotionDocument,
  flipbookId: string,
  playheadMs: number,
  selectedClipIds: readonly string[],
): string[] | null {
  // A multi-cell selection (marquee, ⇧/⌘-click) is always a deliberate pick —
  // for cut/copy/move/delete, never something scrubbing should collapse back
  // to a single playhead-chasing cell.
  if (selectedClipIds.length > 1) return null;
  // PLAYHEAD-first on purpose: scrubbing to a new frame must retarget, even
  // when a cell is selected — that's how "scrub, pause, draw" lands on the
  // frame under the playhead. An explicit pick still stands until you move
  // off it, because clicking a cell parks the playhead ON it.
  const cell = cellUnderPlayhead(doc, flipbookId, playheadMs, selectedClipIds);
  if (!cell) return null;
  const drawingId = cell.sourceFrameId;
  const already = selectedClipIds.some(
    (id) => id === cell.id || locateClip(doc, id)?.clip.frameId === drawingId,
  );
  if (already) return null;
  return [cellPaintTargetId(doc, cell)];
}

/**
 * WHERE drawing tools land right now — the brush, eraser, bucket, lasso and
 * onion skin all read this. On a flipbook it's the active cell's drawing (+ the
 * cell, so callers map coordinates through its transform); a drawing/plain comp
 * takes strokes directly.
 *
 *  - flipbook comp  → the active cell's drawing (see `activeFlipbookCell`)
 *  - drawing comp   → itself (drilled-in deep editing)
 *  - anything else  → itself (plain comps take strokes directly)
 */
export interface PaintContext {
  /** The comp strokes/fills/layers act in. */
  frameId: string;
  /** Set when resolved THROUGH a flipbook cell (coordinate mapping + focus). */
  cell: NestedClip | null;
}

/**
 * The artboard a stage gesture acts on: the comp you are inside, and otherwise
 * the first one on the page — because a stage with a drawing tool armed is
 * always pointing AT something, whether or not anyone has drilled in yet.
 *
 * Shared because the drawing overlay and the HUD that promises what the overlay
 * will do have to agree: the overlay carried this fallback privately, the HUD
 * required an explicit active comp, and the result was a HUD that vanished in
 * exactly the ordinary case — nothing drilled into, brush armed, ready to paint.
 */
export function activeStageFrame(doc: MotionDocument, activeFrameId: string | null): Frame | null {
  return (activeFrameId ? doc.frames.find((f) => f.id === activeFrameId) : null) ?? doc.frames[0] ?? null;
}

export function paintContextAt(
  doc: MotionDocument,
  activeFrameId: string | null,
  playheadMs: number,
  selectedClipIds: readonly string[],
): PaintContext | null {
  const frame = activeFrameId ? locateFrame(doc, activeFrameId) : null;
  if (!frame) return null;
  if (frame.mode !== "flipbook") return { frameId: frame.id, cell: null };

  const cell = activeFlipbookCell(doc, frame.id, playheadMs, selectedClipIds);
  if (!cell) return null; // a gap: nothing paintable on the flipbook
  const drawing = cellDrawing(doc, cell);
  return drawing ? { frameId: drawing.id, cell } : null;
}

/**
 * The current onion "slot" on a flipbook — the row and the two neighbor anchor
 * indices around the playhead (or a selected void), whether or not a cell is
 * drawn there. This is what lets onion skinning ghost the surrounding frames
 * even on an EMPTY cell (a void, or a cell with nothing painted yet): the anchor
 * cell supplies the co-located pose to draw the neighbors through.
 */
export interface FlipbookOnionSlot {
  row: FlipbookRow;
  /** Index of the first PREV neighbor cell (walk downward from here). */
  prevAnchor: number;
  /** Index of the first NEXT neighbor cell (walk upward from here). */
  nextAnchor: number;
  /** A neighbor cell that HAS a drawing — its pose + size position the ghosts. */
  anchorCell: NestedClip | null;
  /** True when a DRAWN cell occupies the slot (vs. an empty gap/void/blank cell). */
  occupied: boolean;
}

export function flipbookOnionSlot(
  doc: MotionDocument,
  flipbookId: string,
  playheadMs: number,
  selectedClipIds: readonly string[],
  voidTrackId: string | null,
  voidMs: number | null,
): FlipbookOnionSlot | null {
  const rows = flipbookRows(doc, flipbookId);
  if (rows.length === 0) return null;

  // Which row + time? A selected void names its own track + time; otherwise the
  // selected row (or the first), read at the playhead.
  let ms = playheadMs;
  let row =
    voidTrackId != null ? rows.find((r) => r.track.id === voidTrackId) : undefined;
  if (row && voidMs != null) ms = voidMs;
  if (!row) {
    row =
      rows.find((r) =>
        r.cells.some((c) => selectedClipIds.some((id) => selectedCellOf(doc, rows, id) === c)),
      ) ?? rows[0];
  }
  if (!row) return null;

  const cells = row.cells;
  // A cell covering this time centers the slot (excluded from its own neighbors,
  // whether or not it's actually painted); an empty gap slots between neighbors.
  const present = rowCellAt(doc, flipbookId, row, ms);
  let prevAnchor: number;
  let nextAnchor: number;
  let occupied = false;
  if (present) {
    const i = cells.findIndex((c) => c.id === present.id);
    prevAnchor = i - 1;
    nextAnchor = i + 1;
    occupied = present.kind === "nested" && cellDrawing(doc, present) != null;
  } else {
    const t = trackLocalTime(row.track, flipbookId, ms);
    const q = cells.filter((c) => c.startMs < t).length; // cells entirely before the slot
    prevAnchor = q - 1;
    nextAnchor = q;
  }

  const drawnNeighbor = (start: number, dir: number): NestedClip | null => {
    for (let i = start; i >= 0 && i < cells.length; i += dir) {
      const c = cells[i];
      if (c?.kind === "nested" && cellDrawing(doc, c)) return c;
    }
    return null;
  };
  const anchorCell =
    (occupied && present?.kind === "nested" ? present : null) ??
    drawnNeighbor(prevAnchor, -1) ??
    drawnNeighbor(nextAnchor, 1);

  return { row, prevAnchor, nextAnchor, anchorCell, occupied };
}

// ── Mirror selection ────────────────────────────────────────────────────────

/**
 * Every clip sharing a lineage with `clipId` (itself included) — the "select
 * matching layers" brain. Works across duplicated cells because duplication
 * stamps `mirrorId` on both sides (see cloneDrawingComp).
 */
export function mirrorSiblings(doc: MotionDocument, clipId: string): Clip[] {
  const loc = locateClip(doc, clipId);
  if (!loc || !loc.clip.mirrorId) return loc ? [loc.clip] : [];
  const id = loc.clip.mirrorId;
  const out: Clip[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.mirrorId === id) out.push(clip);
    }
  }
  return out;
}

// ── Layer targeting (tool guards) ───────────────────────────────────────────

/** What a drawing tool needs from its target layer. */
export type PaintTargetKind = "raster" | "vector";

/**
 * Layer kinds a given tool mode can paint into. Vector tools write into path
 * clips; raster tools write into raster clips. THE guard every drawing tool
 * consults before touching a layer — and the "pick/create a layer" popover's
 * filter when the current selection can't take the stroke.
 */
export function clipAcceptsPaint(clip: Clip, kind: PaintTargetKind): boolean {
  if (clip.locked || clip.hidden) return false;
  return kind === "raster" ? clip.kind === "raster" : clip.kind === "path";
}

/** The paint-target kind a clip naturally offers (for auto-switching tools). */
export function paintKindOf(clip: Clip): PaintTargetKind | null {
  if (clip.kind === "raster") return "raster";
  if (clip.kind === "path" || clip.kind === "shape") return "vector";
  return null;
}
