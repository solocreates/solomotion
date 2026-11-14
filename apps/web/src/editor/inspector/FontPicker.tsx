"use client";

import * as React from "react";
import type { FaceStyle } from "@solomotion/core";
import { ChevronsUpDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { CompactFontBrowser, type FontTarget } from "../fonts/FontBrowser";
import { useFontPrefs } from "../state/font-prefs";
import { usePluginWindows } from "../plugins/plugin-windows";

/**
 * The font FIELD — a trigger showing the family in its own face, opening the
 * quick font browser. Every surface that picks a family uses this one field:
 * the inspector, the text options bar, a variable's value, a node's input.
 *
 * The browser inside is the Fonts window at a smaller size (`FontBrowser`), so
 * "Browse fonts" hands you over to the same list, stars and recents with room
 * to see them, carrying whatever you had typed.
 */
export function FontPicker({
  value,
  weight,
  italic,
  onChange,
  onPreview,
  className,
}: {
  value: string | undefined;
  /** The weight and slant the field's text is set in — kept across a family change where it can be. */
  weight?: number;
  italic?: boolean;
  /** A family was chosen; `face` when a specific one was (an uploaded file names its own). */
  onChange: (family: string, face?: FaceStyle) => void;
  /**
   * Live, non-committal preview: a family as it is hovered or arrowed to, and
   * `null` to revert. Wire it to a history-free overlay.
   */
  onPreview?: (family: string | null) => void;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);

  const target = React.useMemo<FontTarget>(
    () => ({ family: value, weight, italic, pick: onChange, preview: onPreview }),
    [value, weight, italic, onChange, onPreview],
  );

  // Closed and focused, the arrows step through your recent fonts — the native
  // select's feel, on the list you actually move between.
  const cycle = (dir: 1 | -1) => {
    const recent = useFontPrefs.getState().recent;
    if (recent.length === 0) return setOpen(true);
    const at = value ? recent.indexOf(value) : -1;
    const next = recent[(at + dir + recent.length) % recent.length];
    if (next) onChange(next);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label="Font"
          onKeyDown={(e) => {
            if (open) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              cycle(e.key === "ArrowDown" ? 1 : -1);
            }
          }}
          className={cn(
            "flex h-(--control-h) w-full min-w-0 items-center justify-between gap-1 rounded-md border border-transparent bg-input/45 px-2 text-sm transition-colors hover:border-border focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            open && "border-border",
            className,
          )}
        >
          <span className="truncate" style={value ? { fontFamily: `"${value}"` } : undefined}>
            {value ?? "Mixed"}
          </span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto overflow-hidden p-0" align="start" sideOffset={4}>
        {open && (
          <CompactFontBrowser
            target={target}
            onClose={() => setOpen(false)}
            onBrowse={(q) => {
              setOpen(false);
              usePluginWindows.getState().open("fonts", q ? { q } : undefined);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
