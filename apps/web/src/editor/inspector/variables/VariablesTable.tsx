"use client";

import * as React from "react";
import {
  deleteVariable,
  duplicateVariables,
  moveVariables,
  renameVariable,
  variableFolderPath,
  type Variable,
} from "@solomotion/core";
import { ClipboardCopy, ClipboardPaste, Copy, FolderInput, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useVirtualRows } from "@/components/ui/use-virtual-rows";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../../state/document-context";
import { useSweepSelect } from "../../state/use-sweep-select";
import { VARIABLE_TRACK_KEY } from "@solomotion/core";
import { ModulatorControl } from "../ModulatorControl";
import { VariableKeyControl } from "./VariableKeyControl";
import { useVariableModulatorHost } from "./variable-paint-host";
import { VariableValueCell } from "./VariableValueCell";
import { useVariableValue } from "./use-variable-value";
import { VARIABLE_TYPE_META, VariableSwatch, variableValueLabel } from "./variable-meta";
import { isTypingTarget } from "@/editor/input/typing-target";
import { NAMES } from "@/editor/names";

/**
 * The variables TABLE — the browser's right half.
 *
 * It is a table rather than a list of cards because a variable is compared far
 * more often than it is admired: which of these two greys is the one on the
 * button, which of these is used nowhere. Columns make that a glance. The
 * selection model is the app's file-manager one — click, shift-range,
 * cmd-toggle, and a marquee over empty space — because this IS a file manager
 * over a different kind of file, and giving it a fourth selection dialect would
 * have been a fourth set of bugs.
 */

/** The height of one row (`h-10`). */
const ROW_HEIGHT = 40;

/**
 * The variable clipboard — ids, held in the module.
 *
 * Ids rather than copies because a paste is `duplicateVariables`, the same op
 * the context menu's Duplicate already uses: it re-mints ids, uniquifies names
 * and drops the driver (a copied driver would silently give one graph socket
 * two owners). Reusing it means copy/paste cannot drift from duplicate, and
 * pasting into a folder is the SAME call with a folder argument.
 *
 * It survives the window closing, which is the point — copy in one folder, open
 * another, paste. Cross-document transfer is what the export/import buttons are
 * for; a clipboard that silently referenced variables from a document you have
 * since closed would be worse than not offering it.
 */
let variableClipboard: string[] = [];

export interface VariablesTableProps {
  rows: Variable[];
  selected: string[];
  onSelected: (ids: string[]) => void;
  /** The folder new rows land in — shown in the empty state's copy. */
  folderId: string | null;
  emptyAction?: React.ReactNode;
}

