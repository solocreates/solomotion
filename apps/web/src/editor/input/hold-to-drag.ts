"use client";

import { claimPointer, multiFingerDown, subscribePointerEnd } from "./pointer-gestures";
import { gestureScopeAt, HOLD_INTENT, SCOPE_TIMING, type DragAxis } from "./gesture-scope";

/**
 * WHEN DOES A PRESS BECOME A DRAG — one answer, for every draggable in the app.
 *
 * A mouse and a stylus are precise instruments whose press is unambiguous: a
 * few pixels of travel is a drag, and making them wait would be the classic
 * mistake of charging every input for one input's problem. A FINGER is not. It
 * lands with a wobble, it rolls as it presses, and it is also how you move
 * through the surface the thing is sitting on — so the same four pixels that
 * mean "drag this" for a mouse mean nothing at all for a finger.
 *
 * The flipbook sheet showed both halves: cells armed their drag at 4px for
 * every pointer, so on a tablet a frame came away with any finger that brushed
 * the sheet, and you could not move through the sheet without rearranging the
 * animation.
 *
 * ## Three rules, and they compose
 *
 *   SLOP       a finger must travel meaningfully further than a mouse. The
 *              numbers live in `SCOPE_TIMING`, not here, so no control invents
 *              a fourth one.
 *   DIRECTION  where a scroll exists on the OTHER axis, the first real movement
 *              settles it: along the control's axis is the control's, across it
 *              is the scroller's. No wait, because none is needed — which is
 *              what keeps a panel of horizontal Ranges instant while its
 *              vertical scroll still works from anywhere on the panel.
 *   HOLD       where the scroll is on the SAME axis, direction cannot help and
 *              only a PAUSE can. This is the one that makes a swipe across a
 *              toolbar mean "swipe" and never "scrub", with no guessing about
 *              velocity.
 *
 * A press that moves the wrong way, or moves before the hold lands, is not a
 * slow drag — it is a different gesture, so the drag is ABANDONED outright
 * rather than armed late. Arming late is how a drag starts halfway through a
 * scroll, which is the worst of both.
 *
 * ## Why arming is also the whole `touch-action` story
 *
 * Arming CLAIMS the pointer, and a claim does two jobs at once: the app-wide
 * long press stands down (no context menu on top of a drag), and the arbiter
 * refuses the browser's scroll for the rest of the gesture (`pointer-gestures`,
 * the non-passive `touchmove`).
 *
 * That second job is the one that used to be done with `touch-action: none` on
 * every control — and doing BOTH is a contradiction, which is exactly the bug
 * this file was written to fix and then could not, because the CSS got there
 * first. `touch-action: none` says "the browser may never scroll from here",
 * which is the opposite of "the browser keeps this unless the finger earns it".
 * A control governed by a scope must therefore NOT declare `touch-action`; it
 * inherits its surface's, and takes the gesture back by claiming, at the exact
 * moment it has earned the right to. Time-aware, where CSS cannot be.
 */

export interface HeldDrag {
  /** Has the gesture earned the right to move things yet? */
  armed: () => boolean;
  /**
   * Has the PAUSE landed — is this gesture now the one that will act?
   *
   * `armed` needs a pause AND the movement that follows it, which is right for
   * acting and useless for SAYING SO: the moment a hold is earned is the moment
   * the affordance has to change, or the hold is a wait with no feedback and
   * nobody discovers it. This is that moment.
   */
  ready: () => boolean;
  /** True once the gesture can never arm — a finger that swiped instead. */
  abandoned: () => boolean;
  /** Call from the move handler; returns whether the drag may act now. */
  update: (clientX: number, clientY: number) => boolean;
  /**
   * TRAVEL SINCE THE DRAG ARMED — which is zero at the instant it arms, and is
   * the only honest origin a drag has.
   *
   * Arming costs distance: a mouse spends 4px proving it is a drag, a finger
   * considerably more. A caller measuring from its own press point is therefore
   * handed that whole slop as travel on the very first move, and whatever it is
   * holding LEAPS by it — "I start dragging and it jumps forward a bit" is this
   * sentence, everywhere it is written, and it was written at every draggable
   * because the kit did not offer the alternative.
   *
   * The slop is the price of recognising the gesture, not part of the gesture.
   * Absorb it — Figma, After Effects and Photoshop all do — so the thing under
   * the pointer starts moving from exactly where it was.
   *
   * Before arming this is `{x: 0, y: 0}`, so a caller that forgets to check
   * `update` still cannot move anything.
   */
  delta: (clientX: number, clientY: number) => { x: number; y: number };
  /** Always call on release. */
  end: () => void;
}

export interface HeldDragOptions {
  /**
   * Which axes this drag reads. Naming one is what lets a scroll on the OTHER
   * axis be settled by direction instead of by a pause — the difference between
   * an inspector slider that responds instantly and one that waits 180ms for a
   * question nobody asked. Defaults to `"both"`, which can only ever defer.
   */
  axis?: DragAxis;
  /**
   * Does the PRESS itself act (a fader jumps to where you touched, a playhead
   * seeks), or does only MOVEMENT act (a clip moves, a cell rearranges)?
   *
   * It changes the `grab` case only. Where nothing can scroll there is nothing
   * to arbitrate, so an acting press must arm on the press or the control feels
   * a frame late for no reason. Everywhere else the press is not ours to act on
   * yet, and the acting-press behaviour belongs on the RELEASE instead — a tap.
   */
  acts?: "press" | "movement";
  /**
   * `"hold"` — this draggable SHARES ITS POINT with another gesture, so it must
   * be asked for rather than taken: a brief stillness claims it, and any real
   * movement first hands the press to the other one (`HOLD_INTENT`).
   *
   * The scope cannot answer this. It is derived from the DOM, and the whole
   * premise of two gestures on one point is that there is no second element for
   * it to read — the stage's pivot crosshair and a motion key are literally the
   * same pixels, because a position key IS where the pivot goes.
   *
   * Unlike `defer`, the HOLD ITSELF claims the pointer rather than the movement
   * after it: the commitment is the stillness, so the app-wide long press must
   * stand down at that instant or holding the handle would also open a context
   * menu on top of it.
   */
  require?: "hold";
  /**
   * Fired the instant the pause lands, so an affordance can say the gesture is
   * now available. Paired with `ready` because the two answer the same question
   * to a paint loop (poll) and to a listener (push).
   */
  onReady?: () => void;
}

