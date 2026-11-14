import type { GraphNode, NodeGraph } from "../schema";
import { MAIN_SOCKET_KEY } from "./projection";

/**
 * A node's EFFECTIVE target layer: the clip flowing into its main "Layer" input
 * (from a hub node), else its own `target` param. This is what makes the tree
 * composable — wire a Layer hub into a Transform/Effects node and it reads and
 * drives THAT hub's layer, so a second hub lets you pull another layer's values
 * in. One-hop (a hub carries a real `target`); the fallback keeps standalone
 * nodes working.
 */
export function effectiveTarget(graph: NodeGraph, node: GraphNode): string {
  const edge = graph.edges.find((e) => e.to.node === node.id && e.to.socket === MAIN_SOCKET_KEY);
  if (edge) {
    const src = graph.nodes.find((n) => n.id === edge.from.node);
    const t = typeof src?.params.target === "string" ? src.params.target : "";
    if (t) return t;
  }
  // ONE source of truth: the wire if present, else the picked literal, else
  // NONE. No owner fallback — a node with no wire and no pick is genuinely
  // unbound (picker reads "No layer"), so the line and the field never disagree.
  // Cutting the line clears the target; "No layer" and no-wire are the same state.
  return typeof node.params.target === "string" ? node.params.target : "";
}

/**
 * Bake every node's EFFECTIVE target into its `params.target`, so socket
 * resolution sees the layer a hub feeds it — not the empty literal it stores.
 * This is the ONE thing that makes per-property (point-to-point) sockets exist
 * for hit-testing, wire validation and driver projection on hub-fed operators;
 * without it only the static "Layer" socket resolves and every drop snaps there.
 * Read-only: the returned graph is for resolving sockets, never persisted (the
 * base target stays empty so the wire keeps owning it).
 */
export function withEffectiveTargets(graph: NodeGraph): NodeGraph {
  let changed = false;
  const nodes = graph.nodes.map((n) => {
    const et = effectiveTarget(graph, n);
    if (et && et !== n.params.target) {
      changed = true;
      return { ...n, params: { ...n.params, target: et } };
    }
    return n;
  });
  return changed ? { ...graph, nodes } : graph;
}
