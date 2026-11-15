"use client";

import * as React from "react";
import { EFFECT_CATEGORIES, type EffectCategory, type EffectDomain } from "@solomotion/core";
import { Plus, Sparkles, type LucideIcon } from "lucide-react";
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

/**
 * THE ADD-EFFECT PALETTE — one searchable window onto every effect in the app.
 *
 * Three things make it a palette rather than a menu, and each answers a way the
 * old one failed:
 *
 * 1. **What you selected comes first.** An effect that declares `appliesTo`
 *    exists *because of* a layer kind — chroma key needs source pixels, a trim
 *    path needs an outline — so when your selection is that kind it is promoted
 *    into a "For this layer" section at the top. It is the single most likely
 *    thing you came here for, and it used to be buried mid-list under Stylize.
 * 2. **Every row says what it DOES.** A column of nouns (Noise, Adjust, Glass)
 *    is a quiz. The registry carries a `blurb`, so the row carries a sentence,
 *    and search covers the blurb and the `tags` too — typing "green screen",
 *    "bloom", "vhs" or "outline" finds the card whatever it is called.
 * 3. **Presets are effects here.** A saved look is a way to add an effect, not
 *    a thing you do after adding one, so it lives in the same list.
 *
 * Grouping order and labels come from the ONE core taxonomy
 * (`EFFECT_CATEGORIES`, filtered by domain), so the visual and audio stacks
 * organise identically and a new effect slots in by declaring its `category`.
 */
export interface EffectMenuItem {
  type: string;
  label: string;
  category: EffectCategory;
  icon: LucideIcon;
  /** One line under the name — what the effect does, in the user's words. */
  blurb?: string;
  /** Extra search terms (registry `tags`). */
  keywords?: readonly string[];
  /** Declares `appliesTo` and matches the selection → promoted to the top. */
  specific?: boolean;
  /** Non-repeatable type already on the clip — shown but not addable. */
  disabled?: boolean;
  /** Right-aligned hint, e.g. "added". */
  badge?: string;
}

export interface EffectAddMenuProps {
  items: EffectMenuItem[];
  onAdd: (type: string) => void;
  /** Icon-only "+" for the section header; otherwise a dashed empty-state row. */
  compact?: boolean;
  /** Empty-state row label + icon (e.g. "Add layer effect"). */
  addLabel?: string;
  emptyIcon?: LucideIcon;
  /** Heading over the promoted section, e.g. "For this image". */
  specificHeading?: string;
  /** Which taxonomy to group by. Defaults to the visual one. */
  domain?: EffectDomain;
  /** Extra group rendered below the built-ins (e.g. saved effects); gets a
   * `close` callback so its items can dismiss the palette after acting. */
  extra?: (close: () => void) => React.ReactNode;
}

/**
 * How well one row matches what was typed.
 *
 * cmdk's default is a fuzzy SUBSEQUENCE score, which is wrong the moment rows
 * carry prose: the letters of "neon" appear, in order, inside "Refracts what is
 * behind the layer", so Liquid glass outranked Glow for its own nickname. What
 * a palette needs is precision — the name first, then the words the user might
 * call it by, and prose last — so this scores those tiers explicitly and
 * returns 0 for anything that does not genuinely contain the query.
 *
 * `keywords` arrive as `[blurb, ...tags]`; tags are the synonyms worth ranking
 * above prose, so a tag hit beats a blurb hit.
 */
function scoreEffectRow(value: string, search: string, keywords?: string[]): number {
  const q = search.trim().toLowerCase();
  if (!q) return 1;
  const label = value.toLowerCase();
  if (label.startsWith(q)) return 1;
  // A match at a word boundary ("long SHADOW") reads as intentional; one buried
  // mid-word ("SHADOW" in "innershadow") is a weaker signal, not a wrong one.
  if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(label)) return 0.9;
  if (label.includes(q)) return 0.8;
  const tags = (keywords ?? []).slice(1).map((k) => k.toLowerCase());
  if (tags.some((t) => t === q)) return 0.7;
  if (tags.some((t) => t.includes(q))) return 0.6;
  const blurb = (keywords?.[0] ?? "").toLowerCase();
  if (blurb.includes(q)) return 0.4;
  return 0;
}

