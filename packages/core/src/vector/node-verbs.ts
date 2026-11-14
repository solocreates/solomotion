import type { Contour, PathPoint, Subpath } from "../schema/vector";
import {
  averageNodes,
  breakAtNode,
  convertNodes,
  curveSegment,
  deleteNodes,
  deleteSegment,
  duplicateSegment,
  isSmoothNode,
  joinEndpoints,
  mirrorHandles,
  reverseSubpaths,
  segmentOf,
  setNodesClosed,
  simplifySubpaths,
  straightenSegment,
  weldIdAt,
  weldNodes,
  pruneWelds,
  type NodeRef,
} from "./edit-engine";
import { copyPathPoint, insertPointOnSegment } from "./geometry";

/**
 * THE POINT VERBS — every structural thing you can do to a path's nodes, as
 * ONE vocabulary. The flat pen's toolbar, its right-click menu and keys, the
 * 3D edit mode's menu, rail and keys all name a verb here and run it here, so
 * "Smooth" or "Merge" cannot mean one thing on the canvas and another in a
 * world. Pure: a verb takes the outline as it shows and a node selection, and
 * edits the outline in place.
 *
 * Every verb works in a path's own coordinates, depth included: a node's `z`
 * and its handles' `z` move, copy, merge and smooth with it, so a 3D stroke
 * and a flat drawing obey the same verbs.
 *
 * A verb answers which nodes are selected AFTER it: the same ones (`select`
 * absent), new ones (the point an extrude made, the node a merge left), or
 * none (`null`) when the nodes it named no longer mean what they did.
 */

/** What a node selection is — the facts that decide which verbs apply. */
export interface NodeSelection {
  nodeCount: number;
  /** Two selected neighbours name a segment: its shape now, else null. */
  segment: "line" | "curve" | null;
  /** Exactly two open ends are selected (Join / make segment). */
  endpointPair: boolean;
  /** How many of the selected nodes are open ends (Extrude grows from those). */
  ends: number;
  anyOpen: boolean;
  anyClosed: boolean;
  /** The selection's point type: all smooth, all corner, or a mix. */
  type: "smooth" | "corner" | "mixed" | null;
}

export function nodeSelection(subs: ReadonlyArray<Contour>, refs: ReadonlyArray<NodeRef>): NodeSelection {
  const live = refs.filter((r) => subs[r.sub]?.points[r.index]);
  const seg = segmentOf(subs, live);
  let segment: NodeSelection["segment"] = null;
  if (seg) {
    const sub = subs[seg.sub]!;
    const a = sub.points[seg.index]!, b = sub.points[(seg.index + 1) % sub.points.length]!;
    segment = a.hOut || b.hIn ? "curve" : "line";
  }
  const isEnd = (r: NodeRef) => {
    const s = subs[r.sub]!;
    return !s.closed && (r.index === 0 || r.index === s.points.length - 1);
  };
  const ends = live.filter(isEnd).length;
  const owned = new Set(live.map((r) => r.sub));
  const smooth = live.filter((r) => isSmoothNode(subs[r.sub]!.points[r.index]!)).length;
  return {
    nodeCount: live.length,
    segment,
    endpointPair: live.length === 2 && ends === 2,
    ends,
    anyOpen: [...owned].some((s) => !subs[s]!.closed),
    anyClosed: [...owned].some((s) => subs[s]!.closed),
    type: live.length === 0 ? null : smooth === live.length ? "smooth" : smooth === 0 ? "corner" : "mixed",
  };
}

export type NodeVerbId =
  | "toggleType"
  | "smooth"
  | "corner"
  | "mirrorHandles"
  | "average"
  | "merge"
  | "join"
  | "break"
  | "extrude"
  | "subdivide"
  | "toLine"
  | "toCurve"
  | "duplicateSeg"
  | "deleteSeg"
  | "close"
  | "open"
  | "toggleClosed"
  | "reverse"
  | "simplify"
  | "selectRun"
  | "delete";

export interface NodeVerbResult {
  /** Did the outline change? (A selection-only verb leaves it.) */
  changed: boolean;
  /** Nodes selected after: absent = unchanged, null = none. */
  select?: NodeRef[] | null;
  /** Nothing of the path is left — the caller removes the layer. */
  emptied?: boolean;
}

