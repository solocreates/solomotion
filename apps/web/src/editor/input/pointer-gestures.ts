"use client";

import { notePen, usePointerAuthority } from "./pointer-authority";

/**
 * THE GESTURE ARBITER — who owns this pointer, and has anyone committed yet.
 *
 * Three separate bugs turned out to be the same missing concept, which is why
 * this exists rather than three fixes:
 *
 *   · a two-finger tap for undo also nudged the stage camera, because the pinch
 *     recognizer emitted a zoom from the first jitter between the fingers and
 *     only decided it had been a tap afterwards;
 *   · there was no long-press → context menu anywhere, and adding one naively
 *     would fire in the middle of every clip drag and every stage manipulation;
 *   · a hold on a toolbar button already means "open my flyout", so a second
 *     hold gesture layered over the app would collide with it.
 *
 * All three are arbitration. A pointer can mean several things at once, and the
 * question "which gesture owns it" needs ONE answer that every recognizer
 * reads, instead of each guessing.
 *
 * ## The model
 *
 * Straight out of UIKit, because it is the model that works:
 *
 *     possible → began → changed* → ended
 *              ↘ failed
 *
 * A CONTINUOUS gesture (pinch, pan, drag) stays `possible` and emits NOTHING
 * until it passes a threshold. Crossing it is the commitment, and committing
 * CLAIMS the pointer.
 *
 * A DISCRETE gesture (tap, long-press) is only allowed to fire while the
 * pointer is unclaimed. The instant something continuous claims it, the
 * discrete recognizer fails silently.
 *
 * That is the whole rule, and it is what keeps the two-finger tap from zooming
 * and the long-press from firing mid-drag — not a pile of special cases.
 *
 * ## Why claiming is mostly automatic
 *
 * This app has around forty hand-rolled pointer drags, written over a long
 * time, and a design that needed each of them to call `claim()` would be wrong
 * on the day it shipped: the one that forgot would be the bug, and nobody would
 * find it. So movement claims the pointer on its own. A drag moves — that is
 * what makes it a drag — so every existing gesture claims correctly without
 * knowing this file exists.
 *
 * `claimPointer` is for the rare gesture that is meaningful while STATIONARY
 * and so cannot be detected by movement: the modifier puck's press-and-hold,
 * a toolbar button's flyout. Those are a handful, and they are exactly the ones
 * that must not also open a context menu.
 */

/**
 * WHO OWNS THIS POINTER, and — the part that was missing and cost a working
 * feature — WHAT KIND of ownership it is.
 *
 * There was one claim kind doing two incompatible jobs, and conflating them
 * deleted the timeline's context menu. A clip's move-drag claims on press so
 * the browser will not scroll the lanes underneath it; the long-press
 * recognizer read that same claim as "something else owns the hold" and stood
 * down — forever, on every clip. Hold a clip and you got a drag and never a
 * menu.
 *
 * They are different questions and now have different answers:
 *
 *   "drag"        this gesture WILL MOVE. Suppresses the browser's scroll,
 *                 and nothing else. It does not suppress the long press,
 *                 because a press that has not moved yet is still a candidate
 *                 for one — and MOVEMENT is what settles it, which the
 *                 recognizer already tests for.
 *   "hold"        this gesture is meaningful while STATIONARY and owns the
 *                 press outright: a trim edge, a slider, a scrub, a toolbar
 *                 flyout, the tool engaged by `useTouchIntent`. The long press
 *                 stands down.
 *   "multi"       MORE THAN ONE FINGER IS DOWN. Provisional, and set the
 *                 instant the second finger lands — before anyone knows
 *                 whether this will become a pinch, a pan or a two-finger tap.
 *                 Every SINGLE-pointer gesture stands down at once; the
 *                 multi-finger recognizers are still competing among
 *                 themselves, so this claim deliberately does not silence them.
 *   "navigate"    a continuous two-finger gesture COMMITTED — a pinch, a
 *                 two-finger pan. Now everything stands down, the two-finger
 *                 tap included: the gesture has resolved, and it resolved to
 *                 the other one.
 *   "menu"        the long press itself, so the trailing release cannot also
 *                 be read as a tap by whatever is underneath.
 *
 * `"multi"` and `"navigate"` used to be one kind, and merging them is what let
 * a pinch also move the clip under the anchoring finger. "Fingers are down" and
 * "a two-finger gesture has won" are different facts that become true at
 * different moments, and the gap between them is the entire window in which the
 * damage happened.
 *
 * The rule to apply when adding a gesture: **claim `"hold"` only if holding
 * still is already doing something.** Otherwise claim `"drag"` and let
 * movement speak.
 */
