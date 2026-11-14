import polygonClipping, { type MultiPolygon, type Pair, type Polygon, type Ring } from "polygon-clipping";
import type { Contour } from "../schema/vector";
import { cornerPoint } from "./geometry";

/**
 * Polygon view of vector geometry — THE one place curves become rings, rings
 * become `polygon-clipping` polygons, and polygons become subpaths again.
 *
 * Every boolean in the app funnels through here: flatten-to-path (⌘E), the
 * lasso's cut of filled art, the eraser carving a fill. They were one file's
 * private helpers until a second caller needed them; two copies of a ring
 * nester is exactly the defect this codebase keeps deleting.
 *
 * Curves survive until a boolean forces the flattening — callers hold their
 * exact béziers and only reach for this when areas genuinely have to merge.
 */

const FLAT_MAX_DEPTH = 18;

/** Flatness of a cubic: max control-point deviation from the chord. */
function cubicFlat(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  tol: number,
): boolean {
  const ux = 3 * p1.x - 2 * p0.x - p3.x;
  const uy = 3 * p1.y - 2 * p0.y - p3.y;
  const vx = 3 * p2.x - p0.x - 2 * p3.x;
  const vy = 3 * p2.y - p0.y - 2 * p3.y;
  return Math.max(ux * ux, vx * vx) + Math.max(uy * uy, vy * vy) <= 16 * tol * tol;
}

export function flattenCubic(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  tol: number,
  out: Ring,
  depth: number,
): void {
  if (depth >= FLAT_MAX_DEPTH || cubicFlat(p0, p1, p2, p3, tol)) {
    out.push([p3.x, p3.y]);
    return;
  }
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const p23 = mid(p2, p3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const m = mid(p012, p123);
  flattenCubic(p0, p01, p012, m, tol, out, depth + 1);
  flattenCubic(m, p123, p23, p3, tol, out, depth + 1);
}

const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

export function subpathToRing(sub: Contour, tol: number): Ring {
  const pts = sub.points;
  if (pts.length === 0) return [];
  const ring: Ring = [[pts[0]!.x, pts[0]!.y]];
  const segCount = sub.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    if (!a.hOut && !b.hIn) {
      ring.push([b.x, b.y]);
    } else {
      flattenCubic(a, a.hOut ?? a, b.hIn ?? b, b, tol, ring, 0);
    }
  }
  return ring;
}


