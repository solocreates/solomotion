import type { Contour, PathPoint, Subpath } from "../schema/vector";
import {
  DEFAULT_PATH_FIDELITY,
  decimatePolyline,
  fitPolyline,
  type PathFidelity,
} from "../drawing/fidelity";
import type { SnapCandidates, SnapLine } from "../snapping/viewport-snap";
import { autoSmoothHandles, copyHandle, copyPathPoint, insertPointOnSegment } from "./geometry";
import { createId } from "../ids";

type Vec2 = { x: number; y: number };

/**
 * Vector edit engine — the shared, headless brain behind every vector-node
 * gesture (pen drafting, path node editing, shape-corner editing). Pure geometry
 * in one world space: no DOM, no React, no rendering. The web overlay and the
 * stage both feed it world-space points and render whatever it returns, so a
 * pen node and a shape corner snap, close, and continue through ONE code path
 * instead of two divergent ones.
 */

/**
 * Turn a set of WORLD-space anchor points into degenerate snap candidate lines
 * — one vertical (at the point's x) and one horizontal (at its y) per point.
 * Because `snapPoint` resolves the two axes independently, a moving node snaps
 * to another node's x, its y, or both at once (landing exactly on it). The
 * `lo`/`hi` extent starts collapsed on the point and is widened by `snapPoint`
 * to reach the moving node, so the flashed guide visibly connects node → node.
 *
 * This is what makes "new" and "old" nodes indistinguishable to the magnet:
 * feed it fresh draft points, committed anchors, or shape corners alike.
 */
export function nodeSnapLines(points: ReadonlyArray<{ x: number; y: number }>): SnapCandidates {
  const v: SnapLine[] = [];
  const h: SnapLine[] = [];
  for (const p of points) {
    v.push({ pos: p.x, lo: p.y, hi: p.y, kind: "node" });
    h.push({ pos: p.y, lo: p.x, hi: p.x, kind: "node" });
  }
  return { v, h };
}

/** Union two candidate sets (e.g. siblings/page/guides + vector nodes). */
export function mergeSnapCandidates(
  a: SnapCandidates | null,
  b: SnapCandidates | null,
): SnapCandidates {
  return {
    v: [...(a?.v ?? []), ...(b?.v ?? [])],
    h: [...(a?.h ?? []), ...(b?.h ?? [])],
  };
}

/** A grabbable end of an OPEN subpath — the anchor the pen can extend or close from. */
export interface OpenEndpoint {
  /** Index of the subpath in the clip. */
  sub: number;
  /** Index of the endpoint anchor within the subpath. */
  index: number;
  /** Which end of the run this is. `head` prepends, `tail` appends. */
  end: "head" | "tail";
  point: PathPoint;
}

/**
 * Every open subpath's endpoints (head + tail), the anchors the pen tool can
 * click to continue drawing or hover to close. Closed subpaths and empty runs
 * contribute nothing; a single-point run yields just its head.
 */
export function openEndpoints(subpaths: ReadonlyArray<Contour>): OpenEndpoint[] {
  const out: OpenEndpoint[] = [];
  subpaths.forEach((sub, s) => {
    if (sub.closed || sub.points.length === 0) return;
    out.push({ sub: s, index: 0, end: "head", point: sub.points[0]! });
    const last = sub.points.length - 1;
    if (last !== 0) out.push({ sub: s, index: last, end: "tail", point: sub.points[last]! });
  });
  return out;
}

// ── Node operations (the contextual pen toolbar's verbs) ─────────────────────
//
// Pure structural edits on Subpath[] driven by a node selection. Every one is a
// verb the pen toolbar, the right-click menu, and the keyboard all call — one
// implementation, three doors. Selections are structured NodeRefs (never the
// UI's "sub:index" strings) so the engine stays renderer-agnostic.

/** A node addressed by its subpath + point index. */
export interface NodeRef {
  sub: number;
  index: number;
}

// Identity, depth and per-vertex radius travel WITH the point (`copyPathPoint`).
// A copy that drops them is a point that quietly stops being the node it was.
const clone = copyHandle;
const copyPoint = copyPathPoint;

/** Group selected nodes by subpath, indices ascending. */
function bySubpath(nodes: ReadonlyArray<NodeRef>): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const n of nodes) {
    const arr = m.get(n.sub) ?? [];
    arr.push(n.index);
    m.set(n.sub, arr);
  }
  for (const arr of m.values()) arr.sort((a, b) => a - b);
  return m;
}

/** All selected anchor positions (for centroid/align math). */
function selectedPoints(subs: ReadonlyArray<Contour>, nodes: ReadonlyArray<NodeRef>): PathPoint[] {
  const out: PathPoint[] = [];
  for (const n of nodes) {
    const pt = subs[n.sub]?.points[n.index];
    if (pt) out.push(pt);
  }
  return out;
}

