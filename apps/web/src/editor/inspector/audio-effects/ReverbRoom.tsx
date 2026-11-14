"use client";

import * as React from "react";
import {
  AFX,
  earlyReflections,
  roomVolumeM3,
  sabineDecaySec,
  type AudioEffect,
  type Clip,
  type EffectFieldDef,
  type KeyframeValue,
} from "@solomotion/core";
import { cn } from "@/lib/utils";
import { useEffectiveValue } from "./../animatable";
import { capturePointer } from "../../input/capture-pointer";

/**
 * THE REVERB ROOM — a space you resize by dragging its walls.
 *
 * This is not a diagram beside the controls; it IS the control. Width, height
 * and length generate the impulse response (`audio/reverb-ir.ts`), so dragging
 * a wall genuinely re-renders what you hear. The reflection rays and the decay
 * graph below are drawn from `earlyReflections()` — the exact taps that end up
 * in the convolver — which is what keeps the picture honest. Every competitor
 * that draws a pretty room and a separate "size" knob is showing you an
 * illustration; this is the model.
 *
 * One-point perspective, because it reads instantly at panel size: the near
 * wall is the rectangle you grab for width and height, and the far wall's
 * distance is the room's length. The listener sits at the near end and the
 * source is the dot you slide down the room — which is exactly what Distance
 * means, so the control and the concept are the same gesture.
 *
 * Everything writes through the card's keyframe-aware commit, so a room that
 * grows over time is just an animation like any other.
 */

const VIEW_W = 320;
const VIEW_H = 190;

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);
const norm = (v: number, lo: number, hi: number) => clamp((v - lo) / (hi - lo), 0, 1);

type Reverb = Extract<AudioEffect, { type: "reverb" }>;
type Handle = "width" | "height" | "length" | "distance";

