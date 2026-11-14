/**
 * THE LIVE TRANSPORT CLOCK — real-time playback's one answer to "where is the
 * playhead NOW".
 *
 * It is an ANCHOR, not an accumulator: (playhead, master-clock time) at the
 * last start/jump, and the playhead at any later moment is read off the master
 * clock. Adding each animation frame's delta instead had two failures that a
 * heavy project turns into broken sound:
 *
 *  - Every rAF callback in a frame gets the SAME timestamp. When the stage's
 *    callback renders for 600 ms first, the transport then computes a playhead
 *    600 ms in the past — and re-seeks every playing voice BACK to it. Every
 *    frame. That is "the sound keeps repeating the same second".
 *  - Sound cues were scheduled relative to that stale playhead, landing late.
 *
 * The master clock is the AUDIO hardware clock when it runs (what every DAW and
 * NLE slaves picture to — sound must never be dragged to match a late picture;
 * picture drops frames instead), else the wall clock. The source is fixed per
 * anchor, so the two clocks are never mixed in one reading.
 */
export interface LiveClock {
  /** Playhead at the anchor. */
  anchorMs: number;
  /** Master-clock seconds at the anchor. */
  anchorSec: number;
  /** +1 forward, −1 backward (pingpong). */
  dir: 1 | -1;
  /** Which master clock the anchor was taken on. */
  source: "audio" | "wall";
}

export function anchorLiveClock(playheadMs: number, nowSec: number, source: LiveClock["source"], dir: 1 | -1 = 1): LiveClock {
  return { anchorMs: playheadMs, anchorSec: nowSec, dir, source };
}

/** The playhead at `nowSec` on the clock's own master clock. */
export function liveClockAt(clock: LiveClock, nowSec: number): number {
  return clock.anchorMs + clock.dir * Math.max(0, nowSec - clock.anchorSec) * 1000;
}

/**
 * How far ahead sound cues must be scheduled so a slow frame cannot starve
 * them: at least the base lookahead, and 1.5× the longest recent gap between
 * ticks (a tick that arrives late must find its cues already queued), capped
 * so an edit still reaches the ear within a second or so.
 */
export function cueLookaheadMs(baseMs: number, recentTickGapMs: number, capMs = 1200): number {
  return Math.min(capMs, Math.max(baseMs, recentTickGapMs * 1.5));
}