export type PointerClaim = "drag" | "hold" | "multi" | "navigate" | "menu";

/**
 * Claims that OWN the stationary press, so the long press stands down.
 *
 * `"drag"` is deliberately absent, and that asymmetry is the whole point. A
 * clip's move claims `"drag"` so the browser will not scroll the lanes under
 * it — and holding a clip still must open its menu, so a `"drag"` claim cannot
 * be allowed to suppress one.
 *
 * This check was removed once, on the reasoning that "movement cancels a hold,
 * so a claim never needs to". That is true only for gestures that MOVE. A
 * panel resize, a window drag, a slider and a trim edge are stationary FIRST —
 * you put a finger down and position it — so for them the long press fired
 * mid-gesture, dispatched a `contextmenu`, and on iOS the system callout that
 * follows cancelled the touch outright. The drag "let go after a moment", with
 * no menu ever visible to explain why.
 *
 * So: movement settles it for gestures that move, and a DECLARATION settles it
 * for gestures that do not. Both are needed because both kinds exist.
 */
const OWNS_THE_HOLD = new Set<PointerClaim>(["hold", "multi", "navigate", "menu"]);


interface LivePointer {
  id: number;
  type: string;
  downAt: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** Furthest the pointer has been from where it went down, in CSS px. */
  travel: number;
  claim: PointerClaim | null;
  /**
   * The claim came from an explicit `claimPointer` call, not from movement.
   *
   * The distinction matters for exactly one thing and it is load-bearing:
   * refusing the browser's scroll. Movement claims EVERY pointer that travels
   * 10px — including a finger scrolling a panel, which is the single most
   * common gesture in the app. Suppressing scroll on that basis would break
   * scrolling app-wide. A gesture that declared itself on PRESS is the only
   * kind that is certainly not a scroll.
   */
  explicit: boolean;
  /**
   * A second finger landed while this pointer was down, so whatever
   * single-pointer gesture it was driving has been told to abort.
   *
   * Latched: it must not clear when the other finger lifts, or letting one
   * finger go mid-pinch would hand the remaining one a fresh drag on whatever
   * it happens to be resting on.
   */
  superseded: boolean;
  target: EventTarget | null;
}

/** Movement past this is a drag, and claims the pointer for whoever is doing it. */
export const CLAIM_SLOP_PX = 10;

const live = new Map<number, LivePointer>();

/** Started tracking? The recognizers below all read from one table. */
export function trackedPointer(id: number): Readonly<LivePointer> | undefined {
  return live.get(id);
}

export function pointerCount(): number {
  return live.size;
}

/**
 * Take ownership of a pointer for a continuous gesture. Every discrete
 * recognizer watching it stands down immediately.
 */
export function claimPointer(id: number, by: PointerClaim): void {
  const p = live.get(id);
  if (!p || p.claim) return;
  p.claim = by;
  p.explicit = true;
}

export function isClaimed(id: number): boolean {
  return live.get(id)?.claim != null;
}

/** How far this pointer has travelled since it went down. */
export function pointerTravel(id: number): number {
  return live.get(id)?.travel ?? 0;
}

// ── Pointer end: the one signal a hand-rolled drag needs to be cancel-proof ──

/**
 * Why a single-pointer gesture is over.
 *
 * `lost` is the one a drag forgets about; `superseded` is the one it cannot
 * detect at all. The pointer is still physically on the glass — a second finger
 * simply arrived, so this stopped being a one-finger gesture. Same handling as
 * `lost`: ABORT, never commit.
 */
export type PointerEndReason = "up" | "cancel" | "lost" | "superseded";

type EndListener = (id: number, reason: PointerEndReason) => void;
const endListeners = new Set<EndListener>();

