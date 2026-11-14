"use client";

import * as React from "react";
import type { Variable } from "@solomotion/core";
import { Popover, PopoverBody, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PICKER_PLACEMENT, PICKER_WIDTH, PickerPanel } from "@/components/ui/color-picker";
import { NumberInput } from "@/components/ui/number-input";
import { cn } from "@/lib/utils";
import { FontPicker } from "../FontPicker";

/**
 * THE type-aware value control for a document variable — one field, every type:
 * a swatch+picker for color, the shared FontPicker (with upload) for a family,
 * a labelled weight select, a scrub for numbers, a text input for strings. It is
 * fully controlled (`value` in, `onChange` out) so BOTH the Variables window and
 * the Variables node drive it through their own write policy (static literal, or
 * a keyframe at the playhead) — no duplicated editors, no divergence.
 */

const CHECKER = "repeating-conic-gradient(rgba(0,0,0,0.28) 0% 25%, transparent 0% 50%) 0 0 / 7px 7px";

const WEIGHT_LABELS: Record<number, string> = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
};

export function VariableValueField({
  variable,
  value,
  onChange,
  className,
}: {
  variable: Variable;
  /** The value to display (effective at the playhead when animated). */
  value: Variable["value"];
  onChange: (value: Variable["value"]) => void;
  className?: string;
}) {
  if (variable.type === "color") {
    const color = typeof value === "string" ? value : "#000000";
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Edit ${variable.name}`}
            className={cn(
              "relative size-5 shrink-0 overflow-hidden rounded-md shadow-[inset_0_0_0_1px_rgba(0,0,0,0.25),inset_0_0_0_1px_rgba(255,255,255,0.1)] transition-transform hover:scale-105",
              className,
            )}
            style={{ background: CHECKER }}
          >
            <span className="absolute inset-0" style={{ backgroundColor: color }} />
          </button>
        </PopoverTrigger>
        <PopoverContent {...PICKER_PLACEMENT} className={cn("p-0", PICKER_WIDTH)}>
          <PopoverBody>
            <PickerPanel value={color} onChange={onChange} onCommit={onChange} />
          </PopoverBody>
        </PopoverContent>
      </Popover>
    );
  }

  if (variable.type === "fontFamily") {
    return (
      <FontFamilyField
        value={typeof value === "string" ? value : ""}
        onChange={onChange}
        className={className}
      />
    );
  }

  if (variable.type === "fontWeight") {
    return (
      <Select value={String(value)} onValueChange={(w) => onChange(parseInt(w, 10))}>
        <SelectTrigger className={cn("h-6 w-28 shrink-0 text-[11px]", className)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => (
            <SelectItem key={w} value={String(w)} className="text-xs">
              {WEIGHT_LABELS[w] ?? w} · {w}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (variable.type === "number") {
    return (
      <NumberInput
        value={typeof value === "number" ? value : 0}
        onChange={onChange}
        onCommit={onChange}
        className={cn("w-24 shrink-0", className)}
      />
    );
  }

  // string
  return (
    <input
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      placeholder="value"
      className={cn(
        "h-6 w-28 shrink-0 rounded border border-transparent bg-input/45 px-1.5 text-xs outline-none transition-colors hover:border-border focus:border-primary/60",
        className,
      )}
    />
  );
}

/** Font family — the shared FontPicker (upload lives inside its browser). */
function FontFamilyField({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (family: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex w-40 shrink-0 items-center", className)}>
      <FontPicker value={value} onChange={(family) => onChange(family)} />
    </div>
  );
}