/** One row. Icon tile, name, and the sentence that makes the name legible. */
export function EffectPaletteItem({
  icon: Icon,
  label,
  blurb,
  badge,
  disabled,
  value,
  keywords,
  onSelect,
  trailing,
}: {
  icon: LucideIcon;
  label: string;
  blurb?: string;
  badge?: string;
  disabled?: boolean;
  value: string;
  keywords?: string[];
  onSelect: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <CommandItem
      value={value}
      keywords={keywords}
      disabled={disabled}
      onSelect={onSelect}
      className="items-start gap-2.5 py-1.5"
    >
      <span
        className={cn(
          "mt-px flex size-6 shrink-0 items-center justify-center rounded-[5px] border border-border/60 bg-muted/40 text-muted-foreground",
          "[&_svg]:size-3.5 group-aria-selected:border-primary/30 group-aria-selected:text-foreground",
        )}
      >
        <Icon />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[12px] leading-tight">{label}</span>
          {badge && (
            <span className="shrink-0 rounded-(--r-xs) bg-muted px-1.5 text-[9px] uppercase tracking-wide text-muted-foreground">
              {badge}
            </span>
          )}
        </span>
        {blurb && (
          <span className="truncate text-[10.5px] leading-snug text-muted-foreground/80">{blurb}</span>
        )}
      </span>
      {trailing}
    </CommandItem>
  );
}

export function EffectAddMenu({
  items,
  onAdd,
  compact,
  addLabel = "Add effect",
  emptyIcon: EmptyIcon = Plus,
  specificHeading,
  domain = "layer",
  extra,
}: EffectAddMenuProps) {
  const [open, setOpen] = React.useState(false);

  const add = (type: string) => {
    onAdd(type);
    setOpen(false);
  };

  // The promoted section, then the taxonomy. A specific effect appears ONCE —
  // at the top — so the list never asks you to notice you have seen it before.
  const specific = items.filter((i) => i.specific);
  const rest = items.filter((i) => !i.specific);
  const groups = EFFECT_CATEGORIES.filter((c) => c.domain === domain)
    .map((cat) => ({ ...cat, items: rest.filter((i) => i.category === cat.id) }))
    .filter((g) => g.items.length > 0);

  const row = (item: EffectMenuItem) => (
    <EffectPaletteItem
      key={item.type}
      icon={item.icon}
      label={item.label}
      blurb={item.blurb}
      badge={item.badge}
      disabled={item.disabled}
      // The label ranks; the blurb and tags still match, one tier down — so
      // "green screen" finds Chroma key without outranking a real name.
      value={item.label}
      keywords={[item.blurb ?? "", ...(item.keywords ?? [])]}
      onSelect={() => !item.disabled && add(item.type)}
    />
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {compact ? (
          <button
            type="button"
            aria-label={addLabel}
            title={addLabel}
            className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
          >
            <Plus />
          </button>
        ) : (
          <button
            type="button"
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border/80 py-2 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground [&_svg]:size-3.5"
          >
            <EmptyIcon /> {addLabel}
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        <Command filter={scoreEffectRow}>
          <CommandInput placeholder="Search effects…" autoFocus />
          <CommandList className="max-h-[22rem]">
            <CommandEmpty>No effects found.</CommandEmpty>
            {specific.length > 0 && (
              <CommandGroup heading={specificHeading ?? "For this layer"}>{specific.map(row)}</CommandGroup>
            )}
            {groups.map((group) => (
              <CommandGroup key={group.id} heading={group.label}>
                {group.items.map(row)}
              </CommandGroup>
            ))}
            {extra?.(() => setOpen(false))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The icon a preset row wears when its effect kind has none to lend. */
export const PRESET_FALLBACK_ICON = Sparkles;
