"use client";

import * as React from "react";
import {
  ANIMATION_CATEGORY_LABEL,
  getPreset,
  groupedAnimationPresets,
  type AnimationCategory,
  type AnimationPresetDef,
  type Easing,
} from "@solomotion/core";
import { AnimationPreview, useIntroPlay } from "../ui/PosePreview";
import { Ban, ChevronDown, Plus, Search, X } from "lucide-react";
import { Popover, PopoverBody, PopoverContent, PopoverHeader, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTypeToFocus } from "../input/use-type-to-focus";

/**
 * The ONE animation-preset gallery — layer Animate tabs and the text Animate
 * tab both pick from it (each hands in its scoped preset list). Tiles preview
 * through the shared `AnimationPreview`, the same evaluator-driven component
 * the library's cards use, so the gallery and the browser can never disagree
 * about what a preset looks like.
 *
 * It has TWO triggers and one body. `PresetPicker` is the `--control-h` field
 * for a property row; `AnimationStage` is the panel-width viewport that shows
 * the animation you actually chose, tuned, playing. Both open the same grid.
 */

interface GalleryProps {
  presets: AnimationPresetDef[];
  /** Selected preset id, or null for "no animation". */
  value: string | null;
  onSelect: (presetId: string | null) => void;
  /** What the tiles animate — a layer chip or an "Aa" glyph. */
  sample: "layer" | "text";
  /** Which direction the tiles play. An exit previewed as an entrance is a lie. */
  phase?: "in" | "out";
  nullLabel?: string;
}

/** The proxy the stage poses. Big enough to read a rotation and a blur on. */
function StageChip({ sample, text }: { sample: "layer" | "text"; text?: string }) {
  return sample === "text" ? (
    <span className="whitespace-nowrap text-sm font-semibold tracking-tight text-foreground/90">
      {text || "Aa"}
    </span>
  ) : (
    <span className="block size-6 rounded-[5px] bg-linear-to-br from-primary to-primary/60" />
  );
}

// ── The gallery body ─────────────────────────────────────────────────────────

function AnimationGallery({
  presets,
  value,
  onSelect,
  sample,
  phase = "in",
  nullLabel = "None",
  onClose,
}: GalleryProps & { onClose: () => void }) {
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState<AnimationCategory | null>(null);
  const [hovered, setHovered] = React.useState<string | null>(null);
  // The grid plays itself once on open, then rests. A gallery that only moves
  // under the cursor looks like a gallery that failed to load; one that loops
  // forever is thirty things competing for your eye. The app already made
  // this call for the library's cards — same hook, same behaviour.
  const intro = useIntroPlay(false, 2400);

  // Grouped in core, so this picker and anything else that lists animations
  // shelve them identically. The scoped list comes in from the caller: a layer
  // picker has no business offering a typewriter, and that decision is not this
  // component's to re-make.
  const groups = React.useMemo(() => groupedAnimationPresets(presets, query), [presets, query]);
  const total = groups.reduce((n, g) => n + g.presets.length, 0);

  // DERIVED, not stored: a category the current search has emptied simply is
  // not the active one. Storing "selected" separately from "selectable" is how
  // a picker ends up showing an empty shelf and no way back.
  const active = category && groups.some((g) => g.category === category) ? category : null;
  const shown = active ? groups.filter((g) => g.category === active) : groups;

  const pick = (id: string | null) => {
    onSelect(id);
    onClose();
  };

  const searchRef = React.useRef<HTMLInputElement>(null);
  useTypeToFocus(searchRef);

  return (
    <>
      <PopoverHeader className="flex h-9 items-center gap-1.5 px-2">
        <Search className="size-3.5 shrink-0 text-muted-foreground/70" />
        <input
          // A filter beside a list, not a field you came to type in: on a
          // tablet a caret here raises the keyboard over the presets. Typing
          // still searches from the first letter. See `useTypeToFocus`.
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
        />
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">{total}</span>
      </PopoverHeader>

      {/* THE RAIL. Thirty-five tiles in one scroll is a catalogue, not a
          choice — and the families are how people actually think about motion
          ("something that fades", "something loud"). It shows only categories
          the current list HAS, so a layer picker never offers an empty shelf. */}
      {groups.length > 1 && (
        <div className="tm-rail flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 px-1.5 py-1">
          <CategoryChip label="All" active={active === null} onClick={() => setCategory(null)} />
          {groups.map((g) => (
            <CategoryChip
              key={g.category}
              label={ANIMATION_CATEGORY_LABEL[g.category]}
              active={active === g.category}
              onClick={() => setCategory(active === g.category ? null : g.category)}
            />
          ))}
        </div>
      )}

      <PopoverBody className="max-h-[26rem]" viewportClassName="p-1.5">
        {/* None is pinned above the shelves, not filed under one: "remove the
            animation" is not a kind of animation, and it stays one click away
            whatever the rail is filtered to. */}
        <div className="grid grid-cols-2 gap-1.5">
          <GalleryCard selected={value === null} label={nullLabel} onClick={() => pick(null)}>
            <Ban className="size-4 text-muted-foreground/50" />
          </GalleryCard>
        </div>

        {shown.map((g) => (
          <section key={g.category} className="pt-2">
            {/* The heading earns its line only when there is more than one
                shelf to tell apart. Filtered to one, the rail already said it. */}
            {shown.length > 1 && (
              <h4 className="px-0.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                {ANIMATION_CATEGORY_LABEL[g.category]}
              </h4>
            )}
            <div className="grid grid-cols-2 gap-1.5">
              {g.presets.map((def) => (
                <GalleryCard
                  key={def.id}
                  selected={value === def.id}
                  label={def.label}
                  onMouseEnter={() => setHovered(def.id)}
                  onMouseLeave={() => setHovered((h) => (h === def.id ? null : h))}
                  onClick={() => pick(def.id)}
                >
                  <AnimationPreview
                    presetId={def.id}
                    phase={phase}
                    sample={sample}
                    scale={0.28}
                    playing={intro || hovered === def.id || value === def.id}
                    chip={<StageChip sample={sample} />}
                    className="size-full"
                  />
                </GalleryCard>
              ))}
            </div>
          </section>
        ))}

        {total === 0 && (
          <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">No match</p>
        )}
      </PopoverBody>
    </>
  );
}