export function ReverbRoom({
  clip,
  effect,
  onCommit,
}: {
  clip: Clip;
  effect: Reverb;
  onCommit: (e: AudioEffect, f: EffectFieldDef, v: KeyframeValue, label: string) => void;
}) {
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = React.useState<Handle | null>(null);

  // Values resolve through the keyframe sampler, so a keyed room shows the
  // shape it actually has at the playhead rather than its base value.
  const v = (key: keyof Reverb & string) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffectiveValue(clip, AFX.path(effect.id, key), effect[key] as number) as number;

  const widthM = v("widthM");
  const heightM = v("heightM");
  const lengthM = v("lengthM");
  const distance = v("distance");

  const fieldOf = (key: string): EffectFieldDef =>
    AFX.def("reverb")!.fields.find((f) => f.key === key) ?? { key, label: key, kind: "number" };

  const set = (key: string, value: number) =>
    onCommit(effect, fieldOf(key), value, `Reverb ${fieldOf(key).label}`);

  // ── Geometry ───────────────────────────────────────────────────────────────
  // The near wall grows with the room's own width/height; the far wall shrinks
  // with length, which is what makes a corridor read as a corridor.
  const nearW = 70 + norm(widthM, 1, 60) * 170;
  const nearH = 50 + norm(heightM, 1, 30) * 105;
  const depth = 0.24 + norm(lengthM, 1, 60) * 0.5; // 0..1 → how far the back wall recedes
  const cx = VIEW_W / 2;
  const cy = VIEW_H / 2 + 6;

  // `width`/`height`, NOT `w`/`h`: the short names are not SVG attributes, so
  // spreading them rendered a zero-sized rect and the room was invisible.
  const near = { x: cx - nearW / 2, y: cy - nearH / 2, width: nearW, height: nearH };
  const farW = nearW * (1 - depth * 0.62);
  const farH = nearH * (1 - depth * 0.62);
  const far = { x: cx - farW / 2, y: cy - farH / 2 - depth * 8, width: farW, height: farH };

  /** Where the source dot sits along the room's depth. */
  const srcT = clamp(distance, 0, 1);
  const src = {
    x: cx,
    y: near.y + near.height * 0.62 + (far.y + far.height * 0.62 - (near.y + near.height * 0.62)) * srcT,
  };
  const srcScale = 1 - srcT * 0.55;
  const listener = { x: cx, y: near.y + near.height * 0.86 };

  // ── Dragging ───────────────────────────────────────────────────────────────
  const pointAt = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * VIEW_W,
      y: ((e.clientY - r.top) / r.height) * VIEW_H,
    };
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = pointAt(e);
    const fine = e.altKey ? 0.35 : 1;
    const step = (raw: number, lo: number, hi: number, current: number) =>
      current + (clamp(raw, lo, hi) - current) * fine;

    if (drag === "width") {
      const halfPx = clamp(Math.abs(p.x - cx), 35, 120);
      set("widthM", round1(step(1 + ((halfPx * 2 - 70) / 170) * 59, 1, 60, widthM)));
    } else if (drag === "height") {
      const halfPx = clamp(Math.abs(p.y - cy), 25, 77.5);
      set("heightM", round1(step(1 + ((halfPx * 2 - 50) / 105) * 29, 1, 30, heightM)));
    } else if (drag === "length") {
      // Dragging the far wall UP/away lengthens the room.
      const d = clamp((cy - p.y) / 70, 0, 1);
      set("lengthM", round1(step(1 + d * 59, 1, 60, lengthM)));
    } else {
      const t = clamp((p.y - (near.y + near.height * 0.62)) / (far.y + far.height * 0.62 - (near.y + near.height * 0.62)), 0, 1);
      set("distance", Math.round(t * 100) / 100);
    }
  };

  const grab = (h: Handle) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      capturePointer((e.target as Element), e.pointerId);
      setDrag(h);
    },
    onPointerMove: onMove,
    onPointerUp: (e: React.PointerEvent) => {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      setDrag(null);
    },
    onPointerCancel: () => setDrag(null),
  });

  const volume = roomVolumeM3({ widthM, heightM, lengthM });
  const natural = sabineDecaySec({ widthM, heightM, lengthM });
  const decaySec = v("decaySec");

  return (
    // The room, what it would naturally decay to, and the tail it actually has
    // — read top to bottom, because they are one argument in three steps. This
    // is the panel's PICTURE column, and its height is the window's height.
    <div className="space-y-2">
      <div className="relative overflow-hidden rounded-lg border border-border/60 bg-gradient-to-b from-primary/[0.06] via-background/30 to-black/40">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="w-full touch-none select-none"
          style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}
        >
          {/* Corner beams — near wall to far wall. */}
          {([
            [near.x, near.y, far.x, far.y],
            [near.x + near.width, near.y, far.x + far.width, far.y],
            [near.x, near.y + near.height, far.x, far.y + far.height],
            [near.x + near.width, near.y + near.height, far.x + far.width, far.y + far.height],
          ] as const).map(([x1, y1, x2, y2], i) => (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="stroke-primary/25" strokeWidth={1} />
          ))}

          {/* Reflection rays — the ACTUAL first bounces, source → wall → listener. */}
          {earlyReflections({
            widthM, heightM, lengthM,
            preDelayMs: v("preDelayMs"), decaySec, diffusion: v("diffusion"),
            damping: v("damping"), modulation: v("modulation"), distance,
            erLevel: v("erLevel"), tailLevel: v("tailLevel"),
          }).map((tap, i) => {
            const wallX =
              tap.wall === "left" ? far.x : tap.wall === "right" ? far.x + far.width : cx;
            const wallY =
              tap.wall === "ceiling" ? far.y : tap.wall === "floor" ? far.y + far.height : far.y + far.height / 2;
            return (
              <g key={tap.wall} className="pointer-events-none">
                <path
                  d={`M ${src.x} ${src.y} L ${wallX} ${wallY} L ${listener.x} ${listener.y}`}
                  fill="none"
                  className="stroke-primary"
                  strokeWidth={0.7}
                  opacity={clamp(tap.gain * 0.5, 0.06, 0.4)}
                  strokeDasharray="2 3"
                />
              </g>
            );
          })}

          {/* Far wall. */}
          <rect
            {...far}
            rx={2}
            fill="none"
            className={cn("stroke-primary/45 transition-colors", drag === "length" && "stroke-primary")}
            strokeWidth={1.25}
          />
          {/* Near wall — the frame you grab. */}
          <rect {...near} rx={3} fill="none" className="stroke-primary/70" strokeWidth={1.5} />

          {/* ── Grab targets. Wide invisible strokes so they are easy to hit. ── */}
          <line
            x1={near.x + near.width} y1={near.y} x2={near.x + near.width} y2={near.y + near.height}
            className="cursor-ew-resize stroke-transparent" strokeWidth={14} {...grab("width")}
          />
          <line
            x1={near.x} y1={near.y} x2={near.x + near.width} y2={near.y}
            className="cursor-ns-resize stroke-transparent" strokeWidth={14} {...grab("height")}
          />
          <rect
            x={far.x} y={far.y} width={far.width} height={far.height}
            className="cursor-ns-resize fill-transparent" {...grab("length")}
          />
          {/* Visible wall grips. */}
          <line
            x1={near.x + near.width} y1={cy - 9} x2={near.x + near.width} y2={cy + 9}
            className={cn("pointer-events-none stroke-primary", drag === "width" ? "opacity-100" : "opacity-70")}
            strokeWidth={3} strokeLinecap="round"
          />
          <line
            x1={cx - 9} y1={near.y} x2={cx + 9} y2={near.y}
            className={cn("pointer-events-none stroke-primary", drag === "height" ? "opacity-100" : "opacity-70")}
            strokeWidth={3} strokeLinecap="round"
          />

          {/* Listener — you, at the near end. */}
          <circle cx={listener.x} cy={listener.y} r={3.5} className="fill-foreground/70" />
          {/* Source — slide it away to trade direct sound for room. */}
          <circle
            cx={src.x} cy={src.y} r={13} className="cursor-grab fill-transparent" {...grab("distance")}
          />
          <circle
            cx={src.x} cy={src.y} r={5 * srcScale + 2}
            className={cn("pointer-events-none fill-primary transition-[r]", drag === "distance" && "fill-primary")}
          />
          <circle
            cx={src.x} cy={src.y} r={5 * srcScale + 7}
            className="pointer-events-none fill-none stroke-primary/40" strokeWidth={1}
          />

          {/* Readout. */}
          <text x={8} y={14} className="fill-muted-foreground text-[9px]" style={{ fontSize: 9 }}>
            {widthM.toFixed(1)} × {heightM.toFixed(1)} × {lengthM.toFixed(1)} m
          </text>
          <text x={VIEW_W - 8} y={14} textAnchor="end" className="fill-muted-foreground text-[9px]" style={{ fontSize: 9 }}>
            {Math.round(volume).toLocaleString()} m³
          </text>
        </svg>
      </div>

      {/* Sabine says what a room this size would REALLY do. Offered, never
          imposed — the typed decay stays the authority. */}
      {Math.abs(natural - decaySec) > 0.25 && (
        <button
          type="button"
          onClick={() => set("decaySec", Math.round(natural * 100) / 100)}
          className="w-full truncate rounded-md border border-dashed border-border/70 py-1 text-[10px] text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
        >
          This room decays in {natural.toFixed(2)} s — match it
        </button>
      )}

      <DecayGraph
        preDelayMs={v("preDelayMs")}
        decaySec={decaySec}
        damping={v("damping")}
        diffusion={v("diffusion")}
      />
    </div>
  );
}

