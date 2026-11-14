/**
 * THE LAYOUT TREE (README D3) — where every editor lives, as data.
 *
 *   Workspace = { root, floating, windows }
 *   Node      = Split { axis, children: { node, size }[] } | Region
 *   Region    = { id, editors, active, rail, collapsed }
 *
 * Every operation here is PURE: it takes a workspace and returns a new one,
 * already normalised. The shell renders the tree; the drop solver applies an
 * operation to a copy to compute what the preview should draw; tests measure
 * outcomes. Nothing in this file knows about React, the DOM or the stores.
 *
 * Invariants `normalise` restores after every op (and on load):
 *   • no empty regions, no single-child splits, no same-axis split nested in
 *     a same-axis split (they flatten), sizes are positive fractions summing 1;
 *   • every editor appears at most once across docked, floating and windows;
 *   • there is always exactly one stage, docked. A tree that lost it gets it
 *     back as the largest region rather than as an error.
 *
 * ONE MODEL, TWO PRESENTATIONS. A region is an ordered list of editors plus
 * the active one. `rail` says how that list is drawn: as a window-edge RAIL
 * (`left` / `right` / `bottom`, outside the region, so it survives the region
 * collapsing) or, when null, as a TAB STRIP in the region's own header —
 * every tab named, like Photoshop, After Effects and Blender. Sorting,
 * inserting and tearing out are the same operations on either
 * (`list-insert.ts`, `addToRegion` with an index).
 */

import { EDITORS, LEFT_DEFAULT, editorMeta, isEditorId, type EditorId } from "./editor-registry";

export type Axis = "row" | "column";
export type Edge = "left" | "right" | "top" | "bottom";

export interface RegionNode {
  kind: "region";
  id: string;
  editors: EditorId[];
  active: EditorId;
  /** Presentation: the window-edge rail that switches this region; null = its own tab strip. */
  rail: Edge | null;
  /** Collapsed into its rail strip (the region keeps its slot and editors). */
  collapsed?: boolean;
}

export interface SplitChild {
  node: LayoutNode;
  /** Fraction of the split's length, (0, 1]. Siblings sum to 1. */
  size: number;
}

export interface SplitNode {
  kind: "split";
  id: string;
  /** `row` lays children left → right, `column` top → bottom. */
  axis: Axis;
  children: SplitChild[];
}

export type LayoutNode = SplitNode | RegionNode;

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a detached editor returns to (README D4: HOME memory). */
export interface HomeRef {
  regionId: string;
  index: number;
  /** If the region is gone by then: the window edge it sat nearest. */
  edge: Edge;
}

export interface FloatingWin {
  editor: EditorId;
  bounds: Bounds;
  home: HomeRef;
  minimized?: boolean;
}

export interface OsWin {
  editor: EditorId;
  bounds: Bounds;
  home: HomeRef;
}

export interface Workspace {
  version: 1;
  root: LayoutNode;
  floating: FloatingWin[];
  windows: OsWin[];
  /** Region shown alone over the whole workspace (⌃Space). Not persisted. */
  maximised?: string | null;
}

// ─────────────────────────────────────────────────────────────── ids

let seq = 0;
/** Fresh node ids. Deterministic within a run (tests), unique across a tree. */
export function freshId(prefix: string, ws?: Workspace): string {
  const taken = ws ? new Set(allNodes(ws.root).map((n) => n.id)) : null;
  for (;;) {
    const id = `${prefix}-${(++seq).toString(36)}`;
    if (!taken?.has(id)) return id;
  }
}

/** Test hook: reset the id sequence. */
export function _resetIds(): void {
  seq = 0;
}

// ─────────────────────────────────────────────────────────────── queries

export function allNodes(node: LayoutNode): LayoutNode[] {
  if (node.kind === "region") return [node];
  return [node, ...node.children.flatMap((c) => allNodes(c.node))];
}

export function regions(node: LayoutNode): RegionNode[] {
  return allNodes(node).filter((n): n is RegionNode => n.kind === "region");
}

