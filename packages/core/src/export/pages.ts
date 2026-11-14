/**
 * EXPORT PAGES — which instants of which frames become pages (of a PDF) or
 * files (of a batch). Headless, so the dialog's page count, the PDF writer and
 * any agent that asks all read one answer.
 *
 * Two samplings:
 *  - "current": every frame once, at the instant it is showing — a still at its
 *    still, a timeline at its own playhead. What you see is what you get.
 *  - "every":   every frame of every frame — a still is still one page; a
 *    flipbook is one page per DRAWING (a held cell is one page, not six); a
 *    timeline is one page per frame of its own rate.
 *
 * Order is the order the frames were given (the order you picked them).
 */

import type { MotionDocument, Frame } from "../schema";
import { flipbookRows, trackLocalTime } from "../drawing/flipbook";
import { frameEvalTimeMs, frameFps, frameIndexToMs, frameStillMs } from "../timeline/fps";
import { frameDurationMs } from "../timeline/ops";

export type PageSampling = "current" | "every";

export interface ExportPage {
  frameId: string;
  /** Frame-local instant, already on the render clock (a still's still). */
  timeMs: number;
  /** This page's position among its frame's pages, and how many that frame has. */
  index: number;
  count: number;
}

export interface PagePlan {
  pages: ExportPage[];
  /** True when "every" hit `maxPages` and later pages were left out. */
  truncated: boolean;
}

export interface PagePlanOptions {
  sampling: PageSampling;
  /** The instant a frame is showing right now (session playhead, or its remembered time). */
  currentTimeOf: (frameId: string) => number;
  /** Ceiling across the whole plan. Default 1000. */
  maxPages?: number;
}

/** A PDF point per pixel — Figma's convention, so a 595×842 frame is an A4 page. */
export const PDF_POINTS_PER_PX = 1;

export function planExportPages(doc: MotionDocument, frameIds: readonly string[], opts: PagePlanOptions): PagePlan {
  const max = Math.max(1, opts.maxPages ?? 1000);
  const pages: ExportPage[] = [];
  let truncated = false;
  for (const id of frameIds) {
    const frame = doc.frames.find((f) => f.id === id);
    if (!frame) continue;
    const times =
      opts.sampling === "current"
        ? [frameEvalTimeMs(doc, frame, opts.currentTimeOf(id))]
        : everyFrameTimes(doc, frame);
    for (let i = 0; i < times.length; i++) {
      if (pages.length >= max) {
        truncated = true;
        break;
      }
      pages.push({ frameId: id, timeMs: times[i]!, index: i, count: times.length });
    }
    if (truncated) break;
  }
  return { pages, truncated };
}

/** How many pages "every" would make, without building them (for the dialog's label). */
export function countEveryFramePages(doc: MotionDocument, frameIds: readonly string[]): number {
  let n = 0;
  for (const id of frameIds) {
    const frame = doc.frames.find((f) => f.id === id);
    if (frame) n += everyFrameTimes(doc, frame).length;
  }
  return n;
}

/**
 * Every distinct picture a frame has, as frame-local instants on its grid.
 */
export function everyFrameTimes(doc: MotionDocument, frame: Frame): number[] {
  const still = frameStillMs(frame);
  if (still !== null) return [frameEvalTimeMs(doc, frame, still)];
  const fps = frameFps(doc, frame);
  const total = Math.max(1, Math.round(frameDurationMs(doc, frame) / (1000 / fps)));
  const grid = Array.from({ length: total }, (_, i) => frameIndexToMs(i, fps));
  if (frame.mode !== "flipbook") return grid;

  // A sheet changes picture only where a row changes cell. Consecutive frames
  // showing the same cells in every row are ONE drawing — unless a cell there
  // moves by itself (an animated cell), in which case each frame is its own.
  // A void (no row holds a cell) is not a drawing, so it is not a page.
  const rows = flipbookRows(doc, frame.id);
  const out: number[] = [];
  let last: string | null = null;
  for (const t of grid) {
    let signature = "";
    let moving = false;
    let any = false;
    for (const row of rows) {
      const local = trackLocalTime(row.track, frame.id, t);
      const cell = row.cells.find((c) => local >= c.startMs && local < c.startMs + c.durationMs);
      signature += `${cell?.id ?? "-"}|`;
      if (cell) any = true;
      if (cell?.kind === "nested") {
        const source = doc.frames.find((f) => f.id === cell.sourceFrameId);
        if (source && source.mode !== "static") moving = true;
      }
    }
    if (any && (moving || signature !== last)) out.push(t);
    last = signature;
  }
  return out.length > 0 ? out : [grid[0]!];
}
