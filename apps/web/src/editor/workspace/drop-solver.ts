/**
 * THE DROP SOLVER — given the tree, the workspace rect, what is being dragged
 * and where the pointer is, answer: what would dropping HERE do, and what
 * rectangle would the dragged editor end up in?
 *
 * The overlay draws `resultRect`, computed by APPLYING the drop to a copy of
 * the tree and laying it out. So the preview is the result, not an
 * approximation of a result — the hated docking systems draw a hint ("it will
 * go roughly over there") and then do something else.
 *
 * Zones, from a window edge INWARD — exactly one answers at a time:
 *
 *   (a) LIST   a rail (its own width + RAIL_REACH_PX into the workspace) or a
 *              region's tab strip: insert into that ordered list at the slot
 *              `solveListInsert` picks. No rect is drawn — the rail/strip
 *              shows the editor as a live badge among its items instead.
 *   (b) DOCK   the side-dock band just inside a window edge,
 *              min(15% of the workspace on that axis, 120px): a new
 *              full-length column/row, previewed as its real rect.
 *   (c) REGION per region (Blender's edge bands, calmer):
 *
 *   ┌───────────────┐   edge band = min(28% of the side, 96px) → split
 *   │      top      │   centre    = add as a tab (or a rail item)
 *   │ l │ centre │ r│   the STAGE's centre floats instead: tabbing the
 *   │    bottom     │   canvas away behind a tab is a trap
 *   └───────────────┘
 *
 * and FLOAT anywhere outside the workspace and its rails.
 *
 * Hysteresis: once a target is chosen it is kept while the pointer stays
 * within its zone grown by `HYSTERESIS_PX`, so a pointer sitting on a zone
 * boundary does not make the overlay flicker between two answers.
 *
 * Min sizes: a split whose result would squeeze ANY region below its editor's
 * minimum is refused, and the solver falls back to the region's centre (add
 * to rail), which never changes geometry. The user is never shown a preview
 * the layout cannot honour.
 */

import { allowsHost, editorMeta, type EditorId } from "./editor-registry";
import { solveListInsert, type ListAxis } from "./list-insert";
import {
  addToRegion,
  minSizeOf,
  insertAtEdge,
  layoutRects,
  regionOf,
  regions,
  splitRegion,
  type Bounds,
  type Edge,
  type Workspace,
} from "./layout-tree";

export type DropTarget =
  | {
      kind: "list";
      /** The list's id (`rail:left`, `strip:<region>`) — which surface draws the badge. */
      list: string;
      /** Slot in the list AS DRAWN without the dragged item (0 … n). */
      slot: number;
      /** The region it joins and its index there; null region = a new one at `edge`. */
      regionId: string | null;
      index: number;
      edge: Edge | null;
    }
  | { kind: "center"; regionId: string }
  | { kind: "split"; regionId: string; edge: Edge }
  | { kind: "window-edge"; edge: Edge; size: number }
  | { kind: "float" }
  | { kind: "none" };

export interface DropSolution {
  target: DropTarget;
  /** Where the dragged editor lands, in the same space as `rect`. */
  resultRect: Bounds | null;
  /** The whole tree after the drop (for a ghost of the neighbours, if wanted). */
  result: Workspace | null;
  /** The zone the pointer is in, grown by hysteresis — internal, pass back as `prev`. */
  zone: Bounds | null;
}

export const EDGE_BAND_FRACTION = 0.28;
export const EDGE_BAND_MAX_PX = 96;
/** The side-dock band: this share of the workspace on that axis … */
export const DOCK_BAND_FRACTION = 0.15;
/** … capped here. */
export const DOCK_BAND_MAX_PX = 120;
/** A rail's band reaches this far past its own edge into the workspace. */
export const RAIL_REACH_PX = 8;
/** A tab torn this far perpendicular out of its own strip leaves it. */
export const TEAR_OUT_PX = 16;
export const HYSTERESIS_PX = 12;
/** A side dock opens at this share of the workspace (`insertAtEdge`'s default). */
export const DOCK_SHARE = 0.22;
/** A new split takes this share of the target. */
export const SPLIT_SHARE = 0.5;

/**
 * An ordered editor list the pointer can insert into: a rail (outside the
 * workspace, along a window edge) or a region's tab strip. The caller
 * measures; `items` are NATURAL rects in order WITHOUT the dragged editor,
 * each with the region it belongs to and its index there (also computed
 * without the dragged editor), so a slot maps straight to `addToRegion`.
 */
