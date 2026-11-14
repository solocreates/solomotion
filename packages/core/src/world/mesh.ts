import type { MeshData } from "../schema/world";
import { cross, dot, normalize3, sub, transformPoint, type Mat4, type V3 } from "./math";

/**
 * THE MESH KERNEL — everything that is DERIVED from an n-gon mesh: edges,
 * face normals, triangles, render buffers, bounds. Nothing here is stored;
 * every answer is a function of `positions` + `faces`, which is what keeps an
 * edit from ever leaving a stale normal or a ghost edge behind.
 */

export function vertexCount(mesh: MeshData): number {
  return Math.floor(mesh.positions.length / 3);
}

export function vertexAt(mesh: MeshData, i: number): V3 {
  return [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!];
}

export function cloneMesh(mesh: MeshData): MeshData {
  return {
    positions: mesh.positions.slice(),
    faces: mesh.faces.map((f) => f.slice()),
    ...(mesh.faceParts ? { faceParts: mesh.faceParts.slice() } : {}),
    ...(mesh.marks ? { marks: mesh.marks.slice() } : {}),
    ...(mesh.sharp ? { sharp: mesh.sharp.slice() } : {}),
    ...(mesh.uv ? { uv: mesh.uv.slice() } : {}),
    ...(mesh.lines ? { lines: mesh.lines.slice() } : {}),
  };
}

/** Does the mesh carry its own unwrap, one (u, v) per vertex? (An edit that adds vertices without one leaves it stale.) */
export function hasUv(mesh: MeshData): mesh is MeshData & { uv: number[] } {
  return !!mesh.uv && mesh.uv.length === vertexCount(mesh) * 2;
}

/** Canonical undirected edge key. */
export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

export interface MeshEdge {
  a: number;
  b: number;
  /** Faces using this edge (1 = boundary, 2 = manifold, more = non-manifold). */
  faces: number[];
}

const edgeCache = new WeakMap<MeshData, { list: MeshEdge[]; byKey: Map<string, number> }>();

/** Every edge of the mesh, derived from the faces (memoised per mesh object). */
export function meshEdges(mesh: MeshData): { list: MeshEdge[]; byKey: Map<string, number> } {
  const hit = edgeCache.get(mesh);
  if (hit) return hit;
  const list: MeshEdge[] = [];
  const byKey = new Map<string, number>();
  mesh.faces.forEach((f, fi) => {
    for (let i = 0; i < f.length; i++) {
      const a = f[i]!;
      const b = f[(i + 1) % f.length]!;
      const k = edgeKey(a, b);
      let e = byKey.get(k);
      if (e === undefined) {
        e = list.length;
        byKey.set(k, e);
        list.push({ a: Math.min(a, b), b: Math.max(a, b), faces: [] });
      }
      list[e]!.faces.push(fi);
    }
  });
  // Loose edges (a lattice's grid, a lathe's profile) are edges with no face — Blender's wire edges.
  const L = mesh.lines;
  if (L) {
    for (let i = 0; i + 1 < L.length; i += 2) {
      const a = L[i]!, b = L[i + 1]!;
      const k = edgeKey(a, b);
      if (a === b || byKey.has(k)) continue;
      byKey.set(k, list.length);
      list.push({ a: Math.min(a, b), b: Math.max(a, b), faces: [] });
    }
  }
  const out = { list, byKey };
  edgeCache.set(mesh, out);
  return out;
}

/** Newell's method — robust for concave and slightly non-planar n-gons. */
export function faceNormal(mesh: MeshData, face: readonly number[]): V3 {
  let nx = 0, ny = 0, nz = 0;
  const p = mesh.positions;
  for (let i = 0; i < face.length; i++) {
    const a = face[i]! * 3;
    const b = face[(i + 1) % face.length]! * 3;
    nx += (p[a + 1]! - p[b + 1]!) * (p[a + 2]! + p[b + 2]!);
    ny += (p[a + 2]! - p[b + 2]!) * (p[a]! + p[b]!);
    nz += (p[a]! - p[b]!) * (p[a + 1]! + p[b + 1]!);
  }
  return normalize3([nx, ny, nz]);
}

