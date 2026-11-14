"use client";

import * as React from "react";
import type { ViewZoomSpec } from "@/editor/workspace/view-zoom";
import { Check, Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useSliderControl,
  type SliderOrientation,
  type SliderScaleKind,
} from "./slider-base";

/**
 * The ONE zoom dial — a reusable, theme-aware control shared by the stage, the
 * timeline (time + track-height), and the curve panel. Built on the headless
 * `useSliderControl`, so drag, wheel-to-zoom, keyboard, and the axis-aware
 * cursor all come for free and behave identically everywhere.
 *
 * The track is a WEDGE, not a flat bar: thin toward the "smaller" end, thick
 * toward "bigger", so a glance tells you which way grows — no cheap-looking
 * hairline. `-`/`+` caps step it (and are real hit targets), a wheel zooms it,
 * a drag scrubs it, and a double-click resets. Works horizontal or vertical.
 */

// Wedge: narrow (centered) at the small end, full-height at the big end. Two
// polygons, one per axis, so the taper always points "up = bigger".
const WEDGE_H = "polygon(0% 34%, 100% 0%, 100% 100%, 0% 66%)"; // thin left → thick right
const WEDGE_V = "polygon(0% 0%, 100% 0%, 66% 100%, 34% 100%)"; // thick top → thin bottom

/**
 * SIZE is a first-class property of the control, not a caller's CSS problem.
 *
 * Every dimension it paints used to be a literal in the markup — track 18px,
 * thumb 17×5, nine ticks, `text-[11px]`, `gap-1` — which meant "make it smaller"
 * was not expressible: you could override the wrapper's padding from outside and
 * the instrument inside stayed exactly the same size. One table per size keeps
 * the proportions coherent (a thinner track needs a shorter thumb and fewer
 * graduations, or it reads as a smudge), and adding a size later is a row here
 * rather than a hunt through nine magic numbers.
 *
 * `length` stays separate because it is the ALONG-axis measure — how much travel
 * the fader has — and that is a layout decision the caller owns. `size` is the
 * cross-axis and the chrome.
 */
export type ZoomControlSize = "xs" | "sm" | "md";

interface SizeTokens {
  /** Track thickness across its axis, px. */
  thickness: number;
  /** Thumb along/across the track, px. */
  thumbLong: number;
  thumbShort: number;
  /** Graduations across the wedge — fewer on smaller tracks, or they smear. */
  ticks: number;
  cap: string;
  capIcon: string;
  readout: string;
  frame: string;
}

const SIZES: Record<ZoomControlSize, SizeTokens> = {
  xs: {
    thickness: 10,
    thumbLong: 9,
    thumbShort: 3,
    ticks: 4,
    cap: "size-3.5",
    capIcon: "[&_svg]:size-2.5",
    readout: "text-[9px] px-0.5 leading-[1.35]",
    frame: "gap-0.5 rounded-md px-0.5 py-0.5",
  },
  sm: {
    thickness: 13,
    thumbLong: 12,
    thumbShort: 4,
    ticks: 6,
    cap: "size-4",
    capIcon: "[&_svg]:size-2.5",
    readout: "text-[10px] px-1 leading-[1.4]",
    frame: "gap-0.5 rounded-md px-0.5 py-0.5",
  },
  md: {
    thickness: 18,
    thumbLong: 17,
    thumbShort: 5,
    ticks: 9,
    cap: "size-5",
    capIcon: "[&_svg]:size-3",
    readout: "text-[11px] px-1.5 py-0.5 leading-normal",
    frame: "gap-1 rounded-lg px-1 py-0.5",
  },
};

export interface ZoomControlProps {
  value: number;
  /**
   * The view's zoom KIND (README D5). Given a spec, min/max/step/format come
   * from it and the value is clamped ON READ — a persisted level above a
   * lowered ceiling shows at the ceiling instead of pinning the dial.
   * Explicit props still win, for the views that have not migrated.
   */
  spec?: ViewZoomSpec;
  min?: number;
  max?: number;
  step?: number;
  scale?: SliderScaleKind;
  orientation?: SliderOrientation;
  wheel?: boolean;
  disabled?: boolean;
  onChange: (v: number) => void;
  onReset?: () => void;
  /** Readout formatter (e.g. `v => \`${Math.round(v*100)}%\``). Omit to hide it. */
  format?: (v: number) => string;
  /** Track length along its axis, in px. */
  length?: number;
  /** Override the end-cap icons (default −/+). */
  minIcon?: React.ReactNode;
  maxIcon?: React.ReactNode;
  /** Hide the −/+ caps (bare wedge). */
  caps?: boolean;
  /** Overall scale of the instrument. `length` still controls its travel. */
  size?: ZoomControlSize;
  className?: string;
  title?: string;
  "aria-label"?: string;
}

