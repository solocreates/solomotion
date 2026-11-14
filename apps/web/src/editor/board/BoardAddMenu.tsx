"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";

/**
 * THE BOARD ADD MENU — Blender's Shift+A, for every board: a searchable,
 * grouped list that opens AT THE CURSOR and drops what you pick at that spot.
 * Portaled to <body> with fixed positioning so it floats over the whole app
 * (never clipped by the board's window) and flips upward near the bottom edge.
 * A board hands it groups of items; what an item makes is the board's.
 */

export interface BoardAddAnchor {
  /** Viewport (client) position to open at. */
  clientX: number;
  clientY: number;
  /** World position the new thing lands at. */
  worldX: number;
  worldY: number;
}

export interface BoardAddItem {
  id: string;
  label: string;
  /** Extra words the search matches. */
  keywords?: string;
  /** A dot of colour beside it (a category, a pose set). */
  color?: string;
  /** A trailing note (a shortcut, a count). */
  note?: string;
}

export interface BoardAddGroup {
  heading: string;
  items: readonly BoardAddItem[];
}

const MENU_W = 248;
const MENU_H = 340;

export function BoardAddMenu({
  anchor,
  groups,
  placeholder = "Add…",
  empty = "Nothing found.",
  onPick,
  onClose,
}: {
  anchor: BoardAddAnchor;
  groups: readonly BoardAddGroup[];
  placeholder?: string;
  empty?: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const id = window.setTimeout(() => window.addEventListener("pointerdown", onDown), 0);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  // Clamp + flip within the viewport so it never spills off-screen.
  const vw = typeof window !== "undefined" ? window.innerWidth : 1920;
  const vh = typeof window !== "undefined" ? window.innerHeight : 1080;
  const left = Math.min(Math.max(8, anchor.clientX), vw - MENU_W - 8);
  const top = anchor.clientY + MENU_H > vh - 8 ? Math.max(8, anchor.clientY - MENU_H) : anchor.clientY;

  const menu = (
    <div ref={ref} className="fixed z-9999" style={{ left, top, width: MENU_W }} onPointerDown={(e) => e.stopPropagation()}>
      <Command className="rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl" loop>
        <CommandInput placeholder={placeholder} autoFocus />
        <CommandList className="max-h-72">
          <CommandEmpty>{empty}</CommandEmpty>
          {groups
            .filter((g) => g.items.length)
            .map((g) => (
              <CommandGroup key={g.heading} heading={g.heading}>
                {g.items.map((it) => (
                  <CommandItem key={it.id} value={`${it.label} ${it.keywords ?? ""} ${it.id}`} onSelect={() => onPick(it.id)} className="gap-2">
                    {it.color && <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: it.color }} />}
                    <span className="min-w-0 flex-1 truncate">{it.label}</span>
                    {it.note && <span className="shrink-0 text-[10px] text-muted-foreground">{it.note}</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
        </CommandList>
      </Command>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(menu, document.body) : menu;
}
