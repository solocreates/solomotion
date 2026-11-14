"use client";

import * as React from "react";
import {
  addVariableFolder,
  deleteVariableFolder,
  renameVariableFolder,
  type Variable,
  type VariableFolder,
  type VariableType,
} from "@solomotion/core";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Layers,
  Library,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RailItem, RailSection } from "@/components/ui/rail-list";
import { RenameInput } from "@/components/ui/rename-input";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../../state/document-context";
import { VARIABLE_TYPE_META, VARIABLE_TYPE_ORDER } from "./variable-meta";

/**
 * The Variables rail — the left half of the browser, and the same object the
 * app's other rails are: a vertical list of places, on a panel surface, beside
 * the thing it filters.
 *
 * It carries TWO sections because there are genuinely two questions — "what
 * kind of value" and "whose set of values" — and answering them with one flat
 * list of chips is what made the old strip unreadable the moment a palette
 * arrived. Types filter; folders scope. Picking one clears the other, because a
 * folder already knows what is in it and a type crossed with a folder is a
 * query nobody was asking.
 */

export type RailSelection = { kind: "type"; type: VariableType | "all" } | { kind: "folder"; id: string };

export function VariablesRail({
  selection,
  onSelect,
  counts,
  onDropInFolder,
}: {
  selection: RailSelection;
  onSelect: (s: RailSelection) => void;
  counts: Map<VariableType, number>;
  /** A drag from the table landed on a folder — file the dragged rows there. */
  onDropInFolder: (folderId: string | null) => void;
}) {
  const doc = useDoc();
  const store = useDocStore();
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [openIds, setOpenIds] = React.useState<Set<string>>(() => new Set());
  const [dropId, setDropId] = React.useState<string | null>(null);

  const roots = doc.variableFolders.filter((f) => f.parentId === null);
  const total = doc.variables.length;

  const addFolder = () =>
    store.update("New folder", (d) => {
      const f = addVariableFolder(d, "Folder");
      setRenamingId(f.id);
    });

  return (
    <aside className="flex min-h-0 w-full flex-col shell-card">
      <ScrollArea className="min-h-0 flex-1" viewportClassName="p-2">
        <RailSection label="Values" />
        <RailItem
          icon={<Layers />}
          label="All"
          count={total}
          active={selection.kind === "type" && selection.type === "all"}
          onClick={() => onSelect({ kind: "type", type: "all" })}
          onDrop={() => onDropInFolder(null)}
          onDropActive={dropId === "__all"}
          onDropOver={(over) => setDropId(over ? "__all" : null)}
        />
        {VARIABLE_TYPE_ORDER.map((t) => {
          const Icon = VARIABLE_TYPE_META[t].icon;
          return (
            <RailItem
              key={t}
              icon={<Icon />}
              label={VARIABLE_TYPE_META[t].label}
              count={counts.get(t) ?? 0}
              active={selection.kind === "type" && selection.type === t}
              onClick={() => onSelect({ kind: "type", type: t })}
            />
          );
        })}

        <RailSection label="Libraries" action={{ icon: <FolderPlus />, label: "New folder", onClick: addFolder }} />
        {roots.length === 0 && (
          <p className="px-2 py-1.5 text-[11px] text-muted-foreground">No folders yet.</p>
        )}
        {roots.map((f) => (
          <FolderNode
            key={f.id}
            folder={f}
            depth={0}
            selection={selection}
            onSelect={onSelect}
            renamingId={renamingId}
            setRenamingId={setRenamingId}
            openIds={openIds}
            setOpenIds={setOpenIds}
            dropId={dropId}
            setDropId={setDropId}
            onDropInFolder={onDropInFolder}
          />
        ))}

      </ScrollArea>
    </aside>
  );
}

function FolderNode({
  folder,
  depth,
  selection,
  onSelect,
  renamingId,
  setRenamingId,
  openIds,
  setOpenIds,
  dropId,
  setDropId,
  onDropInFolder,
}: {
  folder: VariableFolder;
  depth: number;
  selection: RailSelection;
  onSelect: (s: RailSelection) => void;
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
  openIds: Set<string>;
  setOpenIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  dropId: string | null;
  setDropId: (id: string | null) => void;
  onDropInFolder: (folderId: string | null) => void;
}) {
  const doc = useDoc();
  const store = useDocStore();
  const children = doc.variableFolders.filter((f) => f.parentId === folder.id);
  const count = doc.variables.filter((v: Variable) => v.folderId === folder.id).length;
  const open = openIds.has(folder.id);
  const active = selection.kind === "folder" && selection.id === folder.id;

  if (renamingId === folder.id) {
    return (
      <div className="px-1 py-0.5" style={{ paddingLeft: `${8 + depth * 12}px` }}>
        <RenameInput
          initial={folder.name}
          onCommit={(name) => {
            store.update("Rename folder", (d) => renameVariableFolder(d, folder.id, name));
            setRenamingId(null);
          }}
        />
      </div>
    );
  }

  return (
    <>
      <RailItem
        depth={depth}
        icon={open ? <FolderOpen /> : <Folder />}
        accent={folder.accent}
        label={folder.name}
        count={count}
        active={active}
        onClick={() => onSelect({ kind: "folder", id: folder.id })}
        onDrop={() => onDropInFolder(folder.id)}
        onDropActive={dropId === folder.id}
        onDropOver={(over) => setDropId(over ? folder.id : null)}
        menu={
          <>
            <ContextMenuItem onSelect={() => setRenamingId(folder.id)}>
              <Pencil /> Rename
            </ContextMenuItem>
            <ContextMenuSeparator />
            {/* Two deletes, said plainly. Losing nine colours to a mis-click on
                a folder chip is not a thing a design tool should make possible,
                so the contents move up unless you ask otherwise. */}
            <ContextMenuItem
              onSelect={() => store.update("Delete folder", (d) => deleteVariableFolder(d, folder.id))}
            >
              <Trash2 /> Delete, keep contents
            </ContextMenuItem>
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() =>
                store.update("Delete folder and contents", (d) =>
                  deleteVariableFolder(d, folder.id, { withContents: true }),
                )
              }
            >
              <Trash2 /> Delete with contents
            </ContextMenuItem>
          </>
        }
      >
        {children.length > 0 ? (
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              setOpenIds((s) => {
                const next = new Set(s);
                if (next.has(folder.id)) next.delete(folder.id);
                else next.add(folder.id);
                return next;
              });
            }}
            className="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3"
          >
            <ChevronRight className={cn("transition-transform", open && "rotate-90")} />
          </span>
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
      </RailItem>
      {open &&
        children.map((c) => (
          <FolderNode
            key={c.id}
            folder={c}
            depth={depth + 1}
            selection={selection}
            onSelect={onSelect}
            renamingId={renamingId}
            setRenamingId={setRenamingId}
            openIds={openIds}
            setOpenIds={setOpenIds}
            dropId={dropId}
            setDropId={setDropId}
            onDropInFolder={onDropInFolder}
          />
        ))}
    </>
  );
}

export { Library };
