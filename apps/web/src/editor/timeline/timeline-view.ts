"use client";

import { useSession } from "../state/session";
import { pxToTime, timeToPx } from "./timeline-utils";
import { pxPerSecNow } from "./use-time-axes";
import { TIME_ZOOM } from "../workspace/view-zoom";

/**
 * The horizontal view has ONE source of truth: the timeline lanes' native
 * `scrollLeft` (S). Nothing else scrolls horizontally. Every other surface
 * that must line up with time — the curve/keyframe graph, its scrub band, its
 * playhead — is a FOLLOWER positioned by `transform: translateX(-S)`, driven
 * from that single number. Two things derived from one value can't drift, so
 * the playheads are always in one line by construction — no cross-scroller
 * mirroring, no per-scroller clamp races.
 *
 * Zoom: stash a cursor anchor, set pxPerSec (React state), and apply the new
 * scrollLeft in the timeline's LAYOUT effect — after the new content width is
 * committed, before paint — then notify followers in the same tick. Clamped to
 * a caller-supplied time range so it can't fling into empty space.
 */

/** The time kind's ceiling (README D5) — one number, owned by the spec. */
export const MAX_PX_PER_SEC = TIME_ZOOM.max;
// The zoom-OUT floor for a SHORT project — gives ~80s of runway even when the
// content is tiny (no point zooming out into a sea of emptiness).
export const MIN_PX_PER_SEC = 12;
// Absolute hard floor. Long timelines drive the *dynamic* min far below the
// short-project floor (so you can fit an hours-long edit in one screen), but
// never past this — 0.05 px/s already shows ~5.5h across a 1000px viewport.
export const ABSOLUTE_MIN_PX_PER_SEC = TIME_ZOOM.min;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Duration-aware zoom-out floor: the smallest pxPerSec we let the timeline
 * reach, so you can always zoom out far enough to fit the WHOLE span in the
 * viewport (plus a little padding) — the longer the project, the lower this
 * goes. Bounded by the short-project floor above and the absolute floor below,
 * so short edits don't zoom out into emptiness and epic ones don't vanish.
 * Shared by the zoom clamp AND the zoom dial's `min`, so the dial's far-left
 * lands exactly on "fit everything".
 */
export function dynamicMinPxPerSec(viewportWidthPx: number, spanMs: number): number {
  if (viewportWidthPx <= 0) return MIN_PX_PER_SEC;
  const spanSec = Math.max(1, spanMs / 1000);
  const fitPx = (viewportWidthPx * 0.92) / spanSec; // px/s that fits the span
  return clamp(fitPx, ABSOLUTE_MIN_PX_PER_SEC, MIN_PX_PER_SEC);
}

/**
 * The timeline lanes, WHEN MOUNTED. They are the preferred authority — a native
 * scroller gives momentum, scrollbars and keyboard paging for free — but they
 * are no longer the only one.
 *
 * `offset` is the fallback, and it is what lets the Keyframes and Curves
 * surfaces open on their own. The lanes used to BE the horizontal position, so
 * hiding them left every follower reading `0` from a null scroller and the
 * graph could not be shown without them. The position is now a value this
 * module owns; the lanes are a view onto it that happens to be very good at
 * driving it.
 */
let scroller: HTMLElement | null = null;
let offset = 0;
/** Last known viewport width, from whichever surface is currently the widest
 *  authority — used by zoom's clamp when there is no native scroller. */
let viewportW = 0;

/** Followers get the current scrollLeft whenever it changes and position
 *  themselves (transform). */
type Follower = (scrollLeft: number) => void;
const followers = new Set<Follower>();

interface Anchor {
  timeMs: number;
  cursorX: number;
  rangeMs: { startMs: number; endMs: number };
}
let pending: Anchor | null = null;

