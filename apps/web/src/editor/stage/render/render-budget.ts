"use client";

/**
 * WHAT A RENDER COSTS, AND HOW OFTEN THE STAGE MAY AFFORD ONE.
 *
 * ## The problem this exists for
 *
 * The stage renders on every dirty tick, whatever a render costs. For almost
 * every document that is right and free. For a heavy one it is the difference
 * between an app that is slow and an app that is BROKEN, and the two feel
 * nothing alike:
 *
 * Drag a slider on a costly layer and every pointermove writes the store, every
 * write marks the canvas dirty, and the next animation frame runs a full
 * synchronous render. If that render takes 300ms, the browser spends 300ms
 * unable to service anything — the pointermoves that arrived during it, React's
 * work, the timeline, the panels, the cursor. Then it does it again. The main
 * thread is at 100% duty and nothing on the page responds. That is exactly what
 * a Performance recording of it looks like: a solid wall of long tasks, one per
 * animation frame, with no gaps between them.
 *
 * The instinct is to make the render faster, and the layer cache does that. But
 * "fast enough" is not a property anyone can guarantee — there is always a
 * heavier project — so the guarantee has to come from somewhere else.
 *
 * ## The rule
 *
 * **Never spend more than a fixed share of wall-clock time rendering.**
 *
 * After a render that cost C, the stage waits before starting another, so the
 * thread is idle for a known fraction of every second no matter how heavy C is.
 * The canvas updates less often; the APP does not stop. A person dragging a
 * slider over a 300ms layer sees the preview move at a few frames a second —
 * which is what After Effects, Resolve and every other editor do under the same
 * load — instead of watching the entire interface freeze.
 *
 * Three properties make this honest rather than a way to hide slowness:
 *
 *  1. IT NEVER LOSES AN EDIT. The dirty flag stays set while a tick is skipped,
 *     and the render reads the document when it finally runs, so skipping
 *     COALESCES: ten slider positions become one render of the tenth. It is not
 *     dropping frames, it is declining to draw intermediate states nobody would
 *     have seen anyway.
 *  2. IT NEVER STARVES. `MAX_DEFER_MS` caps how long a pending change may wait,
 *     so a change always lands even if the cost average is wrong.
 *  3. IT DOES NOTHING TO A LIGHT DOCUMENT. Below the budget the pacer is a
 *     comparison that always passes, and the stage behaves exactly as it did.
 *
 * And nothing has to be kept to redisplay: the canvas holds the last picture
 * until something draws over it. A skipped tick is genuinely zero work.
 *
 * ## Why the cost average lives here
 *
 * `camera-raster.ts` needed the same number first, to decide whether its copy
 * was worth making. Two modules measuring "what does a render cost" would drift
 * the moment one of them learned about a new render path, so there is one, and
 * the camera raster reads it.
 */

/** A render cheaper than this needs no help from anybody — see rule 3. */
const RENDER_BUDGET_MS = 6;

/**
 * The share of wall-clock time the stage may spend rendering once it is over
 * budget. 0.5 leaves half of every second for input, React, the timeline and
 * the compositor — enough that the app stays usable while the canvas visibly
 * lags, which is the trade this whole module is making.
 */
const RENDER_DUTY = 0.5;

/** No pending change waits longer than this, whatever the average says. */
const MAX_DEFER_MS = 250;

/** Weight of the newest sample in the render-cost average. */
const COST_ALPHA = 0.25;

let costMs = 0;
let lastRenderEndMs = -Infinity;
let deferringSinceMs = -Infinity;

/**
 * Record what a full frame-content render cost.
 *
 * FULL renders only. A partial one — the incremental scene's handful of changing
 * layers — is cheap by construction, and feeding its number back in taught the
 * average that rendering was cheap, which switched the fast paths off, which
 * made the next render expensive again: a measurement loop that oscillated
 * several times a second for as long as you held the layer.
 */
export function noteRenderCost(ms: number): void {
  costMs = costMs === 0 ? ms : costMs * (1 - COST_ALPHA) + ms * COST_ALPHA;
  // FROM THE END, not the start. Measuring the gap from when a render began
  // makes the pacer a no-op by construction: the render itself consumes the
  // gap, so by the time the next animation frame asks, the wait has always
  // already elapsed. The thread is free only AFTER the render finishes, which
  // is the instant the idle window starts.
  lastRenderEndMs = performance.now();
  deferringSinceMs = -Infinity;
}

/** The current average, for anything that wants to show it. */
export function renderCostMs(): number {
  return costMs;
}

/** Is a render expensive enough to be worth deferring or rastering around? */
export function overRenderBudget(): boolean {
  return costMs > RENDER_BUDGET_MS;
}

/**
 * Should this tick skip its full content render and leave the canvas as it is?
 *
 * The caller must keep its dirty flag SET when this returns true — the change
 * has not been drawn, it has only been postponed.
 */
export function shouldDeferRender(nowMs: number): boolean {
  if (!overRenderBudget()) return false;
  // The gap that keeps the duty cycle: after spending `costMs` rendering, stay
  // out of the way for as long again (at RENDER_DUTY 0.5).
  const gapMs = costMs * (1 / RENDER_DUTY - 1);
  if (nowMs - lastRenderEndMs >= gapMs) return false;
  if (deferringSinceMs === -Infinity) deferringSinceMs = nowMs;
  // Rule 2: a pending change is never held indefinitely.
  return nowMs - deferringSinceMs < MAX_DEFER_MS;
}
