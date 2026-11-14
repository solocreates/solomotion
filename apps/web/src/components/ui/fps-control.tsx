"use client";

import * as React from "react";
import { Check, ChevronDown, Gauge } from "lucide-react";
import {
  FPS_PRESETS,
  MAX_FPS,
  MIN_FPS,
  formatFps,
  frameStepMs,
  normalizeFps,
  type FpsPreset,
} from "@solomotion/core";
import { NumberInput } from "./number-input";
import { Popover, PopoverBody, PopoverContent, PopoverFooter, PopoverHeader, PopoverTrigger } from "./popover";
import { cn } from "@/lib/utils";

/**
 * The frame-rate control — ONE component behind every place a rate is set: the
 * frame inspector, the flipbook sheet header and the export dialog.
 *
 * ## The shape of the control, and why
 *
 * A rate is two different questions wearing one number. Most of the time you
 * want a *known* rate — 24 because it's film, 12 because it's on twos — and
 * picking that from a list is faster and less error-prone than typing. But
 * occasionally you want an arbitrary one (a 9fps sheet, a 47.952 conform), and
 * a control that only offers a list makes that impossible.
 *
 * So this is a **scrub field with a preset menu attached**, not a select and not
 * a bare number box:
 *
 *  - the field is the real control — drag to scrub, click to type, arrows to
 *    step, and it accepts any value in range including the NTSC decimals;
 *  - the menu is the fast path — every preset carries what it's FOR
 *    ("Hand-drawn animation", "PAL broadcast"), because "25" only means
 *    something once you know it's the PAL rate;
 *  - the current value is ticked in the menu when it matches a preset, and the
 *    menu stays usable when it doesn't — a custom rate is a first-class state,
 *    not an error to be corrected.
 *
 * The frame step (`41.7ms / frame`) is shown under the presets rather than in
 * the field: it is the number you reason about when matching a rate to
 * hand-drawn holds, but it would be noise on the field itself.
 *
 * ## Live vs. committed
 *
 * `onChange` fires continuously through a scrub (pair it with an undo
 * `mergeKey` so a drag is one history entry); `onCommit` fires once at the end
 * and on every discrete pick. Callers that must do expensive work on a rate
 * change — re-cutting a flipbook's holds, say — should do it in `onCommit`.
 */
export interface FpsControlProps {
  value: number;
  /** Live during a scrub. Coalesce these into one undo entry. */
  onChange: (fps: number) => void;
  /** End of a scrub, or a discrete pick from the menu. */
  onCommit?: (fps: number) => void;
  /**
   * Rates surfaced in the menu. Defaults to the core preset table; the export
   * dialog narrows it to what a codec will actually accept.
   */
  presets?: readonly FpsPreset[];
  /** Shown above the presets — e.g. "Export rate", "Sheet rate". */
  menuTitle?: string;
  /**
   * Secondary line under the field, for context the field can't carry (the
   * export dialog uses it for "Comp runs at 24").
   */
  hint?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  /** Compact drops the leading icon — for tight inspector rows. */
  size?: "default" | "compact";
  /** Lowest rate accepted — a layer's rate may go below a comp's. */
  min?: number;
}

export function FpsControl({
  value,
  onChange,
  onCommit,
  presets = FPS_PRESETS,
  menuTitle = "Frame rate",
  hint,
  disabled,
  className,
  size = "default",
  min = MIN_FPS,
}: FpsControlProps) {
  const [open, setOpen] = React.useState(false);
  const fps = normalizeFps(value, min);
  const activePreset = presets.find((p) => Math.abs(p.fps - fps) < 0.001) ?? null;

  const pick = (next: number) => {
    const v = normalizeFps(next, min);
    onChange(v);
    onCommit?.(v);
    setOpen(false);
  };

  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div
        className={cn(
          "flex h-7 min-w-0 items-center rounded-md border border-transparent bg-input/45 transition-colors",
          "focus-within:border-primary/60 hover:border-border",
          disabled && "pointer-events-none opacity-40",
        )}
      >
        {size === "default" && (
          <Gauge className="ml-1.5 size-3 shrink-0 text-muted-foreground/70" aria-hidden />
        )}
        {/* The field owns the value. Borderless here because the wrapper draws
            the one focus ring for field + menu together — two nested rings on a
            28px row reads as a bug. */}
        <NumberInput
          value={fps}
          onChange={(v) => onChange(normalizeFps(v, min))}
          onCommit={(v) => onCommit?.(normalizeFps(v, min))}
          min={min}
          max={MAX_FPS}
          step={1}
          precision={3}
          unit="fps"
          disabled={disabled}
          title="Frame rate — drag to scrub, click to type"
          className="h-6 flex-1 border-0 bg-transparent hover:border-0 focus-within:border-0 focus-within:bg-transparent"
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label="Frame rate presets"
              title="Frame rate presets"
              className={cn(
                "mr-0.5 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors",
                "hover:bg-accent/60 hover:text-foreground",
                open && "bg-accent/60 text-foreground",
              )}
            >
              <ChevronDown className="size-3" aria-hidden />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-60 p-0">
            <PopoverHeader className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              {menuTitle}
            </PopoverHeader>
            <PopoverBody className="max-h-64" viewportClassName="p-1">
              {presets.map((preset) => {
                const active = activePreset?.fps === preset.fps;
                return (
                  <button
                    key={preset.fps}
                    type="button"
                    onClick={() => pick(preset.fps)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors",
                      "hover:bg-accent/70 focus-visible:bg-accent/70 focus-visible:outline-none",
                      active && "bg-accent/40",
                    )}
                  >
                    <Check
                      className={cn("size-3 shrink-0", active ? "text-primary" : "opacity-0")}
                      aria-hidden
                    />
                    <span className="w-10 shrink-0 font-mono tabular-nums">
                      {formatFps(preset.fps)}
                    </span>
                    <span className="truncate text-muted-foreground">{preset.label}</span>
                  </button>
                );
              })}
            </PopoverBody>
            {/* The step is the number you reason about when matching a rate to
                hand-drawn holds — kept out of the field, present where you're
                choosing. */}
            <PopoverFooter className="px-2 py-1.5 text-[10px] text-muted-foreground/70">
              {activePreset ? (
                <>
                  <span className="text-foreground/80">{activePreset.label}</span> ·{" "}
                </>
              ) : (
                <span className="text-foreground/80">Custom · </span>
              )}
              {frameStepMs(fps).toFixed(1)}ms per frame
            </PopoverFooter>
          </PopoverContent>
        </Popover>
      </div>
      {hint && <div className="px-0.5 text-[10px] leading-tight text-muted-foreground/70">{hint}</div>}
    </div>
  );
}