export function ringSignedArea(r: Ring): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i]!;
    const [x2, y2] = r[(i + 1) % r.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function pointInRing(pt: Pair, ring: Ring): boolean {
  const [px, py] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Group flat rings into polygon-clipping polygons: containment depth decides
 * outer vs hole (even depth = outer, odd = hole owned by its tightest even
 * ancestor). This resolves donuts, counters in letters, and islands-in-holes
 * to the [outer, ...holes] shape polygon-clipping expects.
 */
export function ringsToMultiPoly(rings: Ring[]): MultiPolygon {
  const valid = rings.filter((r) => r.length >= 3 && Math.abs(ringSignedArea(r)) > 1e-6);
  const n = valid.length;
  if (n === 0) return [];
  const areaAbs = valid.map((r) => Math.abs(ringSignedArea(r)));
  const containers: number[][] = valid.map(() => []);
  for (let i = 0; i < n; i++) {
    const rep = valid[i]![0]!;
    for (let j = 0; j < n; j++) {
      if (i !== j && pointInRing(rep, valid[j]!)) containers[i]!.push(j);
    }
  }
  const depth = containers.map((c) => c.length);
  const polygons: Polygon[] = [];
  const outerPolyIndex = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (depth[i]! % 2 === 0) {
      outerPolyIndex.set(i, polygons.length);
      polygons.push([valid[i]!]);
    }
  }
  for (let i = 0; i < n; i++) {
    if (depth[i]! % 2 === 1) {
      let owner = -1;
      let ownerArea = Infinity;
      for (const j of containers[i]!) {
        if (depth[j]! % 2 === 0 && areaAbs[j]! < ownerArea) {
          owner = j;
          ownerArea = areaAbs[j]!;
        }
      }
      if (owner >= 0) polygons[outerPolyIndex.get(owner)!]!.push(valid[i]!);
      else polygons.push([valid[i]!]);
    }
  }
  return polygons;
}

export function multiPolyToSubpaths(mp: MultiPolygon): Contour[] {
  const out: Contour[] = [];
  for (const poly of mp) {
    for (const ring of poly) {
      let pts = ring;
      // polygon-clipping repeats the first vertex to close the ring — drop it.
      if (
        pts.length > 1 &&
        pts[0]![0] === pts[pts.length - 1]![0] &&
        pts[0]![1] === pts[pts.length - 1]![1]
      ) {
        pts = pts.slice(0, -1);
      }
      if (pts.length < 3) continue;
      out.push({ closed: true, points: pts.map(([x, y]) => cornerPoint(x, y)) });
    }
  }
  return out;
}

// ── The public door: subpaths ⇄ polygons ─────────────────────────────────────

/** Flatten a whole outline (with its holes) into `polygon-clipping` polygons. */
export function subpathsToMultiPoly(subpaths: Contour[], tolerance = 0.3): MultiPolygon {
  return ringsToMultiPoly(subpaths.map((s) => subpathToRing(s, tolerance)));
}

/**
 * Hand-drawn loops (a lasso, a traced wand region, the eraser's footprint) as
 * one polygon set. A freehand outline crosses itself all the time, and a
 * self-intersecting ring is not a region until someone decides what its
 * interior is — `union` is that decision, and it also resolves nested loops
 * into outers with real holes.
 */
export function ringsToRegion(rings: Array<Array<{ x: number; y: number }>>): MultiPolygon {
  const raw = rings.filter((r) => r.length >= 3).map((r): Polygon => [r.map((p): Pair => [p.x, p.y])]);
  if (raw.length === 0) return [];
  return robustBoolean("union", raw.map((p) => [p])) ?? [];
}

export type BooleanOp = "union" | "intersection" | "difference" | "xor";

/**
 * Snapping grids, finest first. `polygon-clipping`'s sweepline throws outright
 * ("Unable to find segment … in SweepLine tree") when input vertices coincide
 * exactly or land on each other's edges — two identical eraser circles, a
 * rectangle dragged along an edge that is already there. The documented cure is
 * to take the coordinates off that exact configuration, so each retry rounds
 * harder. 1e-3 comp px is invisible; 5e-2 is still under a screen pixel at any
 * sane zoom.
 */
const BOOLEAN_GRIDS = [1e-3, 1e-2, 5e-2];

function snapMultiPoly(mp: MultiPolygon, grid: number): MultiPolygon {
  return mp.map((poly) =>
    poly.map((ring) => ring.map(([x, y]): Pair => [Math.round(x / grid) * grid, Math.round(y / grid) * grid])),
  );
}

/**
 * A boolean that cannot take a drawing gesture down with it. Returns null when
 * even the coarsest snap fails, which every caller reads as "the tool missed" —
 * a stroke that does nothing beats a stage that throws mid-drag.
 */
export function robustBoolean(op: BooleanOp, operands: MultiPolygon[]): MultiPolygon | null {
  const live = operands.filter((mp) => mp.length > 0);
  if (live.length === 0) return [];
  for (const grid of BOOLEAN_GRIDS) {
    const [first, ...rest] = live.map((mp) => snapMultiPoly(mp, grid));
    try {
      if (op === "intersection") return polygonClipping.intersection(first!, ...rest);
      if (op === "difference") return polygonClipping.difference(first!, ...rest);
      if (op === "xor") return polygonClipping.xor(first!, ...rest);
      return polygonClipping.union(first!, ...rest);
    } catch {
      // Degenerate at this precision — try again, coarser.
    }
  }
  return null;
}

/** Point-in-region test (outer ring minus its holes) — the region's hit-test. */
export function multiPolyContains(mp: MultiPolygon, x: number, y: number): boolean {
  const pt: Pair = [x, y];
  for (const poly of mp) {
    if (!poly[0] || !pointInRing(pt, poly[0])) continue;
    let inHole = false;
    for (let i = 1; i < poly.length; i++) {
      if (pointInRing(pt, poly[i]!)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

/** Area of a whole polygon set (outer rings minus their holes). */
export function multiPolyArea(mp: MultiPolygon): number {
  let area = 0;
  for (const poly of mp) {
    for (let i = 0; i < poly.length; i++) {
      const a = Math.abs(ringSignedArea(poly[i]!));
      area += i === 0 ? a : -a;
    }
  }
  return Math.max(0, area);
}
