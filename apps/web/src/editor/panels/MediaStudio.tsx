"use client";

import * as React from "react";
import type { Asset } from "@solomotion/core";
import { FolderInput, FolderPlus, Link2, Plus, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * THE STUDIO MEDIA PANEL's parts — the `studio` composition
 * (`ProductIdentity.browsers`). `MediaLibrary` keeps every behaviour (filer,
 * import, drop, paste, marquee, drag-out); these only place it.
 *
 * Import is the panel's first act, so it sits in the head beside the path, not
 * in a footer bar. Selection actions exist only while there is a selection, as
 * a float over the grid. Items read like a media pool: the picture at its true
 * shape on the backdrop, the facts that differ (size, length) in the code face.
 */

/** The facts that tell two items apart and are not in the picture. */
export function assetMeta(asset: Asset): string {
  const parts: string[] = [];
  if (asset.kind !== "audio" && asset.width && asset.height) parts.push(`${asset.width}×${asset.height}`);
  if (asset.durationMs) parts.push(clock(asset.durationMs));
  if (asset.kind === "audio" && !asset.durationMs) parts.push("audio");
  return parts.join(" · ");
}

const clock = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The head's add menu: the second ways in, after Import. */
function AddMenu({
  onNewFolder,
  onImportFolder,
  onLinkFolder,
}: {
  onNewFolder: () => void;
  onImportFolder: () => void;
  onLinkFolder: (() => void) | null;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Folders"
          className="flex size-(--control-h) shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover [&_svg]:size-3.5"
        >
          <Plus />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onNewFolder}>
          <FolderPlus /> New folder
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onImportFolder}>
          <FolderInput /> Import folder…
        </DropdownMenuItem>
        {onLinkFolder && (
          <DropdownMenuItem onClick={onLinkFolder}>
            <Link2 /> Link folder…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Path on the left, the ways in on the right; the search row under it. */
export function StudioMediaHead({
  path,
  search,
  onImport,
  ...menu
}: {
  path: React.ReactNode;
  search: React.ReactNode;
  onImport: () => void;
  onNewFolder: () => void;
  onImportFolder: () => void;
  onLinkFolder: (() => void) | null;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-line px-2 pb-2 pt-1.5">
      <div className="flex min-w-0 items-center gap-0.5">
        <div className="min-w-0 flex-1">{path}</div>
        <AddMenu {...menu} />
        <Button variant="outline" size="sm" className="h-(--control-h) gap-1.5 px-2.5" onClick={onImport}>
          <Upload className="size-3.5" /> Import
        </Button>
      </div>
      <div className="flex items-center gap-1">{search}</div>
    </div>
  );
}

/**
 * The selection's actions, floating over the grid's foot only while something
 * is selected: the count in the code face, Move, Delete, and a way out.
 */
export function MediaSelectionFloat({
  count,
  onMove,
  onDelete,
  onClear,
}: {
  count: number;
  onMove: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const act =
    "flex h-7 items-center gap-1.5 rounded-md px-1.5 text-body transition-colors [&_svg]:size-3.5";
  return (
    <div className="@container pointer-events-none absolute inset-x-2 bottom-2 z-10 flex justify-center">
      <div
        role="toolbar"
        aria-label="Selection"
        className="pointer-events-auto flex max-w-full items-center gap-0.5 rounded-lg bg-popover p-1 shadow-[0_14px_36px_-14px_rgb(0_0_0/0.5),0_2px_6px_-2px_rgb(0_0_0/0.22)] ring-1 ring-line"
      >
        <span className="whitespace-nowrap px-1.5 font-mono text-meta tabular-nums text-fg-muted">
          {count} <span className="hidden @[15rem]:inline">selected</span>
        </span>
        <button type="button" aria-label="Move" onClick={onMove} className={cn(act, "text-fg hover:bg-hover")}>
          <FolderInput /> <span className="hidden @[12rem]:inline">Move</span>
        </button>
        <button
          type="button"
          aria-label="Delete"
          onClick={onDelete}
          className={cn(act, "text-destructive hover:bg-destructive/10")}
        >
          <Trash2 /> <span className="hidden @[12rem]:inline">Delete</span>
        </button>
        <button
          type="button"
          aria-label="Clear selection"
          onClick={onClear}
          className="flex size-7 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg [&_svg]:size-3.5"
        >
          <X />
        </button>
      </div>
    </div>
  );
}

/** An empty bin is the drop target: the backdrop, a frame, one way in. */
export function MediaDropZone({ searching, onImport }: { searching: boolean; onImport: () => void }) {
  if (searching) {
    return (
      <div className="flex flex-col items-center gap-1.5 px-3 py-12 text-center">
        <p className="font-mono text-meta uppercase tracking-[0.12em] text-primary">No match</p>
      </div>
    );
  }
  return (
    <div className="stage-backdrop flex min-h-56 flex-col items-center justify-center gap-3 rounded-lg bg-stage px-4 py-10 text-center ring-1 ring-inset ring-line">
      <p className="font-mono text-meta uppercase tracking-[0.12em] text-primary">Drop media</p>
      <p className="text-body text-fg-muted">Footage, stills and sound.</p>
      <Button variant="outline" size="sm" className="h-(--control-h) gap-1.5 px-3" onClick={onImport}>
        <Upload className="size-3.5" /> Import
      </Button>
    </div>
  );
}
