"use client";

import { toast } from "@/lib/toast";
import { getDocStore } from "./document-context";
import { useSession } from "./session";

/**
 * UNDO AND REDO, once.
 *
 * There is one history gesture and it has five entry points — ⌘Z, the rail
 * buttons, the command palette, the app menu, and a two-finger tap on the
 * glass. Four of them called `store.undo()` directly and so ignored the UNDO
 * SCOPE: while the Brush Studio (or any other editor that owns state the
 * document store has no patches for) is focused, it takes the history over,
 * and only the keyboard path knew. Pressing the rail's undo button in the
 * Brush Studio therefore undid something in the DOCUMENT, somewhere off
 * screen, which is the worst possible failure for an undo button.
 *
 * So the scope resolution lives here and every entry point calls this. Adding
 * a sixth entry point is one import, and it cannot be the one that forgets.
 */
export function undoActive(): void {
  const scope = useSession.getState().undoScope;
  if (scope) {
    scope.undo();
    return;
  }
  // The person's undo — it steps around an agent working beside them.
  if (getDocStore()?.undoOwn() === "conflict") {
    toast.warning("Can't undo — the agent has since changed the same thing");
  }
}

export function redoActive(): void {
  const scope = useSession.getState().undoScope;
  if (scope) {
    scope.redo();
    return;
  }
  getDocStore()?.redo();
}
