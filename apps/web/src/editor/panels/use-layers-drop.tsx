"use client";

import * as React from "react";
import { useDocStore } from "../state/document-context";
import { libraryDropAppliesTo } from "../library/apply-to-clip";
import { useSession } from "../state/session";

/**
 * The layers tree as a DROP SURFACE — the third one, and deliberately the same
 * shape as the other two.
 *
 * The tree had no preview at all: a drag over it published no surface, so
 * nothing lit up, and the release quietly walked the DOM for a row inside the
 * drag controller. Feedback that only exists after you let go is not feedback,
 * and a target the controller knows about but no surface owns is a rule living
 * in the wrong file. Now the panel answers for itself, exactly as the stage and
 * the timeline do: it says which row a drop would claim, and the same answer
 * both draws the highlight and performs the edit.
 *
 * The tree is a LIST, not a canvas, so the row under the cursor is a DOM
 * question — but the cost discipline is the stage's: one hit test per frame,
 * identity-stable when the row has not changed, and nothing subscribed at all
 * unless a drag is live.
 */
export function useLayersDropTarget(): string | null {
  const store = useDocStore();
  const drag = useSession((s) => s.libraryDrag);
  const over = useSession((s) => s.libraryDragPos?.over ?? null);
  const active = drag !== null && over === "layers";
  const [clipId, setClipId] = React.useState<string | null>(null);

  // Latest-value ref, never a dependency: `drag` changing identity mid-drag
  // must not tear the subscription down and blank the highlight for a frame
  // (the flicker the stage overlay had).
  const dragRef = React.useRef(drag);
  dragRef.current = drag;

  React.useEffect(() => {
    if (!active) {
      setClipId(null);
      return;
    }
    let raf = 0;
    let pending: { x: number; y: number } | null = null;

    const commit = (next: string | null) => setClipId((prev) => (prev === next ? prev : next));
    const flush = () => {
      raf = 0;
      if (!pending) return;
      commit(layerRowDropTarget(store.getState(), dragRef.current, pending.x, pending.y));
      pending = null;
    };

    const seed = useSession.getState().libraryDragPos;
    if (seed) commit(layerRowDropTarget(store.getState(), dragRef.current, seed.x, seed.y));

    const onMove = (e: PointerEvent) => {
      pending = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(flush);
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [active, store]);

  return clipId;
}

/**
 * The row a drop at this client point would claim — THE resolver, shared by the
 * highlight above and the commit in the panel. A row the item cannot modify
 * (a locked layer, a shape under a text template, anything under a transition)
 * resolves to null, so the tree can say "not here" before you let go.
 */
export function layerRowDropTarget(
  doc: ReturnType<ReturnType<typeof useDocStore>["getState"]>,
  drag: ReturnType<typeof useSession.getState>["libraryDrag"],
  x: number,
  y: number,
): string | null {
  if (!drag) return null;
  const row = document.elementFromPoint(x, y)?.closest("[data-clip-drop-id]");
  const id = row?.getAttribute("data-clip-drop-id");
  if (!id) return null;
  return libraryDropAppliesTo(doc, drag, id) ? id : null;
}
