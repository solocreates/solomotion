"use client";

import { isClaimed, subscribePointerEnd, CLAIM_SLOP_PX } from "./pointer-gestures";

/**
 * A STYLUS AND A FINGER CLICK EVERYTHING — one listener, the whole app.
 *
 * ## The bug this closes
 *
 * An Apple Pencil could not press a settings tab, a dialog's close button, a
 * switch, a rail button or a menu item. Not one broken control: a whole class
 * of them, on one class of device, and the list grew every time somebody
 * looked.
 *
 * The cause is a dependency on a LEGACY event. Radix — and a great deal of
 * mouse-era web code, including ours — activates from the browser's
 * COMPATIBILITY CLICK: the synthetic `click` emitted after a touch or pen
 * sequence so that pre-Pointer-Events code keeps working. A mouse always
 * produces one. Touch and pen produce it at the platform's discretion, and it
 * goes missing whenever anything upstream calls `preventDefault`, whenever a
 * layer moves or mounts under the pointer between press and release, and
 * whenever the surface was portalled in on the same gesture. When it goes
 * missing, the control has NO activation path at all.
 *
 * ## Why this is one file and not a wrapper per control
 *
 * The previous attempt was two: a `useActivation` bind object composed into
 * every menu-item wrapper, and a `usePenActivation` hook mounted on four
 * floating surfaces. Both are the same shape — a list of places that have
 * remembered — and the list is the bug. Everything not on it stayed broken,
 * which is exactly what the tab strips, the switches and the rail buttons
 * were. Growing the list is managing the problem, not closing it.
 *
 * ONE delegated listener on the window closes it. It covers controls that do
 * not exist yet, controls rendered by plugins, and controls written by someone
 * who has never heard of this file. There is nothing to remember, which is the
 * only property that survives a codebase this size.
 *
 * ## The four conditions
 *
 * A release activates only when it was unambiguously a press ON that control:
 *
 *   1. the pointer is a finger or a stylus — a mouse already works, and
 *      leaving it strictly alone means this can never regress desktop input;
 *   2. the press and the release resolve to the SAME activatable element;
 *   3. the pointer never travelled and was never CLAIMED — a drag, a scroll, a
 *      pinch or a long-press menu is not a click. Checked while the pointer is
 *      MOVING, not at release: by release the arbiter has already retired it,
 *      and a retired pointer answers "unclaimed, zero travel" to everything;
 *   4. the control is not disabled and has not opted out.
 *
 * ## The double-fire, and how it is avoided without a heuristic
 *
 * If the compatibility click does arrive, a naive fix activates twice.
 * `isTrusted` separates them exactly — a click we synthesise reports `false`,
 * one the browser generated reports `true` — so a trusted click arriving
 * within `SUPPRESS_MS` of ours is the duplicate and is swallowed in capture,
 * before any handler sees it. No distance heuristics, no target matching.
 */

/** A trusted mouse event this soon after ours is the browser's duplicate. */
const SUPPRESS_MS = 700;

/**
 * THE WHOLE COMPATIBILITY SEQUENCE, not just the click.
 *
 * Synthesising `click` alone fixed menus and left the SETTINGS TABS dead under
 * a Pencil, which looked like a Radix bug and was not. Radix's `Tabs.Trigger`
 * switches on **`mousedown`** — deliberately, so a tab feels instant — and a
 * great deal of other mouse-era code listens on `mousedown` or `mouseup` too.
 * A fix that only replays the last event of the sequence only fixes the
 * controls that happen to listen for that one.
 *
 * What actually went missing is the browser's whole compatibility burst, so
 * that is what gets replayed, in the order and with the coordinates a real
 * pointer would have produced. Anything listening anywhere in the sequence
 * works, including code written years before this file and code written after
 * it.
 */
const MOUSE_SEQUENCE = ["mousedown", "mouseup", "click"] as const;

/**
 * What counts as activatable.
 *
 * ARIA roles rather than component names, so this describes the platform
 * rather than our component library — a plugin's `role="menuitem"` works, and
 * a shadcn primitive that changes its internals cannot fall off the list.
 */
const ACTIVATABLE = [
  "button",
  "summary",
  "a[href]",
  "label[for]",
  '[role="button"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="treeitem"]',
  "[data-activate]",
].join(",");

/**
 * Opt out where a press is genuinely not a click: a control that acts on
 * `pointerdown` (and would therefore fire twice), or one whose release is part
 * of a longer gesture. Deliberately an attribute rather than a list here — the
 * component that knows is the component that says so.
 */
const OPT_OUT = "[data-no-activate]";

const activatableFrom = (target: EventTarget | null): HTMLElement | null => {
  const el = target as Element | null;
  if (!el || typeof el.closest !== "function") return null;
  const hit = el.closest(ACTIVATABLE) as HTMLElement | null;
  if (!hit || hit.closest(OPT_OUT)) return null;
  if (hit.hasAttribute("disabled") || hit.getAttribute("aria-disabled") === "true") return null;
  return hit;
};

