"use client";

import * as React from "react";
import { pointerMay, usePointerAuthority, type FingerCanvasMode, type PointerAct } from "./pointer-authority";
import { claimPointer, subscribePointerEnd, trackedPointer } from "./pointer-gestures";

/**
 * TOUCH INTENT — deciding whether a finger meant to NAVIGATE or to AUTHOR,
 * before either happens.
 *
 * Pen-only solves this by fiat: on a tablet the finger simply never authors.
 * But pen-only can be switched off, and plenty of people have no stylus at all,
 * and for them one finger on a canvas was still ambiguous the instant it
 * landed — the stage committed to the armed tool immediately, so a press meant
 * as "shove the canvas over a bit" selected a layer, dragged it, drew a dab or
 * erased part of a stroke before the finger had travelled ten pixels.
 *
 * A canvas cannot arbitrate this the way a scroller does. In a scroller,
 * `touch-action` lets the BROWSER decide by hit-target — empty lane scrolls,
 * clip drags — and no timers are involved. A canvas has no scroll to hand the
 * gesture to and no hit-target distinction to make: the same pixels mean both
 * things. So this is the one place where the app must recognise intent itself,
 * and the honest way to do that is the UIKit one: stay in `possible`, and let
 * the first thing the finger DOES decide.
 *
 *   moves first (past SLOP, before HOLD_MS)  → NAVIGATION. Pan the camera. The
 *                                              tool is never told a press
 *                                              happened, so there is nothing to
 *                                              undo and no half-drawn dab.
 *   holds still (HOLD_MS with no travel)     → AUTHORING. The press is replayed
 *                                              to the tool exactly as it
 *                                              arrived, and everything downstream
 *                                              behaves as if nothing intervened.
 *
 * Mouse and pen are untouched and engage instantly. They are precise
 * instruments whose press is already unambiguous, and adding 180ms to a mouse
 * click to solve a finger's problem would be the classic mistake.
 *
 * ── Why a REPLAY rather than a cancel ───────────────────────────────────────
 *
 * The other shape — start the tool immediately and undo it if the finger turns
 * out to be panning — means every tool needs a "never mind" path: remove the
 * dab, un-select the layer, drop the half-made shape. Twelve tools, twelve
 * chances to get it wrong. Not starting is free; unstarting is not.
 *
 * React 19 does not pool events, but it DOES null `currentTarget` once the
 * handler returns, so the event object cannot simply be kept. `snapshot()`
 * copies the closed set of fields the stage's handler actually reads. That set
 * is small and checked — if a tool later needs another field, this is the one
 * place to add it, and forgetting shows up immediately rather than silently.
 */

/** Travel that means "I am moving the canvas", not "I am pressing here". */
const SLOP_PX = 8;
/** Still this long and the press is deliberate. Long enough to survive the
 *  wobble of putting a finger down, short enough not to feel like lag. */
const HOLD_MS = 180;

/** The fields a replayed press carries. Kept minimal on purpose — see above. */
type PressSnapshot = Pick<
  React.PointerEvent,
  | "altKey"
  | "button"
  | "clientX"
  | "clientY"
  | "ctrlKey"
  | "detail"
  | "metaKey"
  | "pointerId"
  | "pointerType"
  | "shiftKey"
  // A brush reads the pen — pressure, tilt, time — and the NATIVE event for
  // its coalesced samples. Without these a finger held still on an iPad
  // replayed into the paint tool and threw on `nativeEvent.getCoalescedEvents`.
  | "nativeEvent"
  | "pressure"
  | "tiltX"
  | "tiltY"
  | "twist"
  | "width"
  | "height"
  | "isPrimary"
  | "timeStamp"
  | "preventDefault"
  | "stopPropagation"
> & { target: EventTarget | null; currentTarget: EventTarget | null };