/**
 * THE HEADER INSET (README D19). On a phone the track-header column lives
 * INSIDE the lanes' scroller, ahead of time zero, so one swipe slides the
 * names away and gives time the whole width, and swiping back brings them.
 * The native scrollLeft then counts those header pixels too; S — the TIME
 * scroll every follower and hit test reads — is the native value minus the
 * inset, clamped at zero. One authority still: the inset is a fact about the
 * scroller's content, declared once, here.
 */
let inset = 0;

/** Native scroll minus the inset — negative while the header is in view. */
function contentScroll(): number {
  return scroller ? scroller.scrollLeft - inset : offset;
}

function scrollLeft(): number {
  return Math.max(0, contentScroll());
}

function viewportWidth(): number {
  return scroller ? scroller.clientWidth - Math.max(0, inset - scroller.scrollLeft) : viewportW;
}

/** Write the shared position, through the scroller when there is one. */
function setScrollLeft(v: number): void {
  const next = Math.max(0, v);
  offset = next;
  if (scroller) {
    // Time zero while the names are showing stays "names showing": a zoom or
    // a jump to the start must not swipe the header away on its own.
    if (!(next === 0 && scroller.scrollLeft < inset)) scroller.scrollLeft = next + inset;
  }
  notify();
}

function notify(): void {
  const s = scrollLeft();
  offset = s; // keep the fallback in step, so unmounting the lanes holds position
  for (const f of followers) f(s);
}

/** Apply the stashed zoom anchor at the live pxPerSec, clamped to its range. */
function applyScroll(): void {
  if (!pending) return;
  const px = pxPerSecNow();
  const vw = viewportWidth();
  const raw = timeToPx(pending.timeMs, px) - pending.cursorX;
  const lo = Math.max(0, timeToPx(pending.rangeMs.startMs, px));
  const hi = Math.max(lo, timeToPx(pending.rangeMs.endMs, px) - vw);
  setScrollLeft(clamp(raw, lo, hi));
}