/**
 * Told whenever a pointer goes away for ANY reason — released, cancelled by
 * the browser, or lost because the window blurred or the tab was hidden.
 *
 * This exists because the doc's "one thing most likely to bite next" bit
 * three more times: a drag that tears down only on `pointerup` works
 * perfectly with a mouse and leaks on every touch. Rather than asking each of
 * the app's ~40 hand-rolled drags to remember the
 * `pointerup`/`pointercancel`/`blur` trio, the arbiter — which already tracks
 * every pointer in the window, in capture phase, where nothing can hide one
 * from it — publishes the fact once and a drag subscribes in one line.
 */
export function subscribePointerEnd(fn: EndListener): () => void {
  endListeners.add(fn);
  return () => endListeners.delete(fn);
}

function endPointer(id: number, reason: PointerEndReason): void {
  if (!live.delete(id)) return;
  for (const fn of endListeners) fn(id, reason);
}

/** Fingers, not pointers. A pen is never half of a two-finger gesture, and a
 *  palm resting beside one must not be counted as the other half. */
function fingerCount(): number {
  let n = 0;
  for (const p of live.values()) if (p.type === "touch") n++;
  return n;
}

/**
 * Is a multi-finger gesture in progress right now?
 *
 * Ask before STARTING a single-pointer gesture. One that begins while a second
 * finger is already on the glass was never a one-finger gesture, and there is
 * no later moment at which that becomes discoverable — the pointer it would
 * watch may never move again.
 */
export function multiFingerDown(): boolean {
  return fingerCount() > 1;
}

/**
 * THE SECOND FINGER ENDS EVERY ONE-FINGER GESTURE, IMMEDIATELY.
 *
 * This is the fact that was missing, and its absence was the whole bug: a pinch
 * also moved the clip, layer or keyframe under the anchoring finger, and a
 * two-finger tap also selected whatever it landed on.
 *
 * Everything needed to prevent that was already here — it was just asked at the
 * wrong moment, and both times the moment was a MOVE:
 *
 *   · `beginHeldDrag` polled the pointer count, but only from its own pointer's
 *     move handler. The anchor finger of a pinch does not move; the other one
 *     does. So the drag stayed armed and committed on release.
 *   · `direct-activation` dropped a press once it became a gesture, also only
 *     on move — so a finger that landed and sat still stayed a perfectly good
 *     tap candidate right through to the release, and activated whatever was
 *     under it.
 *
 * Correct rules, attached to an event that never arrives. So the arbiter
 * publishes the fact itself, at the one moment it becomes true — the second
 * finger's `pointerdown` — and it does two things at once:
 *
 *   · every live pointer is CLAIMED `"multi"`, which is the signal every
 *     discrete recognizer already stands down on. Nothing had to be edited.
 *   · every live pointer's gesture is told it has ENDED, with `"superseded"`.
 *     Abort semantics, exactly like `lost`: nothing on release is a decision
 *     the user made if the gesture was already over.
 *
 * The pointers STAY in `live` — they are still on the glass and the
 * multi-finger recognizers need them. Only the single-pointer reading of them
 * is retired, which is why this cannot be expressed as `endPointer`.
 *
 * A pen down anywhere suspends this outright. A stylus owns the surface, and
 * the contacts either side of it are a palm — the assumption `useMultiTouch`'s
 * own suppression window already makes.
 */
function supersedeSinglePointerGestures(): void {
  for (const p of live.values()) if (p.type === "pen") return;
  for (const p of live.values()) {
    if (p.superseded) continue;
    p.superseded = true;
    // Forced, not defaulted: a finger already mid-drag carries a `"drag"` or
    // `"hold"` claim, and that drag is precisely what must now stand down.
    p.claim = "multi";
    p.explicit = true;
    for (const fn of endListeners) fn(p.id, "superseded");
  }
}

/**
 * Start the app-wide pointer bookkeeping. Mounted once at the shell root,
 * beside the modifier tracker (see `Editor.tsx`).
 *
 * Listeners are CAPTURE-phase and on the window, so a component that stops
 * propagation — and several do, deliberately, to contain portalled surfaces —
 * cannot blind the arbiter. Reading the pointer stream is never something a
 * component should be able to switch off for everyone else.
 */
