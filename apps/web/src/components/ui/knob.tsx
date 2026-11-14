"use client";

import * as React from "react";
import { scaleFromFraction, scaleToFraction, useSliderControl, type SliderScaleKind } from "./slider-base";
import { NumberInput } from "./number-input";
import { cn } from "@/lib/utils";
import { useLiveValue } from "./use-live-value";
import { capturePointer } from "../../editor/input/capture-pointer";

/**
 * THE KNOB — the rotary control the audio panels are built from.
 *
 * A fader is the right control for a level you compare against other levels;
 * a knob is the right control for a value with a HOME POSITION you return to —
 * a cutoff, a ratio, a dry/wet. Audio work is full of the second kind, which is
 * why every mixing surface ever built is covered in them, and why a wall of
 * number inputs never feels like a sound tool no matter how correct it is.
 *
 * The gesture is what every pro plugin uses: **drag anywhere on the cap**, up or
 * right to increase, down or left to decrease. Absolute-angle rotation is
 * deliberately NOT the default — it forces the pointer onto a circle to make a
 * small change and jumps the value if you press slightly off-axis. Turning a
 * real knob is a wrist movement; dragging is the honest screen translation of
 * it. `gesture="rotary"` opts into absolute angle for the rare case (a pan
 * pointer, a phase dial) where the ANGLE itself is the meaning.
 *
 * Gesture, keyboard, wheel, log scale and detents come from `useSliderControl`
 * — the SAME brain behind every Range and zoom dial. It used to hand-roll all
 * of them, and the two drifted exactly where you would expect: ⇧ meant "snap to
 * detents" on a knob and "fine travel, snapping OFF" on a slider, so the one
 * modifier a person learns did opposite things two rows apart. There is one
 * contract now, and it is the shared one:
 *
 *   ⇧  fine travel, detents off — the modifier for hitting an exact value
 *   ⇥  focus, then arrows / Page / Home / End — full keyboard parity
 *   ⌄  double-click resets to the factory default
 *
 * Detents PULL on their own, within `snapRadius`, instead of waiting for a
 * modifier — an assist you get without knowing it exists, which is the point of
 * a checkpoint. ⇧ turns the pull off, so precision is always one key away.
 *
 * Log scale is first-class and not optional: a frequency knob on a linear map
 * spends four fifths of its travel above 4 kHz, which is unusable. The map is
 * the SAME one the sliders use, so a value reads identically whichever control
 * it is bound to.
 *
 * The readout underneath is a real `NumberInput` — draggable and typeable — so
 * the precise path is never taken away by the pretty one.
 */

/** Pixels of drag for the knob's full travel. Tuned against Ableton/Serum feel. */
const TRAVEL_PX = 180;
/** Total sweep of the arc. 270° leaves a visible gap at the bottom, so the
 *  minimum and the maximum never look like the same position. */
const SWEEP_DEG = 270;
const START_DEG = -135;

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);
const clamp01 = (n: number) => clamp(n, 0, 1);

export interface KnobProps {
  value: number;
  onChange: (v: number) => void;
  /** Called once when the gesture ENDS — for history coalescing. */
  onCommit?: (v: number) => void;
  min: number;
  max: number;
  /** Quantisation for the typed/keyboard path. Dragging stays continuous. */
  step?: number;
  scale?: SliderScaleKind;
  /** Fill the arc outward from the centre instead of from `min` (−1…1 trims). */
  bipolar?: boolean;
  /**
   * Checkpoint values the cap is PULLED toward. Give the ones that MEAN
   * something — unity, 0 dB, fully wet — not an even lattice, which is what
   * `step` is for. ⇧ disables the pull.
   */
  detents?: readonly number[];
  /** How near a detent pulls from. `"3%"` of the range by default. */
  snapRadius?: number | `${number}%`;
  /** Absolute-angle rotation instead of drag. Only when the angle IS the value. */
  gesture?: "drag" | "rotary";
  /** Double-click target. Also drawn as a faint tick on the arc. */
  defaultValue?: number;
  label?: string;
  unit?: string;
  precision?: number;
  /** Diameter in px. 44 is the panel default; 64 for a hero control. */
  size?: number;
  disabled?: boolean;
  /** Hide the numeric readout (a dense strip of small knobs). */
  hideValue?: boolean;
  title?: string;
  className?: string;
}

