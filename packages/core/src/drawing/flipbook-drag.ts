import { clipEnd, isClipLocked, locateClip, locateFrame, reconcileFillClips } from "../timeline/ops";
import { sheetStepMs, syncFlipbookLoopSpan } from "./flipbook";
import type { MotionDocument, Clip, Track } from "../schema";

/**
 * EDITING THE SHEET — one plan, previewed and committed by the same function.
 *
 * Three gestures rearrange a flipbook — move a cell, trim its start, change its
 * hold — and all three are the same question: given what the pointer is doing
 * right now, where does every cell in this row end up? So they are one planner
 * with one plan and one apply, and the sheet DRAWS the plan while your finger
 * is down.
 *
 * The sheet used to answer "where does this land" twice, in two different
 * languages. While the pointer moved, the cells being dragged rode a pure CSS
 * ghost and NOTHING else on the sheet reacted: the row you were dragging into
 * sat perfectly still, so the only way to find out what a drop would do was to
 * do it. Then on release a second, unrelated set of rules ran — a single cell
 * SWAPPED with whatever it landed on, a multi-selection instead used a clamped
 * move that refused to swap at all, and either could silently refuse.
 *
 * A preview that does not predict the commit is worse than no preview, and two
 * rule sets for one gesture is why "it only works when the cell already fits".
 *
 * So there is one function and it returns a PLAN — every cell's start, movers
 * included. The sheet renders the plan while the pointer moves (cells glide
 * aside and a gap opens under your hand, live) and applies the same plan on
 * release. What you saw is what you get, by construction rather than by two
 * implementations agreeing.
 *
 * ## The rule: displaced cells fall INTO THE HOLE, not away from it
 *
 * Movers go where you put them, and whatever they now overlap moves aside. The
 * whole of the design is WHICH WAY aside, and getting that backwards makes the
 * sheet impossible to rearrange:
 *
 * A drag always leaves a hole behind it — the slot the mover just vacated — and
 * that hole is exactly the room the displaced cells need. So the push runs
 * AGAINST the direction of travel, back toward the origin. Drag right, and the
 * cells you land on shuffle LEFT into the space you came from; drag left and
 * they shuffle right. The row's length does not change and no gap appears: what
 * happens is a REORDER, which is what dragging a frame into the middle of a
 * sequence has always meant.
 *
 * Pushing forward instead — which is the obvious implementation, and was the
 * first one — grows the row by a frame and leaves a hole where the mover was,
 * every single time. Dropping a cell BETWEEN two others then becomes
 * impossible: the two you aimed between are shoved along ahead of you and the
 * gap you were aiming at travels with them. (It looks fine dragging right to
 * left, because there the forward push happens to be the correct direction.)
 *
 * The chain is absorbed by the first real gap it meets, the same "a gap absorbs
 * it first" rule the hold resize obeys — so cells past the drop are untouched,
 * and a deliberate void is not silently eaten.
 *
 * When the hole cannot absorb the chain — the row would run past zero, or a
 * LOCKED cell stands in the way — the row is re-planned pushing forward
 * instead. That is the honest answer to "there is genuinely no room this way",
 * and it is also exactly right for a ⌥-COPY, which leaves no hole at all
 * because the original stays: inserting a new frame really does lengthen the
 * row.
 *
 * Rows are independent — a mover in row A can never collide with one in row B —
 * so each is planned on its own with no coordination between them.
 */

/** Half a frame's tolerance is far too coarse; a fraction of a ms is enough to
 *  keep two "same" boundary times from reading as an overlap. */
const EPS = 0.5;

export interface FlipbookDragPlan {
  /** Every cell whose start CHANGES, id → new startMs. Movers included. */
  readonly starts: ReadonlyMap<string, number>;
  /** Every cell whose DURATION changes, id → new durationMs (trims/holds). */
  readonly durations: ReadonlyMap<string, number>;
  /** The cells the gesture acts on, ordered by their original start. */
  readonly movers: readonly Clip[];
  /** The quantised distance actually applied (clamped so nothing goes < 0). */
  readonly deltaMs: number;
}

const EMPTY_PLAN: FlipbookDragPlan = {
  starts: new Map(),
  durations: new Map(),
  movers: [],
  deltaMs: 0,
};

