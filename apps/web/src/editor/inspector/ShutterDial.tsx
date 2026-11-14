"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { capturePointer } from "../input/capture-pointer";
import { beginHeldDrag, type HeldDrag } from "../input/hold-to-drag";

/**
 * THE SHUTTER DIAL — a rotary shutter, drawn as one.
 *
 * Shutter angle and phase are the two numbers nobody holds in their head:
 * "-90° phase on a 180° shutter" is a sentence you have to decode every single
 * time, and the thing it decodes to — *the exposure straddles the frame* — is
 * a picture. So this draws the picture. The ring is one frame, the tick at the
 * top is the instant being rendered, and the lit arc is when the shutter is
 * open. Set the phase to zero and you can SEE the exposure fall behind the
 * frame instead of around it, which is the entire reason the default is -90.
 *
 * Dragging the arc's leading edge sets the angle; dragging its body sets the
 * phase. Both read out live, so the numbers below stay the authority and this
 * stays the explanation.
 */

const R = 26;
const CENTER = 32;

/** Polar → cartesian, with 0° at the TOP and sweeping clockwise (a film gate). */
function pt(deg: number, radius: number) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: CENTER + Math.cos(rad) * radius, y: CENTER + Math.sin(rad) * radius };
}

/** An SVG arc path from `from`° to `from + sweep`°, clockwise. */
function arc(from: number, sweep: number, radius: number): string {
  // A full turn cannot be expressed as a single arc (start === end), and the
  // shutter legitimately reaches 360 and beyond — so draw it in two halves.
  if (Math.abs(sweep) >= 359.99) {
    const a = pt(from, radius);
    const b = pt(from + 180, radius);
    return `M ${a.x} ${a.y} A ${radius} ${radius} 0 0 1 ${b.x} ${b.y} A ${radius} ${radius} 0 0 1 ${a.x} ${a.y}`;
  }
  const a = pt(from, radius);
  const b = pt(from + sweep, radius);
  return `M ${a.x} ${a.y} A ${radius} ${radius} 0 ${Math.abs(sweep) > 180 ? 1 : 0} 1 ${b.x} ${b.y}`;
}

export function ShutterDial({
  angle,
  phase,
  onChange,
  className,
}: {
  angle: number;
  phase: number;
  onChange: (next: { angle?: number; phase?: number }) => void;
  className?: string;
}) {
  const ref = React.useRef<SVGSVGElement>(null);
  const drag = React.useRef<{ mode: "angle" | "phase"; startDeg: number; startVal: number; arm: HeldDrag; armed: boolean } | null>(null);
  const gradientId = React.useId();

  // Past 360° the shutter overlaps itself; showing the overlap as a second,
  // brighter ring is more honest than clamping the drawing at a full turn.
  const primary = Math.min(angle, 360);
  const overflow = Math.max(0, angle - 360);

  const degAt = (e: React.PointerEvent | PointerEvent): number => {
    const el = ref.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    return (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  };

  const start = (mode: "angle" | "phase") => (e: React.PointerEvent) => {
    e.stopPropagation();
    capturePointer((e.target as Element), e.pointerId);
    /*
     * A dial is turned in every direction, so it has no axis to arbitrate with
     * and the scope can only fall back to the pause. That is the right answer
     * here: this is a 64px control in a scrolling panel, and a finger swiping
     * past it must not spin the shutter open.
     */
    drag.current = {
      mode,
      startDeg: degAt(e),
      startVal: mode === "angle" ? angle : phase,
      arm: beginHeldDrag(e, { axis: "both" }),
      armed: false,
    };
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.arm.update(e.clientX, e.clientY)) return;
    if (!d.armed) {
      // Rebase: the travel spent earning the gesture is not also turned.
      d.armed = true;
      d.startDeg = degAt(e);
    }
    // Unwrap the shortest path so a drag across the 12-o'clock seam does not
    // snap the value 360° the wrong way.
    let delta = degAt(e) - d.startDeg;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    const next = Math.round(d.startVal + delta);
    if (d.mode === "angle") onChange({ angle: Math.max(0, Math.min(720, next)) });
    else onChange({ phase: Math.max(-360, Math.min(360, next)) });
  };

  const end = () => {
    drag.current?.arm.end();
    drag.current = null;
  };

  const head = pt(phase + primary, R);

  return (
    <svg
      ref={ref}
      viewBox="0 0 64 64"
      className={cn("size-16 select-none", className)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      role="img"
      aria-label={`Shutter ${Math.round(angle)} degrees, phase ${Math.round(phase)} degrees`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ff8732" />
          <stop offset="100%" stopColor="#ff2885" />
        </linearGradient>
      </defs>

      {/* One frame. */}
      <circle cx={CENTER} cy={CENTER} r={R} className="fill-none stroke-input" strokeWidth={5} />

      {/* The open shutter — drag its body to slide the phase. */}
      <path
        d={arc(phase, primary, R)}
        stroke={`url(#${gradientId})`}
        strokeWidth={5}
        strokeLinecap="round"
        fill="none"
        className="cursor-grab active:cursor-grabbing"
        onPointerDown={start("phase")}
      />
      {overflow > 0 && (
        <path
          d={arc(phase, overflow, R - 6)}
          stroke={`url(#${gradientId})`}
          strokeWidth={2.5}
          strokeLinecap="round"
          fill="none"
          opacity={0.6}
        />
      )}

      {/* THIS frame's instant. Everything is read against it. */}
      <line
        x1={CENTER}
        y1={CENTER - R - 4}
        x2={CENTER}
        y2={CENTER - R + 4}
        className="stroke-foreground"
        strokeWidth={1.5}
        strokeLinecap="round"
      />

      {/* The closing edge — drag to open the shutter wider. */}
      <circle
        cx={head.x}
        cy={head.y}
        r={4}
        className="fill-background stroke-foreground cursor-ew-resize"
        strokeWidth={1.5}
        onPointerDown={start("angle")}
      />

      <text
        x={CENTER}
        y={CENTER + 3}
        textAnchor="middle"
        className="fill-foreground text-[11px] font-medium tabular-nums"
      >
        {Math.round(angle)}°
      </text>
    </svg>
  );
}
