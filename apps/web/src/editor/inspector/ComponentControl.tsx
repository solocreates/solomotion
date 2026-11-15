"use client";

import * as React from "react";
import {
  componentContextOfClip,
  componentContextOfFrame,
  isVisualClip,
  type Clip,
  type ComponentContext,
  type Frame,
} from "@solomotion/core";
import { Component, Film, Plus, Unlink } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import {
  addVariantFor,
  deleteVariantFor,
  detachInstanceFrameAction,
  detachSelectedInstances,
  renameVariantFor,
  switchVariantFor,
} from "../state/clip-actions";
import { saveToLibrary } from "../presets/SaveToLibraryDialog";
import { PanelSection, PropRow } from "./controls";

/**
 * THE unified, headless-driven component control (Figma-style) — one section for
 * a selected FRAME or a selected LAYER, single-select. Everything it does routes
 * through the ONE core brain (`components.ts`), so the sidebar, the frame header
 * and the Components view can never drift:
 *  - an instance (linked frame OR nested clip) → variant switcher + Add variant +
 *    Detach (+ Edit for a clip instance);
 *  - a definition/variant frame → variant switcher (navigate) + Add/rename/delete.
 * Renders nothing for a non-visual selection.
 *
 * Renders nothing until the subject IS part of a component set — creating one
 * is the header button beside Duplicate, for every kind of subject.
 */
export function ComponentControl({ frame, clip }: { frame?: Frame; clip?: Clip }) {
  const doc = useDoc();
  const store = useDocStore();
  const targetId = frame?.id ?? clip?.id;
  if (!targetId) return null;
  if (clip && !isVisualClip(clip)) return null;

  const ctx: ComponentContext | null = frame
    ? componentContextOfFrame(doc, frame)
    : clip
      ? componentContextOfClip(doc, clip)
      : null;

  if (!ctx) return null;


  const currentId = ctx.current?.id;
  const isClipInstance = !!clip && ctx.isInstance;

  const onVariant = (variantId: string) => {
    if (ctx.isInstance) switchVariantFor(store, targetId, variantId);
    else useSession.getState().selectFrame(variantId); // navigate between a set's variants
  };
  const rename = (variantId: string, cur: string) =>
    saveToLibrary({
      title: "Rename variant",
      defaultName: cur,
      scopeless: true,
      confirmLabel: "Rename",
      onSave: (next) => renameVariantFor(store, variantId, next),
    });

  return (
    <PanelSection title="Component" collapsible={false}>
      <PropRow label={ctx.isInstance ? "Instance of" : "Component"}>
        <span className="flex min-w-0 items-center gap-1.5 truncate text-xs">
          <Component className="size-3.5 shrink-0 text-(--kind-component)" />
          {ctx.current?.name ?? "Component"}
        </span>
      </PropRow>

      <PropRow label="Variant">
        <div className="flex flex-wrap items-center gap-1">
          {ctx.variants.map((v) => {
            const active = v.id === currentId;
            return (
              <button
                key={v.id}
                className={cn(
                  "rounded border px-2 py-0.5 text-[11px] transition-colors",
                  active
                    ? "border-(--kind-component) bg-(--kind-component)/20 text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                onClick={() => onVariant(v.id)}
                onDoubleClick={() => rename(v.id, v.component?.variantName ?? "Main")}
                title={ctx.isInstance ? "Switch to this variant" : "Select variant · double-click to rename"}
              >
                {v.component?.variantName ?? "Main"}
              </button>
            );
          })}
          <button
            className="flex size-5.5 items-center justify-center rounded border border-dashed border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => addVariantFor(store, targetId)}
            title="Add variant"
            aria-label="Add variant"
          >
            <Plus className="size-3" />
          </button>
        </div>
      </PropRow>

      <div className="flex gap-1.5 pt-1">
        {isClipInstance && (
          <Button
            variant="secondary"
            size="sm"
            className="flex-1"
            onClick={() =>
              clip && clip.kind === "nested" && useSession.getState().enterClip(clip.id)
            }
          >
            <Film /> Edit
          </Button>
        )}
        {ctx.isInstance ? (
          <Button
            variant="secondary"
            size="sm"
            className="flex-1"
            onClick={() => (frame ? detachInstanceFrameAction(store, frame.id) : detachSelectedInstances(store))}
          >
            <Unlink /> Detach
          </Button>
        ) : (
          ctx.variants.length > 1 &&
          currentId && (
            <Button
              variant="ghost"
              size="sm"
              className="flex-1 text-muted-foreground hover:text-destructive"
              onClick={() => deleteVariantFor(store, currentId)}
            >
              Delete variant
            </Button>
          )
        )}
      </div>
    </PanelSection>
  );
}