/**
 * Plan a drag of `moverIds` by `deltaMs` within one flipbook.
 *
 * `copy` is the ⌥ gesture: the movers are NEW cells landing at the offset
 * position while the originals hold their slots, so the originals join the
 * cells that may be pushed. Passing it here rather than branching at the call
 * site is what keeps duplicate-drag and move-drag from growing separate
 * placement rules — they differ by one boolean and nothing else.
 */
export function planFlipbookCellDrag(
  doc: MotionDocument,
  flipbookId: string,
  moverIds: readonly string[],
  deltaMs: number,
  opts: { copy?: boolean } = {},
): FlipbookDragPlan {
  const fb = locateFrame(doc, flipbookId);
  if (!fb) return EMPTY_PLAN;
  const step = sheetStepMs(doc, fb);
  if (step <= 0) return EMPTY_PLAN;

  const movers: Clip[] = [];
  const trackOfMover = new Map<string, string>();
  for (const id of moverIds) {
    const loc = locateClip(doc, id);
    if (!loc || loc.clip.frameId !== flipbookId) continue;
    movers.push(loc.clip);
    trackOfMover.set(id, loc.track.id);
  }
  if (movers.length === 0) return EMPTY_PLAN;
  movers.sort((a, b) => a.startMs - b.startMs);

  // Quantise to the sheet's grid, then clamp ONCE for the whole group so the
  // selection keeps its shape when its leading cell reaches zero. Clamping per
  // cell would silently compress a multi-frame selection against the start.
  const earliest = Math.min(...movers.map((c) => c.startMs));
  const delta = Math.max(Math.round(deltaMs / step) * step, -earliest);

  const starts = new Map<string, number>();
  const moverIdSet = new Set(movers.map((c) => c.id));

  // Rows are independent — plan only the ones a mover actually lands in.
  const touchedTracks = new Set(trackOfMover.values());
  for (const trackId of touchedTracks) {
    const track = doc.tracks.find((t) => t.id === trackId);
    if (!track) continue;

    /** Where the dragged cells will sit in this row, in start order. */
    const blocks = movers
      .filter((c) => trackOfMover.get(c.id) === trackId)
      .map((c) => ({ start: c.startMs + delta, end: c.startMs + delta + c.durationMs }))
      .sort((a, b) => a.start - b.start);

    // Everything else in the row, in its current order. On a COPY the originals
    // stay put and are therefore push candidates like any other cell.
    const others = track.clips
      .filter((c) => c.frameId === flipbookId && (opts.copy || !moverIdSet.has(c.id)))
      .sort((a, b) => a.startMs - b.startMs);

    const locked = others.filter((c) => isClipLocked(track, c));
    // Landing the block ON a locked cell is refused outright rather than
    // fudged: a lock that only stopped you dragging the cell itself would be
    // half a lock. Refusing means an EMPTY plan, so the sheet simply shows no
    // reflow — which reads as "not there" without needing a message.
    for (const b of blocks) {
      for (const c of locked) {
        if (b.start < clipEnd(c) - EPS && b.end > c.startMs + EPS) return EMPTY_PLAN;
      }
    }
    const walls = [
      ...blocks,
      ...locked.map((c) => ({ start: c.startMs, end: clipEnd(c) })),
    ].sort((a, b) => a.start - b.start);

    // A copy leaves no hole behind it, so there is nothing to fall into and the
    // row genuinely does get longer. Everything else falls back toward origin.
    const backward = !opts.copy && delta > 0;
    const placed = backward
      ? placeTowardStart(others, track, walls)
      : placeTowardEnd(others, track, walls);
    // The backward pass gives up rather than compressing the row past zero or
    // shoving a locked cell; forward always succeeds, so it is the fallback.
    const resolved = placed ?? placeTowardEnd(others, track, walls)!;
    for (const [id, startMs] of resolved) starts.set(id, startMs);
  }

  if (!opts.copy) {
    for (const c of movers) {
      const next = c.startMs + delta;
      if (Math.abs(next - c.startMs) >= EPS) starts.set(c.id, next);
    }
  }
  return { starts, durations: new Map(), movers, deltaMs: delta };
}


