"use client";

import * as React from "react";
import { ArrowUpDown, Check, ClipboardPaste, FolderPlus } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Kbd } from "@/components/ui/kbd";
import { ShortcutHint } from "../state/ShortcutHint";
import { cn } from "@/lib/utils";
import { FilerCard } from "./FilerCard";
import { computeView, type FilerItem, type SortKey } from "./model/tree";
import { useFilerKeys } from "./use-filer-keys";
import { useFiler, type FilerStore } from "./use-file-manager";
import { useGridDrag } from "./use-grid-drag";
import { useMarquee } from "./use-marquee";

/**
 * The grid surface: derives the current folder's view from the store, lays out
 * folder + item cards at a uniform height, and wires the three interaction
 * hooks (pointer-drag, marquee, keyboard). The empty background is a right-click
 * menu (New folder / Paste / Select all / Sort) and a marquee origin. Item
 * visuals come in as render-props so this stays surface-agnostic.
 */

export interface FileGridProps<T> {
  fm: FilerStore<T>;
  renderThumb: (item: FilerItem<T>, hovered: boolean) => React.ReactNode;
  itemThumbUrl: (item: FilerItem<T>) => string | null;
  itemMeta?: (item: FilerItem<T>) => string;
  /** Rendered before all cards (e.g. the New Project tile). */
  leading?: React.ReactNode;
  /** Cards (default) or rows with columns. */
  layout?: "grid" | "list";
  /** Replaces the one-line "empty folder" state (Home's first run). */
  empty?: React.ReactNode;
  onNewFolder: () => void;
  onMoveToNewFolder: (ids: string[]) => void;
  onRequestDelete: (ids: string[]) => void;
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: "updated", label: "Date modified" },
  { key: "created", label: "Date created" },
  { key: "name", label: "Name" },
];

export function FileGrid<T>(props: FileGridProps<T>) {
  const { fm, leading, onNewFolder, onMoveToNewFolder, onRequestDelete, layout = "grid" } = props;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const gridRef = React.useRef<HTMLDivElement>(null);

  const tree = useFiler(fm, (s) => s.tree);
  const currentFolderId = useFiler(fm, (s) => s.currentFolderId);
  const sort = useFiler(fm, (s) => s.sort);
  const search = useFiler(fm, (s) => s.search);
  const selected = useFiler(fm, (s) => s.selection.selected);
  const clipboard = useFiler(fm, (s) => s.clipboard);
  const renamingId = useFiler(fm, (s) => s.renamingId);
  const loading = useFiler(fm, (s) => s.loading);

  const view = React.useMemo(
    () => computeView(tree, currentFolderId, sort, search),
    [tree, currentFolderId, sort, search],
  );

  const { beginDrag, ghostNode } = useGridDrag(fm);
  const { onPointerDown, marqueeNode } = useMarquee(fm, scrollRef);
  useFilerKeys(fm, { gridRef, onRequestDelete });

  const cutIds = clipboard?.mode === "cut" ? new Set(clipboard.ids) : null;
  const nodes = [...view.folders, ...view.items];
  const empty = nodes.length === 0;

  return (
    <>
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div ref={scrollRef} onPointerDown={onPointerDown} className="relative flex-1">
          {layout === "list" && !empty && (
            <div className="flex h-(--control-h) items-center gap-3 border-b border-line px-2 text-meta text-fg-faint">
              <span className="w-12 shrink-0" />
              <span className="min-w-0 flex-1">Name</span>
              <span className="hidden w-32 shrink-0 sm:block">Edited</span>
              <span className="w-6 shrink-0" />
            </div>
          )}
          <div
            ref={gridRef}
            className={
              layout === "list"
                ? "flex flex-col"
                : "grid grid-cols-2 gap-x-2 gap-y-3 sm:grid-cols-[repeat(auto-fill,minmax(13rem,1fr))]"
            }
          >
            {!search.query && leading}
            {nodes.map((node) => (
              <FilerCard
                key={node.id}
                fm={fm}
                node={node}
                selected={selected.has(node.id)}
                cut={cutIds?.has(node.id) ?? false}
                renaming={renamingId === node.id}
                layout={layout}
                beginDrag={beginDrag}
                renderThumb={props.renderThumb}
                itemThumbUrl={props.itemThumbUrl}
                itemMeta={props.itemMeta}
                onMoveToNewFolder={onMoveToNewFolder}
                onRequestDelete={onRequestDelete}
              />
            ))}
          </div>

          {!loading && empty && (view.searching || search.query || !props.empty ? (
            <p className="py-24 text-center text-body text-fg-faint">
              {view.searching || search.query ? "No projects match" : "Empty folder — drag projects here"}
            </p>
          ) : (
            props.empty
          ))}
          {marqueeNode}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="min-w-48">
        <ContextMenuItem onClick={onNewFolder}>
          <FolderPlus /> New folder
        </ContextMenuItem>
        <ContextMenuItem disabled={!clipboard} onClick={() => void fm.getState().paste()}>
          <ClipboardPaste /> Paste
          <ShortcutHint id="edit.paste" />
        </ContextMenuItem>
        <ContextMenuItem onClick={() => fm.getState().selectAll()}>
          Select all
          <ShortcutHint id="edit.selectAll" />
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <ArrowUpDown /> Sort by
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {SORTS.map((sp) => (
              <ContextMenuItem
                key={sp.key}
                onClick={() =>
                  fm.getState().setSort({
                    key: sp.key,
                    dir: sort.key === sp.key && sort.dir === "desc" ? "asc" : "desc",
                  })
                }
              >
                {sort.key === sp.key ? <Check /> : <span className="size-4" />}
                {sp.label}
                {sort.key === sp.key && (
                  <Kbd>{sort.dir === "desc" ? "↓" : "↑"}</Kbd>
                )}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
    {ghostNode}
    </>
  );
}