export interface DropList {
  id: string;
  kind: "rail" | "strip";
  axis: ListAxis;
  /** The rail's whole rect / the strip's header rect. */
  band: Bounds;
  /** Rails: which window edge (the reach grows inward; an empty rail inserts there). */
  edge: Edge | null;
  /** Strips: the region they switch (an empty strip inserts there). */
  regionId: string | null;
  items: { editor: EditorId; regionId: string; index: number; rect: Bounds }[];
  /** Px the live badge opens along the axis (its length + the list's gap). */
  badge?: number;
}

interface Opts {
  gutter?: number;
  /** Rails and tab strips, measured. */
  lists?: readonly DropList[];
  /**
   * The list the drag started in. Until the pointer has torn out of it
   * (`torn`), a STRIP's band is grown by TEAR_OUT_PX across and a quarter of
   * the dragged tab (`span`) along, so a sort wobbles without tearing.
   */
  source?: { list: string; torn: boolean; span: number } | null;
  /** The previous solution, for hysteresis. */
  prev?: DropSolution | null;
  /** Floating window size used for the float preview. */
  floatSize?: { w: number; h: number };
}

const inside = (p: { x: number; y: number }, r: Bounds) =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

const grow = (r: Bounds, by: number): Bounds => ({ x: r.x - by, y: r.y - by, width: r.width + by * 2, height: r.height + by * 2 });

function sameTarget(a: DropTarget, b: DropTarget): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The geometric zone of a target within its region's rect. */
function zoneRect(target: DropTarget, rect: Bounds, regionRect?: Bounds): Bounds | null {
  if (target.kind === "window-edge") {
    const w = dockBand(rect, target.edge);
    switch (target.edge) {
      case "left": return { x: rect.x, y: rect.y, width: w, height: rect.height };
      case "right": return { x: rect.x + rect.width - w, y: rect.y, width: w, height: rect.height };
      case "top": return { x: rect.x, y: rect.y, width: rect.width, height: w };
      case "bottom": return { x: rect.x, y: rect.y + rect.height - w, width: rect.width, height: w };
    }
  }
  if (!regionRect) return null;
  const bx = Math.min(regionRect.width * EDGE_BAND_FRACTION, EDGE_BAND_MAX_PX);
  const by = Math.min(regionRect.height * EDGE_BAND_FRACTION, EDGE_BAND_MAX_PX);
  const r = regionRect;
  if (target.kind === "center") return { x: r.x + bx, y: r.y + by, width: r.width - 2 * bx, height: r.height - 2 * by };
  if (target.kind === "split") {
    switch (target.edge) {
      case "left": return { x: r.x, y: r.y, width: bx, height: r.height };
      case "right": return { x: r.x + r.width - bx, y: r.y, width: bx, height: r.height };
      case "top": return { x: r.x, y: r.y, width: r.width, height: by };
      case "bottom": return { x: r.x, y: r.y + r.height - by, width: r.width, height: by };
    }
  }
  return null;
}

/** The side-dock band's thickness at a window edge. */
export function dockBand(rect: Bounds, edge: Edge): number {
  const extent = edge === "left" || edge === "right" ? rect.width : rect.height;
  return Math.min(extent * DOCK_BAND_FRACTION, DOCK_BAND_MAX_PX);
}

/** A list's band as the pointer meets it: rail reach inward, a source strip's tear-out slack. */
export function listBand(list: DropList, source?: Opts["source"]): Bounds {
  let b = list.band;
  if (list.kind === "rail" && list.edge) {
    const r = RAIL_REACH_PX;
    if (list.edge === "left") b = { ...b, width: b.width + r };
    else if (list.edge === "right") b = { ...b, x: b.x - r, width: b.width + r };
    else if (list.edge === "bottom") b = { ...b, y: b.y - r, height: b.height + r };
    else b = { ...b, height: b.height + r };
  }
  if (list.kind === "strip" && source && source.list === list.id && !source.torn) {
    const across = TEAR_OUT_PX;
    const along = source.span / 4;
    b =
      list.axis === "x"
        ? { x: b.x - along, y: b.y - across, width: b.width + along * 2, height: b.height + across * 2 }
        : { x: b.x - across, y: b.y - along, width: b.width + across * 2, height: b.height + along * 2 };
  }
  return b;
}

/** The list target for a pointer inside `list`'s band. */
function listTarget(list: DropList, pointer: { x: number; y: number }, prevSlot: number | null): DropTarget {
  const slot = solveListInsert(
    list.items.map((i) => i.rect),
    list.axis,
    pointer,
    prevSlot,
    list.badge ?? 0,
  );
  const n = list.items.length;
  if (n === 0) return { kind: "list", list: list.id, slot: 0, regionId: list.regionId, index: 0, edge: list.edge };
  const at = slot < n ? list.items[slot]! : null;
  const last = list.items[n - 1]!;
  return at
    ? { kind: "list", list: list.id, slot, regionId: at.regionId, index: at.index, edge: list.edge }
    : { kind: "list", list: list.id, slot, regionId: last.regionId, index: last.index + 1, edge: list.edge };
}

