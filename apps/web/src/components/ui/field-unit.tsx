"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * THE UNIT SLOT — a value field's trailing cell, owned by the field.
 *
 * A unit drawn as a SIBLING of its field (a `px` chip beside the keyframe
 * diamond, a `dB` span after the input) has no reserved room: it appears on
 * hover, shoves the field sideways, and in a narrow row the number runs under
 * it. Inside the field it is part of the field's own min-content, so the value
 * keeps its width and the unit never collides with it.
 *
 * Two ways to fill it: a field's literal `unit` ("dB", "%"), or the length-unit
 * chip a binding wrapper hands down through this context (`PropertyBindingMenu`
 * provides it for length paths), which wins because it is the live unit.
 */
const FieldUnit = React.createContext<React.ReactNode>(null);

export function FieldUnitProvider({ unit, children }: { unit: React.ReactNode; children: React.ReactNode }) {
  return <FieldUnit.Provider value={unit}>{children}</FieldUnit.Provider>;
}

/** What goes in this field's unit slot, or null for none. */
export function useFieldUnit(literal: string | undefined): React.ReactNode {
  const provided = React.useContext(FieldUnit);
  return provided ?? (literal ? literal.trim() : null);
}

/**
 * The slot itself. `min-w-[2ch]` reserves room for the commonest units (px, %,
 * dB, ms) so a value never shifts when its unit swaps; pointer events stop here
 * so pressing the unit never starts a scrub on the field around it.
 */
export function FieldUnitSlot({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      data-el="unit"
      className={cn("flex min-w-[2ch] shrink-0 items-center justify-end text-meta text-fg-faint", className)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {children}
    </span>
  );
}
