/**
 * FRAME MODES — timeline, flipbook, static — and the ONE verb that moves a
 * frame between them.
 *
 * A mode answers "how does this frame's content vary in time?" and nothing
 * else (see `frameModeSchema`). All three are comps, so a switch never builds
 * a parallel container and never throws content away. The rule every switch
 * keeps: **the picture does not move and nothing is lost**.
 *
 *   timeline ⇄ static    A pure flip. Static stills the timeline at the instant
 *                        you stood on (`stillMs`); its clips, keys and timing
 *                        are untouched, and switching back resumes there.
 *   → flipbook           A sheet's clips are CELLS, so the frame's content is
 *                        wrapped as frame 1 — a private comp in the mode it
 *                        came from. A timeline's cell spans its whole length
 *                        (the animation still plays, inside frame 1); a still's
 *                        cell holds one frame on a looping sheet (it still
 *                        shows forever, and frame 2 is one click away).
 *   flipbook →           A flip too — the cells become nested clips on tracks,
 *                        or the still shows the drawing under the playhead —
 *                        EXCEPT a sheet that never grew past its first frame:
 *                        that wrapper dissolves, so static → flipbook → static
 *                        hands back exactly the layers you started with.
 *
 * Nested frames follow the same rule at every depth because every consumer
 * reads time through `frameEvalTimeMs` (the render clock), not through the
 * mode: a still inside a timeline holds, a timeline inside a still shows one
 * moment (`setStillMoment` chooses which), a flipbook cell may be any mode.
 */

import { cellSpanMs, createDrawing, DEFAULT_SHEET_FRAMES, flipbookRows, reconcileFlipbook } from "../drawing/flipbook";
import { createTrack } from "../factories";
import type { MotionDocument, Clip, Frame, FrameMode } from "../schema";
import { clipIsAnimated } from "../export/target";
import { decomposeNestedClip } from "./decompose";
import { durationInFrames, frameFps, frameStepMs, quantizeMsToFrame } from "./fps";
import {
  clipEnd,
  clipLocalTimeAtSource,
  clipSourceTimeAt,
  compOwnerNested,
  frameDurationMs,
  locateClip,
  nestClips,
  reconcileFillClips,
} from "./ops";

export const FRAME_MODES: readonly FrameMode[] = ["timeline", "flipbook", "static"];

export interface SetFrameModeOptions {
  /**
   * The frame-local instant you are standing on — what a still shows, and
   * where a timeline resumes. Omitted = the frame's own remembered time
   * (`playheadMs`, or its still when leaving static).
   */
  atMs?: number;
}

/**
 * Move a frame to another mode, losslessly (see the module note). Mutates —
 * call inside a document update. Returns false when nothing changed: an
 * unknown id, the mode it already has, or a linked instance frame (it holds
 * no content of its own to re-time; switch its master).
 */
export function setFrameMode(
  doc: MotionDocument,
  frameId: string,
  mode: FrameMode,
  opts: SetFrameModeOptions = {},
): boolean {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame || frame.mode === mode || frame.instanceOf) return false;
  const fps = frameFps(doc, frame);
  const at = quantizeMsToFrame(Math.max(0, opts.atMs ?? frame.stillMs ?? frame.playheadMs ?? 0), fps);

  // Leaving a sheet that never grew past frame 1 dissolves the wrapper — the
  // round trip must hand back the layers, not a frame holding a frame.
  const unwrapped = frame.mode === "flipbook" ? unwrapSingleCell(doc, frame) : null;

  if (mode === "flipbook") {
    wrapAsFirstCell(doc, frame);
    return true;
  }

  const from = frame.mode;
  frame.mode = mode;
  if (mode === "static") {
    // A dissolved still keeps ITS still: the cell showed its drawing at the
    // drawing's own instant, and the drawing's layers are now the frame's.
    frame.stillMs = unwrapped?.stillMs ?? at;
  } else {
    // A timeline resumes on the moment the still showed.
    frame.playheadMs = from === "static" ? (frame.stillMs ?? 0) : (unwrapped?.stillMs ?? at);
    delete frame.stillMs;
  }
  return true;
}

