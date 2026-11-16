"use client";

import * as React from "react";
import { Search, Trash2 } from "lucide-react";
import {
  aspectRatioLabel,
  framePresetMatches,
  FRAME_PRESET_GROUPS,
  FRAME_SIZE_PRESETS,
} from "@solomotion/core";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { addFrameFromPreset, addWorldFromPreset } from "../state/clip-actions";
import { useDocSelector, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { useWorkspace } from "../state/workspace";
import { isPrintableKey } from "../state/shortcut-registry";

/**
 * THE frame-size picker — one searchable list, shared by the New Project dialog
 * and the frame tool. Both read the same source of truth (`FRAME_SIZE_PRESETS`
 * plus the user's saved sizes), so a size added in one place shows up in the
 * other.
 *
 * It is a LIST, not a grid of cards. A card grid puts three sizes on a row and
 * then wraps, so the eye scans in two directions to compare two numbers that
 * differ by one digit; a column of rows lines every width, height and ratio up
 * under each other, which is the comparison you are actually making. It is also
 * the only shape that still works at fifty saved presets.
 */

export interface PickedPreset {
  name: string;
  width: number;
  height: number;
}

/**
 * One row: proportional glyph · name · size · ratio, in fixed columns.
 *
 * Spreads the rest of its props onto the BUTTON, which is load-bearing: the
 * saved rows are wrapped in a `ContextMenuTrigger asChild`, and a component
 * that swallows the props Slot injects gets no right-click menu at all —
 * silently, since nothing errors.
 */
export function FramePresetRow({
  name,
  width,
  height,
  selected,
  className,
  ...rest
}: {
  name: string;
  width: number;
  height: number;
  selected: boolean;
} & React.ComponentProps<"button">) {
  // Proportional glyph inside a 16×16 slot — the shape IS the preview.
  const scale = Math.min(16 / width, 16 / height);
  const gw = Math.max(4, Math.round(width * scale));
  const gh = Math.max(4, Math.round(height * scale));
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "grid h-8 w-full shrink-0 items-center gap-2.5 rounded-md px-2 text-left",
        // The row is column-fluid: in the 17rem frame-tool sidebar the ratio
        // would eat the NAME (every preset showed as "V…"), so it only exists
        // once the list is wide enough to carry it — the dialog's pane is.
        "grid-cols-[1rem_minmax(0,1fr)_auto] @[15rem]:grid-cols-[1rem_minmax(0,1fr)_auto_2.5rem]",
        "outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring",
        selected ? "material-glass-raised" : "hover:bg-muted",
        className,
      )}
      {...rest}
    >
      <span className="flex size-4 items-center justify-center">
        <span
          className={cn(
            "rounded-[2px] border transition-colors",
            selected ? "border-primary bg-primary/30" : "border-muted-foreground/60",
          )}
          style={{ width: gw, height: gh }}
        />
      </span>
      <span className={cn("truncate text-xs", selected ? "font-medium text-foreground" : "text-foreground/85")}>
        {name}
      </span>
      <span className="font-mono text-2xs tabular-nums text-muted-foreground">
        {width}×{height}
      </span>
      <span className="hidden text-right text-2xs tabular-nums text-muted-foreground/60 @[15rem]:block">
        {aspectRatioLabel(width, height)}
      </span>
    </button>
  );
}

/**
 * The scrollable, searchable list. Search is what lets preset NAMES stay clean:
 * the platform words live in each preset's keywords, so "tiktok" still lands on
 * Vertical HD (see `framePresetMatches`).
 *
 * ↑/↓ walk the flattened result and Enter activates, so the picker is fully
 * usable from the search field without touching the mouse.
 */
