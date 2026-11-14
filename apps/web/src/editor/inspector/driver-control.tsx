import { disconnect, OUTPUT_NODE_TYPE, parseDriverToken, type DocumentStore } from "@solomotion/core";
import { useBoardStore } from "../nodes/board-store";
import { findGraph, updateGraph } from "../nodes/graph-actions";

/**
 * NAVIGATION AND DETACH FOR A NODE-DRIVEN PROPERTY — the two verbs, headless.
 *
 * There used to be a "Nodes" chip here, mounted beside every driven row. It is
 * gone: a value's source belongs ON the value, so a driven field tints itself
 * and opens its own source (see `binding/dynamic-field`). What survives is the
 * part that was never about presentation — where a token POINTS, and how to
 * unhook it — which the field, the row menu and the board all call.
 *
 * Detaching a node-driven sink removes the board edge rather than the token, so
 * the graph and the document agree about what is connected; `syncGraphDrivers`
 * then clears the token and the property's preserved base/keyframe literal
 * resurfaces exactly as it was.
 */

/** Open the board pinned to the graph/node behind a driver token. Works even
 *  when the board window is closed — it opens it. */
export function openBoardAtDriver(store: DocumentStore, token: string): void {
  const parsed = parseDriverToken(token);
  if (!parsed) return;
  const graph = findGraph(store.getState(), parsed.graphId);
  if (!graph) return;
  const nodeId =
    parsed.sink?.node ??
    graph.nodes.find((n) => n.type === OUTPUT_NODE_TYPE)?.id ??
    graph.nodes[0]?.id;
  if (!nodeId) return;
  useBoardStore.getState().focusOnNode(parsed.graphId, nodeId);
}

/** Detach a property from its driver, restoring its literal value. */
export function detachDriver(store: DocumentStore, clipId: string, property: string, token: string): void {
  const parsed = parseDriverToken(token);
  if (!parsed) return;
  if (parsed.sink) {
    // Node-driven (Object-node sink): drop the feeding edge — `syncGraphDrivers`
    // then clears the driver token, and the base/keyframe literal (never touched
    // by driving) resurfaces.
    const g = findGraph(store.getState(), parsed.graphId);
    const edge = g?.edges.find((e) => e.to.node === parsed.sink!.node && e.to.socket === parsed.sink!.socket);
    if (edge) {
      updateGraph(store, parsed.graphId, "Detach from nodes", (gr) => disconnect(gr, edge.id));
      return;
    }
  }
  // Expression driver (Output node) or a missing edge — drop the token directly.
  store.update("Detach from nodes", (draft) => {
    for (const t of draft.tracks)
      for (const c of t.clips)
        if (c.id === clipId && c.drivers) {
          const next = { ...c.drivers };
          delete next[property];
          c.drivers = Object.keys(next).length ? next : undefined;
        }
  });
}
