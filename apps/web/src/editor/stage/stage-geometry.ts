import { shearPoint, type AABB } from "@solomotion/core";
import type { ClipHitRect } from "./render/draw-frame";

/**
 * The Stage's latest painted hit rects, published for surfaces OUTSIDE the
 * canvas (the align toolbar, menus) that need each layer's rendered world box
 * but don't run the render loop. Stage overwrites `current` every frame; readers
 * treat it as read-only and only touch it in response to a user action, so
 * there's no churn. Keeping it a plain mutable ref (not zustand) avoids a
 * re-render storm from a value that changes 60×/second.
 */
export const stageHitRects: { current: ClipHitRect[] } = { current: [] };

/** World axis-aligned bounds of a hit rect (its rotated corners' extent). */
/** The four world corners of a hit rect, in drawing order (T·R·K·S). */
export function hitCorners(h: ClipHitRect): Array<{ x: number; y: number }> {
  const rad = (h.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = h.width / 2;
  const hh = h.height / 2;
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => {
    const s = shearPoint(sx * hw, sy * hh, h.skewX, h.skewY);
    return { x: h.cx + s.x * cos - s.y * sin, y: h.cy + s.x * sin + s.y * cos };
  });
}

export function hitAABB(h: ClipHitRect): AABB {
  const rad = (h.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = h.width / 2;
  const hh = h.height / 2;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    // Corner rides scale(baked into hw/hh) → shear → rotate (T·R·K·S).
    const s = shearPoint(sx * hw, sy * hh, h.skewX, h.skewY);
    xs.push(h.cx + s.x * cos - s.y * sin);
    ys.push(h.cy + s.x * sin + s.y * cos);
  }
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** Union of several hit rects' world AABBs (a group/selection box). */
export function unionAABB(boxes: AABB[]): AABB | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  return { minX, minY, maxX, maxY };
}
