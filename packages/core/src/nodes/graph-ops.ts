import { createId } from "../ids";
import type {
  GraphEdge,
  GraphNode,
  NodeGraph,
  NodeGraphKind,
  NodeGroupBox,
  NodeParam,
  SocketRef,
  SocketType,
} from "../schema";
import type { NodeRegistry, SocketResolveCtx } from "./registry";

/** The live-property hook projection nodes need to resolve their dynamic sockets
 *  (the board passes one built from the doc; plain graphs pass nothing). */
type DescribeClip = SocketResolveCtx["describeClip"];
import { canConnect } from "./sockets";

/**
 * PURE GRAPH EDITING — every structural change to a graph as a pure
 * `(graph) → graph` transform. These are the brains the board's gestures reduce
 * to: dragging a wire (`connect`), Shift-dragging to detach (`disconnect`),
 * Shift-dropping a node onto a wire (`spliceNodeOnEdge`), Alt-dragging to clone
 * (`duplicateNodes`), delete (`removeNodes`). Keeping them here — framework-free
 * and returning NEW graphs — means the exact same rules run under the UI, under
 * tests, and under any future native adapter, with zero duplicated logic.
 */

export function createGraph(name = "Graph", kind: NodeGraphKind = "board", ownerId: string | null = null): NodeGraph {
  return { id: createId("graph"), name, kind, ownerId, nodes: [], edges: [], groups: [], view: null };
}

/** Instantiate a node of `type` at a board position, seeded with its input
 *  defaults and option defaults (so it evaluates sensibly before any wiring). */
export function createNode(registry: NodeRegistry, type: string, x: number, y: number): GraphNode | null {
  const def = registry.get(type);
  if (!def) return null;
  const node: GraphNode = { id: createId("node"), type, x, y, params: {}, collapsed: false, groupId: null };
  const params: Record<string, NodeParam> = {};
  // Projection nodes have no static inputs until targeted — `inputsOf` returns []
  // then, so nothing is seeded, which is exactly right.
  for (const s of registry.inputsOf(node)) if (s.default !== undefined) params[s.key] = s.default as NodeParam;
  for (const o of def.options ?? []) params[o.key] = o.default;
  node.params = params;
  return node;
}

// ── queries ──────────────────────────────────────────────────────────────────

/** The single edge feeding an input socket, if any. */
export function inboundEdge(graph: NodeGraph, node: string, socket: string): GraphEdge | undefined {
  return graph.edges.find((e) => e.to.node === node && e.to.socket === socket);
}

/** Every edge touching a node (as source or target). */
export function edgesOfNode(graph: NodeGraph, nodeId: string): GraphEdge[] {
  return graph.edges.filter((e) => e.from.node === nodeId || e.to.node === nodeId);
}

/** The declared type of a socket (output when `dir==="out"`, input otherwise). */
export function socketType(
  registry: NodeRegistry,
  graph: NodeGraph,
  ref: SocketRef,
  dir: "in" | "out",
  describeClip?: DescribeClip,
): SocketType | undefined {
  const node = graph.nodes.find((n) => n.id === ref.node);
  if (!node) return undefined;
  const specs =
    dir === "out" ? registry.outputsOf(node, { describeClip }) : registry.inputsOf(node, { describeClip });
  return specs.find((s) => s.key === ref.socket)?.type;
}

/**
 * Would adding a wire `fromNode → toNode` create a cycle? True iff `toNode` can
 * already reach `fromNode` downstream (or they're the same node). The board
 * calls this to refuse an invalid drop before it happens.
 */
export function wouldCycle(graph: NodeGraph, fromNode: string, toNode: string): boolean {
  if (fromNode === toNode) return true;
  const downstream = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = downstream.get(e.from.node);
    if (list) list.push(e.to.node);
    else downstream.set(e.from.node, [e.to.node]);
  }
  const stack = [toNode];
  const seen = new Set<string>();
  while (stack.length) {
    const n = stack.pop()!;
    if (n === fromNode) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of downstream.get(n) ?? []) stack.push(m);
  }
  return false;
}

/** Can a wire from output `from` legally feed input `to`? (Types compatible,
 *  no self-loop, no cycle.) The one predicate the board uses to light a socket
 *  green/red while dragging. */
export function canWire(
  registry: NodeRegistry,
  graph: NodeGraph,
  from: SocketRef,
  to: SocketRef,
  describeClip?: DescribeClip,
): boolean {
  if (from.node === to.node) return false;
  const ft = socketType(registry, graph, from, "out", describeClip);
  const tt = socketType(registry, graph, to, "in", describeClip);
  if (!ft || !tt) return false;
  if (!canConnect(ft, tt)) return false;
  return !wouldCycle(graph, from.node, to.node);
}

// ── mutations (return a NEW graph) ─────────────────────────────────────────────

/**
 * Wire an output to an input. An input holds at most one edge, so any existing
 * wire into `to` is replaced (Blender/Figma behaviour). Returns the new graph,
 * or null when the connection is illegal (`canWire` fails).
 */
export function connect(
  registry: NodeRegistry,
  graph: NodeGraph,
  from: SocketRef,
  to: SocketRef,
  describeClip?: DescribeClip,
): NodeGraph | null {
  if (!canWire(registry, graph, from, to, describeClip)) return null;
  const edges = graph.edges.filter((e) => !(e.to.node === to.node && e.to.socket === to.socket));
  edges.push({ id: createId("edge"), from, to });
  return { ...graph, edges };
}

/** Remove one edge by id. */
export function disconnect(graph: NodeGraph, edgeId: string): NodeGraph {
  return { ...graph, edges: graph.edges.filter((e) => e.id !== edgeId) };
}

