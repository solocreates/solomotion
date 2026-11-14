"use client";

import * as React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ClipboardPaste,
  Copy,
  CopyPlus,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Pencil,
  Scissors,
  Trash2,
} from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { isDescendant } from "./model/tree";
import { useFiler, type FilerStore } from "./use-file-manager";

/**
 * The one node-action menu, rendered identically by the right-click
 * ContextMenu and the three-dot DropdownMenu (touch) — a single source so the
 * two surfaces can never drift (the editor's "one vocabulary, three surfaces"
 * idea, applied to the home file manager). Acts on `ids` (the normalised target
 * set: the whole selection when the target is part of it, else just the target).
 */

const CTX = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Shortcut: ContextMenuShortcut,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};
const DROP = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Shortcut: DropdownMenuShortcut,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

export interface FilerMenuProps<T> {
  fm: FilerStore<T>;
  variant: "context" | "dropdown";
  ids: string[];
  onRename: (id: string) => void;
  onMoveToNewFolder: (ids: string[]) => void;
  onRequestDelete: (ids: string[]) => void;
}

export function FilerNodeMenu<T>({ fm, variant, ids, onRename, onMoveToNewFolder, onRequestDelete }: FilerMenuProps<T>) {
  const P = variant === "context" ? CTX : DROP;
  const tree = useFiler(fm, (st) => st.tree);
  const clipboard = useFiler(fm, (st) => st.clipboard);
  const nodes = ids
    .map((id) => [...tree.folders, ...tree.items].find((n) => n.id === id))
    .filter(Boolean) as { id: string; kind: string; parentId: string | null }[];
  const single = nodes.length === 1 ? nodes[0] : null;
  const hasItems = nodes.some((n) => n.kind === "item");
  const draggedFolderIds = nodes.filter((n) => n.kind === "folder").map((n) => n.id);

  // Valid move targets: any folder not selected and not inside a moved folder,
  // excluding the folder the nodes already sit in.
  const currentParents = new Set(nodes.map((n) => n.parentId ?? null));
  const targets = tree.folders.filter(
    (f) =>
      !ids.includes(f.id) &&
      !draggedFolderIds.some((d) => isDescendant(tree, f.id, d)) &&
      !(currentParents.size === 1 && currentParents.has(f.id)),
  );
  const canPasteHere = clipboard != null && single?.kind === "folder";

  return (
    <>
      {single && (
        <P.Item onClick={() => fm.getState().activate(single.id)}>
          <FolderOpen /> Open
        </P.Item>
      )}
      {single && (
        <P.Item onClick={() => onRename(single.id)}>
          <Pencil /> Rename
          <P.Shortcut>F2</P.Shortcut>
        </P.Item>
      )}
      <P.Separator />
      <P.Item onClick={() => fm.getState().cut()}>
        <Scissors /> Cut
        <P.Shortcut>⌘X</P.Shortcut>
      </P.Item>
      <P.Item onClick={() => fm.getState().copy()}>
        <Copy /> Copy
        <P.Shortcut>⌘C</P.Shortcut>
      </P.Item>
      {canPasteHere && (
        <P.Item onClick={() => void fm.getState().paste(single!.id)}>
          <ClipboardPaste /> Paste into folder
        </P.Item>
      )}
      {hasItems && (
        <P.Item onClick={() => void fm.getState().duplicateSelection()}>
          <CopyPlus /> Duplicate
          <P.Shortcut>⌘D</P.Shortcut>
        </P.Item>
      )}
      <P.Sub>
        <P.SubTrigger>
          <FolderInput /> Move to
        </P.SubTrigger>
        <P.SubContent>
<ScrollArea className="max-h-72">
          <P.Item onClick={() => onMoveToNewFolder(ids)}>
            <FolderPlus /> New folder…
          </P.Item>
          {(targets.length > 0 || !currentParents.has(null)) && <P.Separator />}
          {!currentParents.has(null) && (
            <P.Item onClick={() => void fm.getState().move(ids, null)}>Home (root)</P.Item>
          )}
          {targets.map((f) => (
            <P.Item key={f.id} onClick={() => void fm.getState().move(ids, f.id)}>
              {f.name}
            </P.Item>
          ))}
        </ScrollArea>
        </P.SubContent>
      </P.Sub>
      <P.Separator />
      <P.Item className="text-destructive focus:text-destructive" onClick={() => onRequestDelete(ids)}>
        <Trash2 /> Delete
        <P.Shortcut>⌦</P.Shortcut>
      </P.Item>
    </>
  );
}
