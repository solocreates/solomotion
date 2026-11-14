"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { blockFills, rangeDetent, rangeStep, rulerPaint, rulerScale, stepOpacities } from "@solomotion/theme";
import { useSliderControl, type SliderDetent, type SliderOrientation, type SliderScaleKind } from "./slider-base";
import { rootDialect, useRootDialect } from "./use-root-dialect";
import { PartLabel } from "./part-label";

/**
 * RANGE — the app's one value control, on either axis.
 *
 * The old sliders were 16px tall thumbs on a 4px rail, dropped into rows of
 * 28px inputs. Nothing ever lined up, so every property row read as broken.
 * This is the fix, and it is a different OBJECT, not a restyle: a filled bar
 * the exact height of an input, with the label and the value living INSIDE it.
 * Beside a number field it reads as a sibling; on its own it reads as a meter
 * you can grab. (Ableton, Blender and DaVinci all landed here for the same
 * reason — a rail-and-thumb wastes the vertical space a dense panel doesn't
 * have, and gives you a 12px target instead of a 200px one.)
 *
 * The whole bar is the hit target. There is no thumb to miss.
 *
 * THE FILL IS NEUTRAL AND THE EDGE CARRIES THE ACCENT. It used to be the accent
 * itself at 28–42% alpha across the whole bar, which is the one thing the design
 * system says never to build: a saturated accent-filled slab. At 20% of the
 * range it looked like a tasteful tint and at 90% it was a maroon brick with
 * text on it, and a column of three of them read as three coloured buttons
 * rather than three meters. The value step is now a brighter pane of the same
 * track — the same move `material-glass-raised` makes — and the accent is a
 * 2px leading edge, which is also the only part that says exactly WHERE the
 * value is. `tone` still overrides the fill for the controls whose colour is
 * the data (grade wheels, EQ bands).
 *
 * Gesture, keyboard, wheel and log-scaling all come from `useSliderControl` —
 * the same brain behind the zoom dials and faders — so a Range cannot drift
 * from the rest of the app's drag behaviour.
 *
 *   <Range label="Thickness" value={v} min={0} max={100} unit="px" onChange={…} />
 *   <Range value={mix} min={0} max={1} step={0.01} onChange={…} />          // bare
 *   <Range value={lift} min={-1} max={1} origin={0} onChange={…} />          // bipolar
 *   <Range orientation="vertical" length={140} value={size} … />             // fader
 *
 * DIALECTS. A theme draws a Range one of several ways (meter, trail, ruler,
 * blocks, steps, line), and picks one for AMOUNTS and one for MEASURES — so
 * `kind="measure"` (scale, size, angle, pan, zoom) may wear a ruler while an
 * opacity beside it wears a trail. The paint is `parts.css`; the two
 * instrument dialects also carry detents (`range-math`): a ruler steps tick to
 * tick, blocks step a whole block, ⇧ frees both, arrows step one tick.
 *
 * VERTICAL is the same object stood on its end, not a second control: same
 * hook, same detents, same reset, same keys, and `--control-h` becomes its
 * WIDTH so a column of them lines up with the row of them. It carries no text,
 * because a bar 28px wide has nowhere to put a word without rotating it — the
 * caller shows the readout beside the fader, where there is room for it to be
 * big enough to read while you drag (the stage brush handle does exactly this).
 */

