import type { Contour, PathPoint } from "../schema/vector";
import type { TrackRegion, TrackShape } from "../schema/tracking";
import { posePoint, type RegionPose } from "./pose";
import type { Vec2 } from "../schema/common";
import { commandsToSubpaths, cornerPoint, shapeCommands, subpathBounds } from "../vector/geometry";
import { subpathToRing } from "../vector/polygon";
import { createId } from "../ids";

/**
 * REGION GEOMETRY — the one place a tracker's stored contour meets a solved pose.
 *
 * A tracker stores its silhouette ONCE, in region-local space (centred on the
 * origin, unrotated, at reference scale), and stores WHERE IT IS at each time as
 * a pose on the sample. Everything that needs the shape at a moment — the stage
 * overlay, the matte rasteriser, the warp solver, the exporter — comes through
 * `contourAtPose` and therefore cannot disagree about it.
 *
 * The alternative (bake the contour into every sample) was rejected for the
 * reason it always is: N copies of one fact. Editing the shape would have meant
 * rewriting every frame, and a per-frame hand correction to the SHAPE would be
 * indistinguishable from the shape itself.
 */

const TOL = 0.25;

/**
 * The region's contours in SOURCE PIXELS at one pose, warp included.
 *
 * The warp is applied in region-local space BEFORE the pose, which is the only
 * ordering that makes a hand-nudged vertex survive a later scale change: an
 * offset stored in source pixels would be the wrong size the moment the object
 * came closer.
 */
export function contourAtPose(region: TrackRegion, pose: RegionPose): Contour[] {
  const warp = pose.warp ?? null;
  let k = 0;
  return region.subpaths.map((sub) => ({
    closed: sub.closed,
    points: sub.points.map((pt) => {
      const off = warp?.[k++] ?? null;
      const local = off ? { x: pt.x + off.x, y: pt.y + off.y } : pt;
      const a = posePoint(local, pose);
      return {
        x: a.x,
        y: a.y,
        // Handles are stored as absolute control points, so they pose like
        // points. Under perspective a cubic is not mapped exactly by its
        // control points — close enough for a matte edge, and far cheaper
        // than flattening every contour to a polyline first.
        hIn: pt.hIn ? posePoint(pt.hIn, pose) : null,
        hOut: pt.hOut ? posePoint(pt.hOut, pose) : null,
      } satisfies PathPoint;
    }),
  }));
}

/** Every anchor of the region, in list order — the array a `warp` is parallel to. */
export function regionVertices(region: TrackRegion): Vec2[] {
  const out: Vec2[] = [];
  for (const sub of region.subpaths) for (const p of sub.points) out.push({ x: p.x, y: p.y });
  return out;
}

/** The region's local bounding box — the correlation template's extent. */
export function regionBounds(region: TrackRegion): { width: number; height: number } {
  const b = subpathBounds(region.subpaths);
  if (!b) return { width: 1, height: 1 };
  return { width: Math.max(1, b.maxX - b.minX), height: Math.max(1, b.maxY - b.minY) };
}

/**
 * Flatten a region to polylines in source px at a pose — what a rasteriser and
 * a point-in-shape test want, and what the warp solver walks.
 */
export function regionPolylines(region: TrackRegion, pose: RegionPose): Vec2[][] {
  return contourAtPose(region, pose).map((c) =>
    subpathToRing(c, TOL).map(([x, y]) => ({ x, y })),
  );
}

// ── Construction ─────────────────────────────────────────────────────────────

/**
 * Build a region from a parametric shape, centred on the origin.
 *
 * Rect, ellipse, polygon and star all come from `shapeCommands` — the SAME
 * builder every shape clip in the app uses, in the same centred local space. A
 * tracking region and a shape layer are therefore the same geometry produced by
 * the same code, which is what makes "convert this window to a shape" and "track
 * this shape" one-line operations instead of two converters that drift.
 */
export function regionFromShape(
  shape: TrackShape,
  width: number,
  height: number,
  points = 6,
): Contour[] {
  if (shape === "path") {
    // A free path with nothing drawn yet is a rectangle; the pen replaces it.
    return regionFromShape("rect", width, height);
  }
  const kind = shape === "polygon" ? "polygon" : shape === "ellipse" ? "ellipse" : "rect";
  return commandsToSubpaths(
    shapeCommands({
      shape: kind,
      width,
      height,
      cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
      radius: Math.min(width, height) / 2,
      pointCount: points,
      innerRatio: 0.5,
    }),
  );
}

/** Give bare contours the stable ids a stored `Subpath` needs. */
export function toSubpaths(contours: Contour[]): Array<Contour & { id: string }> {
  return contours.map((c) => ({ ...c, id: createId("sub") }));
}

// ── Resampling: the accuracy dial ────────────────────────────────────────────

/**
 * Resample a closed contour to `count` anchors spread evenly along its LENGTH,
 * preserving the shape it already has.
 *
 * This is what "raise the detail" means. A four-point rectangle the user liked
 * becomes a twenty-point outline that can deform, WITHOUT them redrawing it —
 * and dropping detail back down re-derives a coarser outline from the same
 * curve rather than from the coarser one before it, so the dial is lossless in
 * both directions as long as the underlying contour has not been hand-edited.
 *
 * Corners are kept: a vertex whose turn exceeds `cornerDeg` is forced into the
 * output, because a resampled rectangle that rounds its own corners is not the
 * shape anybody drew.
 */
export function resampleContour(contour: Contour, count: number, cornerDeg = 35): Contour {
  const ring = subpathToRing(contour, TOL);
  if (ring.length < 3 || count < 3) return contour;

  const pts = ring.map(([x, y]) => ({ x, y }));
  const n = pts.length;
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    seg.push(d);
    total += d;
  }
  if (total === 0) return contour;

  // Arc position of each flattened point, plus the corners we must keep.
  const at: number[] = [];
  let run = 0;
  for (let i = 0; i < n; i++) {
    at.push(run);
    run += seg[i]!;
  }
  const corners: number[] = [];
  const cosLimit = Math.cos((180 - cornerDeg) * (Math.PI / 180));
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n]!;
    const c = pts[i]!;
    const q = pts[(i + 1) % n]!;
    const ax = p.x - c.x;
    const ay = p.y - c.y;
    const bx = q.x - c.x;
    const by = q.y - c.y;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la === 0 || lb === 0) continue;
    if ((ax * bx + ay * by) / (la * lb) > cosLimit) corners.push(at[i]!);
  }

  const wanted = new Set<number>();
  for (const c of corners) wanted.add(c);
  const even = Math.max(3, count - wanted.size);
  for (let i = 0; i < even; i++) wanted.add((i / even) * total);

  const stops = [...wanted].sort((a, b) => a - b).slice(0, Math.max(3, count));
  const out: PathPoint[] = stops.map((s) => {
    const p = pointAtArc(pts, at, seg, total, s);
    return cornerPoint(p.x, p.y);
  });
  return { closed: true, points: out };
}

function pointAtArc(pts: Vec2[], at: number[], seg: number[], total: number, s: number): Vec2 {
  const t = ((s % total) + total) % total;
  // Linear scan is fine: contours are flattened to a few hundred points and
  // this runs once per detail change, not per frame.
  for (let i = 0; i < pts.length; i++) {
    const end = at[i]! + seg[i]!;
    if (t <= end || i === pts.length - 1) {
      const u = seg[i]! === 0 ? 0 : (t - at[i]!) / seg[i]!;
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
  }
  return pts[0]!;
}
