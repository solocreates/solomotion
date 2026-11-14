"use client";

/**
 * GESTURE SCOPE — what a press MEANS here, derived from the DOM and
 * overridable by any subtree.
 *
 * The bug this exists to end, in the user's words: *"if it's happening fast in
 * a panel — no matter what, FBF, the stage toolbar, animate, media — it should
 * be scroll. If it's a short hold and then a drag, and there's something under
 * the finger, that thing should happen. If there's nothing, the default."*
 *
 * That rule is correct and it is not expressible as a per-control fix. It was
 * being re-decided in every draggable in the app — a 4px threshold here, a 5px
 * one there, `touch-action: none` on some and not others — so it disagreed with
 * itself surface by surface and every new control started the argument again.
 *
 * ## What `touch-action` can and cannot answer
 *
 * `touch-action` answers *may the browser take this gesture* — by hit-target,
 * before a handler runs, for free. It is the right tool whenever the answer is
 * a property of WHERE the finger landed: an empty lane scrolls, a clip moves.
 *
 * It cannot answer anything that depends on TIME or DIRECTION, because CSS has
 * no notion of either. And in a panel full of sliders, knobs and scrubby number
 * fields, where does not discriminate: the controls ARE the panel, so
 * `touch-action: none` on each of them leaves nowhere to put a finger to
 * scroll, and `touch-action: pan-y` on each of them leaves no way to drag.
 *
 * That is the question this file answers, and there are exactly three answers
 * plus the one that needs no policy:
 *
 *   "grab"    the press is this element's gesture, at once. Nothing around it
 *             can scroll, so there is nothing to arbitrate. What a mouse and a
 *             stylus ALWAYS get — precise instruments whose press is already
 *             unambiguous, and charging every input for one input's problem is
 *             the classic mistake.
 *   "steer"   something scrolls, but on the OTHER axis. Direction settles it:
 *             the first real movement either runs along the control's axis (the
 *             control takes the gesture) or across it (the scroller keeps it).
 *             No wait at all, because none is needed.
 *   "defer"   something scrolls on the SAME axis, so direction cannot settle
 *             it and only time can. A quick swipe scrolls; a brief hold and
 *             then a drag operates the control.
 *   "scroll"  never this element's; the surface keeps it.
 *
 * `steer` is the one that makes a dense inspector feel native. A vertical panel
 * full of horizontal Ranges and number fields has no genuine ambiguity — up and
 * down is the panel, left and right is the value — and a design that made both
 * wait 180ms would be adding lag to answer a question nobody asked.
 *
 * ## How it is decided, and why almost nothing has to declare anything
 *
 * Walk up from the press target. The nearest `data-gesture` wins, exactly like
 * a CSS declaration. If there is none, the answer is DERIVED from two facts the
 * DOM already knows — which axes an ancestor can actually scroll, and which
 * axes the drag itself reads — and those two facts are all the rule needs.
 *
 * So the common cases need NO markup at all. A Range in a scrolling inspector
 * steers; a scrubby field in a horizontally scrolling toolbar defers; a knob
 * (which reads both axes) defers; the same controls in a fixed dialog grab.
 * Declaring is for the exceptions:
 *
 *   data-gesture="grab"    a control that must respond instantly even inside a
 *                          scroller (a playhead, a scrub band).
 *   data-gesture="defer"   force the pause where no ancestor scrolls.
 *   data-gesture="scroll"  a subtree that must never take a press from the
 *                          surface.
 *
 * Overriding is just putting the attribute closer to the target, and it
 * composes with everything already written because the default is derived
 * rather than declared.
 */

/** Which axes a drag reads. The same union `usePointerDrag` already uses. */
export type DragAxis = "x" | "y" | "both";

export type GestureScope = "grab" | "steer" | "defer" | "scroll";

const ATTR = "data-gesture";

/** The three a subtree may DECLARE. `steer` is derived only — it is a function
 *  of the drag's axis, which is the control's business and not the DOM's. */
const DECLARABLE = new Set(["grab", "defer", "scroll"]);

/**
 * Which axes could the browser ACTUALLY scroll if we let this press go?
 *
 * Both halves matter and each on its own is wrong. An `overflow-y-auto` with
 * nothing to scroll is not a contest — it is a div. A scroller the finger can
 * never reach because something between here and there says
 * `touch-action: none` is not a contest either.
 *
 * `touch-action` is not an inherited property; the browser intersects the
 * declarations from the hit element up through its ancestors, so a subtree can
 * only ever NARROW what its parents allow. This walk mirrors that exactly,
 * which is what keeps the policy and the browser from disagreeing.
 */