export interface NodeVerb {
  id: NodeVerbId;
  /** The menu's words. */
  label: string;
  /** The history step's words. */
  undo: string;
  /** Does it mean anything for this selection? Menus show only what applies. */
  applies(ctx: NodeSelection): boolean;
  /** Acts on the whole path when nothing is selected (Reverse, Simplify). */
  wholePath?: true;
  run(subs: Subpath[], refs: NodeRef[]): NodeVerbResult;
}

const same = (changed = true): NodeVerbResult => ({ changed });
const cleared = (changed = true): NodeVerbResult => ({ changed, select: null });

/**
 * The selection's type, flipped — THE double-click (and V): a node with
 * handles becomes a corner, a node without gets smooth ones through its
 * neighbours. A mixed selection goes the way most of it points.
 */
function toggleType(subs: Subpath[], refs: NodeRef[]): NodeVerbResult {
  const curved = refs.filter((r) => {
    const p = subs[r.sub]?.points[r.index];
    return !!p && !!(p.hIn || p.hOut);
  }).length;
  convertNodes(subs, refs, curved > refs.length / 2 ? "corner" : "smooth");
  return same();
}

export const NODE_VERBS: Record<NodeVerbId, NodeVerb> = {
  toggleType: { id: "toggleType", label: "Smooth / corner", undo: "Point type", applies: (c) => c.nodeCount > 0, run: toggleType },
  // Smooth on a node that is already smooth re-aims its handles through its
  // neighbours (a reset to the flowing curve), so it applies to any selection.
  smooth: { id: "smooth", label: "Smooth", undo: "Smooth nodes", applies: (c) => c.nodeCount > 0, run: (s, r) => (convertNodes(s, r, "smooth"), same()) },
  corner: { id: "corner", label: "Corner", undo: "Corner nodes", applies: (c) => c.nodeCount > 0, run: (s, r) => (convertNodes(s, r, "corner"), same()) },
  mirrorHandles: { id: "mirrorHandles", label: "Balance handles", undo: "Mirror handles", applies: (c) => c.nodeCount > 0 && c.type !== "corner", run: (s, r) => (mirrorHandles(s, r), same()) },
  average: { id: "average", label: "Average", undo: "Average points", applies: (c) => c.nodeCount >= 2, run: (s, r) => (averageNodes(s, r), same()) },
  merge: { id: "merge", label: "Merge", undo: "Merge points", applies: (c) => c.nodeCount >= 2, run: (s, r) => mergeNodes(s, r) },
  join: {
    id: "join",
    label: "Join",
    undo: "Join path",
    applies: (c) => c.endpointPair,
    run: (s, r) => (r.length === 2 && joinEndpoints(s, r[0]!, r[1]!) ? cleared() : same(false)),
  },
  break: { id: "break", label: "Break path here", undo: "Break path", applies: (c) => c.nodeCount === 1, run: (s, r) => (breakAtNode(s, r[0]!), cleared()) },
  extrude: { id: "extrude", label: "Extrude", undo: "Extrude", applies: (c) => c.nodeCount > 0, run: (s, r) => extrudeNodes(s, r) },
  subdivide: { id: "subdivide", label: "Subdivide", undo: "Subdivide", applies: (c) => c.nodeCount >= 2, run: (s, r) => subdivideNodes(s, r) },
  toLine: { id: "toLine", label: "Convert to line", undo: "Straighten segment", applies: (c) => c.segment === "curve", run: (s, r) => same(straightenSegment(s, r)) },
  toCurve: { id: "toCurve", label: "Convert to curve", undo: "Curve segment", applies: (c) => c.segment === "line", run: (s, r) => same(curveSegment(s, r)) },
  duplicateSeg: { id: "duplicateSeg", label: "Duplicate segment", undo: "Duplicate segment", applies: (c) => c.segment !== null, run: (s, r) => cleared(duplicateSegment(s, r)) },
  deleteSeg: { id: "deleteSeg", label: "Delete segment", undo: "Delete segment", applies: (c) => c.segment !== null, run: (s, r) => cleared(deleteSegment(s, r)) },
  close: { id: "close", label: "Close path", undo: "Close path", applies: (c) => c.anyOpen, run: (s, r) => (setNodesClosed(s, r, true), same()) },
  open: { id: "open", label: "Open path", undo: "Open path", applies: (c) => c.anyClosed, run: (s, r) => (setNodesClosed(s, r, false), same()) },
  toggleClosed: {
    id: "toggleClosed",
    label: "Close / open path",
    undo: "Close path",
    applies: (c) => c.nodeCount > 0,
    run: (s, r) => (setNodesClosed(s, r, !s[r[0]!.sub]?.closed), same()),
  },
  reverse: {
    id: "reverse",
    label: "Reverse direction",
    undo: "Reverse path",
    applies: () => true,
    wholePath: true,
    run: (s, r) => (reverseSubpaths(s, r.length ? new Set(r.map((x) => x.sub)) : undefined), cleared()),
  },
  simplify: {
    id: "simplify",
    label: "Simplify",
    undo: "Simplify path",
    applies: () => true,
    wholePath: true,
    run: (s) => {
      const out = simplifySubpaths(s, SIMPLIFY_TOLERANCE);
      s.splice(0, s.length, ...out);
      return cleared();
    },
  },
  selectRun: {
    id: "selectRun",
    label: "Select the whole line",
    undo: "Select",
    applies: (c) => c.nodeCount > 0,
    run: (s, r) => ({ changed: false, select: [...new Set(r.map((x) => x.sub))].flatMap((sub) => s[sub]!.points.map((_, index) => ({ sub, index }))) }),
  },
  delete: {
    id: "delete",
    label: "Delete points",
    undo: "Delete points",
    applies: (c) => c.nodeCount > 0,
    run: (s, r) => {
      const left = deleteNodes(s, r);
      return { changed: true, select: null, emptied: !left };
    },
  },
};

