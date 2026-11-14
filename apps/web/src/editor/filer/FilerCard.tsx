"use client";

import * as React from "react";
import { Folder, MoreHorizontal } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { FilerNodeMenu } from "./filer-menu";
import { descendantItems, type FilerItem, type FilerNode } from "./model/tree";
import { useFiler, type FilerState, type FilerStore } from "./use-file-manager";

/**
 * One grid card — folder or item — with all shared card behaviour in one place:
 * selection ring, cut-dimming, pointer-drag start, right-click + three-dot menus
 * (identical actions via FilerNodeMenu), inline rename, and double-click to
 * activate. Folders additionally render a Procreate-style 2×2 preview of their
 * most-recent items and act as a drop target. The item's visual is a render-prop
 * so the surface (projects now, media later) owns only its thumbnail.
 */

export interface FilerCardProps<T> {
  fm: FilerStore<T>;
  node: FilerNode<T>;
  selected: boolean;
  cut: boolean;
  renaming: boolean;
  beginDrag: (e: React.PointerEvent, id: string) => void;
  /** Item thumbnail (hovered = allowed to animate). Unused for folders. */
  renderThumb: (item: FilerItem<T>, hovered: boolean) => React.ReactNode;
  /** Still thumbnail URL for folder-preview tiles. */
  itemThumbUrl: (item: FilerItem<T>) => string | null;
  itemMeta?: (item: FilerItem<T>) => string;
  onMoveToNewFolder: (ids: string[]) => void;
  onRequestDelete: (ids: string[]) => void;
  layout?: "grid" | "list";
}

export function FilerCard<T>(props: FilerCardProps<T>) {
  const { fm, node, selected, cut, renaming, beginDrag, onMoveToNewFolder, onRequestDelete, layout = "grid" } = props;
  const list = layout === "list";
  const [hover, setHover] = React.useState(false);

  // Menu acts on the whole selection when this node is part of it, else on it
  // alone. Only a selected card follows the selection set, so picking one card
  // in a big grid doesn't wake every other.
  const selection = useFiler(fm, (st) => (selected ? st.selection.selected : null));
  const menuIds = selection?.has(node.id) ? [...selection] : [node.id];
  const normalizeSelection = () => {
    if (!fm.getState().selection.selected.has(node.id)) fm.getState().setSelection([node.id]);
  };

  const isFolder = node.kind === "folder";
  const folderLabel = useFiler(fm, (st) => (isFolder ? folderMeta(st.tree, node.id) : ""));
  const dropAttrs = isFolder ? { "data-drop-folder-id": node.id } : {};

  const menu = (variant: "context" | "dropdown") => (
    <FilerNodeMenu
      fm={fm}
      variant={variant}
      ids={menuIds}
      onRename={(id) => fm.getState().beginRename(id)}
      onMoveToNewFolder={onMoveToNewFolder}
      onRequestDelete={onRequestDelete}
    />
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-node-id={node.id}
          {...dropAttrs}
          onPointerDown={(e) => beginDrag(e, node.id)}
          onContextMenu={normalizeSelection}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          className={cn(
            // D8: selection is an accent FILL, never an outline. The card is
            // its picture and two lines of type — no box around them.
            "group relative flex select-none rounded-lg outline-none transition-colors",
            list ? "h-12 items-center gap-3 px-2" : "flex-col gap-2 p-1.5",
            "data-[drop-over=true]:bg-selection data-[drop-over=true]:ring-2 data-[drop-over=true]:ring-primary/60",
            selected ? "bg-selection" : "hover:bg-hover",
            cut && "opacity-45",
          )}
        >
          <div
            className={cn(
              "relative block shrink-0 overflow-hidden rounded-md border border-line bg-stage",
              list ? "h-7.5 w-12" : "aspect-16/10 w-full",
            )}
          >
            {isFolder ? (
              <FolderPreview {...props} folderId={node.id} />
            ) : (
              props.renderThumb(node as FilerItem<T>, hover && !list)
            )}
          </div>

          <div className={cn("flex min-w-0 items-center gap-2", list ? "flex-1" : "px-0.5")}>
            <div className={cn("min-w-0 flex-1", list && "flex items-center gap-3")}>
              {renaming ? (
                <RenameInput fm={fm} id={node.id} initial={node.name} />
              ) : (
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  {isFolder && <Folder className="size-3.5 shrink-0 text-fg-muted" />}
                  <div className={cn("truncate text-label", selected ? "text-selection-fg" : "text-fg")}>{node.name}</div>
                </div>
              )}
              <div className={cn("truncate text-meta text-fg-faint", list && "hidden w-32 shrink-0 sm:block")}>
                {isFolder ? folderLabel : props.itemMeta?.(node as FilerItem<T>) ?? ""}
              </div>
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Menu"
                  onClick={normalizeSelection}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-muted opacity-0 transition-opacity hover:bg-pressed hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 [&_svg]:size-4 [@media(pointer:coarse)]:opacity-100"
                >
                  <MoreHorizontal />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                {menu("dropdown")}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">{menu("context")}</ContextMenuContent>
    </ContextMenu>
  );
}

function folderMeta<T>(tree: FilerState<T>["tree"], folderId: string): string {
  let n = 0;
  for (const f of tree.folders) if (f.parentId === folderId) n++;
  for (const it of tree.items) if (it.parentId === folderId) n++;
  return n === 0 ? "Empty" : `${n} item${n === 1 ? "" : "s"}`;
}

/** Procreate-style 2×2 grid of the folder's four most-recent item thumbnails. */
function FolderPreview<T>({ fm, itemThumbUrl, folderId }: FilerCardProps<T> & { folderId: string }) {
  const tree = useFiler(fm, (st) => st.tree);
  const previews = descendantItems(tree, folderId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4)
    .map((it) => itemThumbUrl(it));

  if (previews.length === 0) {
    return (
      <div className="flex size-full items-center justify-center text-fg-faint">
        <Folder className="size-8" />
      </div>
    );
  }
  return (
    <div className="grid size-full grid-cols-2 grid-rows-2 gap-px bg-line">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center justify-center overflow-hidden bg-stage">
          {previews[i] ? (
            <img src={previews[i]!} alt="" draggable={false} className="size-full object-cover" />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function RenameInput<T>({ fm, id, initial }: { fm: FilerStore<T>; id: string; initial: string }) {
  const [value, setValue] = React.useState(initial);
  const commit = () => void fm.getState().commitRename(id, value);
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") fm.getState().cancelRename();
        e.stopPropagation();
      }}
      className="w-full rounded-sm bg-input px-1 text-label outline-none ring-1 ring-primary/60"
      spellCheck={false}
    />
  );
}