export const timelineView = {
  /** The timeline lanes register as THE scroller. */
  registerScroller(el: HTMLElement | null): () => void {
    if (!el) return () => {};
    scroller = el;
    viewportW = el.clientWidth;
    // Adopt the position the followers were already holding, so showing the
    // lanes after working in the graph alone doesn't jump back to zero.
    el.scrollLeft = offset > 0 ? offset + inset : 0;
    notify();
    return () => {
      if (scroller === el) {
        offset = el.scrollLeft; // hand the authority back to the module
        scroller = null;
      }
    };
  },

  /** A follower reports its own width, so zoom can still clamp correctly when
   *  the lanes are hidden and nothing native is measuring the viewport. */
  reportViewportWidth(width: number): void {
    if (!scroller && width > 0) viewportW = width;
  },

  /** A surface that mirrors the horizontal position (graph content, band,
   *  playhead) joins; it's called immediately with the current S. */
  registerFollower(f: Follower): () => void {
    followers.add(f);
    f(scrollLeft());
    return () => {
      followers.delete(f);
    };
  },

  /** The timeline scroller scrolled (user pan / playhead auto-follow) — push
   *  the new position to every follower. */
  onScroll(): void {
    notify();
  },

  /** Current horizontal scroll offset (px). */
  scrollLeft,

  /** The header inset in force (px) — 0 on wide layouts. */
  inset: (): number => inset,

  /** Declare the header inset (compact: the header width; wide: 0). Keeps
   *  the time position steady across the change. */
  setInset(px: number): void {
    const next = Math.max(0, px);
    if (next === inset) return;
    if (scroller && scroller.scrollLeft > inset) scroller.scrollLeft += next - inset;
    inset = next;
    notify();
  },

  /** A client X over the lanes' scroller → px along the time axis. */
  contentX(clientX: number, el: HTMLElement): number {
    return clientX - el.getBoundingClientRect().left + el.scrollLeft - inset;
  },

  /** The lanes' visible width (px) — 0 before anything has measured it. */
  viewportWidth,

  /** Pan the shared view (graph horizontal wheel forwards here). */
  panBy(dx: number): void {
    setScrollLeft(scrollLeft() + dx);
  },

  /**
   * Zoom under the cursor. `cursorX` is px from the surface's left edge (the
   * surfaces are horizontally aligned, so it's interchangeable); `rangeMs` is
   * the void guard (whole timeline vs. one clip).
   */
  zoom(cursorX: number, factor: number, rangeMs: { startMs: number; endMs: number }): void {
    const before = pxPerSecNow();
    pending = { timeMs: pxToTime(contentScroll() + cursorX, before), cursorX, rangeMs };
    // Floor is duration-aware: a longer span lets you zoom further out to fit it.
    const minPx = dynamicMinPxPerSec(viewportWidth(), rangeMs.endMs - rangeMs.startMs);
    const next = clamp(before * factor, minPx, MAX_PX_PER_SEC);
    useSession.getState().setPxPerSec(next);
    if (pxPerSecNow() === before) applyScroll();
    // else: pxPerSec changed → the timeline's useLayoutEffect runs applyPendingScroll.
  },

  /**
   * Show exactly [startMs, startMs + durMs) — the zoom bar's verb. `hold`
   * says which edge must not move when the zoom clamps: a drag on the start
   * handle holds the end, everything else holds the start.
   */
  showWindow(startMs: number, durMs: number, rangeMs: { startMs: number; endMs: number }, hold: "start" | "end" = "start"): void {
    const vw = viewportWidth();
    if (vw <= 0 || durMs <= 0) return;
    const before = pxPerSecNow();
    const minPx = dynamicMinPxPerSec(vw, rangeMs.endMs - rangeMs.startMs);
    const next = clamp((vw / durMs) * 1000, Math.min(minPx, before), Math.max(MAX_PX_PER_SEC, before));
    pending =
      hold === "end"
        ? { timeMs: startMs + durMs, cursorX: vw, rangeMs }
        : { timeMs: startMs, cursorX: 0, rangeMs };
    useSession.getState().setPxPerSec(next);
    if (pxPerSecNow() === before) applyScroll();
  },

  /** Called from the timeline's `useLayoutEffect([pxPerSec])`. */
  applyPendingScroll: applyScroll,

  /**
   * "Focus on selection" for the timeline half of smart-focus. A no-op if
   * `range` already overlaps the visible window at all — same "visible at
   * all, leave it alone" rule as the stage's `isBoundsVisible`, so a click
   * never yanks the view out from under someone who already has the clip on
   * screen. Otherwise zooms OUT just enough to fit (never in — a tiny clip
   * doesn't deserve an aggressive zoom-in) and centers it, clamped to
   * `boundsMs` exactly like a manual zoom would be.
   */
  focusRange(range: { startMs: number; endMs: number }, viewportWidth: number, boundsMs: { startMs: number; endMs: number }): void {
    if (viewportWidth <= 0) return;
    const px = pxPerSecNow();
    const visStart = pxToTime(scrollLeft(), px);
    const visEnd = pxToTime(scrollLeft() + viewportWidth, px);
    if (range.startMs < visEnd && range.endMs > visStart) return; // already showing at least in part

    const PAD_PX = 80;
    const durationMs = Math.max(1, range.endMs - range.startMs);
    const fitPx = ((viewportWidth - PAD_PX * 2) / durationMs) * 1000;
    // Allow fitting an arbitrarily long range — clamp only to the absolute floor.
    const nextPx = clamp(Math.min(px, fitPx), ABSOLUTE_MIN_PX_PER_SEC, MAX_PX_PER_SEC);
    const centerMs = (range.startMs + range.endMs) / 2;
    pending = { timeMs: centerMs, cursorX: viewportWidth / 2, rangeMs: boundsMs };
    if (nextPx === px) applyScroll();
    else useSession.getState().setPxPerSec(nextPx); // the layout effect applies `pending` post-relayout
  },
};