export function VariablesTable({ rows, selected, onSelected, folderId, emptyAction }: VariablesTableProps) {
  const doc = useDoc();
  const store = useDocStore();
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const baseRef = React.useRef<string[]>([]);
  const lastIndex = React.useRef<number | null>(null);

  /** Every row is `h-10` — 40px plus the 1px the flow gives it. Fixed by
   *  design: a table's rows are uniform, which is what makes columns scannable. */
  const { start, end, padTop, padBottom } = useVirtualRows({
    count: rows.length,
    rowHeight: ROW_HEIGHT,
    viewportRef: scrollRef,
  });

  const { onPointerDown, marqueeNode } = useSweepSelect(scrollRef, "data-var-id", {
    onDragStart: (additive) => void (baseRef.current = additive ? [...selected] : []),
    onSweep: (hits) => onSelected([...new Set([...baseRef.current, ...hits])]),
    onClear: () => onSelected([]),
  });

  const click = (e: React.MouseEvent, id: string, index: number) => {
    if (e.shiftKey && lastIndex.current !== null) {
      const [a, b] = [lastIndex.current, index].sort((x, y) => x - y) as [number, number];
      onSelected([...new Set([...selected, ...rows.slice(a, b + 1).map((r) => r.id)])]);
      return;
    }
    lastIndex.current = index;
    if (e.metaKey || e.ctrlKey) {
      onSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
      return;
    }
    onSelected([id]);
  };

  /** What a drag carries. The rows being dragged are the SELECTION if the
   *  grabbed row is in it, otherwise just the grabbed row — the rule every file
   *  manager uses, and the one that stops a drag silently discarding a
   *  selection you forgot you had. */
  const dragIds = (id: string) => (selected.includes(id) ? selected : [id]);

  const copy = () => {
    if (selected.length > 0) variableClipboard = [...selected];
  };
  const paste = () => {
    if (variableClipboard.length === 0) return;
    store.update("Paste variables", (d) => {
      const made = duplicateVariables(d, variableClipboard, folderId);
      // Land the pasted rows selected, so the next gesture acts on what you
      // just made rather than on what you copied from.
      queueMicrotask(() => onSelected(made.map((v) => v.id)));
    });
  };

  /** The file-manager verbs, on the keys every file manager uses. The context
   *  menu offers the same four — a gesture people reach for blind should not be
   *  the only way in, and a menu item should not be the only way either. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    // A row's name field owns every key while the caret is in it — ⌘A included.
    // This container used to claim ⌘A/⌘C/⌘V/⌘D unconditionally and guard only
    // Backspace, so "select all the text I am typing" selected all the ROWS
    // instead and the field never saw the keystroke.
    if (isTypingTarget(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "c") return void (copy(), e.preventDefault());
    if (mod && e.key === "v") return void (paste(), e.preventDefault());
    if (mod && e.key === "d") {
      e.preventDefault();
      if (selected.length > 0) {
        store.update("Duplicate variables", (d) => void duplicateVariables(d, selected));
      }
      return;
    }
    if (mod && e.key === "a") {
      e.preventDefault();
      onSelected(rows.map((r) => r.id));
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (selected.length > 0) remove(selected);
    }
  };

  const remove = (ids: string[]) =>
    store.update(ids.length > 1 ? `Delete ${ids.length} variables` : "Delete variable", (d) => {
      for (const id of ids) deleteVariable(d, id);
    });

  if (rows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-xs text-muted-foreground">Nothing here yet.</p>
        {emptyAction}
      </div>
    );
  }

  return (
    <ScrollArea fill className="min-h-0 flex-1" viewportRef={scrollRef}>
      {/* `tabIndex` so the list can hold focus and answer for the keys above;
          clicking any row puts focus here. */}
      <div className="relative p-1.5 outline-none" tabIndex={-1} onKeyDown={onKeyDown} onPointerDown={onPointerDown}>
        {/* Only the rows on screen are built. A row here is a swatch canvas, a
            typed editor and three Radix roots, so a hundred variables were
            constructing three hundred popover roots for clicks that had not
            happened — which is the whole of "opening Variables freezes the
            app". Spacers stand in for the rest so the scrollbar still tells the
            truth about how much there is. */}
        {padTop > 0 && <div style={{ height: padTop }} />}
        {rows.slice(start, end).map((v, n) => (
          <VariableRow
            key={v.id}
            variable={v}
            index={start + n}
            selected={selected.includes(v.id)}
            onClick={(e) => click(e, v.id, start + n)}
            dragIds={dragIds}
            onDuplicate={() =>
              store.update("Duplicate variable", (d) => void duplicateVariables(d, dragIds(v.id)))
            }
            onCopy={() => {
              if (!selected.includes(v.id)) onSelected([v.id]);
              variableClipboard = selected.includes(v.id) ? [...selected] : [v.id];
            }}
            onPaste={paste}
            canPaste={variableClipboard.length > 0}
            onDelete={() => remove(dragIds(v.id))}
            onUnfile={() => store.update("Move to root", (d) => moveVariables(d, dragIds(v.id), null))}
            folderName={
              v.folderId ? (variableFolderPath(doc, v.folderId).at(-1)?.name ?? null) : null
            }
            showFolder={folderId === null}
          />
        ))}
        {padBottom > 0 && <div style={{ height: padBottom }} />}
        {marqueeNode}
      </div>
    </ScrollArea>
  );
}