/** RDP tolerance for Simplify, in layer units (≈px at 100% scale). */
export const SIMPLIFY_TOLERANCE = 2.5;

/**
 * Run a verb on a selection. Refs past the outline are dropped first, so a
 * selection left stale by an agent's edit or an undo can never reach an op.
 */
export function runNodeVerb(id: NodeVerbId, subs: Subpath[], refs: ReadonlyArray<NodeRef>): NodeVerbResult {
  const live = refs.filter((r) => subs[r.sub]?.points[r.index]);
  const verb = NODE_VERBS[id];
  if (!verb.wholePath && live.length === 0) return { changed: false };
  if (!verb.applies(nodeSelection(subs, live))) return { changed: false };
  return verb.run(subs, live);
}

// ── Merge ─────────────────────────────────────────────────────────────────────

type P3 = { x: number; y: number; z?: number };

/** The centre of the selected anchors, depth included when any has depth. */
function centreOf(subs: ReadonlyArray<Contour>, refs: ReadonlyArray<NodeRef>): P3 {
  let x = 0, y = 0, z = 0, deep = false;
  for (const r of refs) {
    const p = subs[r.sub]!.points[r.index]!;
    x += p.x;
    y += p.y;
    z += p.z ?? 0;
    if (p.z !== undefined) deep = true;
  }
  const n = Math.max(1, refs.length);
  return deep ? { x: x / n, y: y / n, z: z / n } : { x: x / n, y: y / n };
}

/** A handle carried along by its anchor's move from `from` to `to` (depth too). */
function carried(h: PathPoint["hIn"], from: PathPoint, to: P3): PathPoint["hIn"] {
  if (!h) return null;
  const dz = to.z === undefined ? 0 : to.z - (from.z ?? 0);
  return { x: h.x + to.x - from.x, y: h.y + to.y - from.y, ...(h.z === undefined ? {} : { z: h.z + dz }) };
}

/**
 * MERGE (Blender's M, "at center") — the selected nodes become ONE, at their
 * centre (or `at`).
 *
 * What "one" means depends on where they are, and each case is the honest
 * version of it for a path:
 *  - neighbours along a line collapse into a single point (the run keeps its
 *    outer handles, so the curve either side stays);
 *  - two open ends — of one line or of two — JOIN there, into one continuous
 *    run (a line's own two ends close it);
 *  - points of different lines that are not ends are WELDED: one node several
 *    lines pass through (a T-junction), which moves as one from then on.
 * The node that is left is the selection afterwards.
 */
