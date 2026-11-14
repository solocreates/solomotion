"use client";

import * as React from "react";
import { useSession, type WorkspacePanel } from "./session";

export type { WorkspacePanel };

/**
 * Panel focus — the ONE way a workspace surface claims keyboard context.
 *
 * `session.focusedPanel` routes every focus-aware shortcut (arrow keys, S for
 * snapping, ⌘A select-all, E for easing). A panel marks itself focused on
 * pointer-down via this hook's `bind` props; nesting works naturally because
 * capture-phase handlers fire outermost-first, so the innermost panel wins
 * (the curves panel inside the timeline ends up "curves", not "timeline").
 *
 * The flipbook SHEET is its own surface rather than another "timeline", because
 * one shortcut genuinely means two things depending on which of them you are
 * in: on the sheet a selection is FRAMES, on the canvas it is ARTWORK, and the
 * ids are identical (see `flipbookCellsInSelection`).
 *
 * Adding a focus-aware surface = spread `usePanelFocus("…").bind` on its root
 * and switch on the new value where a shortcut should behave differently.
 */


export function usePanelFocus(panel: WorkspacePanel): {
  bind: { onPointerDownCapture: () => void };
  focused: boolean;
} {
  const focused = useSession((s) => s.focusedPanel === panel);
  const bind = React.useMemo(
    () => ({ onPointerDownCapture: () => useSession.getState().setFocusedPanel(panel) }),
    [panel],
  );
  return { bind, focused };
}
