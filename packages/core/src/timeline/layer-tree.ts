import { editScopes } from "../navigation/scope";
import { isSettledDocument } from "./settled";
import { frameClipEntries } from "./frame-index";
import type { MotionDocument, Clip, GroupClip, Track, VisualClip } from "../schema";

/**
 * THE layer tree — one headless description of how a frame's layers nest.
 *
 * Clips live on lanes (`doc.tracks`, z = lane order) and a GROUP is itself a
 * clip on a lane whose interior is the set of lanes that name it
 * (`track.groupId`); this module joins the two into the single recursive
 * structure every surface consumes — the renderer walks it to composite, the
 * layers panel and the timeline walk it to emit rows. What nests in the list
 * is, by construction, what nests on canvas.
 *
 * ORDERING: a group node sits at its own clip's lane, so its z-position is a
 * fact you can point at, and its children sort by THEIR lanes' order among the
 * group's rows. Nothing about a group's rows relates to the lanes around the
 * group: two groups side by side on one lane are siblings at one depth, and a
 * group's rows can sit anywhere in `doc.tracks` — only their order among
 * themselves is read.
 */

export interface ClipLayerNode {
  type: "clip";
  clip: VisualClip;
  /** Index of the clip's track in doc.tracks (0 = topmost z). */
  trackIndex: number;
}

export interface GroupLayerNode {
  type: "group";
  /** The group CLIP — its name, mode, span, transform, paint and effects. */
  clip: GroupClip;
  /** The group's own lane; this IS the group's z-position in its parent. */
  trackIndex: number;
  /** Children top→bottom in z; clip and group nodes interleave freely. */
  children: LayerTreeNode[];
  /** Every descendant LEAF clip id, at all depths — what actually paints. */
  clipIds: string[];
  /**
   * Where a new row of THIS group's interior is spliced into `doc.tracks` to
   * become its first / its last row. A group's rows are z-ordered among
   * themselves by index, so "top of the interior" is just before its first
   * row, and "bottom" just after its last — or straight after the group's own
   * lane when it has no rows yet.
   */
  interiorTop: number;
  interiorEnd: number;
}

export type LayerTreeNode = ClipLayerNode | GroupLayerNode;

/**
 * Build one frame's layer tree, top→bottom in z. Total for ANY lane order: a
 * lane whose group is missing (or is not a group, or would cycle) simply
 * contributes roots, matching `pruneGroups`' healing rule — so a half-applied
 * undo renders as a flat frame rather than as nothing.
 */
export function frameLayerTree(doc: MotionDocument, frameId: string): LayerTreeNode[] {
  // Asked per comp per draw, per nested level, by the renderer — and a build is
  // a scan of every clip in the project. Memoised per FROZEN document (the
  // `scopeIndex` rule); the tree is shared, so callers treat it as read-only
  // (every transform in this codebase maps to new nodes).
  if (!isSettledDocument(doc)) return buildFrameLayerTree(doc, frameId);
  let perDoc = treeMemo.get(doc);
  if (!perDoc) treeMemo.set(doc, (perDoc = new Map()));
  let tree = perDoc.get(frameId);
  if (!tree) perDoc.set(frameId, (tree = buildFrameLayerTree(doc, frameId)));
  return tree;
}

const treeMemo = new WeakMap<MotionDocument, Map<string, LayerTreeNode[]>>();

function buildFrameLayerTree(doc: MotionDocument, frameId: string): LayerTreeNode[] {
  const nodes = new Map<string, LayerTreeNode>();
  const placed: Array<{ node: LayerTreeNode; scope: string | null }> = [];

  // Only this comp's clips, from the per-document index (document order).
  for (const { track, clip, row: trackIndex } of frameClipEntries(doc, frameId)) {
    if (clip.kind === "audio") continue;
    const node: LayerTreeNode =
      clip.kind === "group"
        ? { type: "group", clip, trackIndex, children: [], clipIds: [], interiorTop: trackIndex + 1, interiorEnd: trackIndex + 1 }
        : { type: "clip", clip, trackIndex };
    nodes.set(clip.id, node);
    placed.push({ node, scope: track.groupId });
  }

  // A node's parent is the group its lane names — when that chain actually
  // reaches the top. A lane naming a missing group, a non-group, or a group
  // whose own chain loops back on itself contributes a ROOT instead.
  const scopeOfGroup = new Map<string, string | null>();
  for (const { node, scope } of placed) if (node.type === "group") scopeOfGroup.set(node.clip.id, scope);
  const grounded = (scope: string | null): boolean => {
    const seen = new Set<string>();
    let g = scope;
    while (g) {
      if (seen.has(g) || !scopeOfGroup.has(g)) return false;
      seen.add(g);
      g = scopeOfGroup.get(g) ?? null;
    }
    return true;
  };
  const roots: LayerTreeNode[] = [];
  for (const { node, scope } of placed) {
    const parent = scope && grounded(scope) ? nodes.get(scope) : null;
    (parent && parent.type === "group" ? parent.children : roots).push(node);
  }

  sortByLane(roots);
  finalize(doc, roots);
  return roots;
}