export interface RangeProps {
  value: number;
  /**
   * What the value IS: an amount (opacity, mix, volume — the default) or a
   * measure (scale, size, angle, pan, zoom). A theme may draw them in
   * different dialects.
   */
  kind?: "amount" | "measure";
  min: number;
  max: number;
  /** Snap increment (linear scales only). */
  step?: number;
  scale?: SliderScaleKind;
  /**
   * Which way the bar runs. Vertical fills bottom→top (up = more, the mixer
   * convention every fader in every tool obeys) and shows no inline text.
   */
  orientation?: SliderOrientation;
  /** Vertical only: how tall the fader is. */
  length?: number | string;
  /**
   * Vertical only: how WIDE the bar is. `--control-h` by default, so a fader
   * beside a field is the same gauge as the field. Narrower where the control
   * is a thumb-rest rather than a form row — the stage handle runs slim, since
   * every pixel it takes is canvas.
   */
  thickness?: number | string;
  /**
   * Where the fill grows FROM. Defaults to `min`. Pass `0` on a signed range
   * (−1…1 lift, −100…100 balance) and the bar fills outward from centre, which
   * is the only way a bipolar value reads correctly at a glance.
   */
  origin?: number;
  /** Shown inside the bar, left. Omit for a bare meter. */
  label?: React.ReactNode;
  /** Appended to the readout ("px", "%", "°"). */
  unit?: string;
  /** Decimal places in the readout. Inferred from `step` when omitted. */
  precision?: number;
  /** Hide the numeric readout (when a NumberInput sits beside it). */
  hideValue?: boolean;
  /** Custom readout — wins over unit/precision. */
  format?: (v: number) => string;
  /** Double-click resets here. Also drawn as a faint notch on the track. */
  defaultValue?: number;
  /**
   * CHECKPOINTS the value is pulled toward — unity, centre, a 100%. Drawn on
   * the track, so the assist is visible rather than a surprise: a detent you
   * cannot see reads as the control sticking. ⇧ releases the pull, ⌃ forces it
   * (see `drag-modifiers`).
   *
   * Give the values that MEAN something, not an even lattice — that is `step`.
   */
  ticks?: number[];
  /** How near a checkpoint pulls from. `"3%"` of the range by default. */
  snapRadius?: number | `${number}%`;
  disabled?: boolean;
  /**
   * Wheel-to-change. OFF by default and deliberately so: a Range lives inside
   * scrolling panels, where grabbing the wheel means the panel stops scrolling
   * the instant the pointer crosses a slider — which reads as the app being
   * broken. The zoom DIALS opt in (they sit on the stage and the timeline,
   * where the wheel already means "change this"); nothing in a panel should.
   */
  wheel?: boolean;
  /** Paint the fill in this colour instead of the accent (grade wheels, EQ bands). */
  tone?: string;
  className?: string;
  onChange: (v: number) => void;
  /** Fired once when a drag ends — the seam for history commits. */
  onCommit?: (v: number) => void;
  "aria-label"?: string;
}

/**
 * The value step: a brighter pane of the track, never a colour. Brightens on
 * hover and again while dragging, so the control answers a pointer without
 * changing hue — the whole vocabulary of these bars is VALUE.
 */
function fillPaint(tone: string | undefined, dragging: boolean): string {
  if (tone) return tone;
  return dragging ? "color-mix(in srgb, var(--foreground) 16%, transparent)" : "color-mix(in srgb, var(--foreground) 9%, transparent)";
}

function decimalsOf(step: number | undefined): number {
  if (!step) return 2;
  const s = String(step);
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : Math.min(4, s.length - dot - 1);
}