/**
 * Plan a RESIZE — the two trim grips, previewed exactly like a move.
 *
 * `edge: "hold"` drags the right edge: the cell's hold grows or shrinks and the
 * cells behind it RIPPLE, but only the ones actually touching the chain. A real
 * gap absorbs the change and everything past it holds still, which is the same
 * sentence the move planner obeys and the reason a sheet full of deliberate
 * voids survives being edited.
 *
 * `edge: "start"` drags the left edge: the start moves and the END stays put,
 * so the hold grows from the front. Nothing else in the row can be affected —
 * the cell is only ever eating into the space before it, which is bounded by
 * the previous cell's end.
 *
 * Both used to write the DOCUMENT on every pointer move, through
 * `setCellHoldFrames` / `trimFlipbookCellStart` with a history merge key. That
 * is an immer patch, a history entry and a re-render of the sheet, the stage
 * and the inspector per pointer event — at 120Hz on a laptop it is the entire
 * reason trimming felt like it was fighting you. Now it is arithmetic during
 * the drag and one write on release.
 */
export function planFlipbookCellResize(
  doc: MotionDocument,
  flipbookId: string,
  cellIds: readonly string[],
  edge: "start" | "hold",
  deltaMs: number,
): FlipbookDragPlan {
  const fb = locateFrame(doc, flipbookId);
  if (!fb) return EMPTY_PLAN;
  const step = sheetStepMs(doc, fb);
  if (step <= 0) return EMPTY_PLAN;
  const delta = Math.round(deltaMs / step) * step;

  const targets: Array<{ clip: Clip; track: Track }> = [];
  for (const id of cellIds) {
    const loc = locateClip(doc, id);
    if (!loc || loc.clip.frameId !== flipbookId || isClipLocked(loc.track, loc.clip)) continue;
    targets.push({ clip: loc.clip, track: loc.track });
  }
  if (targets.length === 0) return EMPTY_PLAN;

  const starts = new Map<string, number>();
  const durations = new Map<string, number>();

  for (const { clip, track } of targets) {
    if (edge === "start") {
      // The end is fixed; the start may not cross it, nor the cell before it.
      const end = clipEnd(clip);
      let floor = 0;
      for (const c of track.clips) {
        if (c.id === clip.id || c.frameId !== flipbookId) continue;
        if (clipEnd(c) <= clip.startMs + EPS) floor = Math.max(floor, clipEnd(c));
      }
      const want = Math.min(Math.max(clip.startMs + delta, floor), end - step);
      if (Math.abs(want - clip.startMs) >= EPS) {
        starts.set(clip.id, want);
        durations.set(clip.id, end - want);
      }
      continue;
    }

    const nextDur = Math.max(step, clip.durationMs + delta);
    const shift = nextDur - clip.durationMs;
    if (Math.abs(shift) < EPS) continue;
    durations.set(clip.id, nextDur);

    // RIPPLE the touching chain behind it. `touching` walks forward while each
    // cell begins exactly where the previous one ended; the first real gap ends
    // the chain and absorbs the change.
    const after = track.clips
      .filter((c) => c.frameId === flipbookId && c.startMs >= clipEnd(clip) - EPS)
      .sort((a, b) => a.startMs - b.startMs);
    let edgeMs = clipEnd(clip);
    for (const c of after) {
      if (Math.abs(c.startMs - edgeMs) >= EPS) break; // a gap — stop here
      if (isClipLocked(track, c)) break; // a locked cell absorbs nothing
      starts.set(c.id, c.startMs + shift);
      edgeMs = clipEnd(c);
    }
  }

  if (starts.size === 0 && durations.size === 0) return EMPTY_PLAN;
  return { starts, durations, movers: targets.map((t) => t.clip), deltaMs: delta };
}


/**
 * Lay the row out walking FORWARD, pushing displaced cells toward the end.
 *
 * `cursor` is the earliest free time so far, so a cell that already clears
 * everything keeps its own start — which is what makes a real gap absorb the
 * push instead of the whole tail shifting. Always succeeds: there is no
 * boundary in this direction.
 */