/** Remove whatever edge feeds an input socket (Shift-drag-off-input to detach). */
export function disconnectInput(graph: NodeGraph, node: string, socket: string): NodeGraph {
  return { ...graph, edges: graph.edges.filter((e) => !(e.to.node === node && e.to.socket === socket)) };
}

/**
 * Splice a node into an existing wire — the Shift-drop-a-node-onto-a-line
 * gesture. The edge A→B becomes A→node and node→B, choosing the node's first
 * type-compatible input and output automatically. No-op-safe: returns null if
 * the node can't sit inline (no compatible socket on either side).
 */
export function spliceNodeOnEdge(
  registry: NodeRegistry,
  graph: NodeGraph,
  edgeId: string,
  nodeId: string,
): NodeGraph | null {
  const edge = graph.edges.find((e) => e.id === edgeId);
  const node = graph.nodes.find((n) => n.id === nodeId);
  const def = node ? registry.get(node.type) : undefined;
  if (!edge || !node || !def) return null;

  const fromType = socketType(registry, graph, edge.from, "out");
  const toType = socketType(registry, graph, edge.to, "in");
  if (!fromType || !toType) return null;

  const inSpec = registry.inputsOf(node).find((s) => canConnect(fromType, s.type));
  const outSpec = registry.outputsOf(node).find((s) => canConnect(s.type, toType));
  if (!inSpec || !outSpec) return null;

  let g = disconnect(graph, edgeId);
  g = connect(registry, g, edge.from, { node: nodeId, socket: inSpec.key }) ?? g;
  g = connect(registry, g, { node: nodeId, socket: outSpec.key }, edge.to) ?? g;
  return g;
}

/** Move a set of nodes by a delta (drag). */
export function moveNodes(graph: NodeGraph, ids: Iterable<string>, dx: number, dy: number): NodeGraph {
  const set = new Set(ids);
  return { ...graph, nodes: graph.nodes.map((n) => (set.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)) };
}

/** Set one literal param (an unconnected input's value or an option choice). */
export function setNodeParam(graph: NodeGraph, nodeId: string, key: string, value: NodeParam): NodeGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, params: { ...n.params, [key]: value } } : n)),
  };
}

/** Delete nodes and every edge touching them (and prune now-empty groups). */
export function removeNodes(graph: NodeGraph, ids: Iterable<string>): NodeGraph {
  const set = new Set(ids);
  const nodes = graph.nodes.filter((n) => !set.has(n.id));
  const liveGroups = new Set(nodes.map((n) => n.groupId).filter(Boolean) as string[]);
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter((e) => !set.has(e.from.node) && !set.has(e.to.node)),
    groups: graph.groups.filter((g) => liveGroups.has(g.id)),
  };
}

// ── groups (Ctrl+G) ───────────────────────────────────────────────────────────

/** Enclose a set of nodes in a new visual group/frame; returns the new graph
 *  (a no-op when fewer than one node). Members' `groupId` point at it. */
export function groupNodes(graph: NodeGraph, ids: Iterable<string>, name = "Group"): NodeGraph {
  const set = new Set(ids);
  if (set.size === 0) return graph;
  const group: NodeGroupBox = { id: createId("ngroup"), name, color: null };
  return {
    ...graph,
    groups: [...graph.groups, group],
    nodes: graph.nodes.map((n) => (set.has(n.id) ? { ...n, groupId: group.id } : n)),
  };
}

/** Disband a group: detach its members and drop the frame. */
export function ungroup(graph: NodeGraph, groupId: string): NodeGraph {
  return {
    ...graph,
    groups: graph.groups.filter((g) => g.id !== groupId),
    nodes: graph.nodes.map((n) => (n.groupId === groupId ? { ...n, groupId: null } : n)),
  };
}

/** The ids of every node in a group. */
export function groupMemberIds(graph: NodeGraph, groupId: string): string[] {
  return graph.nodes.filter((n) => n.groupId === groupId).map((n) => n.id);
}

export interface DuplicateResult {
  graph: NodeGraph;
  /** old node id → new node id, so callers can re-select the clones. */
  idMap: Map<string, string>;
  newIds: string[];
}

/**
 * Clone a set of nodes (Alt-drag / copy-paste), offset by (dx, dy). Edges whose
 * BOTH ends are in the set are cloned too (internal wiring is preserved); wires
 * to outside nodes are intentionally dropped, matching every node editor.
 */
export function duplicateNodes(graph: NodeGraph, ids: Iterable<string>, dx = 32, dy = 32): DuplicateResult {
  const set = new Set(ids);
  const idMap = new Map<string, string>();
  const clones: GraphNode[] = [];
  for (const n of graph.nodes) {
    if (!set.has(n.id)) continue;
    const nid = createId("node");
    idMap.set(n.id, nid);
    // Clones start ungrouped — a duplicated set is its own free-standing copy.
    clones.push({ ...n, id: nid, x: n.x + dx, y: n.y + dy, params: { ...n.params }, groupId: null });
  }
  const newEdges: GraphEdge[] = [];
  for (const e of graph.edges) {
    if (!set.has(e.from.node) || !set.has(e.to.node)) continue;
    newEdges.push({
      id: createId("edge"),
      from: { node: idMap.get(e.from.node)!, socket: e.from.socket },
      to: { node: idMap.get(e.to.node)!, socket: e.to.socket },
    });
  }
  return {
    graph: { ...graph, nodes: [...graph.nodes, ...clones], edges: [...graph.edges, ...newEdges] },
    idMap,
    newIds: [...idMap.values()],
  };
}