/** One shelf on the rail. Small, quiet, and obviously a filter when it is on. */
function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-(--r-xs) px-2 py-0.5 text-[10px] transition-colors",
        active
          ? "bg-primary/15 text-foreground shadow-[inset_0_0_0_1px_var(--primary)]"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/**
 * The motion, then its name. No descriptor line: the tile IS the description,
 * and fifteen of them stacked was a paragraph of grey prose in a picker.
 */
function GalleryCard({
  selected,
  label,
  onClick,
  onMouseEnter,
  onMouseLeave,
  children,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={cn(
        "group/card flex flex-col overflow-hidden rounded-md p-1 text-left transition-colors",
        selected ? "material-glass-raised" : "material-chip hover:bg-accent/60",
      )}
    >
      <span className="flex h-[3.25rem] items-center justify-center overflow-hidden rounded-[5px] bg-stage">
        {children}
      </span>
      <span className="truncate px-0.5 pt-1 text-[11px] leading-tight">{label}</span>
    </button>
  );
}

// ── Trigger A: the property-row field ────────────────────────────────────────

export function PresetPicker(props: GalleryProps) {
  const [open, setOpen] = React.useState(false);
  const current = props.value ? getPreset(props.value) : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md border border-transparent bg-input/45 px-1.5 text-xs transition-colors hover:border-border"
        >
          <span className="truncate">{current?.label ?? props.nullLabel ?? "None"}</span>
          <ChevronDown className="ml-auto size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[19rem] p-0" align="end" sideOffset={8}>
        <AnimationGallery {...props} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

// ── Trigger B: the stage ─────────────────────────────────────────────────────

/**
 * The animation, playing, at panel width — and the way you change it.
 *
 * This replaces a combobox that named the animation in words. A motion tool
 * should not describe a motion; the whole panel below it is numbers, and the
 * one thing the user is actually choosing is a movement. Hover (or the first
 * moment it mounts) plays it; clicking anywhere opens the gallery.
 *
 * When a `spec` is handed in the stage plays the TUNED animation — the real
 * duration, easing and params — so tuning a slider is visible where you tune it.
 */
export function AnimationStage({
  presets,
  value,
  onSelect,
  sample,
  phase = "in",
  spec,
  text,
  emptyLabel = "Add animation",
  nullLabel,
}: GalleryProps & {
  spec?: { durationMs: number; easing: Easing; params: Record<string, number> } | null;
  /** The layer's own words, for a text sample. */
  text?: string;
  emptyLabel?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [hovered, setHovered] = React.useState(false);
  const def = value ? getPreset(value) : undefined;

  const gallery = (
    <PopoverContent className="w-[19rem] p-0" align="end" sideOffset={8}>
      <AnimationGallery
        presets={presets}
        value={value}
        onSelect={onSelect}
        sample={sample}
        phase={phase}
        nullLabel={nullLabel}
        onClose={() => setOpen(false)}
      />
    </PopoverContent>
  );

  if (!def) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-[4.5rem] w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-foreground"
          >
            <Plus className="size-3.5" />
            {emptyLabel}
          </button>
        </PopoverTrigger>
        {gallery}
      </Popover>
    );
  }

  return (
    <div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title="Change animation"
            className="group/stage block w-full overflow-hidden rounded-md bg-stage text-left shadow-[inset_0_0_0_1px_var(--border)] transition-shadow hover:shadow-[inset_0_0_0_1px_var(--primary)]"
          >
            <AnimationPreview
              presetId={def.id}
              phase={phase}
              sample={sample}
              text={text}
              spec={spec ?? undefined}
              scale={0.32}
              playing={hovered}
              chip={<StageChip sample={sample} text={text} />}
              className="h-[4.5rem] w-full"
            />
            {/* The name rides on the stage rather than above it — one object,
                and the panel keeps its row rhythm for the actual fields. */}
            <span className="flex items-center gap-1 border-t border-border/60 px-1.5 py-1">
              <span className="truncate text-[11px] font-medium">{def.label}</span>
              <ChevronDown className="ml-auto size-3 shrink-0 text-muted-foreground" />
            </span>
          </button>
        </PopoverTrigger>
        {gallery}
      </Popover>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Remove animation"
            onClick={() => onSelect(null)}
            className={cn(
              "absolute right-1 top-1 flex size-5 items-center justify-center rounded bg-background/70 text-muted-foreground transition-opacity hover:text-foreground",
              hovered ? "opacity-100" : "opacity-0",
            )}
          >
            <X className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">Remove</TooltipContent>
      </Tooltip>
    </div>
  );
}