/** Move an anchor AND its handles by a delta (handles are absolute). */
function translatePoint(pt: PathPoint, dx: number, dy: number): void {
  pt.x += dx;
  pt.y += dy;
  if (pt.hIn) { pt.hIn.x += dx; pt.hIn.y += dy; }
  if (pt.hOut) { pt.hOut.x += dx; pt.hOut.y += dy; }
}

/**
 * How far off collinear two arms may be and still count as ONE tangent through
 * the anchor. Above it the anchor is a corner and nothing re-aims it.
 *
 * It is an angle, not a distance, because it is a statement about SHAPE: a
 * fitted freehand stroke and a hand-drawn pen curve both leave interior anchors
 * with mirrored tangents (the fitter splits on a centred tangent, so the two
 * halves share one), while a corner leaves them genuinely apart. A few degrees
 * of slack absorbs the float error of a fit without ever calling a corner
 * smooth.
 */
const SMOOTH_TANGENT_DEG = 12;

/**
 * Does this anchor read as SMOOTH — one tangent running through it — rather
 * than a corner? Derived from the handles it already has, so nothing is stored
 * and an imported SVG, a brush fit and a pen curve all answer the same way.
 *
 * A single-armed anchor (an open run's endpoint) is smooth: there is no second
 * arm for it to break against.
 */
export function isSmoothNode(pt: PathPoint): boolean {
  // A handle's own depth counts (a 3D tangent); one without depth lies level.
  const pz = pt.z ?? 0;
  const dz = (h: { z?: number }) => (h.z === undefined ? 0 : h.z - pz);
  const inDir = pt.hIn ? { x: pt.x - pt.hIn.x, y: pt.y - pt.hIn.y, z: -dz(pt.hIn) } : null;
  const outDir = pt.hOut ? { x: pt.hOut.x - pt.x, y: pt.hOut.y - pt.y, z: dz(pt.hOut) } : null;
  if (!inDir && !outDir) return false;
  if (!inDir || !outDir) return true;
  const la = Math.hypot(inDir.x, inDir.y, inDir.z);
  const lb = Math.hypot(outDir.x, outDir.y, outDir.z);
  if (la < 1e-9 || lb < 1e-9) return true;
  const cos = (inDir.x * outDir.x + inDir.y * outDir.y + inDir.z * outDir.z) / (la * lb);
  return Math.acos(Math.min(1, Math.max(-1, cos))) <= (SMOOTH_TANGENT_DEG * Math.PI) / 180;
}

/** The anchors either side of `i`, wrapping on a closed run, null past an open end. */
function neighbours(sub: Contour, i: number): { prev: PathPoint | null; next: PathPoint | null } {
  const n = sub.points.length;
  return {
    prev: i > 0 ? sub.points[i - 1]! : sub.closed ? sub.points[n - 1]! : null,
    next: i < n - 1 ? sub.points[i + 1]! : sub.closed ? sub.points[0]! : null,
  };
}

/**
 * Re-aim ONE smooth anchor's arms along the tangent its current neighbours
 * imply, keeping each arm's LENGTH. Corners are left alone.
 *
 * Direction is recomputed, weight is not: the Catmull-Rom tangent is what makes
 * the curve flow, while the handle lengths are the artist's — a stroke that
 * hugs one side keeps hugging it. Recomputing both (Blender's AUTO) would
 * quietly flatten every curve the drag passes near.
 */
function reaimSmoothNode(sub: Contour, i: number): void {
  const pt = sub.points[i];
  if (!pt || !isSmoothNode(pt)) return;
  const { prev, next } = neighbours(sub, i);
  const aim = autoSmoothHandles(pt, prev, next);
  const pz = pt.z ?? 0;
  for (const side of ["hIn", "hOut"] as const) {
    const arm = pt[side];
    const to = aim[side];
    if (!arm || !to) continue;
    // In 3D when the arm or its new aim has depth; a flat node stays flat.
    const deep = arm.z !== undefined || to.z !== undefined;
    const az = deep ? (arm.z ?? pz) - pz : 0;
    const tz = deep ? (to.z ?? pz) - pz : 0;
    const len = Math.hypot(arm.x - pt.x, arm.y - pt.y, az);
    const dl = Math.hypot(to.x - pt.x, to.y - pt.y, tz);
    if (len < 1e-9 || dl < 1e-9) continue;
    const k = len / dl;
    pt[side] = deep
      ? { x: pt.x + (to.x - pt.x) * k, y: pt.y + (to.y - pt.y) * k, z: pz + tz * k }
      : { x: pt.x + (to.x - pt.x) * k, y: pt.y + (to.y - pt.y) * k };
  }
}