export function startPointerTracking(): () => void {
  if (typeof window === "undefined") return () => {};

  const onDown = (e: PointerEvent) => {
    /*
     * A STYLUS TOUCHING THE GLASS ANYWHERE IS A STYLUS.
     *
     * This used to be recorded only when a pen pressed on the stage or the
     * drawing overlay, because that was where the check that consulted it
     * lived. So a Pencil that had spent five minutes tapping buttons, opening
     * panels and scrubbing the timeline had still never been "seen", and the
     * first stroke of the session was handed to the finger anyway — the exact
     * failure `auto` exists to prevent. The tracker sees every pointer in the
     * window, so it is the only place that cannot miss one.
     */
    if (e.pointerType === "pen") notePen();
    live.set(e.pointerId, {
      id: e.pointerId,
      type: e.pointerType,
      downAt: performance.now(),
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      travel: 0,
      claim: null,
      explicit: false,
      superseded: false,
      target: e.target,
    });
    // AFTER inserting, so the finger that just arrived is counted and is itself
    // superseded — it must not start a one-finger gesture either.
    if (e.pointerType === "touch" && fingerCount() > 1) supersedeSinglePointerGestures();
  };

  const onMove = (e: PointerEvent) => {
    // Synthetic moves are ours (see `cancelNativeLongPress`); they carry no
    // information about where a finger actually is.
    if (!e.isTrusted) return;
    const p = live.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    const d = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
    if (d > p.travel) p.travel = d;
    // MOVEMENT IS THE CLAIM. This is the line that makes every hand-rolled drag
    // in the app participate without being edited: a drag moves, so it claims,
    // so the discrete recognizers stand down. Nothing had to opt in.
    if (p.travel > CLAIM_SLOP_PX && !p.claim) p.claim = "drag";
  };

  const onUp = (e: PointerEvent) => {
    endPointer(e.pointerId, e.type === "pointercancel" ? "cancel" : "up");
  };

  /*
   * A DRAG NEVER SCROLLS THE THING IT IS INSIDE.
   *
   * The brush bar is a horizontal scroller full of scrubby number fields, and
   * dragging one moved the value AND scrolled the bar out from under the
   * finger. The per-control fix is `touch-action: none`, and it is the single
   * most-forgotten line in the input layer — a control can wire a perfect
   * gesture and still slide sideways because nobody wrote the CSS.
   *
   * So it is enforced here instead, from the one fact the arbiter already
   * knows: a claimed pointer belongs to a gesture, and a gesture is not a
   * scroll. The shared drag kits claim on PRESS (see `claimPointer` in
   * `usePointerDrag` and `beginScrubDrag`), which is before the first
   * `touchmove` — the last moment `preventDefault` can still refuse the
   * browser's scroll. After that the browser owns the gesture and nothing can
   * take it back, which is why this cannot be done from a move handler.
   *
   * Non-passive is mandatory: a passive listener may not `preventDefault`, and
   * browsers default `touchmove` to passive on scrollable elements.
   */
  const onTouchMove = (e: TouchEvent) => {
    if (!e.cancelable) return;
    for (const p of live.values()) {
      // EXPLICIT claims only. Movement claims a scrolling finger too, and
      // refusing the scroll it just started would break every panel in the app.
      if (p.explicit && (p.claim === "drag" || p.claim === "hold")) {
        e.preventDefault();
        return;
      }
    }
  };

  /*
   * THE POINTER THAT NEVER CAME BACK.
   *
   * `pointerup` alone looks like a complete teardown for as long as the only
   * pointer is a mouse. Touch and pen cancel constantly, and a few paths lose
   * the pointer without either event: a portalled layer opening over the press
   * (a context menu on a slow pen marquee is the one that bit), the tab being
   * hidden, the window losing focus mid-drag. Whatever was in flight is then
   * live forever — which is how a stage marquee drawn with a Pencil stayed on
   * screen with nothing able to close it.
   *
   * Every live pointer is therefore released on blur and on the tab going
   * away, and subscribers are told. One safety net, so a hand-rolled drag can
   * be made cancel-proof in one line instead of by remembering the
   * `pointerup`/`pointercancel`/`blur` trio.
   */
  const releaseAll = (reason: PointerEndReason) => {
    for (const id of [...live.keys()]) endPointer(id, reason);
  };
  const onBlur = () => releaseAll("lost");
  const onVisibility = () => {
    if (document.visibilityState === "hidden") releaseAll("lost");
  };

  const opts = { capture: true, passive: true } as const;
  window.addEventListener("pointerdown", onDown, opts);
  window.addEventListener("pointermove", onMove, opts);
  window.addEventListener("pointerup", onUp, opts);
  window.addEventListener("pointercancel", onUp, opts);
  window.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("pointerdown", onDown, opts);
    window.removeEventListener("pointermove", onMove, opts);
    window.removeEventListener("pointerup", onUp, opts);
    window.removeEventListener("pointercancel", onUp, opts);
    window.removeEventListener("touchmove", onTouchMove, { capture: true });
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
    live.clear();
  };
}

