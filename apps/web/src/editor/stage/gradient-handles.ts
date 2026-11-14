import { isGradientPaint, type GradientType, type Paint } from "@solomotion/core";
import type { ClipHitRect } from "./render/draw-frame";

/**
 * On-stage gradient handles — ONE rig for every gradient type (linear, radial,
 * angular), for every clip kind (shape, path, text).
 *
 * The trick that unifies it: a gradient's geometry is two normalized points
 * (`start`/`end`, 0..1 across the paint box), and EVERY selectable clip already
 * exposes a `ClipHitRect` (its rotated selection box in world space) that IS the
 * paint box the renderer fills. So mapping normalized → world through the hit
 * rect places the handles exactly over the painted gradient — no per-kind pose
 * math, no second source of truth. Manipulating a handle just writes the same
 * `start`/`end` keyframe paths the inspector uses.
 */

export type Vec = { x: number; y: number };

/** A normalized paint-box point (0..1) → world, using the hit rect as the box. */
export function paintNormToWorld(nx: number, ny: number, hit: ClipHitRect): Vec {
  const lx = (nx - 0.5) * hit.width;
  const ly = (ny - 0.5) * hit.height;
  const rad = (hit.rotation * Math.PI) / 180;
  return {
    x: hit.cx + lx * Math.cos(rad) - ly * Math.sin(rad),
    y: hit.cy + lx * Math.sin(rad) + ly * Math.cos(rad),
  };
}

/** Inverse: a world point back into the paint box's normalized (0..1) space. */
export function worldToPaintNorm(w: Vec, hit: ClipHitRect): Vec {
  const dx = w.x - hit.cx;
  const dy = w.y - hit.cy;
  const rad = (-hit.rotation * Math.PI) / 180;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  return { x: lx / Math.max(1e-3, hit.width) + 0.5, y: ly / Math.max(1e-3, hit.height) + 0.5 };
}

export interface GradientHandleStop {
  id: string;
  color: string;
  at: Vec; // world position along the axis
}

export interface GradientHandleModel {
  type: GradientType;
  start: Vec; // world
  end: Vec; // world
  stops: GradientHandleStop[];
}

/** Build the world-space handle model for a gradient paint (null for non-gradients). */
export function gradientHandleModel(paint: Paint, hit: ClipHitRect): GradientHandleModel | null {
  if (!isGradientPaint(paint)) return null;
  const start = paintNormToWorld(paint.start.x, paint.start.y, hit);
  const end = paintNormToWorld(paint.end.x, paint.end.y, hit);
  const stops = [...paint.stops]
    .sort((a, b) => a.offset - b.offset)
    .map((s) => ({
      id: s.id,
      color: s.color,
      at: { x: start.x + (end.x - start.x) * s.offset, y: start.y + (end.y - start.y) * s.offset },
    }));
  return { type: paint.type, start, end, stops };
}

export type GradientHandleHit =
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "stop"; id: string };

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

/** Where along the axis (0..1, unclamped) does the projection of `p` land. */
export function axisT(p: Vec, start: Vec, end: Vec): number {
  const vx = end.x - start.x;
  const vy = end.y - start.y;
  const len2 = vx * vx + vy * vy;
  return len2 > 0 ? ((p.x - start.x) * vx + (p.y - start.y) * vy) / len2 : 0;
}

/**
 * Which handle is under the pointer (world space). `grab` is the grab radius in
 * WORLD units (screen px ÷ view scale) so the target stays a constant size on
 * screen. Only existing handles are hit — endpoints, then interior stops; the
 * bare axis is inert (stops are added from the inspector ramp, not by clicking
 * the line, which used to add colors unexpectedly).
 */
export function hitTestGradient(
  model: GradientHandleModel,
  pointer: Vec,
  grab: number,
): GradientHandleHit | null {
  if (dist(pointer, model.end) <= grab) return { kind: "end" };
  if (dist(pointer, model.start) <= grab) return { kind: "start" };
  for (const s of model.stops) {
    // Endpoints already claimed offset 0/1; skip stops sitting on them.
    if (dist(s.at, model.start) <= grab || dist(s.at, model.end) <= grab) continue;
    if (dist(pointer, s.at) <= grab) return { kind: "stop", id: s.id };
  }
  return null;
}