/** Sort every children list top→bottom in z, depth-first. */
function sortByLane(nodes: LayerTreeNode[]): void {
  nodes.sort((a, b) => a.trackIndex - b.trackIndex);
  for (const n of nodes) if (n.type === "group") sortByLane(n.children);
}

/** Fill each group node's descendant clip ids + interior insert points, bottom-up. */
function finalize(doc: MotionDocument, nodes: LayerTreeNode[]): void {
  for (const node of nodes) {
    if (node.type !== "group") continue;
    finalize(doc, node.children);
    for (const child of node.children) {
      if (child.type === "clip") node.clipIds.push(child.clip.id);
      else node.clipIds.push(...child.clipIds);
    }
    let top = Infinity;
    let end = -Infinity;
    doc.tracks.forEach((t, i) => {
      if (t.groupId !== node.clip.id) return;
      top = Math.min(top, i);
      end = Math.max(end, i + 1);
    });
    if (Number.isFinite(top)) {
      node.interiorTop = top;
      node.interiorEnd = end;
    }
  }
}

/* ------------------------------------------------- lane order IS tree order */

/**
 * The lanes a comp's tree occupies, in TREE ORDER — a node's own lane, then
 * everything it holds, depth first.
 */
export function treeLaneOrder(nodes: LayerTreeNode[], out: number[] = [], seen = new Set<number>()): number[] {
  for (const node of nodes) {
    if (!seen.has(node.trackIndex)) {
      seen.add(node.trackIndex);
      out.push(node.trackIndex);
    }
    if (node.type === "group") treeLaneOrder(node.children, out, seen);
  }
  return out;
}

/**
 * Re-seat a set of lanes into a new order, IN THEIR OWN SLOTS.
 *
 * Tracks are document-global — one lane can carry clips from several comps — so
 * a reorder that repacked the array would restack every other comp in the
 * project. This only ever permutes the positions the given lanes already
 * occupied; everything else stays exactly where it was. A lane keeps its scope
 * through the permutation (scope is a fact of the lane, not of its slot), so
 * each scope's rows come out in the new relative order and nothing else
 * changes. Returns true if anything actually moved.
 */
export function permuteLanes(doc: MotionDocument, from: number[], to: number[]): boolean {
  if (from.length !== to.length || from.length === 0) return false;
  const slots = [...from].sort((a, b) => a - b);
  const moved = to.map((i) => doc.tracks[i]!);
  if (slots.every((slot, i) => doc.tracks[slot] === moved[i])) return false;
  slots.forEach((slot, i) => {
    doc.tracks[slot] = moved[i]!;
  });
  return true;
}

/* ------------------------------------------------------- nesting, one level */

/**
 * The layers INSIDE a clip that has an inside — the disclosure triangle's
 * answer. A nested comp is expanded in the layers list exactly the way Figma
 * expands a frame: its own layers, in its own z-order, rendered as children of
 * the row.
 *
 * The panel asks this; it does not decide it. "Does this row expand" is the
 * scope registry's question (`editScopes`), already answered once for
 * double-click, the breadcrumb and isolation — so a `flat` clip stays one
 * opaque layer here too, and a future enterable kind gets a triangle for free.
 *
 * ONE level, lazily: the caller recurses only into rows the user actually
 * opened, which is what keeps a 200-layer icon pack from walking its whole
 * subtree on every render.
 */
export function clipLayerChildren(doc: MotionDocument, clip: Clip): LayerTreeNode[] | null {
  const source = editScopes.resolve(doc, clip)?.sourceFrameId;
  return source ? frameLayerTree(doc, source) : null;
}