function contestedAxes(target: EventTarget | null): { x: boolean; y: boolean } {
  const out = { x: false, y: false };
  let allowX = true;
  let allowY = true;
  let el = target as Element | null;
  while (el && el !== document.body) {
    const s = getComputedStyle(el);
    const ta = s.touchAction;
    if (ta === "none") return out; // the surface already refused the browser
    if (ta !== "auto" && ta !== "manipulation") {
      if (!/pan-x|pan-left|pan-right/.test(ta)) allowX = false;
      if (!/pan-y|pan-up|pan-down/.test(ta)) allowY = false;
      if (!allowX && !allowY) return out;
    }
    if (allowX && !out.x && /auto|scroll/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1) {
      out.x = true;
    }
    if (allowY && !out.y && /auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1) {
      out.y = true;
    }
    if (out.x && out.y) return out;
    el = el.parentElement;
  }
  return out;
}

/**
 * The scope in force for a press.
 *
 * `axis` is what the DRAG reads, and leaving it out means "both", which is the
 * safe answer: a gesture that uses every direction has no direction left to
 * arbitrate with, so it can only defer. Naming an axis is what buys `steer`.
 *
 * Mouse and pen always `grab`: this whole mechanism exists to disambiguate a
 * finger, and charging every input for one input's ambiguity is what makes
 * desktop apps feel laggy.
 */
export function gestureScopeAt(
  target: EventTarget | null,
  pointerType: string | undefined,
  axis: DragAxis = "both",
): GestureScope {
  if ((pointerType ?? "mouse") !== "touch") return "grab";

  for (let el = target as Element | null; el && el !== document.body; el = el.parentElement) {
    const declared = el.getAttribute?.(ATTR);
    if (declared && DECLARABLE.has(declared)) return declared as GestureScope;
  }

  const c = contestedAxes(target);
  if (!c.x && !c.y) return "grab";
  // A contest on an axis this drag reads cannot be settled by direction: both
  // gestures want the same movement, and only a pause tells them apart.
  if ((c.x && axis !== "y") || (c.y && axis !== "x")) return "defer";
  return "steer";
}

/**
 * The scope's own timing. One table, so no control invents a fourth number.
 *
 * `steer` asks for a little more travel than `grab` before it commits, because
 * it is deciding a DIRECTION and two pixels of wobble have no direction. It
 * still sits under the browser's own touch slop (~8px), which is the constraint
 * that actually matters: arming is what claims the pointer, and a claim only
 * refuses the browser's scroll while the browser has not started one.
 */
export const SCOPE_TIMING: Record<GestureScope, { holdMs: number; slopPx: number; steer: boolean }> = {
  // A mouse's press is already a decision; 4px is just noise rejection.
  grab: { holdMs: 0, slopPx: 4, steer: false },
  // No wait — direction is the whole answer here, and it is available on the
  // first few pixels. 7px is enough travel to have a direction and less than
  // the browser's slop, so the claim still lands before any scroll begins.
  steer: { holdMs: 0, slopPx: 7, steer: true },
  // Long enough to be deliberate, short enough not to read as lag — the same
  // 180ms the canvas uses, because a person's idea of "a moment" does not
  // change between panels. 14px is the wobble of a deliberate finger.
  defer: { holdMs: 180, slopPx: 14, steer: false },
  scroll: { holdMs: Number.POSITIVE_INFINITY, slopPx: Number.POSITIVE_INFINITY, steer: false },
};

/**
 * TWO GESTURES, ONE POINT — the timing for a handle that sits ON TOP of another
 * draggable rather than inside a scroller, where the rarer of the two has to ask
 * for the press instead of taking it.
 *
 * The scopes above all answer "is this a scroll or an edit", and the DOM settles
 * them: the two gestures live on different elements, so `touch-action` and the
 * hit target do the arbitration for free. That trick is unavailable when the two
 * gestures are *the same pixels* — the stage's pivot crosshair and a motion
 * key are literally the same point, because a position key IS where the pivot
 * goes. There is no element to declare anything on and no direction to read.
 *
 * So the rarer gesture is claimed by a brief, deliberate STILLNESS, which is the
 * only signal left that costs nothing to give and cannot happen by accident.
 *
 * Same 180ms as `defer`, because a person's idea of "a moment" does not change
 * with what they are holding. The SLOP is mouse-sized, and deliberately not
 * `defer`'s 14px: that number is the wobble a finger has to be forgiven while it
 * decides whether to scroll, and forgiving it here would let a slow, genuine
 * drag sit under the threshold long enough for the hold to land and steal it.
 * Here any real movement IS the answer — you meant the other gesture.
 */
export const HOLD_INTENT = { holdMs: 180, slopPx: 4, steer: false } as const;