function VariableRow({
  variable,
  selected,
  onClick,
  dragIds,
  onDuplicate,
  onCopy,
  onPaste,
  canPaste,
  onDelete,
  onUnfile,
  folderName,
  showFolder,
}: {
  variable: Variable;
  index: number;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  dragIds: (id: string) => string[];
  onDuplicate: () => void;
  onCopy: () => void;
  onPaste: () => void;
  canPaste: boolean;
  onDelete: () => void;
  onUnfile: () => void;
  folderName: string | null;
  showFolder: boolean;
}) {
  const store = useDocStore();
  const [name, setName] = React.useState(variable.name);
  React.useEffect(() => setName(variable.name), [variable.name]);
  const { value, setValue } = useVariableValue(variable);
  const modulatorHost = useVariableModulatorHost(store, variable);
  const editsInSwatch = VARIABLE_TYPE_META[variable.type].editsInSwatch ?? false;

  // Bindings reference by id, so a rename ALWAYS keeps every usage linked —
  // no confirm needed (Figma and CSS custom properties both rename silently).
  const commitRename = () => {
    const next = name.trim();
    if (!next || next === variable.name) return void setName(variable.name);
    store.update("Rename variable", (d) => renameVariable(d, variable.id, next));
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-var-id={variable.id}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(NAMES.wire.variablesDrag, JSON.stringify(dragIds(variable.id)));
            e.dataTransfer.effectAllowed = "move";
          }}
          onPointerDown={onClick}
          className={cn(
            "group/var flex h-10 items-center gap-2.5 rounded-lg px-2 transition-colors",
            selected ? "material-glass-raised" : "hover:bg-muted/40",
          )}
        >
          {/* ONE badge per row, and the rule comes from the TYPE.

              A colour and a fill are both edited by clicking a square, so for
              them the leading badge IS the editor and there is no second one.
              Types that need a real field keep a preview here and their field
              in the value column, because a font weight cannot be typed into
              24 pixels.

              Asking `VARIABLE_TYPE_META` rather than naming types here is the
              point: the first version of this special-cased `paint`, so fills
              got one badge and colours kept two — the same duplication, moved. */}
          {editsInSwatch ? (
            <VariableValueCell variable={variable} value={value} onChange={setValue} className="size-6 rounded-[7px]" />
          ) : (
            <VariableSwatch variable={variable} value={value} className="size-6 rounded-[7px]" />
          )}

          <input
            value={name}
            aria-label="Variable name"
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setName(variable.name);
            }}
            onBlur={commitRename}
            className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-xs outline-none transition-colors hover:border-border/70 focus:border-primary/60 focus:bg-input/40"
          />

          {showFolder && folderName && (
            <span className="hidden shrink-0 rounded material-chip px-1.5 py-0.5 text-[10px] text-muted-foreground @[560px]:inline">
              {folderName}
            </span>
          )}

          <span className="hidden w-28 shrink-0 truncate text-right font-mono text-[10px] tabular-nums text-muted-foreground @[480px]:inline">
            {variableValueLabel(variable, value)}
          </span>

          {!editsInSwatch && (
            <VariableValueCell variable={variable} value={value} onChange={setValue} />
          )}
          {/* Only NUMBERS take a modulator here: there is no meaningful signal
              to add to a colour or a font family, and offering one would be a
              promise nothing can keep. A FILL's modulators live on its
              sub-properties, inside the paint editor, where the angle and the
              scale they shape actually are. */}
          {variable.type === "number" && (
            <ModulatorControl host={modulatorHost} path={VARIABLE_TRACK_KEY} label={variable.name} />
          )}
          <VariableKeyControl variable={variable} />

          <span className="w-8 shrink-0 text-right text-[10px] text-muted-foreground/60">
            {VARIABLE_TYPE_META[variable.type].label}
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onCopy}>
          <ClipboardCopy /> Copy
        </ContextMenuItem>
        <ContextMenuItem onSelect={onPaste} disabled={!canPaste}>
          <ClipboardPaste /> Paste
        </ContextMenuItem>
        <ContextMenuItem onSelect={onDuplicate}>
          <Copy /> Duplicate
        </ContextMenuItem>
        {variable.folderId && (
          <ContextMenuItem onSelect={onUnfile}>
            <FolderInput /> Move to root
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
          <Trash2 /> Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