/**
 * After some anchors moved, let the curve FOLLOW: every smooth anchor adjacent
 * to a moved one re-aims its tangent through its (now moved) neighbour.
 *
 * This is the behaviour every node editor worth using has — Blender's auto
 * handles, Illustrator's smooth points — and its absence is what made editing a
 * fitted brush stroke feel wrong: the anchor you dragged went where you asked
 * and the two curves either side of it stayed aimed at where it used to be, so
 * a smooth stroke grew a kink at every point you touched.
 *
 * Only DIRECT neighbours re-aim, and only the ones that were smooth already, so
 * a polygon of hard corners is untouched and the change never propagates past
 * the segments actually attached to the edit. Nodes that moved keep their own
 * arms exactly as dragged — the artist steered those.
 */
export function reflowAroundNodes(subs: Contour[], nodes: ReadonlyArray<NodeRef>): void {
  for (const [s, indices] of bySubpath(nodes)) {
    const sub = subs[s];
    if (!sub) continue;
    const n = sub.points.length;
    const moved = new Set(indices);
    const touched = new Set<number>();
    for (const i of indices) {
      for (const j of [i - 1, i + 1]) {
        const k = sub.closed ? (j + n) % n : j;
        if (k < 0 || k >= n || moved.has(k)) continue;
        touched.add(k);
      }
    }
    for (const i of touched) reaimSmoothNode(sub, i);
  }
}

/**
 * THE node-move primitive: translate the given anchors (handles travelling with
 * them) and re-flow the curve around them. Every door onto moving a node — the
 * pointer drag, the arrow-key nudge, the section box — goes through here, so a
 * nudged node and a dragged node cannot disagree about what "move" means.
 */
export function translateNodes(subs: Contour[], nodes: ReadonlyArray<NodeRef>, dx: number, dy: number): void {
  for (const n of nodes) {
    const pt = subs[n.sub]?.points[n.index];
    if (pt) translatePoint(pt, dx, dy);
  }
  reflowAroundNodes(subs, nodes);
}

/**
 * Reverse the winding of the given subpaths (all of them when `which` is
 * omitted): points run the other way and each anchor's in/out handles swap, so
 * the drawn outline is byte-identical but its direction — trim, arrowheads,
 * boolean winding — flips.
 */
export function reverseSubpaths(subs: Contour[], which?: ReadonlySet<number>): void {
  subs.forEach((sub, s) => {
    if (which && !which.has(s)) return;
    sub.points.reverse();
    for (const pt of sub.points) {
      const h = pt.hIn;
      pt.hIn = pt.hOut;
      pt.hOut = h;
    }
  });
}

/** Set the `closed` flag on every subpath that owns a selected node. */
export function setNodesClosed(subs: Contour[], nodes: ReadonlyArray<NodeRef>, closed: boolean): void {
  for (const s of bySubpath(nodes).keys()) {
    const sub = subs[s];
    if (sub && sub.points.length >= 2) sub.closed = closed;
  }
}

/**
 * Convert selected anchors to smooth (Figma auto-handles through the neighbors)
 * or to corners (drop both handles). Endpoints of an open run lean on their lone
 * neighbor. This is the toolbar/keyboard counterpart of the double-click toggle.
 */
export function convertNodes(subs: Contour[], nodes: ReadonlyArray<NodeRef>, to: "smooth" | "corner"): void {
  for (const [s, indices] of bySubpath(nodes)) {
    const sub = subs[s];
    if (!sub) continue;
    for (const i of indices) {
      const pt = sub.points[i];
      if (!pt) continue;
      if (to === "corner") {
        pt.hIn = null;
        pt.hOut = null;
      } else {
        const prev = i > 0 ? sub.points[i - 1]! : sub.closed ? sub.points[sub.points.length - 1]! : null;
        const next = i < sub.points.length - 1 ? sub.points[i + 1]! : sub.closed ? sub.points[0]! : null;
        const { hIn, hOut } = autoSmoothHandles(pt, prev, next);
        pt.hIn = hIn;
        pt.hOut = hOut;
      }
    }
  }
}

/** Drop both handles on the selected anchors (make them hard corners). */
export function resetHandles(subs: Contour[], nodes: ReadonlyArray<NodeRef>): void {
  convertNodes(subs, nodes, "corner");
}

/**
 * Make each selected anchor's handles mirror-symmetric: collinear, equal length
 * (the shared length is the average of the two, so nothing jumps). A node with
 * one handle grows its mirror; a corner is untouched.
 */
