"use client";

import * as React from "react";
import { create } from "zustand";
import { Box, Component, FileText, Film, Frame as FrameIcon, Layers2, type LucideIcon } from "lucide-react";
import { docIndex, searchDocNodes, type DocNode, type DocNodeKind } from "@solomotion/core";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { comboFor, comboFromEvent, formatCombo } from "../state/shortcut-registry";
import { ClipKindIcon } from "../ui/clip-icon";
import { goToNode } from "../links/navigate";

/**
 * ⌘P — GO TO ANYTHING. VS Code's quick open for a motion project: a frame, a
 * 3D world, a component, a nested comp, any layer, a page — type a few
 * letters, Enter, and you are standing in it (inside a world's viewport,
 * inside a nested comp, on the layer with it selected). Typing ">" hands over
 * to the command palette (⌘K), as VS Code's does.
 *
 * Built for big projects: the index is core's `docIndex`, derived once per
 * document snapshot, matching is its cheap subsequence score, and each group
 * shows its best few, so a project with ten thousand layers types as fast as
 * an empty one. Every field that picks from the project runs the same index.
 */

type Kind = Exclude<DocNodeKind, never>;

const GROUPS: Array<{ kind: Kind; heading: string; cap: number; icon?: LucideIcon; tint?: string }> = [
  { kind: "world", heading: "3D worlds", cap: 6, icon: Box, tint: "text-[#FF9F43]" },
  { kind: "frame", heading: "Frames", cap: 8, icon: FrameIcon, tint: "text-(--tool-frame,#B18CFF)" },
  { kind: "component", heading: "Components", cap: 6, icon: Component, tint: "text-[#B79BFF]" },
  { kind: "comp", heading: "Nested comps", cap: 6, icon: Film, tint: "text-muted-foreground" },
  { kind: "layer", heading: "Layers", cap: 12 },
  { kind: "page", heading: "Pages", cap: 4, icon: FileText, tint: "text-muted-foreground" },
];

export const useNavigator = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function Navigator() {
  const open = useNavigator((s) => s.open);
  const setOpen = useNavigator((s) => s.setOpen);
  const doc = useDoc();
  const store = useDocStore();
  const [query, setQuery] = React.useState("");

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (comboFromEvent(e) === comboFor("view.navigator")) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(!useNavigator.getState().open);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [setOpen]);

  React.useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  // Core's index (`query/doc-index.ts`) — the same one every picker reads.
  const index = React.useMemo(() => (open ? docIndex(doc) : []), [open, doc]);
  const activePage = useSession((s) => s.activePageId) ?? doc.pages[0]?.id;
  const q = query.trim().toLowerCase();

  const groups = React.useMemo(() => {
    if (!open) return [];
    return GROUPS.map((g) => {
      let rows = index.filter((it) => it.kind === g.kind);
      if (q) rows = searchDocNodes(rows, q);
      else {
        // Nothing typed: suggestions — every world, this page's frames, the components.
        if (g.kind === "layer" || g.kind === "comp" || g.kind === "page") rows = [];
        if (g.kind === "frame") rows = rows.filter((it) => it.pageId === activePage);
      }
      return { ...g, total: rows.length, rows: rows.slice(0, g.cap) };
    }).filter((g) => g.rows.length > 0);
  }, [open, index, q, doc.pages, activePage]);

  const pick = (it: DocNode) => {
    setOpen(false);
    goToNode(store, it);
  };

  const commandsKey = formatCombo(comboFor("view.palette"));
  return (
    <CommandDialog title="Go to" open={open} onOpenChange={setOpen} commandProps={{ shouldFilter: false, loop: true }}>
      <CommandInput
        value={query}
        onValueChange={(v) => {
          // VS Code: ">" is the way to commands.
          if (v.startsWith(">")) {
            setOpen(false);
            useSession.getState().setCommandPaletteOpen(true);
            return;
          }
          setQuery(v);
        }}
        placeholder="Go to a frame, world, component or layer…"
      />
      <CommandList className="max-h-[min(60vh,28rem)]">
        <CommandEmpty>Nothing called that. Type &gt; for commands.</CommandEmpty>
        {groups.map((g) => (
          <CommandGroup key={g.kind} heading={g.total > g.rows.length ? `${g.heading} · ${g.rows.length} of ${g.total}` : g.heading}>
            {g.rows.map((it) => (
              <CommandItem key={it.key} value={it.key} onSelect={() => pick(it)} className="gap-2.5">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/60">
                  {it.clip ? <ClipKindIcon clip={it.clip} className="size-3.5 text-muted-foreground" /> : g.icon ? <g.icon className={cn("size-3.5", g.tint)} /> : <Layers2 className="size-3.5" />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate text-[13px]">{it.name}</span>
                  <span className="truncate text-2xs text-muted-foreground">{it.where}</span>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      <div className="flex items-center justify-between border-t px-3 py-1.5 text-2xs text-muted-foreground">
        <span>↑↓ to move · ↵ to go</span>
        <span>&gt; commands{commandsKey ? ` (${commandsKey})` : ""}</span>
      </div>
    </CommandDialog>
  );
}
