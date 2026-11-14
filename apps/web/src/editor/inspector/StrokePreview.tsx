"use client";

import * as React from "react";
import {
  buildStrokePlan,
  commandsToSvgPath,
  solidPaint,
  strokeStyle,
  type PathCommand,
  type StrokeSet,
} from "@solomotion/core";
import { cn } from "@/lib/utils";

/**
 * THE stroke preview — one component that draws a stack of lines, and the only
 * place in the app that answers "what does this look like".
 *
 * It renders through `buildStrokePlan`, the same brain the canvas and the
 * exporter use, so a preset tile, a brush card and the stage cannot disagree.
 * A preview that draws its own approximation of an arrowhead is a preview that
 * will drift, and the drift always shows up as "the picker lied".
 *
 * It takes a STACK because a solo set is a stack of one. That is what lets a
 * per-stroke set tile, a whole-section stack tile and a vector brush card be
 * the same card — the thing that made brushes and strokes one feature.
 *
 * Lines are scaled to fit the tile, preserving their RELATIVE widths, so a
 * two-line brush still reads as a core inside a halo at 56px wide.
 */
export function StrokePreview({
  stack,
  shape = "line",
  className,
  color = "currentColor",
}: {
  stack: readonly StrokeSet[];
  /** `line` for a tile, `wave` when the look needs a curve to read (taper, dash). */
  shape?: "line" | "wave";
  className?: string;
  color?: string;
}) {
  const drawn = React.useMemo(() => drawStack(stack, shape), [stack, shape]);

  return (
    <svg
      viewBox="0 0 64 20"
      preserveAspectRatio="xMidYMid meet"
      // A look is allowed to exceed its nominal line box — a squiggle's crest, an
      // arrowhead's barbs — and clipping those is what makes a preview lie about
      // the very thing it is previewing.
      className={cn("shrink-0 overflow-visible", className)}
      style={{ color }}
      aria-hidden
    >
      {drawn.map((d) => (
        <React.Fragment key={d.id}>
          {d.line && (
            <path
              d={d.line}
              fill="none"
              stroke="currentColor"
              strokeWidth={d.width}
              strokeDasharray={d.dash}
              strokeDashoffset={d.offset}
              strokeLinecap={d.cap}
              strokeLinejoin={d.join}
            />
          )}
          {d.ribbon && <path d={d.ribbon} fill="currentColor" />}
          {d.markers && <path d={d.markers} fill="currentColor" />}
        </React.Fragment>
      ))}
    </svg>
  );
}

/**
 * Rendered tiles, keyed by the VALUES that produce them.
 *
 * A picker now shows dozens of looks, several menus deep, and a look is a pure
 * function of its set — so the same tile was being re-planned on every render
 * of every menu that mentioned it. Keying by value rather than by identity is
 * what makes that safe: two menus holding different array instances of the same
 * preset hit the same entry, and a set the user is actively editing misses the
 * cache the instant a number changes, which is exactly when it should.
 *
 * Bounded because a live edit mints a new key per drag frame; oldest-out keeps
 * a slider from growing this without limit.
 */
const CACHE = new Map<string, DrawnLine[]>();
const CACHE_MAX = 600;

interface DrawnLine {
  id: string;
  line: string | null;
  ribbon: string | null;
  markers: string | null;
  width: number;
  dash: string | undefined;
  offset: number;
  cap: StrokeSet["cap"];
  join: StrokeSet["join"];
}

function drawStack(stack: readonly StrokeSet[], shape: "line" | "wave"): DrawnLine[] {
  // The id is identity, not look — two stacks that differ only by id draw the
  // same tile, so it is excluded from the key.
  const key = `${shape}|${JSON.stringify(stack.map(({ id: _id, ...look }) => look))}`;
  const hit = CACHE.get(key);
  if (hit) return hit;

  const widest = Math.max(1, ...stack.map((s) => s.width));
  // Fit the widest line into the tile; the rest keep their ratio to it.
  const k = Math.min(1, 7 / widest);
  const geom = shape === "wave" ? WAVE : LINE;
  const out = stack.map((set) => {
    const width = Math.max(0.5, set.width * k);
    const plan = buildStrokePlan(geom, {
      ...strokeStyle(solidPaint("#000")),
      ...set,
      width,
      align: "center",
    });
    return {
      id: set.id,
      line: plan.path ? commandsToSvgPath(plan.path) : null,
      ribbon: plan.ribbon ? commandsToSvgPath(plan.ribbon) : null,
      markers: plan.markers.length ? commandsToSvgPath(plan.markers) : null,
      width,
      dash: plan.dash.length ? plan.dash.join(" ") : undefined,
      offset: -plan.dashOffset,
      cap: set.cap,
      join: set.join,
    };
  });

  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value as string);
  CACHE.set(key, out);
  return out;
}

/** Straight run, inset so an arrowhead has room to sit inside the box. */
const LINE: PathCommand[] = [
  { type: "M", x: 6, y: 10 },
  { type: "L", x: 58, y: 10 },
];

/** A gentle S — the shape that shows a taper, a join and a dash at once. */
const WAVE: PathCommand[] = [
  { type: "M", x: 6, y: 14 },
  { type: "C", x1: 20, y1: 14, x2: 18, y2: 5, x: 32, y: 5 },
  { type: "C", x1: 46, y1: 5, x2: 44, y2: 15, x: 58, y: 15 },
];