/**
 * Wrap everything a frame holds as frame 1 of a sheet, and make it a flipbook.
 * An empty frame gets a blank drawing instead, exactly like a new flipbook.
 */
function wrapAsFirstCell(doc: MotionDocument, frame: Frame): void {
  const from = frame.mode;
  const fps = frameFps(doc, frame);
  const span = frameDurationMs(doc, frame);
  // Only top-level layers are named: a group's members travel with it
  // (`nestClips` expands descendants), and naming them too would pull them out
  // of their group.
  const topLevel: string[] = [];
  for (const track of doc.tracks) {
    if (track.groupId !== null) continue;
    for (const clip of track.clips) if (clip.frameId === frame.id) topLevel.push(clip.id);
  }

  // A still is ONE frame of a looping sheet (it shows forever, and drawing the
  // next frame is one click); a timeline is one cell as long as itself, so its
  // animation keeps playing inside frame 1.
  const hold = from === "static" ? 1 : durationInFrames(span, fps);
  const cellSpan = cellSpanMs(fps, 0, hold);
  const still = frame.stillMs;

  frame.mode = "flipbook";
  delete frame.stillMs;
  if (from === "static") frame.loop = "loop";
  // Keep the sheet exactly as long as the frame was, so every instance of it
  // still spans what it spanned. A frame with an auto length pins the one it
  // had; a still that never had one gets a fresh sheet's generous canvas.
  if (frame.durationMs == null) {
    frame.durationMs = from === "static" ? Math.max(span, frameStepMs(fps) * DEFAULT_SHEET_FRAMES) : span;
  }

  if (topLevel.length === 0) {
    const cell = createDrawing(doc, {
      parentFrameId: frame.id,
      startMs: cellSpan.startMs,
      durationMs: cellSpan.durationMs,
      width: frame.width,
      height: frame.height,
      name: "Frame 1",
      x: frame.x,
      y: frame.y,
    });
    const row = createTrack("Row 1", frame.id);
    row.clips.push(cell.clip);
    doc.tracks.unshift(row);
    reconcileFlipbook(doc, frame.id);
    return;
  }

  const cellId = nestClips(doc, topLevel, "Frame 1", { wholeComp: true });
  const cell = cellId ? locateClip(doc, cellId) : null;
  if (!cell || cell.clip.kind !== "nested") return;
  cell.clip.name = "Frame 1";
  cell.clip.startMs = cellSpan.startMs;
  cell.clip.durationMs = cellSpan.durationMs;
  cell.track.name = "Row 1";
  const source = doc.frames.find((f) => f.id === (cell.clip as { sourceFrameId: string }).sourceFrameId);
  if (source) {
    source.name = "Frame 1";
    // The cell is the frame it came from: a still stays a still (the drawing
    // you paint into), a timeline stays a timeline (animated frame 1).
    source.mode = from === "static" ? "static" : "timeline";
    if (from === "static") source.stillMs = still ?? 0;
    // Co-located with its sheet, like every cell (focusing it needs no camera move).
    source.x = frame.x;
    source.y = frame.y;
    reconcileFillClips(doc, source.id);
  }
  reconcileFlipbook(doc, frame.id);
}

/**
 * Dissolve a sheet that holds exactly ONE private cell at frame 0 back into
 * plain layers. Returns what the cell's drawing was showing (its still), or
 * null when the sheet is a real one and stays as cells.
 */
