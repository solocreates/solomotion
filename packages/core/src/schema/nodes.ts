import { z } from "zod";
import { vec2Schema } from "./common";

/**
 * NODE GRAPHS — the stored data behind the app's unified node system (v41). One
 * graph model powers BOTH faces of the feature:
 *  - the free NODE BOARD (a Blender-style workspace you pan/zoom/edit visually), and
 *  - EXPRESSIONS (a graph bound to drive a single property, `expr:<id>`).
 *
 * Graphs live in `doc.graphs[]` — a reusable table like `variables`/`trackers`:
 * one graph can drive many property slots and be opened on the board at once.
 * This file is ONLY the persisted shape (framework-free zod). The engine that
 * evaluates and edits a graph lives in `../nodes` (registry / eval / graph-ops)
 * and is intentionally decoupled from storage, exactly like tracking's
 * schema/engine split — so the file format never depends on the node library.
 *
 * What is NOT stored: socket VALUES (they are computed by the eval engine) and
 * a node's socket layout (it comes from the type registry). Only node POSITIONS,
 * the literal `params` for unconnected inputs + option choices, and the EDGES
 * are persisted — the minimum that can't be re-derived from the registry.
 */

/** The typed data a socket carries. `any` is the wildcard (drives coerce on use). */
// `layer` carries a clip id. It is a real type rather than a string so that a
// Layer socket cannot be fed a piece of text, and so the expression language can
// hold the same handle a wire does — one idea of "a layer", not two.
export const socketTypeSchema = z.enum(["float", "vec2", "color", "bool", "string", "layer", "track", "any"]);
export type SocketType = z.infer<typeof socketTypeSchema>;

/** A concrete runtime value flowing through a socket during evaluation. */
export type NodeValue = number | { x: number; y: number } | string | boolean;

/**
 * A persisted literal — the value an UNCONNECTED input socket holds, or an
 * option choice (a math operation, a clamp toggle, …). Colors ride the `string`
 * arm (hex), like every other color in the document.
 */
export const nodeParamSchema = z.union([z.number(), z.string(), z.boolean(), vec2Schema]);
export type NodeParam = z.infer<typeof nodeParamSchema>;

/** A reference to one socket on one node (an output when it's an edge source,
 *  an input when it's an edge target). */
export const socketRefSchema = z.object({ node: z.string(), socket: z.string() });
export type SocketRef = z.infer<typeof socketRefSchema>;

/**
 * A node instance on the board. `type` names its `NodeTypeDef` in the registry
 * (which supplies title, sockets, evaluation); everything here is the per-
 * instance state the registry can't know: position, the literal params bag, and
 * whether the card is collapsed to its header.
 */
export const graphNodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  x: z.number(),
  y: z.number(),
  /** Literals for unconnected input sockets AND option values, keyed by key. */
  params: z.record(z.string(), nodeParamSchema).default({}),
  collapsed: z.boolean().default(false),
  /** Enclosing visual group/frame (Blender-style), or null. See `nodeGroupSchema`. */
  groupId: z.string().nullable().default(null),
});
export type GraphNode = z.infer<typeof graphNodeSchema>;

/** A visual GROUP/FRAME behind a set of nodes (Ctrl+G). Purely organisational —
 *  it moves its members together and labels a region; membership lives on the
 *  nodes (`node.groupId`), so a node is in at most one group. */
export const nodeGroupSchema = z.object({
  id: z.string(),
  name: z.string().default("Group"),
  /** Accent tint for the frame; null = neutral. */
  color: z.string().nullable().default(null),
});
export type NodeGroupBox = z.infer<typeof nodeGroupSchema>;

/** A directed wire: data flows from an OUTPUT socket (`from`) to an INPUT (`to`).
 *  An input holds at most one edge; an output may fan out to many. */
export const graphEdgeSchema = z.object({
  id: z.string(),
  from: socketRefSchema,
  to: socketRefSchema,
});
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

