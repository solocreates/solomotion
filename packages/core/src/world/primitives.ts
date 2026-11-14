import type { MeshData } from "../schema/world";
import { recalcNormalsOutside, weldMesh } from "./mesh";

/**
 * THE PRIMITIVES — parametric meshes, one registry entry each.
 *
 * A primitive stays parametric (Cinema 4D's model) until you edit its
 * polygons: its size, segments and fillet are ordinary animatable values
 * (`geometry.<param>`), so a box that grows, a torus that thickens or a cube
 * whose corners round over a second is a keyframe, not a rebuild. Adding a
 * primitive is one entry here — the add menu, the inspector, the API catalog
 * and the agent skill all read this list.
 *
 * All primitives are Z-up, centred on their origin, faces counter-clockwise
 * from outside. 1 unit = 1 px = 1 cm, so the default cube (200) matches C4D's.
 */

export interface PrimitiveParam {
  key: string;
  label: string;
  default: number;
  min?: number;
  max?: number;
  step?: number;
  /** Rounded to an integer before building (segment counts). */
  int?: boolean;
  unit?: string;
}

export interface PrimitiveDef {
  id: string;
  label: string;
  /** Icon hint for menus (a lucide-ish name the web app maps). */
  icon: string;
  params: PrimitiveParam[];
  build(p: Record<string, number>): MeshData;
}

const size = (key: string, label: string, d: number): PrimitiveParam => ({ key, label, default: d, min: 0.01, step: 1, unit: "u" });
const segs = (key: string, label: string, d: number, min = 1, max = 256): PrimitiveParam => ({ key, label, default: d, min, max, step: 1, int: true });

// ── Builders ─────────────────────────────────────────────────────────────────

class Builder {
  positions: number[] = [];
  faces: number[][] = [];
  v(x: number, y: number, z: number): number {
    this.positions.push(x, y, z);
    return this.positions.length / 3 - 1;
  }
  f(...idx: number[]): void {
    this.faces.push(idx);
  }
  mesh(): MeshData {
    return { positions: this.positions, faces: this.faces };
  }
}

/** Distribute coordinates across [-h, h], crowding toward the ends inside a fillet. */
function axisStops(h: number, r: number, segments: number, filletSegs: number): number[] {
  if (r <= 1e-9) return Array.from({ length: segments + 1 }, (_, i) => -h + (2 * h * i) / segments);
  const inner = h - r;
  const out: number[] = [];
  for (let k = 0; k < filletSegs; k++) out.push(-inner - r * Math.sin(((filletSegs - k) / filletSegs) * (Math.PI / 2)));
  for (let i = 0; i <= segments; i++) out.push(-inner + (2 * inner * i) / segments);
  for (let k = filletSegs - 1; k >= 0; k--) out.push(inner + r * Math.sin(((filletSegs - k) / filletSegs) * (Math.PI / 2)));
  return out;
}

function buildBox(p: Record<string, number>): MeshData {
  const hx = p.sizeX! / 2, hy = p.sizeY! / 2, hz = p.sizeZ! / 2;
  const r = Math.max(0, Math.min(p.fillet!, hx, hy, hz));
  const fs = Math.max(1, Math.round(p.filletSegments!));
  const sx = axisStops(hx, r, Math.max(1, Math.round(p.segmentsX ?? p.segments!)), fs);
  const sy = axisStops(hy, r, Math.max(1, Math.round(p.segmentsY ?? p.segments!)), fs);
  const sz = axisStops(hz, r, Math.max(1, Math.round(p.segmentsZ ?? p.segments!)), fs);
  const b = new Builder();
  // Each side: (u axis, v axis, fixed axis, sign) with u × v = outward normal.
  const sides: Array<{ u: 0 | 1 | 2; v: 0 | 1 | 2; w: 0 | 1 | 2; sign: 1 | -1 }> = [
    { u: 1, v: 2, w: 0, sign: 1 },
    { u: 2, v: 1, w: 0, sign: -1 },
    { u: 2, v: 0, w: 1, sign: 1 },
    { u: 0, v: 2, w: 1, sign: -1 },
    { u: 0, v: 1, w: 2, sign: 1 },
    { u: 1, v: 0, w: 2, sign: -1 },
  ];
  const stops = [sx, sy, sz];
  const half = [hx, hy, hz];
  for (const s of sides) {
    const us = stops[s.u]!, vs = stops[s.v]!;
    const grid: number[][] = [];
    for (let i = 0; i < us.length; i++) {
      grid.push([]);
      for (let j = 0; j < vs.length; j++) {
        const c = [0, 0, 0];
        c[s.u] = us[i]!;
        c[s.v] = vs[j]!;
        c[s.w] = half[s.w]! * s.sign;
        grid[i]!.push(b.v(c[0]!, c[1]!, c[2]!));
      }
    }
    for (let i = 0; i < us.length - 1; i++) {
      for (let j = 0; j < vs.length - 1; j++) {
        b.f(grid[i]![j]!, grid[i + 1]![j]!, grid[i + 1]![j + 1]!, grid[i]![j + 1]!);
      }
    }
  }
  let mesh = weldMesh(b.mesh(), Math.max(1e-4, Math.min(hx, hy, hz) * 1e-5)).mesh;
  if (r > 0) {
    const ix = hx - r, iy = hy - r, iz = hz - r;
    const pos = mesh.positions.slice();
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i]!, y = pos[i + 1]!, z = pos[i + 2]!;
      const cx = Math.max(-ix, Math.min(ix, x)), cy = Math.max(-iy, Math.min(iy, y)), cz = Math.max(-iz, Math.min(iz, z));
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const l = Math.hypot(dx, dy, dz);
      if (l > 1e-9) {
        pos[i] = cx + (dx / l) * r;
        pos[i + 1] = cy + (dy / l) * r;
        pos[i + 2] = cz + (dz / l) * r;
      }
    }
    mesh = { ...mesh, positions: pos };
  }
  return mesh;
}