function unwrapSingleCell(doc: MotionDocument, frame: Frame): { stillMs: number | undefined } | null {
  const rows = flipbookRows(doc, frame.id);
  const cells = rows.flatMap((r) => r.cells);
  if (cells.length !== 1) return null;
  const cell = cells[0]!;
  if (cell.kind !== "nested" || cell.startMs > 0.5 || cell.trimInMs > 0.5) return null;
  if (cell.playback.speed !== 1 || cell.playback.reverse || cell.playback.loop !== "none") return null;
  const source = doc.frames.find((f) => f.id === cell.sourceFrameId);
  if (!source || source.mode === "flipbook" || compOwnerNested(doc, source.id) !== cell) return null;
  const stillMs = source.mode === "static" ? (source.stillMs ?? 0) : undefined;
  const row = rows.find((r) => r.cells.includes(cell))?.track ?? null;
  if (!decomposeNestedClip(doc, cell.id)) return null;
  // The row was the wrapper's; with its one cell gone it is not a lane anyone made.
  if (row && row.clips.length === 0) doc.tracks = doc.tracks.filter((t) => t !== row);
  return { stillMs };
}

/**
 * CHOOSE THE MOMENT a still shows of a nested comp inside it.
 *
 * A static parent evaluates at its still, so the child it nests shows whatever
 * instant the nested clip maps that still to. Stepping into the child and
 * scrubbing its timeline is how you pick a different one — and this is the
 * edit that makes the pick true: it SLIPS the clip (its in-point) so the
 * parent's instant lands on `childMs`, which keeps the clip where it sits on
 * any timeline. Only when the in-point cannot go that far back (it would be
 * negative) does it SLIDE the clip instead.
 *
 * Verified against the renderer's own map (`clipSourceTimeAt`), so speed ramps,
 * reverse and loops either solve exactly or are left untouched (false).
 */
export function setStillMoment(doc: MotionDocument, clipId: string, parentMs: number, childMs: number): boolean {
  const loc = locateClip(doc, clipId);
  if (!loc || loc.clip.kind !== "nested") return false;
  const clip = loc.clip;
  const target = Math.max(0, childMs);
  const lands = () => Math.abs(clipSourceTimeAt(doc, clip, Math.min(Math.max(0, parentMs - clip.startMs), clip.durationMs)) - target) < 0.5;
  if (lands()) return true;

  const before = { startMs: clip.startMs, durationMs: clip.durationMs, trimInMs: clip.trimInMs };
  // Slip: where the source would be at this instant with no in-point at all.
  clip.trimInMs = 0;
  const bare = clipSourceTimeAt(doc, clip, Math.min(Math.max(0, parentMs - clip.startMs), clip.durationMs));
  const slip = target - bare;
  if (slip >= 0) {
    clip.trimInMs = slip;
  } else {
    // Slide: start the clip early enough that the instant IS `childMs` in.
    const local = clipLocalTimeAtSource(doc, clip, target);
    clip.startMs = Math.max(0, parentMs - local);
    if (clipEnd(clip) <= parentMs) clip.durationMs = parentMs - clip.startMs + 1;
  }
  if (!lands()) {
    Object.assign(clip, before);
    return false;
  }
  if (clip.fillDuration) reconcileFillClips(doc, clip.frameId);
  return true;
}

/**
 * Can this frame's picture change over time? Answers for its CONTENT, whatever
 * its own mode — the question a still asks before it bothers showing a moment
 * picker, and the one the v88 migration asked of every old drawing.
 *
 * Deliberately conservative: an effect or an audio layer counts as change
 * (some effects move by themselves; we do not enumerate which), so "false"
 * is a promise and "true" only a maybe.
 */
export function contentVariesInTime(doc: MotionDocument, frameId: string): boolean {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame) return false;
  const span = frameDurationMs(doc, frame);
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.frameId !== frameId) continue;
      if (clipVaries(doc, clip, span)) return true;
    }
  }
  return false;
}

function clipVaries(doc: MotionDocument, clip: Clip, span: number): boolean {
  if (clip.kind === "audio") return true;
  if (clipIsAnimated(doc, clip)) return true;
  if ((clip.modulators?.length ?? 0) > 0 || Object.keys(clip.drivers ?? {}).length > 0) return true;
  if ("effects" in clip && Array.isArray(clip.effects) && clip.effects.length > 0) return true;
  // A layer that is not there for the whole frame appears or disappears.
  const covers = clip.startMs <= 0.5 && (clip.fillDuration || clipEnd(clip) >= span - 0.5);
  return !covers;
}