export function faceCenter(mesh: MeshData, face: readonly number[]): V3 {
  let x = 0, y = 0, z = 0;
  for (const v of face) {
    x += mesh.positions[v * 3]!;
    y += mesh.positions[v * 3 + 1]!;
    z += mesh.positions[v * 3 + 2]!;
  }
  const n = face.length || 1;
  return [x / n, y / n, z / n];
}

export interface Bounds3 {
  min: V3;
  max: V3;
}

export function meshBounds(mesh: MeshData): Bounds3 {
  const p = mesh.positions;
  if (p.length < 3) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  return { min, max };
}

// ── Triangulation ────────────────────────────────────────────────────────────

/**
 * Triangulate one polygon (indices into the mesh). Triangles and convex
 * polygons fan; concave ones ear-clip in their own plane (dominant-axis
 * projection), which is what keeps an L-shaped extruded face from folding.
 */
export function triangulateFace(mesh: MeshData, face: readonly number[]): number[] {
  const n = face.length;
  if (n < 3) return [];
  if (n === 3) return [face[0]!, face[1]!, face[2]!];
  const normal = faceNormal(mesh, face);
  const ax = Math.abs(normal[0]), ay = Math.abs(normal[1]), az = Math.abs(normal[2]);
  // Project onto the plane most facing the normal, keeping orientation.
  const drop = az >= ax && az >= ay ? 2 : ax >= ay ? 0 : 1;
  const sign = normal[drop]! >= 0 ? 1 : -1;
  const pts = face.map((vi) => {
    const v = [mesh.positions[vi * 3]!, mesh.positions[vi * 3 + 1]!, mesh.positions[vi * 3 + 2]!];
    if (drop === 2) return [v[0]! * sign, v[1]!];
    if (drop === 0) return [v[1]! * sign, v[2]!];
    return [v[2]! * sign, v[0]!];
  });
  if (isConvex(pts)) {
    const out: number[] = [];
    for (let i = 1; i < n - 1; i++) out.push(face[0]!, face[i]!, face[i + 1]!);
    return out;
  }
  return earClip(face, pts);
}

function cross2(o: number[], a: number[], b: number[]): number {
  return (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
}

function isConvex(pts: number[][]): boolean {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    if (cross2(pts[i]!, pts[(i + 1) % n]!, pts[(i + 2) % n]!) < -1e-9) return false;
  }
  return true;
}

function pointInTri(p: number[], a: number[], b: number[], c: number[]): boolean {
  return cross2(a, b, p) >= 0 && cross2(b, c, p) >= 0 && cross2(c, a, p) >= 0;
}

function earClip(face: readonly number[], pts: number[][]): number[] {
  const idx = face.map((_, i) => i);
  const out: number[] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length]!;
      const i1 = idx[i]!;
      const i2 = idx[(i + 1) % idx.length]!;
      const a = pts[i0]!, b = pts[i1]!, c = pts[i2]!;
      if (cross2(a, b, c) <= 1e-12) continue;
      let inside = false;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (pointInTri(pts[j]!, a, b, c)) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      out.push(face[i0]!, face[i1]!, face[i2]!);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    // Degenerate input (self-intersecting): fall back to a fan for the rest.
    if (!clipped) break;
  }
  for (let i = 1; i < idx.length - 1; i++) out.push(face[idx[0]!]!, face[idx[i]!]!, face[idx[i + 1]!]!);
  return out;
}

// ── Render buffers ───────────────────────────────────────────────────────────

/**
 * What a renderer draws: one corner per triangle vertex (non-indexed), so
 * flat and smooth shading and per-face parts are all just attribute values.
 * `triFace` maps each triangle back to its polygon — the picking table that
 * turns a ray hit into "you clicked face 12".
 */
export interface MeshBuffers {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  triFace: Uint32Array;
  /** The mesh vertex each corner came from — what carries per-vertex data (shape-key offsets) onto the corners. */
  corners: Uint32Array;
  /** Triangle ranges per part id ("" = the object's own look), in draw order. */
  groups: Array<{ part: string; start: number; count: number }>;
}

