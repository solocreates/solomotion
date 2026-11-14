/**
 * Headless 2D snapping — the canvas counterpart to the timeline's `snapTime`.
 *
 * ONE brain for every canvas gesture that moves geometry (drag, resize, draw):
 * given the moving box and a set of candidate guide lines, it returns the delta
 * that clicks the box onto the nearest alignment plus the guide lines to flash.
 * It is pure geometry in a single world space — the caller (Stage) feeds it
 * axis-aligned boxes it already computes (hit rects, the page frame) and renders
 * whatever lines come back. No DOM, no React, no knowledge of clips: a native
 * adapter (Figma/Blender-style) can reuse it verbatim.
 *
 * Model (Figma): the moving box exposes three probes per axis — its two edges
 * and its center. Every target contributes the same three lines. A snap happens
 * when any moving probe lands within `threshold` of any candidate line; the
 * smallest such correction wins per axis, and X/Y resolve independently so a
 * corner can snap to a vertical and a horizontal guide at once.
 */

/** Axis-aligned box in world units (the shared canvas space). */
export interface AABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Which part of a target a guide line came from — drives the guide's color/feel.
 *  `node` = an individual vector anchor point (pen/shape node-to-node snapping). */
export type SnapLineKind = "edge" | "center" | "page" | "guide" | "node";

/**
 * A candidate alignment line. `pos` is the coordinate on the snap axis (x for a
 * vertical line, y for a horizontal one); `lo`/`hi` is the source's extent on
 * the OTHER axis, so the rendered guide can span from the target to the moving
 * box instead of running edge-to-edge across the whole canvas.
 */
export interface SnapLine {
  pos: number;
  lo: number;
  hi: number;
  kind: SnapLineKind;
}

/** Vertical (constant-x) and horizontal (constant-y) candidate lines. */
export interface SnapCandidates {
  v: SnapLine[];
  h: SnapLine[];
}

/** What the canvas magnet snaps to (persisted; mirrors the timeline SnapSettings). */
export interface ViewportSnapSettings {
  /** Snap radius in SCREEN px — the caller converts to world units by /zoom. */
  thresholdPx: number;
  /** Snap to other layers' edges and centers. */
  toLayers: boolean;
  /** Snap to the page (frame) edges. */
  toPageEdges: boolean;
  /** Snap to the page center (both axes). */
  toPageCenter: boolean;
  /** Snap to ruler guides (the "rulers" switch). On by default so a guide you
   *  pull out immediately attracts layers, unless you turn it off. */
  toGuides: boolean;
}

export const DEFAULT_VIEWPORT_SNAP: ViewportSnapSettings = {
  thresholdPx: 8,
  toLayers: true,
  toPageEdges: true,
  toPageCenter: true,
  toGuides: true,
};

/** A ruler guide as a world-space line, fed into snapping when `toGuides` is on.
 *  `axis: "x"` = a vertical line at world x `pos`; `"y"` = horizontal at y. The
 *  `lo`/`hi` extent is the frame's span on the other axis (for drawing). */
export interface GuideLine {
  axis: "x" | "y";
  pos: number;
  lo: number;
  hi: number;
}

/** The three snap probes of a box on one axis: near edge, center, far edge. */
function probes(lo: number, hi: number): [number, number, number] {
  return [lo, (lo + hi) / 2, hi];
}

/**
 * Build the candidate guide lines from the surrounding geometry: every other
 * layer's edges + center, and the page's edges + center — filtered by settings.
 * `targets` and `page` are world AABBs; the moving selection is NOT included.
 */
