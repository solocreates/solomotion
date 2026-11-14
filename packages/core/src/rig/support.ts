import type { MeshData } from "../schema";
import { transformPoint, type Mat4, type V3 } from "../world/math";
import { meshEdges } from "../world/mesh";
import { SLOTS, INFLUENCES, type WeightGraph, type Weights } from "./weights";

/**
 * WHAT WEIGHTS LIVE ON — the graph for each kind of art.
 *
 *  - A 2D layer: a GRID over its own box, keeping only the cells its
 *    silhouette covers (`gridSupport`). The silhouette is what keeps two legs
 *    apart: heat only spreads cell to cell, so a gap in the picture is a gap
 *    in the weights. The same grid is the mesh a picture is warped through,
 *    and any other point (a path's outline, a body's vertex) reads the weights
 *    bilinearly off it (`sampleGrid`) — one field per layer, whatever draws it.
 *  - A mesh: its own vertices and edges (`meshSupport`).
 */

export interface Box2 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** How opaque the art is at a point of its own space (0..1) — the silhouette. */
export type Coverage = (x: number, y: number) => number;

export interface GridSupport extends WeightGraph {
  /** The grid's corner, cell size and size in cells, in the layer's own space. */
  x0: number;
  y0: number;
  cell: number;
  cols: number;
  rows: number;
  /** (cols+1)·(rows+1) grid nodes → point index, or −1 where no covered cell touches. */
  node: Int32Array;
  /** cols·rows: is the cell covered? */
  covered: Uint8Array;
}

/** The finest a grid gets (cells across the longer side) and its smallest cell, in layer px. */
export const GRID_MAX_CELLS = 40;
const GRID_MIN_CELL = 3;

/**
 * The support grid over a 2D layer's box. `coverage` absent (headless, or a
 * picture that moves on its own) = the whole box. A silhouette that covers
 * nothing at all also falls back to the box, so a typing-on text bound at its
 * first frame still has somewhere to keep weights.
 */
export function gridSupport(box: Box2, toRig: Mat4, coverage?: Coverage | null, key = ""): GridSupport {
  const w = Math.max(1e-3, box.maxX - box.minX), h = Math.max(1e-3, box.maxY - box.minY);
  const cell = Math.max(GRID_MIN_CELL, Math.max(w, h) / GRID_MAX_CELLS);
  const cols = Math.max(1, Math.ceil(w / cell)), rows = Math.max(1, Math.ceil(h / cell));
  // Centre the grid on the box so its overhang is even on both sides.
  const x0 = (box.minX + box.maxX) / 2 - (cols * cell) / 2, y0 = (box.minY + box.maxY) / 2 - (rows * cell) / 2;
  const covered = new Uint8Array(cols * rows);
  let any = false;
  if (coverage) {
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const cx = x0 + (i + 0.5) * cell, cy = y0 + (j + 0.5) * cell, q = cell * 0.45;
      const on = coverage(cx, cy) > 0.05 || coverage(cx - q, cy - q) > 0.05 || coverage(cx + q, cy - q) > 0.05 || coverage(cx + q, cy + q) > 0.05 || coverage(cx - q, cy + q) > 0.05;
      if (on) (covered[j * cols + i] = 1), (any = true);
    }
  }
  if (!any) covered.fill(1);

  const node = new Int32Array((cols + 1) * (rows + 1)).fill(-1);
  const local: number[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    if (!covered[j * cols + i]) continue;
    for (const [a, b] of [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]] as const) {
      const k = b * (cols + 1) + a;
      if (node[k]! < 0) {
        node[k] = local.length / 3;
        local.push(x0 + a * cell, y0 + b * cell, 0);
      }
    }
  }
  const count = local.length / 3;
  // Edges along the sides of covered cells (each once).
  const nbr: number[][] = Array.from({ length: count }, () => []);
  const link = (p: number, q: number) => {
    if (p < 0 || q < 0 || nbr[p]!.includes(q)) return;
    nbr[p]!.push(q);
    nbr[q]!.push(p);
  };
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    if (!covered[j * cols + i]) continue;
    const n00 = node[j * (cols + 1) + i]!, n10 = node[j * (cols + 1) + i + 1]!;
    const n01 = node[(j + 1) * (cols + 1) + i]!, n11 = node[(j + 1) * (cols + 1) + i + 1]!;
    link(n00, n10), link(n10, n11), link(n11, n01), link(n01, n00);
  }
  const { offsets, adj } = csr(nbr);
  const rig = new Float64Array(count * 3);
  for (let p = 0; p < count; p++) {
    const r = transformPoint(toRig, [local[p * 3]!, local[p * 3 + 1]!, 0]);
    rig[p * 3] = r[0], rig[p * 3 + 1] = r[1], rig[p * 3 + 2] = r[2];
  }
  return {
    key: `g|${key}|${x0.toFixed(2)},${y0.toFixed(2)},${cell.toFixed(3)},${cols}x${rows}|${coverage ? hashCovered(covered) : "box"}|${toRig.map((v) => v.toFixed(3)).join(",")}`,
    count,
    local: new Float64Array(local),
    rig,
    offsets,
    adj,
    spacing: cell,
    x0,
    y0,
    cell,
    cols,
    rows,
    node,
    covered,
  };
}

function hashCovered(c: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < c.length; i++) h = Math.imul(h ^ c[i]!, 16777619);
  return (h >>> 0).toString(36);
}

function csr(nbr: number[][]): { offsets: Int32Array; adj: Int32Array } {
  const offsets = new Int32Array(nbr.length + 1);
  for (let i = 0; i < nbr.length; i++) offsets[i + 1] = offsets[i]! + nbr[i]!.length;
  const adj = new Int32Array(offsets[nbr.length]!);
  for (let i = 0; i < nbr.length; i++) adj.set(nbr[i]!, offsets[i]!);
  return { offsets, adj };
}

