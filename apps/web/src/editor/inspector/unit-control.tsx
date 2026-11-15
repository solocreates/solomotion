"use client";

import * as React from "react";
import {
  formatLength,
  isLengthPath,
  LENGTH_UNIT_META,
  parseLength,
  propertyDef,
  setFieldUnit,
  specActive,
  type Clip,
  type Length,
  type LengthSpec,
  type LengthUnit,
} from "@solomotion/core";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useClipUpdater } from "./use-clip-updater";

/**
 * THE UNIT OF A SIZE — one chip beside the keyframe diamond of every length
 * field in the app (it rides `KeyControl`, so strokes, fonts, gaps, padding and
 * every effect radius get it with nothing per panel). Quiet at px, like the
 * diamond; once a field is relational it stays visible and says how (`spx`,
 * `fw`, bracketed when it has limits). The popover is the CSS model, laid out:
 * which space the number is in, and the floor and ceiling it is held between.
 *
 * Writes through core `setFieldUnit`, the function `layer.set` uses, so a
 * size switched here keeps its size exactly as an agent's switch does.
 */
const COMP: ReadonlyArray<SegmentedOption<LengthUnit>> = (["px", "fw", "fh", "%"] as const).map((u) => ({
  value: u,
  label: u,
  hint: LENGTH_UNIT_META[u].describe,
}));
const SCREEN: ReadonlyArray<SegmentedOption<LengthUnit>> = (["spx", "vw", "vh", "vmin"] as const).map((u) => ({
  value: u,
  label: u,
  hint: LENGTH_UNIT_META[u].describe,
}));

/*
 * WHO DRAWS THE UNIT. Inside the field is the home (the field reserves a slot
 * for it, so the number never runs under it); beside the keyframe diamond is the
 * fallback for a field nobody wrapped. A field that mounts the chip CLAIMS its
 * (clip, path), and the diamond's copy steps aside — the two are siblings, so a
 * context could not tell one about the other.
 */
const claims = new Map<string, number>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
function useClaim(key: string, on: boolean) {
  React.useLayoutEffect(() => {
    if (!on) return;
    claims.set(key, (claims.get(key) ?? 0) + 1);
    notify();
    return () => {
      const n = (claims.get(key) ?? 1) - 1;
      if (n > 0) claims.set(key, n);
      else claims.delete(key);
      notify();
    };
  }, [key, on]);
}
function useClaimed(key: string): boolean {
  return React.useSyncExternalStore(subscribe, () => claims.has(key), () => false);
}

/** The unit a length field shows in its own slot (see `FieldUnitProvider`). */
export function fieldUnitFor(clip: Clip, property: string): React.ReactNode {
  return isLengthPath(property) ? <UnitChip clip={clip} property={property} placement="field" /> : null;
}

export function UnitChip({
  clip,
  property,
  placement = "beside",
}: {
  clip: Clip;
  property: string;
  /** `field` = inside the field's unit slot (always visible, the field's unit);
   *  `beside` = the keyframe gutter's fallback, quiet at px. */
  placement?: "field" | "beside";
}) {
  const update = useClipUpdater(clip.id);
  const [open, setOpen] = React.useState(false);
  const key = `${clip.id}\u0000${property}`;
  const inField = placement === "field";
  useClaim(key, inField && isLengthPath(property));
  const claimed = useClaimed(key);
  if (!isLengthPath(property)) return null;
  if (!inField && claimed) return null;
  const spec = clip.units?.[property];
  const active = specActive(spec);
  const unit = spec?.unit ?? "px";
  const bounded = !!(spec?.min || spec?.max);

  const name = propertyDef(property)?.label ?? property;
  const limits = [spec?.min && `min ${formatLength(spec.min.value, spec.min.unit)}`, spec?.max && `max ${formatLength(spec.max.value, spec.max.unit)}`].filter(Boolean);
  const tip = `${name} in ${unit}${limits.length ? ` · ${limits.join(" · ")}` : ""}`;

  const write = (next: LengthUnit, bounds?: Pick<LengthSpec, "min" | "max">) =>
    update("Size unit", (c, d) => setFieldUnit(d, c, property, next, bounds));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Unit: ${unit}`}
              className={cn(
                "shrink-0 rounded-sm text-meta tabular-nums transition-[opacity,color,background-color] hover:bg-hover hover:text-fg",
                inField
                  ? // The field's own unit: always there, as quiet as any unit.
                    cn("-mr-0.5 px-0.5", active ? "text-primary" : "text-fg-faint")
                  : cn(
                      "h-4 px-1 leading-4",
                      active ? "text-primary" : "text-fg-muted opacity-0 group-hover/row:opacity-100 data-[state=open]:opacity-100",
                    ),
              )}
            >
              {bounded ? `[${unit}]` : unit}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-60 space-y-3 p-3">
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground">Comp</div>
          <Segmented stretch value={unit} onChange={(u) => write(u)} options={COMP} aria-label="Comp units" />
          <div className="text-xs text-muted-foreground">Screen · steady at any zoom</div>
          <Segmented stretch value={unit} onChange={(u) => write(u)} options={SCREEN} aria-label="Screen units" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <BoundInput label="Min" bound={spec?.min} onCommit={(min) => write(unit, { min, max: spec?.max })} />
          <BoundInput label="Max" bound={spec?.max} onCommit={(max) => write(unit, { min: spec?.min, max })} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A limit typed as a length (`1spx`, `40%`); empty = none. Enter or leaving the field commits. */
function BoundInput({ label, bound, onCommit }: { label: string; bound: Length | undefined; onCommit: (b: Length | undefined) => void }) {
  const shown = bound ? formatLength(bound.value, bound.unit) : "";
  const [text, setText] = React.useState(shown);
  React.useEffect(() => setText(shown), [shown]);
  const parsed = text.trim() === "" ? null : parseLength(text);
  const bad = text.trim() !== "" && !parsed;
  const commit = () => {
    if (bad || text === shown) return;
    onCommit(parsed ?? undefined);
  };
  return (
    <label className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Input
        value={text}
        placeholder="none"
        aria-invalid={bad}
        className={cn("h-7 font-mono text-xs", bad && "border-destructive")}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setText(shown);
        }}
      />
    </label>
  );
}
