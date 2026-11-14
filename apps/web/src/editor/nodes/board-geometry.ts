import { MAIN_SOCKET_KEY, type AABB, type GraphNode, type NodeGraph, type NodeTypeDef, type SocketSpec } from "@solomotion/core";

/**
 * BOARD GEOMETRY — the pure layout math for one node card and the wires between
 * cards. Given a node type + instance it returns fixed socket positions (so the
 * card render and the wire render agree exactly), plus the bezier path and a
 * distance test used for clicking/splicing wires. No React, no DOM: the same
 * numbers drive rendering, hit-testing and the drag gestures.
 */

export const NODE_WIDTH = 224;
export const HEADER_H = 30;
export const ROW_H = 22;
export const OPTION_H = 26;
export const PAD_Y = 8;
export const SOCKET_R = 5.5;

export interface SocketLayout {
  key: string;
  /** Y offset from the node's top, in world units (= the socket's center). */
  y: number;
}

export interface NodeLayout {
  width: number;
  height: number;
  outputs: SocketLayout[];
  inputs: SocketLayout[];
  /** Y where the options block starts (below the sockets). */
  optionsY: number;
}

/** Compute a node's card size and every socket's vertical position from its
 *  RESOLVED sockets (projection nodes vary per target, so the caller resolves
 *  them). Outputs sit at the top (right edge), inputs below (left edge), options
 *  at the bottom — the Blender reading order. */
export function nodeLayout(def: NodeTypeDef, inputs: SocketSpec[], outputs: SocketSpec[]): NodeLayout {
  // A key present on BOTH sides is ONE combined row (input dot left, output dot
  // right) — projection nodes read+write each property in place. Keys unique to
  // one side stack as normal (math: outputs on top, inputs below). Order:
  // output-only → combined → input-only, top to bottom.
  const inKeys = new Set(inputs.map((s) => s.key));
  const outKeys = new Set(outputs.map((s) => s.key));
  const outputRows: SocketLayout[] = [];
  const inputRows: SocketLayout[] = [];
  let y = HEADER_H + PAD_Y;
  const rowAt = () => {
    const yy = y + ROW_H / 2;
    y += ROW_H;
    return yy;
  };
  // The main "Layer" socket is the node's identity — always the FIRST row, on
  // whichever single side its role puts it (source→output, operator→input).
  const mainOut = outKeys.has(MAIN_SOCKET_KEY);
  const mainIn = inKeys.has(MAIN_SOCKET_KEY);
  if (mainOut || mainIn) {
    const yy = rowAt();
    if (mainOut) outputRows.push({ key: MAIN_SOCKET_KEY, y: yy });
    if (mainIn) inputRows.push({ key: MAIN_SOCKET_KEY, y: yy });
  }
  const skip = (k: string) => k === MAIN_SOCKET_KEY;
  for (const o of outputs) if (!skip(o.key) && !inKeys.has(o.key)) outputRows.push({ key: o.key, y: rowAt() });
  for (const o of outputs) {
    if (skip(o.key) || !inKeys.has(o.key)) continue;
    const yy = rowAt();
    outputRows.push({ key: o.key, y: yy });
    inputRows.push({ key: o.key, y: yy });
  }
  for (const i of inputs) if (!skip(i.key) && !outKeys.has(i.key)) inputRows.push({ key: i.key, y: rowAt() });
  const optionsY = y;
  y += (def.options?.length ?? 0) * OPTION_H;
  y += PAD_Y;
  return { width: NODE_WIDTH, height: y, outputs: outputRows, inputs: inputRows, optionsY };
}

/** The world-space center of one socket. `dir` picks the edge (outputs right,
 *  inputs left). Returns null if the socket isn't on this node. */
export function socketWorldPos(
  node: GraphNode,
  layout: NodeLayout,
  dir: "in" | "out",
  key: string,
): { x: number; y: number } | null {
  const list = dir === "out" ? layout.outputs : layout.inputs;
  const s = list.find((r) => r.key === key);
  if (!s) return null;
  return { x: dir === "out" ? node.x + layout.width : node.x, y: node.y + s.y };
}

/** World-space bounding box of a node card (for marquee + fit). */
export function nodeBounds(node: GraphNode, layout: NodeLayout): AABB {
  return { minX: node.x, minY: node.y, maxX: node.x + layout.width, maxY: node.y + layout.height };
}

/** Union bounds of a whole graph (for zoom-to-fit on open). Null when empty. */
export function graphBounds(graph: NodeGraph, layoutOf: (n: GraphNode) => NodeLayout): AABB | null {
  if (graph.nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of graph.nodes) {
    const b = nodeBounds(n, layoutOf(n));
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The cubic-bezier path for a wire from an output point to an input point. The
 * horizontal control offset scales with the gap so wires bow out like Blender's
 * (and never collapse to a straight kink when nodes overlap vertically).
 */
export function wirePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

/** Sample the wire bezier and return the min distance from `p` — for clicking a
 *  wire to select it and for detecting the node dropped onto a wire (splice). */
export function wireDistance(
  from: { x: number; y: number },
  to: { x: number; y: number },
  p: { x: number; y: number },
): number {
  const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
  const c1 = { x: from.x + dx, y: from.y };
  const c2 = { x: to.x - dx, y: to.y };
  let min = Infinity;
  const N = 20;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const mt = 1 - t;
    const x = mt * mt * mt * from.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * to.x;
    const y = mt * mt * mt * from.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * to.y;
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < min) min = d;
  }
  return min;
}

/** Do two world AABBs overlap (marquee vs node)? */
export function boxesOverlap(a: AABB, b: AABB): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}