function snapshot(e: React.PointerEvent): React.PointerEvent {
  const native = e.nativeEvent;
  const s: PressSnapshot = {
    altKey: e.altKey,
    button: e.button,
    clientX: e.clientX,
    clientY: e.clientY,
    ctrlKey: e.ctrlKey,
    detail: e.detail,
    metaKey: e.metaKey,
    pointerId: e.pointerId,
    pointerType: e.pointerType,
    shiftKey: e.shiftKey,
    nativeEvent: native,
    pressure: e.pressure,
    tiltX: e.tiltX,
    tiltY: e.tiltY,
    twist: e.twist,
    width: e.width,
    height: e.height,
    isPrimary: e.isPrimary,
    timeStamp: e.timeStamp,
    // The press has already been dispatched; there is nothing left to stop.
    preventDefault: () => {},
    stopPropagation: () => {},
    target: e.target,
    currentTarget: e.currentTarget,
  };
  return s as unknown as React.PointerEvent;
}

export interface TouchIntentHandlers {
  /** Engage the tool. Called with the original press for mouse/pen, or with a
   *  replayed snapshot of it once a finger has held still. */
  onTool: (e: React.PointerEvent) => void;
  /** The finger is navigating: move the camera by this screen delta. */
  onPan: (dx: number, dy: number) => void;
  /**
   * WHICH ACT the armed tool performs, asked per press because the answer
   * changes with the tool. A door that asked one question for every tool is
   * what made pen-only all-or-nothing: refusing the finger for a brush also
   * refused it for moving a layer.
   */
  act: PointerAct | ((e: React.PointerEvent) => PointerAct);
  /**
   * Which finger setting governs this surface, asked per press. Absent, the
   * flat canvas's (`fingerCanvas`). A 3D viewport answers with its own
   * (`fingerWorld`), and with `tool` while a brush is armed — a sculpt or
   * draw stroke is the finger's job wherever the pen-only rule lets it paint.
   */
  finger?: (e: React.PointerEvent) => FingerCanvasMode;
  /** Off where a canvas has no camera to pan. */
  enabled?: boolean;
}

/**
 * Returns the `onPointerDown` a canvas should mount INSTEAD of its tool
 * handler. Everything else about the surface is unchanged.
 */