// ── Long press → context menu ───────────────────────────────────────────────

/**
 * Stand down the UI library's OWN long press, without touching anything else.
 *
 * Radix's context-menu trigger carries a private 700ms touch/pen timer that
 * opens the menu by calling `onOpenChange(true)` directly — it never dispatches
 * `contextmenu`, so nothing that works out WHAT the menu is about ever runs.
 * On the stage that produced the empty-canvas "Paste" menu over a selected
 * layer.
 *
 * The first attempt at switching it off was `preventDefault()` on every
 * context-menu trigger's pointerdown, and that was a bad trade: on touch,
 * preventing the default ALSO removes the browser's compatibility mouse burst,
 * so tapping empty timeline space stopped deselecting. A fix that reaches every
 * trigger in the app has to cost nothing at the ones that were fine.
 *
 * Radix clears its timer on `pointermove`. So the app's recognizer — the one
 * place that knows whether this press is a menu, a drag, or someone else's
 * hold — sends a zero-distance move at the moment it decides. Nothing observes
 * a stationary pointermove, nothing is prevented, and the primitive's copy is
 * silent everywhere without a single call site opting in.
 *
 * ## SYNTHETIC INPUT MUST BE A FAITHFUL ECHO, OR IT IS A LIE EVERYONE BELIEVES
 *
 * This is dispatched into the window's real pointer stream, where every drag in
 * the app AND every drag in every library we did not write is listening. Ours
 * can be taught to ignore it (`isTrusted`); theirs cannot. So the only safe
 * shape for it is an exact echo of the pointer that is genuinely down — same
 * type, same position, same BUTTON STATE.
 *
 * It was not one, and the missing field cost the panel resize on every touch
 * device. The event was built with no `buttons`, which the constructor defaults
 * to `0` — and `buttons: 0` on a `pointermove` is the platform's own way of
 * saying *the pointer was released while you weren't looking*. Any drag that
 * guards against a lost release reads it exactly that way and tears itself
 * down. `react-resizable-panels` does, in one line, and so:
 *
 *     finger crosses 10px on a gutter  → the long press stands down
 *       → this fires, claiming buttons: 0
 *         → the library stops dragging mid-drag
 *
 * Which is *"a fast drag lets go, a slow one doesn't"* exactly — slow means the
 * 500ms timer resolves first and disarms, so this never fires at all. And
 * invisible on a desktop, because the recognizer ignores a mouse outright.
 *
 * `pointerType` was hardcoded `"touch"`, too, so a Pencil's cancel arrived as a
 * finger. There is no version of this that is safe to approximate.
 */
function cancelNativeLongPress(p: LivePointer): void {
  /*
   * RE-ENTRANCY. This dispatches into the very stream the recognizers listen
   * to, so it must be impossible for one of them to call it again from the
   * event it just produced.
   *
   * It was not, and the result was not a subtle bug: the move handler saw
   * travel past the threshold, called this, the synthetic move re-entered the
   * same handler, travel was still past the threshold… A stack overflow takes
   * the tab with it, which on a tablet looks like the app spontaneously
   * reloading in the middle of dragging a panel.
   *
   * Two guards, because one of them alone is a promise about call order:
   * a latch here, and `isTrusted` at every listener that could re-enter. Our
   * own events are never input.
   */
  if (synthesising) return;
  synthesising = true;
  try {
    (p.target as Element | null)?.dispatchEvent?.(
      new PointerEvent("pointermove", {
        bubbles: true,
        composed: true,
        pointerId: p.id,
        // The echo, field by field. Every one of these is load-bearing —
        // see the doc comment above.
        pointerType: p.type,
        isPrimary: true,
        // The pointer IS still down. Saying otherwise ends other people's drags.
        buttons: 1,
        pressure: 0.5,
        clientX: p.x,
        clientY: p.y,
      }),
    );
  } finally {
    synthesising = false;
  }
}