/** Apply a target to the workspace (pure). `none` / `float` return null. */
export function applyDrop(ws: Workspace, dragged: EditorId, target: DropTarget): Workspace | null {
  switch (target.kind) {
    case "list":
      if (target.regionId) return addToRegion(ws, target.regionId, dragged, target.index);
      // An empty rail: a new region at that window edge, switched by that rail.
      return target.edge ? insertAtEdge(ws, target.edge, dragged, undefined, target.edge === "top" ? null : target.edge) : null;
    case "center":
      return addToRegion(ws, target.regionId, dragged);
    case "split":
      return splitRegion(ws, target.regionId, target.edge, dragged, SPLIT_SHARE);
    case "window-edge":
      return insertAtEdge(ws, target.edge, dragged, target.size);
    default:
      return null;
  }
}

/** Which region-local zone is the pointer in? Corners resolve to the nearer edge. */
function regionZone(p: { x: number; y: number }, r: Bounds): Edge | "center" {
  const bx = Math.min(r.width * EDGE_BAND_FRACTION, EDGE_BAND_MAX_PX);
  const by = Math.min(r.height * EDGE_BAND_FRACTION, EDGE_BAND_MAX_PX);
  const dl = p.x - r.x;
  const dr = r.x + r.width - p.x;
  const dt = p.y - r.y;
  const db = r.y + r.height - p.y;
  // Normalise by band size so a corner picks the edge the pointer is deeper in.
  const cands: [Edge, number][] = [
    ["left", dl / bx],
    ["right", dr / bx],
    ["top", dt / by],
    ["bottom", db / by],
  ];
  cands.sort((a, b) => a[1] - b[1]);
  const best = cands[0]!;
  return best[1] < 1 ? best[0] : "center";
}

export function solveDrop(
  ws: Workspace,
  rect: Bounds,
  dragged: EditorId,
  pointer: { x: number; y: number },
  opts: Opts = {},
): DropSolution {
  const gutter = opts.gutter ?? 0;
  const none: DropSolution = { target: { kind: "none" }, resultRect: null, result: null, zone: null };
  if (dragged === "stage") return none;

  const lists = opts.lists ?? [];
  const prev = opts.prev;
  // Hysteresis. Inside a list's zone the LIST is kept and only the slot moves
  // (with its own hysteresis); any other target is kept outright.
  if (prev && prev.zone && inside(pointer, prev.zone)) {
    const pt = prev.target;
    if (pt.kind === "list") {
      const list = lists.find((l) => l.id === pt.list);
      if (list) return { ...prev, target: listTarget(list, pointer, pt.slot) };
    } else if (pt.kind !== "none") return prev;
  }

  const float = (): DropSolution => {
    const size = opts.floatSize ?? { w: editorMeta(dragged)?.floatSize.w ?? 320, h: editorMeta(dragged)?.floatSize.h ?? 420 };
    return {
      target: { kind: "float" },
      resultRect: { x: pointer.x - 24, y: pointer.y - 14, width: size.w, height: size.h },
      result: null,
      zone: null,
    };
  };

  // An editor the registry does not allow docked can only float.
  if (!allowsHost(dragged, "docked")) return float();

  // (a) Rails and tab strips — the outermost band, so a drag toward an edge
  //     lands IN the rail rather than in a slot beside it.
  for (const list of lists) {
    const band = listBand(list, opts.source);
    if (!inside(pointer, band)) continue;
    return { target: listTarget(list, pointer, null), resultRect: null, result: null, zone: grow(band, HYSTERESIS_PX) };
  }

  if (!inside(pointer, rect)) return float();

  const rects = layoutRects(ws.root, rect, gutter);
  const finish = (target: DropTarget, zone: Bounds | null): DropSolution | null => {
    const result = applyDrop(ws, dragged, target);
    if (!result) return null;
    if (!dropKeepsMinSizes(ws, result, rect, gutter)) return null;
    const home = regionOf(result, dragged);
    if (!home) return null;
    const resultRect = layoutRects(result.root, rect, gutter).get(home.id) ?? null;
    return { target, resultRect, result, zone: zone ? grow(zone, HYSTERESIS_PX) : null };
  };

  // (b) The side-dock band at each window edge, before the regions whose
  //     own edge bands it overlaps.
  //     The band is AUTHORITATIVE: inside it the answer is a dock or nothing,
  //     never a quiet fall-through to "add a tab" in the region underneath —
  //     two zones that look alike are the patchy feel this replaces. The dock
  //     opens at DOCK_SHARE, or wider when its editor's minimum needs it.
  const edges: Edge[] = ["left", "right", "top", "bottom"];
  for (const edge of edges) {
    const z = zoneRect({ kind: "window-edge", edge, size: DOCK_SHARE }, rect)!;
    if (!inside(pointer, z)) continue;
    const extent = edge === "left" || edge === "right" ? rect.width : rect.height;
    const m = editorMeta(dragged)?.minSize;
    // The gutter comes out of the shared length, so it is part of the minimum.
    const least = m ? ((edge === "left" || edge === "right" ? m.w : m.h) + gutter + 1) / Math.max(1, extent) : DOCK_SHARE;
    const s = finish({ kind: "window-edge", edge, size: Math.max(DOCK_SHARE, least) }, z);
    return s ?? { ...none, zone: grow(z, HYSTERESIS_PX) };
  }

  // (c) The region under the pointer.
  const region = regions(ws.root).find((r) => !r.collapsed && inside(pointer, rects.get(r.id)!));
  if (!region) return float();
  const rr = rects.get(region.id)!;
  const zone = regionZone(pointer, rr);
  const source = regionOf(ws, dragged);

  if (zone === "center") {
    // The stage's centre floats (see header); your own region's centre is
    // "leave it where it is".
    if (region.editors.includes("stage")) return float();
    if (source?.id === region.id) return { ...none, zone: grow(zoneRect({ kind: "center", regionId: region.id }, rect, rr)!, HYSTERESIS_PX) };
    const t: DropTarget = { kind: "center", regionId: region.id };
    return finish(t, zoneRect(t, rect, rr)) ?? none;
  }

  const t: DropTarget = { kind: "split", regionId: region.id, edge: zone };
  const s = finish(t, zoneRect(t, rect, rr));
  if (s) return s;
  // Refused for min sizes → the centre, which never changes geometry.
  if (!region.editors.includes("stage") && source?.id !== region.id) {
    const c: DropTarget = { kind: "center", regionId: region.id };
    return finish(c, zoneRect(t, rect, rr)) ?? none;
  }
  return none;
}