export interface BufferOptions {
  shading: "smooth" | "flat" | "auto";
  /** Degrees — `auto` smooths across edges flatter than this. */
  smoothAngle: number;
  /** How a texture wraps the shape (default box). */
  uv?: "box" | "planar" | "cylinder" | "sphere";
}

/**
 * Triangulate the whole mesh into draw buffers.
 *
 * Normals: per corner, the angle-weighted average of the face normals around
 * the vertex that are within `smoothAngle` of this face (Blender's auto smooth)
 * — `flat` is angle 0, `smooth` is 180. Sharp-marked edges never smooth.
 * UVs: the mesh's own unwrap when it carries one (`hasUv`), else box
 * projection on the face's dominant axis over the mesh bounds.
 */
export function meshBuffers(mesh: MeshData, opts: BufferOptions): MeshBuffers {
  const faceNormals = mesh.faces.map((f) => faceNormal(mesh, f));
  const angle = opts.shading === "flat" ? 0 : opts.shading === "smooth" ? 180 : opts.smoothAngle;
  const cosLimit = Math.cos((Math.min(180, Math.max(0, angle)) * Math.PI) / 180) - 1e-6;

  // vertex → faces around it
  const around: number[][] = Array.from({ length: vertexCount(mesh) }, () => []);
  mesh.faces.forEach((f, fi) => {
    for (const v of f) around[v]?.push(fi);
  });
  const sharp = new Set<string>();
  if (mesh.sharp) for (let i = 0; i + 1 < mesh.sharp.length; i += 2) sharp.add(edgeKey(mesh.sharp[i]!, mesh.sharp[i + 1]!));

  const b = meshBounds(mesh);
  const size: V3 = [
    Math.max(1e-6, b.max[0] - b.min[0]),
    Math.max(1e-6, b.max[1] - b.min[1]),
    Math.max(1e-6, b.max[2] - b.min[2]),
  ];

  // Order faces by part so each part is ONE contiguous draw group.
  const parts = mesh.faceParts;
  const own = hasUv(mesh) ? mesh.uv : null;
  const order = mesh.faces.map((_, i) => i);
  if (parts) order.sort((x, y) => (parts[x] ?? "").localeCompare(parts[y] ?? "") || x - y);

  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const triFace: number[] = [];
  const corners: number[] = [];
  const groups: MeshBuffers["groups"] = [];

  for (const fi of order) {
    const face = mesh.faces[fi]!;
    const tris = triangulateFace(mesh, face);
    if (tris.length === 0) continue;
    const fn = faceNormals[fi]!;
    const part = parts?.[fi] ?? "";
    const last = groups[groups.length - 1];
    const startTri = triFace.length;
    if (!last || last.part !== part) groups.push({ part, start: startTri * 3, count: 0 });
    const ax = Math.abs(fn[0]), ay = Math.abs(fn[1]), az = Math.abs(fn[2]);
    const dom = az >= ax && az >= ay ? 2 : ax >= ay ? 0 : 1;
    for (let t = 0; t < tris.length; t += 3) {
      triFace.push(fi);
      for (let k = 0; k < 3; k++) {
        const v = tris[t + k]!;
        const px = mesh.positions[v * 3]!, py = mesh.positions[v * 3 + 1]!, pz = mesh.positions[v * 3 + 2]!;
        pos.push(px, py, pz);
        corners.push(v);
        // Corner normal.
        let n: V3 = fn;
        if (cosLimit < 1 - 1e-6) {
          let sx = 0, sy = 0, sz = 0;
          for (const of of around[v] ?? []) {
            const on = faceNormals[of]!;
            if (of !== fi && dot(on, fn) < cosLimit) continue;
            if (of !== fi && sharp.size && sharesSharpEdge(mesh, fi, of, v, sharp)) continue;
            const w = cornerAngle(mesh, mesh.faces[of]!, v);
            sx += on[0] * w;
            sy += on[1] * w;
            sz += on[2] * w;
          }
          n = normalize3([sx, sy, sz]);
          if (n[0] === 0 && n[1] === 0 && n[2] === 0) n = fn;
        }
        nor.push(n[0], n[1], n[2]);
        if (own) {
          uv.push(own[v * 2]!, own[v * 2 + 1]!);
          continue;
        }
        const proj = opts.uv ?? "box";
        const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
        const u =
          proj === "planar" ? [(px - b.min[0]) / size[0], (pz - b.min[2]) / size[2]]
          : proj === "cylinder" ? [Math.atan2(py - cy, px - cx) / (2 * Math.PI) + 0.5, (pz - b.min[2]) / size[2]]
          : proj === "sphere" ? [Math.atan2(py - cy, px - cx) / (2 * Math.PI) + 0.5, 0.5 + Math.asin(Math.max(-1, Math.min(1, (pz - cz) / (Math.hypot(px - cx, py - cy, pz - cz) || 1)))) / Math.PI]
          : dom === 2 ? [(px - b.min[0]) / size[0], (py - b.min[1]) / size[1]]
          : dom === 0 ? [(py - b.min[1]) / size[1], (pz - b.min[2]) / size[2]]
          : [(px - b.min[0]) / size[0], (pz - b.min[2]) / size[2]];
        uv.push(u[0]!, u[1]!);
      }
    }
    groups[groups.length - 1]!.count += (triFace.length - startTri) * 3;
  }
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nor),
    uvs: new Float32Array(uv),
    triFace: new Uint32Array(triFace),
    corners: new Uint32Array(corners),
    groups,
  };
}

