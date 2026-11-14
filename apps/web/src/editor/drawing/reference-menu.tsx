"use client";

import * as React from "react";
import { Focus } from "lucide-react";
import { isReferenced, referenceNoun, type PaintReference } from "@solomotion/core";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { useDrawing } from "./drawing-store";

/**
 * "USE AS REFERENCE", wherever you are pointing at the thing.
 *
 * A reference is chosen by pointing at artwork, not by opening a picker — you
 * are already looking at the layer when you decide, and a picker would be a
 * second list of the same layers the panel beside it is showing. So this is one
 * menu item, and every surface that can right-click a layer gets it: the shared
 * clip menu (stage, timeline, layers panel), and the track header.
 *
 * It TOGGLES, and it says which way it is going, because the same gesture has
 * to take a reference off again — a menu that can only add is a menu you have
 * to leave to undo.
 */
export function ReferenceMenuItem({
  target,
  targets,
}: {
  target?: PaintReference | null;
  /** A multi-selection. One item, one verb, applied to all of them. */
  targets?: PaintReference[];
}) {
  const refs = useDrawing((s) => s.scope.refs);
  const toggleRef = useDrawing((s) => s.toggleRef);
  const list = targets ?? (target ? [target] : []);
  if (list.length === 0) return null;
  // Already-referenced when EVERY one is: the item then offers the way out, so
  // one gesture is always the opposite of the last one.
  const on = list.every((t) => isReferenced(refs, t));
  // The noun comes from the SOURCE REGISTRY, so a new kind of referenceable
  // thing reads correctly in this menu without editing this file.
  const noun = list.length > 1 ? `${list.length} layers` : `this ${referenceNoun(list[0]!.kind)}`;
  const verb = list.length > 1 ? noun : referenceNoun(list[0]!.kind);
  return (
    <ContextMenuItem
      onClick={() => {
        // Toggling each would flip a mixed selection into the inverse of
        // itself. The verb the label promises is the verb every item gets.
        for (const t of list) {
          if (isReferenced(useDrawing.getState().scope.refs, t) === on) toggleRef(t);
        }
      }}
    >
      <Focus className={cn(on && "text-primary")} />
      {on ? `Stop referencing ${noun}` : `Use ${verb} as reference`}
    </ContextMenuItem>
  );
}

/**
 * THE REFERENCE BADGE — the same mark, everywhere the referenced thing appears.
 *
 * One icon and one colour for one fact, on the timeline clip, the layer row and
 * the track header, so recognising it is learned once. It is `aria-hidden` and
 * inert: the badge REPORTS the state, the right-click menu changes it, and a
 * tiny click target that silently unbinds a reference is a way to lose one
 * without knowing you did.
 */
export function ReferenceBadge({ on, className }: { on: boolean; className?: string }) {
  if (!on) return null;
  return (
    <Focus
      aria-hidden
      className={cn("size-3 shrink-0 text-primary", className)}
    />
  );
}

/**
 * Is this clip/track/group referenced right now?
 *
 * It selects the BOOLEAN, not the list. A timeline can hold hundreds of clip
 * rows and every one of them asks this; selecting `scope.refs` would give each
 * of them a new array reference the moment any reference anywhere changed, and
 * re-render the whole lane for a badge on one clip. Selecting the answer means
 * zustand's own equality check stops the render at the ninety-nine rows whose
 * answer did not move.
 */
export function useIsReferenced(target: PaintReference | null): boolean {
  return useDrawing((s) => (target ? isReferenced(s.scope.refs, target) : false));
}
