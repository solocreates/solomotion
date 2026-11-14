"use client";

import * as React from "react";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { useBoardStore } from "./board-store";
import { findOrCreateOwnerGraph } from "./graph-actions";
import { NodeBoard } from "./NodeBoard";

/**
 * Resolves the board's SELECTION-DRIVEN graph: the primary selected layer owns
 * its own node tree, a selected frame owns one, and with nothing selected the
 * document-level board shows. Switching selection while the board is open swaps
 * the graph live (find-or-create), so a layer's expressions/effects always live
 * with that layer — the "each selected layer has its own node tree" model.
 */
export function NodeBoardHost() {
  const store = useDocStore();
  const doc = useDoc();
  const clipPrimary = useSession((s) => s.selectedClipIds[s.selectedClipIds.length - 1] ?? null);
  const framePrimary = useSession((s) => s.selectedFrameIds[s.selectedFrameIds.length - 1] ?? null);
  const ownerId = clipPrimary ?? framePrimary ?? null;

  const label = React.useMemo(() => {
    if (clipPrimary) {
      for (const t of doc.tracks) for (const c of t.clips) if (c.id === clipPrimary) return c.name || "Layer";
      return "Layer";
    }
    if (framePrimary) return doc.frames.find((f) => f.id === framePrimary)?.name ?? "Frame";
    return "Global";
  }, [clipPrimary, framePrimary, doc]);

  // A real selection change (owner flips) ends any driver "open at node" pin, so
  // the board returns to following selection. Skip the first run so opening the
  // window straight onto a pinned node (focusOnNode) isn't immediately unpinned.
  const firstRun = React.useRef(true);
  React.useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    useBoardStore.getState().clearFocus();
  }, [ownerId]);

  React.useEffect(() => {
    // A focus pin owns the active graph — don't stomp it with the selection graph.
    if (useBoardStore.getState().focus) return;
    const id = findOrCreateOwnerGraph(store, ownerId, label);
    useBoardStore.getState().setActiveGraph(id);
  }, [ownerId, store, label]);

  const activeGraphId = useBoardStore((s) => s.activeGraphId);
  if (!activeGraphId) return null;
  return <NodeBoard graphId={activeGraphId} ownerLabel={label} scope={ownerId ? (clipPrimary ? "layer" : "frame") : "global"} />;
}