export function mirrorHandles(subs: Contour[], nodes: ReadonlyArray<NodeRef>): void {
  for (const n of nodes) {
    const pt = subs[n.sub]?.points[n.index];
    if (!pt || (!pt.hIn && !pt.hOut)) continue;
    // Direction from the out handle (fallback: away from the in handle).
    const ref = pt.hOut ?? (pt.hIn ? { x: 2 * pt.x - pt.hIn.x, y: 2 * pt.y - pt.hIn.y } : null);
    if (!ref) continue;
    let dx = ref.x - pt.x;
    let dy = ref.y - pt.y;
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl;
    dy /= dl;
    const lenOut = pt.hOut ? Math.hypot(pt.hOut.x - pt.x, pt.hOut.y - pt.y) : 0;
    const lenIn = pt.hIn ? Math.hypot(pt.hIn.x - pt.x, pt.hIn.y - pt.y) : 0;
    const len = (lenOut + lenIn) / (pt.hOut && pt.hIn ? 2 : 1);
    pt.hOut = { x: pt.x + dx * len, y: pt.y + dy * len };
    pt.hIn = { x: pt.x - dx * len, y: pt.y - dy * len };
  }
}

/** Collapse selected anchors onto their shared centroid (per axis, or both). */
export function averageNodes(subs: Contour[], nodes: ReadonlyArray<NodeRef>, axis: "both" | "x" | "y" = "both"): void {
  const pts = selectedPoints(subs, nodes);
  if (pts.length < 2) return;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  for (const pt of pts) {
    const dx = axis === "y" ? 0 : cx - pt.x;
    const dy = axis === "x" ? 0 : cy - pt.y;
    translatePoint(pt, dx, dy);
  }
}

export type NodeAlign = "left" | "right" | "top" | "bottom" | "hcenter" | "vcenter";

/** Align selected anchors to a shared edge/center of their bounding box. */
export function alignNodes(subs: Contour[], nodes: ReadonlyArray<NodeRef>, mode: NodeAlign): void {
  const pts = selectedPoints(subs, nodes);
  if (pts.length < 2) return;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const target = (pt: PathPoint): { dx: number; dy: number } => {
    switch (mode) {
      case "left": return { dx: minX - pt.x, dy: 0 };
      case "right": return { dx: maxX - pt.x, dy: 0 };
      case "hcenter": return { dx: (minX + maxX) / 2 - pt.x, dy: 0 };
      case "top": return { dx: 0, dy: minY - pt.y };
      case "bottom": return { dx: 0, dy: maxY - pt.y };
      case "vcenter": return { dx: 0, dy: (minY + maxY) / 2 - pt.y };
    }
  };
  for (const pt of pts) {
    const { dx, dy } = target(pt);
    translatePoint(pt, dx, dy);
  }
}

/**
 * Break the path at a single node. A closed run opens into a line that starts
 * AND ends at that node (two coincident anchors you can pull apart, Illustrator's
 * "cut path at anchor"). An open run's interior node splits it into two open
 * runs sharing a duplicated anchor. Endpoints are already broken — no-op.
 */
export function breakAtNode<T extends Contour>(subs: T[], ref: NodeRef): void {
  const sub = subs[ref.sub];
  if (!sub) return;
  const n = sub.points.length;
  const i = ref.index;
  if (sub.closed) {
    // Rotate so the loop starts at i, then append a copy of i as the new tail.
    const rotated = [...sub.points.slice(i), ...sub.points.slice(0, i)];
    rotated.push(copyPoint(rotated[0]!));
    // The duplicated ends become corners on their outward sides.
    rotated[0]!.hIn = null;
    rotated[rotated.length - 1]!.hOut = null;
    sub.points = rotated;
    sub.closed = false;
    return;
  }
  if (i <= 0 || i >= n - 1) return; // endpoint of an open run — nothing to break
  // Both halves inherit the run they came from — same part, and duplicate ids
  // are re-minted by `healContourIds` at the write seam.
  const left: T = { ...sub, closed: false, points: sub.points.slice(0, i + 1).map(copyPoint) };
  const right: T = { ...sub, closed: false, points: sub.points.slice(i).map(copyPoint) };
  left.points[left.points.length - 1]!.hOut = null;
  right.points[0]!.hIn = null;
  subs.splice(ref.sub, 1, left, right);
}

/**
 * Remove the segment between two adjacent selected anchors, opening the path
 * there. A closed run becomes an open run that ends/starts at the cut; an open
 * run splits into two. Needs exactly two adjacent selected nodes in one subpath.
 */
export function deleteSegment<T extends Contour>(subs: T[], nodes: ReadonlyArray<NodeRef>): boolean {
  // One answer to "do these two anchors name a segment" — see `segmentOf`.
  const seg = segmentOf(subs, nodes);
  if (!seg) return false;
  const sub = subs[seg.sub]!;
  const n = sub.points.length;
  const [a, b] = bySubpath(nodes).get(seg.sub) as [number, number];
  if (sub.closed) {
    // Open the loop across the removed segment: reorder so the run starts at the
    // later anchor and ends at the earlier one (the gap is where the segment was).
    const wrap = a === 0 && b === n - 1; // gap is the closing segment (n-1 → 0)
    const start = wrap ? 0 : b;
    const rotated = [...sub.points.slice(start), ...sub.points.slice(0, start)];
    rotated[0]!.hIn = null;
    rotated[rotated.length - 1]!.hOut = null;
    sub.points = rotated;
    sub.closed = false;
    return true;
  }
  const left: T = { ...sub, closed: false, points: sub.points.slice(0, a + 1).map(copyPoint) };
  const right: T = { ...sub, closed: false, points: sub.points.slice(b).map(copyPoint) };
  left.points[left.points.length - 1]!.hOut = null;
  right.points[0]!.hIn = null;
  const next = subs.filter((_, k) => k !== seg.sub);
  next.splice(seg.sub, 0, ...[left, right].filter((r) => r.points.length >= 1));
  subs.length = 0;
  subs.push(...next);
  return true;
}