/** A mesh's own vertices and edges, in its space and the rig's. */
export function meshSupport(mesh: MeshData, toRig: Mat4, key: string): WeightGraph {
  const count = mesh.positions.length / 3;
  const nbr: number[][] = Array.from({ length: count }, () => []);
  let total = 0, edges = 0;
  for (const { a, b } of meshEdges(mesh).list) {
    if (a >= count || b >= count || a === b) continue;
    nbr[a]!.push(b);
    nbr[b]!.push(a);
    total += Math.hypot(mesh.positions[a * 3]! - mesh.positions[b * 3]!, mesh.positions[a * 3 + 1]! - mesh.positions[b * 3 + 1]!, mesh.positions[a * 3 + 2]! - mesh.positions[b * 3 + 2]!);
    edges++;
  }
  const { offsets, adj } = csr(nbr);
  const rig = new Float64Array(count * 3);
  for (let p = 0; p < count; p++) {
    const r = transformPoint(toRig, [mesh.positions[p * 3]!, mesh.positions[p * 3 + 1]!, mesh.positions[p * 3 + 2]!]);
    rig[p * 3] = r[0], rig[p * 3 + 1] = r[1], rig[p * 3 + 2] = r[2];
  }
  return {
    key: `m|${key}|${toRig.map((v) => v.toFixed(3)).join(",")}`,
    count,
    local: Float64Array.from(mesh.positions),
    rig,
    offsets,
    adj,
    spacing: edges ? total / edges : 1,
  };
}

/** A point's influences: bone indices and weights, at most `INFLUENCES`, summing to one. */
export interface Influence {
  bone: Int16Array;
  w: Float32Array;
}

/**
 * The weights at ANY point of a 2D layer's own space, read off its grid:
 * bilinear across the cell's covered corners; outside the silhouette, the
 * nearest covered point's. What a path's outline, a body's vertex or a
 * point added after binding bend by.
 */
export function sampleGrid(g: GridSupport, wts: Weights, x: number, y: number, out: Influence = emptyInfluence()): Influence {
  const fx = (x - g.x0) / g.cell, fy = (y - g.y0) / g.cell;
  const i = Math.max(0, Math.min(g.cols - 1, Math.floor(fx))), j = Math.max(0, Math.min(g.rows - 1, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - i)), ty = Math.max(0, Math.min(1, fy - j));
  const acc = new Map<number, number>();
  let wsum = 0;
  const corner = (a: number, b: number, k: number) => {
    const p = g.node[b * (g.cols + 1) + a]!;
    if (p < 0 || k <= 0) return;
    wsum += k;
    for (let s = 0; s < SLOTS; s++) {
      const bi = wts.bone[p * SLOTS + s]!;
      if (bi >= 0) acc.set(bi, (acc.get(bi) ?? 0) + wts.w[p * SLOTS + s]! * k);
    }
  };
  corner(i, j, (1 - tx) * (1 - ty));
  corner(i + 1, j, tx * (1 - ty));
  corner(i, j + 1, (1 - tx) * ty);
  corner(i + 1, j + 1, tx * ty);
  if (wsum <= 1e-9) {
    const p = nearestNode(g, x, y);
    if (p >= 0) {
      for (let s = 0; s < SLOTS; s++) {
        const bi = wts.bone[p * SLOTS + s]!;
        if (bi >= 0) acc.set(bi, wts.w[p * SLOTS + s]!);
      }
      wsum = 1;
    }
  }
  return fillInfluence(acc, out);
}

/** A point of the graph's own influences (no sampling). */
export function pointInfluence(wts: Weights, p: number, out: Influence = emptyInfluence()): Influence {
  const acc = new Map<number, number>();
  for (let s = 0; s < SLOTS; s++) {
    const bi = wts.bone[p * SLOTS + s]!;
    if (bi >= 0) acc.set(bi, wts.w[p * SLOTS + s]!);
  }
  return fillInfluence(acc, out);
}

export function emptyInfluence(): Influence {
  return { bone: new Int16Array(INFLUENCES).fill(-1), w: new Float32Array(INFLUENCES) };
}

function fillInfluence(acc: Map<number, number>, out: Influence): Influence {
  const items = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, INFLUENCES);
  const sum = items.reduce((a, [, v]) => a + v, 0);
  for (let k = 0; k < INFLUENCES; k++) {
    out.bone[k] = k < items.length ? items[k]![0] : -1;
    out.w[k] = k < items.length && sum > 0 ? items[k]![1] / sum : 0;
  }
  return out;
}

function nearestNode(g: GridSupport, x: number, y: number): number {
  let best = -1, bd = Infinity;
  for (let p = 0; p < g.count; p++) {
    const d = (g.local[p * 3]! - x) ** 2 + (g.local[p * 3 + 1]! - y) ** 2;
    if (d < bd) (bd = d), (best = p);
  }
  return best;
}

/** The covered cells as quads of point indices (n00, n10, n11, n01) — what a picture is warped through. */
export function gridCells(g: GridSupport): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  for (let j = 0; j < g.rows; j++) for (let i = 0; i < g.cols; i++) {
    if (!g.covered[j * g.cols + i]) continue;
    out.push([g.node[j * (g.cols + 1) + i]!, g.node[j * (g.cols + 1) + i + 1]!, g.node[(j + 1) * (g.cols + 1) + i + 1]!, g.node[(j + 1) * (g.cols + 1) + i]!]);
  }
  return out;
}

export type { V3 };
