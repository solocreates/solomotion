"use client";

import * as React from "react";
import { Check, Loader2, Search, SlidersHorizontal, X } from "lucide-react";
import { LayoutGrid, List } from "lucide-react";
import { Popover, PopoverBody, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ZoomControl } from "@/components/ui/zoom-control";
import { cn } from "@/lib/utils";
import type { usePanelZoom } from "../state/use-panel-zoom";

/**
 * THE BROWSER CHROME — one search field and one filter popover, shared by the
 * Library and the Media panel.
 *
 * They are the same object doing the same job and had drifted into two: two
 * search fields (one `Input`-based at h-8 with its own clear button, one a
 * hand-rolled h-7 box), two filter popovers at different widths, two sort
 * menus in different components (a dropdown here, a toggle group there), and
 * two zoom rows. Nothing about "narrow a list of things" differs between
 * browsing presets and browsing files, so nothing about the controls should.
 *
 * What DOES differ is what there is to filter BY — sources and tags in the
 * library, kinds and folders in media — so that is the parameter. Groups are a
 * list of instances rather than a fixed set of fields, which is the difference
 * between adding a filter and editing this file.
 */

export interface FilterOption {
  value: string;
  label: string;
  /** Shown right-aligned when known. Omit rather than passing 0. */
  count?: number;
}

export interface FilterGroup {
  id: string;
  label: string;
  options: FilterOption[];
  selected: readonly string[];
  onToggle: (value: string) => void;
}

export interface SortOption<T extends string = string> {
  value: T;
  label: string;
}

/* -------------------------------------------------------------------------- */

/**
 * The search field. `Search` — one word, because a field with a magnifier in it
 * does not need a sentence explaining that you may type in it, and
 * "Search the library…  #tags work" was documentation wearing a placeholder's
 * clothes. Hashtags still work; they are discoverable by doing, like everywhere
 * else that has them.
 */