export function startDirectActivation(): () => void {
  if (typeof window === "undefined") return () => {};

  /**
   * The presses still eligible to become activations: where each one went
   * down, and on what.
   *
   * A press is REMOVED the moment it becomes a gesture — travelled past the
   * slop, or claimed by a drag, a pinch or a long press. Doing it here, on
   * move, rather than asking the arbiter at release, is not a style choice: by
   * release the tracker has already deleted the pointer from its table, so
   * `isClaimed` and `pointerTravel` both answer for a pointer that no longer
   * exists — "unclaimed, zero travel", i.e. yes to everything. Both listeners
   * are window-capture, so which runs first is registration order, and no
   * correctness argument should rest on that. Watching the move settles it
   * without depending on order at all.
   */
  const pressed = new Map<number, { el: HTMLElement; x: number; y: number }>();
  /** The control we last activated, and when — so the browser's trailing
   *  compatibility click can be recognised as the duplicate of THAT click and
   *  nothing else. Time alone would also swallow an unrelated real click that
   *  happened to land inside the window. */
  let synthetic: { el: HTMLElement; at: number } | null = null;

  const isDirect = (t: string) => t === "touch" || t === "pen";

  const onDown = (e: PointerEvent) => {
    if (!isDirect(e.pointerType)) return;
    if (e.button !== 0 && e.button !== -1) return;
    const el = activatableFrom(e.target);
    if (el) pressed.set(e.pointerId, { el, x: e.clientX, y: e.clientY });
  };

  const onMove = (e: PointerEvent) => {
    const p = pressed.get(e.pointerId);
    if (!p) return;
    // Travelled, or something continuous took it — a drag, a scroll, a pinch,
    // a long-press menu. Either way this is no longer a tap. The arbiter is
    // still the authority on "claimed"; this only reads it while it is true.
    if (
      Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLAIM_SLOP_PX ||
      isClaimed(e.pointerId)
    ) {
      pressed.delete(e.pointerId);
    }
  };

  const onUp = (e: PointerEvent) => {
    const from = pressed.get(e.pointerId)?.el;
    pressed.delete(e.pointerId);
    if (!from || !isDirect(e.pointerType)) return;
    // The release must land on the same control. The event's OWN target,
    // never `elementFromPoint` — that returns null for a point outside the
    // viewport or under a layer that declines hits, and a null there reads as
    // "not over the control" and silently swallows the activation.
    if (activatableFrom(e.target) !== from) return;
    // Detached between press and release (a menu that re-rendered): clicking a
    // node no longer in the document does nothing useful and can resurrect a
    // stale handler.
    if (!from.isConnected) return;

    synthetic = { el: from, at: Date.now() };
    for (const type of MOUSE_SEQUENCE) {
      from.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          detail: type === "mousedown" ? 1 : 1,
          button: 0,
          buttons: type === "mousedown" ? 1 : 0,
          clientX: e.clientX,
          clientY: e.clientY,
        }),
      );
      // Focus lands between press and release for a real pointer, and several
      // controls (a tab strip in automatic-activation mode among them) hang
      // behaviour off it.
      if (type === "mousedown") from.focus?.({ preventScroll: true });
    }
  };

  const onCancel = (e: PointerEvent) => {
    pressed.delete(e.pointerId);
  };

  /*
   * A SECOND FINGER RETIRES EVERY CANDIDATE PRESS, INSTANTLY.
   *
   * `onMove` above already drops a press once it becomes a gesture — but only
   * on MOVE, and the finger this matters for is the one that does not move. Put
   * two fingers on the stage to pinch, or tap two fingers to undo, and the
   * anchoring finger travelled nothing and was claimed by nothing, so it stayed
   * a perfect tap candidate all the way to the release and then activated
   * whatever was underneath it: a layer selected, a clip focused, a keyframe
   * picked, seemingly at random. That is one delegated listener away from being
   * true of every surface in the app at once, which is why it belongs here and
   * not in the stage, the timeline, the curve editor and the sheet separately.
   *
   * `pressed.clear()` rather than deleting one id: EVERY press live at that
   * moment is part of the multi-finger gesture now, including the one that
   * started it.
   *
   * Subscribing rather than asking `multiFingerDown()` from `onDown` is
   * deliberate and is the same trap this file already documents: both are
   * window-capture listeners, so which sees the second finger first is
   * registration order, and no correctness argument should rest on that. The
   * arbiter publishes AFTER it has counted.
   */
  const offEnd = subscribePointerEnd((_id, reason) => {
    if (reason === "superseded") pressed.clear();
  });

  /**
   * Swallow the browser's trailing burst if it does arrive.
   *
   * `isTrusted` is the exact discriminator — ours reports `false`, the
   * browser's `true` — so no distance heuristics and no timers to tune. It
   * covers all three event types now, because we emit all three: suppressing
   * only the click would let a duplicate `mousedown` through, which is
   * precisely the event a tab strip acts on.
   *
   * `synthetic` is deliberately NOT cleared on the first suppression: the
   * burst is up to three events and they all belong to the same duplicate.
   */
  const onMouseCapture = (e: MouseEvent) => {
    if (!e.isTrusted) return; // ours — the control must see it
    const s = synthetic;
    if (!s || Date.now() - s.at > SUPPRESS_MS) return;
    // Same control, or inside it. A trusted event somewhere else in that window
    // is a real one by a real pointer and must go through.
    const t = e.target as Node | null;
    if (t !== s.el && !(t && s.el.contains(t))) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const opts = { capture: true, passive: true } as const;
  window.addEventListener("pointerdown", onDown, opts);
  window.addEventListener("pointermove", onMove, opts);
  window.addEventListener("pointerup", onUp, opts);
  window.addEventListener("pointercancel", onCancel, opts);
  // Capture on the window, so the duplicate is stopped before it reaches any
  // component's handler wherever that component was portalled to.
  for (const type of MOUSE_SEQUENCE) window.addEventListener(type, onMouseCapture, true);
  return () => {
    window.removeEventListener("pointerdown", onDown, opts);
    window.removeEventListener("pointermove", onMove, opts);
    window.removeEventListener("pointerup", onUp, opts);
    window.removeEventListener("pointercancel", onCancel, opts);
    for (const type of MOUSE_SEQUENCE) window.removeEventListener(type, onMouseCapture, true);
    offEnd();
    pressed.clear();
  };
}
