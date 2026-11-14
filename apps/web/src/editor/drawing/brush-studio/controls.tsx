"use client";

import * as React from "react";
import type { BrushPreset } from "@solomotion/core";
import { cn } from "@/lib/utils";
import { Range } from "@/components/ui/range";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { tipPreviewCanvas } from "../dab-painter";

/**
 * The studio's control kit.
 *
 * One place, because a brush editor is eighty controls and eighty ad-hoc rows
 * is exactly how a panel starts looking generated: the labels drift out of
 * alignment, half the numbers are fields and half are sliders, and nothing
 * tells you which values are the interesting ones.
 *
 * The rule is that a brush parameter is a RANGE first. You tune a brush by
 * feel — sweeping a value while watching the stroke redraw — and a bare number
 * field asks you to already know the answer. The number stays, inside the bar,
 * because you also need to read what you landed on.
 */

/** What every editing surface in the studio is handed. */
export interface StudioProps {
  brush: BrushPreset;
  patch: (fn: (draft: BrushPreset) => void) => void;
}

/** A titled block of rows. The studio's only grouping primitive. */
export function Group({
  title,
  hint,
  children,
  className,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mb-5", className)}>
      <div className="mb-2 flex items-center gap-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
        {hint && <Hint text={hint} />}
      </div>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

/** A hint is a tooltip on a mark, never a paragraph under a label. */
export function Hint({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex size-3.5 cursor-help items-center justify-center rounded-full border border-border/70 text-[8px] leading-none text-muted-foreground">
          ?
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-60">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

/** A label beside a control — for the things a Range cannot be. */
export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-h-7 items-center gap-2 text-xs">
      <span className="flex w-32 shrink-0 items-center gap-1 text-muted-foreground">
        <span className="truncate">{label}</span>
        {hint && <Hint text={hint} />}
      </span>
      <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">{children}</span>
    </label>
  );
}

/**
 * THE brush slider: a labelled `Range` across the full width.
 *
 * `defaultValue` is passed wherever there is a meaningful one, so a double-click
 * is always the way back — which is what makes sweeping a value to find out
 * what it does a safe thing to do rather than a commitment.
 */
export function Dial({
  label,
  hint,
  value,
  min = 0,
  max = 1,
  step,
  unit,
  precision,
  origin,
  ticks,
  defaultValue,
  percent,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  precision?: number;
  origin?: number;
  ticks?: number[];
  defaultValue?: number;
  /** Show a 0..1 value as a percentage — the studio's most common readout. */
  percent?: boolean;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className={cn("flex items-center gap-1.5", disabled && "pointer-events-none opacity-40")}>
      <Range
        className="min-w-0 flex-1"
        label={
          hint ? (
            <span className="flex items-center gap-1">
              {label}
              <Hint text={hint} />
            </span>
          ) : (
            label
          )
        }
        value={value}
        min={min}
        max={max}
        step={step ?? (percent ? 0.01 : undefined)}
        unit={percent ? undefined : unit}
        precision={precision}
        origin={origin}
        ticks={ticks}
        defaultValue={defaultValue}
        format={percent ? (v) => `${Math.round(v * 100)}%` : undefined}
        onChange={onChange}
      />
    </div>
  );
}

/**
 * A compact "pick one" — the app's `ToggleGroup`, not a third hand-rolled
 * segmented control. Radix gives it the roving focus and the armed state for
 * free, and it can never drift from the toggles in the toolbar.
 */
export function Seg<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: Array<{ v: T; label: string; hint?: string }>;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      className={cn("h-(--control-h)", className)}
    >
      {options.map(({ v, label, hint }) => {
        const item = (
          <ToggleGroupItem value={v} className="flex-1 px-2 text-[10px]">
            {label}
          </ToggleGroupItem>
        );
        if (!hint) return <React.Fragment key={v}>{item}</React.Fragment>;
        return (
          <Tooltip key={v}>
            <TooltipTrigger asChild>{item}</TooltipTrigger>
            <TooltipContent side="top" className="max-w-56">
              {hint}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </ToggleGroup>
  );
}

/**
 * A GRID of choices — the same `ToggleGroup` as `Seg`, wrapped into columns.
 *
 * Nine paper textures in a row of segments is unreadable, and nine hand-rolled
 * buttons is how a panel starts looking generated. It is one control either
 * way; only the layout differs.
 */
export function SegGrid<T extends string>({
  value,
  options,
  columns = 3,
  itemClassName,
  onChange,
}: {
  value: T;
  options: Array<{ v: T; label: React.ReactNode; hint?: string }>;
  columns?: number;
  /** Override the cell — a gallery of glyphs needs room a text chip does not. */
  itemClassName?: string;
  onChange: (v: T) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      className="grid h-auto w-full gap-1"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {options.map(({ v, label, hint }) => {
        const item = (
          <ToggleGroupItem
            value={v}
            className={cn("h-(--control-h) min-w-0 px-1 text-[10px]", itemClassName)}
          >
            {label}
          </ToggleGroupItem>
        );
        if (!hint) return <React.Fragment key={v}>{item}</React.Fragment>;
        return (
          <Tooltip key={v}>
            <TooltipTrigger asChild>{item}</TooltipTrigger>
            <TooltipContent side="top" className="max-w-56">{hint}</TooltipContent>
          </Tooltip>
        );
      })}
    </ToggleGroup>
  );
}

/** A boolean row. */
export function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Row label={label} hint={hint}>
      <Switch checked={checked} onCheckedChange={onChange} />
    </Row>
  );
}

/** A number field row, for values you type rather than sweep. */
export function Num({
  label,
  hint,
  value,
  min,
  max,
  step,
  unit,
  precision = 0,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  precision?: number;
  onChange: (v: number) => void;
}) {
  return (
    <Row label={label} hint={hint}>
      <NumberInput
        value={value}
        min={min}
        max={max}
        step={step}
        precision={precision}
        unit={unit}
        className="w-20"
        onChange={onChange}
      />
    </Row>
  );
}

/**
 * A tip, drawn as it will actually stamp.
 *
 * The gallery shows the REAL baked sprite rather than an icon of one, so
 * choosing a tip is choosing the mark you can see — and a stencil whose
 * parameters make it invisible looks invisible here, which is the fastest
 * possible way to find that out.
 */
export function TipGlyph({
  brush,
  size = 34,
  className,
}: {
  brush: BrushPreset;
  size?: number;
  className?: string;
}) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  const key = JSON.stringify(brush.shape);

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tipPreviewCanvas(brush, "#F4F2ED"), 0, 0, canvas.width, canvas.height);
    // The shape's serialised identity IS the dependency — a tip redraws when
    // any of its parameters move, and nothing else can change these pixels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, size]);

  return <canvas ref={ref} style={{ width: size, height: size }} className={className} />;
}