export function BrowserSearch({
  value,
  onChange,
  loading = false,
  placeholder = "Search",
  className,
  scope,
  onLeaveScope,
}: {
  value: string;
  onChange: (value: string) => void;
  loading?: boolean;
  placeholder?: string;
  className?: string;
  /**
   * What the search is narrowed to, drawn as a token in the field (Raycast's
   * grammar): ⌫ on an empty field or the token's × leaves it.
   */
  scope?: string;
  onLeaveScope?: () => void;
}) {
  return (
    <div
      className={cn(
        "flex h-(--control-h) min-w-0 flex-1 items-center gap-1.5 rounded-md border border-transparent bg-input/45 px-2 transition-colors focus-within:border-primary/60",
        className,
      )}
    >
      {loading ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      {scope && (
        <span className="flex h-5 shrink-0 items-center gap-0.5 rounded-(--r-xs) bg-primary/12 pl-1.5 pr-0.5 font-mono text-meta text-primary">
          {scope}
          <button
            type="button"
            aria-label={`Leave ${scope}`}
            onClick={onLeaveScope}
            className="flex size-4 items-center justify-center rounded-(--r-xs) text-primary/70 hover:text-primary"
          >
            <X className="size-2.5" />
          </button>
        </span>
      )}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onChange("");
          else if (e.key === "Backspace" && !value && scope) onLeaveScope?.();
        }}
        placeholder={placeholder}
        className="w-full min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear"
          onClick={() => onChange("")}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

/**
 * The filter popover: view, zoom, sort, then whatever this panel filters by.
 *
 * Sources and tags were chips — little rounded outlines you toggle. Chips are
 * honest for five things and dishonest for forty: they wrap into a block that
 * grows with the catalogue, they give no room for a count, and "on" versus
 * "off" is carried by a border colour you have to compare against a neighbour
 * to read. A checkbox list has one column of state you can scan straight down,
 * room for the count that tells you whether a filter is worth pressing, and it
 * does not reflow when the catalogue does.
 */
export function BrowserFilters({
  view,
  onView,
  zoom,
  sort,
  sorts,
  onSort,
  groups,
  onClear,
}: {
  view?: "grid" | "list";
  onView?: (view: "grid" | "list") => void;
  zoom?: ReturnType<typeof usePanelZoom>;
  sort?: string;
  sorts?: readonly SortOption[];
  onSort?: (value: string) => void;
  groups?: readonly FilterGroup[];
  onClear?: () => void;
}) {
  const active = (groups ?? []).some((g) => g.selected.length > 0);

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="View and filters"
              className={cn(
                "relative flex size-(--control-h) shrink-0 items-center justify-center rounded-md transition-colors [&_svg]:size-3.5",
                active
                  ? "material-glass-raised text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <SlidersHorizontal />
              {active && <span className="absolute right-1 top-1 size-1 rounded-full bg-primary" />}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">View and filters</TooltipContent>
      </Tooltip>

      <PopoverContent align="end" className="w-60 p-0">
        <PopoverBody className="max-h-[min(70vh,26rem)]" viewportClassName="p-3" contentClassName="flex flex-col gap-3">
          {view && onView && (
            <Row label="View">
              <ToggleGroup
                type="single"
                size="sm"
                value={view}
                onValueChange={(v) => v && onView(v as "grid" | "list")}
                className="w-full"
              >
                <ToggleGroupItem value="grid" className="h-7 flex-1 gap-1.5 text-[11px] [&_svg]:size-3">
                  <LayoutGrid /> Grid
                </ToggleGroupItem>
                <ToggleGroupItem value="list" className="h-7 flex-1 gap-1.5 text-[11px] [&_svg]:size-3">
                  <List /> List
                </ToggleGroupItem>
              </ToggleGroup>
            </Row>
          )}

          {zoom && (
            <Row label="Size">
              {/* THE zoom dial — the same instrument the stage, timeline, node
                  board and curve panel use, so it is learned once. */}
              <ZoomControl
                value={zoom.level}
                min={zoom.min}
                max={zoom.max}
                scale="log"
                size="sm"
                length={132}
                title="Drag, scroll or ± ; double-click to reset"
                aria-label="Card size"
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={zoom.setLevel}
                onReset={zoom.reset}
              />
            </Row>
          )}

          {sorts?.length && onSort ? (
            <Row label="Sort">
              <div className="flex flex-col">
                {sorts.map((s) => (
                  <CheckRow
                    key={s.value}
                    label={s.label}
                    checked={sort === s.value}
                    radio
                    onToggle={() => onSort(s.value)}
                  />
                ))}
              </div>
            </Row>
          ) : null}

          {groups?.map((group) =>
            group.options.length ? (
              <Row key={group.id} label={group.label}>
                <div className="flex flex-col">
                  {group.options.map((opt) => (
                    <CheckRow
                      key={opt.value}
                      label={opt.label}
                      count={opt.count}
                      checked={group.selected.includes(opt.value)}
                      onToggle={() => group.onToggle(opt.value)}
                    />
                  ))}
                </div>
              </Row>
            ) : null,
          )}

          {active && onClear && (
            <button
              type="button"
              onClick={onClear}
              className="self-start text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Clear filters
            </button>
          )}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * One line of the list. The box carries the state, the label carries the name
 * and the count sits right — three columns that line up down the whole list, so
 * "what is on" is one glance down the left edge instead of a colour comparison
 * between neighbours.
 *
 * `radio` is a look, not a second component: a sort is one-of-many and a filter
 * is any-of-many, and the only honest difference is whether the mark is round.
 */
function CheckRow({
  label,
  count,
  checked,
  radio = false,
  onToggle,
}: {
  label: string;
  count?: number;
  checked: boolean;
  radio?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role={radio ? "radio" : "checkbox"}
      aria-checked={checked}
      onClick={onToggle}
      className="group flex h-7 items-center gap-2 rounded-md px-1.5 text-left text-[11px] transition-colors hover:bg-accent/50"
    >
      <span
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center border transition-colors [&_svg]:size-2.5",
          radio ? "rounded-full" : "rounded-[4px]",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border group-hover:border-primary/50",
        )}
      >
        {checked && (radio ? <span className="size-1.5 rounded-full bg-current" /> : <Check />)}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{count}</span>
      )}
    </button>
  );
}

/**
 * A frame tile's hairline (the `studio` browsers), drawn OVER the picture so a
 * full-bleed preview cannot cover it: quiet at rest, brighter on hover, the
 * accent when on (selected, or on the selection), the warning tone when the
 * bytes are missing. Needs a `group` and a positioned, rounded parent.
 */
export function FrameEdge({ tone = "rest" }: { tone?: "rest" | "on" | "warn" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 rounded-[inherit] ring-inset transition-shadow",
        tone === "on"
          ? "ring-2 ring-primary"
          : tone === "warn"
            ? "ring-1 ring-warning/70"
            : "ring-1 ring-line group-hover:ring-fg/25 group-focus-visible:ring-2 group-focus-visible:ring-primary",
      )}
    />
  );
}