/** True only while `cancelNativeLongPress` is dispatching its own event. */
let synthesising = false;


/** Hold this long, still and unclaimed, and it is a right-click. */
const LONG_PRESS_MS = 500;

/**
 * ONE long-press recognizer for the entire app, and it produces a real
 * `contextmenu` event.
 *
 * That last part is the design. Every context menu in this app is already a
 * Radix `ContextMenu` listening for `contextmenu` — clips, layers, tracks,
 * frames, library cards, media, flipbook cells, the stage itself — and
 * `useHoldMenu`'s toolbar flyouts take `onContextMenu` too. Dispatching the
 * event the platform already defines means every one of them gains touch and
 * Pencil support from this file alone, with no per-site changes and no registry
 * of "things that can be long-pressed" to keep in sync. A new context menu
 * added next year works on an iPad without its author doing anything.
 *
 * The alternative — a `useLongPress` hook each site spreads — is the patchy
 * version: forty call sites, each able to forget, each with its own threshold.
 *
 * It fires only when the press was still, unclaimed, single-fingered, and not
 * on something that already treats a hold as its own gesture. Those four
 * conditions are what keep it from firing in the middle of a clip drag, a stage
 * manipulation, a two-finger navigation, or a toolbar flyout.
 */
export function startLongPressContextMenu(): () => void {
  if (typeof window === "undefined") return () => {};

  let timer: ReturnType<typeof setTimeout> | null = null;
  let armedId: number | null = null;

  const disarm = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    armedId = null;
  };

  const onDown = (e: PointerEvent) => {
    // A mouse has a real right button; synthesising one for it would make
    // press-and-wait ambiguous for no gain.
    if (e.pointerType === "mouse") return;
    // A second finger means navigation, not a menu.
    if (live.size > 1) return disarm();
    // Two fingers that arrive AFTER this one also cancel it — checked at fire
    // time via `live.size`, so a pinch can never end in a context menu.

    const target = e.target as Element | null;
    // Surfaces that already own the hold: toolbar flyouts (`data-hold-menu`),
    // the modifier puck, and text inputs, where the platform's own selection
    // handles are the right behaviour and ours would fight them.
    if (
      target?.closest?.(
        "[data-hold-menu],[data-no-longpress],input,textarea,[contenteditable='true']",
      )
    ) {
      return;
    }

    disarm();
    if (!usePointerAuthority.getState().longPressMenu) return;
    armedId = e.pointerId;
    timer = setTimeout(() => {
      const id = armedId;
      timer = null;
      armedId = null;
      if (id == null) return;
      const p = live.get(id);
      // Re-check at FIRE time, not only at arm time: the press may have been
      // claimed by a stationary gesture, joined by a second finger, moved, or
      // lifted since. A `"drag"` claim is NOT disqualifying — see
      // `PointerClaim`: a drag that has not moved is still a hold.
      /*
       * A STILL PRESS IS A HOLD, AND A HOLD IS A RIGHT-CLICK. Full stop.
       *
       * This used to also stand down whenever anything had CLAIMED the pointer,
       * and that condition is what kept deleting the feature: every gesture
       * that claims early — a clip drag, a trim, a slider, the canvas's own
       * hold-to-author — silently removed the menu from its whole surface, and
       * each fix moved the hole somewhere else.
       *
       * It is unnecessary as well as harmful. A gesture that MOVES cancels the
       * hold by moving, which is the honest test and is already made below. A
       * gesture that does not move is not competing with the menu — under the
       * scope model nothing arms until movement either (see `beginHeldDrag`),
       * so a stationary press has no other claimant.
       *
       * What remains is a DECLARATION, not a side effect: a subtree that
       * genuinely owns the hold says so with `data-hold-menu` (toolbar flyouts)
       * or `data-no-longpress`, checked at arm time. Inherited, overridable,
       * and impossible to trigger by accident from an unrelated gesture.
       *
       * And because this dispatches the platform's own `contextmenu`, "is there
       * anything to right-click here?" is answered by the DOM rather than by
       * us: something with a menu opens it, everything else ignores the event
       * and whatever the press was already doing simply carries on.
       */
      if (!p || live.size > 1 || p.travel > CLAIM_SLOP_PX) return;
      // Something is already using this stationary press — a resize gutter, a
      // window drag, a slider, a trim edge. See `OWNS_THE_HOLD`.
      if (p.claim && OWNS_THE_HOLD.has(p.claim)) return;

      // Claim it ourselves so the trailing `pointerup` cannot also be read as a
      // tap by whatever is underneath — a menu opening and the thing behind it
      // also activating is the classic long-press double-fire.
      p.claim = "menu";

      const el = (p.target as Element | null) ?? document.elementFromPoint(p.x, p.y);
      // Ours is the menu. Silence the primitive's own timer so it cannot
      // re-open the same menu 200ms later against a stale target.
      cancelNativeLongPress(p);
      el?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: p.x,
          clientY: p.y,
          button: 2,
          buttons: 2,
        }),
      );
    }, LONG_PRESS_MS);
  };

  const onMove = (e: PointerEvent) => {
    // Never react to our own synthetic move — see `cancelNativeLongPress`.
    if (!e.isTrusted || armedId !== e.pointerId) return;
    const p = live.get(e.pointerId);
    if (!p) return;
    // Either the press moved, or a stationary gesture declared itself. Both
    // end the candidacy; neither can be inferred from the other.
    if (p.travel > CLAIM_SLOP_PX || (p.claim && OWNS_THE_HOLD.has(p.claim))) {
      // DISARM FIRST. The cancel dispatches an event that re-enters this
      // handler, and re-entering while still armed is the recursion.
      disarm();
      cancelNativeLongPress(p);
    }
  };

  const opts = { capture: true, passive: true } as const;
  window.addEventListener("pointerdown", onDown, opts);
  window.addEventListener("pointermove", onMove, opts);
  window.addEventListener("pointerup", disarm, opts);
  window.addEventListener("pointercancel", disarm, opts);
  return () => {
    disarm();
    window.removeEventListener("pointerdown", onDown, opts);
    window.removeEventListener("pointermove", onMove, opts);
    window.removeEventListener("pointerup", disarm, opts);
    window.removeEventListener("pointercancel", disarm, opts);
  };
}