export function Range({
  value,
  min,
  max,
  step,
  scale = "linear",
  orientation = "horizontal",
  length,
  thickness,
  origin,
  label,
  unit,
  precision,
  hideValue,
  format,
  defaultValue,
  ticks,
  snapRadius,
  disabled,
  wheel = false,
  tone,
  className,
  onChange,
  onCommit,
  kind = "amount",
  ...aria
}: RangeProps) {
  const attr = kind === "measure" ? "measure" : "range";
  const dialect = useRootDialect(attr);
  // Detents are asked at each move, from the root, so the behaviour can never
  // disagree with the paint the same attribute chose.
  const detent = React.useMemo<SliderDetent | undefined>(
    () =>
      scale === "log"
        ? undefined
        : {
            snap: (v, free) => rangeDetent(rootDialect(attr), v, min, max, { free, unit }),
            step: (v, dir) => rangeStep(rootDialect(attr), v, dir, min, max, { unit }),
          },
    [attr, min, max, unit, scale],
  );
  const c = useSliderControl({
    value,
    min,
    max,
    step,
    scale,
    orientation,
    wheel,
    ticks,
    snapRadius,
    detent,
    disabled,
    onChange,
    // ONE commit per gesture, from the brain. This used to watch `dragging`
    // fall, which reported a drag and nothing else — a value changed by the
    // arrow keys or the wheel never reached history at all.
    onCommit,
    onReset: defaultValue === undefined ? undefined : () => onChange(defaultValue),
  });

  // Everything below paints from `c.value` — the optimistic value while a drag
  // is in flight — so the bar and its readout track the pointer at screen rate
  // even when the document store is committing four times a second.
  const shown = c.value;
  const frac = (v: number) => (max <= min ? 0 : Math.min(1, Math.max(0, (v - min) / (max - min))));
  const originFrac = origin === undefined ? 0 : frac(origin);
  const lo = Math.min(c.fraction, originFrac);
  const hi = Math.max(c.fraction, originFrac);

  const digits = precision ?? decimalsOf(step);
  const text = format ? format(shown) : `${shown.toFixed(digits)}${unit ? ` ${unit}` : ""}`;

  /**
   * TYPE AN EXACT VALUE. Dragging is for exploring; some values you simply
   * know. Double-clicking the readout swaps the bar for an input rather than
   * moving the handle, so a slider is never the reason you cannot enter 37.
   * (Double-click on the TRACK still resets — two different targets, two
   * different jobs.)
   */
  const [typing, setTyping] = React.useState<string | null>(null);
  const commitTyped = () => {
    const raw = (typing ?? "").trim().replace(/[^0-9.eE+-]/g, "");
    const n = Number(raw);
    if (raw !== "" && Number.isFinite(n)) {
      const v = Math.min(max, Math.max(min, n));
      onChange(v);
      onCommit?.(v);
    }
    setTyping(null);
  };

  if (typing !== null) {
    return (
      <input
        autoFocus
        value={typing}
        onChange={(e) => setTyping(e.target.value)}
        onBlur={commitTyped}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commitTyped();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setTyping(null);
          }
        }}
        onFocus={(e) => e.target.select()}
        aria-label={aria["aria-label"] ?? (typeof label === "string" ? label : undefined)}
        data-part="field"
        data-num=""
        className={cn("w-full min-w-0 px-2 text-body outline-none", className)}
        style={{ height: "var(--control-h)" }}
      />
    );
  }

  /**
   * VERTICAL. A separate tree rather than a pile of ternaries through the
   * horizontal one: the two share their BRAIN (one `useSliderControl` above,
   * already configured with the orientation) and share nothing else, because a
   * fader has no label cell, no readout cell and no typing affordance to
   * arrange. Interleaving them would have meant fourteen conditionals to save
   * twenty lines, and every future change to either paying for both.
   */
  if (!c.horizontal) {
    return (
      <div
        ref={c.trackRef}
        {...c.trackProps}
        {...c.keyProps}
        aria-label={aria["aria-label"] ?? (typeof label === "string" ? label : undefined)}
        data-dragging={c.dragging || undefined}
        className={cn(
          "group/range relative isolate select-none overflow-hidden rounded-md",
          "border border-transparent bg-input",
          "cursor-ns-resize outline-none",
          "transition-[background,border-color] duration-100",
          "hover:border-border focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring",
          "data-[dragging]:border-ring",
          disabled && "pointer-events-none opacity-40",
          className,
        )}
        // `--control-h` is the WIDTH here, so a fader beside a field is the same
        // gauge as a Range above it. Merge the gesture's own style rather than
        // replacing it — `touch-action` travels with the handlers.
        style={{ ...c.trackProps.style, width: thickness ?? "var(--control-h)", height: length ?? 120 }}
      >
        {ticks?.map(
          (t) =>
            t > min &&
            t < max && (
              <React.Fragment key={t}>
                <span aria-hidden className="absolute left-0 h-px w-1 bg-foreground/20" style={{ bottom: `${frac(t) * 100}%` }} />
                <span aria-hidden className="absolute right-0 h-px w-1 bg-foreground/20" style={{ bottom: `${frac(t) * 100}%` }} />
              </React.Fragment>
            ),
        )}
        {defaultValue !== undefined && defaultValue > min && defaultValue < max && (
          <span
            aria-hidden
            className="absolute inset-x-1 h-px bg-foreground/25"
            style={{ bottom: `${frac(defaultValue) * 100}%` }}
          />
        )}

        <span
          aria-hidden
          className="absolute inset-x-0 -z-10 transition-[background] duration-100 group-hover/range:brightness-150"
          style={{
            bottom: `${lo * 100}%`,
            height: `${(hi - lo) * 100}%`,
            background: fillPaint(tone, c.dragging),
          }}
        />
        {/* The leading edge — the accent, and the only part that says exactly
            where the value is. It stays at the ends rather than fading out:
            "pinned at the minimum" is a state worth seeing. */}
        <span
          aria-hidden
          className="absolute inset-x-0 h-0.5 rounded-full transition-[bottom] duration-75"
          style={{
            bottom: `calc(${c.fraction * 100}% - ${c.fraction >= 0.5 ? 2 : 0}px)`,
            background: tone ?? "var(--primary)",
          }}
        />
      </div>
    );
  }

  const ruler = dialect === "ruler" ? rulerPaint(min, max, rulerScale(min, max, { unit })) : null;
  const cells = dialect === "blocks" ? blockFills(c.fraction) : dialect === "steps" ? stepOpacities(c.fraction) : null;
  const style = {
    ...c.trackProps.style,
    height: "var(--control-h)",
    "--f": c.fraction,
    "--lo": lo,
    "--hi": hi,
    ...(tone ? { "--range-tone": tone, "--range-edge": tone } : null),
    ...(ruler ? { "--rule-minor": ruler.minorPct, "--rule-major": ruler.majorPct, "--rule-offset": ruler.offsetPct } : null),
  } as React.CSSProperties;

  return (
    <div
      ref={c.trackRef}
      {...c.trackProps}
      {...c.keyProps}
      aria-label={aria["aria-label"] ?? (typeof label === "string" ? label : undefined)}
      data-part="range"
      data-kind={kind}
      data-dialect={dialect ?? "meter"}
      data-dragging={c.dragging || undefined}
      className={cn(
        "relative flex min-w-0 select-none items-center text-body",
        "cursor-ew-resize outline-none",
        disabled && "pointer-events-none opacity-40",
        className,
      )}
      style={style}
    >
      {/* Checkpoints: short marks at the EDGES of the bar, findable while a
          drag is in flight and invisible the rest of the time. The reset notch
          is one shade brighter: the checkpoint you most likely want. */}
      {ticks?.map(
        (t) =>
          t > min &&
          t < max && (
            <React.Fragment key={t}>
              <span aria-hidden className="absolute top-0 h-1 w-px bg-foreground/20" style={{ left: `${frac(t) * 100}%` }} />
              <span aria-hidden className="absolute bottom-0 h-1 w-px bg-foreground/20" style={{ left: `${frac(t) * 100}%` }} />
            </React.Fragment>
          ),
      )}
      {defaultValue !== undefined && defaultValue > min && defaultValue < max && (
        <span aria-hidden className="absolute inset-y-1 w-px bg-foreground/25" style={{ left: `${frac(defaultValue) * 100}%` }} />
      )}

      {/* Every piece any dialect draws; `parts.css` shows the ones this
          theme's dialect uses. Cheap spans, no work per frame. */}
      <span aria-hidden data-el="fill" />
      <span aria-hidden data-el="ghost" />
      <span aria-hidden data-el="ghost" />
      <span aria-hidden data-el="ghost" />
      <span aria-hidden data-el="rule" />
      <span aria-hidden data-el="edge" />
      {cells && (
        <span aria-hidden data-el="blocks">
          {cells.map((x, i) => (
            <i key={i} style={{ [dialect === "steps" ? "--bo" : "--bf"]: x } as React.CSSProperties} />
          ))}
        </span>
      )}

      {label !== undefined &&
        (typeof label === "string" ? (
          <PartLabel data-el="label" className="min-w-0 flex-1 truncate pl-2" text={label} />
        ) : (
          <span data-el="label" className="min-w-0 flex-1 truncate pl-2">
            {label}
          </span>
        ))}
      {!hideValue && (
        <span
          data-el="value"
          data-num=""
          onDoubleClick={(e) => {
            e.stopPropagation();
            setTyping(String(Number(shown.toFixed(digits))));
          }}
          className={cn(
            // The readout takes pointer events ONLY so it can catch a
            // double-click; a single click still falls through to the track,
            // because stealing it would break "click anywhere to set".
            "shrink-0 cursor-text px-2",
            label === undefined && "ml-auto",
          )}
        >
          {text}
        </span>
      )}
      {label === undefined && hideValue && <span className="flex-1" />}
    </div>
  );
}

/**
 * A Range with a number field welded to its right — the pattern for any value
 * you both scrub and type. Kept here rather than assembled at each call site so
 * the gap, the field width and the two controls' shared height are decided
 * once. `children` is the field (a `NumberInput`), so this stays free of an
 * import cycle and any numeric editor can slot in.
 */
export function RangeWithField({
  className,
  fieldWidth = 68,
  children,
  ...range
}: RangeProps & { fieldWidth?: number; children: React.ReactNode }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <Range {...range} hideValue className="flex-1" />
      <div className="shrink-0" style={{ width: fieldWidth }}>
        {children}
      </div>
    </div>
  );
}