/** Does this row get a disclosure triangle? Cheap; no tree is built. */
export function hasLayerChildren(doc: MotionDocument, clip: Clip): boolean {
  const source = editScopes.resolve(doc, clip)?.sourceFrameId;
  if (!source) return false;
  return doc.tracks.some((t) => t.clips.some((c) => c.frameId === source && c.kind !== "audio"));
}

/* ------------------------------------------------------------ rows, in order */

/**
 * Is this top-level track one of the comp's lanes? Tracks are document-global
 * and one can carry several comps' clips, so "yours" means holding any of your
 * clips, or being an EMPTY lane made for you (`homeCompId`). A group's rows
 * need no test — a row holds only its group's comp's clips.
 */
export function isCompLane(track: Track, frameId: string): boolean {
  return track.clips.length === 0 ? track.homeCompId === frameId : track.clips.some((c) => c.frameId === frameId);
}

/** A lane row of the timeline: a track, and the scope it is a row of. */
export interface FrameLaneRow {
  kind: "lane";
  track: Track;
  /** Index into `doc.tracks` — still the z key every other surface uses. */
  index: number;
  /** Tree depth: 0 at the comp's top level, +1 inside each enclosing group. */
  depth: number;
  /** The group whose interior this row is, or null at the top level. */
  scope: GroupClip | null;
}

/**
 * The head of an OPEN group's band: emitted just before the group's rows, so
 * a surface that draws them knows where one group's interior starts and which
 * lane its bar sits on.
 */
export interface FrameGroupRow {
  kind: "group";
  group: GroupClip;
  /** The lane the group's bar sits on (`doc.tracks` index). */
  laneIndex: number;
  /** Depth of the group's own bar; its rows are one deeper. */
  depth: number;
  /** How many rows the band holds (this group's direct rows). */
  rows: number;
}

export type FrameRow = FrameLaneRow | FrameGroupRow;

/**
 * THE row order for one comp's timeline — every lane the comp shows, top to
 * bottom, with each OPEN group's rows spliced in directly beneath the lane its
 * bar sits on, headed by a `group` row.
 *
 * A group's rows are its own: they are emitted under the group, not at their
 * `doc.tracks` index, so the comp's lanes read as the comp's and a group's
 * interior reads as the group's wherever either happens to live in the array.
 * Two open groups on one lane put their bands one after the other, in time
 * order, so what you see beneath a bar is that bar's contents and nothing
 * else's.
 *
 * COLLAPSE is a filter here and nowhere else. A collapsed group keeps its bar
 * and drops its band, which is why collapsing cannot move anything above it —
 * the rows above are emitted before the group is even reached.
 *
 * Which lanes are the comp's: a top-level lane holding any of its clips, an
 * empty top-level lane made for it (`homeCompId`), and every row of a group
 * that is in it — empty rows included, since a row you added inside a group
 * is still there before you fill it.
 */
export function frameRows(
  doc: MotionDocument,
  frameId: string,
  collapsed: ReadonlySet<string> = new Set(),
): FrameRow[] {
  const out: FrameRow[] = [];
  const walk = (scope: GroupClip | null, depth: number): void => {
    const scopeId = scope?.id ?? null;
    doc.tracks.forEach((track, index) => {
      if ((track.groupId ?? null) !== scopeId) return;
      if (!scope && !isCompLane(track, frameId)) return;
      out.push({ kind: "lane", track, index, depth, scope });
      const groups = track.clips
        .filter((c): c is GroupClip => c.kind === "group" && c.frameId === frameId && !collapsed.has(c.id))
        .sort((a, b) => a.startMs - b.startMs);
      for (const g of groups) {
        out.push({ kind: "group", group: g, laneIndex: index, depth, rows: doc.tracks.filter((t) => t.groupId === g.id).length });
        walk(g, depth + 1);
      }
    });
  };
  walk(null, 0);
  return out;
}

/** Just the lane rows of `frameRows`, for the callers that only need tracks. */
export function frameLanes(
  doc: MotionDocument,
  frameId: string,
  collapsed: ReadonlySet<string> = new Set(),
): FrameLaneRow[] {
  return frameRows(doc, frameId, collapsed).filter((r): r is FrameLaneRow => r.kind === "lane");
}
