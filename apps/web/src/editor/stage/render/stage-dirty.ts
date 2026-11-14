"use client";

/**
 * ASK THE STAGE FOR A FRAME.
 *
 * The render loop is dirty-flagged: it draws when something says the picture
 * changed and otherwise does nothing, which is what makes an idle editor cost
 * zero. Almost everything that changes the picture is a store write, so almost
 * nothing needs this.
 *
 * The RAM preview build does. It steps the playhead and waits for the frame to
 * appear in the cache — but when the playhead is ALREADY at the instant being
 * built (the commonest case at the start of a range, because you are parked
 * there), setting it writes nothing, nothing is marked dirty, no frame is
 * drawn, and the build moves on leaving a hole. Then the next pass over that
 * hole does the same thing, which is a bar that never completes no matter how
 * long you let it run.
 *
 * A one-line seam rather than a fake edit: nudging the playhead to force a
 * redraw would quantize back to the same frame anyway, and writing to the
 * document to provoke a render is the kind of lie that outlives whoever wrote
 * it.
 */

const listeners = new Set<() => void>();

/** The stage registers its dirty flag here. */
export function onStageDirtyRequest(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Draw the next animation frame even if nothing changed. */
export function markStageDirty(): void {
  for (const cb of listeners) cb();
}

// ── What the stage last presented ───────────────────────────────────────────

/**
 * THE STAGE SAYS WHAT IT SHOWED — the one signal a range build waits on.
 *
 * A build used to guess: set the playhead, wait a frame, poll the media, poll
 * the cache, wait another frame. Too short and it skipped instants whose seek
 * had not landed (gaps in the bar); too long and it crawled. The stage knows
 * exactly when it has put an instant on screen and whether every picture in it
 * was the exact one, so it says so, and the build advances the moment it does.
 */
export interface Presented {
  compId: string | null;
  timeMs: number;
  /**
   * The PLAYHEAD this was drawn for. `timeMs` is the comp's own instant, mapped
   * through nesting and drill-in; the transport asks about the playhead it set,
   * and comparing its own number is the one comparison that cannot disagree.
   */
  playheadMs: number;
  /** Every picture in it was the exact picture of its instant. */
  faithful: boolean;
  /** Monotonic, so a waiter can tell a new presentation from an old one. */
  serial: number;
}

let presented: Presented = { compId: null, timeMs: NaN, playheadMs: NaN, faithful: false, serial: 0 };

export function notePresented(compId: string | null, timeMs: number, playheadMs: number, faithful: boolean): void {
  presented = { compId, timeMs, playheadMs, faithful, serial: presented.serial + 1 };
}

export function lastPresented(): Presented {
  return presented;
}