/**
 * Arm a drag for one press, under the GESTURE SCOPE in force at the press
 * target — see `gesture-scope.ts`. The scope is derived from the DOM and any
 * subtree can override it, so a control does not decide its own rules and the
 * rules cannot disagree between two controls that look the same.
 *
 * `grab`   nothing around it can scroll. Arms on the press if the press acts,
 *          otherwise on the first real movement.
 * `steer`  a scroll exists across the drag's axis. Arms on the first movement
 *          that runs ALONG the axis; movement across it abandons.
 * `defer`  a scroll exists along the drag's axis. Arms only after a brief
 *          pause; moving before the pause abandons.
 * `scroll` never arms.
 */
export function beginHeldDrag(
  e: {
    pointerId: number;
    pointerType?: string;
    clientX: number;
    clientY: number;
    target?: EventTarget | null;
  },
  opts: HeldDragOptions = {},
): HeldDrag {
  const axis = opts.axis ?? "both";
  const scope = gestureScopeAt(e.target ?? null, e.pointerType, axis);
  const intent = opts.require === "hold";
  const { holdMs, slopPx, steer } = intent ? HOLD_INTENT : SCOPE_TIMING[scope];
  const startX = e.clientX;
  const startY = e.clientY;
  let ready = holdMs === 0;
  /*
   * A GESTURE THAT BEGINS UNDER A SECOND FINGER WAS NEVER A ONE-FINGER GESTURE.
   *
   * Asked here, at construction, because there is no later moment at which it
   * becomes discoverable: the pointer this drag watches may never move again —
   * during a pinch it is usually the still one, and the OTHER finger does the
   * moving. Polling the count from the move handler (which is what this did)
   * therefore answered a question nobody asked.
   */
  let abandoned = scope === "scroll" || multiFingerDown();
  // An intent hold can never arm on the press — asking for the press is the
  // entire point of it.
  let armed = !abandoned && !intent && scope === "grab" && opts.acts === "press";
  // Where the drag began, as opposed to where the PRESS did. They are the same
  // point only for a press that acts (nothing was spent arming); otherwise the
  // difference is the slop, and handing that to the caller is a visible jump.
  let originX = startX;
  let originY = startY;

  // An acting press under `grab` is a decision already made — claim it now, so
  // the long press stands down and the browser never gets the chance to read
  // the gesture as a scroll.
  if (armed) claimPointer(e.pointerId, "hold");

  /*
   * …and if the second finger arrives LATER, the arbiter says so.
   *
   * `"superseded"` is published the instant a second finger lands, which is the
   * only moment this can be known without the drag's own pointer moving. Cancel
   * and lost abort for the reason the doc gives everywhere else: nothing on
   * release is a decision the user made if the gesture was already over.
   *
   * One subscription here covers every draggable in the app — every slider,
   * knob, number field, clip, cell, layer row, tab and grip — because they all
   * come through this function. That is the whole reason it exists.
   */
  const offEnd = subscribePointerEnd((id, reason) => {
    if (id !== e.pointerId || reason === "up") return;
    abandoned = true;
    armed = false;
  });

  const timer =
    !armed && holdMs > 0 && Number.isFinite(holdMs)
      ? window.setTimeout(() => {
          if (abandoned) return;
          ready = true;
          // The stillness WAS the commitment (see `require`), so claim here
          // rather than on the movement that follows: the long press stands
          // down, and the browser can no longer read the rest as a scroll.
          if (intent) claimPointer(e.pointerId, "hold");
          opts.onReady?.();
        }, holdMs)
      : 0;

  const give = () => {
    abandoned = true;
    window.clearTimeout(timer);
    return false;
  };

  return {
    armed: () => armed,
    ready: () => ready && !abandoned,
    abandoned: () => abandoned,
    update: (clientX, clientY) => {
      if (abandoned) return false;
      if (armed) return true;

      const dx = clientX - startX;
      const dy = clientY - startY;
      if (Math.hypot(dx, dy) < slopPx) return false;

      /*
       * DIRECTION SETTLES IT. The drag's own axis has to be the dominant one,
       * or this movement belongs to the scroller running across it. Ties go to
       * the scroller: moving freely is the default, and an accidental value
       * change costs more than an accidental scroll.
       *
       * `axis: "both"` never reaches here — a gesture that reads every
       * direction has no direction left to arbitrate with, so its scope is
       * `defer`, and the pause is the only tool left.
       */
      if (steer && Math.abs(axis === "y" ? dy : dx) <= Math.abs(axis === "y" ? dx : dy)) return give();

      // Moved before the pause landed. Not a slow drag — a different gesture.
      if (!ready) return give();

      armed = true;
      originX = clientX;
      originY = clientY;
      claimPointer(e.pointerId, "drag");
      return true;
    },
    delta: (clientX, clientY) =>
      armed ? { x: clientX - originX, y: clientY - originY } : { x: 0, y: 0 },
    end: () => {
      offEnd();
      window.clearTimeout(timer);
    },
  };
}