// ── Two fingers undo, three redo — ONE recognizer for the whole app ──────────

/**
 * Longer than this, first finger down to last finger up, and it was a hold.
 *
 * Was 260ms, which is what a tap takes when you measure yourself deliberately
 * and not what one takes in traffic. Two fingers do not land or leave together,
 * the window spans BOTH, and on a busy frame the events themselves arrive late
 * — a perfectly good tap was being discarded as a hold. There is nothing to
 * collide with out here: the long press needs 500ms AND a single finger, so a
 * two-finger gesture can never be mistaken for one.
 */
const TAP_MS = 400;
/** Travel, px, that still counts as "did not move". */
const TAP_SLOP = 14;

/**
 * THE UNDO TAP, and it belongs here rather than on a surface.
 *
 * It used to live inside `useMultiTouch`, which every surface mounts its own
 * copy of. Two consequences, both bad and both reported:
 *
 *   · it only existed where a surface had bothered to pass `onTap` — which was
 *     the stage, and nowhere else. Editing pen nodes, trimming in the timeline,
 *     working in a panel: no undo gesture at all.
 *   · where surfaces NEST — a scroller inside the stage, a panel inside a
 *     zoomable region — both copies saw the same two fingers and both fired,
 *     so one tap undid twice. That is the "it repeats" bug, and it is not
 *     fixable inside a per-surface hook: no instance can know another instance
 *     also heard the gesture.
 *
 * One recognizer on the window has neither problem by construction. It also
 * gets the whole app for free — every panel, every overlay, every surface
 * written next year.
 *
 * It counts the MOST fingers that were down at once rather than the number at
 * release: lifting is never simultaneous, and counting at the end reads every
 * three-finger tap as a two.
 */
