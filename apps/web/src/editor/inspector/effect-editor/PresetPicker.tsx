"use client";

import * as React from "react";
import { activePreset, groupPresets, PRESET_SCOPES, type Preset, type PresetScope } from "@solomotion/core";
import { BookmarkPlus, Check, ChevronDown, Pencil, Trash2 } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { saveToLibrary } from "../../presets/SaveToLibraryDialog";
import { usePresets } from "./use-presets";

/**
 * THE preset picker — searchable, scoped, and identical for every preset kind.
 *
 * The three scopes are tabs rather than three separate menus because they are
 * the same list seen from different distances: what ships, what this project
 * carries, and what this device remembers. Saving asks WHICH scope in the same
 * breath as the name, so "just for this project" is one click, not a settings
 * trip — and a project preset travels inside the slice file.
 *
 * Closed and focused, ArrowUp/Down step through the presets and apply each one
 * live — the native-`<select>` feel every Select and the font picker already
 * have. Auditioning ten glass looks is ten keystrokes, not ten open-scroll-
 * click trips, and the stage shows each as you pass it.
 */
export function PresetPicker({
  kind,
  /** The current values, saved verbatim when the user names a new preset. */
  capture,
  onApply,
  /** Swatch for a preset the user saves (e.g. the effect's dominant colours). */
  chipFor,
  current: matchable,
  label = "Presets",
  defaultName,
  showLabel,
  saveLabel = "Save current as preset",
  saveTitle = "Save preset",
  saveDescription = "Reuse this look on any layer, in this project or everywhere.",
}: {
  kind: string;
  capture: () => unknown;
  /** What the trigger matches presets against, when that is not what Save keeps (a look fitted to its comp is still that look). Default: `capture`. */
  current?: () => unknown;
  onApply: (data: unknown, preset: Preset) => void;
  chipFor?: () => [string, string] | null;
  label?: string;
  /** Suggested name when saving (the effect's own label). */
  defaultName?: string;
  /** Read `label` instead of "Custom" when nothing matches — an empty stack
   *  is not a custom look, it is nothing yet. */
  showLabel?: boolean;
  saveLabel?: string;
  saveTitle?: string;
  saveDescription?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [scope, setScope] = React.useState<PresetScope | "all">("all");
  const { presets, save, remove, rename } = usePresets(kind, query);

  const shown = scope === "all" ? presets : presets.filter((p) => p.scope === scope);
  const groups = groupPresets(shown);

  // What the card currently IS. Derived every render rather than stored, so it
  // cannot go stale behind a slider, a keyframe, a node driver or a paste —
  // see `activePreset`. `all` (not `shown`) so the trigger keeps naming the
  // live look while you filter the list by scope.
  const current = (matchable ?? capture)() as Record<string, unknown> | readonly unknown[];
  const active = activePreset(presets, current);

  // Closed + focused: arrows walk the whole list (every scope, in list order)
  // and apply as they go. From a custom look the first step lands on the
  // first preset, which is where a walk should start.
  const cycle = (dir: 1 | -1) => {
    if (presets.length === 0) return;
    const at = active ? presets.findIndex((p) => p.id === active.id) : -1;
    const next = presets[(at + dir + presets.length) % presets.length];
    if (next) onApply(next.data, next);
  };

  const doSave = () => {
    setOpen(false);
    saveToLibrary({
      title: saveTitle,
      description: saveDescription,
      defaultName: defaultName ?? "My preset",
      onSave: (label, target) => {
        save(target, label, capture(), { chip: chipFor?.() ?? null, group: "Saved" });
        toast(`Saved “${label}” — ${target === "project" ? "in this project" : "for every project"}`);
      },
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={active ? `${active.name} — ↑↓ to step through presets` : showLabel ? label : "Custom — save it to reuse it"}
          onKeyDown={(e) => {
            if (open) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              cycle(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              cycle(-1);
            }
          }}
          className="flex h-6 max-w-[11rem] items-center gap-1 rounded-md border border-border/70 bg-secondary/40 px-2 text-[11px] font-medium text-foreground/90 transition-colors hover:bg-secondary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring [&_svg]:size-3"
        >
          {active && (
            <span
              className="size-2.5 shrink-0 rounded-full border border-border/60"
              style={{
                background: active.chip
                  ? `linear-gradient(135deg, ${active.chip[0]}, ${active.chip[1]})`
                  : "linear-gradient(135deg, var(--muted), var(--secondary))",
              }}
            />
          )}
          {/* Naming the live look is the point — "Custom" is a real state, not
              an empty one, and reads as "you have gone somewhere of your own". */}
          <span className={cn("truncate", !active && "text-muted-foreground")}>
            {active ? active.name : presets.length > 0 && !showLabel ? "Custom" : label}
          </span>
          <ChevronDown className="shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        {/* Search lives INSIDE cmdk so ↑/↓/Enter walk the list — the same
            keyboard model as the add-effect palette. Filtering is ours (it
            matches names, groups and tags in the library brain), so cmdk's own
            fuzzy pass is switched off. */}
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder="Search presets…" autoFocus />
          <div className="flex gap-0.5 border-b border-border/60 px-1.5 py-1">
            <ScopeTab id="all" label="All" count={presets.length} active={scope} onPick={setScope} />
            {PRESET_SCOPES.map((s) => (
              <ScopeTab
                key={s.id}
                id={s.id}
                label={s.label}
                title={s.hint}
                count={presets.filter((p) => p.scope === s.id).length}
                active={scope}
                onPick={setScope}
              />
            ))}
          </div>
          <CommandList className="max-h-72">
            {shown.length === 0 && <CommandEmpty>No presets here yet.</CommandEmpty>}
            {groups.map(({ group, items }) => (
              <CommandGroup key={group ?? "_"} heading={group ?? "Presets"}>
                {items.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={p.id}
                    onSelect={() => {
                      onApply(p.data, p);
                      setOpen(false);
                    }}
                    className="gap-2"
                  >
                    <span
                      className="size-4 shrink-0 rounded-full border border-border/60"
                      style={{
                        background: p.chip
                          ? `linear-gradient(135deg, ${p.chip[0]}, ${p.chip[1]})`
                          : "linear-gradient(135deg, var(--muted), var(--secondary))",
                      }}
                    />
                    <span className="flex-1 truncate text-[12px]">{p.name}</span>
                    {active?.id === p.id && <Check className="size-3 shrink-0 text-primary" />}
                    {p.scope !== "builtin" && (
                      <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-aria-selected:opacity-100">
                        <IconAction
                          label="Rename preset"
                          onClick={() =>
                            saveToLibrary({
                              title: "Rename preset",
                              defaultName: p.name,
                              scopeless: true,
                              confirmLabel: "Rename",
                              onSave: (next) => rename(p, next),
                            })
                          }
                        >
                          <Pencil />
                        </IconAction>
                        <IconAction label="Delete preset" danger onClick={() => remove(p)}>
                          <Trash2 />
                        </IconAction>
                      </span>
                    )}
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                      {p.scope === "builtin" ? "" : p.scope === "project" ? "proj" : "dev"}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
        <div className="border-t border-border/60 p-1.5">
          <button
            type="button"
            onClick={doSave}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border/80 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground [&_svg]:size-3.5"
          >
            <BookmarkPlus /> {saveLabel}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ScopeTab({
  id,
  label,
  title,
  count,
  active,
  onPick,
}: {
  id: PresetScope | "all";
  label: string;
  title?: string;
  count: number;
  active: PresetScope | "all";
  onPick: (v: PresetScope | "all") => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={() => onPick(id)}
      className={cn(
        "flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium transition-colors",
        active === id ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
        count === 0 && active !== id && "opacity-50",
      )}
    >
      {label}
      <span className="text-[10px] tabular-nums opacity-60">{count}</span>
    </button>
  );
}

function IconAction({
  children,
  label,
  danger,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex size-5 items-center justify-center rounded text-muted-foreground/70 [&_svg]:size-3",
        danger ? "hover:text-destructive" : "hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
