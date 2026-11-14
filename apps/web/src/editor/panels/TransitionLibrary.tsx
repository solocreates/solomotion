"use client";

import * as React from "react";
import { TRANSITION_PRESETS, type TransitionCategory, type TransitionDef } from "@solomotion/core";
import { cn } from "@/lib/utils";
import { TransitionPreview, useIntroPlay } from "../ui/PosePreview";

/**
 * The transitions browser: cards whose preview shows the ACTUAL cut — two
 * panels crossing — rather than a generic icon. A transition is the one preset
 * family nobody can judge from a static thumbnail, so the preview IS the
 * product. It renders through the shared `TransitionPreview`, driven by the
 * same headless evaluator the canvas uses, and plays once on mount then rests
 * until hovered so an idle library costs nothing.
 */

/** Ordered so the browser reads from "safest" to "loudest". */
export const TRANSITION_CATEGORY_ORDER: TransitionCategory[] = [
  "dissolve",
  "wipe",
  "motion",
  "stylize",
];

export const TRANSITION_CATEGORY_LABEL: Record<TransitionCategory, string> = {
  dissolve: "Dissolves",
  wipe: "Wipes",
  motion: "Motion",
  stylize: "Stylised",
};

export function TransitionCard({
  def,
  favorited,
  onPointerDown,
  onMouseEnter,
  onMouseLeave,
}: {
  def: TransitionDef;
  favorited?: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onMouseEnter?: (e: React.MouseEvent) => void;
  onMouseLeave?: (e: React.MouseEvent) => void;
}) {
  const [hovered, setHovered] = React.useState(false);
  const playing = useIntroPlay(hovered);
  return (
    <button
      className={cn(
        "tm-card group relative flex w-full flex-col items-stretch overflow-hidden rounded-lg border bg-card text-left transition-colors hover:border-primary/50",
        favorited && "border-primary/40",
      )}
      onPointerDown={onPointerDown}
      onMouseEnter={(e) => {
        setHovered(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        setHovered(false);
        onMouseLeave?.(e);
      }}
      title={def.tagline}
    >
      <TransitionPreview presetId={def.id} playing={playing} className="h-14 border-b bg-stage" />
      <div className="p-1.5">
        <div className="truncate text-[11px] font-semibold">{def.label}</div>
        <div className="truncate text-[10px] text-muted-foreground">{def.tagline}</div>
      </div>
    </button>
  );
}

/** Presets matching a search, grouped into their categories in browse order. */
export function groupedTransitions(query: string): Array<{
  category: TransitionCategory;
  presets: TransitionDef[];
}> {
  const q = query.trim().toLowerCase();
  const match = (p: TransitionDef) =>
    !q || p.label.toLowerCase().includes(q) || p.tagline.toLowerCase().includes(q);
  return TRANSITION_CATEGORY_ORDER.map((category) => ({
    category,
    presets: TRANSITION_PRESETS.filter((p) => p.category === category && match(p)),
  })).filter((g) => g.presets.length > 0);
}