function sharesSharpEdge(mesh: MeshData, fa: number, fb: number, v: number, sharp: Set<string>): boolean {
  const a = mesh.faces[fa]!;
  const bset = new Set(mesh.faces[fb]!);
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = a[(i + 1) % a.length]!;
    if ((x === v || y === v) && bset.has(x) && bset.has(y) && sharp.has(edgeKey(x, y))) return true;
  }
  return false;
}

/** The interior angle of a face at vertex v — the weight for angle-weighted normals. */
function cornerAngle(mesh: MeshData, face: readonly number[], v: number): number {
  const i = face.indexOf(v);
  if (i < 0) return 0;
  const p = (k: number): V3 => [mesh.positions[k * 3]!, mesh.positions[k * 3 + 1]!, mesh.positions[k * 3 + 2]!];
  const c = p(v);
  const a = normalize3(sub(p(face[(i + face.length - 1) % face.length]!), c));
  const b = normalize3(sub(p(face[(i + 1) % face.length]!), c));
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
}

// ── Whole-mesh operations ────────────────────────────────────────────────────

export function transformMesh(mesh: MeshData, m: Mat4): MeshData {
  const out = cloneMesh(mesh);
  for (let i = 0; i < out.positions.length; i += 3) {
    const p = transformPoint(m, [out.positions[i]!, out.positions[i + 1]!, out.positions[i + 2]!]);
    out.positions[i] = p[0];
    out.positions[i + 1] = p[1];
    out.positions[i + 2] = p[2];
  }
  // A mirroring matrix turns every face inside out — flip the loops back.
  const d = m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
  if (d < 0) out.faces = out.faces.map((f) => f.slice().reverse());
  return out;
}

/** Append `b` to `a` (Ctrl+J). Parts and marks travel with their faces. */
export function joinMeshes(a: MeshData, b: MeshData): MeshData {
  const off = vertexCount(a);
  const anyParts = a.faceParts || b.faceParts;
  const out: MeshData = {
    positions: [...a.positions, ...b.positions],
    faces: [...a.faces.map((f) => f.slice()), ...b.faces.map((f) => f.map((v) => v + off))],
  };
  if (anyParts) {
    out.faceParts = [
      ...(a.faceParts ?? a.faces.map(() => "")),
      ...(b.faceParts ?? b.faces.map(() => "")),
    ];
  }
  if (a.marks || b.marks) out.marks = [...(a.marks ?? []), ...(b.marks ?? []).map((v) => v + off)];
  if (a.sharp || b.sharp) out.sharp = [...(a.sharp ?? []), ...(b.sharp ?? []).map((v) => v + off)];
  if (hasUv(a) || hasUv(b)) {
    const pad = (m: MeshData) => (hasUv(m) ? m.uv : new Array<number>(vertexCount(m) * 2).fill(0));
    out.uv = [...pad(a), ...pad(b)];
  }
  return out;
}

