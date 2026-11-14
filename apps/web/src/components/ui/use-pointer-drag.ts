"use client";

import { cursors, resizeCursor } from "@solomotion/ui/cursors";
import * as React from "react";

import { beginHeldDrag, type HeldDrag } from "@/editor/input/hold-to-drag";
import type { DragAxis } from "@/editor/input/gesture-scope";
import { subscribePointerEnd } from "@/editor/input/pointer-gestures";
import { capturePointer } from "../../editor/input/capture-pointer";

/**
 * DELTA DRAG — the Blender scrub gesture, headless.
 *
 * Turns pointer TRAVEL into a value, rather than pointer POSITION into a value.
 * That single change is what lets a 40px slider have a long, precise throw: you
 * are no longer mapping 40 pixels of track onto the whole range, so the drag
 * keeps giving as long as you keep moving.
 *
 * It does NOT use the Pointer Lock API, and that is a deliberate reversal. Lock
 * buys one thing — travel past the edge of the screen — and charges for it in
 * Firefox with a permission prompt, a full-screen-style transition and a cursor
 * that disappears across the whole OS. That is a jarring, app-wide cost for a
 * limit people reach rarely, and the `infinite` option below is off by default
 * because of it. The lock is kept as an opt-in for a future canvas gizmo where
 * unbounded travel genuinely is the feature.
 *
 * Deliberately not part of the slider. This is the gesture behind scrubby
 * number fields, the timeline playhead, knobs, gizmo handles and anything else
 * that turns pointer travel into a value — one implementation of "drag means
 * delta", both axes, so none of them re-derives modifier handling or forgets to
 * restore the cursor.
 *
 * Modifiers, matching Blender and every DCC tool:
 *   • Shift  — FINE mode. Movement is scaled down, so the same physical travel
 *              covers a fraction of the range. This is how you land an exact
 *              value without zooming the control.
 *   • The consumer decides what fine means for it (a slider also stops
 *              snapping); this hook only reports `fine` and scales the delta.
 */

export interface PointerDragMove {
  /** Delta since the last move, in CSS px, already scaled by fine mode. */
  dx: number;
  dy: number;
  /** Accumulated (scaled) delta since the drag began. */
  totalX: number;
  totalY: number;
  /** Shift held on this move. */
  fine: boolean;
  /** True while the pointer is locked — clientX/Y are meaningless. */
  locked: boolean;
  event: PointerEvent | React.PointerEvent;
}

export interface UsePointerDragOptions {
  onStart?: (e: React.PointerEvent) => void;
  onMove: (m: PointerDragMove) => void;
  onEnd?: (m: { totalX: number; totalY: number; canceled: boolean }) => void;
  /**
   * The press ended without ever becoming a drag — a tap.
   *
   * It exists because deferring changed where "what a press does" belongs. A
   * fader jumps to where you touched it, and on a mouse that happens on the
   * press. On a finger inside a scroller the press is not ours yet, so the
   * jump has to wait until the release proves it was never a swipe. Same
   * behaviour, moved to the first moment it is knowable.
   */
  onTap?: (e: React.PointerEvent) => void;
  /**
   * Which axis the gesture reads. Drives the drag cursor — and, more
   * importantly, tells the gesture scope which direction belongs to this
   * control, which is what lets a scroll running ACROSS it be settled without
   * a pause. Default "x".
   */
  axis?: DragAxis;
  /**
   * Does the PRESS act (a fader jumps), or only movement (a handle drags)?
   * Default `"press"` — everything built on this hook turns a press into a
   * value. See `beginHeldDrag`; it changes behaviour only where nothing around
   * the control can scroll.
   */
  acts?: "press" | "movement";
  /** Delta multiplier while Shift is held. Default 0.15 (Blender-ish). */
  fineFactor?: number;
  /**
   * Lock the pointer so travel can continue past the screen edge. OFF by
   * default: it costs a permission prompt and a hidden system cursor in
   * Firefox, which is far more disruptive than the edge it removes. Delta
   * accumulation already gives the long throw; this only buys the last inch.
   */
  infinite?: boolean;
  /** Body cursor during the drag. Defaults from `axis`. */
  cursor?: string;
  disabled?: boolean;
}

