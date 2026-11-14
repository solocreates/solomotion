"use client";

import { identity } from "@/editor/identity";
import * as React from "react";
import {
  addVariable,
  exportVariables,
  importVariables,
  isVariableFile,
  moveVariables,
  variableFolderPath,
  variableUsage,
  type Variable,
  type VariableType,
} from "@solomotion/core";
import { Boxes, Download, Plus, Upload } from "lucide-react";
import { FloatingWindow, type WindowBounds } from "@/components/ui/floating-window";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../../state/document-context";
import { useSession } from "../../state/session";
import { VariablesRail, type RailSelection } from "./VariablesRail";
import { VariablesTable } from "./VariablesTable";
import { VARIABLE_TYPE_META, VARIABLE_TYPE_ORDER } from "./variable-meta";
import { ENGINE } from "@/editor/names";

/**
 * The Variables window — one browser for every reusable value in the document.
 *
 * The layout is the app's own grammar rather than a window-specific invention:
 * the shell ground with two cards floating on it, a rail on the left that lives
 * OUTSIDE what it filters, and a full-height scroll region in each. That is the
 * same shape as the editor's side panels, so nothing here has to be learned
 * twice — and it is why the old bordered, boxes-inside-boxes panel read as
 * belonging to a different app.
 *
 * Responsiveness rides the FloatingWindow's `@container`, so the rail collapses
 * on a narrow window and the table sheds its optional columns without a resize
 * listener or a breakpoint that only knows about the viewport.
 */
export function VariablesWindow() {
  const open = useSession((s) => s.variablesOpen);
  const setOpen = useSession((s) => s.setVariablesOpen);
  const [bounds, setBounds] = React.useState<WindowBounds | null>(null);

  // Wide by default. This is a browser, not an inspector strip: a table you
  // have to scroll horizontally to compare two greys in is a table that has
  // already failed at the one thing it is for.
  React.useEffect(() => {
    if (open && !bounds) {
      const width = Math.min(940, window.innerWidth - 80);
      const height = Math.min(620, window.innerHeight - 120);
      setBounds({
        x: Math.max(24, (window.innerWidth - width) / 2),
        y: Math.max(24, (window.innerHeight - height) / 2),
        width,
        height,
        minimized: false,
      });
    }
  }, [open, bounds]);

  if (!open || !bounds) return null;

  return (
    <FloatingWindow
      title="Variables"
      icon={<Boxes />}
      bounds={bounds}
      windowId="variables"
      minWidth={420}
      minHeight={320}
      onBoundsChange={(patch) => setBounds((b) => (b ? { ...b, ...patch } : b))}
      onToggleMinimize={() => setBounds((b) => (b ? { ...b, minimized: !b.minimized } : b))}
      onClose={() => setOpen(false)}
      body="fill"
    >
      <VariablesBrowser />
    </FloatingWindow>
  );
}