function buildPlane(p: Record<string, number>): MeshData {
  const b = new Builder();
  const nx = Math.max(1, Math.round(p.segmentsX ?? p.segments!));
  const ny = Math.max(1, Math.round(p.segmentsY ?? p.segments!));
  const w = p.sizeX!, h = p.sizeY!;
  const grid: number[][] = [];
  for (let i = 0; i <= nx; i++) {
    grid.push([]);
    for (let j = 0; j <= ny; j++) grid[i]!.push(b.v(-w / 2 + (w * i) / nx, -h / 2 + (h * j) / ny, 0));
  }
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) b.f(grid[i]![j]!, grid[i + 1]![j]!, grid[i + 1]![j + 1]!, grid[i]![j + 1]!);
  return b.mesh();
}

function buildCircle(p: Record<string, number>): MeshData {
  const b = new Builder();
  const n = Math.max(3, Math.round(p.vertices!));
  const ring: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push(b.v(Math.cos(a) * p.radius!, Math.sin(a) * p.radius!, 0));
  }
  b.f(...ring);
  return b.mesh();
}

/** A lathe: rings of (radius, z) profile points around Z; poles where radius is 0. */
function lathe(profile: Array<[number, number]>, sides: number, capBottom: boolean, capTop: boolean): MeshData {
  const b = new Builder();
  const rings: number[][] = profile.map(([r, z]) => {
    if (r <= 1e-9) return [b.v(0, 0, z)];
    const ring: number[] = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      ring.push(b.v(Math.cos(a) * r, Math.sin(a) * r, z));
    }
    return ring;
  });
  // Profile runs bottom → top, so (ring k, ring k+1) quads wind outward as
  // [k_i, k_i+1, (k+1)_i+1, (k+1)_i].
  for (let k = 0; k < rings.length - 1; k++) {
    const A = rings[k]!, B = rings[k + 1]!;
    for (let i = 0; i < sides; i++) {
      const i1 = (i + 1) % sides;
      if (A.length === 1 && B.length === 1) continue;
      if (A.length === 1) b.f(A[0]!, B[i1]!, B[i]!);
      else if (B.length === 1) b.f(A[i]!, A[i1]!, B[0]!);
      else b.f(A[i]!, A[i1]!, B[i1]!, B[i]!);
    }
  }
  const first = rings[0]!, last = rings[rings.length - 1]!;
  if (capBottom && first.length > 1) b.f(...first.slice().reverse());
  if (capTop && last.length > 1) b.f(...last);
  return b.mesh();
}

/**
 * A UV sphere — or, with `arc` under 180°, the CAP of one around its bottom
 * pole, open at its rim: a shell (a lid over an eye, a dome, a bowl).
 */
function buildUvSphere(p: Record<string, number>): MeshData {
  const rings = Math.max(2, Math.round(p.rings!));
  const span = (Math.max(1, Math.min(180, p.arc ?? 180)) * Math.PI) / 180;
  const prof: Array<[number, number]> = [];
  for (let j = 0; j <= rings; j++) {
    const phi = Math.PI - (j / rings) * span;
    prof.push([Math.sin(phi) * p.radius!, Math.cos(phi) * p.radius!]);
  }
  return lathe(prof, Math.max(3, Math.round(p.segments!)), false, false);
}