/**
 * Remove vertices no face uses and renumber — every op that deletes ends here,
 * so an orphaned vertex can never linger as an invisible, unclickable point.
 * Keeps vertices listed in `keep` (loose verts the user made on purpose).
 */
export function compactMesh(mesh: MeshData, keep?: ReadonlySet<number>): MeshData {
  const used = new Uint8Array(vertexCount(mesh));
  for (const f of mesh.faces) for (const v of f) used[v] = 1;
  // A loose edge's ends are in use too (a lattice's grid, a lathe's profile).
  if (mesh.lines) for (const v of mesh.lines) if (v < used.length) used[v] = 1;
  if (keep) for (const v of keep) if (v < used.length) used[v] = 1;
  const remap = new Int32Array(used.length).fill(-1);
  const positions: number[] = [];
  const own = hasUv(mesh) ? mesh.uv : null;
  const uv: number[] = [];
  let n = 0;
  for (let i = 0; i < used.length; i++) {
    if (!used[i]) continue;
    remap[i] = n++;
    positions.push(mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!);
    if (own) uv.push(own[i * 2]!, own[i * 2 + 1]!);
  }
  const out: MeshData = { positions, faces: mesh.faces.map((f) => f.map((v) => remap[v]!)) };
  if (own) out.uv = uv;
  if (mesh.faceParts) out.faceParts = mesh.faceParts.slice();
  const remapPairs = (pairs: number[] | undefined): number[] | undefined => {
    if (!pairs) return undefined;
    const r: number[] = [];
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const a = remap[pairs[i]!] ?? -1, b = remap[pairs[i + 1]!] ?? -1;
      if (a >= 0 && b >= 0) r.push(a, b);
    }
    return r.length ? r : undefined;
  };
  const marks = remapPairs(mesh.marks);
  const sharp = remapPairs(mesh.sharp);
  const lines = remapPairs(mesh.lines);
  if (marks) out.marks = marks;
  if (sharp) out.sharp = sharp;
  if (lines) out.lines = lines;
  return out;
}

/**
 * Merge vertices closer than `distance` (Blender's Merge by Distance), drop
 * faces that collapsed below three distinct corners. Returns the new mesh and
 * how many vertices went away.
 */
export function weldMesh(mesh: MeshData, distance = 0.01, only?: ReadonlySet<number>): { mesh: MeshData; removed: number } {
  const n = vertexCount(mesh);
  const target = new Int32Array(n).map((_, i) => i);
  const cell = Math.max(distance, 1e-9);
  const grid = new Map<string, number[]>();
  const keyOf = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  let removed = 0;
  for (let i = 0; i < n; i++) {
    if (only && !only.has(i)) continue;
    const x = mesh.positions[i * 3]!, y = mesh.positions[i * 3 + 1]!, z = mesh.positions[i * 3 + 2]!;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) {
      for (let dy = -1; dy <= 1 && found < 0; dy++) {
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            const ddx = mesh.positions[j * 3]! - x, ddy = mesh.positions[j * 3 + 1]! - y, ddz = mesh.positions[j * 3 + 2]! - z;
            if (ddx * ddx + ddy * ddy + ddz * ddz <= distance * distance) {
              found = j;
              break;
            }
          }
        }
      }
    }
    if (found >= 0) {
      target[i] = found;
      removed++;
    } else {
      const k = keyOf(x, y, z);
      const list = grid.get(k);
      if (list) list.push(i);
      else grid.set(k, [i]);
    }
  }
  if (removed === 0) return { mesh, removed: 0 };
  const out = remapFaces(mesh, target);
  return { mesh: compactMesh(out), removed };
}

/**
 * Point vertices at other vertices (target[i] = the vertex i becomes), then
 * clean every face: consecutive duplicates collapse, faces under three
 * distinct corners disappear. The one primitive behind merge and weld.
 */