function placeTowardEnd(
  others: readonly Clip[],
  track: Track,
  walls: ReadonlyArray<{ start: number; end: number }>,
): Map<string, number> {
  const out = new Map<string, number>();
  let cursor = 0;
  for (const c of others) {
    if (isClipLocked(track, c)) {
      cursor = Math.max(cursor, clipEnd(c));
      continue;
    }
    let start = Math.max(c.startMs, cursor);
    // Walls are sorted and every push moves `start` forward, so one pass clears
    // them all: a cell shoved past one wall can only meet later ones.
    for (const w of walls) {
      if (start < w.end - EPS && start + c.durationMs > w.start + EPS) start = w.end;
    }
    if (Math.abs(start - c.startMs) >= EPS) out.set(c.id, start);
    cursor = start + c.durationMs;
  }
  return out;
}

/**
 * Lay the row out walking BACKWARD, pushing displaced cells toward the start —
 * into the hole the mover left. THE reorder pass.
 *
 * `limit` is the earliest start already claimed, so a cell only moves when the
 * one after it has taken its space, and the chain stops at the first cell with
 * room to spare. Returns null when the row cannot absorb it (past zero, or a
 * locked cell in the way); the caller then falls forward.
 */
function placeTowardStart(
  others: readonly Clip[],
  track: Track,
  walls: ReadonlyArray<{ start: number; end: number }>,
): Map<string, number> | null {
  const out = new Map<string, number>();
  let limit = Infinity;
  for (let i = others.length - 1; i >= 0; i--) {
    const c = others[i]!;
    if (isClipLocked(track, c)) {
      // Immovable. Anything earlier must finish before it starts, and if the
      // chain has already been pushed past that point there is no room here.
      if (clipEnd(c) > limit + EPS) return null;
      limit = Math.min(limit, c.startMs);
      continue;
    }
    let start = c.startMs;
    for (let pass = 0; pass < walls.length + 1; pass++) {
      let moved = false;
      for (const w of walls) {
        if (start < w.end - EPS && start + c.durationMs > w.start + EPS) {
          start = w.start - c.durationMs;
          moved = true;
        }
      }
      if (start + c.durationMs > limit + EPS) {
        start = limit - c.durationMs;
        moved = true;
      }
      if (!moved) break;
    }
    if (start < -EPS) return null; // the hole could not absorb the chain
    if (Math.abs(start - c.startMs) >= EPS) out.set(c.id, start);
    limit = Math.min(limit, start);
  }
  return out;
}

/**
 * Apply a plan. The commit half of the same decision the sheet has been drawing
 * for the whole gesture — deliberately dumb, because every rule already ran
 * when the plan was made.
 */
export function applyFlipbookDragPlan(doc: MotionDocument, plan: FlipbookDragPlan): boolean {
  let changed = false;
  for (const [id, durationMs] of plan.durations) {
    const loc = locateClip(doc, id);
    if (!loc || Math.abs(loc.clip.durationMs - durationMs) < EPS) continue;
    loc.clip.durationMs = Math.max(1, durationMs);
    changed = true;
    /*
     * A CELL'S LENGTH IS ITS DRAWING'S LENGTH.
     *
     * The layers inside a cell are `fillDuration` — they span the drawing, and
     * the drawing's span is this clip's. Retime the cell without re-spanning
     * them and the paint simply stops partway through the hold: a layer with an
     * out-animation FADES there, one without it disappears, and either reads as
     * "the frame I am standing on went dim by itself".
     *
     * Both primitives this planner replaced did it, and dropping it was the one
     * behaviour that did not survive the move. Duration only — a cell's START
     * moving does not change how long its drawing is.
     */
    if (loc.clip.kind === "nested") reconcileFillClips(doc, loc.clip.sourceFrameId);
  }
  for (const [id, startMs] of plan.starts) {
    const loc = locateClip(doc, id);
    if (!loc || Math.abs(loc.clip.startMs - startMs) < EPS) continue;
    loc.clip.startMs = Math.max(0, startMs);
    changed = true;
  }
  if (!changed) return false;
  for (const track of doc.tracks) track.clips.sort((a, b) => a.startMs - b.startMs);
  // Pushing cells forward can grow the sheet past its owner clip's length; the
  // one place that reconciles the two is called here so a drag cannot leave a
  // frame that plays nowhere.
  const flipbookIds = new Set(plan.movers.map((c) => c.frameId));
  for (const id of flipbookIds) syncFlipbookLoopSpan(doc, id);
  return true;
}