export interface PointerDragState {
  /** Spread onto the draggable element. Uses pointer capture, so the gesture is
   *  live from the first press and keeps tracking off-element. */
  bind: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
    /** Selection + iOS callout suppression, travelling WITH the handlers so a
     *  scrub can never be half-wired. Deliberately NOT `touch-action` — see the
     *  note at the value. Spread `bind` after any style of your own. */
    style: React.CSSProperties;
    /** This control acts on the press, so a hold here is not a right-click. */
    "data-no-longpress": string;
  };
  dragging: boolean;
  /** Shift is held right now (only meaningful while dragging). */
  fine: boolean;
}

const cursorFor = (axis: "x" | "y" | "both") =>
  axis === "x" ? resizeCursor(0) : axis === "y" ? resizeCursor(90) : cursors.move;

export function usePointerDrag(opts: UsePointerDragOptions): PointerDragState {
  const { axis = "x", fineFactor = 0.15, infinite = false, disabled = false } = opts;

  const [dragging, setDragging] = React.useState(false);
  const [fine, setFine] = React.useState(false);

  // Live options in a ref so the window listeners never go stale without
  // re-subscribing on every value tick.
  const live = React.useRef(opts);
  live.current = opts;

  const state = React.useRef<{
    active: boolean;
    armed: boolean;
    arm: HeldDrag | null;
    locked: boolean;
    totalX: number;
    totalY: number;
    lastX: number;
    lastY: number;
    /** The pointer this drag is following, and where it was captured. */
    pointerId: number;
    el: Element | null;
    /** Unsubscribe from the arbiter's end signal. */
    off: (() => void) | null;
  }>({
    active: false,
    armed: false,
    arm: null,
    locked: false,
    totalX: 0,
    totalY: 0,
    lastX: 0,
    lastY: 0,
    pointerId: -1,
    el: null,
    off: null,
  });

  const cleanup = React.useCallback(() => {
    const s = state.current;
    if (!s.active) return;
    s.arm?.end();
    s.arm = null;
    s.off?.();
    s.off = null;
    // Capture is released HERE, not at the call sites, because the release has
    // to happen however the gesture ended — including the ends this element
    // never hears about.
    if (s.el && s.pointerId >= 0) {
      try {
        (s.el as Element & { releasePointerCapture?: (id: number) => void }).releasePointerCapture?.(s.pointerId);
      } catch {
        /* already gone — the element unmounted, or capture was never granted */
      }
    }
    s.el = null;
    s.pointerId = -1;
    s.active = false;
    s.armed = false;
    s.locked = false;
    setDragging(false);
    setFine(false);
    document.body.style.cursor = "";
    if (typeof document !== "undefined" && document.pointerLockElement) document.exitPointerLock();
  }, []);

  // If the control unmounts mid-drag, the cursor and the lock must still come
  // back — otherwise the whole app is left with a resize cursor and no pointer.
  React.useEffect(() => cleanup, [cleanup]);

  // Esc cancels, and the browser can drop the lock on its own (tab blur, the
  // user pressing Esc against our wishes). Either way the drag has to end, or
  // the next mousemove keeps writing values with no button held.
  React.useEffect(() => {
    if (!dragging) return;
    const onLockChange = () => {
      if (state.current.locked && !document.pointerLockElement) {
        live.current.onEnd?.({ totalX: state.current.totalX, totalY: state.current.totalY, canceled: true });
        cleanup();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      live.current.onEnd?.({ totalX: state.current.totalX, totalY: state.current.totalY, canceled: true });
      cleanup();
    };
    document.addEventListener("pointerlockchange", onLockChange);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      window.removeEventListener("keydown", onKey);
    };
  }, [dragging, cleanup]);

  /**
   * The drag is really starting NOW — either on the press (nothing around this
   * control can scroll, so there was never anything to arbitrate) or at the
   * moment the finger earned it. Everything visible lives here rather than in
   * the press handler, because under a scope the press is not yet ours.
   */
  const engage = (e: React.PointerEvent) => {
    const s = state.current;
    s.armed = true;
    // Deltas restart from HERE, so the travel spent earning the gesture is not
    // also spent changing the value. Without this a deferred slider jumps by
    // its slop the instant it arms, which reads as the control lurching.
    s.lastX = e.clientX;
    s.lastY = e.clientY;
    setDragging(true);
    setFine(e.shiftKey);
    document.body.style.cursor = live.current.cursor ?? cursorFor(axis);
    live.current.onStart?.(e);

    // Pointer lock needs a user gesture and can still be refused (an iframe
    // without permission, an unsupported engine). A rejection is not an error
    // here — the drag simply stays bounded, which is the old behaviour.
    if (infinite) {
      const el = e.currentTarget as HTMLElement & { requestPointerLock?: () => Promise<void> | void };
      try {
        const r = el.requestPointerLock?.();
        if (r && typeof (r as Promise<void>).then === "function") {
          (r as Promise<void>).then(
            () => {
              if (state.current.active) state.current.locked = true;
            },
            () => {},
          );
        } else if (r === undefined && document.pointerLockElement === el) {
          s.locked = true;
        }
      } catch {
        /* bounded drag is a fine fallback */
      }
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    capturePointer(e.currentTarget, e.pointerId);
    const s = state.current;
    s.active = true;
    s.armed = false;
    s.locked = false;
    s.totalX = 0;
    s.totalY = 0;
    s.lastX = e.clientX;
    s.lastY = e.clientY;
    /*
     * THE PRESS IS NOT AUTOMATICALLY OURS.
     *
     * This hook used to `claimPointer` here unconditionally and wear
     * `touch-action: none`, which together said: every touch that lands on any
     * of the ~90 controls built on this hook belongs to the control, forever,
     * no matter what it does next. In a fixed toolbar that is right. In a
     * scrolling panel — where the controls ARE the panel — it means there is
     * nowhere left to put a finger to scroll, and a swipe across the inspector
     * either does nothing or scrubs whatever it passed over.
     *
     * The rule is not this hook's to invent, so it does not. `beginHeldDrag`
     * reads the scope inherited from the DOM and decides by axis and by time:
     * instant where nothing can scroll, steered by direction where the scroll
     * runs across this control, held behind a brief pause where it runs along
     * it. Arming is what claims the pointer — and the claim is what refuses the
     * browser's scroll from then on, which is the job the CSS used to do
     * bluntly and much too early.
     */
    s.arm = beginHeldDrag(e, { axis, acts: live.current.acts ?? "press" });
    // The gesture's real lifeline: whatever happens to this element or its
    // capture, the arbiter still sees the pointer go. A release the element
    // DID hear gets here first and this is a no-op.
    s.pointerId = e.pointerId;
    s.el = e.currentTarget;
    s.off?.();
    s.off = subscribePointerEnd((id, reason) => {
      if (id !== state.current.pointerId) return;
      // An ABORT is immediate — the gesture has to stop being live right now.
      if (reason !== "up") return finish("abort");
      // A real release is handled a microtask later, because the arbiter reads
      // the window in CAPTURE phase and so hears the release before this
      // element's own handler does. That handler carries the React event a tap
      // needs (where it landed, whether ⇧ was down); this one cannot invent
      // it. So it yields — and if the element never heard the release, which
      // is the whole reason this subscription exists, `active` is still true
      // one microtask later and the drag ends here instead of hanging.
      queueMicrotask(() => {
        if (state.current.pointerId !== id) return;
        finish(state.current.armed ? "commit" : "abort");
      });
    });
    if (s.arm.armed()) engage(e);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = state.current;
    if (!s.active) return;
    const o = live.current;

    if (!s.armed) {
      const arm = s.arm;
      if (!arm || !arm.update(e.clientX, e.clientY)) {
        // The surface won it. Let go completely: no cursor, no onEnd, nothing
        // to undo — not starting is free, unstarting is not.
        if (!arm || arm.abandoned()) cleanup();
        return;
      }
      engage(e);
      return;
    }

    // Locked: movementX/Y is the ONLY truth (clientX is frozen). Unlocked:
    // difference from the last position, which also survives a lock that was
    // requested but not yet granted.
    const locked = !!document.pointerLockElement;
    s.locked = locked;
    let rawX: number;
    let rawY: number;
    if (locked) {
      rawX = e.movementX;
      rawY = e.movementY;
    } else {
      rawX = e.clientX - s.lastX;
      rawY = e.clientY - s.lastY;
      s.lastX = e.clientX;
      s.lastY = e.clientY;
    }

    const isFine = e.shiftKey;
    setFine(isFine);
    const k = isFine ? (o.fineFactor ?? fineFactor) : 1;
    const dx = rawX * k;
    const dy = rawY * k;
    s.totalX += dx;
    s.totalY += dy;

    o.onMove({ dx, dy, totalX: s.totalX, totalY: s.totalY, fine: isFine, locked, event: e });
  };

  /**
   * THE ONE WAY A DRAG ENDS — and the reason it is not the element's
   * `pointerup`.
   *
   * This hook used to tear down only from its own `onPointerUp` /
   * `onPointerCancel`, which is the exact fault `responsive-and-gestures.md`
   * names as "the one thing most likely to bite next". It survives a mouse,
   * because a mouse under pointer capture essentially always delivers its
   * release to the element that captured it. It does not survive anything
   * that takes the capture away mid-gesture — the control re-mounting under a
   * floating window, a portalled layer opening over the press, the window
   * blurring, a touch the browser cancels.
   *
   * When that happened the release went somewhere else and `active` stayed
   * true. The element still carries `onPointerMove` with no capture needed, so
   * the NEXT time the pointer merely PASSED OVER the control it carried on
   * scrubbing with no button held — "sometimes it is still being dragged",
   * precisely, and with a body cursor nothing could clear.
   *
   * So the arbiter decides. It tracks every pointer in the window in capture
   * phase, where nothing can hide one from it, and publishes the disappearance
   * once (`subscribePointerEnd`). A real release commits; anything else —
   * cancel, lost, superseded by a second finger — ABORTS, because nothing on
   * release is a decision the user made when the release never happened.
   *
   * `finish` is idempotent through `cleanup`'s `active` guard, so it does not
   * matter whether the element's handler or the arbiter gets there first.
   */
  const finish = (outcome: "commit" | "abort" | "tap", e?: React.PointerEvent) => {
    const s = state.current;
    if (!s.active) return;
    if (s.armed) live.current.onEnd?.({ totalX: s.totalX, totalY: s.totalY, canceled: outcome === "abort" });
    // Never armed and never abandoned: the pointer came and went without
    // moving, which is a tap. This is where an acting press lands once it can
    // no longer act on the press itself.
    else if (outcome === "tap" && e) live.current.onTap?.(e);
    cleanup();
  };

  const end = (e: React.PointerEvent) => {
    finish(e.type === "pointerup" ? (state.current.armed ? "commit" : "tap") : "abort", e);
  };

  return {
    bind: {
      onPointerDown,
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: end,
      /* Acts on the PRESS, so it owns the hold: no context menu on top of a
       * slider you are holding. Declared, not inferred — see the long press.
       */
      "data-no-longpress": "",
      /*
       * NOTE WHAT IS NOT HERE: `touch-action`.
       *
       * It used to be, and it was the other half of the bug. `touch-action:
       * none` tells the browser it may never scroll from this element — a
       * decision taken at hit-test time, before anyone knows whether this
       * gesture is a scrub or a swipe. In a scrolling panel that answer is
       * wrong roughly half the time, and it is wrong in the direction that
       * cannot be recovered: the scroll is gone before the first move handler
       * runs, so no amount of correct JS can give it back.
       *
       * The claim does the same job at the right moment instead. Arming calls
       * `claimPointer`, and the arbiter's non-passive `touchmove` refuses the
       * browser's scroll for every claimed pointer — from the press where the
       * scope is `grab`, and from the moment the gesture is earned everywhere
       * else. Same guarantee, one decision later, which is all it took.
       *
       * What stays is the part that is unconditionally true of a drag: it is
       * not a text selection, and it is not an iOS copy/share callout — that
       * callout is a separate system gesture, and when it appears iOS cancels
       * the touch that summoned it, so a drag held still for half a second
       * dies with no menu ever visible to explain why.
       */
      style: {
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
      } as React.CSSProperties,
    },
    dragging,
    fine,
  };
}
