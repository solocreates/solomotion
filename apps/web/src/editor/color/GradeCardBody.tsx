"use client";

import * as React from "react";
import {
  compileGrade,
  gradeIsIdentity,
  isNeutralKey,
  type LayerEffect,
  type VisualClip,
} from "@solomotion/core";
import { ArrowRight, Circle, Palette, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useColorStore } from "./color-store";

/**
 * THE GRADE CARD, IN THE LAYER'S EFFECT STACK.
 *
 * Every other card in that list is a set of sliders. This one is a doorway, and
 * it has to look like one — a row of pills reading the chain left to right, and
 * a button that opens the page. A generated field list would have shown exactly
 * one row ("Mix") and said nothing about the four correctors underneath it.
 *
 * It stays an ORDINARY CARD in every other respect: draggable, bypassable,
 * deletable, keyframable, copyable. That is the whole point of the card being
 * where the grade lives — its position in the stack is the answer to "before or
 * after the glow?", and a card you cannot drag could not answer it.
 *
 * And it is why the page needs no tab strip of its own: a layer with two grades
 * has two cards here, in order, already sortable. A second switcher would be a
 * second place to say the same thing, and the two would disagree the first time
 * somebody reordered one of them.
 */
export function GradeCardBody({
  clip,
  effect,
}: {
  clip: VisualClip;
  effect: Extract<LayerEffect, { type: "grade" }>;
}) {
  const setTarget = useColorStore((s) => s.setTarget);
  const setOpen = useColorStore((s) => s.setOpen);
  const activeCard = useColorStore((s) => s.cardId);

  const graph = effect.graph;
  const plan = React.useMemo(() => compileGrade(graph), [graph]);
  const idle = gradeIsIdentity(graph);

  // The chain, in evaluation order — the plan's order, so what the pills say is
  // what the renderer does rather than what the node positions suggest.
  const chain = plan.steps
    .map((s) => s.node)
    .filter((n) => n.kind === "corrector") as Array<Extract<(typeof graph.nodes)[number], { kind: "corrector" }>>;

  const open = () => {
    setTarget(clip.id, effect.id);
    setOpen(true);
  };

  return (
    <div className="space-y-1.5">
      {idle ? (
        <p className="text-[11px] text-muted-foreground">Nothing dialled yet.</p>
      ) : (
        // A chain can be longer than the panel. It scrolls sideways rather than
        // wrapping, because a chain that wraps stops reading as an order.
        <ScrollArea className="w-full">
          <div className="flex items-center gap-1 pb-1.5">
            {chain.map((node, i) => (
              <React.Fragment key={node.id}>
                {i > 0 && <ArrowRight className="size-3 shrink-0 text-muted-foreground/60" />}
                <button
                  type="button"
                  onClick={open}
                  className={cn(
                    "flex h-6 shrink-0 items-center gap-1 rounded border px-1.5 text-[10px] transition-colors",
                    node.enabled
                      ? "border-border/70 bg-muted/40 hover:border-primary/60"
                      : "border-dashed border-border/60 text-muted-foreground line-through",
                  )}
                  title={`${node.effects.length} correction${node.effects.length === 1 ? "" : "s"}`}
                >
                  {!isNeutralKey(node.key) && <Circle className="size-2.5 text-primary" />}
                  <span className="max-w-24 truncate">{node.name || `Node ${i + 1}`}</span>
                  {node.effects.length > 1 && (
                    <span className="tabular-nums text-muted-foreground">{node.effects.length}</span>
                  )}
                </button>
              </React.Fragment>
            ))}
            {chain.length === 0 && <span className="text-[11px] text-muted-foreground">No correctors.</span>}
          </div>
        </ScrollArea>
      )}

      <Button
        variant={activeCard === effect.id ? "secondary" : "outline"}
        size="sm"
        className="h-7 w-full text-[11px]"
        onClick={open}
      >
        <Palette className="mr-1 size-3" />
        {idle ? "Start grading" : "Open in Color"}
      </Button>

      {plan.orphans.length > 0 && (
        <p className="flex items-center gap-1 text-[10px] text-warning">
          <Sparkles className="size-3" />
          {plan.orphans.length} node{plan.orphans.length === 1 ? "" : "s"} not reaching the output
        </p>
      )}
    </div>
  );
}
