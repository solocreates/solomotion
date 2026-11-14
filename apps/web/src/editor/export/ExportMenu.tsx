"use client";

import { identity } from "@/editor/identity";
import * as React from "react";
import { Braces, FileText, Film, Image as ImageIcon, Layers, PackageOpen } from "lucide-react";
import { selectionTarget } from "@solomotion/core";
import { toast } from "@/lib/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { exportScopeOf, exportSelectionAsFile } from "../io/slice-file";
import { exportPng } from "./export-media";
import { useDoc, useDocSelector, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";

/**
 * The EXPORT menu — what you can get out of the project, in one list.
 *
 * It used to be written inline in the top bar. When that bar was removed the
 * menu went with it and the rail's Export button was left calling
 * `setExportDialogOpen(true)` into a dialog nobody was rendering — so clicking
 * it did nothing at all. Extracted here so it belongs to `export/` rather than
 * to whichever piece of chrome happens to host it, and can be reused by the
 * rail, the app menu and the command palette without a third copy.
 *
 * The first item is the common case (the whole composition); the rest are the
 * shortcuts that skip the dialog because their scope is unambiguous.
 */
export function ExportMenu({ children }: { children: React.ReactNode }) {
  const store = useDocStore();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="left" sideOffset={6} className="w-56">
        <DropdownMenuItem onClick={() => useSession.getState().setExportDialogOpen(true)}>
          <Film /> Composition…
        </DropdownMenuItem>
        <SelectedLayerExportItem />
        <DropdownMenuItem
          onClick={() =>
            useSession.getState().setExportDialogOpen(true, { scope: "frame", medium: "lottie" })
          }
        >
          <Braces /> Lottie animation…
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => useSession.getState().setExportDialogOpen(true, { scope: "frame", medium: "pdf" })}
        >
          <FileText /> PDF…
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            const d = store.getState();
            const session = useSession.getState();
            const frame = d.frames.find((f) => f.id === session.activeFrameId) ?? d.frames[0];
            if (!frame) {
              toast("There are no frames to export yet");
              return;
            }
            void exportPng(d, frame, session.playheadMs).catch((e) =>
              toast.error("PNG export failed", { description: (e as Error).message }),
            );
          }}
        >
          <ImageIcon /> Current frame (PNG)
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <SliceFileItem />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "<product> file — <scope>": the label follows the selection it will export. */
function SliceFileItem() {
  const store = useDocStore();
  const selectedFrameIds = useSession((s) => s.selectedFrameIds);
  const selectedClipIds = useSession((s) => s.selectedClipIds);
  const activeFrameId = useSession((s) => s.activeFrameId);
  const firstFrameId = useDocSelector((d) => d.frames[0]?.id ?? null);
  const scope = exportScopeOf({ selectedFrameIds, selectedClipIds, activeFrameId }, firstFrameId);
  return (
    <DropdownMenuItem onClick={() => void exportSelectionAsFile(store, scope.selection)}>
      <PackageOpen /> {identity.name} file — {scope.label}
    </DropdownMenuItem>
  );
}

/** "Export <selection name>…" — only while layers are selected; opens the
 *  dialog straight on the selection tab, named after what is picked. */
function SelectedLayerExportItem() {
  const doc = useDoc();
  const selectedIds = useSession((s) => s.selectedClipIds);
  const target = selectedIds.length ? selectionTarget(doc, selectedIds) : null;
  if (!target) return null;
  return (
    <DropdownMenuItem
      onClick={() => useSession.getState().setExportDialogOpen(true, { scope: "selection", medium: null })}
    >
      <Layers /> {target.kind === "layer" ? `Layer “${target.name}”` : target.name}…
    </DropdownMenuItem>
  );
}
