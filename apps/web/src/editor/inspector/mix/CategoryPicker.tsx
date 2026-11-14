"use client";

import * as React from "react";
import { ChevronDown, Plus } from "lucide-react";
import { createSoundBus, type SoundBus } from "@solomotion/core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../../state/document-context";
import { useBusMembers } from "./use-mix";

/** A category's colour, as the one mark every surface draws it with. */
export function BusDot({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", className)} style={{ background: color }} />;
}

/**
 * Pick the category a sound routes into. "Auto" is a real choice, not an
 * empty one: it names what the route resolves to without a tag (a nested
 * parent's category, or Effects for fired sounds), so leaving it alone is an
 * informed decision. "New category" creates one and routes into it in the same
 * step — naming it is one click away in its own panel.
 */
export function CategoryPicker({
  value,
  mixed,
  inherited,
  onChange,
  onCreated,
}: {
  /** The explicit tag, or null for Auto. */
  value: string | null;
  mixed?: boolean;
  /** What Auto resolves to here, if anything. */
  inherited: SoundBus | null;
  onChange: (busId: string | null) => void;
  /** A new category was made and routed to — the caller may open it. */
  onCreated?: (busId: string) => void;
}) {
  const doc = useDoc();
  const store = useDocStore();
  const members = useBusMembers();
  const current = value ? doc.soundBuses.find((b) => b.id === value) ?? null : null;
  const shown = current ?? inherited;

  const create = () => {
    let id = "";
    store.update("New sound category", (d) => void (id = createSoundBus(d, { name: `Category ${d.soundBuses.filter((b) => !b.builtIn).length + 1}` })));
    if (!id) return;
    onChange(id);
    onCreated?.(id);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-input/35 px-2 text-xs transition-colors hover:bg-input/55"
        >
          {mixed ? (
            <span className="flex-1 truncate text-left text-muted-foreground">Mixed</span>
          ) : (
            <>
              {shown && <BusDot color={shown.color} />}
              <span className="flex-1 truncate text-left">
                {current ? current.name : shown ? `Auto · ${shown.name}` : "Auto"}
              </span>
            </>
          )}
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <span className="flex-1">Auto</span>
          {inherited && <span className="text-[11px] text-muted-foreground">{inherited.name}</span>}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {doc.soundBuses.map((bus) => (
          <DropdownMenuItem key={bus.id} onSelect={() => onChange(bus.id)}>
            <BusDot color={bus.color} />
            <span className="flex-1 truncate">{bus.name}</span>
            <span className="font-mono text-[10px] text-muted-foreground">{members.get(bus.id)?.length ?? 0}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={create}>
          <Plus className="size-3.5" />
          New category
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