function buildIcoSphere(p: Record<string, number>): MeshData {
  const t = (1 + Math.sqrt(5)) / 2;
  let pts: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
    [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  let faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const levels = Math.max(0, Math.min(6, Math.round(p.subdivisions!)));
  for (let l = 0; l < levels; l++) {
    const mid = new Map<string, number>();
    const m = (a: number, b: number) => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      let i = mid.get(k);
      if (i === undefined) {
        i = pts.length;
        pts.push([(pts[a]![0]! + pts[b]![0]!) / 2, (pts[a]![1]! + pts[b]![1]!) / 2, (pts[a]![2]! + pts[b]![2]!) / 2]);
        mid.set(k, i);
      }
      return i;
    };
    const next: number[][] = [];
    for (const [a, b, c] of faces as Array<[number, number, number]>) {
      const ab = m(a, b), bc = m(b, c), ca = m(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  pts = pts.map((q) => {
    const l = Math.hypot(q[0]!, q[1]!, q[2]!);
    return [(q[0]! / l) * p.radius!, (q[1]! / l) * p.radius!, (q[2]! / l) * p.radius!];
  });
  return { positions: pts.flat(), faces };
}

function buildCylinder(p: Record<string, number>): MeshData {
  const h = p.depth! / 2;
  return lathe([[p.radius!, -h], [p.radius!, h]], Math.max(3, Math.round(p.vertices!)), true, true);
}

function buildCone(p: Record<string, number>): MeshData {
  const h = p.depth! / 2;
  return lathe([[p.radius1!, -h], [Math.max(0, p.radius2!), h]], Math.max(3, Math.round(p.vertices!)), true, true);
}

function buildPyramid(p: Record<string, number>): MeshData {
  const sides = Math.max(3, Math.round(p.sides!));
  // Rotate so a four-sided pyramid's base edges sit square to the axes.
  const m = lathe([[(p.base! / 2) * Math.SQRT2, -p.height! / 2], [0, p.height! / 2]], sides, true, false);
  if (sides !== 4) return m;
  const pos = m.positions.slice();
  const c = Math.cos(Math.PI / 4), s = Math.sin(Math.PI / 4);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i]!, y = pos[i + 1]!;
    pos[i] = x * c - y * s;
    pos[i + 1] = x * s + y * c;
  }
  return { ...m, positions: pos };
}

function buildCapsule(p: Record<string, number>): MeshData {
  const r = p.radius!, half = Math.max(0, p.length!) / 2;
  const rings = Math.max(2, Math.round(p.rings!));
  const prof: Array<[number, number]> = [];
  for (let j = 0; j <= rings; j++) {
    const phi = Math.PI - (j / rings) * (Math.PI / 2);
    prof.push([Math.sin(phi) * r, Math.cos(phi) * r - half]);
  }
  for (let j = 0; j <= rings; j++) {
    const phi = Math.PI / 2 - (j / rings) * (Math.PI / 2);
    prof.push([Math.sin(phi) * r, Math.cos(phi) * r + half]);
  }
  return lathe(prof, Math.max(3, Math.round(p.segments!)), false, false);
}

function buildTorus(p: Record<string, number>): MeshData {
  const b = new Builder();
  const nu = Math.max(3, Math.round(p.majorSegments!));
  const nv = Math.max(3, Math.round(p.minorSegments!));
  const R = p.majorRadius!, r = p.minorRadius!;
  const grid: number[][] = [];
  for (let i = 0; i < nu; i++) {
    const th = (i / nu) * Math.PI * 2;
    grid.push([]);
    for (let j = 0; j < nv; j++) {
      const ph = (j / nv) * Math.PI * 2;
      grid[i]!.push(b.v((R + r * Math.cos(ph)) * Math.cos(th), (R + r * Math.cos(ph)) * Math.sin(th), r * Math.sin(ph)));
    }
  }
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const i1 = (i + 1) % nu, j1 = (j + 1) % nv;
      b.f(grid[i]![j]!, grid[i1]![j]!, grid[i1]![j1]!, grid[i]![j1]!);
    }
  }
  return b.mesh();
}