/**
 * Join two OPEN endpoints. Same subpath's two ends → close it. Two different
 * subpaths → concatenate into one continuous run (reversing as needed so the
 * chosen ends meet); coincident anchors merge. Returns false if either ref isn't
 * an open endpoint.
 */
export function joinEndpoints<T extends Contour>(subs: T[], a: NodeRef, b: NodeRef): boolean {
  const isEnd = (r: NodeRef) => {
    const sub = subs[r.sub];
    return !!sub && !sub.closed && sub.points.length >= 2 && (r.index === 0 || r.index === sub.points.length - 1);
  };
  if (!isEnd(a) || !isEnd(b)) return false;
  if (a.sub === b.sub) {
    subs[a.sub]!.closed = true;
    return true;
  }
  const sa = subs[a.sub]!;
  const sb = subs[b.sub]!;
  // Orient so a's joined end is the tail and b's is the head.
  if (a.index === 0) reverseSubpaths(subs, new Set([a.sub]));
  if (b.index !== 0) reverseSubpaths(subs, new Set([b.sub]));
  const merged: PathPoint[] = sa.points.map(copyPoint);
  const tail = merged[merged.length - 1]!;
  const head = sb.points[0]!;
  const coincident = Math.hypot(tail.x - head.x, tail.y - head.y) < 1e-6;
  if (coincident) tail.hOut = clone(head.hOut); // fuse the shared anchor
  const rest = sb.points.slice(coincident ? 1 : 0).map(copyPoint);
  const result: T = { ...sa, closed: false, points: [...merged, ...rest] };
  const keep = subs.filter((_, k) => k !== a.sub && k !== b.sub);
  keep.push(result);
  subs.length = 0;
  subs.push(...keep);
  return true;
}

// ── Node identity (welds) ────────────────────────────────────────────────────

/**
 * Points sharing a `weldId` are ONE node stored once per run through it.
 *
 * A subpath point has exactly two neighbours, so a T-junction — three lines
 * meeting — cannot live in one run. Leaving two anchors on the same coordinates
 * and calling it connected is the lie this replaces: it renders identically and
 * comes apart the instant you drag it. A weld says the two ARE one node, so
 * every op that moves, deletes or reshapes a node can act on all of it.
 *
 * Identity, not coincidence: two anchors may share a pixel by accident, and
 * dragging one of those must not drag the other.
 */

/**
 * The id naming this node's identity, minted if it has none.
 *
 * The primitive behind "start a branch HERE": the branch's first point is
 * stamped with the same id, so the two are one node from the moment the run
 * exists rather than two points that happen to share coordinates.
 */
export function weldIdAt(subs: Subpath[], ref: NodeRef): string | null {
  const pt = subs[ref.sub]?.points[ref.index];
  if (!pt) return null;
  if (!pt.weldId) pt.weldId = createId("weld");
  return pt.weldId;
}

/** Every node that IS `ref` — itself, plus anything welded to it. */
export function weldGroup(subs: ReadonlyArray<Subpath>, ref: NodeRef): NodeRef[] {
  const id = subs[ref.sub]?.points[ref.index]?.weldId;
  if (!id) return [ref];
  const out: NodeRef[] = [];
  subs.forEach((sub, s) =>
    sub.points.forEach((pt, i) => {
      if (pt.weldId === id) out.push({ sub: s, index: i });
    }),
  );
  return out.length > 0 ? out : [ref];
}

/**
 * Fuse the given nodes into one. Any weld already present is absorbed, so
 * welding onto a junction grows THAT junction instead of starting a rival one —
 * the reason a third and fourth line meeting at a point stay one node. Every
 * member is moved onto the first ref's coordinates, because a junction whose
 * parts sit apart is not one.
 */