/** The board's last camera (pan/zoom), so reopening a graph lands where you left. */
export const graphViewSchema = z.object({ tx: z.number(), ty: z.number(), scale: z.number() });
export type GraphView = z.infer<typeof graphViewSchema>;

/**
 * What a graph is FOR. `board` graphs are free workspaces (every node type
 * allowed); `expression` graphs drive one property and hide board-only nodes.
 * The registry marks each node type's allowed contexts — the core already knows
 * which nodes to exclude in expression mode, so the UI never has to.
 */
export const nodeGraphKindSchema = z.enum(["board", "expression"]);
export type NodeGraphKind = z.infer<typeof nodeGraphKindSchema>;

export const nodeGraphSchema = z.object({
  id: z.string(),
  name: z.string().default("Graph"),
  kind: nodeGraphKindSchema.default("board"),
  /**
   * What this graph belongs to (v41): a clip (layer), group, or frame id — so
   * every layer carries its OWN node tree, surfaced when it's selected. null =
   * the document-level board (shown when nothing is selected). The board
   * resolves selection → owner → this graph, find-or-create.
   */
  ownerId: z.string().nullable().default(null),
  nodes: z.array(graphNodeSchema).default([]),
  edges: z.array(graphEdgeSchema).default([]),
  /** Visual node groups/frames (Ctrl+G). */
  groups: z.array(nodeGroupSchema).default([]),
  /** Saved board camera; null = fit on open. */
  view: graphViewSchema.nullable().default(null),
});
export type NodeGraph = z.infer<typeof nodeGraphSchema>;

// ── Driver tokens ────────────────────────────────────────────────────────────

/**
 * A bindable slot may store `expr:<graphId>` to be DRIVEN by a graph's Output
 * node instead of a literal or a `var:` reference. This mirrors the variables
 * token scheme (`VAR_TOKEN_PREFIX`) exactly — one funnel resolves the value —
 * so expressions plug into every existing bindable field with no new plumbing.
 */
export const EXPR_TOKEN_PREFIX = "expr:";

/** Matches an `expr:<id>` driver token. */
export const exprTokenRegex = /^expr:.+/;

/**
 * Build a driver token. `expr:<graphId>` drives from the graph's Output node
 * (a right-click "Add expression"); `expr:<graphId>@<node>.<socket>` drives from
 * a specific Object-node INPUT socket wired on the board — one token grammar for
 * both authoring paths, mirroring the `var:` scheme so it plugs into any slot.
 */
export function exprToken(graphId: string, sink?: { node: string; socket: string }): string {
  const base = `${EXPR_TOKEN_PREFIX}${graphId}`;
  return sink ? `${base}@${sink.node}.${sink.socket}` : base;
}

/** The graph id inside a driver token, or null when the value isn't a driver.
 *  (Back-compat: ignores any `@sink` suffix — call `parseDriverToken` for that.) */
export function parseExprToken(value: unknown): string | null {
  const parsed = parseDriverToken(value);
  return parsed ? parsed.graphId : null;
}

export interface ParsedDriver {
  graphId: string;
  /** The Object-node input sink to read, when the token names one. */
  sink?: { node: string; socket: string };
}

/** Decompose a driver token into `{ graphId, sink? }`, or null when not a driver. */
export function parseDriverToken(value: unknown): ParsedDriver | null {
  if (typeof value !== "string" || !value.startsWith(EXPR_TOKEN_PREFIX)) return null;
  const body = value.slice(EXPR_TOKEN_PREFIX.length);
  const at = body.indexOf("@");
  if (at < 0) return { graphId: body };
  const graphId = body.slice(0, at);
  const rest = body.slice(at + 1);
  // Node ids never contain "." (createId uses `_`); property-path socket keys do
  // (`fill.<id>.color`) — so the FIRST dot splits node from the rest-is-socket.
  const dot = rest.indexOf(".");
  if (dot < 0) return { graphId };
  return { graphId, sink: { node: rest.slice(0, dot), socket: rest.slice(dot + 1) } };
}
