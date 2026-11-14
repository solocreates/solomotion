/**
 * Headless alignment + distribution — pure geometry over boxes, the same shape
 * as the snapping engine. The caller groups the selection into "units" (a lone
 * layer, or a whole group that must move as one) and hands their world boxes
 * plus a container box; this returns the translation for each unit. It never
 * touches clips, so the UI decides what a unit is and how to apply the delta.
 */
import type { AABB } from "./viewport-snap";

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
export type DistributeMode = "dist-h" | "dist-v";

const mid = (lo: number, hi: number) => (lo + hi) / 2;

/**
 * Align every unit to `container` on one edge/axis. With one unit the container
 * is its frame (centers it in the page); with several it's their combined bounds
 * (flushes them to a shared edge / centerline). Returns a per-unit {dx,dy}.
 */
export function alignBoxes(units: AABB[], container: AABB, mode: AlignMode): Array<{ dx: number; dy: number }> {
  return units.map((u) => {
    switch (mode) {
      case "left":
        return { dx: container.minX - u.minX, dy: 0 };
      case "right":
        return { dx: container.maxX - u.maxX, dy: 0 };
      case "hcenter":
        return { dx: mid(container.minX, container.maxX) - mid(u.minX, u.maxX), dy: 0 };
      case "top":
        return { dx: 0, dy: container.minY - u.minY };
      case "bottom":
        return { dx: 0, dy: container.maxY - u.maxY };
      case "vcenter":
        return { dx: 0, dy: mid(container.minY, container.maxY) - mid(u.minY, u.maxY) };
    }
  });
}

/**
 * Distribute units so the GAPS between them are equal (Figma's default). The two
 * outermost units stay put; the rest slide to even out the spacing. Needs 3+
 * units to do anything. Returns a per-unit {dx,dy} in the ORIGINAL order.
 */
export function distributeBoxes(units: AABB[], axis: "h" | "v"): Array<{ dx: number; dy: number }> {
  const out = units.map(() => ({ dx: 0, dy: 0 }));
  if (units.length < 3) return out;
  const lo = (u: AABB) => (axis === "h" ? u.minX : u.minY);
  const hi = (u: AABB) => (axis === "h" ? u.maxX : u.maxY);
  const order = units.map((_, i) => i).sort((a, b) => lo(units[a]!) - lo(units[b]!));
  const first = units[order[0]!]!;
  const last = units[order[order.length - 1]!]!;
  const span = hi(last) - lo(first);
  let occupied = 0;
  for (const i of order) occupied += hi(units[i]!) - lo(units[i]!);
  const gap = (span - occupied) / (units.length - 1);
  let cursor = lo(first);
  for (const i of order) {
    const u = units[i]!;
    const size = hi(u) - lo(u);
    const target = cursor;
    const delta = target - lo(u);
    if (axis === "h") out[i] = { dx: delta, dy: 0 };
    else out[i] = { dx: 0, dy: delta };
    cursor += size + gap;
  }
  return out;
}
