"use client";

import * as React from "react";
import { Range } from "./range";
import type { SliderScaleKind } from "./slider-base";

/**
 * `Slider` is now a THIN ADAPTER over {@link Range}.
 *
 * The app had two answers to "how do I show a value between two numbers": a
 * Radix rail-and-thumb here, and a hand-rolled track in the inspector. They
 * looked different, behaved differently, and neither matched the height of the
 * inputs beside them. Range is the one answer.
 *
 * This file survives only so the existing `<Slider value={[x]} onValueChange…>`
 * call sites (Radix's array-valued API) keep working and inherit the new design
 * without being rewritten. New code should reach for `Range` directly — its API
 * is a plain number, and it can carry a label and a readout.
 */
function Slider({
  value,
  defaultValue,
  min = 0,
  max = 100,
  step,
  disabled,
  className,
  onValueChange,
  onValueCommit,
  scale,
  "aria-label": ariaLabel,
}: {
  value?: number[];
  defaultValue?: number[];
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
  onValueChange?: (v: number[]) => void;
  onValueCommit?: (v: number[]) => void;
  /** Log ranges (zoom, frequency) map evenly instead of bunching at one end. */
  scale?: SliderScaleKind;
  "aria-label"?: string;
}) {
  const current = value?.[0] ?? defaultValue?.[0] ?? min;
  return (
    <Range
      className={className}
      value={current}
      min={min}
      max={max}
      step={step}
      scale={scale}
      disabled={disabled}
      hideValue
      aria-label={ariaLabel}
      onChange={(v) => onValueChange?.([v])}
      onCommit={(v) => onValueCommit?.([v])}
    />
  );
}

export { Slider };
