"use client";

import * as React from "react";
import { PALETTE_LIBRARIES, solidPaint, type Paint, type Variable, type VariableType } from "@solomotion/core";
import { Blend, CaseSensitive, Hash, Palette, Type as TypeIcon, Weight } from "lucide-react";
import { PaintPreview } from "../../paint/PaintPreview";
import { cn } from "@/lib/utils";

/**
 * ONE description of every variable type — label, icon, seed value and how its
 * value previews. The Variables window, the bind picker and every field chip
 * read it from here, so adding a type is a single entry rather than a hunt
 * through three files that had each grown their own copy of this table.
 */

export interface VariableTypeMeta {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** The value a freshly created variable of this type starts at. */
  defaultValue: Variable["value"];
  /** This type's editor IS a swatch — so the row's leading badge is the
   *  control, and there is no second one. See the note below the table. */
  editsInSwatch?: boolean;
}

export const VARIABLE_TYPE_META: Record<VariableType, VariableTypeMeta> = {
  color: { label: "Color", icon: Palette, defaultValue: "#B18CFF", editsInSwatch: true },
  paint: { label: "Fill", icon: Blend, defaultValue: solidPaint(PALETTE_LIBRARIES[0]!.colors[0]!.value), editsInSwatch: true },
  number: { label: "Number", icon: Hash, defaultValue: 0 },
  fontFamily: { label: "Font", icon: TypeIcon, defaultValue: "Space Grotesk" },
  fontWeight: { label: "Weight", icon: Weight, defaultValue: 400 },
  string: { label: "Text", icon: CaseSensitive, defaultValue: "" },
};

/**
 * Whether this type's whole editor IS a swatch.
 *
 * A colour and a fill are edited by clicking a square and picking — the square
 * is the control, not a picture of the value. Everything else needs a field a
 * square cannot be: you cannot type a font weight into 24 pixels.
 *
 * It lives on the TYPE because it is a fact about the type, and because asking
 * it anywhere else means a list of type names that has to be kept in step. That
 * list is exactly what produced a row with two badges — one that edited and one
 * that only looked like it did — for colours but not for fills.
 */

/** Display order wherever types are listed (tabs, groups, menus). */
export const VARIABLE_TYPE_ORDER: VariableType[] = [
  "color",
  "paint",
  "number",
  "fontFamily",
  "fontWeight",
  "string",
];

const CHECKER = "repeating-conic-gradient(rgba(0,0,0,0.28) 0% 25%, transparent 0% 50%) 0 0 / 6px 6px";

/**
 * The square preview of a variable's value: the colour itself for colours, the
 * number/first glyph for everything else. Sized by `className` so the same
 * component serves a 16px menu row and a 20px inspector chip.
 */
export function VariableSwatch({
  variable,
  value,
  className,
}: {
  variable: Variable;
  /** Override the previewed value (e.g. the animated value at the playhead). */
  value?: Variable["value"];
  className?: string;
}) {
  const shown = value ?? variable.value;
  // A fill previews as ITSELF, painted by the stage's own painter — a gradient
  // reads as that gradient and a hatch reads as that hatch at 45°, at 16px.
  if (variable.type === "paint") {
    return (
      <span
        className={cn(
          "relative size-4 shrink-0 overflow-hidden rounded-[5px] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.3),inset_0_0_0_1px_rgba(255,255,255,0.12)]",
          className,
        )}
      >
        <PaintPreview paint={shown as Paint} />
      </span>
    );
  }
  if (variable.type === "color") {
    return (
      <span
        className={cn(
          "relative size-4 shrink-0 overflow-hidden rounded-[5px] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.3),inset_0_0_0_1px_rgba(255,255,255,0.12)]",
          className,
        )}
        style={{ background: CHECKER }}
      >
        <span className="absolute inset-0" style={{ backgroundColor: String(shown) }} />
      </span>
    );
  }
  const Icon = VARIABLE_TYPE_META[variable.type].icon;
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[5px] bg-muted/80 text-[8px] font-medium tabular-nums text-muted-foreground",
        className,
      )}
    >
      {typeof shown === "number" ? (
        Math.abs(shown) < 1000 ? (
          Math.round(shown)
        ) : (
          <Icon className="size-2.5" />
        )
      ) : (
        <Icon className="size-2.5" />
      )}
    </span>
  );
}

/** A variable's value rendered as the short, right-aligned text a row shows. */
export function variableValueLabel(variable: Variable, value?: Variable["value"]): string {
  const shown = value ?? variable.value;
  if (variable.type === "color") return String(shown).replace(/^#/, "").toUpperCase().slice(0, 8);
  if (variable.type === "paint") return PAINT_LABEL[(shown as Paint).type];
  if (typeof shown === "number") return String(Math.round(shown * 100) / 100);
  return String(shown);
}

/** What a fill variable's row says on the right. The paint's KIND, because its
 *  colours are already in the swatch and a hex would only describe one of them. */
const PAINT_LABEL: Record<Paint["type"], string> = {
  solid: "Solid",
  linear: "Linear",
  radial: "Radial",
  angular: "Angular",
  media: "Image",
  pattern: "Pattern",
  variable: "Alias",
};
