import type { MeshData } from "../schema/world";
import { hasUv, meshBounds, meshEdges, triangulateFace, vertexCount } from "./mesh";

/**
 * REMESH — rebuild a shape from voxels (Blender's Remesh): `blocks` is the
 * voxel-art look, every filled cell a cube; `smooth` is a clean, even surface
 * over the same cells (naive surface nets), which is what a messy boolean, a
 * drawn solid or an imported scan wants before it is subdivided or displaced.
 *
 * Filling is exact for a closed shape (a ray along X through every row of
 * cells, inside between crossings); an open one (a card, a ribbon) becomes a
 * thin shell — the cells its surface passes through.
 */
export function remeshMesh(mesh: MeshData, cells: number, mode: "blocks" | "smooth"): MeshData {
  if (vertexCount(mesh) === 0 || mesh.faces.length === 0) return mesh;
  const res = Math.max(4, Math.min(96, Math.round(cells)));
  const b = meshBounds(mesh);
  const span = Math.max(1e-6, b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const h = span / res;
  // A cell of margin so the surface closes round the outside.
  const o: [number, number, number] = [b.min[0] - h, b.min[1] - h, b.min[2] - h];
  const N = [0, 1, 2].map((k) => Math.max(1, Math.ceil((b.max[k]! - b.min[k]!) / h) + 2)) as [number, number, number];
  const filled = new Uint8Array(N[0] * N[1] * N[2]);
  const idx = (x: number, y: number, z: number) => (z * N[1] + y) * N[0] + x;
  const P = mesh.positions;
  const tris: number[] = [];
  for (const f of mesh.faces) tris.push(...triangulateFace(mesh, f));
  const closed = meshEdges(mesh).list.every((e) => e.faces.length === 2);

  if (closed) {
    // Rows along X: collect every crossing, fill between pairs.
    const rows = new Map<number, number[]>();
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t]! * 3, bb = tris[t + 1]! * 3, c = tris[t + 2]! * 3;
      const ys = [P[a + 1]!, P[bb + 1]!, P[c + 1]!], zs = [P[a + 2]!, P[bb + 2]!, P[c + 2]!];
      const y0 = Math.max(0, Math.ceil((Math.min(...ys) - o[1]) / h - 0.5)), y1 = Math.min(N[1] - 1, Math.floor((Math.max(...ys) - o[1]) / h - 0.5));
      const z0 = Math.max(0, Math.ceil((Math.min(...zs) - o[2]) / h - 0.5)), z1 = Math.min(N[2] - 1, Math.floor((Math.max(...zs) - o[2]) / h - 0.5));
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const py = o[1] + (y + 0.5) * h, pz = o[2] + (z + 0.5) * h;
          // Barycentric hit of the row's line with the triangle (in YZ).
          const ax = P[a]!, ay = P[a + 1]!, az = P[a + 2]!;
          const bx = P[bb]!, by = P[bb + 1]!, bz = P[bb + 2]!;
          const cx = P[c]!, cy = P[c + 1]!, cz = P[c + 2]!;
          const det = (by - ay) * (cz - az) - (cy - ay) * (bz - az);
          if (Math.abs(det) < 1e-12) continue;
          const u = ((py - ay) * (cz - az) - (cy - ay) * (pz - az)) / det;
          const v = ((by - ay) * (pz - az) - (py - ay) * (bz - az)) / det;
          if (u < 0 || v < 0 || u + v > 1) continue;
          const x = ax + (bx - ax) * u + (cx - ax) * v;
          const k = z * N[1] + y;
          const list = rows.get(k);
          if (list) list.push(x);
          else rows.set(k, [x]);
        }
      }
    }
    for (const [k, xs] of rows) {
      xs.sort((p, q) => p - q);
      const y = k % N[1], z = Math.floor(k / N[1]);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const x0 = Math.max(0, Math.ceil((xs[i]! - o[0]) / h - 0.5)), x1 = Math.min(N[0] - 1, Math.floor((xs[i + 1]! - o[0]) / h - 0.5));
        for (let x = x0; x <= x1; x++) filled[idx(x, y, z)] = 1;
      }
    }
  }
  // An OPEN shape has no inside: it becomes the shell of cells its surface
  // passes through, sampled densely enough to touch every one.
  for (let t = 0; !closed && t < tris.length; t += 3) {
    const a = tris[t]! * 3, bb = tris[t + 1]! * 3, c = tris[t + 2]! * 3;
    const e = Math.max(
      Math.hypot(P[bb]! - P[a]!, P[bb + 1]! - P[a + 1]!, P[bb + 2]! - P[a + 2]!),
      Math.hypot(P[c]! - P[a]!, P[c + 1]! - P[a + 1]!, P[c + 2]! - P[a + 2]!),
    );
    const steps = Math.min(200, Math.max(1, Math.ceil((e / h) * 2)));
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; i + j <= steps; j++) {
        const u = i / steps, v = j / steps;
        const p = [0, 1, 2].map((k) => P[a + k]! + (P[bb + k]! - P[a + k]!) * u + (P[c + k]! - P[a + k]!) * v);
        const x = Math.floor((p[0]! - o[0]) / h), y = Math.floor((p[1]! - o[1]) / h), z = Math.floor((p[2]! - o[2]) / h);
        if (x >= 0 && y >= 0 && z >= 0 && x < N[0] && y < N[1] && z < N[2]) filled[idx(x, y, z)] = 1;
      }
    }
  }
  const out = mode === "blocks" ? blocks(filled, N, o, h) : surfaceNets(filled, N, o, h);
  return hasUv(mesh) ? { ...out, uv: nearestUv(mesh, out, h) } : out;
}