export function weldNodes(subs: Contour[], refs: ReadonlyArray<NodeRef>, id = createId("weld")): string | null {
  const live = refs.filter((r) => subs[r.sub]?.points[r.index]);
  if (live.length < 2) return null;
  const absorb = new Set<string>();
  for (const r of live) {
    const w = subs[r.sub]!.points[r.index]!.weldId;
    if (w) absorb.add(w);
  }
  const at = subs[live[0]!.sub]!.points[live[0]!.index]!;
  const place = (pt: PathPoint) => {
    const dx = at.x - pt.x;
    const dy = at.y - pt.y;
    pt.x = at.x;
    pt.y = at.y;
    if (pt.hIn) {
      pt.hIn.x += dx;
      pt.hIn.y += dy;
    }
    if (pt.hOut) {
      pt.hOut.x += dx;
      pt.hOut.y += dy;
    }
    pt.weldId = id;
  };
  for (const r of live) place(subs[r.sub]!.points[r.index]!);
  // Anything that was welded to a member is welded to the result.
  if (absorb.size > 0) {
    for (const sub of subs) {
      for (const pt of sub.points) {
        if (pt.weldId && absorb.has(pt.weldId)) place(pt);
      }
    }
  }
  return id;
}

/**
 * Drop welds that no longer join anything — a group down to its last point is
 * an ordinary node again. Deleting one arm of a junction has to leave the rest
 * honest, or a stale id would silently re-fuse a point inserted later.
 */
export function pruneWelds(subs: Subpath[]): void {
  const count = new Map<string, number>();
  for (const sub of subs) {
    for (const pt of sub.points) {
      if (pt.weldId) count.set(pt.weldId, (count.get(pt.weldId) ?? 0) + 1);
    }
  }
  for (const sub of subs) {
    for (const pt of sub.points) {
      if (pt.weldId && (count.get(pt.weldId) ?? 0) < 2) delete pt.weldId;
    }
  }
}

/**
 * DELETE NODES — remove these anchors from a path, the one rule every surface
 * deletes points by (the flat node editor's ⌫ and the 3D edit mode's X). A
 * subpath left with fewer than two anchors is no longer a path and goes; welds
 * that no longer join anything are pruned (a stale id would silently re-fuse a
 * point inserted later). Returns whether anything is left of the path at all —
 * false means the caller should remove the layer.
 */
export function deleteNodes(subs: Subpath[], nodes: ReadonlyArray<NodeRef>): boolean {
  const doomed = new Map<number, Set<number>>();
  for (const n of nodes) (doomed.get(n.sub) ?? doomed.set(n.sub, new Set()).get(n.sub)!).add(n.index);
  for (const [s, idx] of doomed) {
    const sub = subs[s];
    if (sub) sub.points = sub.points.filter((_, i) => !idx.has(i));
  }
  for (let s = subs.length - 1; s >= 0; s--) if (subs[s]!.points.length < 2) subs.splice(s, 1);
  pruneWelds(subs);
  return subs.length > 0;
}

/**
 * Simplify: thin each subpath's anchors at `tolerance` (local units) and put a
 * flowing curve back through the survivors — the classic "reduce points, keep
 * the shape" cleanup, run by hand from the pen toolbar.
 *
 * The thinning and the fitting are the SHARED ones (`drawing/fidelity`), the
 * same pair the eraser and lasso use to refit what a boolean hands back. This
 * command differs only in mandate: it is a deliberate act on a path you chose,
 * so it thins anything, where the automatic refit only touches geometry a
 * boolean just produced. Routing both through one fitter is also why Simplify
 * stopped rounding deliberate corners — a thinned rectangle stays a rectangle.
 */
export function simplifySubpaths<T extends Contour>(subs: ReadonlyArray<T>, tolerance: number): T[] {
  const fidelity: PathFidelity = { ...DEFAULT_PATH_FIDELITY, simplify: tolerance };
  return subs.map((sub) => {
    if (sub.points.length < 3) return { ...sub, points: sub.points.map(copyPoint) };
    const thinned = decimatePolyline(sub.points, tolerance);
    const fitted = fitPolyline(thinned, fidelity, sub.closed);
    if (fitted) return { ...sub, ...fitted };
    // Degenerate (every anchor collapsed onto one point) — leave it alone.
    return { ...sub, points: sub.points.map(copyPoint) };
  });
}

// ── Knife (headless) ─────────────────────────────────────────────────────────
//
// The Cut tool's brain. Given a knife SEGMENT in a clip's local space, it finds
// every place the segment crosses the outline, inserts exact on-curve anchors
// there, and severs the path at each — a straight slice through any vector.
// Pure geometry; the overlay transforms the world knife line into each clip's
// local space and writes back the returned subpaths.

const KNIFE_STEPS = 22;

function evalCubic(a: PathPoint, b: PathPoint, t: number): Vec2 {
  const c1 = a.hOut ?? a;
  const c2 = b.hIn ?? b;
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}

/** Signed side of point `p` relative to the directed line a→b. */
function sideOf(a: Vec2, b: Vec2, p: Vec2): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

/** Parameter of `p` projected onto segment a→b (0..1 when between the ends). */
function projParam(a: Vec2, b: Vec2, p: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  return ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
}

