import type { MotionDocument } from "../schema";
import { locateClip } from "../timeline/ops";
import { childTimeOf } from "./context";
import { playheadBetweenPaths } from "./selection";
import { editPath, pathToFrame, targetFrameId, type EditPath } from "./path";

/**
 * THE TIME AUTHORITY — reading and writing the playhead in SOMEBODY ELSE'S
 * time.
 *
 * The playhead is one instant. What changes as you drill is only the coordinate
 * system it is reported in: standing in a flipbook, `playheadMs` counts sheet
 * time; standing inside one of its cells, it counts that drawing's own local
 * time. Both are true statements about the same moment.
 *
 * Every surface that shows a comp OTHER than the one you are standing in needs
 * to convert. The flipbook sheet is the extreme case — it is always drawn in
 * flipbook time even while you are drilled two levels down into a cell's paint
 * layer — and it used to convert by hand, in three places, with three different
 * rules:
 *
 *   - the ruler subtracted `drilledCell.startMs` when it felt in range and
 *     re-navigated when it did not, MID-DRAG, so crossing a cell boundary while
 *     scrubbing flipped the coordinate system under the gesture;
 *   - clicking a cell called `revealFrame(source, 0)` — a hard "time is now
 *     zero", which is why focusing a frame moved the playhead and moving the
 *     playhead refocused a frame, each undoing the other;
 *   - a React effect ascended on Play with a fourth expression again.
 *
 * None of those are bugs in their own right. They are three answers to a
 * question that must have one, which is what "patchy" always turns out to mean.
 *
 * So: two pure functions. {@link playheadInFrame} reads the instant in a
 * frame's own time; {@link seekInFrame} writes one, returning the standing
 * point that can express it. `packages/core` already had the hard half of both
 * (`playheadBetweenPaths`, `childTimeOf`) — what was missing was addressing
 * them BY FRAME rather than by path, which is all any surface actually knows.
 */

/** Where to stand, and what the playhead reads there, after a seek. */
export interface SeekPlan {
  /** The path to stand on. Equal to the one passed in whenever possible. */
  path: EditPath;
  /** The playhead value, expressed in `path`'s target time. */
  playheadMs: number;
  /** True when expressing the instant required leaving where we stood. */
  moved: boolean;
}

/**
 * The path to `frameId` PREFERRING a prefix of where we already stand.
 *
 * `pathToFrame` answers from the document's own ownership chain, which is right
 * in isolation and wrong here: a flipbook opened as its own root tab has a
 * canonical path rooted at ITS owner, and mapping against that would navigate
 * away from the tab the user is looking at. Standing inside something is the
 * better answer about where it is than the document's ancestry is.
 */
function pathToFrameFrom(doc: MotionDocument, standing: EditPath, frameId: string): EditPath {
  for (let depth = 0; depth <= standing.hops.length; depth++) {
    const candidate = editPath(standing.rootFrameId, standing.hops.slice(0, depth));
    if (targetFrameId(doc, candidate) === frameId) return candidate;
  }
  return pathToFrame(doc, frameId);
}

/**
 * The playhead as `frameId`'s own clock reads it.
 *
 * Ascends through trims and speeds when the frame is an ancestor of where we
 * stand, descends when it is inside, and answers unchanged for a frame with no
 * relationship to here — there is no honest mapping between two unrelated
 * timelines, and inventing one is worse than admitting it.
 */
export function playheadInFrame(
  doc: MotionDocument,
  standing: EditPath,
  playheadMs: number,
  frameId: string,
): number {
  const target = pathToFrameFrom(doc, standing, frameId);
  return playheadBetweenPaths(doc, standing, target, playheadMs);
}

/**
 * Put the playhead at `ms`, as measured by `frameId`'s clock.
 *
 * The subtle half is what happens when the instant is not expressible from
 * where you stand — scrubbing a flipbook sheet to frame 40 while drilled into
 * frame 2's drawing. Local time inside a cell is CLAMPED to that cell by
 * construction (`childTimeOf`), so staying put would silently pin the playhead
 * at the cell's edge and the sheet would fight the ruler for the rest of the
 * drag.
 *
 * So the plan steps OUT to the frame being addressed, in the same single
 * decision that computes the time. One atomic answer instead of a navigation
 * and a seek racing each other from two different handlers, which is what made
 * this feel broken rather than merely surprising.
 */
export function seekInFrame(
  doc: MotionDocument,
  standing: EditPath,
  frameId: string,
  ms: number,
): SeekPlan {
  const at = Math.max(0, ms);
  const target = pathToFrameFrom(doc, standing, frameId);
  const stepOut: SeekPlan = { path: target, playheadMs: at, moved: true };
  if (target.rootFrameId !== standing.rootFrameId) return stepOut;

  // Standing at or ABOVE the addressed frame: the ordinary mapping applies and
  // nothing has to move (an ancestor's clock can always express a descendant's
  // instant — it is the descendant's that is bounded).
  const inside =
    target.hops.length <= standing.hops.length &&
    target.hops.every((hop, i) => standing.hops[i] === hop);
  if (!inside) {
    return { path: standing, playheadMs: playheadBetweenPaths(doc, target, standing, at), moved: false };
  }

  // Standing INSIDE it: descend hop by hop, refusing to clamp. The first hop
  // that does not contain the instant is proof that where we stand cannot
  // express it.
  let t = at;
  for (let i = target.hops.length; i < standing.hops.length; i++) {
    const clip = locateClip(doc, standing.hops[i]!)?.clip;
    if (!clip) return stepOut;
    if (t < clip.startMs || t >= clip.startMs + clip.durationMs) return stepOut;
    t = childTimeOf(doc, clip, t);
  }
  return { path: standing, playheadMs: Math.max(0, t), moved: false };
}
