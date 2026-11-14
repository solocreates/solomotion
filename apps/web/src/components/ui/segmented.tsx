"use client";

import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Tooltip. Never shown as text — a segment is its label. */
  hint?: string;
  disabled?: boolean;
}

/**
 * THE SEGMENTED CONTROL — pick one of a few. One object for every "which one"
 * strip: a frame's mode, an export's medium and subject, a render path.
 *
 * - A recess (`track`), not a boxed slab: no border of its own, so it sits in a
 *   panel, a dialog or a toolbar capsule without drawing a second outline.
 *   `bare` drops the recess too, for a strip that already lives in chrome.
 * - The armed segment wears the app's one armed state (raised glass, accent
 *   label), the same as a tab or an armed tool.
 * - Corners are concentric with the strip (see `.track` in globals.css).
 * - With icons, a strip that gets too narrow for its words shows icons only
 *   (container query), instead of clipping the armed label.
 * - Radix roving focus: arrow keys move between segments.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  disabled,
  stretch,
  bare,
  className,
  "aria-label": ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  disabled?: boolean;
  /** Fill the width, segments sharing it equally. */
  stretch?: boolean;
  /** No recess — for a strip inside a toolbar capsule. */
  bare?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const collapsible = stretch && options.every((o) => o.icon);
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onValueChange={(v) => {
        if (v && v !== value) onChange(v as T);
      }}
      className={cn(
        "track flex h-(--control-h) min-w-0 max-w-full items-center gap-0.5",
        !bare && "bg-input",
        stretch ? "w-full" : "w-fit",
        collapsible && "@container",
        className,
      )}
    >
      {options.map((o) => {
        const Icon = o.icon;
        const armed = o.value === value;
        const item = (
          <ToggleGroupPrimitive.Item
            key={o.value}
            value={o.value}
            disabled={o.disabled}
            aria-label={o.label}
            className={cn(
              "flex h-full min-w-0 items-center justify-center gap-1.5 whitespace-nowrap px-2.5 text-body font-medium outline-none transition-colors",
              "focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5 [&_svg]:shrink-0",
              stretch && "flex-1",
              armed ? "material-glass-raised text-primary" : "text-fg-muted hover:text-fg",
            )}
          >
            {Icon && <Icon />}
            <span className={cn("truncate", collapsible && "hidden @min-[16rem]:inline")}>{o.label}</span>
          </ToggleGroupPrimitive.Item>
        );
        if (!o.hint) return item;
        return (
          <Tooltip key={o.value}>
            <TooltipTrigger asChild>{item}</TooltipTrigger>
            <TooltipContent side="bottom">
              <p>{o.hint}</p>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </ToggleGroupPrimitive.Root>
  );
}
