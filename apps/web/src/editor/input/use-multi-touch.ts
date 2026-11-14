"use client";

import * as React from "react";
import { claimPointer, CLAIM_SLOP_PX } from "./pointer-gestures";

/**
 * THE NAVIGATION GESTURE — two fingers, on every surface in the app.
 *
 * ## The rule
 *
 *   ONE finger  → depends on WHAT IT LANDS ON, and the browser decides:
 *                 empty scroller → scroll it (native, free);
 *                 a grabbable thing → that thing's drag.
 *                 See `SCROLL_SURFACE` / `DRAG_SURFACE` at the bottom — the
 *                 arbitration is `touch-action`, not a recognizer.
 *   TWO fingers → navigate. Pinch zooms; on a CANVAS the drag also pans.
 *   A pen       → the tool, never navigation. (Palm rejection: see below.)
 *
 * An earlier version of this rule said one finger is ALWAYS the tool and gave
 * navigation entirely to two fingers. On the stage — an infinite canvas with
 * nothing to scroll — that is still exactly right. On a timeline it was not:
 * dragging left and right is the primary navigation of a scroller, and making
 * the commonest gesture cost two fingers so the rarest (rubber-band selection)
 * could have one is the trade backwards.
 *
 * That split is the whole design, and it is worth saying why it is the right
 * one rather than the obvious alternative. The obvious alternative is to
 * arbitrate: one finger pans on the canvas but selects in the timeline, unless
 * you started on a clip, unless a tool is armed… Every app that has tried that
 * ends up with a gesture whose meaning you cannot predict before you commit to
 * it, and with a code path per surface that has to guess. Procreate, Figma and
 * Photoshop all landed on the same answer instead: navigation is the two-finger
 * gesture, and it is unconditional. Nothing has to guess, and one finger never
 * has to mean two things.
 *
 * It is also why this hook deliberately does NOT touch single-pointer
 * behaviour. Every existing drag in this app — clips, layers, handles, pen
 * nodes, the playhead, floating windows — is written with Pointer Events and
 * `setPointerCapture`, which the browser already delivers for touch and pen.
 * Those gestures work on a tablet today; they do not need porting, and a
 * recognizer that intercepted them would break the desktop paths that share the
 * code. This adds the one gesture the pointer model cannot express: more than
 * one finger at once.
 *
 * ## Nothing is emitted until the gesture commits
 *
 * The first version emitted a zoom and a pan from the moment the second finger
 * landed. Two fingers never land or lift at the same instant, so every
 * two-finger tap shoved the camera a few pixels and a few percent before doing
 * what it was for — the gesture worked and still felt broken.
 *
 * So this follows the standard recognizer lifecycle: the gesture is POSSIBLE
 * while the fingers are down, and only BEGINS once the centroid or the spread
 * passes a threshold. Nothing is emitted while possible, and `onStart` — which
 * cancels the host surface's in-flight single-finger drag — does not fire
 * either, so a tap never aborts a drag it did not replace.
 *
 * The commitment also CLAIMS the pointers, which is what tells the app-wide
 * discrete recognizers to stand down: two fingers on a surface must never also
 * open a context menu or count as an undo tap.
 *
 * ## Where the undo tap went
 *
 * Two-finger tap = undo lived HERE, and it was wrong twice over: it existed
 * only where a surface had passed `onTap` (which was the stage alone), and
 * where surfaces nest both copies heard the same fingers and both fired, so
 * one tap undid twice. A recognizer that must be unique per window cannot live
 * in a per-surface hook. It is now `startMultiFingerTaps` in the arbiter, and
 * works on every surface in the app including the ones written next year.
 *
 * ## Palm rejection
 *
 * A pen going down suppresses touch on the same surface for a moment. On a
 * tablet your hand rests on the glass a fraction of a second before the nib
 * lands, and without this every stroke starts with a phantom two-finger pinch.
 * `DrawingOverlay` had this logic privately; it belongs to every surface a
 * Pencil can reach, which is all of them.
 *
 * ## Why it never fights the browser
 *
 * The element must be `touch-action: none` for this to receive continuous
 * touch moves — otherwise the browser claims the gesture as a page pan/zoom
 * and fires `pointercancel` on the first move. `touchActionFor` below derives
 * that from what the surface actually supports, so a surface cannot handle
 * multi-touch and forget the CSS that makes it possible. That pairing is the
 * single most common way touch support "mysteriously doesn't work".
 */

export interface MultiTouch {
  /**
   * Scale since the LAST event, not since the gesture began. Incremental so a
   * consumer can feed it straight into a multiplicative zoom without holding a
   * baseline — the same shape `useZoomGesture` already hands the wheel path.
   */
  scale: number;
  /** Radians since the last event. Positive = clockwise. */
  rotation: number;
  /** Centroid travel since the last event, in CSS px. */
  dx: number;
  dy: number;
  /** Centroid, local to the attached element — the anchor for the zoom. */
  x: number;
  y: number;
  /** How many pointers are down (≥ 2 while a gesture is live). */
  count: number;
}

