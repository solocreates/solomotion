"use client";

import * as React from "react";

/**
 * ══ LIVE VALUE — optimistic paint, self-pacing commit ═══════════════════════
 *
 * The one gesture→value seam for every control you DRAG: the Range, the Knob,
 * the scrubbable NumberInput. It answers the complaint that a slider "feels
 * heavy" — and that complaint was never about the slider.
 *
 * WHAT WAS ACTUALLY WRONG. A drag streams a value per pointermove, straight
 * into the document store. That is a full store write, an undo merge, a React
 * pass over every inspector, and a stage re-render — and if the layer carries a
 * Liquid glass or a colour grade, that stage render is 40–80ms of pixel work on
 * the main thread. The next pointermove cannot be delivered until it finishes,
 * so the browser coalesces the ones that arrived meanwhile. The slider's own
 * position came back FROM that render, so the bar only moved once per commit:
 * you drag smoothly, the value arrives in lurches, and the control feels like
 * it is dragging something heavy behind it. Which it is.
 *
 * TWO FIXES, and they are separate ideas:
 *
 *   1. OPTIMISTIC PAINT. The control renders from its own `value` during a
 *      gesture and never waits for the round trip. Even at four commits a
 *      second the bar tracks the pointer exactly, because moving the bar was
 *      never the expensive part — it is one `style.left` on one element.
 *
 *   2. SELF-PACING COMMIT. How often the value reaches the store is decided by
 *      how long the last commit actually TOOK, measured here rather than
 *      guessed at a call site. Cheap effect → every frame, fully live, which is
 *      the behaviour worth keeping. Expensive effect → the interval opens up to
 *      match, automatically, and closes again when the load goes away.
 *
 * MEASURING IT is the part worth reading. `performance.now()` around
 * `onChange` measures nothing useful: React has only scheduled the work when it
 * returns. So the clock stops on the NEXT animation frame — by which point the
 * render, the layout and the canvas paint that commit caused have all had to
 * happen. That number is the real cost of one commit, including work in
 * components this file has never heard of, which is exactly why nothing has to
 * be told about the Liquid glass effect for the pacing to react to it.
 *
 * The meter is MODULE-LEVEL on purpose. Slowness is a property of the document
 * and the frame being rendered, not of the control you happen to be holding —
 * so the first drag teaches every other control in the app, and a Knob you have
 * never touched is already paced correctly the first time you grab it.
 *
 * The final value ALWAYS lands: `end()` flushes synchronously, so a released
 * drag is never a value the store did not receive.
 */

/** One 60fps frame, with a little slack. A commit inside this is free. */
const FRAME_MS = 20;
/** Never open the interval further than this — 4/sec still reads as live. */
const MAX_INTERVAL_MS = 250;
/**
 * Exponential smoothing on the cost. Weighted toward the new sample so the
 * pacing opens up within two or three frames of hitting an expensive effect,
 * but a single unlucky frame (a GC pause) cannot pin it wide open.
 */
const EMA_ALPHA = 0.35;

/** The shared cost meter — see the note above on why it is not per-control. */
let commitCostMs = 0;
/** Time in flight, so overlapping controls can't double-count one frame. */
let measuring = false;

function noteCost(startedAt: number): void {
  if (measuring) return;
  measuring = true;
  requestAnimationFrame(() => {
    measuring = false;
    const cost = performance.now() - startedAt;
    commitCostMs = commitCostMs === 0 ? cost : commitCostMs * (1 - EMA_ALPHA) + cost * EMA_ALPHA;
  });
}

/**
 * How long to wait between commits right now. Zero while the app is keeping up
 * (every frame), opening toward the measured cost once it isn't — pacing the
 * writes to what the machine can actually absorb rather than to a fixed
 * debounce that would be too slow on a fast document and too fast on a heavy one.
 */
function commitInterval(): number {
  return commitCostMs <= FRAME_MS ? 0 : Math.min(MAX_INTERVAL_MS, commitCostMs);
}

/** Whether the app is currently struggling — for chrome that wants to say so. */
export function isCommitExpensive(): boolean {
  return commitCostMs > FRAME_MS;
}

export interface LiveValue<T> {
  /** What to PAINT. The optimistic value during a gesture, the prop otherwise. */
  value: T;
  /** Stream a value from a gesture. Paints now, commits when the app can. */
  push: (v: T) => void;
  /** Gesture over: flush the final value and hand authority back to the prop. */
  end: () => void;
}

/**
 * Wrap a controlled value + its `onChange` so a drag paints instantly and
 * commits at a rate the app can absorb.
 *
 * Generic over the value type because the same seam is right for anything a
 * gesture streams — a number today, a colour from an eyedropper drag tomorrow.
 */
export function useLiveValue<T>(value: T, onChange: (v: T) => void): LiveValue<T> {
  const [local, setLocal] = React.useState<T | null>(null);
  // Live inputs in refs: the rAF/timeout callbacks below must never close over
  // a stale `onChange`, and re-subscribing them per value tick would defeat the
  // point of pacing in the first place.
  const live = React.useRef({ onChange, pending: null as T | null, lastAt: 0 });
  live.current.onChange = onChange;
  // Tagged, because a rAF handle and a timeout handle are numbers from two
  // different pools: cancelling one with the other's canceller silently kills
  // an unrelated frame callback somewhere else in the app.
  const timer = React.useRef<{ kind: "raf" | "timeout"; id: number } | null>(null);

  const clearTimer = () => {
    const t = timer.current;
    if (!t) return;
    timer.current = null;
    if (t.kind === "raf") cancelAnimationFrame(t.id);
    else clearTimeout(t.id);
  };

  const flush = React.useCallback(() => {
    clearTimer();
    const s = live.current;
    if (s.pending === null) return;
    const v = s.pending;
    s.pending = null;
    s.lastAt = performance.now();
    const startedAt = s.lastAt;
    s.onChange(v);
    noteCost(startedAt);
  }, []);

  const push = React.useCallback(
    (v: T) => {
      setLocal(v);
      live.current.pending = v;
      if (timer.current !== null) return;
      const wait = commitInterval() - (performance.now() - live.current.lastAt);
      // A frame, not a zero timeout: aligning the commit to the paint the
      // optimistic value is already causing means one render for both.
      timer.current =
        wait <= 0
          ? { kind: "raf", id: requestAnimationFrame(() => flush()) }
          : { kind: "timeout", id: setTimeout(() => flush(), wait) as unknown as number };
    },
    [flush],
  );

  const end = React.useCallback(() => {
    flush();
    // The prop is the truth again — and it may legitimately differ from what
    // was pushed (a clamp, a quantise, a value the store refused).
    setLocal(null);
  }, [flush]);

  // A control can unmount mid-gesture (a card closes, a selection changes).
  // The value it was holding still has to land.
  React.useEffect(() => () => flush(), [flush]);

  return { value: local === null ? value : local, push, end };
}