export function buildSnapCandidates(
  targets: AABB[],
  page: AABB | null,
  settings: ViewportSnapSettings,
  guides: GuideLine[] = [],
): SnapCandidates {
  const v: SnapLine[] = [];
  const h: SnapLine[] = [];

  // Ruler guides act like fixed alignment lines when the "rulers" switch is on.
  if (settings.toGuides) {
    for (const g of guides) {
      if (g.axis === "x") v.push({ pos: g.pos, lo: g.lo, hi: g.hi, kind: "guide" });
      else h.push({ pos: g.pos, lo: g.lo, hi: g.hi, kind: "guide" });
    }
  }

  if (settings.toLayers) {
    for (const t of targets) {
      const cx = (t.minX + t.maxX) / 2;
      const cy = (t.minY + t.maxY) / 2;
      // Vertical lines (x positions), each spanning the target's y-extent.
      v.push({ pos: t.minX, lo: t.minY, hi: t.maxY, kind: "edge" });
      v.push({ pos: cx, lo: t.minY, hi: t.maxY, kind: "center" });
      v.push({ pos: t.maxX, lo: t.minY, hi: t.maxY, kind: "edge" });
      // Horizontal lines (y positions), each spanning the target's x-extent.
      h.push({ pos: t.minY, lo: t.minX, hi: t.maxX, kind: "edge" });
      h.push({ pos: cy, lo: t.minX, hi: t.maxX, kind: "center" });
      h.push({ pos: t.maxY, lo: t.minX, hi: t.maxX, kind: "edge" });
    }
  }

  if (page) {
    const pcx = (page.minX + page.maxX) / 2;
    const pcy = (page.minY + page.maxY) / 2;
    if (settings.toPageEdges) {
      v.push({ pos: page.minX, lo: page.minY, hi: page.maxY, kind: "page" });
      v.push({ pos: page.maxX, lo: page.minY, hi: page.maxY, kind: "page" });
      h.push({ pos: page.minY, lo: page.minX, hi: page.maxX, kind: "page" });
      h.push({ pos: page.maxY, lo: page.minX, hi: page.maxX, kind: "page" });
    }
    if (settings.toPageCenter) {
      v.push({ pos: pcx, lo: page.minY, hi: page.maxY, kind: "page" });
      h.push({ pos: pcy, lo: page.minX, hi: page.maxX, kind: "page" });
    }
  }

  return { v, h };
}

/** The winning snap on one axis: the correction to apply + the lines it hit. */
interface AxisSnap {
  delta: number;
  lines: SnapLine[];
}

/**
 * Resolve one axis: try every (probe, candidate) pair, keep the smallest
 * correction within `threshold`. Returns delta 0 and no lines when nothing is in
 * range. All candidate lines that coincide with the snapped position are
 * returned so overlapping guides (e.g. two layers sharing an edge) all draw.
 */
function snapAxis(pr: [number, number, number], lines: SnapLine[], threshold: number): AxisSnap {
  let best: number | null = null; // winning correction
  let bestAbs = threshold + 1;
  for (const p of pr) {
    for (const line of lines) {
      const d = line.pos - p;
      const ad = Math.abs(d);
      if (ad <= threshold && ad < bestAbs) {
        bestAbs = ad;
        best = d;
      }
    }
  }
  if (best === null) return { delta: 0, lines: [] };
  // Collect every line the box now sits exactly on (any probe), so shared
  // alignments all light up.
  const snappedProbes = pr.map((p) => p + best!);
  const hit = lines.filter((line) => snappedProbes.some((p) => Math.abs(line.pos - p) < 0.01));
  return { delta: best, lines: hit };
}

/** The result of a snap: the delta to add to the box, plus guides to render. */
export interface SnapResult {
  dx: number;
  dy: number;
  /** Vertical guide lines to flash (constant-x), already at their snapped pos. */
  v: SnapLine[];
  /** Horizontal guide lines to flash (constant-y). */
  h: SnapLine[];
}

/**
 * Snap a MOVING box (translation gesture) to the candidates. `threshold` is in
 * world units (the caller divides its px threshold by the zoom). X and Y snap
 * independently. The returned guide `lo`/`hi` are widened to also cover the
 * moving box so the flashed line visibly connects box → target.
 */