export function findNode(node: LayoutNode, id: string): LayoutNode | undefined {
  return allNodes(node).find((n) => n.id === id);
}

export function findRegion(ws: Workspace, id: string): RegionNode | undefined {
  const n = findNode(ws.root, id);
  return n?.kind === "region" ? n : undefined;
}

export function regionOf(ws: Workspace, editor: EditorId): RegionNode | undefined {
  return regions(ws.root).find((r) => r.editors.includes(editor));
}

/** The stage's region — there is always one after `normalise`. */
export function stageRegion(ws: Workspace): RegionNode {
  return regionOf(ws, "stage")!;
}

/** Where an editor is right now. */
export function hostOf(ws: Workspace, editor: EditorId): "docked" | "floating" | "window" | null {
  if (regionOf(ws, editor)) return "docked";
  if (ws.floating.some((f) => f.editor === editor)) return "floating";
  if (ws.windows.some((w) => w.editor === editor)) return "window";
  return null;
}

/** Parent split + index of a node, or null for the root. */
export function parentOf(root: LayoutNode, id: string): { split: SplitNode; index: number } | null {
  for (const n of allNodes(root)) {
    if (n.kind !== "split") continue;
    const index = n.children.findIndex((c) => c.node.id === id);
    if (index >= 0) return { split: n, index };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────── geometry

/**
 * Lay the tree out in a rect. `gutter` is the px between siblings — the shell
 * reserves it for the resize handle, and react-resizable-panels shares the
 * REMAINING length by the size fractions, which is exactly this. Getting that
 * right is what makes the drop preview land on the pixels the drop produces.
 */
export function layoutRects(root: LayoutNode, rect: Bounds, gutter = 0): Map<string, Bounds> {
  const out = new Map<string, Bounds>();
  const walk = (node: LayoutNode, r: Bounds) => {
    out.set(node.id, r);
    if (node.kind === "region") return;
    const horizontal = node.axis === "row";
    const total = (horizontal ? r.width : r.height) - gutter * (node.children.length - 1);
    let at = horizontal ? r.x : r.y;
    node.children.forEach((c, i) => {
      // The last child takes the remainder, so rounding never opens a seam.
      const len = i === node.children.length - 1 ? (horizontal ? r.x + r.width : r.y + r.height) - at : total * c.size;
      walk(
        c.node,
        horizontal ? { x: at, y: r.y, width: len, height: r.height } : { x: r.x, y: at, width: r.width, height: len },
      );
      at += len + gutter;
    });
  };
  walk(root, rect);
  return out;
}

/** The smallest box a node can be laid out in (sums along its axis). */
export function minSizeOf(node: LayoutNode, gutter = 0): { w: number; h: number } {
  if (node.kind === "region") {
    if (node.collapsed) return { w: 0, h: 0 };
    let w = 0;
    let h = 0;
    // A region must fit its ACTIVE editor; the others can wait to be shown.
    const m = editorMeta(node.active)?.minSize;
    if (m) {
      w = m.w;
      h = m.h;
    }
    return { w, h };
  }
  const kids = node.children.map((c) => minSizeOf(c.node, gutter));
  const g = gutter * (kids.length - 1);
  return node.axis === "row"
    ? { w: kids.reduce((a, k) => a + k.w, 0) + g, h: Math.max(0, ...kids.map((k) => k.h)) }
    : { w: Math.max(0, ...kids.map((k) => k.w)), h: kids.reduce((a, k) => a + k.h, 0) + g };
}

/** Does every region in the tree get at least its minimum in this rect? */
export function fitsMinSizes(root: LayoutNode, rect: Bounds, gutter = 0): boolean {
  const rects = layoutRects(root, rect, gutter);
  for (const r of regions(root)) {
    if (r.collapsed) continue;
    const b = rects.get(r.id)!;
    const m = minSizeOf(r);
    // Half a pixel of slack for float rounding.
    if (b.width + 0.5 < m.w || b.height + 0.5 < m.h) return false;
  }
  return true;
}

/**
 * The window edge a region belongs to — the HOME fallback when it is gone.
 * A region narrower than most of the window is a COLUMN, so it belongs to
 * the left or right; only a full-width band belongs to the top or bottom.
 * (Plain nearest-edge sent a column beside the canvas home as a full-width
 * row, because the top of the window happened to be closer.)
 */
export function nearestEdge(rect: Bounds, of: Bounds): Edge {
  const cx = (of.x + of.width / 2 - rect.x) / rect.width;
  const cy = (of.y + of.height / 2 - rect.y) / rect.height;
  if (of.width < rect.width * 0.6) return cx < 0.5 ? "left" : "right";
  return cy < 0.5 ? "top" : "bottom";
}

// ─────────────────────────────────────────────────────────────── normalise

function cloneNode(n: LayoutNode): LayoutNode {
  return n.kind === "region"
    ? { ...n, editors: [...n.editors] }
    : { ...n, children: n.children.map((c) => ({ node: cloneNode(c.node), size: c.size })) };
}

export function cloneWorkspace(ws: Workspace): Workspace {
  return {
    ...ws,
    root: cloneNode(ws.root),
    floating: ws.floating.map((f) => ({ ...f, bounds: { ...f.bounds }, home: { ...f.home } })),
    windows: ws.windows.map((w) => ({ ...w, bounds: { ...w.bounds }, home: { ...w.home } })),
  };
}

function normaliseNode(node: LayoutNode, seen: Set<EditorId>): LayoutNode | null {
  if (node.kind === "region") {
    const editors: EditorId[] = [];
    for (const e of node.editors) {
      if (!isEditorId(e) || seen.has(e)) continue;
      seen.add(e);
      editors.push(e);
    }
    if (editors.length === 0) return null;
    const active = editors.includes(node.active) ? node.active : editors[0]!;
    // PRESENTATION: `rail` names the window-edge rail that switches this
    // region, null = its own tab strip. There is no top rail, so a region
    // claiming one would have no way to switch it — it gets a strip.
    const rail = node.rail === "left" || node.rail === "right" || node.rail === "bottom" ? node.rail : null;
    const out: RegionNode = { kind: "region", id: node.id, editors, active, rail };
    if (node.collapsed && !editors.includes("stage")) out.collapsed = true;
    return out;
  }
  const kids: SplitChild[] = [];
  for (const c of node.children) {
    const n = normaliseNode(c.node, seen);
    if (!n) continue;
    const size = Number.isFinite(c.size) && c.size > 0 ? c.size : 0;
    // Flatten a same-axis child split into this one, scaling its sizes.
    if (n.kind === "split" && n.axis === node.axis) {
      for (const g of n.children) kids.push({ node: g.node, size: g.size * size });
    } else kids.push({ node: n, size });
  }
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0]!.node;
  const sum = kids.reduce((a, k) => a + k.size, 0);
  const sized = sum > 0 ? kids.map((k) => ({ node: k.node, size: k.size > 0 ? k.size / sum : 0 })) : kids;
  // A zero-size child (bad data) gets an equal share instead of vanishing.
  const zeros = sized.filter((k) => !(k.size > 0)).length;
  const fixed =
    zeros > 0
      ? (() => {
          const share = 1 / sized.length;
          const scale = 1 - share * zeros;
          return sized.map((k) => ({ node: k.node, size: k.size > 0 ? k.size * scale : share }));
        })()
      : sized;
  return { kind: "split", id: node.id, axis: node.axis, children: fixed };
}

/**
 * Restore every invariant. Idempotent. Also the loader's validator: anything
 * unknown (an editor removed from the registry, a duplicate) is dropped, and
 * a missing stage is put back rather than leaving a workspace with no canvas.
 */
export function normalise(ws: Workspace): Workspace {
  const seen = new Set<EditorId>();
  // The stage claims itself first, so a stray stage in a floating list (bad
  // data) can never steal it from the docked tree.
  let root = normaliseNode(ws.root, seen);
  const floating: FloatingWin[] = [];
  for (const f of ws.floating ?? []) {
    if (!isEditorId(f.editor) || seen.has(f.editor) || f.editor === "stage") continue;
    seen.add(f.editor);
    floating.push(f);
  }
  const windows: OsWin[] = [];
  for (const w of ws.windows ?? []) {
    if (!isEditorId(w.editor) || seen.has(w.editor) || w.editor === "stage") continue;
    seen.add(w.editor);
    windows.push(w);
  }
  if (!root || !seen.has("stage")) {
    const stage: RegionNode = { kind: "region", id: "stage", editors: ["stage"], active: "stage", rail: null };
    root = root
      ? { kind: "split", id: "root-stage", axis: "row", children: [{ node: root, size: 0.3 }, { node: stage, size: 0.7 }] }
      : stage;
    root = normaliseNode(root, new Set()) ?? stage;
  }
  // The stage never collapses (normaliseNode drops the flag on its region).
  const maximised = ws.maximised && findNode(root, ws.maximised)?.kind === "region" ? ws.maximised : null;
  return { version: 1, root, floating, windows, maximised };
}

// ─────────────────────────────────────────────────────────────── ops

function mapNode(node: LayoutNode, id: string, fn: (n: LayoutNode) => LayoutNode): LayoutNode {
  if (node.id === id) return fn(node);
  if (node.kind === "region") return node;
  return { ...node, children: node.children.map((c) => ({ node: mapNode(c.node, id, fn), size: c.size })) };
}

function updateRegion(ws: Workspace, id: string, fn: (r: RegionNode) => RegionNode): Workspace {
  return normalise({ ...ws, root: mapNode(ws.root, id, (n) => (n.kind === "region" ? fn(n) : n)) });
}

/**
 * Take an editor out of wherever it is (docked, floating, window). The stage
 * is never removed — callers that move it pass `allowStage` and put it back.
 */
export function detachEditor(ws: Workspace, editor: EditorId, allowStage = false): Workspace {
  if (editor === "stage" && !allowStage) return ws;
  const strip = (n: LayoutNode): LayoutNode =>
    n.kind === "region"
      ? { ...n, editors: n.editors.filter((e) => e !== editor) }
      : { ...n, children: n.children.map((c) => ({ node: strip(c.node), size: c.size })) };
  const out: Workspace = {
    ...ws,
    root: strip(ws.root),
    floating: ws.floating.filter((f) => f.editor !== editor),
    windows: ws.windows.filter((w) => w.editor !== editor),
  };
  // Stage removal is mid-move: skip normalise's "put the stage back".
  return allowStage ? out : normalise(out);
}

/** Close an editor. Same as detach — the stage refuses. */
export function closeEditor(ws: Workspace, editor: EditorId): Workspace {
  if (!editorMeta(editor)?.closable) return ws;
  return detachEditor(ws, editor);
}

/** Show an editor in a region (its rail), making it active. Moves it if it lived elsewhere. */
export function addToRegion(ws: Workspace, regionId: string, editor: EditorId, index?: number): Workspace {
  if (!findRegion(ws, regionId)) return ws;
  const moved = detachEditor(ws, editor, editor === "stage");
  // The target region may have been the editor's only home and collapsed away.
  if (!findRegion(moved, regionId)) return ws;
  const out = {
    ...moved,
    root: mapNode(moved.root, regionId, (n) => {
      if (n.kind !== "region") return n;
      const editors = [...n.editors];
      const at = index === undefined ? editors.length : Math.max(0, Math.min(index, editors.length));
      editors.splice(at, 0, editor);
      return { ...n, editors, active: editor, collapsed: false };
    }),
  };
  return normalise(out);
}

export function setActive(ws: Workspace, regionId: string, editor: EditorId): Workspace {
  return updateRegion(ws, regionId, (r) => (r.editors.includes(editor) ? { ...r, active: editor } : r));
}

/** Replace the region's active editor IN PLACE (the editor switcher). */
export function changeEditor(ws: Workspace, regionId: string, editor: EditorId): Workspace {
  const region = findRegion(ws, regionId);
  if (!region) return ws;
  if (region.editors.includes(editor)) return setActive(ws, regionId, editor);
  // The stage cannot be switched away from — that would close the canvas.
  if (region.active === "stage") return addToRegion(ws, regionId, editor);
  const at = region.editors.indexOf(region.active);
  const replaced = region.active;
  let next = addToRegion(ws, regionId, editor, at);
  // The editor it replaced leaves the region (Blender semantics) unless it is
  // the only copy of something the user would lose; it simply closes.
  if (findRegion(next, regionId)) next = detachEditor(next, replaced);
  return next;
}

export function setCollapsed(ws: Workspace, regionId: string, collapsed: boolean): Workspace {
  return updateRegion(ws, regionId, (r) => ({ ...r, collapsed: collapsed || undefined }));
}

export function setMaximised(ws: Workspace, regionId: string | null): Workspace {
  return normalise({ ...ws, maximised: regionId });
}

/** Write a split's sizes (the resize handles). Renormalised. */
export function setSizes(ws: Workspace, splitId: string, sizes: number[]): Workspace {
  return normalise({
    ...ws,
    root: mapNode(ws.root, splitId, (n) =>
      n.kind === "split" && sizes.length === n.children.length
        ? { ...n, children: n.children.map((c, i) => ({ node: c.node, size: sizes[i] ?? c.size })) }
        : n,
    ),
  });
}

const AXIS_OF: Record<Edge, Axis> = { left: "row", right: "row", top: "column", bottom: "column" };
const BEFORE: Record<Edge, boolean> = { left: true, top: true, right: false, bottom: false };

/**
 * Split a region: the editor gets a NEW region on `edge` of `regionId`,
 * `size` of the target's length (default half).
 */
export function splitRegion(
  ws: Workspace,
  regionId: string,
  edge: Edge,
  editor: EditorId,
  size = 0.5,
): Workspace {
  if (!findRegion(ws, regionId)) return ws;
  const source = regionOf(ws, editor);
  // Splitting a lone editor off itself is a no-op, not a reshuffle.
  if (source?.id === regionId && source.editors.length === 1) return ws;
  const moved = detachEditor(ws, editor);
  const target = findRegion(moved, regionId);
  if (!target) return ws;
  const fresh: RegionNode = { kind: "region", id: freshId("region", moved), editors: [editor], active: editor, rail: null };
  const axis = AXIS_OF[edge];
  const s = Math.min(0.85, Math.max(0.15, size));
  const pair: SplitChild[] = BEFORE[edge]
    ? [{ node: fresh, size: s }, { node: target, size: 1 - s }]
    : [{ node: target, size: 1 - s }, { node: fresh, size: s }];
  const parent = parentOf(moved.root, regionId);
  let root: LayoutNode;
  if (parent && parent.split.axis === axis) {
    // Same axis as the parent: become a SIBLING sharing the target's slot,
    // rather than a nested split (normalise would flatten it anyway; doing it
    // here keeps the target's neighbours' sizes untouched).
    root = mapNode(moved.root, parent.split.id, (n) => {
      if (n.kind !== "split") return n;
      const children = [...n.children];
      const slot = children[parent.index]!.size;
      children.splice(parent.index, 1, ...pair.map((p) => ({ node: p.node, size: p.size * slot })));
      return { ...n, children };
    });
  } else {
    root = mapNode(moved.root, regionId, () => ({ kind: "split", id: freshId("split", moved), axis, children: pair }));
  }
  return normalise({ ...moved, root });
}

/**
 * A new column/row along a WINDOW edge — the whole height/width of the
 * workspace. `rail` presents it as that edge's rail instead of a tab strip
 * (dropping into an empty rail).
 */
export function insertAtEdge(ws: Workspace, edge: Edge, editor: EditorId, size = 0.22, rail: Edge | null = null): Workspace {
  const moved = detachEditor(ws, editor);
  const fresh: RegionNode = { kind: "region", id: freshId("region", moved), editors: [editor], active: editor, rail };
  const axis = AXIS_OF[edge];
  const s = Math.min(0.6, Math.max(0.1, size));
  const root = moved.root;
  let next: LayoutNode;
  if (root.kind === "split" && root.axis === axis) {
    // The STAGE pays for the new dock; every other column keeps its width.
    const children = takeFromStage(root.children, s, axis) ?? root.children.map((c) => ({ node: c.node, size: c.size * (1 - s) }));
    next = {
      ...root,
      children: BEFORE[edge] ? [{ node: fresh, size: s }, ...children] : [...children, { node: fresh, size: s }],
    };
  } else {
    const kept = keepAlong(root, axis, 1 - s);
    next = {
      kind: "split",
      id: freshId("split", moved),
      axis,
      children: BEFORE[edge] ? [{ node: fresh, size: s }, { node: kept, size: 1 - s }] : [{ node: kept, size: 1 - s }, { node: fresh, size: s }],
    };
  }
  return normalise({ ...moved, root: next });
}

const holdsStage = (n: LayoutNode): boolean => (n.kind === "region" ? n.editors.includes("stage") : n.children.some((c) => holdsStage(c.node)));

/**
 * Give `share` of a split's length to a newcomer by taking it from the child
 * that holds the stage, so the side panels keep their pixel widths — docking
 * a panel shrinks the canvas, as in every pro app, instead of squeezing every
 * column (which pushed Layers under its minimum and refused the dock). Null if
 * the stage cannot afford it; the caller then shares proportionally.
 */
function takeFromStage(children: readonly SplitChild[], share: number, axis: Axis): SplitChild[] | null {
  const i = children.findIndex((c) => holdsStage(c.node));
  if (i < 0 || children[i]!.size - share < 0.1) return null;
  const f = children[i]!.size;
  // The stage's child shrinks; inside it, only the stage pays again.
  return children.map((c, k) => (k === i ? { node: keepAlong(c.node, axis, (f - share) / f), size: f - share } : c));
}

/**
 * The tree shrinks to `factor` of its length along `axis`; keep every
 * non-stage child's PIXEL length on that axis and let the stage absorb it.
 */
function keepAlong(node: LayoutNode, axis: Axis, factor: number): LayoutNode {
  if (node.kind === "region") return node;
  if (node.axis !== axis) return { ...node, children: node.children.map((c) => ({ node: keepAlong(c.node, axis, factor), size: c.size })) };
  const i = node.children.findIndex((c) => holdsStage(c.node));
  if (i < 0) return node;
  const others = node.children.reduce((a, c, k) => (k === i ? a : a + c.size / factor), 0);
  if (1 - others < 0.1) return node;
  return {
    ...node,
    children: node.children.map((c, k) => ({
      node: k === i ? keepAlong(c.node, axis, factor) : c.node,
      size: k === i ? 1 - others : c.size / factor,
    })),
  };
}

/** Merge region `b` into `a` (Blender's join): b's editors join a's rail. */
export function joinRegions(ws: Workspace, a: string, b: string): Workspace {
  const ra = findRegion(ws, a);
  const rb = findRegion(ws, b);
  if (!ra || !rb || a === b) return ws;
  const out = {
    ...ws,
    root: mapNode(
      mapNode(ws.root, a, (n) => (n.kind === "region" ? { ...n, editors: [...n.editors, ...rb.editors] } : n)),
      b,
      (n) => (n.kind === "region" ? { ...n, editors: [] } : n),
    ),
  };
  return normalise(out);
}

// ─────────────────────────────────────────────────────────────── hosts

/** Remember where an editor lives, for the trip back from a detached host. */
export function homeOf(ws: Workspace, editor: EditorId, rect: Bounds): HomeRef {
  const r = regionOf(ws, editor);
  if (!r) return { regionId: "left", index: 0, edge: "left" };
  const rects = layoutRects(ws.root, rect);
  return { regionId: r.id, index: r.editors.indexOf(editor), edge: nearestEdge(rect, rects.get(r.id)!) };
}

export function floatEditor(ws: Workspace, editor: EditorId, bounds: Bounds, rect: Bounds): Workspace {
  if (editor === "stage") return ws;
  const existing = ws.floating.find((f) => f.editor === editor);
  if (existing) return ws;
  const home = regionOf(ws, editor) ? homeOf(ws, editor, rect) : ws.windows.find((w) => w.editor === editor)?.home ?? homeOf(ws, editor, rect);
  const moved = detachEditor(ws, editor);
  return normalise({ ...moved, floating: [...moved.floating, { editor, bounds, home }] });
}

export function windowEditor(ws: Workspace, editor: EditorId, bounds: Bounds, rect: Bounds): Workspace {
  if (editor === "stage") return ws;
  if (ws.windows.some((w) => w.editor === editor)) return ws;
  const home = regionOf(ws, editor) ? homeOf(ws, editor, rect) : ws.floating.find((f) => f.editor === editor)?.home ?? homeOf(ws, editor, rect);
  const moved = detachEditor(ws, editor);
  return normalise({ ...moved, windows: [...moved.windows, { editor, bounds, home }] });
}

/**
 * Return a detached editor HOME: its old region at its old index if that
 * region still exists, else a new region on the edge it sat nearest. Closing
 * a floating or OS window lands here, never "gone".
 */
export function returnHome(ws: Workspace, editor: EditorId): Workspace {
  const home = ws.floating.find((f) => f.editor === editor)?.home ?? ws.windows.find((w) => w.editor === editor)?.home;
  if (!home) return ws;
  if (findRegion(ws, home.regionId)) return addToRegion(ws, home.regionId, editor, home.index);
  return insertAtEdge(ws, home.edge, editor);
}

export function setFloatingBounds(ws: Workspace, editor: EditorId, patch: Partial<Bounds>): Workspace {
  return {
    ...ws,
    floating: ws.floating.map((f) => (f.editor === editor ? { ...f, bounds: { ...f.bounds, ...patch } } : f)),
  };
}

// ─────────────────────────────────────────────────────────────── defaults + migration

/**
 * TODAY'S LAYOUT, as a tree. Node ids are the ids the shell's resizable
 * groups and panels have always used ("tm-vertical", "tm-horizontal", "left",
 * "stage", "inspector", "timeline") — that is what makes the first load of the
 * new shell PIXEL-IDENTICAL: react-resizable-panels finds the sizes it saved
 * under those exact keys and restores them.
 *
 * The sizes are the old `defaultSize`s (17/61/24 — which summed to 102, and
 * the library normalised them; so do we).
 */
export function defaultWorkspace(): Workspace {
  return normalise({
    version: 1,
    root: {
      kind: "split",
      id: "tm-vertical",
      axis: "column",
      children: [
        {
          size: 0.68,
          node: {
            kind: "split",
            id: "tm-horizontal",
            axis: "row",
            children: [
              { size: 0.17, node: { kind: "region", id: "left", editors: [...LEFT_DEFAULT], active: "layers", rail: "left" } },
              { size: 0.61, node: { kind: "region", id: "stage", editors: ["stage"], active: "stage", rail: null } },
              { size: 0.24, node: { kind: "region", id: "inspector", editors: ["inspector"], active: "inspector", rail: "right" } },
            ],
          },
        },
        {
          size: 0.32,
          node: {
            kind: "region",
            id: "timeline",
            editors: ["timeline", "keys", "curves", "color", "nodes", "mixer"],
            active: "timeline",
            rail: "bottom",
          },
        },
      ],
    },
    floating: [],
    windows: [],
  });
}

/** What the old shell persisted, read leniently. */
export interface LegacyFlags {
  /** `session.leftTab` — which left surface showed. */
  leftTab?: string;
  /** Panels popped out into sticky windows (`useFloatingPanels`). */
  floating?: { panelId: string; x: number; y: number; width: number; height: number; minimized?: boolean }[];
  /** react-resizable-panels' saved layouts, if the caller read them. */
  vertical?: number[];
  horizontal?: number[];
}

/**
 * Migrate an existing user. Visibility flags (left/inspector/timeline/mixer)
 * are NOT migrated into the tree: they stay the visibility layer
 * (`resolvePanel` — density, workspace memory, focus mode), which is exactly
 * what keeps a phone from ever rewriting the desktop tree. The tree takes
 * structure only: which editor shows in the left region, which panels float,
 * and the saved split sizes.
 */
export function migrateFromLegacy(flags: LegacyFlags): Workspace {
  let ws = defaultWorkspace();
  if (flags.leftTab && isEditorId(flags.leftTab) && regionOf(ws, flags.leftTab)?.id === "left") {
    ws = setActive(ws, "left", flags.leftTab);
  }
  if (flags.vertical?.length === 2) ws = setSizes(ws, "tm-vertical", flags.vertical.map((v) => v / 100));
  if (flags.horizontal?.length === 3) ws = setSizes(ws, "tm-horizontal", flags.horizontal.map((v) => v / 100));
  for (const f of flags.floating ?? []) {
    if (!isEditorId(f.panelId)) continue;
    const r = regionOf(ws, f.panelId);
    const home: HomeRef = { regionId: r?.id ?? "left", index: r ? r.editors.indexOf(f.panelId) : 0, edge: r?.rail ?? "left" };
    const moved = detachEditor(ws, f.panelId);
    ws = normalise({
      ...moved,
      floating: [...moved.floating, { editor: f.panelId, bounds: { x: f.x, y: f.y, width: f.width, height: f.height }, home, minimized: f.minimized }],
    });
  }
  return ws;
}

// ─────────────────────────────────────────────────────────────── serialise

export function serialise(ws: Workspace): string {
  const { maximised: _m, ...rest } = ws;
  return JSON.stringify(rest);
}

/** Parse + validate. Anything unreadable becomes the default layout. */
export function parseWorkspace(raw: string | null | undefined): Workspace | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<Workspace>;
    if (!data || data.version !== 1 || !data.root) return null;
    if (!validNode(data.root)) return null;
    return normalise({
      version: 1,
      root: data.root,
      floating: Array.isArray(data.floating) ? data.floating.filter(validWin) : [],
      windows: Array.isArray(data.windows) ? data.windows.filter(validWin) : [],
    });
  } catch {
    return null;
  }
}

function validNode(n: unknown): n is LayoutNode {
  if (!n || typeof n !== "object") return false;
  const node = n as LayoutNode;
  if (typeof node.id !== "string") return false;
  if (node.kind === "region") return Array.isArray(node.editors);
  if (node.kind === "split")
    return (node.axis === "row" || node.axis === "column") && Array.isArray(node.children) && node.children.every((c) => c && validNode(c.node));
  return false;
}

function validWin(w: unknown): w is FloatingWin {
  const f = w as FloatingWin;
  return !!f && isEditorId(f.editor) && !!f.bounds && typeof f.bounds.x === "number" && !!f.home;
}

/** Every editor the tree hosts (docked), in tree order. */
export function dockedEditors(ws: Workspace): EditorId[] {
  return regions(ws.root).flatMap((r) => r.editors);
}

/** Editors not shown anywhere — what "Add editor" offers. */
export function absentEditors(ws: Workspace): EditorId[] {
  const shown = new Set<EditorId>([...dockedEditors(ws), ...ws.floating.map((f) => f.editor), ...ws.windows.map((w) => w.editor)]);
  return EDITORS.map((e) => e.id).filter((id) => !shown.has(id));
}