/** Where the knife segment [ka,kb] crosses one subpath: {seg, t} (t along the segment). */
function knifeCrossings(sub: Contour, ka: Vec2, kb: Vec2): Array<{ seg: number; t: number }> {
  const out: Array<{ seg: number; t: number }> = [];
  const segCount = sub.closed ? sub.points.length : sub.points.length - 1;
  for (let i = 0; i < segCount; i++) {
    const a = sub.points[i]!;
    const b = sub.points[(i + 1) % sub.points.length]!;
    let prevSide = sideOf(ka, kb, evalCubic(a, b, 0));
    for (let k = 1; k <= KNIFE_STEPS; k++) {
      const t = k / KNIFE_STEPS;
      const curSide = sideOf(ka, kb, evalCubic(a, b, t));
      // A crossing = a sign flip between samples, OR a sample landing exactly on
      // the line (handled explicitly so an on-sample hit isn't skipped — e.g. the
      // midpoint of an edge, which lands on a round step).
      const flip = (prevSide < 0 && curSide > 0) || (prevSide > 0 && curSide < 0);
      const onLine = curSide === 0 && prevSide !== 0;
      if (flip || onLine) {
        const frac = onLine ? 1 : prevSide / (prevSide - curSide);
        const tt = (k - 1 + frac) / KNIFE_STEPS;
        // Only count it if the crossing lies within the knife SEGMENT, not its
        // infinite extension — so the slice cuts exactly what you dragged over.
        const u = projParam(ka, kb, evalCubic(a, b, tt));
        if (u >= -0.02 && u <= 1.02 && tt > 1e-3 && tt < 1 - 1e-3) out.push({ seg: i, t: tt });
      }
      prevSide = curSide;
    }
  }
  return out;
}

/** Insert cut anchors for the crossings, then split the run into pieces. */
function severSubpath<T extends Contour>(sub: T, crossings: Array<{ seg: number; t: number }>): { pieces: T[]; added: number } {
  const work: T = { ...sub, points: sub.points.map(copyPoint) };
  const bySeg = new Map<number, number[]>();
  for (const c of crossings) {
    const arr = bySeg.get(c.seg) ?? [];
    arr.push(c.t);
    bySeg.set(c.seg, arr);
  }
  const cutIdx: number[] = [];
  let offset = 0; // anchors inserted so far shift later segment bases
  for (const seg of [...bySeg.keys()].sort((a, b) => a - b)) {
    const ts = bySeg.get(seg)!.sort((a, b) => a - b);
    let base = seg + offset;
    let prevT = 0;
    for (const tOrig of ts) {
      const tLocal = (tOrig - prevT) / (1 - prevT || 1); // rescale into the current right piece
      const ni = insertPointOnSegment(work, base, Math.max(1e-4, Math.min(1 - 1e-4, tLocal)));
      cutIdx.push(ni);
      base = ni;
      prevT = tOrig;
      offset++;
    }
  }
  return { pieces: splitAtCutAnchors(work, new Set(cutIdx)), added: cutIdx.length };
}

/** Split a run at the given anchor indices into open pieces (closed runs open). */
function splitAtCutAnchors<T extends Contour>(sub: T, cutSet: Set<number>): T[] {
  const pts = sub.points;
  const cuts = [...cutSet].sort((a, b) => a - b);
  if (cuts.length === 0) return [{ ...sub, points: pts.map(copyPoint) }];
  if (!sub.closed) {
    const bounds = [0, ...cuts.filter((c) => c > 0 && c < pts.length - 1), pts.length - 1];
    const runs: T[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const run = pts.slice(bounds[i], bounds[i + 1]! + 1).map(copyPoint);
      if (run.length >= 2) runs.push({ ...sub, closed: false, points: run });
    }
    return runs.length ? runs : [{ ...sub, closed: false, points: pts.map(copyPoint) }];
  }
  const n = pts.length;
  const runs: T[] = [];
  for (let i = 0; i < cuts.length; i++) {
    const start = cuts[i]!;
    const end = cuts[(i + 1) % cuts.length]!;
    const run: PathPoint[] = [copyPoint(pts[start]!)];
    let j = start;
    do {
      j = (j + 1) % n;
      run.push(copyPoint(pts[j]!));
    } while (j !== end);
    if (run.length >= 2) runs.push({ ...sub, closed: false, points: run });
  }
  return runs;
}

/**
 * Slice a clip's subpaths with a knife SEGMENT (clip-local coords): every
 * crossing becomes an exact anchor and the path severs there. Returns fresh
 * subpaths and the number of cuts made (0 = the knife missed this clip).
 */
