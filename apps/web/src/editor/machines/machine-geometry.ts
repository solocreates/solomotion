import { MACHINE_ANY, MACHINE_EXIT, type AABB, type MachineLayer } from "@solomotion/core";

/**
 * MACHINE BOARD GEOMETRY — pure layout for the board: where each node sits
 * (states from the document; Entry, Any state and Exit DERIVED from them, never
 * stored) and the arrow between two of them. One source for render, hit tests
 * and gestures.
 */

export const CARD_W = 168;
export const CARD_H = 52;
export const PSEUDO_W = 104;
export const PSEUDO_H = 32;
export const ENTRY = "__entry";

export interface BoardNode {
  id: string;
  kind: "state" | "entry" | "any" | "exit";
  x: number;
  y: number;
  w: number;
  h: number;
}

export function layerNodes(layer: MachineLayer): BoardNode[] {
  const states: BoardNode[] = layer.states.map((s) => ({ id: s.id, kind: "state", x: s.x, y: s.y, w: CARD_W, h: CARD_H }));
  const minX = states.length ? Math.min(...states.map((s) => s.x)) : 0;
  const minY = states.length ? Math.min(...states.map((s) => s.y)) : 0;
  const maxX = states.length ? Math.max(...states.map((s) => s.x + s.w)) : 200;
  const entryState = states.find((s) => s.id === layer.entry) ?? states[0];
  const entryY = entryState ? entryState.y + (CARD_H - PSEUDO_H) / 2 : 0;
  const out: BoardNode[] = [
    { id: ENTRY, kind: "entry", x: minX - PSEUDO_W - 96, y: entryY, w: PSEUDO_W, h: PSEUDO_H },
    { id: MACHINE_ANY, kind: "any", x: minX - PSEUDO_W - 96, y: minY - PSEUDO_H - 72, w: PSEUDO_W, h: PSEUDO_H },
    ...states,
  ];
  if (layer.transitions.some((t) => t.to === MACHINE_EXIT)) out.push({ id: MACHINE_EXIT, kind: "exit", x: maxX + 120, y: entryY, w: PSEUDO_W, h: PSEUDO_H });
  return out;
}

export function nodesBounds(nodes: readonly BoardNode[]): AABB | null {
  if (!nodes.length) return null;
  return {
    minX: Math.min(...nodes.map((n) => n.x)),
    minY: Math.min(...nodes.map((n) => n.y)),
    maxX: Math.max(...nodes.map((n) => n.x + n.w)),
    maxY: Math.max(...nodes.map((n) => n.y + n.h)),
  };
}

export function nodeAt(nodes: readonly BoardNode[], p: { x: number; y: number }): BoardNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]!;
    if (p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h) return n;
  }
  return null;
}

const centre = (n: BoardNode) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });

/** Where the ray from a box's centre toward `to` leaves the box. */
function edgePoint(n: BoardNode, to: { x: number; y: number }) {
  const c = centre(n);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = dx === 0 ? Infinity : n.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : n.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

/**
 * The arrow from one node to another, nudged sideways by `lane` (so A→B and
 * B→A sit side by side instead of on top of each other). A self-loop is an arc
 * over the card.
 */
export function arrowBetween(a: BoardNode, b: BoardNode, lane: number): { d: string; mid: { x: number; y: number } } {
  if (a === b) {
    const x = a.x + a.w - 28;
    const y = a.y;
    return { d: `M ${x} ${y} C ${x - 10} ${y - 54}, ${x + 50} ${y - 54}, ${x + 22} ${y}`, mid: { x: x + 8, y: y - 42 } };
  }
  const ca = centre(a);
  const cb = centre(b);
  const len = Math.hypot(cb.x - ca.x, cb.y - ca.y) || 1;
  const nx = -(cb.y - ca.y) / len;
  const ny = (cb.x - ca.x) / len;
  const off = lane * 9;
  const p = edgePoint(a, { x: cb.x + nx * off, y: cb.y + ny * off });
  const q = edgePoint(b, { x: ca.x + nx * off, y: ca.y + ny * off });
  const from = { x: p.x + nx * off, y: p.y + ny * off };
  const to = { x: q.x + nx * off, y: q.y + ny * off };
  return { d: `M ${from.x} ${from.y} L ${to.x} ${to.y}`, mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 } };
}
