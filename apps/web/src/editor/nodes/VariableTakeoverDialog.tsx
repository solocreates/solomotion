"use client";

import * as React from "react";
import { parseDriverToken, type VariableWriteConflict } from "@solomotion/core";
import { Waypoints } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useBoardStore } from "./board-store";

/**
 * A VARIABLE HAS ONE OWNER, so wiring one that another graph already writes is a
 * choice, not an accident — and the choice is offered where it is made, at the
 * drop, instead of being refused with a toast.
 *
 * Three ways out, deliberately: take it (cutting the other wire, so that board
 * shows the loss rather than holding a wire that does nothing), go look at who
 * has it, or leave it alone.
 */
export function VariableTakeoverDialog({
  conflict,
  onForce,
  onCancel,
}: {
  conflict: VariableWriteConflict | null;
  onForce: () => void;
  onCancel: () => void;
}) {
  const focusOnNode = useBoardStore((s) => s.focusOnNode);
  if (!conflict) return null;
  const sink = parseDriverToken(conflict.token)?.sink ?? null;
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md gap-3" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-base">
            “{conflict.variableName}” is already driven
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{conflict.graphName}</span> writes this
            variable. A variable takes its value from one place, so connecting here means taking it
            over — the other graph’s wire is cut.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          {sink && (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto"
              onClick={() => {
                focusOnNode(conflict.graphId, sink.node);
                onCancel();
              }}
            >
              <Waypoints /> Show me who has it
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={onForce}>
            Take it over
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