export function snapMove(box: AABB, cand: SnapCandidates, threshold: number): SnapResult {
  const x = snapAxis(probes(box.minX, box.maxX), cand.v, threshold);
  const y = snapAxis(probes(box.minY, box.maxY), cand.h, threshold);
  const b: AABB = { minX: box.minX + x.delta, minY: box.minY + y.delta, maxX: box.maxX + x.delta, maxY: box.maxY + y.delta };
  return {
    dx: x.delta,
    dy: y.delta,
    v: x.lines.map((l) => ({ ...l, lo: Math.min(l.lo, b.minY), hi: Math.max(l.hi, b.maxY) })),
    h: y.lines.map((l) => ({ ...l, lo: Math.min(l.lo, b.minX), hi: Math.max(l.hi, b.maxX) })),
  };
}

/**
 * Snap a point that is CONSTRAINED to a ray (a Shift angle-lock) onto the
 * alignment candidates WITHOUT breaking the lock. This is the composition of the
 * two gestures the naïve code treated as mutually exclusive: the point may only
 * slide along `origin + t·dir`, so for each candidate line we solve the `t` where
 * the ray crosses it and keep the crossing nearest to `p` within `threshold`.
 * A Shift-locked pen segment therefore still clicks onto a sibling's edge/center
 * — the smart guide shows and the angle stays exactly locked. `dir` is assumed
 * unit-length; a point on the ray can meet at most one line, so a single axis of
 * guides is returned. No crossing in range → the point (and no guides) come back.
 */
export function snapPointOnRay(
  origin: { x: number; y: number },
  dir: { x: number; y: number },
  p: { x: number; y: number },
  cand: SnapCandidates,
  threshold: number,
): { x: number; y: number; v: SnapLine[]; h: SnapLine[] } {
  let best: { x: number; y: number; line: SnapLine; axis: "v" | "h" } | null = null;
  let bestDist = threshold;
  // A candidate on `comp` (the ray component that must reach line.pos) is hit at
  // t = (line.pos − origin[comp]) / dir[comp]; skip lines the ray runs parallel to.
  const consider = (lines: SnapLine[], axis: "v" | "h", dc: number, oc: number, pick: (t: number) => { x: number; y: number }) => {
    if (Math.abs(dc) < 1e-6) return;
    for (const line of lines) {
      const t = (line.pos - oc) / dc;
      const at = pick(t);
      const dist = Math.hypot(at.x - p.x, at.y - p.y);
      if (dist <= bestDist) {
        bestDist = dist;
        best = { x: at.x, y: at.y, line, axis };
      }
    }
  };
  consider(cand.v, "v", dir.x, origin.x, (t) => ({ x: origin.x + t * dir.x, y: origin.y + t * dir.y }));
  consider(cand.h, "h", dir.y, origin.y, (t) => ({ x: origin.x + t * dir.x, y: origin.y + t * dir.y }));
  if (!best) return { x: p.x, y: p.y, v: [], h: [] };
  const b = best as { x: number; y: number; line: SnapLine; axis: "v" | "h" };
  const line: SnapLine = b.axis === "v"
    ? { ...b.line, lo: Math.min(b.line.lo, b.y), hi: Math.max(b.line.hi, b.y) }
    : { ...b.line, lo: Math.min(b.line.lo, b.x), hi: Math.max(b.line.hi, b.x) };
  return { x: b.x, y: b.y, v: b.axis === "v" ? [line] : [], h: b.axis === "h" ? [line] : [] };
}

/**
 * Snap a single moving POINT (a dragged corner / draw endpoint) on both axes,
 * independently. Used by resize and shape-draw, where only the grabbed corner
 * moves and the opposite one is pinned. Returns the corrected point + guides.
 */
export function snapPoint(
  px: number,
  py: number,
  cand: SnapCandidates,
  threshold: number,
): { x: number; y: number; v: SnapLine[]; h: SnapLine[] } {
  const x = snapAxis([px, px, px], cand.v, threshold);
  const y = snapAxis([py, py, py], cand.h, threshold);
  const nx = px + x.delta;
  const ny = py + y.delta;
  return {
    x: nx,
    y: ny,
    v: x.lines.map((l) => ({ ...l, lo: Math.min(l.lo, ny), hi: Math.max(l.hi, ny) })),
    h: y.lines.map((l) => ({ ...l, lo: Math.min(l.lo, nx), hi: Math.max(l.hi, nx) })),
  };
}