function buildTube(p: Record<string, number>): MeshData {
  const b = new Builder();
  const n = Math.max(3, Math.round(p.vertices!));
  const ro = p.outerRadius!, ri = Math.min(p.innerRadius!, ro * 0.999), h = p.depth! / 2;
  const ring = (r: number, z: number) => Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return b.v(Math.cos(a) * r, Math.sin(a) * r, z);
  });
  const ob = ring(ro, -h), ot = ring(ro, h), it = ring(ri, h), ib = ring(ri, -h);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    b.f(ob[i]!, ob[j]!, ot[j]!, ot[i]!);
    b.f(ot[i]!, ot[j]!, it[j]!, it[i]!);
    b.f(it[i]!, it[j]!, ib[j]!, ib[i]!);
    b.f(ib[i]!, ib[j]!, ob[j]!, ob[i]!);
  }
  return b.mesh();
}

function buildTorusKnot(p: Record<string, number>): MeshData {
  const b = new Builder();
  const nu = Math.max(8, Math.round(p.segments!));
  const nv = Math.max(3, Math.round(p.tubeSegments!));
  const P = Math.max(1, Math.round(p.p!)), Q = Math.max(1, Math.round(p.q!));
  const R = p.radius!, tube = p.tube!;
  const curve = (u: number): [number, number, number] => {
    const cu = Math.cos(u), su = Math.sin(u), quOverP = (Q / P) * u, cs = Math.cos(quOverP);
    return [R * (2 + cs) * 0.5 * cu, R * (2 + cs) * 0.5 * su, R * Math.sin(quOverP) * 0.5];
  };
  const grid: number[][] = [];
  for (let i = 0; i < nu; i++) {
    const u = (i / nu) * P * Math.PI * 2;
    const p1 = curve(u), p2 = curve(u + 0.01);
    const T = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
    const N0 = [p2[0] + p1[0], p2[1] + p1[1], p2[2] + p1[2]];
    const B = [T[1]! * N0[2]! - T[2]! * N0[1]!, T[2]! * N0[0]! - T[0]! * N0[2]!, T[0]! * N0[1]! - T[1]! * N0[0]!];
    const N = [B[1]! * T[2]! - B[2]! * T[1]!, B[2]! * T[0]! - B[0]! * T[2]!, B[0]! * T[1]! - B[1]! * T[0]!];
    const lb = Math.hypot(B[0]!, B[1]!, B[2]!) || 1, ln = Math.hypot(N[0]!, N[1]!, N[2]!) || 1;
    grid.push([]);
    for (let j = 0; j < nv; j++) {
      const v = (j / nv) * Math.PI * 2;
      const cx = -tube * Math.cos(v), cy = tube * Math.sin(v);
      grid[i]!.push(
        b.v(
          p1[0] + cx * (N[0]! / ln) + cy * (B[0]! / lb),
          p1[1] + cx * (N[1]! / ln) + cy * (B[1]! / lb),
          p1[2] + cx * (N[2]! / ln) + cy * (B[2]! / lb),
        ),
      );
    }
  }
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const i1 = (i + 1) % nu, j1 = (j + 1) % nv;
      b.f(grid[i]![j]!, grid[i1]![j]!, grid[i1]![j1]!, grid[i]![j1]!);
    }
  }
  return b.mesh();
}

/** Closed primitives get their winding proven outward rather than trusted. */
const closed = (build: (p: Record<string, number>) => MeshData) => (p: Record<string, number>) => recalcNormalsOutside(build(p));