export function knifeSubpaths<T extends Contour>(subs: ReadonlyArray<T>, ka: Vec2, kb: Vec2): { subs: T[]; cuts: number } {
  const result: T[] = [];
  let cuts = 0;
  for (const sub of subs) {
    const crossings = knifeCrossings(sub, ka, kb);
    if (crossings.length === 0) {
      result.push({ ...sub, points: sub.points.map(copyPoint) });
      continue;
    }
    const { pieces, added } = severSubpath(sub, crossings);
    cuts += added;
    result.push(...pieces);
  }
  return { subs: result, cuts };
}

/* ------------------------------------------------------------- segment verbs */

/**
 * The SEGMENT two selected anchors name — the run between them — or null when
 * they name none (different contours, not adjacent, wrong count).
 *
 * A segment is not a stored thing and does not need to be: it IS its two
 * bounding anchors, so selecting them selects it, and every segment verb reads
 * the same selection every node verb does. A parallel "selected segment" would
 * be a second description of one fact, and the two would disagree the first
 * time a node was deleted out from under it.
 *
 * `index` is the FIRST anchor of the run, so the segment is `index → index+1`
 * (wrapping on a closed contour). `deleteSegment` and the toolbar's
 * `adjacentPair` both used to re-derive this inline; now there is one answer.
 */
export function segmentOf(
  subs: ReadonlyArray<Contour>,
  nodes: ReadonlyArray<NodeRef>,
): { sub: number; index: number } | null {
  const groups = bySubpath(nodes);
  if (groups.size !== 1) return null;
  const [s, idx] = [...groups.entries()][0]!;
  const sub = subs[s];
  if (!sub || idx.length !== 2) return null;
  const n = sub.points.length;
  const [a, b] = idx as [number, number];
  if (b - a === 1) return { sub: s, index: a };
  // The closing run of a loop: last anchor → first.
  if (sub.closed && a === 0 && b === n - 1) return { sub: s, index: n - 1 };
  return null;
}

/** The two anchors a segment runs between. */
function segmentEnds(sub: Contour, index: number): [PathPoint, PathPoint] {
  return [sub.points[index]!, sub.points[(index + 1) % sub.points.length]!];
}

/** Straighten a segment: drop only the two handles that face along it. */
export function straightenSegment<T extends Contour>(subs: T[], nodes: ReadonlyArray<NodeRef>): boolean {
  const seg = segmentOf(subs, nodes);
  if (!seg) return false;
  const [a, b] = segmentEnds(subs[seg.sub]!, seg.index);
  // Only the arms pointing INTO this segment — the anchors' other sides belong
  // to their neighbouring runs and must survive untouched.
  a.hOut = null;
  b.hIn = null;
  return true;
}

/**
 * Curve a straight segment: handles a third of the way along the chord.
 *
 * The neutral shape every vector tool converts to — visually still a line, but
 * with something to drag. Anything cleverer would be guessing at an intent the
 * next drag is about to state exactly.
 */
export function curveSegment<T extends Contour>(subs: T[], nodes: ReadonlyArray<NodeRef>): boolean {
  const seg = segmentOf(subs, nodes);
  if (!seg) return false;
  const [a, b] = segmentEnds(subs[seg.sub]!, seg.index);
  const dx = (b.x - a.x) / 3;
  const dy = (b.y - a.y) / 3;
  a.hOut = { x: a.x + dx, y: a.y + dy };
  b.hIn = { x: b.x - dx, y: b.y - dy };
  return true;
}

/**
 * Copy a segment out as its own open contour, offset so you can see it.
 *
 * The copy is NOT welded to anything: a weld means two points are one node, and
 * a duplicate is by definition a different node in a different run.
 */
export function duplicateSegment<T extends Contour>(
  subs: T[],
  nodes: ReadonlyArray<NodeRef>,
  offset = 12,
): boolean {
  const seg = segmentOf(subs, nodes);
  if (!seg) return false;
  const sub = subs[seg.sub]!;
  const [a, b] = segmentEnds(sub, seg.index);
  const move = (p: Vec2 | null | undefined): Vec2 | null =>
    p ? { x: p.x + offset, y: p.y + offset } : null;
  const lift = (p: PathPoint, hIn: Vec2 | null, hOut: Vec2 | null): PathPoint => ({
    x: p.x + offset,
    y: p.y + offset,
    hIn,
    hOut,
    ...(p.cornerRadius === undefined ? {} : { cornerRadius: p.cornerRadius }),
  });
  subs.push({
    ...sub,
    closed: false,
    points: [lift(a, null, move(a.hOut)), lift(b, move(b.hIn), null)],
  } as T);
  return true;
}

/**
 * Add an anchor on a segment, splitting the curve so the outline does not move.
 * Returns the new point's index, or null when the selection names no segment.
 */
export function splitSegment<T extends Contour>(
  subs: T[],
  nodes: ReadonlyArray<NodeRef>,
  t = 0.5,
): number | null {
  const seg = segmentOf(subs, nodes);
  if (!seg) return null;
  return insertPointOnSegment(subs[seg.sub]!, seg.index, t);
}