export function mergeNodes(subs: Subpath[], refs: ReadonlyArray<NodeRef>, at?: P3): NodeVerbResult {
  const live = refs.filter((r) => subs[r.sub]?.points[r.index]);
  if (live.length < 2) return { changed: false };
  const to = at ?? centreOf(subs, live);
  // 1. Collapse each run of selected neighbours to its first point.
  const survivors: PathPoint[] = [];
  const doomed: NodeRef[] = [];
  const bySub = new Map<number, number[]>();
  for (const r of live) (bySub.get(r.sub) ?? bySub.set(r.sub, []).get(r.sub)!).push(r.index);
  for (const [s, idx] of bySub) {
    const sub = subs[s]!;
    const n = sub.points.length;
    const sel = new Set(idx);
    // Every selected index, grouped into runs of consecutive neighbours
    // (wrapping on a closed line). A fully selected loop is one run.
    const seen = new Set<number>();
    for (const i of [...sel].sort((a, b) => a - b)) {
      if (seen.has(i)) continue;
      // Walk back to the run's start.
      let start = i;
      for (let k = 0; k < n; k++) {
        const prev = sub.closed ? (start - 1 + n) % n : start - 1;
        if (prev < 0 || !sel.has(prev) || prev === i) break;
        start = prev;
      }
      const run: number[] = [];
      for (let j = start, k = 0; k < n && sel.has(j) && !seen.has(j); k++) {
        run.push(j);
        seen.add(j);
        j = sub.closed ? (j + 1) % n : j + 1;
        if (j >= n) break;
      }
      const first = sub.points[run[0]!]!;
      const last = sub.points[run[run.length - 1]!]!;
      // The collapsed point keeps the curve's two OUTER handles, each carried
      // by its own anchor's move — so the curve either side keeps its shape.
      const hIn = carried(first.hIn, first, to);
      const hOut = carried(last.hOut, last, to);
      first.x = to.x;
      first.y = to.y;
      if (to.z !== undefined) {
        if (Math.abs(to.z) > 1e-9) first.z = to.z;
        else delete first.z;
      }
      first.hIn = hIn;
      first.hOut = hOut;
      for (const j of run.slice(1)) doomed.push({ sub: s, index: j });
      survivors.push(first);
    }
  }
  // Mark the survivors so they can be found again after indices shift.
  const mark = "__merge";
  survivors.forEach((p) => ((p as PathPoint & { [mark]?: true })[mark] = true));
  if (doomed.length) deleteNodes(subs, doomed);
  const find = (): NodeRef[] => {
    const out: NodeRef[] = [];
    subs.forEach((sub, s) => sub.points.forEach((p, i) => (p as PathPoint & { [mark]?: true })[mark] && out.push({ sub: s, index: i })));
    return out;
  };
  let left = find();
  // 2. Two open ends meet: join them into one run (or close the line).
  if (left.length === 2) {
    const [a, b] = left as [NodeRef, NodeRef];
    const end = (r: NodeRef) => {
      const s = subs[r.sub]!;
      return !s.closed && s.points.length >= 2 && (r.index === 0 || r.index === s.points.length - 1);
    };
    if (end(a) && end(b)) {
      if (a.sub === b.sub) {
        // A line's own ends: the tail folds into the head and the line closes.
        const s = subs[a.sub]!;
        const head = s.points[0]!, tail = s.points[s.points.length - 1]!;
        head.hIn = tail.hIn ? { ...tail.hIn } : null;
        s.points.pop();
        s.closed = s.points.length >= 2;
      } else joinEndpoints(subs, a, b);
      left = find();
    }
  }
  // 3. Anything still apart is several lines through one point: weld them.
  if (left.length > 1) weldNodes(subs, left);
  for (const sub of subs) for (const p of sub.points) delete (p as PathPoint & { [mark]?: true })[mark];
  for (let s = subs.length - 1; s >= 0; s--) if (subs[s]!.points.length < 2) subs.splice(s, 1);
  pruneWelds(subs);
  const select = left.filter((r) => subs[r.sub]?.points[r.index]).slice(0, 1);
  return { changed: true, select: select.length ? select : null, emptied: subs.length === 0 };
}