export interface MultiTouchHandlers {
  /**
   * The second finger just landed. Cancel whatever single-finger drag is in
   * flight here — the user is navigating, not editing, and the half-finished
   * move should not commit.
   */
  onStart?: () => void;
  onGesture: (g: MultiTouch) => void;
  onEnd?: () => void;
  /** Off for surfaces where navigation is meaningless (a static panel). */
  enabled?: boolean;
}

interface Pt {
  x: number;
  y: number;
}

const centroid = (pts: Pt[]): Pt => {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
};

/** Mean distance from the centroid — the scale basis, and it generalises past
 *  two fingers, where the "distance between the two touches" formula does not. */
const spread = (pts: Pt[], c: Pt): number => {
  let sum = 0;
  for (const p of pts) sum += Math.hypot(p.x - c.x, p.y - c.y);
  return sum / pts.length;
};

/** Angle of the first pointer about the centroid — enough for a twist. */
const angle = (pts: Pt[], c: Pt): number => Math.atan2(pts[0]!.y - c.y, pts[0]!.x - c.x);

/**
 * How long a pen suppresses touch after it lifts. Long enough to cover the
 * gap between the nib leaving the glass and the palm following it; short
 * enough that deliberately switching to two fingers feels immediate.
 */
const PEN_SUPPRESS_MS = 700;

export interface MultiTouchState {
  /**
   * Is a two-finger gesture live right now? Read it from a single-pointer move
   * handler to bail out — the two-line seam that stops a half-started drag from
   * fighting the pinch it turned into.
   */
  active: () => boolean;
  /** Is a pen currently in contact (or just lifted)? Touch should stand down. */
  penActive: () => boolean;
}