function Cap({
  children,
  onStep,
  label,
  tokens,
}: {
  children: React.ReactNode;
  onStep: () => void;
  label: string;
  tokens: SizeTokens;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      onClick={onStep}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        tokens.cap,
        tokens.capIcon,
      )}
    >
      {children}
    </button>
  );
}

export function ZoomControl({
  length = 96,
  format,
  minIcon,
  maxIcon,
  caps = true,
  size = "md",
  className,
  title,
  orientation = "horizontal",
  spec,
  min: minProp,
  max: maxProp,
  value: rawValue,
  ...opts
}: ZoomControlProps) {
  const t = SIZES[size];
  const min = minProp ?? spec?.min ?? 0;
  const max = maxProp ?? spec?.max ?? 1;
  const value = Math.min(max, Math.max(min, Number.isFinite(rawValue) ? rawValue : (spec?.default ?? min)));
  format = format ?? spec?.format;
  const c = useSliderControl({ ...opts, min, max, value, orientation });
  const pct = `${c.fraction * 100}%`;
  const horizontal = c.horizontal;
  const wedge = horizontal ? WEDGE_H : WEDGE_V;

  const track = (
    <div
      // The interactive surface is this FULL rectangle (ref + handlers here), so
      // every pixel of the track is grabbable. The wedge below is clip-path'd —
      // which would also clip the hit region — so it's kept purely visual.
      ref={c.trackRef}
      {...c.trackProps}
      {...c.keyProps}
      className={cn(
        "group/zoom relative select-none outline-none",
        horizontal ? "cursor-ew-resize" : "cursor-ns-resize",
      )}
      style={horizontal ? { width: length, height: t.thickness } : { width: t.thickness, height: length }}
    >
      {/* Wedge body — clipped so the fill + ticks inherit the taper. */}
      <div
        className="pointer-events-none absolute inset-0 overflow-hidden"
        style={{ clipPath: wedge }}
      >
        {/* Rail — monochrome, theme-aware. No product accent: this is an
            instrument, not a highlight. */}
        <div className="absolute inset-0 bg-foreground/10" />
        {/* Fill — a neutral graphite gradient that brightens toward the "bigger"
            end, so the level reads even without the numbers. */}
        <div
          className={cn(
            "absolute",
            horizontal
              ? "bg-linear-to-r from-foreground/25 to-foreground/60"
              : "bg-linear-to-t from-foreground/25 to-foreground/60",
          )}
          style={
            horizontal
              ? { left: 0, top: 0, bottom: 0, width: pct }
              : { left: 0, right: 0, bottom: 0, height: pct }
          }
        />
        {/* Graduation ticks. */}
        <div
          className={cn(
            "pointer-events-none absolute inset-0 flex",
            horizontal ? "items-stretch justify-between px-1" : "flex-col-reverse items-stretch justify-between py-1",
          )}
        >
          {Array.from({ length: t.ticks }).map((_, i) => (
            <span key={i} className={cn("bg-foreground/20", horizontal ? "w-px" : "h-px")} />
          ))}
        </div>
      </div>
      {/* Thumb — a crisp graphite bar (outside the clip). Brightens + lifts on
          grab, the way a good hardware fader's cap catches the light. */}
      <div
        className={cn(
          "pointer-events-none absolute rounded-[2px] bg-foreground shadow ring-1 ring-black/25 transition-all",
          c.dragging ? "scale-110 shadow-md ring-black/40" : "group-hover/zoom:scale-105",
        )}
        style={
          horizontal
            ? { left: pct, top: "50%", width: t.thumbShort, height: t.thumbLong, transform: "translate(-50%,-50%)" }
            : { bottom: pct, left: "50%", width: t.thumbLong, height: t.thumbShort, transform: "translate(-50%,50%)" }
        }
      />
    </div>
  );

  // The value display — the hero, and a CONTROL. See `ZoomReadout`.
  const readout = format ? (
    <ZoomReadout
      {...opts}
      min={min}
      max={max}
      value={value}
      format={format}
      className={cn(
        t.readout,
        // Horizontal reserves width so the row doesn't reflow as digits change;
        // vertical must NOT, or the readout sets the whole control's width.
        horizontal ? "min-w-13" : "min-w-0",
      )}
    />
  ) : null;

  const minCap = caps ? (
    <Cap label="Zoom out" onStep={() => c.nudge(-1)} tokens={t}>
      {minIcon ?? <Minus />}
    </Cap>
  ) : null;
  const maxCap = caps ? (
    <Cap label="Zoom in" onStep={() => c.nudge(1)} tokens={t}>
      {maxIcon ?? <Plus />}
    </Cap>
  ) : null;

  return (
    <div
      title={title}
      aria-label={opts["aria-label"]}
      className={cn(
        "material-glass pointer-events-auto flex items-center",
        t.frame,
        horizontal ? "flex-row" : "flex-col",
        opts.disabled && "opacity-40",
        className,
      )}
    >
      {/* Horizontal: [−][wedge][+][readout]. Vertical: [+]/[wedge]/[−]/[readout]
          so the top cap grows, matching the up-is-bigger wedge. */}
      {horizontal ? minCap : maxCap}
      {track}
      {horizontal ? maxCap : minCap}
      {readout}
    </div>
  );
}

