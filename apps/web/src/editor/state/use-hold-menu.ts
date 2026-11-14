import * as React from "react";

/**
 * The ONE workspace-wide "open my submenu" gesture. Press-and-hold OR
 * right-click any toolbar button — canvas tools, the align/snap/ruler bar,
 * timeline tools — and its flyout/popover opens; a plain click still does the
 * button's main job. Every surface spreads the SAME `bind`, so the trigger is
 * identical everywhere and there's a single place to tune it.
 *
 * `bind` carries:
 *   - the hold timer (primary pointer-down → `open()` after `ms`),
 *   - `onContextMenu` (right-click → `open()`),
 *   - `data-hold-menu` — a marker the stage's context-menu capture handler
 *     checks so it never swallows the right-click before the button sees it
 *     (chrome that floats over the canvas would otherwise lose right-click).
 *
 * `guard()` returns true exactly once right after a hold opened the menu, so the
 * click that trails the release can be skipped:
 *   onClick={(e) => { if (guard()) return; doTheMainThing(); }}
 */
export function useHoldMenu(open: () => void, ms = 380) {
  const consumed = React.useRef(false);
  const timer = React.useRef<number | null>(null);
  const cancel = React.useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  React.useEffect(() => cancel, [cancel]);

  const bind = {
    "data-hold-menu": "",
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return; // primary only; right-click has its own path
      consumed.current = false;
      cancel();
      timer.current = window.setTimeout(() => {
        consumed.current = true;
        open();
      }, ms);
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      open();
    },
  };

  const guard = () => {
    if (consumed.current) {
      consumed.current = false;
      return true;
    }
    return false;
  };

  return { bind, guard, cancel };
}
