/**
 * SPACE-to-pan (Figma/Photoshop): holding Space turns the canvas into a
 * temporary hand tool WITHOUT switching the active tool — release and you're
 * exactly where you were. A quick tap still plays/pauses. This tiny singleton
 * is the shared truth between the global key handler (which owns press/release
 * and the tap→play decision) and the Stage (which owns the drag + cursor).
 */
let held = false;
let downAt = 0;
let dragged = false;
const subscribers = new Set<() => void>();

function notify() {
  for (const fn of subscribers) fn();
}

export const spacePan = {
  get held() {
    return held;
  },
  /** Space went down (first press, not a key-repeat). */
  press() {
    if (held) return;
    held = true;
    downAt = Date.now();
    dragged = false;
    notify();
  },
  /** A pan drag happened — so the release is a pan, never a play/pause tap. */
  markDragged() {
    dragged = true;
  },
  /** Space came up. Returns true when it was a quick TAP (caller plays/pauses). */
  release(): boolean {
    if (!held) return false;
    held = false;
    const tap = Date.now() - downAt < 220 && !dragged;
    notify();
    return tap;
  },
  /** Fired on window blur etc. — drop the hold without a tap. */
  cancel() {
    if (!held) return;
    held = false;
    notify();
  },
  subscribe(fn: () => void) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  },
};