export function FramePresetList({
  isSelected,
  onPick,
  onActivate,
  className,
  autoFocus,
}: {
  isSelected: (preset: PickedPreset) => boolean;
  onPick: (preset: PickedPreset) => void;
  /** Double-click / Enter — the "and go" half of pick-then-confirm. */
  onActivate?: (preset: PickedPreset) => void;
  className?: string;
  autoFocus?: boolean;
}) {
  const customPresets = useWorkspace((s) => s.customFramePresets);
  const deleteFramePreset = useWorkspace((s) => s.deleteFramePreset);
  const [query, setQuery] = React.useState("");
  const selectedRef = React.useRef<HTMLButtonElement | null>(null);

  const groups = React.useMemo(() => {
    const builtin = FRAME_PRESET_GROUPS.map((group) => ({
      title: group as string,
      presets: FRAME_SIZE_PRESETS.filter((p) => p.group === group && framePresetMatches(p, query)),
      custom: false,
    }));
    return [
      ...builtin,
      {
        title: "Saved",
        presets: customPresets.filter((p) => framePresetMatches(p, query)),
        custom: true,
      },
    ].filter((g) => g.presets.length > 0);
  }, [query, customPresets]);

  // The flat order the arrow keys walk — the same order that is on screen.
  const flat = React.useMemo(() => groups.flatMap((g) => g.presets), [groups]);

  const step = (delta: number) => {
    if (flat.length === 0) return;
    const at = flat.findIndex((p) => isSelected(p));
    const next = flat[Math.max(0, Math.min(flat.length - 1, at === -1 ? 0 : at + delta))]!;
    onPick(next);
    // Keep the moving selection in view.
    requestAnimationFrame(() => selectedRef.current?.scrollIntoView({ block: "nearest" }));
  };

  const searchRef = React.useRef<HTMLInputElement | null>(null);

  /**
   * ↑/↓/Enter walk the list, and any PRINTABLE key jumps into the search field
   * carrying its character.
   *
   * The list used to hand `autoFocus` straight to the search input, so opening
   * New Project dropped a caret into a filter box nobody asked for — and on a
   * tablet it threw the on-screen keyboard up over half the dialog before you
   * had seen a single size. The dialog is a picker; the primary act is
   * choosing a tile, and searching is the fallback.
   *
   * Focusing the LIST instead keeps everything the autofocus was there for.
   * Arrow keys work immediately, Enter activates, and typing still searches —
   * it just no longer assumes typing is what you came to do. Finder, Blender
   * and every file dialog behave this way.
   */
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "Enter" && onActivate) {
      const current = flat.find((p) => isSelected(p));
      if (current) onActivate(current);
    } else if (
      isPrintableKey(e) &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      document.activeElement !== searchRef.current
    ) {
      // Focus WITHOUT preventDefault, so the keypress that triggered this lands
      // in the field as its first character. Swallowing it would make the user
      // type the first letter twice.
      searchRef.current?.focus();
    }
  };

  return (
    <div
      className={cn("@container flex min-h-0 flex-col outline-none", className)}
      // Focusable but not in the tab order: it is a region that owns keys, not
      // a control someone should land on while tabbing through the dialog.
      tabIndex={-1}
      autoFocus={autoFocus}
      onKeyDown={onListKeyDown}
    >
      <div className="relative shrink-0 p-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // No key handler of its own: ↑/↓/Enter bubble to the container, which
          // is the one place that walks the list. Two handlers for one job is
          // how the two ended up able to disagree about what "selected" meant.
          placeholder="Search sizes"
          spellCheck={false}
          className="h-7 w-full rounded-md bg-input pl-7 pr-2 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:bg-muted focus:ring-1 focus:ring-ring"
        />
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-2">
        {groups.map((group) => (
          <div key={group.title} className="pt-1.5 first:pt-0">
            <div className="sticky top-0 z-10 bg-[var(--panel)] py-1 text-2xs font-semibold uppercase tracking-[0.09em] text-muted-foreground/70">
              {group.title}
            </div>
            {group.presets.map((preset) => {
              const selected = isSelected(preset);
              const row = (
                <FramePresetRow
                  key={preset.id}
                  ref={selected ? selectedRef : undefined}
                  name={preset.name}
                  width={preset.width}
                  height={preset.height}
                  selected={selected}
                  onClick={() => onPick(preset)}
                  onDoubleClick={onActivate ? () => onActivate(preset) : undefined}
                />
              );
              if (!group.custom) return row;
              return (
                <ContextMenu key={preset.id}>
                  <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => deleteFramePreset(preset.id)}
                    >
                      <Trash2 /> Delete preset
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        ))}
        {flat.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No size matches “{query}”.
          </p>
        )}
      </ScrollArea>
    </div>
  );
}

/**
 * Frame-tool sidebar: pick a size to drop a frame into the viewport (Figma's
 * frame presets). Same list, same search, same rows as New Project — picking
 * here places the frame instead of selecting a size.
 */
const SPACES = [
  { value: "2d", label: "Frame" },
  { value: "3d", label: "3D world" },
] as const satisfies ReadonlyArray<SegmentedOption<"2d" | "3d">>;

export function FramePresetsPanel() {
  const store = useDocStore();
  const activeFrameId = useSession((s) => s.activeFrameId);
  const active = useDocSelector((d) => d.frames.find((f) => f.id === activeFrameId));
  // The same sizes make a flat frame or a 3D world — a world's size is its camera's output.
  const [space, setSpace] = React.useState<"2d" | "3d">("2d");

  return (
    <div className="flex h-full flex-col">
      {/* Which space a preset makes: the app's one segmented control, so the
          armed side wears the armed pane, not a solid accent slab. */}
      <div className="shrink-0 border-b p-2">
        <Segmented
          aria-label="Add as"
          stretch
          value={space}
          onChange={setSpace}
          options={SPACES}
        />
      </div>
      <FramePresetList
        className="min-h-0 flex-1"
        isSelected={(p) => !!active && active.width === p.width && active.height === p.height}
        onPick={(p) =>
          space === "3d"
            ? addWorldFromPreset(store, { name: p.name, width: p.width, height: p.height })
            : addFrameFromPreset(store, { name: p.name, width: p.width, height: p.height })
        }
      />
    </div>
  );
}
