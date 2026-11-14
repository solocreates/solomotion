import type { MotionDocument, Clip } from "../schema";
import { clipEnd } from "./ops";
import { frameLayerTree, permuteLanes, treeLaneOrder, type LayerTreeNode } from "./layer-tree";

/**
 * SORTING THE STACK — reordering a comp's layers by something other than the
 * order you happened to build them in.
 *
 * ## It sorts the TREE, not the lanes
 *
 * The naive version sorts `doc.tracks` and is wrong in a way that destroys
 * work: a group's members are the lanes beneath it, so any comparator that does
 * not know about groups scatters them, and a mask ends up with its stencil six
 * layers away from the thing it was cutting. There is no undo-free way back
 * from that.
 *
 * So the unit of sorting is a TREE NODE. Siblings are ordered among themselves
 * at every depth, a group travels whole with everything it holds, and the lane
 * order is then REBUILT from the sorted tree. A group's internals sort too, in
 * the same pass, because a group is just another list of siblings — which is
 * what makes "sort by name" do the obvious thing on a document nested five
 * deep instead of only at the top.
 *
 * ## It writes lane order, so every surface follows
 *
 * z IS lane order in this document model, so there is nothing else to update:
 * sorting rewrites `doc.tracks` and the timeline, the layers list, the renderer
 * and the exporter all read the new stack from the same place. The layers list
 * does not need to be told, and cannot disagree.
 *
 * The rewrite is a PERMUTATION of the positions this comp already occupied, so
 * lanes belonging to other comps never move. Tracks are document-global — a
 * lane can carry clips from several comps — and a sort that repacked the whole
 * array would silently restack every other comp in the project.
 *
 * ## It is an ACTION, not a view mode
 *
 * Sorting commits, once, to the undo stack. A persistent "sorted view" would be
 * a second source of truth for z-order, which the renderer would then have to
 * consult — and a document whose paint order depends on a UI toggle is a
 * document you cannot share. Sort, look, undo if you hate it.
 */

/** What to sort by. */
export type LayerSortKey = "name" | "kind" | "start" | "end" | "duration";

/** UI-facing metadata, in menu order — the single list every surface renders. */
export const LAYER_SORT_KEYS: ReadonlyArray<{
  key: LayerSortKey;
  label: string;
  /** What ascending means, in the user's words — the menu's secondary line. */
  ascLabel: string;
  descLabel: string;
}> = [
  { key: "name", label: "Name", ascLabel: "A → Z", descLabel: "Z → A" },
  { key: "kind", label: "Type", ascLabel: "A → Z", descLabel: "Z → A" },
  { key: "start", label: "Start time", ascLabel: "Earliest first", descLabel: "Latest first" },
  { key: "end", label: "End time", ascLabel: "Earliest first", descLabel: "Latest first" },
  { key: "duration", label: "Duration", ascLabel: "Shortest first", descLabel: "Longest first" },
];

export type SortDirection = "asc" | "desc";

/** A layer's name as the list shows it — the clip's own, else its kind. */
function displayName(clip: Clip): string {
  return (clip.name || clip.kind).toLocaleLowerCase();
}

/**
 * A node's sort value. A GROUP answers for the whole subtree it carries — its
 * earliest start, its latest end, its longest span — because a group IS one
 * layer at the level it sits on, and comparing it by the span of its own bar
 * would sort it by a value the user never sees.
 */
function sortValue(node: LayerTreeNode, key: LayerSortKey): number | string {
  if (node.type === "clip") {
    const c = node.clip;
    switch (key) {
      case "name":
        return displayName(c);
      case "kind":
        return c.kind;
      case "start":
        return c.startMs;
      case "end":
        return clipEnd(c);
      case "duration":
        return c.durationMs;
    }
  }
  if (key === "name") return displayName(node.clip);
  if (key === "kind") return "group";
  const kids = node.children.map((c) => sortValue(c, key));
  const nums = kids.filter((v): v is number => typeof v === "number");
  if (nums.length === 0) return key === "start" ? node.clip.startMs : node.clip.durationMs;
  if (key === "start") return Math.min(...nums);
  return Math.max(...nums);
}

/** Stable ordering of one sibling list. */
function sortSiblings(nodes: LayerTreeNode[], key: LayerSortKey, dir: SortDirection): LayerTreeNode[] {
  const sign = dir === "asc" ? 1 : -1;
  return nodes
    .map((node, i) => ({ node, i, v: sortValue(node, key) }))
    .sort((a, b) => {
      const cmp =
        typeof a.v === "string" && typeof b.v === "string"
          ? a.v.localeCompare(b.v)
          : Number(a.v) - Number(b.v);
      // Stable: equal values keep the order they already had, so sorting twice
      // by the same key never shuffles anything.
      return cmp !== 0 ? cmp * sign : a.i - b.i;
    })
    .map((e) => e.node);
}

/**
 * Sort one comp's layers. Returns true when anything moved, so the caller can
 * skip a no-op undo entry.
 */
export function sortLayers(
  doc: MotionDocument,
  frameId: string,
  key: LayerSortKey,
  direction: SortDirection,
): boolean {
  const tree = frameLayerTree(doc, frameId);
  if (tree.length === 0) return false;

  const before = treeLaneOrder(tree);

  const sortTree = (nodes: LayerTreeNode[]): LayerTreeNode[] =>
    sortSiblings(nodes, key, direction).map((node) =>
      node.type === "group" ? { ...node, children: sortTree(node.children) } : node,
    );

  return permuteLanes(doc, before, treeLaneOrder(sortTree(tree)));
}

/**
 * Flip the whole stack — the one "sort" that needs no key and is exactly what
 * people reach for when a paste landed everything upside down. Groups flip
 * internally too, for the same reason a sort descends: a group is a stack.
 */
export function reverseLayers(doc: MotionDocument, frameId: string): boolean {
  const tree = frameLayerTree(doc, frameId);
  if (tree.length === 0) return false;
  const before = treeLaneOrder(tree);
  const flip = (nodes: LayerTreeNode[]): LayerTreeNode[] =>
    [...nodes].reverse().map((node) => (node.type === "group" ? { ...node, children: flip(node.children) } : node));
  return permuteLanes(doc, before, treeLaneOrder(flip(tree)));
}
