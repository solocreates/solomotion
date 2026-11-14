import { z } from "zod";
import {
  addFlipbookCell,
  addFlipbookCellAt,
  addFlipbookRow,
  cellDrawing,
  deleteFlipbookCell,
  duplicateFlipbookCell,
  flipbookRows,
  isFlipbookFrame,
  setCellHoldFrames,
} from "../../drawing/flipbook";
import { cellFrameCount, frameFps, frameStepMs, msToFrameIndex } from "../../timeline/fps";
import type { MotionDocument, Frame } from "../../schema";
import { ApiError, defineCommand } from "../command";
import { requireClip, requireFrame } from "../lookup";

/**
 * FRAME-BY-FRAME, AS COMMANDS.
 *
 * A flipbook is rows of CELLS; each cell is a nested drawing comp held for a
 * whole number of animation frames. The sheet already had a complete headless
 * brain (`drawing/flipbook.ts`), but the API stopped at `frame.create
 * {mode:"flipbook"}` — an agent could make the sheet and then had no way to put
 * a second drawing in it, so it hand-built "frame-by-frame" out of nested comps
 * laid side by side on a timeline. These two verbs are that brain, exposed: the
 * cells are read and written exactly the way the sheet UI does it.
 *
 * Drawing INTO a cell is ordinary layer work: every cell names its `drawingId`,
 * and `layer_add` / `layer_patch` with that `frameId` fill it.
 */

function requireFlipbook(doc: MotionDocument, id: string): Frame {
  const frame = requireFrame(doc, id);
  if (!isFlipbookFrame(frame)) {
    throw new ApiError(`"${frame.name}" is a ${frame.mode} comp, not a flipbook.`, 'Make one with frame_create {mode:"flipbook"} or switch it with frame_update {mode:"flipbook"}.');
  }
  return frame;
}

/** The sheet as an agent reads it: rows of cells in frames, each with the comp it draws. */
function describeSheet(doc: MotionDocument, fb: Frame) {
  const fps = frameFps(doc, fb);
  return {
    fps,
    rows: flipbookRows(doc, fb.id).map((row, index) => ({
      row: index,
      cells: row.cells.map((cell) => ({
        id: cell.id,
        drawingId: cellDrawing(doc, cell)?.id ?? null,
        name: cell.name,
        frame: msToFrameIndex(cell.startMs, fps),
        hold: cellFrameCount(doc, fb, cell),
      })),
    })),
  };
}

export const flipbookCells = defineCommand({
  id: "flipbook.cells",
  summary: "A flipbook's sheet: its rows and cells — where each cell starts (frame), how long it holds, and the drawing comp to fill.",
  details:
    "`frame` and `hold` are ANIMATION FRAMES at the sheet's fps, not ms. `drawingId` is the comp a cell shows — add layers to it with layer_add {frameId: drawingId}. Rows stack top to bottom like timeline tracks (row 0 on top).",
  effect: "read",
  input: z.object({ id: z.string().describe("The flipbook comp.") }),
  run(input, rt) {
    const doc = rt.doc();
    return describeSheet(doc, requireFlipbook(doc, input.id));
  },
});

const flipbookOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    row: z.number().int().min(0).default(0).describe("Which row (0 = top). Use op addRow first for a new one."),
    count: z.number().int().min(1).max(240).default(1).describe("How many blank drawings to append, one after another."),
    hold: z.number().int().min(1).max(240).optional().describe("Frames each new cell holds (2 = on twos). Default: the row's last cell's hold, else 1."),
    at: z.number().int().min(0).optional().describe("Start frame for a single cell placed in an EMPTY slot; omitted = after the row's last cell."),
  }),
  z.object({ op: z.literal("duplicate"), cellId: z.string().describe("Cell to copy; the copy lands right after it and later cells ripple down.") }),
  z.object({ op: z.literal("hold"), cellId: z.string(), frames: z.number().int().min(1).max(240) }),
  z.object({ op: z.literal("delete"), cellId: z.string() }),
  z.object({ op: z.literal("addRow") }),
]);

export const flipbookEdit = defineCommand({
  id: "flipbook.edit",
  summary: "Build a flipbook's sheet: add blank drawings, duplicate a drawing to tweak it, set a cell's hold, delete cells, add rows. One undo step.",
  details:
    "Frame-by-frame animation is a FLIPBOOK, never nested comps laid out on a timeline by hand. Typical: frame_create {mode:\"flipbook\", fps:12} → flipbook_edit {ops:[{op:\"add\", count:7}]} → fill each new cell's drawingId with layer_add → view_frames to check the motion. Duplicate a drawing and change it slightly for the next pose (in-betweens). Returns the sheet as flipbook_cells does, plus the ids of the cells this call made.",
  effect: "write",
  input: z.object({ id: z.string().describe("The flipbook comp."), ops: z.array(flipbookOp).min(1) }),
  run(input, rt) {
    requireFlipbook(rt.doc(), input.id);
    const made: string[] = [];
    rt.write("Edit flipbook", (d) => {
      for (const op of input.ops) {
        const fb = requireFlipbook(d, input.id);
        if (op.op === "addRow") {
          addFlipbookRow(d, fb.id);
          continue;
        }
        if (op.op === "add") {
          const row = flipbookRows(d, fb.id)[op.row];
          if (!row) throw new ApiError(`The flipbook has no row ${op.row}.`, "Rows are numbered from 0; add one with {op:\"addRow\"}.");
          if (op.at !== undefined && op.count > 1) throw new ApiError("`at` places one cell; drop `count` or `at`.");
          for (let i = 0; i < op.count; i++) {
            const created =
              op.at !== undefined
                ? addFlipbookCellAt(d, fb.id, row.track.id, op.at * frameStepMs(frameFps(d, fb)), op.hold)
                : addFlipbookCell(d, fb.id, row.track.id, op.hold);
            if (!created) throw new ApiError("That cell could not be added.");
            made.push(created.clip.id);
          }
          continue;
        }
        const cell = requireClip(d, op.cellId).clip;
        if (cell.frameId !== fb.id) throw new ApiError("That cell belongs to another comp.", "Read this sheet's cells with flipbook_cells.");
        if (op.op === "duplicate") {
          // Painted pixels live in the app's surface store, which a command
          // cannot copy — a duplicate that silently came out blank would be
          // worse than saying so. A paint layer nobody has painted (rev 0, the
          // one every blank cell starts with) has nothing to lose.
          const drawing = cellDrawing(d, cell);
          if (drawing && hasPaint(d, drawing.id)) {
            throw new ApiError("That drawing has painted (raster) pixels, which only the editor can copy.", "Duplicate it in the sheet, or add a blank cell and rebuild it from shapes.");
          }
          const copy = duplicateFlipbookCell(d, cell.id);
          if (!copy) throw new ApiError("That cell could not be duplicated.");
          made.push(copy.clip.id);
        } else if (op.op === "hold") {
          setCellHoldFrames(d, cell.id, op.frames);
        } else {
          if (!deleteFlipbookCell(d, cell.id)) throw new ApiError("That cell could not be deleted.");
        }
      }
    });
    const doc = rt.doc();
    return { ...describeSheet(doc, requireFlipbook(doc, input.id)), made };
  },
});

/** Does anything in this comp carry painted pixels? */
function hasPaint(doc: MotionDocument, frameId: string): boolean {
  return doc.tracks.some((t) =>
    t.clips.some((c) => c.frameId === frameId && c.kind === "raster" && (c.rev > 0 || Object.values(c.captureRevs ?? {}).some((r) => r > 0))),
  );
}

export const FLIPBOOK_COMMANDS = [flipbookCells, flipbookEdit];
