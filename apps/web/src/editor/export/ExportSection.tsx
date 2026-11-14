"use client";

import { identity } from "@/editor/identity";
import * as React from "react";
import { frameTarget, framesTarget, selectionTarget, type ExportTarget, type SliceSelection } from "@solomotion/core";
import { PackageOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDoc, useDocStore } from "../state/document-context";
import { PanelSection } from "../inspector/controls";
import { exportSelectionAsFile } from "../io/slice-file";
import { ExportPanel } from "./ExportPanel";

/**
 * The sidebar "Export" section — Figma's bottom-of-inspector export, for ANY
 * subject: a layer, a group, a multi-selection, or the frame itself. It's the
 * same ExportPanel the dialog renders; only the chrome differs. Collapsed by
 * default so the inspector stays calm; the panel's smart defaults kick in the
 * moment it opens (video for animated layers, SVG for pure vectors).
 */
export function ExportSection({
  clipIds,
  frameId,
  frameIds,
}: {
  clipIds?: string[];
  frameId?: string;
  /** Several frames picked — exported together, in this (pick) order. */
  frameIds?: string[];
}) {
  const doc = useDoc();
  const store = useDocStore();
  const target: ExportTarget | null = React.useMemo(() => {
    if (clipIds && clipIds.length > 0) return selectionTarget(doc, clipIds);
    if (frameIds && frameIds.length > 1) return framesTarget(doc, frameIds);
    if (frameId) return frameTarget(doc, frameId);
    return null;
  }, [doc, clipIds, frameId, frameIds]);

  if (!target) return null;

  // Same selection, packaged as a reusable slice file (media included) —
  // the import-anywhere counterpart to the render exports above.
  const dataSelection: SliceSelection =
    clipIds && clipIds.length > 0 ? { clipIds } : { frameIds: frameIds && frameIds.length > 1 ? frameIds : frameId ? [frameId] : [] };

  return (
    <PanelSection title="Export" defaultOpen={false}>
      <ExportPanel target={target} variant="sidebar" />
      <Button
        variant="outline"
        size="sm"
        className="mt-2 w-full text-[11px]"
        onClick={() => void exportSelectionAsFile(store, dataSelection)}
      >
        <PackageOpen /> Export as {identity.name} file
      </Button>
    </PanelSection>
  );
}
