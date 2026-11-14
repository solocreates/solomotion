"use client";

/**
 * SPRING-LOADED HOVER — hold a drag still over something shut, and it opens.
 *
 * The gesture every file manager has had for thirty years and every layers
 * panel needs: you are carrying a layer, the group you want is collapsed, and
 * the alternative is to drop what you are holding somewhere harmless, open the
 * group, pick the layer back up. Nobody does that. They give up and use the
 * timeline instead.
 *
 * ## Why it is a module and not three timers
 *
 * Because it is the same gesture over a group, a frame, a nested comp, a page
 * and the audio section, and those live in different components. Written per
 * surface it would be five timers with five delays, four of which would drift
 * and one of which would leak. Written here it is one delay, one cancellation
 * rule, and one place to change how long "held" means.
 *
 * ## The contract
 *
 * The DRAG feeds it what is under the pointer; the SURFACE declares what is
 * openable. A surface opts in with one attribute — `data-spring-load="<key>"` —
 * so a panel that is not even aware of this file joins by tagging its rows, and
 * the drag never needs to know which kinds of row exist. `keyUnderPoint` is the
 * shared reader; the key is the caller's own vocabulary.
 *
 * ## The rules that make it feel right rather than twitchy
 *
 *   ONCE PER VISIT   opening fires once, then stays quiet until the pointer
 *                    leaves and comes back. Otherwise a hover that outlasts the
 *                    delay re-fires forever and a toggle flickers.
 *   MOVEMENT IS NOT  the timer restarts only when the KEY changes, not on every
 *   IMPATIENCE       pixel — a hand is never perfectly still, and restarting on
 *                    movement means the gesture can only be performed by a
 *                    mouse on a desk.
 *   LEAVING CANCELS  including leaving to nothing, so sliding off a group on
 *                    the way somewhere else never opens it a moment later.
 */

/** How long the pointer rests before a container opens. */
export const SPRING_LOAD_MS = 550;

export interface SpringLoad {
  /** Call on every pointer move with the key under the pointer (null = none). */
  hover: (key: string | null) => void;
  /** Cancel any pending open — the drag ended, or was aborted. */
  end: () => void;
}

export function createSpringLoad(
  open: (key: string) => void,
  delayMs: number = SPRING_LOAD_MS,
): SpringLoad {
  let current: string | null = null;
  let timer: number | null = null;
  /** Keys already opened this visit — cleared when the pointer leaves them. */
  let fired: string | null = null;

  const clear = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };

  return {
    hover(key) {
      if (key === current) return;
      current = key;
      fired = key === fired ? fired : null;
      clear();
      if (key === null || key === fired) return;
      timer = window.setTimeout(() => {
        timer = null;
        fired = key;
        open(key);
      }, delayMs);
    },
    end() {
      clear();
      current = null;
      fired = null;
    },
  };
}

/**
 * The spring-load key under a screen point, or null.
 *
 * Reads the DOM rather than a row model on purpose: the pointer may be over a
 * PAGE while the drag belongs to the layers list, and those are different
 * components that should not have to know about each other to cooperate. One
 * attribute, any surface, including ones written later.
 */
export function keyUnderPoint(clientX: number, clientY: number): string | null {
  const el = document.elementFromPoint(clientX, clientY);
  const host = el?.closest<HTMLElement>("[data-spring-load]");
  return host?.dataset.springLoad ?? null;
}