export function useTouchIntent(handlers: TouchIntentHandlers): (e: React.PointerEvent) => void {
  const latest = React.useRef(handlers);
  latest.current = handlers;

  return React.useCallback((e: React.PointerEvent) => {
    const h = latest.current;
    const act = typeof h.act === "function" ? h.act(e) : h.act;
    /*
     * A REFUSED FINGER STILL NAVIGATES.
     *
     * This used to `return`, and that single line is most of why pen-only felt
     * like the app had stopped responding: with a brush armed, a finger could
     * neither paint (correct) NOR move the canvas (nonsense — the finger has
     * nothing else to do). Refusing an ACT must never refuse navigation, so a
     * refused press falls through to the pan branch with the tool half
     * removed. That is the difference between a rule and a wall.
     */
    const mayAct = pointerMay(e, act);
    const finger = h.finger ? h.finger(e) : usePointerAuthority.getState().fingerCanvas;
    if (
      mayAct &&
      (h.enabled === false || e.pointerType !== "touch" || e.button !== 0 || finger === "tool")
    ) {
      h.onTool(e);
      return;
    }
    if (!mayAct && (h.enabled === false || e.pointerType !== "touch")) return;

    const press = snapshot(e);
    const startX = e.clientX;
    const startY = e.clientY;
    let last = { x: startX, y: startY };
    let decided: "tool" | "pan" | null = null;

    /*
     * HOLDING STILL IS ALWAYS A CONTEXT MENU. Engaging the tool takes a hold
     * AND THEN A MOVE.
     *
     * `hold` mode used to engage the tool the instant 180ms landed, and claim
     * the pointer there. That is a second hold gesture on the same surface as
     * the app's 500ms hold-to-menu, and the shorter one always wins — so on a
     * tablet the canvas had no context menu at all: resting a finger on a layer
     * silently started a tool gesture and the menu never came.
     *
     * They compose once the hold only ARMS. A press that holds still and keeps
     * holding still is unambiguously a menu, and gets one. A press that holds
     * and then moves is unambiguously an authoring drag, and the tool receives
     * the original press exactly as it arrived. Neither has to guess, and there
     * is still no "never mind" path to write in twelve tools — a press that
     * turned out to be a menu is simply never handed to one.
     */
    let armed = false;

    const engage = () => {
      if (decided) return;
      // Something else got there first — the long press, a second finger, a
      // gesture that claimed on press. A claimed pointer is never ours.
      if (trackedPointer(press.pointerId)?.claim) {
        decided = "pan";
        cleanup();
        return;
      }
      decided = "tool";
      if (!mayAct) {
        cleanup();
        return;
      }
      // Claim only NOW, when the gesture has become a real drag. Claiming at
      // the hold would stand the menu down before it could ever fire.
      claimPointer(press.pointerId, "hold");
      cleanup();
      h.onTool(press);
    };

    // The hold ARMS the tool; movement engages it. `navigate` does not arm at
    // all — there, one finger pans and a hold is only ever a menu.
    const timer =
      finger === "hold"
        ? window.setTimeout(() => {
            armed = true;
          }, HOLD_MS)
        : 0;

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== press.pointerId) return;
      if (decided === "tool") return;
      if (!decided) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < SLOP_PX) return;
        window.clearTimeout(timer);
        if (armed) {
          // Held, then moved: an authoring drag. The tool gets the original
          // press, replayed.
          engage();
          return;
        }
        // Travelled before the hold landed: the press was not deliberate, so
        // the tool never hears about it either way.
        decided = "pan";
      }
      /*
       * In `hold` (the default) an early swipe is INERT — it neither authors
       * nor pans. Two fingers move the view, the same two that zoom, so one
       * finger has nothing left to do here and doing nothing is the honest
       * answer: an accidental brush moves neither the artwork nor the camera.
       * `navigate` opts back into the one-finger pan.
       */
      if (finger !== "navigate" && mayAct) return;
      h.onPan(ev.clientX - last.x, ev.clientY - last.y);
      last = { x: ev.clientX, y: ev.clientY };
    };

    const onUp = () => {
      // Lifted before either verdict: a TAP. That is a real tool press (tapping
      // to select is the most ordinary thing on a canvas), so it engages —
      // `engage` no-ops if the hold already fired.
      window.clearTimeout(timer);
      if (!decided) {
        cleanup();
        decided = "tool";
        // A TAP is always allowed to select, whatever the armed tool may not
        // do with a drag — `pick` is its own act, and taking it away leaves a
        // canvas that cannot respond to a finger at all. A CLAIMED press is not
        // a tap: the long press turned it into a menu, or a second finger made
        // it half of a two-finger tap — and replaying that one as a tool press
        // is how undo-by-tap also placed a pen node under the anchoring finger.
        if (trackedPointer(press.pointerId)?.claim) return;
        if (mayAct || pointerMay(press, "pick")) h.onTool(press);
        return;
      }
      cleanup();
    };

    /*
     * A press that stops being a one-finger press stops being ours. The
     * arbiter says so at the second finger's `pointerdown` (`superseded`) —
     * a moment this pointer's own move handler can never observe, since the
     * anchoring finger of a pinch does not move. Without this, the pinch's
     * anchor finger crossed SLOP on its own and drove a second, one-finger pan
     * underneath the two-finger one. `up` is left to `onUp`: the arbiter
     * publishes it in capture, before the tap could fire.
     */
    const unsubscribe = subscribePointerEnd((id, reason) => {
      if (id !== press.pointerId || reason === "up" || decided === "tool") return;
      decided = "pan";
      cleanup();
    });

    function cleanup() {
      unsubscribe();
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
  }, []);
}