/**
 * The tail, drawn. Pre-delay is the flat gap, then the build, then the 60 dB
 * fall — so "pre-delay" and "decay" stop being words and become the two parts
 * of a shape you can see.
 */
function DecayGraph({
  preDelayMs,
  decaySec,
  damping,
  diffusion,
}: {
  preDelayMs: number;
  decaySec: number;
  damping: number;
  diffusion: number;
}) {
  const W = 320;
  const H = 44;
  const totalSec = Math.max(0.4, preDelayMs / 1000 + decaySec);
  const pts: string[] = [];
  for (let i = 0; i <= 120; i++) {
    const t = (i / 120) * totalSec;
    const afterPre = t - preDelayMs / 1000;
    const build = afterPre <= 0 ? 0 : 1 - Math.exp(-afterPre / (0.01 + (1 - diffusion) * 0.08));
    const env = afterPre <= 0 ? 0 : Math.exp(-6.907755 * (afterPre / decaySec)) * build;
    pts.push(`${(i / 120) * W},${H - env * (H - 4) * (1 - damping * 0.25)}`);
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md border border-border/50 bg-black/25" style={{ aspectRatio: `${W} / ${H}` }}>
      <polyline points={`0,${H} ${pts.join(" ")} ${W},${H}`} className="fill-primary/20 stroke-none" />
      <polyline points={pts.join(" ")} fill="none" className="stroke-primary" strokeWidth={1.5} />
      <text x={4} y={9} className="fill-muted-foreground" style={{ fontSize: 8 }}>
        {totalSec.toFixed(2)}s
      </text>
    </svg>
  );
}

const round1 = (n: number) => Math.round(n * 10) / 10;
