"use client";

import * as React from "react";
import { componentFrameOfClip, isInstanceClip, isVisualClip, type Clip } from "@solomotion/core";
import { Component, Film, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { detachSelectedInstances } from "../state/clip-actions";
import { PanelSection, PropRow } from "./controls";

/**
 * The universal Figma-style component control — ONE section, every visual layer
 * kind (text, shape, media, group, nested…), single or multi-select:
 *  - a single instance → its definition (Main), "Edit component", "Detach";
 *  - a selection containing instances → "Detach instances".
 * Creating one is the header's job (beside Duplicate), so this section only
 * appears once there is a component to talk about.
 * Both the sidebar and the right-click menu drive the same `clip-actions`, so the
 * two surfaces can never drift. Renders nothing for a non-visual selection.
 */
export function ComponentSection({ clips }: { clips: Clip[] }) {
  const doc = useDoc();
  const store = useDocStore();

  const visual = clips.filter(isVisualClip);
  if (visual.length === 0) return null;

  const single = visual.length === 1 ? visual[0]! : null;
  const instance = single && single.kind === "nested" ? single : null;
  const singleInstance = instance ? componentFrameOfClip(doc, instance) : null;
  const anyInstance = visual.some((c) => isInstanceClip(doc, c));

  // A single component instance → the rich definition card.
  if (instance && singleInstance) {
    return (
      <PanelSection title="Component" collapsible={false}>
        <PropRow label="Main">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-xs">
            <Component className="size-3.5 shrink-0 text-[#9B7BFF]" />
            {singleInstance.name}
          </span>
        </PropRow>
        <div className="flex gap-1.5 pt-1">
          <Button
            variant="secondary"
            size="sm"
            className="flex-1"
            onClick={() => useSession.getState().enterClip(instance.id)}
          >
            <Film /> Edit component
          </Button>
          <Button variant="secondary" size="sm" className="flex-1" onClick={() => detachSelectedInstances(store)}>
            <Unlink /> Detach
          </Button>
        </div>
      </PanelSection>
    );
  }

  // A multi-selection that contains instances → detach them all.
  if (anyInstance) {
    return (
      <PanelSection title="Component" collapsible={false}>
        <Button variant="secondary" size="sm" className="w-full" onClick={() => detachSelectedInstances(store)}>
          <Unlink /> Detach instances
        </Button>
      </PanelSection>
    );
  }

  return null;
}