// ── Extrude ───────────────────────────────────────────────────────────────────

/**
 * EXTRUDE (Blender's E on a curve) — a new point grows out of each selected
 * node, where it stands, ready to be dragged away:
 *  - from an open end, the line simply continues (appended at the tail,
 *    prepended at the head);
 *  - from anywhere else, a BRANCH starts there: a new two-point line welded
 *    to the node, so the junction is one node, not two that happen to touch.
 * The new points are the selection afterwards — the caller grabs them.
 */
export function extrudeNodes(subs: Subpath[], refs: ReadonlyArray<NodeRef>): NodeVerbResult {
  const live = refs.filter((r) => subs[r.sub]?.points[r.index]);
  if (!live.length) return { changed: false };
  const fresh: PathPoint[] = [];
  const grow = (p: PathPoint): PathPoint => {
    const q = copyPathPoint(p);
    q.hIn = null;
    q.hOut = null;
    delete q.weldId;
    delete q.cornerRadius;
    fresh.push(q);
    return q;
  };
  // Ends first and in descending index order, so each splice leaves the
  // remaining refs pointing where they did.
  const sorted = [...live].sort((a, b) => b.sub - a.sub || b.index - a.index);
  const branches: Subpath[] = [];
  for (const r of sorted) {
    const sub = subs[r.sub]!;
    const p = sub.points[r.index]!;
    const n = sub.points.length;
    if (!sub.closed && r.index === n - 1 && n >= 1) sub.points.push(grow(p));
    else if (!sub.closed && r.index === 0) sub.points.unshift(grow(p));
    else {
      const weld = weldIdAt(subs, r)!;
      const root = copyPathPoint(p);
      root.hIn = null;
      root.hOut = null;
      root.weldId = weld;
      branches.push({ ...sub, id: "", closed: false, points: [root, grow(p)] } as Subpath);
    }
  }
  subs.push(...branches);
  const select: NodeRef[] = [];
  subs.forEach((sub, s) => sub.points.forEach((p, i) => fresh.includes(p) && select.push({ sub: s, index: i })));
  return { changed: true, select };
}

// ── Subdivide ─────────────────────────────────────────────────────────────────

/**
 * SUBDIVIDE — a point in the middle of every segment whose two ends are both
 * selected, ON the curve (the outline does not move). Blender's Subdivide for
 * a curve; the pen's "Add point" is its two-node case. The new points join
 * the selection.
 */
export function subdivideNodes(subs: Subpath[], refs: ReadonlyArray<NodeRef>): NodeVerbResult {
  const live = refs.filter((r) => subs[r.sub]?.points[r.index]);
  const chosen = new Set(live.map((r) => `${r.sub}:${r.index}`));
  const all: PathPoint[] = live.map((r) => subs[r.sub]!.points[r.index]!);
  let changed = false;
  subs.forEach((sub, s) => {
    const n = sub.points.length;
    const segs: number[] = [];
    const count = sub.closed ? n : n - 1;
    for (let i = 0; i < count; i++) if (chosen.has(`${s}:${i}`) && chosen.has(`${s}:${(i + 1) % n}`)) segs.push(i);
    // From the last segment back, so earlier indices stay put.
    for (const i of segs.sort((a, b) => b - a)) {
      const at = insertPointOnSegment(sub, i, 0.5);
      all.push(sub.points[at]!);
      changed = true;
    }
  });
  if (!changed && live.length === 2) {
    // Two nodes that are not neighbours name no segment: nothing to split.
    return { changed: false };
  }
  const select: NodeRef[] = [];
  subs.forEach((sub, s) => sub.points.forEach((p, i) => all.includes(p) && select.push({ sub: s, index: i })));
  return { changed, select };
}

/** The verbs whose argument is a SEGMENT (two neighbouring nodes) — `splitSegment` is Subdivide's two-node case. */
export const SEGMENT_VERBS: readonly NodeVerbId[] = ["toLine", "toCurve", "subdivide", "duplicateSeg", "deleteSeg"];