export const PRIMITIVES: PrimitiveDef[] = [
  {
    id: "cube",
    label: "Cube",
    icon: "box",
    params: [
      size("sizeX", "Size X", 200), size("sizeY", "Size Y", 200), size("sizeZ", "Size Z", 200),
      { key: "fillet", label: "Fillet", default: 0, min: 0, step: 1, unit: "u" },
      segs("filletSegments", "Steps", 4, 1, 32),
      segs("segments", "Segments", 1, 1, 64),
    ],
    build: closed(buildBox),
  },
  {
    id: "plane",
    label: "Plane",
    icon: "square",
    params: [size("sizeX", "Size X", 200), size("sizeY", "Size Y", 200), segs("segments", "Segments", 1, 1, 256)],
    build: buildPlane,
  },
  {
    id: "grid",
    label: "Grid",
    icon: "grid",
    params: [size("sizeX", "Size X", 200), size("sizeY", "Size Y", 200), segs("segments", "Segments", 10, 1, 256)],
    build: buildPlane,
  },
  {
    id: "circle",
    label: "Circle",
    icon: "circle",
    params: [size("radius", "Radius", 100), segs("vertices", "Vertices", 32, 3, 512)],
    build: buildCircle,
  },
  {
    id: "uvSphere",
    label: "UV Sphere",
    icon: "globe",
    params: [
      size("radius", "Radius", 100),
      segs("segments", "Segments", 32, 3, 256),
      segs("rings", "Rings", 16, 2, 128),
      { key: "arc", label: "Arc", default: 180, min: 1, max: 180, step: 1, unit: "°" },
    ],
    build: (p) => ((p.arc ?? 180) >= 180 ? closed(buildUvSphere)(p) : buildUvSphere(p)),
  },
  {
    id: "icoSphere",
    label: "Ico Sphere",
    icon: "hexagon",
    params: [size("radius", "Radius", 100), segs("subdivisions", "Detail", 2, 0, 6)],
    build: closed(buildIcoSphere),
  },
  {
    id: "cylinder",
    label: "Cylinder",
    icon: "cylinder",
    params: [size("radius", "Radius", 100), size("depth", "Depth", 200), segs("vertices", "Vertices", 32, 3, 256)],
    build: closed(buildCylinder),
  },
  {
    id: "cone",
    label: "Cone",
    icon: "cone",
    params: [
      size("radius1", "Base radius", 100),
      { key: "radius2", label: "Top radius", default: 0, min: 0, step: 1, unit: "u" },
      size("depth", "Depth", 200),
      segs("vertices", "Vertices", 32, 3, 256),
    ],
    build: closed(buildCone),
  },
  {
    id: "pyramid",
    label: "Pyramid",
    icon: "triangle",
    params: [size("base", "Base", 200), size("height", "Height", 200), segs("sides", "Sides", 4, 3, 64)],
    build: closed(buildPyramid),
  },
  {
    id: "torus",
    label: "Torus",
    icon: "donut",
    params: [
      size("majorRadius", "Major radius", 100), size("minorRadius", "Minor radius", 25),
      segs("majorSegments", "Around", 48, 3, 256), segs("minorSegments", "Tube sides", 12, 3, 128),
    ],
    build: closed(buildTorus),
  },
  {
    id: "capsule",
    label: "Capsule",
    icon: "pill",
    params: [size("radius", "Radius", 50), { key: "length", label: "Length", default: 100, min: 0, step: 1, unit: "u" }, segs("segments", "Segments", 32, 3, 256), segs("rings", "Cap rings", 8, 2, 64)],
    build: closed(buildCapsule),
  },
  {
    id: "tube",
    label: "Tube",
    icon: "circle-dot",
    params: [size("outerRadius", "Outer radius", 100), size("innerRadius", "Inner radius", 70), size("depth", "Depth", 200), segs("vertices", "Vertices", 32, 3, 256)],
    build: closed(buildTube),
  },
  {
    id: "torusKnot",
    label: "Torus Knot",
    icon: "infinity",
    params: [
      size("radius", "Radius", 100), size("tube", "Tube", 20),
      segs("p", "P", 2, 1, 20), segs("q", "Q", 3, 1, 20),
      segs("segments", "Segments", 128, 8, 1024), segs("tubeSegments", "Tube sides", 12, 3, 64),
    ],
    build: closed(buildTorusKnot),
  },
];

const byId = new Map(PRIMITIVES.map((p) => [p.id, p]));

export function primitiveDef(id: string): PrimitiveDef | undefined {
  return byId.get(id);
}

/** The param values a primitive is built from: stored ones over registry defaults, clamped. */
export function primitiveParams(def: PrimitiveDef, params: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of def.params) {
    let v = params[p.key];
    if (typeof v !== "number" || !Number.isFinite(v)) v = p.default;
    if (p.min !== undefined) v = Math.max(p.min, v);
    if (p.max !== undefined) v = Math.min(p.max, v);
    if (p.int) v = Math.round(v);
    out[p.key] = v;
  }
  return out;
}

const buildCache = new Map<string, MeshData>();

/** Build (memoised by id + params — a 300-frame playback of a still cube builds it once). */
export function buildPrimitive(id: string, params: Record<string, number>): MeshData | null {
  const def = byId.get(id);
  if (!def) return null;
  const p = primitiveParams(def, params);
  const key = `${id}|${def.params.map((x) => p[x.key]).join(",")}`;
  let mesh = buildCache.get(key);
  if (!mesh) {
    mesh = def.build(p);
    if (buildCache.size > 256) buildCache.delete(buildCache.keys().next().value!);
    buildCache.set(key, mesh);
  }
  return mesh;
}
