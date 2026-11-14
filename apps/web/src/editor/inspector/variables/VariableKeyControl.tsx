"use client";

import * as React from "react";
import { VARIABLE_TRACK_KEY, type Variable } from "@solomotion/core";
import { ChevronsLeft, ChevronsRight, Diamond, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { useSession, useParkedPlayhead } from "../../state/session";
import { useDocStore } from "../../state/document-context";
import { NavButton } from "../keyframe-controls";
import {
  adjacentVariableKey,
  clearVariableKeyframes,
  isVariableAnimated,
  toggleVariableKeyframe,
  variableHasKeyAt,
} from "./variable-editing";

/**
 * The ‹ ◆ › keyframe cluster for a document VARIABLE — the same affordance every
 * inspector row has (jump prev · toggle key · jump next, right-click for more),
 * but scoped to a doc-global variable track at the raw playhead. It reuses the
 * shared `NavButton` and the core keyframe engine through `variable-editing`, so
 * a variable animates through the exact primitives clips do — no parallel logic.
 * Hidden until animated (or the row is hovered) to stay quiet, like KeyControl.
 */
export function VariableKeyControl({ variable }: { variable: Variable }) {
  const store = useDocStore();
  const playheadMs = useParkedPlayhead();

  const active = variableHasKeyAt(variable, playheadMs);
  const animated = isVariableAnimated(variable);
  const prevTime = adjacentVariableKey(variable, playheadMs, "prev");
  const nextTime = adjacentVariableKey(variable, playheadMs, "next");

  const track = variable.keyframes?.find((t) => t.property === VARIABLE_TRACK_KEY);
  const firstKey = track && track.keys.length > 0 ? track.keys[0]!.timeMs : null;
  const lastKey = track && track.keys.length > 0 ? track.keys[track.keys.length - 1]!.timeMs : null;

  const mutate = (label: string, fn: (v: Variable) => void) =>
    store.update(label, (d) => {
      const v = d.variables.find((x) => x.id === variable.id);
      if (v) fn(v);
    });

  const toggle = () =>
    mutate(active ? "Remove variable keyframe" : "Add variable keyframe", (v) =>
      toggleVariableKeyframe(v, playheadMs),
    );
  const reset = () =>
    mutate("Reset variable keyframes", (v) => clearVariableKeyframes(v, playheadMs));
  const jump = (t: number | null) => {
    if (t === null) return;
    const s = useSession.getState();
    s.setPlaying(false);
    s.setPlayhead(t);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "flex items-center",
            animated
              ? "opacity-100"
              : "opacity-0 transition-opacity group-hover/var:opacity-100 group-hover/row:opacity-100",
          )}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <NavButton dir="prev" enabled={prevTime !== null} onClick={() => jump(prevTime)} />
          <button
            type="button"
            aria-label={active ? "Remove keyframe" : "Add keyframe"}
            title="Keyframe at playhead · right-click for options"
            onClick={toggle}
            className={cn(
              "flex size-5 items-center justify-center rounded transition-colors",
              active
                ? "text-primary"
                : animated
                  ? "text-primary/60 hover:text-primary"
                  : "text-muted-foreground/50 hover:text-foreground",
            )}
          >
            <Diamond className={cn("size-2.5", active && "fill-primary")} strokeWidth={2.5} />
          </button>
          <NavButton dir="next" enabled={nextTime !== null} onClick={() => jump(nextTime)} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={toggle}>
          <Diamond /> {active ? "Remove keyframe here" : "Add keyframe here"}
        </ContextMenuItem>
        <ContextMenuItem disabled={firstKey === null} onClick={() => jump(firstKey)}>
          <ChevronsLeft /> Jump to first key
        </ContextMenuItem>
        <ContextMenuItem disabled={lastKey === null} onClick={() => jump(lastKey)}>
          <ChevronsRight /> Jump to last key
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!animated} onClick={reset} className="text-destructive focus:text-destructive">
          <Trash2 /> Reset keyframes
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