/**
 * A drop may not SHRINK any region below its minimum (and a new region must
 * fit). A region that was already undersized and is untouched does not veto
 * the drop — a small window should still allow moves that cost nothing.
 */
export function dropKeepsMinSizes(before: Workspace, after: Workspace, rect: Bounds, gutter = 0): boolean {
  const was = layoutRects(before.root, rect, gutter);
  const now = layoutRects(after.root, rect, gutter);
  for (const r of regions(after.root)) {
    if (r.collapsed) continue;
    const b = now.get(r.id)!;
    const prev = was.get(r.id);
    const shrank = !prev || b.width < prev.width - 0.5 || b.height < prev.height - 0.5;
    if (!shrank) continue;
    const m = minSizeOf(r);
    if (b.width + 0.5 < m.w || b.height + 0.5 < m.h) return false;
  }
  return true;
}

/** For tests and the overlay: did the target change? */
export function targetChanged(a: DropSolution | null, b: DropSolution): boolean {
  return !a || !sameTarget(a.target, b.target);
}

/**
 * EAT THE NEIGHBOUR — the gutter rule, headless. Dragging a gutter so far
 * that a neighbour would drop below its minimum does not stop the drag at a
 * wall (which reads as stuck) and does not squash the neighbour into an
 * unusable sliver: once the pointer has gone past HALF the neighbour's
 * minimum, the neighbour collapses into its rail strip. Back off and it
 * returns. `lengthPx` is the split's length.
 *
 * Returns the new sizes (fractions) and which child, if any, collapsed.
 */
export function resizeGutter(
  sizes: readonly number[],
  mins: readonly number[],
  gutterIndex: number,
  deltaPx: number,
  lengthPx: number,
): { sizes: number[]; collapsed: number | null } {
  const px = sizes.map((s) => s * lengthPx);
  const a = gutterIndex;
  const b = gutterIndex + 1;
  const minA = mins[a] ?? 0;
  const minB = mins[b] ?? 0;
  const total = (px[a] ?? 0) + (px[b] ?? 0);
  let na = (px[a] ?? 0) + deltaPx;
  let collapsed: number | null = null;
  if (total - na < minB) {
    if (total - na < minB / 2) {
      collapsed = b;
      na = total;
    } else na = total - minB;
  }
  if (na < minA) {
    if (na < minA / 2) {
      collapsed = a;
      na = 0;
    } else na = minA;
  }
  px[a] = na;
  px[b] = total - na;
  return { sizes: px.map((p) => p / lengthPx), collapsed };
}
