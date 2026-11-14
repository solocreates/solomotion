"use client";

import * as React from "react";
import {
  DEFAULT_PATH_FIDELITY,
  DENSE_SIMPLIFY_PX,
  FIDELITY_RANGE,
  SHIFT_SMOOTHING,
  isDenseFidelity,
  type PathFidelity,
} from "@solomotion/core";
import { Range } from "@/components/ui/range";

/**
 * FIDELITY — the fields, without a trigger.
 *
 * The control is mounted in two places now: the tool options bar's pod, and the
 * brush handle's smoothing cap. They want different triggers (a square pod on a
 * bar; a slim cap on a fader) and the same body, so the body is the component
 * and the trigger is each surface's own business. Extracted rather than copied
 * for the ordinary reason — the day `simplify` gains a detent, one of the two
 * copies would get it.
 *
 * Smoothing is stored 0..1 and edited in whole percent, which is what makes
 * "40%" a thing you can type. The ⇧ note is a caption, not a paragraph: it is
 * the one non-obvious fact about this control and there is nowhere else to
 * learn it.
 */
/**
 * What "on" means when smoothing is switched on from off — shared by every
 * trigger that has an on/off, so the bar's pod and the handle's cap cannot land
 * on different numbers. Enough leash to see, not enough to fight.
 */
export const SMOOTHING_ON = 0.4;

export function FidelityFields({
  value,
  onChange,
  geometry = true,
  fallback = DEFAULT_PATH_FIDELITY,
  heading = true,
}: {
  value: PathFidelity;
  onChange: (patch: Partial<PathFidelity>) => void;
  /** False for the pixel brush: it stabilises, but it makes no anchors. */
  geometry?: boolean;
  /** This tool's shipped default — the notch, and what double-click restores. */
  fallback?: PathFidelity;
  /** Off inside the settings sheet, where the TAB already names the section —
   *  a title under a tab of the same subject is a box inside a box. */
  heading?: boolean;
}) {
  const dense = geometry && isDenseFidelity(value);
  return (
    <div className="space-y-2">
      {heading && (
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold">Fidelity</span>
          <span className="text-2xs text-muted-foreground">⇧ reverses it</span>
        </div>
      )}
      <Range
        label="Smoothing"
        value={Math.round(value.smoothing * 100)}
        min={0}
        max={100}
        step={1}
        unit="%"
        precision={0}
        defaultValue={0}
        ticks={[0, Math.round(SHIFT_SMOOTHING * 100)]}
        onChange={(v) => onChange({ smoothing: v / 100 })}
      />
      {geometry && (
        <>
          <Range
            label="Simplify"
            value={value.simplify}
            min={FIDELITY_RANGE.simplify.min}
            max={FIDELITY_RANGE.simplify.max}
            scale="log"
            unit="px"
            precision={2}
            defaultValue={fallback.simplify}
            ticks={[DENSE_SIMPLIFY_PX, fallback.simplify]}
            onChange={(simplify) => onChange({ simplify })}
          />
          <Range
            label="Corners"
            value={value.corner}
            min={FIDELITY_RANGE.corner.min}
            max={FIDELITY_RANGE.corner.max}
            step={1}
            unit="°"
            precision={0}
            defaultValue={fallback.corner}
            ticks={[fallback.corner]}
            onChange={(corner) => onChange({ corner })}
          />
          {dense && <p className="text-2xs text-warning">Dense paths — slower to edit.</p>}
        </>
      )}
    </div>
  );
}