export function useMultiTouch(
  ref: React.RefObject<HTMLElement | null>,
  handlers: MultiTouchHandlers,
): MultiTouchState {
  const latest = React.useRef(handlers);
  latest.current = handlers;

  // Deliberately refs, not state: this runs at pointer-move rate during a
  // pinch, and a setState per frame would re-render the surface underneath the
  // gesture. Nothing here needs to paint — the consumer's own store does.
  const pointers = React.useRef(new Map<number, Pt>());
  const prev = React.useRef<{ c: Pt; d: number; a: number } | null>(null);
  const penUntil = React.useRef(0);
  /** `null` = no gesture, "possible" = fingers down but uncommitted, "began" =
   *  committed and emitting. Nothing reaches the consumer while possible. */
  const phase = React.useRef<null | "possible" | "began">(null);
  /** Absolute travel/spread since the fingers landed, used to decide whether
   *  the gesture has earned the right to act. Not an accumulation — see below. */
  const committed = React.useRef({ travel: 0, spread: 0 });

  const state = React.useMemo<MultiTouchState>(
    () => ({
      active: () => phase.current === "began",
      penActive: () => performance.now() < penUntil.current,
    }),
    [],
  );

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = (): { c: Pt; d: number; a: number } | null => {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return null;
      const c = centroid(pts);
      return { c, d: spread(pts, c), a: angle(pts, c) };
    };

    const stop = () => {
      if (!phase.current) return;
      const began = phase.current === "began";
      phase.current = null;
      prev.current = null;
      // Only a gesture that actually began has an end worth reporting.
      if (began) latest.current.onEnd?.();
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "pen") {
        // A pen owns the surface. Any fingers already down are palm, and the
        // gesture they were building is not one the user asked for.
        penUntil.current = Number.POSITIVE_INFINITY;
        pointers.current.clear();
        stop();
        return;
      }
      if (e.pointerType !== "touch") return;
      if (latest.current.enabled === false) return;
      if (performance.now() < penUntil.current) return;

      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size < 2 || phase.current) return;
      // POSSIBLE, not began: no callback, no camera movement, nothing the user
      // can see. The gesture earns the right to act by moving.
      phase.current = "possible";
      prev.current = measure();
      committed.current = { travel: 0, spread: 0 };
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "pen") return;
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!phase.current) return;

      const now = measure();
      const was = prev.current;
      if (!now || !was) return;

      // Guard the degenerate case: two fingers landing on the same pixel gives
      // a zero spread, and the ratio is Infinity. A frame with no scale change
      // is the honest answer, and the next frame recovers.
      const scale = was.d > 0.5 && now.d > 0.5 ? now.d / was.d : 1;
      let rotation = now.a - was.a;
      // Unwrap across ±π so a twist through the seam is not read as a full turn.
      if (rotation > Math.PI) rotation -= 2 * Math.PI;
      if (rotation < -Math.PI) rotation += 2 * Math.PI;

      if (phase.current === "possible") {
        // Undecided. `prev` is deliberately NOT advanced here, so these are
        // absolute distances from where the fingers landed — an assignment, not
        // an accumulation. Accumulating per-frame distance from a fixed origin
        // over-counts badly (a finger jittering in place would "travel" metres),
        // which would make a slow, careful tap register as a pinch.
        const c = committed.current;
        c.travel = Math.hypot(now.c.x - was.c.x, now.c.y - was.c.y);
        c.spread = Math.abs(now.d - was.d);
        if (c.travel < CLAIM_SLOP_PX && c.spread < CLAIM_SLOP_PX) return;

        // COMMITTED. Claiming the pointers is what stands the long-press
        // recognizer down — two fingers on a surface must never also open a
        // context menu — and `onStart` cancels the host's single-finger drag
        // only now, so a tap never aborts a drag it did not replace.
        phase.current = "began";
        // `"navigate"`, not `"multi"`: the fingers were already claimed
        // provisionally when the second one landed. THIS is the upgrade that
        // says a continuous gesture won — and it is what stands the two-finger
        // TAP down, which the provisional claim deliberately does not.
        for (const id of pointers.current.keys()) claimPointer(id, "navigate");
        latest.current.onStart?.();
      }

      prev.current = now;
      const rect = el.getBoundingClientRect();
      latest.current.onGesture({
        scale,
        rotation,
        dx: now.c.x - was.c.x,
        dy: now.c.y - was.c.y,
        x: now.c.x - rect.left,
        y: now.c.y - rect.top,
        count: pointers.current.size,
      });
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerType === "pen") {
        // Start the suppression window on lift rather than clearing outright:
        // the palm is still on the glass and will fire its own events.
        penUntil.current = performance.now() + PEN_SUPPRESS_MS;
        return;
      }
      if (!pointers.current.delete(e.pointerId)) return;
      if (pointers.current.size < 2) stop();
      else if (phase.current === "began") prev.current = measure();
    };

    // Capture phase: the gesture has to be recognised before the surface's own
    // single-pointer handler commits to a drag, and several surfaces stop
    // propagation on their own children.
    const opts = { capture: true } as const;
    el.addEventListener("pointerdown", onDown, opts);
    /*
     * TAKING THE PINCH BACK FROM THE BROWSER.
     *
     * On a SCROLLER (`touch-action: pan-x pan-y`) the browser owns one-finger
     * panning, which is what we want. But it also starts claiming the gesture
     * the moment a second finger lands, and once it has, our pointers get
     * cancelled mid-pinch — which is exactly why zooming the timeline felt
     * laggy and kept "releasing" while the stage (`touch-action: none`) was
     * smooth.
     *
     * `preventDefault()` on a NON-PASSIVE touchstart cancels the browser's
     * scroll for that gesture, and only when a second finger is actually down.
     * One finger still scrolls natively; two fingers are ours, completely, on
     * every surface. That removes the "best-effort pinch on scrollers" caveat
     * rather than living with it.
     *
     * Non-passive is required — a passive listener may not preventDefault, and
     * the browser defaults touchstart to passive on scrollable elements.
     */
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2 && e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchstart", onTouchStart, { passive: false });
    // Move/up on the WINDOW: fingers wander outside the element mid-pinch, and
    // a listener bound to the element would silently drop the gesture there.
    window.addEventListener("pointermove", onMove, opts);
    window.addEventListener("pointerup", onUp, opts);
    window.addEventListener("pointercancel", onUp, opts);
    return () => {
      el.removeEventListener("pointerdown", onDown, opts);
      el.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("pointermove", onMove, opts);
      window.removeEventListener("pointerup", onUp, opts);
      window.removeEventListener("pointercancel", onUp, opts);
      pointers.current.clear();
      stop();
    };
  }, [ref]);

  return state;
}

/**
 * The `touch-action` a surface needs, DERIVED from what it does with pointers.
 *
 * Hand-writing this is how touch support gets silently half-finished: the
 * handlers are correct, the CSS is missing, the browser claims the gesture on
 * the first move, and the surface looks like it ignores touch entirely. Ask
 * here instead and the two can't drift.
 *
 *   "canvas"  — the surface owns every gesture (stage, node board, drawing).
 *   "scroller"— native scrolling is the point; we only add pinch (panels,
 *               timeline lanes). The browser keeps one-finger scroll, which is
 *               exactly the behaviour a list should have, and still delivers
 *               the second finger to us.
 *   "control" — a small widget dragged for a value (slider, knob, handle).
 */
export function touchActionFor(kind: "canvas" | "scroller" | "control"): string {
  return kind === "scroller" ? "pan-x pan-y" : "none";
}