/** Each new point wears the unwrap of the nearest original point (a grid search), so a remeshed picture keeps its pixels in place. */
function nearestUv(src: MeshData, dst: MeshData, h: number): number[] {
  const P = src.positions, U = src.uv!;
  const cell = Math.max(1e-6, h);
  const grid = new Map<string, number[]>();
  const keyOf = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < P.length / 3; i++) {
    const k = keyOf(P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  }
  const out: number[] = [];
  const D = dst.positions;
  for (let j = 0; j < D.length / 3; j++) {
    const x = D[j * 3]!, y = D[j * 3 + 1]!, z = D[j * 3 + 2]!;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let best = -1, bd = Infinity;
    for (let r = 1; r <= 8 && best < 0; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        for (const i of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
          const d = (P[i * 3]! - x) ** 2 + (P[i * 3 + 1]! - y) ** 2 + (P[i * 3 + 2]! - z) ** 2;
          if (d < bd) (bd = d), (best = i);
        }
      }
    }
    out.push(best >= 0 ? U[best * 2]! : 0, best >= 0 ? U[best * 2 + 1]! : 0);
  }
  return out;
}

/** One quad per filled cell face that meets an empty one. */
function blocks(filled: Uint8Array, N: [number, number, number], o: [number, number, number], h: number): MeshData {
  const at = (x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < N[0] && y < N[1] && z < N[2] && filled[(z * N[1] + y) * N[0] + x] === 1;
  const verts = new Map<string, number>();
  const positions: number[] = [];
  const vert = (x: number, y: number, z: number) => {
    const k = `${x},${y},${z}`;
    let i = verts.get(k);
    if (i === undefined) {
      i = positions.length / 3;
      verts.set(k, i);
      positions.push(o[0] + x * h, o[1] + y * h, o[2] + z * h);
    }
    return i;
  };
  const faces: number[][] = [];
  const quad = (c: Array<[number, number, number]>) => faces.push(c.map(([x, y, z]) => vert(x, y, z)));
  for (let z = 0; z < N[2]; z++) for (let y = 0; y < N[1]; y++) for (let x = 0; x < N[0]; x++) {
    if (!at(x, y, z)) continue;
    if (!at(x - 1, y, z)) quad([[x, y, z], [x, y, z + 1], [x, y + 1, z + 1], [x, y + 1, z]]);
    if (!at(x + 1, y, z)) quad([[x + 1, y, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x + 1, y, z + 1]]);
    if (!at(x, y - 1, z)) quad([[x, y, z], [x + 1, y, z], [x + 1, y, z + 1], [x, y, z + 1]]);
    if (!at(x, y + 1, z)) quad([[x, y + 1, z], [x, y + 1, z + 1], [x + 1, y + 1, z + 1], [x + 1, y + 1, z]]);
    if (!at(x, y, z - 1)) quad([[x, y, z], [x, y + 1, z], [x + 1, y + 1, z], [x + 1, y, z]]);
    if (!at(x, y, z + 1)) quad([[x, y, z + 1], [x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]]);
  }
  return { positions, faces };
}

/**
 * Naive SURFACE NETS: one vertex per cell the surface passes through (at the
 * average of its sign-changing edges' midpoints), one quad per sign-changing
 * grid edge. Smooth, even, all quads — then relaxed twice so the staircase of
 * the voxels does not show.
 */
function surfaceNets(filled: Uint8Array, N: [number, number, number], o: [number, number, number], h: number): MeshData {
  const at = (x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < N[0] && y < N[1] && z < N[2] && filled[(z * N[1] + y) * N[0] + x] === 1;
  // Dual grid: cell (x,y,z) has corners at voxel centres (x..x+1, ...).
  const vertOf = new Map<number, number>();
  const positions: number[] = [];
  const key = (x: number, y: number, z: number) => (z * (N[1] + 1) + y) * (N[0] + 1) + x;
  for (let z = -1; z < N[2]; z++) for (let y = -1; y < N[1]; y++) for (let x = -1; x < N[0]; x++) {
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    const corner = (dx: number, dy: number, dz: number) => at(x + dx, y + dy, z + dz);
    const edges: Array<[[number, number, number], [number, number, number]]> = [
      [[0, 0, 0], [1, 0, 0]], [[0, 1, 0], [1, 1, 0]], [[0, 0, 1], [1, 0, 1]], [[0, 1, 1], [1, 1, 1]],
      [[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0]], [[0, 0, 1], [0, 1, 1]], [[1, 0, 1], [1, 1, 1]],
      [[0, 0, 0], [0, 0, 1]], [[1, 0, 0], [1, 0, 1]], [[0, 1, 0], [0, 1, 1]], [[1, 1, 0], [1, 1, 1]],
    ];
    for (const [a, b] of edges) {
      if (corner(...a) === corner(...b)) continue;
      sx += (a[0] + b[0]) / 2;
      sy += (a[1] + b[1]) / 2;
      sz += (a[2] + b[2]) / 2;
      cnt++;
    }
    if (!cnt) continue;
    vertOf.set(key(x + 1, y + 1, z + 1), positions.length / 3);
    positions.push(o[0] + (x + 0.5 + sx / cnt) * h, o[1] + (y + 0.5 + sy / cnt) * h, o[2] + (z + 0.5 + sz / cnt) * h);
  }
  const faces: number[][] = [];
  const v = (x: number, y: number, z: number) => vertOf.get(key(x + 1, y + 1, z + 1));
  for (let z = 0; z < N[2]; z++) for (let y = 0; y < N[1]; y++) for (let x = 0; x < N[0]; x++) {
    const inside = at(x, y, z);
    // The +X, +Y, +Z grid edges out of this voxel centre: a quad of the four dual cells around each.
    const quads: Array<[boolean, Array<number | undefined>]> = [
      [at(x + 1, y, z), [v(x, y - 1, z - 1), v(x, y, z - 1), v(x, y, z), v(x, y - 1, z)]],
      [at(x, y + 1, z), [v(x - 1, y, z - 1), v(x - 1, y, z), v(x, y, z), v(x, y, z - 1)]],
      [at(x, y, z + 1), [v(x - 1, y - 1, z), v(x, y - 1, z), v(x, y, z), v(x - 1, y, z)]],
    ];
    for (const [other, q] of quads) {
      if (other === inside || q.some((i) => i === undefined)) continue;
      const loop = q as number[];
      faces.push(inside ? loop : loop.slice().reverse());
    }
  }
  // Relax: each vertex toward its neighbours' average, twice.
  const nb: number[][] = Array.from({ length: positions.length / 3 }, () => []);
  for (const f of faces) for (let i = 0; i < f.length; i++) nb[f[i]!]!.push(f[(i + 1) % f.length]!);
  let pos = positions;
  for (let it = 0; it < 2; it++) {
    const next = pos.slice();
    nb.forEach((list, i) => {
      if (!list.length) return;
      for (let k = 0; k < 3; k++) {
        let s = 0;
        for (const j of list) s += pos[j * 3 + k]!;
        next[i * 3 + k] = pos[i * 3 + k]! * 0.5 + (s / list.length) * 0.5;
      }
    });
    pos = next;
  }
  return { positions: pos, faces };
}