/**
 * THE ZOOM READOUT — a percentage you can DRAG.
 *
 * A number that names a value should change it; that is the convention every
 * DCC tool has had for twenty years, and a zoom percentage you can only read is
 * the one place this app broke it. It reads as a label, so nobody discovers the
 * dial hiding behind it.
 *
 * Built on `useSliderControl` with `grab: "hold"` and a named `travelPx`, for
 * the same reason the Knob is: a readout has no track to aim along, so a press
 * must change nothing and travel must be a DISTANCE rather than a position.
 * `axis: "both"` means neither a horizontal nor a vertical wrist movement is
 * the wrong one.
 *
 * Exported so a host that wants ONLY the number — the stage's chrome capsule,
 * where the dial itself lives in a popover — gets the identical gesture,
 * formatting and reset instead of rendering a `<span>` and calling it a day.
 * The drag has a threshold via `usePointerDrag`, so a plain click still reaches
 * whatever the host wrapped it in.
 */
export function ZoomReadout({
  format,
  className,
  spec,
  min: minProp,
  max: maxProp,
  value: rawValue,
  ...opts
}: ZoomControlProps & { format: (v: number) => string }) {
  const min = minProp ?? spec?.min ?? 0;
  const max = maxProp ?? spec?.max ?? 1;
  const value = Math.min(max, Math.max(min, Number.isFinite(rawValue) ? rawValue : (spec?.default ?? min)));
  const c = useSliderControl({ ...opts, min, max, value, grab: "hold", axis: "both", travelPx: 260 });
  /**
   * A DRAG IS NOT A CLICK. The readout is meant to be wrapped — the stage puts
   * it inside a popover trigger — and a pointer that travelled still ends with
   * a `click`, so scrubbing the value would also open whatever it was wrapped
   * in. Swallowing that click in capture keeps both gestures on one target:
   * press-and-move scrubs, press-and-release opens.
   */
  const moved = React.useRef(false);
  return (
    <span
      ref={c.trackRef}
      {...c.trackProps}
      onPointerDown={(e) => {
        moved.current = false;
        c.trackProps.onPointerDown(e);
      }}
      onPointerMove={(e) => {
        if (c.dragging) moved.current = true;
        c.trackProps.onPointerMove(e);
      }}
      onClickCapture={(e) => {
        if (!moved.current) return;
        moved.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
      {...c.keyProps}
      title="Drag to zoom · double-click to reset"
      className={cn(
        "shrink-0 cursor-ew-resize select-none rounded-md bg-foreground/5 text-center font-mono font-medium tabular-nums tracking-tight outline-none transition-colors",
        c.dragging ? "bg-foreground/10 text-foreground" : "text-foreground/80 hover:bg-foreground/10 hover:text-foreground",
        opts.disabled && "pointer-events-none",
        className,
      )}
    >
      {format(c.value)}
    </span>
  );
}

/**
 * THE PRESET LIST for a zoom KIND (README D5) — the rows under a zoom dial:
 * Fit (where the kind can fit) and the spec's presets, the current one
 * checked. One component so the stage, the node board and every camera view
 * offer the same presets in the same order with the same shortcut hints.
 */
export function ZoomPresetList({
  spec,
  value,
  onPick,
  onFit,
  viewportPx,
}: {
  spec: ViewZoomSpec;
  value: number;
  /** An absolute level from a preset. */
  onPick: (level: number) => void;
  /** Fit, for kinds that can. Omit to hide the Fit row. */
  onFit?: () => void;
  /** For `time` presets (durations → px/s). */
  viewportPx?: number;
}) {
  const rows = spec.presets.filter((p) => p.value !== "fit" || (spec.fit && onFit));
  return (
    <div className="flex flex-col">
      {rows.map((p) => {
        const isFit = p.value === "fit";
        const level = isFit ? NaN : spec.kind === "time" ? (viewportPx ?? 1000) / (p.value as number) : (p.value as number);
        const on = !isFit && Math.abs(value - level) / Math.max(level, 1e-6) < 0.005;
        return (
          <button
            key={p.label}
            type="button"
            onClick={() => (isFit ? onFit?.() : onPick(level))}
            className="flex w-full items-center gap-2 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            style={{ height: "var(--control-h)" }}
          >
            <Check className={cn("size-3.5", !on && "opacity-0")} />
            <span className="flex-1 text-left">{p.label}</span>
            {isFit && <kbd className="rounded bg-secondary px-1 font-mono text-2xs">⌘0</kbd>}
            {!isFit && spec.actual && level === 1 && <kbd className="rounded bg-secondary px-1 font-mono text-2xs">⇧0</kbd>}
          </button>
        );
      })}
    </div>
  );
}