function VariablesBrowser() {
  const doc = useDoc();
  const store = useDocStore();
  const focusId = useSession((s) => s.variablesFocusId);
  const clearFocus = useSession((s) => s.clearVariableFocus);
  const [selection, setSelection] = React.useState<RailSelection>({ kind: "type", type: "all" });
  const [selected, setSelected] = React.useState<string[]>([]);
  const [query, setQuery] = React.useState("");
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const usage = React.useMemo(() => variableUsage(doc), [doc]);
  const counts = React.useMemo(() => {
    const c = new Map<VariableType, number>();
    for (const v of doc.variables) c.set(v.type, (c.get(v.type) ?? 0) + 1);
    return c;
  }, [doc.variables]);

  // Something elsewhere asked to edit a style ("Edit style" in the picker).
  // Land ON it: show everything, select it, and drop the request so a later
  // open does not jump back to whatever was last asked for.
  React.useEffect(() => {
    if (!focusId) return;
    setSelection({ kind: "type", type: "all" });
    setQuery("");
    setSelected([focusId]);
    clearFocus();
  }, [focusId, clearFocus]);

  const q = query.trim().toLowerCase();
  const rows = doc.variables.filter((v) => {
    if (q && !v.name.toLowerCase().includes(q)) return false;
    if (selection.kind === "folder") return v.folderId === selection.id;
    return selection.type === "all" || v.type === selection.type;
  });

  /** The folder a new variable lands in, and the one an export covers. */
  const folderId = selection.kind === "folder" ? selection.id : null;
  /** The type "+" makes. On a folder or All, a colour — the overwhelmingly
   *  common case, and the one a person is least surprised to get. */
  const addType: VariableType = selection.kind === "type" && selection.type !== "all" ? selection.type : "color";

  const add = () =>
    store.update(`New ${VARIABLE_TYPE_META[addType].label.toLowerCase()}`, (d) => {
      const made = addVariable(d, addType, VARIABLE_TYPE_META[addType].label, VARIABLE_TYPE_META[addType].defaultValue);
      made.folderId = folderId;
      setSelected([made.id]);
    });

  const exportFile = () => {
    const file = exportVariables(doc, folderId, ENGINE.ns);
    if (file.variables.length === 0) return toast.error("Nothing here to export.");
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${file.name.replace(/[^\w-]+/g, "-").toLowerCase()}.variables.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importFile = async (file: File) => {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!isVariableFile(parsed)) return toast.error("That is not a variables file.");
      store.update("Import variables", (d) => {
        const { variables } = importVariables(d, parsed, folderId);
        setSelected(variables.map((v) => v.id));
      });
    } catch {
      toast.error("Could not read that file.");
    }
  };

  const breadcrumb =
    selection.kind === "folder"
      ? variableFolderPath(doc, selection.id).map((f) => f.name).join(" / ")
      : selection.type === "all"
        ? "All variables"
        : VARIABLE_TYPE_META[selection.type].label;

  return (
    <div className="flex min-h-0 flex-1 gap-2 bg-background p-2">
      {/* The rail lives OUTSIDE the table it filters — the app's rule
          everywhere. Hidden on a narrow window, where the type chips in the
          toolbar take over rather than eating half the width. */}
      <div className="hidden w-52 shrink-0 @[620px]:flex">
        <VariablesRail
          selection={selection}
          onSelect={(s) => {
            setSelection(s);
            setSelected([]);
          }}
          counts={counts}
          onDropInFolder={(id) => {
            if (selected.length === 0) return;
            store.update("File variables", (d) => moveVariables(d, selected, id));
          }}
        />
      </div>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col shell-card">
        <header className="flex shrink-0 items-center gap-1.5 border-b border-border/50 p-2">
          <span className="hidden min-w-0 shrink truncate text-xs font-medium @[620px]:inline">{breadcrumb}</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            spellCheck={false}
            className="h-(--control-h) min-w-0 flex-1 rounded-md border border-transparent bg-input/45 px-2 text-xs outline-none transition-colors hover:border-border focus:border-primary/60"
          />
          <ToolbarButton label="Import variables" onClick={() => fileRef.current?.click()}>
            <Upload />
          </ToolbarButton>
          <ToolbarButton label="Export what's shown" onClick={exportFile}>
            <Download />
          </ToolbarButton>
          <button
            type="button"
            onClick={add}
            className="flex h-(--control-h) items-center gap-1 rounded-md bg-primary/15 px-2 text-[11px] font-medium text-primary transition-colors hover:bg-primary/25 [&_svg]:size-3.5"
          >
            <Plus /> New
          </button>
        </header>

        {/* Narrow window: the rail's type list becomes a chip row so filtering
            never disappears just because the window got small. */}
        <div className="flex shrink-0 flex-wrap gap-1 border-b border-border/50 px-2 py-1.5 @[620px]:hidden">
          <TypeChip label="All" active={selection.kind === "type" && selection.type === "all"} onClick={() => setSelection({ kind: "type", type: "all" })} />
          {VARIABLE_TYPE_ORDER.map((t) => (
            <TypeChip
              key={t}
              label={VARIABLE_TYPE_META[t].label}
              count={counts.get(t) ?? 0}
              active={selection.kind === "type" && selection.type === t}
              onClick={() => setSelection({ kind: "type", type: t })}
            />
          ))}
        </div>

        <VariablesTable
          rows={rows}
          selected={selected}
          onSelected={setSelected}
          folderId={folderId}
          emptyAction={
            <button
              type="button"
              onClick={add}
              className="flex items-center gap-1.5 rounded-md material-glass px-2.5 py-1.5 text-[11px] transition-colors hover:text-primary [&_svg]:size-3.5"
            >
              <Plus /> New {VARIABLE_TYPE_META[addType].label.toLowerCase()}
            </button>
          }
        />

        <footer className="flex h-7 shrink-0 items-center gap-2 border-t border-border/50 px-2.5 text-[10px] text-muted-foreground">
          <span>{rows.length} shown</span>
          {selected.length > 1 && <span className="text-primary">{selected.length} selected</span>}
          <span className="flex-1" />
          <span className="hidden @[520px]:inline">
            {[...usage.values()].reduce((a, b) => a + b, 0)} linked slots
          </span>
        </footer>
      </section>

      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importFile(file);
        }}
      />
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-(--control-h) shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}

function TypeChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-6 items-center gap-1 rounded-md px-2 text-[11px] transition-colors",
        active ? "material-glass-raised text-primary" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {count !== undefined && count > 0 && <span className="font-mono tabular-nums opacity-50">{count}</span>}
    </button>
  );
}

export type { Variable };
