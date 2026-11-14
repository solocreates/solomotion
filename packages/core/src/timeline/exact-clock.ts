/**
 * THE EXACT CLOCK — the transport for "real-time playback off".
 *
 * Real-time playback advances the playhead by wall-clock delta and shows
 * whatever each instant looks like by the time it is drawn. Exact playback
 * makes the opposite promise: EVERY frame of the comp is shown, each one the
 * exact picture of its instant, in order, never faster than real time — and
 * never slower than the slowest frame needs.
 *
 * The clock that used to do this advanced "one step per frame the stage drew".
 * Drawn is not shown: it counted a draw of a video mid-seek, or a rolling
 * element a frame off its instant, as the frame — so it played on past the
 * very pictures it existed to wait for. And a comp under 30fps draws only when
 * its frame changes, so a clock waiting for a draw and a stage waiting for the
 * clock waited for each other forever (the playhead crept one pixel and froze).
 *
 * So the transport holds ONE instant at a time and asks one question of it:
 * has it been shown exactly? Timing is the only thing decided here, as data,
 * so it can be tested without a browser:
 *
 *  - PACED (playback): the next instant is due one frame after this one was
 *    due. A frame that took longer to make re-anchors the schedule at the
 *    moment it appeared, so a slow stretch is followed by real-time playback
 *    again — never by a burst that "catches up".
 *  - UNPACED (a range build): the next instant is due the moment this one is
 *    shown.
 *  - A STALL (a decode that never lands) is released after `stallMs`: a frame
 *    that cannot be made exactly must cost one slow frame, not the session.
 */

export interface ExactClock {
  /** When the current instant was due on screen (wall ms). */
  dueAt: number;
  /** When the current instant was first shown exactly, or null while waiting for it. */
  shownAt: number | null;
  /** When the wait for the current instant began. */
  waitingSince: number;
}

export interface ExactClockTiming {
  /** One comp frame, in ms. */
  stepMs: number;
  /** False for a range build: advance the moment an instant is shown. */
  paced: boolean;
  /**
   * Tick granularity, in ms — one display frame. An instant due between two
   * ticks is taken on the nearer one, so a 30fps comp on a 60Hz display
   * advances on every second tick rather than drifting between two and three.
   */
  tickMs: number;
  /** Longest one instant may take to be shown exactly before playback moves on regardless. */
  stallMs: number;
}

export type ExactClockVerdict = "wait" | "advance" | "stalled";

/** A clock holding its first instant, due now. */
export function startExactClock(now: number): ExactClock {
  return { dueAt: now, shownAt: null, waitingSince: now };
}

/** The current instant was presented exactly. Idempotent — the first showing counts. */
export function exactClockShown(clock: ExactClock, now: number): ExactClock {
  return clock.shownAt !== null ? clock : { ...clock, shownAt: now };
}

/**
 * When the NEXT instant is due: one frame after this one was due — or, if this
 * one took longer than a frame to make, the moment it appeared. On time, the
 * schedule is kept exactly (rounding to display ticks never accumulates); late,
 * the next frame starts at once (no idle wait on top of a slow frame) and the
 * schedule continues from there (lateness is never repaid by rushing).
 */
function nextDue(clock: ExactClock, t: ExactClockTiming): number {
  return Math.max(clock.dueAt + t.stepMs, clock.shownAt ?? clock.dueAt);
}

/** Should the transport move to the next instant now? */
export function exactClockVerdict(clock: ExactClock, now: number, t: ExactClockTiming): ExactClockVerdict {
  if (clock.shownAt === null) return now - clock.waitingSince >= t.stallMs ? "stalled" : "wait";
  if (!t.paced) return "advance";
  return now >= nextDue(clock, t) - t.tickMs / 2 ? "advance" : "wait";
}

/** The clock for the next instant, once the transport has moved to it. */
export function exactClockAdvance(clock: ExactClock, now: number, t: ExactClockTiming): ExactClock {
  const dueAt = t.paced && clock.shownAt !== null ? nextDue(clock, t) : now;
  return { dueAt, shownAt: null, waitingSince: now };
}