/**
 * THE OTHER HALF: a draggable whose arbitration is TIME and DIRECTION, not
 * hit-target — everything governed by `beginHeldDrag` (`input/hold-to-drag`).
 *
 * `DRAG_SURFACE` and a gesture scope are a CONTRADICTION, and it is the bug
 * both of them were written to fix. `touch-action: none` says *the browser may
 * never scroll from here* — decided at hit-test time, before anybody knows
 * whether this gesture is a drag or a swipe. A scope says *the browser keeps
 * this until the finger earns it*. Wear both and the scope's abandon branch
 * hands the gesture back to a scroller that has already been told it may not
 * move: the swipe does nothing at all, and the control is the only thing a
 * finger can do there.
 *
 * That is why an inspector full of sliders could not be scrolled, and why a
 * swipe across the timeline that happened to start on a clip went nowhere.
 *
 * So a scoped draggable declares only the parts that are unconditionally true
 * of a drag — it is not a text selection, and it is not an iOS copy/share
 * callout (a separate system gesture, and when it appears iOS cancels the touch
 * that summoned it, so a drag held still for half a second dies with no menu
 * ever visible to explain why). The scroll it sits in stays the browser's, and
 * arming takes it back by claiming the pointer, which is the same guarantee one
 * decision later.
 *
 * Use `DRAG_SURFACE` when the element IS the surface — a canvas, a resize
 * gutter, a floating window edge, a scrub band. Use this one when it sits
 * INSIDE something that scrolls.
 */
export const HELD_DRAG_SURFACE = "select-none [-webkit-touch-callout:none]";

/**
 * THE class an element wears when it IS the surface — a canvas, a resize
 * gutter, a floating-window edge, a scrub band. `touch-action: none`, so the
 * browser resolves scroll-vs-drag by HIT-TARGET, before any handler runs.
 *
 * That is the right tool whenever the answer is a property of WHERE the finger
 * landed. It is the wrong one for a control sitting inside a scroller, where
 * the answer depends on time or direction — use `HELD_DRAG_SURFACE` and a
 * gesture scope there, and never both.
 *
 * `select-none` and `-webkit-touch-callout: none` ride along for the reasons
 * given above; one name, so a new draggable cannot invent a fourth spelling of
 * it and a review can grep for the ones that forgot.
 */
export const DRAG_SURFACE = `touch-none ${HELD_DRAG_SURFACE}`;

/**
 * THE class every SCROLLER wears — and the app's default for a panel.
 *
 * ## Moving freely is the default; a tool action is the exception
 *
 * The rule this replaces said one finger is always the tool, so every scroller
 * wore `DRAG_SURFACE` and one-finger scrolling was removed app-wide, with a
 * two-finger pan handed back in its place. It is coherent, Procreate does it —
 * and on a timeline it is wrong. Dragging left and right IS the primary
 * navigation of a timeline, a sheet, a list. Making the most common thing a
 * person does need two fingers, so that the rarest thing (rubber-band
 * selection) can have one, is the trade backwards.
 *
 * So: **a scroller scrolls, with one finger, natively.** No JS, no momentum to
 * re-implement, no rubber-band to fake, no `pointercancel` to survive — the
 * browser has done this well for fifteen years and it is free.
 *
 * ## How "unless I'm dragging that clip" resolves with no code at all
 *
 * `touch-action` inherits down the subtree and the nearest declaration wins.
 * So the viewport says `pan-x pan-y` and each grabbable thing inside it —
 * a clip, a trim edge, a keyframe, a flipbook cell — says `DRAG_SURFACE`. The
 * BROWSER then resolves the ambiguity by hit-target, before a single handler
 * runs: finger on empty lane scrolls, finger on a clip moves the clip.
 *
 * That is the whole arbitration, and it needs no recognizer, no threshold and
 * no guessing about intent. It is worth noticing that the hard version of this
 * problem — "is this drag a scroll or an edit?" — is one the platform already
 * answers, as long as the elements say what they are.
 *
 * ## What it costs
 *
 * Two-finger pinch-to-zoom becomes best-effort here. Once the browser commits
 * to a scroll it takes the pointers and fires `pointercancel`, so a pinch that
 * starts with centroid travel can be swallowed. `pinch-zoom` is deliberately
 * NOT in the value — that would hand the browser the gesture and page-zoom the
 * app — so a clean two-finger spread still reaches us. Trackpad pinch and
 * ⌘-wheel are unaffected, and the zoom dial is the guaranteed path on touch.
 * Reliable scrolling for best-effort pinch is the right way round: one is used
 * constantly, the other has two other affordances.
 */
export const SCROLL_SURFACE = "[touch-action:pan-x_pan-y] select-none";