export function remapFaces(mesh: MeshData, target: ArrayLike<number>): MeshData {
  const faces: number[][] = [];
  const faceParts: string[] = [];
  mesh.faces.forEach((f, fi) => {
    const loop: number[] = [];
    for (const v of f) {
      const t = target[v]!;
      if (loop[loop.length - 1] !== t) loop.push(t);
    }
    while (loop.length > 1 && loop[0] === loop[loop.length - 1]) loop.pop();
    if (new Set(loop).size < 3) return;
    faces.push(loop);
    faceParts.push(mesh.faceParts?.[fi] ?? "");
  });
  const out: MeshData = { positions: mesh.positions.slice(), faces };
  if (mesh.uv) out.uv = mesh.uv.slice();
  if (mesh.faceParts) out.faceParts = faceParts;
  if (mesh.marks) out.marks = mesh.marks.map((v) => target[v]!);
  if (mesh.sharp) out.sharp = mesh.sharp.map((v) => target[v]!);
  return out;
}

/** Flip a face's winding (its normal points the other way). */
export function flipFaces(mesh: MeshData, faces: ReadonlySet<number> | null): MeshData {
  const out = cloneMesh(mesh);
  out.faces = out.faces.map((f, i) => (faces === null || faces.has(i) ? f.slice().reverse() : f));
  return out;
}

/**
 * Recalculate normals outside: make winding consistent across each connected
 * piece, then flip a piece whose signed volume is negative. (Blender's ⇧N.)
 */
export function recalcNormalsOutside(mesh: MeshData): MeshData {
  const out = cloneMesh(mesh);
  const { list, byKey } = meshEdges(mesh);
  const seen = new Uint8Array(out.faces.length);
  for (let start = 0; start < out.faces.length; start++) {
    if (seen[start]) continue;
    const piece: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const fi = stack.pop()!;
      piece.push(fi);
      const f = out.faces[fi]!;
      for (let i = 0; i < f.length; i++) {
        const a = f[i]!, b = f[(i + 1) % f.length]!;
        const e = list[byKey.get(edgeKey(a, b))!];
        if (!e) continue;
        for (const nf of e.faces) {
          if (seen[nf]) continue;
          seen[nf] = 1;
          // Consistent winding: the neighbour must traverse a→b the other way.
          const g = out.faces[nf]!;
          const j = g.indexOf(a);
          if (j >= 0 && g[(j + 1) % g.length] === b) out.faces[nf] = g.slice().reverse();
          stack.push(nf);
        }
      }
    }
    // Signed volume of the piece (divergence theorem over a triangle fan).
    let vol = 0;
    for (const fi of piece) {
      const tris = triangulateFace(out, out.faces[fi]!);
      for (let t = 0; t < tris.length; t += 3) {
        const p0 = vertexAt(out, tris[t]!), p1 = vertexAt(out, tris[t + 1]!), p2 = vertexAt(out, tris[t + 2]!);
        vol += dot(p0, cross(p1, p2));
      }
    }
    if (vol < 0) for (const fi of piece) out.faces[fi] = out.faces[fi]!.slice().reverse();
  }
  return out;
}

/**
 * REFINE — split every edge longer than `maxEdge` at its middle until none is
 * (triangles, conforming: a midpoint is shared by both faces of its edge), so
 * a deform has vertices to move. A picture card is two triangles and a
 * letter's cap is a fan of slivers; a bend needs points ALONG it. Parts and
 * the unwrap follow (a midpoint takes the average of its edge). Stops at
 * `maxFaces`, whatever is left.
 */
