"use client";

import * as React from "react";
import { ArrowUpDown, LayoutGrid, List, Search, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { SortKey } from "./model/tree";
import { useFiler, type FilerStore } from "./use-file-manager";

/**
 * Filer controls: a plain search field, sort, and the grid/list switch.
 *
 * The search used to advertise `*` and hide a "search all folders" switch in a
 * popover. Nobody browsing their projects types a wildcard; the surface sets
 * recursive search once and the field just searches. New folder and Recently
 * Deleted moved to the sidebar, where a file browser keeps them.
 */

export type FilerLayout = "grid" | "list";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "updated", label: "Last edited" },
  { key: "created", label: "Date created" },
  { key: "name", label: "Name" },
];

const LAYOUTS = [
  { value: "grid" as const, label: "Grid", icon: LayoutGrid },
  { value: "list" as const, label: "List", icon: List },
];

export function FilerToolbar<T>({
  fm,
  layout,
  onLayout,
  placeholder = "Search",
}: {
  fm: FilerStore<T>;
  layout: FilerLayout;
  onLayout: (layout: FilerLayout) => void;
  placeholder?: string;
}) {
  const query = useFiler(fm, (s) => s.search.query);
  const sort = useFiler(fm, (s) => s.sort);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {/* The field GIVES: on a phone it absorbs the whole difference, so the
          two controls after it never fall off the edge. */}
      <label className="flex h-(--control-h-lg) min-w-28 max-w-80 flex-1 items-center gap-2 rounded-md bg-raised px-2.5 text-fg-muted focus-within:text-fg">
        <Search className="size-4 shrink-0" />
        <input
          value={query}
          onChange={(e) => fm.getState().setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && fm.getState().setSearch("")}
          placeholder={placeholder}
          aria-label={placeholder}
          className="min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-faint"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => fm.getState().setSearch("")}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-hover [&_svg]:size-3.5"
          >
            <X />
          </button>
        )}
      </label>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Sort"
                  className="flex h-(--control-h-lg) shrink-0 items-center gap-1.5 rounded-md px-2 text-body text-fg-muted hover:bg-hover hover:text-fg data-[state=open]:bg-hover [&_svg]:size-4"
                >
                  <ArrowUpDown />
                  <span className="hidden sm:inline">{SORTS.find((s) => s.key === sort.key)?.label}</span>
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Sort</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            {SORTS.map((sp) => (
              <DropdownMenuCheckboxItem
                key={sp.key}
                checked={sort.key === sp.key}
                onSelect={(e) => {
                  e.preventDefault();
                  // Names read A→Z first; dates read newest first.
                  fm.getState().setSort({ key: sp.key, dir: sp.key === "name" ? "asc" : "desc" });
                }}
              >
                {sp.label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={sort.dir === (sort.key === "name" ? "desc" : "asc")}
              onSelect={(e) => {
                e.preventDefault();
                fm.getState().setSort({ key: sort.key, dir: sort.dir === "asc" ? "desc" : "asc" });
              }}
            >
              {sort.key === "name" ? "Z to A" : "Oldest first"}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Icons only: two glyphs everyone reads, and the room goes to search. */}
        <div role="radiogroup" aria-label="Layout" className="flex h-(--control-h-lg) items-center rounded-md bg-raised p-0.5">
          {LAYOUTS.map(({ value, label, icon: Icon }) => (
            <Tooltip key={value}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-checked={layout === value}
                  aria-label={label}
                  onClick={() => onLayout(value)}
                  className={cn(
                    "flex h-full w-7 items-center justify-center rounded-sm [&_svg]:size-4",
                    layout === value ? "bg-selection text-selection-fg" : "text-fg-muted hover:text-fg",
                  )}
                >
                  <Icon />
                </button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
    </div>
  );
}