export function Knob({
  value,
  onChange,
  onCommit,
  min,
  max,
  step,
  scale = "linear",
  bipolar,
  detents,
  snapRadius,
  gesture = "drag",
  defaultValue,
  label,
  unit,
  precision,
  size = 44,
  disabled,
  hideValue,
  title,
  className,
}: KnobProps) {
  const ref = React.useRef<SVGSVGElement | null>(null);

  /**
   * The whole gesture, from the shared brain. `grab: "hold"` because a cap has
   * no position to aim at — pressing it must not throw the value away — and
   * `travelPx` because it has no length to drag along either, so it names the
   * distance instead. `axis: "both"` sums up-and-right, so neither a vertical
   * nor a horizontal wrist movement is the "wrong" one.
   */
  const ctl = useSliderControl({
    value,
    min,
    max,
    step,
    scale,
    grab: "hold",
    travelPx: TRAVEL_PX,
    axis: "both",
    // A knob lives in scrolling panels, and a wall of them would eat the wheel
    // everywhere the pointer crossed one. Same reason Range defaults it off.
    wheel: false,
    disabled,
    ticks: detents ? [...detents] : undefined,
    snapRadius,
    onChange: (v) => onChange(v),
    onReset: defaultValue === undefined ? undefined : () => {
      onChange(clamp(defaultValue, min, max));
      onCommit?.(defaultValue);
    },
  });

  const shown = ctl.value;
  const fraction = clamp01(ctl.fraction);

  // Rotary is the one thing the brain cannot own: it maps an ABSOLUTE screen
  // angle, not travel. Kept here, and only for the rare control (a pan pointer,
  // a phase dial) where the angle itself is the meaning.
  const [rotating, setRotating] = React.useState(false);
  const angleFraction = (e: React.PointerEvent | PointerEvent): number => {
    const el = ref.current;
    if (!el) return fraction;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    if (deg > 180) deg -= 360;
    return clamp01((deg - START_DEG) / SWEEP_DEG);
  };

  const rotaryDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    capturePointer((e.target as Element), e.pointerId);
    setRotating(true);
    onChange(scaleFromFraction(angleFraction(e), min, max, scale));
  };
  const rotaryMove = (e: React.PointerEvent) => {
    if (!rotating || disabled) return;
    onChange(scaleFromFraction(angleFraction(e), min, max, scale));
  };
  const rotaryUp = (e: React.PointerEvent) => {
    if (!rotating) return;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    setRotating(false);
    onCommit?.(shown);
  };

  const rotary = gesture === "rotary";
  const dragging = rotary ? rotating : ctl.dragging;
  const gestureProps = rotary
    ? { onPointerDown: rotaryDown, onPointerMove: rotaryMove, onPointerUp: rotaryUp, onPointerCancel: rotaryUp }
    : { ...ctl.trackProps, onPointerUp: () => onCommit?.(shown) };

  // Geometry. The arc is a stroked circle segment; `pathLength` normalises it to
  // 100 so the dash maths is in percent and independent of the radius.
  const r = size / 2;
  const stroke = Math.max(3, size * 0.09);
  const radius = r - stroke / 2 - 1;
  const arc = describeArc(r, r, radius, START_DEG, START_DEG + SWEEP_DEG);
  const zeroFraction = bipolar ? clamp01(scaleToFraction(0, min, max, scale)) : 0;
  const from = bipolar ? Math.min(zeroFraction, fraction) : 0;
  const to = bipolar ? Math.max(zeroFraction, fraction) : fraction;
  const pointerDeg = START_DEG + fraction * SWEEP_DEG;

  return (
    <div className={cn("flex flex-col items-center gap-1", className)} title={title}>
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        {...ctl.keyProps}
        aria-label={label}
        aria-valuenow={Number(shown.toFixed(precision ?? 2))}
        aria-orientation="vertical"
        aria-disabled={disabled}
        {...gestureProps}
        onDoubleClick={ctl.trackProps.onDoubleClick}
        // Focused-only wheel: a panel full of knobs must not swallow the
        // scroll, but a knob you have deliberately tabbed to should respond.
        onWheel={(e) => {
          if (disabled || document.activeElement !== e.currentTarget) return;
          e.preventDefault();
          ctl.nudge(e.deltaY < 0 ? 1 : -1, e.shiftKey);
        }}
        className={cn(
          "select-none outline-none transition-[filter]",
          disabled ? "cursor-not-allowed opacity-50" : "cursor-ns-resize",
          !disabled && "hover:brightness-110 focus-visible:brightness-110",
          dragging && "brightness-125",
        )}
      >
        {/* Unfilled travel. */}
        <path
          d={arc}
          pathLength={100}
          fill="none"
          strokeLinecap="round"
          strokeWidth={stroke}
          className="stroke-muted-foreground/20"
        />
        {/* Detents — the checkpoints ⇧ snaps to, so the gesture is discoverable. */}
        {detents?.map((d) => {
          const f = clamp01(scaleToFraction(d, min, max, scale));
          const p = pointOnCircle(r, r, radius, START_DEG + f * SWEEP_DEG);
          return (
            <circle key={d} cx={p.x} cy={p.y} r={Math.max(0.8, size * 0.022)} className="fill-muted-foreground/45" />
          );
        })}
        {/* The value. `to - from` in percent, offset by `from`. */}
        <path
          d={arc}
          pathLength={100}
          fill="none"
          strokeLinecap="round"
          strokeWidth={stroke}
          strokeDasharray={`${Math.max(0.001, (to - from) * 100)} 100`}
          strokeDashoffset={-from * 100}
          className="stroke-primary transition-[stroke-dasharray,stroke-dashoffset] duration-75"
        />
        {/* The cap, with the light from above that makes it read as a physical
            object rather than a circle. */}
        <circle cx={r} cy={r} r={radius - stroke * 0.85} className="fill-secondary stroke-border/80" strokeWidth={1} />
        <circle
          cx={r}
          cy={r - radius * 0.12}
          r={(radius - stroke * 0.85) * 0.82}
          className="fill-foreground/[0.06]"
        />
        {/* The indicator — the one line that says which way it is pointing. */}
        <line
          x1={pointOnCircle(r, r, radius * 0.3, pointerDeg).x}
          y1={pointOnCircle(r, r, radius * 0.3, pointerDeg).y}
          x2={pointOnCircle(r, r, radius * 0.72, pointerDeg).x}
          y2={pointOnCircle(r, r, radius * 0.72, pointerDeg).y}
          strokeLinecap="round"
          strokeWidth={Math.max(1.5, size * 0.055)}
          className="stroke-foreground/85"
        />
      </svg>

      {label && (
        <span className="max-w-full truncate text-[10px] leading-none text-muted-foreground">{label}</span>
      )}
      {!hideValue && (
        <NumberInput
          value={shown}
          onChange={(v) => onChange(clamp(v, min, max))}
          onCommit={onCommit}
          min={min}
          max={max}
          step={step}
          precision={precision}
          unit={unit}
          disabled={disabled}
          className="h-6 w-full text-[10px]"
        />
      )}
    </div>
  );
}

function pointOnCircle(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  // −90° so 0° points UP, which is where a knob's "twelve o'clock" belongs.
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const start = pointOnCircle(cx, cy, r, startDeg);
  const end = pointOnCircle(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y}`;
}
