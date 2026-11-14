"use client";

import * as React from "react";
import {
  MAX_STABILIZER_PX,
  createStabilizer,
  stabilizerPush,
  stabilizerRadius,
  type BrushPreset,
  type StabPoint,
} from "@solomotion/core";
import { useStageView } from "../state/session";

/**
 * WHAT THE SETTING LOOKS LIKE — the two pictures every paint control needs.
 *
 * They live apart from any one control because three surfaces want them: the
 * handle's readout card while you drag a fader, the Brush tab of the settings
 * sheet, and the Smoothing tab. A preview drawn twice is two previews that
 * eventually disagree about the thing they are previewing.
 *
 * Both are MEASUREMENTS, not illustrations. The dab is drawn at the size it
 * will land (brush size × stage zoom) with the tip's own hardness; the
 * stabiliser preview runs core's actual filter over a fixed demo stroke. A
 * preview that approximates is a preview that lies as soon as the real thing
 * changes.
 */

/** The dab, at the size it will land on the canvas. A preview that ignored the
 *  camera would be showing a number, not a brush. */
export function SizePreview({ size, brush }: { size: number; brush: BrushPreset | null }) {
  const scale = useStageView((v) => v.scale);
  const hardness = brush?.shape.hardness ?? 0.9;
  const roundness = brush?.shape.roundness ?? 1;
  const angle = brush?.shape.angle ?? 0;
  const onScreen = size * scale;
  const BOX = 72;
  // Past the box it is drawn at the box's size and the number carries the
  // truth. A preview that shrank once it stopped fitting would read as the
  // brush getting smaller.
  const d = Math.min(onScreen, BOX);
  return (
    <div className="relative flex size-[76px] items-center justify-center rounded-md bg-foreground/5">
      <span
        aria-hidden
        className="rounded-full"
        style={{
          width: d,
          height: d * roundness,
          transform: `rotate(${angle}deg)`,
          // Hardness IS the falloff — the same quantity the painter bakes into
          // the sprite, read straight off the preset.
          background:
            hardness >= 0.99
              ? "var(--foreground)"
              : `radial-gradient(closest-side, var(--foreground) ${Math.round(hardness * 100)}%, transparent 100%)`,
          opacity: 0.9,
        }}
      />
      {onScreen > BOX && (
        <span aria-hidden className="absolute inset-0 rounded-full ring-1 ring-inset ring-foreground/15" />
      )}
    </div>
  );
}

/**
 * OPACITY — a stroke laid over itself, which is the only honest picture of it.
 *
 * A flat swatch at 40% tells you what 40% of a colour looks like against this
 * panel, which is not the question: opacity in a paint tool is about what
 * happens where a stroke CROSSES itself and what shows through from underneath.
 * So the preview is two overlapping bands over a checker — the build-up and the
 * transparency are both visible, and the difference between 40% and 60% is
 * something you can see rather than read.
 */
export function OpacityPreview({ value, brush }: { value: number; brush: BrushPreset | null }) {
  const hardness = brush?.shape.hardness ?? 0.9;
  const soft = hardness < 0.99;
  return (
    <div
      className="relative size-[76px] overflow-hidden rounded-md"
      style={{
        // The checker says "this is transparency" without a word of copy.
        backgroundImage:
          "linear-gradient(45deg, var(--foreground) 25%, transparent 25%, transparent 75%, var(--foreground) 75%), linear-gradient(45deg, var(--foreground) 25%, transparent 25%, transparent 75%, var(--foreground) 75%)",
        backgroundSize: "12px 12px",
        backgroundPosition: "0 0, 6px 6px",
        backgroundColor: "var(--background)",
        opacity: 1,
      }}
    >
      <span aria-hidden className="absolute inset-0 bg-background/85" />
      {[0, 1].map((i) => (
        <span
          key={i}
          aria-hidden
          className="absolute rounded-full bg-foreground"
          style={{
            left: i === 0 ? 8 : 30,
            top: 8,
            width: 38,
            height: 60,
            opacity: value,
            filter: soft ? `blur(${Math.round((1 - hardness) * 6)}px)` : undefined,
          }}
        />
      ))}
    </div>
  );
}

/** The demo stroke's own space, in SCREEN pixels — the units the stabiliser
 *  runs in on the canvas, so the leash drawn here is the leash you will feel. */
const DEMO = { w: 240, h: 76 };

/** A hand-drawn line: one sweep plus the two things a real hand adds, a slow
 *  wobble and fast tremor. Deterministic, so the preview never shimmers. */
const DEMO_PATH: StabPoint[] = Array.from({ length: 120 }, (_, i) => {
  const t = i / 119;
  const wobble = Math.sin(t * Math.PI * 2.1) * 13;
  const tremor = Math.sin(t * 97) * 2.6 + Math.sin(t * 211) * 1.4;
  return { x: 12 + t * (DEMO.w - 24), y: DEMO.h / 2 + wobble + tremor };
});

const toPoly = (pts: StabPoint[]) => pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

function stabilized(smoothing: number): StabPoint[] {
  const radius = stabilizerRadius(smoothing, false);
  const first = DEMO_PATH[0]!;
  if (radius <= 0) return DEMO_PATH;
  const s = createStabilizer(first, radius);
  const out: StabPoint[] = [first];
  for (const p of DEMO_PATH) out.push(...stabilizerPush(s, p, radius));
  return out;
}

/** The stabiliser's leash, and what it does to a shaky line. */
export function SmoothingPreview({ value }: { value: number }) {
  const pts = React.useMemo(() => stabilized(value), [value]);
  const radius = stabilizerRadius(value, false);
  const end = pts[pts.length - 1] ?? DEMO_PATH[0]!;
  return (
    <svg viewBox={`0 0 ${DEMO.w} ${DEMO.h}`} className="h-[76px] w-full" aria-hidden>
      {/* What your hand did. */}
      <polyline points={toPoly(DEMO_PATH)} fill="none" stroke="var(--foreground)" strokeOpacity={0.18} strokeWidth={3} />
      {/* What lands. */}
      <polyline
        points={toPoly(pts)}
        fill="none"
        stroke="var(--primary)"
        strokeWidth={5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* The leash at true radius. Drawn because it is AIMABLE — an artist works
          with it once they can see how long it is. */}
      {radius > 0 && (
        <circle
          cx={end.x}
          cy={end.y}
          r={Math.min(radius, MAX_STABILIZER_PX)}
          fill="none"
          stroke="var(--primary)"
          strokeOpacity={0.35}
          strokeDasharray="4 4"
        />
      )}
    </svg>
  );
}