export function startMultiFingerTaps(handlers: {
  onUndo: () => void;
  onRedo: () => void;
}): () => void {
  if (typeof window === "undefined") return () => {};

  /**
   * The recognizer keeps its OWN set of fingers rather than counting the
   * arbiter's table, and that is not duplication — it is the difference
   * between working and not.
   *
   * Deriving the count from `live` made the gesture depend on two things it
   * should not: which window listener the browser happens to call first, and
   * whether any unrelated stale entry is sitting in the table. One stale touch
   * pointer made the FIRST finger of every tap look like a second, so the
   * gesture's start time was never recorded and every tap thereafter measured
   * as hours long and was discarded. A recognizer that can be wedged for the
   * session by one leaked entry is not a recognizer.
   *
   * `live` is still the authority on CLAIM and TRAVEL — the questions it
   * genuinely owns, and which no local copy could answer.
   */
  const down = new Set<number>();
  let fingers = 0;
  let startedAt = 0;
  let spoiled = false;

  const reset = () => {
    down.clear();
    fingers = 0;
    startedAt = 0;
    spoiled = false;
  };

  const onDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    if (down.size === 0) {
      startedAt = performance.now();
      spoiled = false;
      fingers = 0;
    }
    down.add(e.pointerId);
    // The MOST fingers down at once, not the count at release: lifting is
    // never simultaneous, so counting at the end reads every three-finger tap
    // as a two.
    fingers = Math.max(fingers, down.size);
    // Text fields own their own undo, and the platform's is the right one
    // there.
    const el = e.target as Element | null;
    if (el?.closest?.("input,textarea,[contenteditable='true']")) spoiled = true;
  };

  const onUp = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    if (!down.delete(e.pointerId)) return;
    // The gesture is only over when the last finger leaves.
    if (down.size > 0) return;
    // Read everything BEFORE resetting. An earlier version reset first and
    // then tested `spoiled`, which by then was always false — so a pinch that
    // had already committed could still fire an undo on release.
    const took = performance.now() - startedAt;
    const n = fingers;
    const bad = spoiled;
    reset();
    if (bad || n < 2 || took > TAP_MS) return;
    if (!usePointerAuthority.getState().tapUndo) return;
    if (n === 2) handlers.onUndo();
    else handlers.onRedo();
  };

  /*
   * Any COMMITMENT by a continuous gesture spoils the tap — a pinch that began,
   * a pan, a drag, a long-press menu.
   *
   * `"multi"` is the one claim that does not, and the exception is the point.
   * It means only "more than one finger is down", which is true of a two-finger
   * tap by definition — treating it as a commitment would spoil every tap the
   * instant the second finger landed and delete undo-by-tap outright. The two
   * multi-finger gestures are still competing at that moment, and this is the
   * recognizer for one of them.
   *
   * What settles it between them is what always settles a continuous gesture:
   * movement. Past `TAP_SLOP` this was a pinch; under it, released inside
   * `TAP_MS`, it was a tap. Exactly one of the two can win.
   */
  const onMove = (e: PointerEvent) => {
    if (!e.isTrusted || e.pointerType !== "touch" || spoiled || !down.has(e.pointerId)) return;
    const p = live.get(e.pointerId);
    if (p && ((p.claim && p.claim !== "multi") || p.travel > TAP_SLOP)) spoiled = true;
  };

  const opts = { capture: true, passive: true } as const;
  window.addEventListener("pointerdown", onDown, opts);
  window.addEventListener("pointermove", onMove, opts);
  window.addEventListener("pointerup", onUp, opts);
  window.addEventListener("pointercancel", onUp, opts);
  return () => {
    window.removeEventListener("pointerdown", onDown, opts);
    window.removeEventListener("pointermove", onMove, opts);
    window.removeEventListener("pointerup", onUp, opts);
    window.removeEventListener("pointercancel", onUp, opts);
    reset();
  };
}