export function refineMesh(mesh: MeshData, maxEdge: number, maxFaces = 40000): MeshData {
  if (!(maxEdge > 0)) return mesh;
  const own = hasUv(mesh);
  const pos = mesh.positions.slice();
  const uv = own ? mesh.uv!.slice() : null;
  let faces: number[][] = [];
  let parts: string[] = [];
  mesh.faces.forEach((f, fi) => {
    const t = triangulateFace(mesh, f);
    for (let i = 0; i < t.length; i += 3) {
      faces.push([t[i]!, t[i + 1]!, t[i + 2]!]);
      parts.push(mesh.faceParts?.[fi] ?? "");
    }
  });
  const limit = maxEdge * maxEdge;
  const len2 = (a: number, b: number) => (pos[a * 3]! - pos[b * 3]!) ** 2 + (pos[a * 3 + 1]! - pos[b * 3 + 1]!) ** 2 + (pos[a * 3 + 2]! - pos[b * 3 + 2]!) ** 2;
  for (let pass = 0; pass < 12 && faces.length < maxFaces; pass++) {
    const mids = new Map<string, number>();
    const mid = (a: number, b: number): number => {
      const k = edgeKey(a, b);
      let m = mids.get(k);
      if (m === undefined) {
        m = pos.length / 3;
        pos.push((pos[a * 3]! + pos[b * 3]!) / 2, (pos[a * 3 + 1]! + pos[b * 3 + 1]!) / 2, (pos[a * 3 + 2]! + pos[b * 3 + 2]!) / 2);
        if (uv) uv.push((uv[a * 2]! + uv[b * 2]!) / 2, (uv[a * 2 + 1]! + uv[b * 2 + 1]!) / 2);
        mids.set(k, m);
      }
      return m;
    };
    // Mark first, over every face, so both sides of an edge agree.
    const long = new Set<string>();
    for (const [a, b, c] of faces) {
      if (len2(a!, b!) > limit) long.add(edgeKey(a!, b!));
      if (len2(b!, c!) > limit) long.add(edgeKey(b!, c!));
      if (len2(c!, a!) > limit) long.add(edgeKey(c!, a!));
    }
    if (long.size === 0) break;
    // Every split edge adds a triangle on each side: stop BEFORE a pass that
    // would overshoot the budget, not after it.
    if (faces.length + long.size * 2 > maxFaces) break;
    const next: number[][] = [];
    const nextParts: string[] = [];
    faces.forEach((tri, fi) => {
      const emit = (...t: number[][]) => {
        for (const x of t) next.push(x), nextParts.push(parts[fi]!);
      };
      // Rotate so the split edges come first: e0 = v0→v1, e1 = v1→v2, e2 = v2→v0.
      let v = tri;
      let mask = 0;
      for (let r = 0; r < 3; r++) {
        mask = (long.has(edgeKey(v[0]!, v[1]!)) ? 1 : 0) | (long.has(edgeKey(v[1]!, v[2]!)) ? 2 : 0) | (long.has(edgeKey(v[2]!, v[0]!)) ? 4 : 0);
        if (mask === 0 || mask === 7 || mask === 1 || mask === 3) break;
        v = [v[1]!, v[2]!, v[0]!];
      }
      const [a, b, c] = v as [number, number, number];
      if (mask === 0) emit([a, b, c]);
      else if (mask === 1) {
        const m = mid(a, b);
        emit([a, m, c], [m, b, c]);
      } else if (mask === 3) {
        const m1 = mid(a, b), m2 = mid(b, c);
        emit([a, m1, m2], [m1, b, m2], [a, m2, c]);
      } else {
        const m1 = mid(a, b), m2 = mid(b, c), m3 = mid(c, a);
        emit([a, m1, m3], [m1, b, m2], [m3, m2, c], [m1, m2, m3]);
      }
    });
    faces = next;
    parts = nextParts;
  }
  const out: MeshData = { positions: pos, faces };
  if (mesh.faceParts) out.faceParts = parts;
  if (uv) out.uv = uv;
  return out;
}

/** Round positions so a saved mesh does not carry float noise (1e-4 units = 1 µm). */
export function quantizeMesh(mesh: MeshData): MeshData {
  return { ...mesh, positions: mesh.positions.map((v) => Math.round(v * 1e4) / 1e4) };
}

export function meshStats(mesh: MeshData): { vertices: number; edges: number; faces: number; triangles: number } {
  let triangles = 0;
  for (const f of mesh.faces) triangles += Math.max(0, f.length - 2);
  return { vertices: vertexCount(mesh), edges: meshEdges(mesh).list.length, faces: mesh.faces.length, triangles };
}
