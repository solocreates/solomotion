import type { KeyframeValue, LatticeSpec, Modifier, MeshData } from "../schema";
import type { Modulator } from "../schema/modulators";
import { createEffectRegistry, type EffectFieldDef, type EffectTypeDefBase } from "../animation/effect-base";
import { applyModulators } from "../animation/modulators";
import { createId } from "../ids";
import { compactMesh, edgeKey, faceCenter, faceNormal, hasUv, joinMeshes, meshBounds, meshEdges, remapFaces, transformMesh, triangulateFace, vertexCount, weldMesh } from "./mesh";
import { cross, invert4, mul4, normalize3, rotation4, scale4, sub, transformPoint, translate4, type Mat4, type V3 } from "./math";
import { deformAlongCurve } from "./curve-deform";
import { shrinkwrapMesh } from "./shrinkwrap";
import { screwMesh } from "./screw";
import { remeshMesh } from "./remesh";
import { latticeDeform } from "./lattice";
import { scatterOver } from "./scatter";
import { buildPrimitive } from "./primitives";
import { bevelMesh } from "./bevel";

/**
 * MODIFIERS — non-destructive geometry steps: the `geometry` DOMAIN of the one
 * effect registry.
 *
 * Effects process pixels; modifiers process geometry, so they are their own
 * domain and their own stack (ADR-3d) — but they are the same KIND of thing: an
 * ordered list of cards with stable ids, declarative fields and keyframes at
 * `<prefix>.<id>.<field>`. So they are built by `createEffectRegistry`, and
 * everything a stack needs comes with that: the inspector's card stack, the
 * floating editor, presets and looks, copy/paste, multi-selection, the add
 * palette, and the `effects_*` verbs for agents. A new modifier is one entry
 * here and one icon in the web's table.
 *
 * An instance is FLAT, exactly like an effect: `{ id, type, enabled, ...fields }`.
 */

export interface ModifierField extends EffectFieldDef {
  default: number | string;
}

/** A reference to another layer (a path, a surface, a controller). */
const layerRef = (key: string, label: string, hint: string): ModifierField => ({ key, label, kind: "layer", default: "", hint });
/** Where along the axis a deform acts (Blender's Simple Deform limits), in % of the shape's length. */
const limits = (): ModifierField[] => [
  num("from", "From", 0, { min: 0, max: 100, step: 1, unit: "%", group: "limits", hint: "Where along the axis it starts — before this the shape is untouched" }),
  num("to", "To", 100, { min: 0, max: 100, step: 1, unit: "%", group: "limits", hint: "Where it ends — past this the shape carries on rigidly" }),
];
const LIMITS_GROUP = { id: "limits", label: "Limits", collapsed: true };
/** The fraction (0..1) of the limited range a coordinate sits at, clamped. */
const limitFrac = (p: ModifierParams, frac: number): number => {
  const a = Math.min(Number(p.from ?? 0), Number(p.to ?? 100)) / 100;
  const b = Math.max(Number(p.from ?? 0), Number(p.to ?? 100)) / 100;
  return b - a < 1e-6 ? (frac >= b ? 1 : 0) : Math.max(0, Math.min(1, (frac - a) / (b - a)));
};

/**
 * ANOTHER OBJECT, AS THIS ONE SEES IT — what the modifiers that reach out of
 * their own shape read (Curve follows a path, Shrinkwrap hugs a surface, Hook
 * follows a controller). Everything is in THIS object's local space, so a
 * modifier never knows about worlds, parents or cameras.
 */
export interface SceneObject {
  /** That object's space → this object's space, now. */
  matrix: Mat4;
  /** The same at rest (both at the start of the comp) — what a Hook measures motion from. */
  rest?: Mat4;
  /** Its evaluated surface, in its own space (a mesh). */
  mesh: MeshData | null;
  /** Its outline as a polyline in its own space (a path): a curve to follow. */
  path: V3[] | null;
  /** The direction its picture faces, in this object's space (a path's plane normal). */
  facing: V3;
  /** A lattice cage's rest grid (its `mesh` is the grid now). */
  lattice?: LatticeSpec | null;
  /** Changes when anything above does — what a cached stack keys on. */
  key: string;
}

export interface ModifierScene {
  object(id: string, opts?: { rest?: boolean }): SceneObject | null;
}

/** The brightness (0..1) of the picture a body wears, at a vertex's unwrap (layer px) — Displace's source. */
export interface PictureSampler {
  key: string;
  at(u: number, v: number): number;
}

export interface ModifierCtx {
  timeSec: number;
  /** The rest of the world (absent headless: the reaching modifiers pass through). */
  scene?: ModifierScene;
  /** The body's own picture (absent on a mesh). */
  picture?: PictureSampler;
  /** The body's DEPTH, 0 far … 1 near, at the same unwrap — a picture with a depth tracker (Displace › Its depth). */
  depth?: PictureSampler;
}

/** What a stack runs WITH: the world around it, the body's picture, and whether this is the viewport. */
export interface StackEnv {
  scene?: ModifierScene;
  picture?: PictureSampler;
  depth?: PictureSampler;
  /** The interactive viewport: cards switched off for it (`viewport: false`) are skipped. */
  viewport?: boolean;
  /**
   * The object BENDS with a rig (core `rig/world.ts`): skinned before every
   * card, so the stack works on the bent shape. `key` changes exactly when the
   * skin would.
   */
  skin?: { key: string; apply(mesh: MeshData, meshKey: string): MeshData };
}

/** A modifier's resolved values at an instant — every field and toggle, defaults filled. */
export type ModifierParams = Record<string, number | string | boolean>;

export interface ModifierDef extends EffectTypeDefBase<Modifier> {
  fields: ModifierField[];
  /** Defaults of the `toggles` (EffectToggleDef carries no value of its own). */
  toggleDefaults?: Record<string, boolean>;
  /** The result moves with time even with nothing keyed (a running wave). See the registry's `isMoving`. */
  timeDriven?: boolean | ((m: Modifier) => boolean);
  /** Points across the longest side a BODY gets before this runs (a deform wants ~32; displacement more). */
  detail?: number;
  /** The scene objects this card reads (layer fields) need their rest pose too (Hook). */
  readsRest?: boolean;
  apply(mesh: MeshData, p: ModifierParams, ctx: ModifierCtx): MeshData;
}

const num = (key: string, label: string, d: number, extra: Partial<ModifierField> = {}): ModifierField => ({ key, label, kind: "number", default: d, ...extra });
const axis = (d: "x" | "y" | "z" = "z"): ModifierField => ({
  key: "axis",
  label: "Axis",
  kind: "select",
  default: d,
  options: [
    { value: "x", label: "X" },
    { value: "y", label: "Y" },
    { value: "z", label: "Z" },
  ],
});
const AX = { x: 0, y: 1, z: 2 } as const;
const axisIndex = (p: ModifierParams): 0 | 1 | 2 => AX[(p.axis as "x" | "y" | "z") ?? "z"] ?? 2;

/**
 * The axis a mesh is FLAT along, if it clearly is one — a picture card stands
 * in the local XZ plane and is thin along Y; a floor plane is thin along Z. A
 * bend curls toward it and a wave rises along it, so a card curls like a
 * page and ripples like a flag instead of shearing in its own plane. A
 * chunky object (a cube) answers Z, the world's up.
 */
export function flatAxis(mesh: MeshData): 0 | 1 | 2 {
  const b = meshBounds(mesh);
  const ext = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const order = [0, 1, 2].sort((i, j) => ext[i]! - ext[j]!) as Array<0 | 1 | 2>;
  return ext[order[0]!]! < 0.5 * ext[order[1]!]! ? order[0]! : 2;
}

/** A def's fresh instance: every field and toggle at its default. */
function defaultsOf(def: Pick<ModifierDef, "fields" | "toggleDefaults">): ModifierParams {
  const out: ModifierParams = { ...(def.toggleDefaults ?? {}) };
  for (const f of def.fields) out[f.key] = f.default;
  return out;
}

/** One registry row: the def, plus the `create` every kind gets for free. */
function modifier(def: Omit<ModifierDef, "create">): ModifierDef {
  const full: ModifierDef = { ...def, create: () => ({ id: createId("mdf"), type: def.type, enabled: true, ...defaultsOf(def) }) };
  return full;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapVertices(mesh: MeshData, fn: (x: number, y: number, z: number, i: number) => V3): MeshData {
  const pos = mesh.positions.slice();
  for (let i = 0, v = 0; i < pos.length; i += 3, v++) {
    const r = fn(pos[i]!, pos[i + 1]!, pos[i + 2]!, v);
    pos[i] = r[0];
    pos[i + 1] = r[1];
    pos[i + 2] = r[2];
  }
  return { ...mesh, positions: pos };
}

/** Area-weighted vertex normals. */
export function vertexNormals(mesh: MeshData): V3[] {
  const out: V3[] = Array.from({ length: vertexCount(mesh) }, () => [0, 0, 0] as V3);
  for (const f of mesh.faces) {
    const n = faceNormal(mesh, f);
    for (const v of f) {
      out[v]![0] += n[0];
      out[v]![1] += n[1];
      out[v]![2] += n[2];
    }
  }
  return out.map((n) => normalize3(n));
}

/** Catmull–Clark, one level. Boundaries stay put on their curve; parts follow faces. */
export function catmullClark(mesh: MeshData, simple = false): MeshData {
  const P = mesh.positions;
  const nv = vertexCount(mesh);
  const { list: edges, byKey } = meshEdges(mesh);
  const out: number[] = [];
  const facePt = mesh.faces.map((f) => faceCenter(mesh, f));
  const vp = (i: number): V3 => [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!];

  // New positions for original vertices.
  const vFaces: number[][] = Array.from({ length: nv }, () => []);
  mesh.faces.forEach((f, fi) => f.forEach((v) => vFaces[v]!.push(fi)));
  const vEdges: number[][] = Array.from({ length: nv }, () => []);
  edges.forEach((e, ei) => {
    vEdges[e.a]!.push(ei);
    vEdges[e.b]!.push(ei);
  });
  for (let i = 0; i < nv; i++) {
    const p = vp(i);
    if (simple || vEdges[i]!.length === 0) {
      out.push(...p);
      continue;
    }
    const boundary = vEdges[i]!.filter((ei) => edges[ei]!.faces.length === 1);
    if (boundary.length >= 2) {
      // Crease rule on the open border.
      const a = boundary.map((ei) => vp(edges[ei]!.a === i ? edges[ei]!.b : edges[ei]!.a));
      out.push(
        (a[0]![0] + a[1]![0] + 6 * p[0]) / 8,
        (a[0]![1] + a[1]![1] + 6 * p[1]) / 8,
        (a[0]![2] + a[1]![2] + 6 * p[2]) / 8,
      );
      continue;
    }
    const n = vEdges[i]!.length;
    const F: V3 = [0, 0, 0];
    for (const fi of vFaces[i]!) for (let k = 0; k < 3; k++) F[k] = F[k]! + facePt[fi]![k]! / vFaces[i]!.length;
    const R: V3 = [0, 0, 0];
    for (const ei of vEdges[i]!) {
      const e = edges[ei]!;
      const a = vp(e.a), b = vp(e.b);
      for (let k = 0; k < 3; k++) R[k] = R[k]! + (a[k]! + b[k]!) / 2 / n;
    }
    out.push(...([0, 1, 2].map((k) => (F[k]! + 2 * R[k]! + (n - 3) * p[k]!) / n) as V3));
  }
  // Edge points.
  const edgeBase = nv;
  for (const e of edges) {
    const a = vp(e.a), b = vp(e.b);
    if (simple || e.faces.length !== 2) out.push((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    else {
      const f0 = facePt[e.faces[0]!]!, f1 = facePt[e.faces[1]!]!;
      out.push((a[0] + b[0] + f0[0] + f1[0]) / 4, (a[1] + b[1] + f0[1] + f1[1]) / 4, (a[2] + b[2] + f0[2] + f1[2]) / 4);
    }
  }
  // Face points.
  const faceBase = nv + edges.length;
  for (const fp of facePt) out.push(...fp);
  // The unwrap: an original vertex keeps its own, an edge point and a face
  // point take the average of what they were made from — the picture stays
  // pinned where it was while the surface smooths under it.
  let uv: number[] | undefined;
  if (hasUv(mesh)) {
    const U = mesh.uv;
    uv = U.slice(0, nv * 2);
    for (const e of edges) uv.push((U[e.a * 2]! + U[e.b * 2]!) / 2, (U[e.a * 2 + 1]! + U[e.b * 2 + 1]!) / 2);
    for (const f of mesh.faces) {
      let su = 0, sv = 0;
      for (const v of f) (su += U[v * 2]!), (sv += U[v * 2 + 1]!);
      uv.push(su / f.length, sv / f.length);
    }
  }
  const faces: number[][] = [];
  const parts: string[] = [];
  mesh.faces.forEach((f, fi) => {
    const n = f.length;
    for (let i = 0; i < n; i++) {
      const v = f[i]!;
      const next = f[(i + 1) % n]!;
      const prev = f[(i + n - 1) % n]!;
      faces.push([v, edgeBase + byKey.get(edgeKey(v, next))!, faceBase + fi, edgeBase + byKey.get(edgeKey(prev, v))!]);
      parts.push(mesh.faceParts?.[fi] ?? "");
    }
  });
  const res: MeshData = { positions: out, faces };
  if (mesh.faceParts) res.faceParts = parts;
  if (uv) res.uv = uv;
  return res;
}

/** Hash-based value noise in [-1, 1] — deterministic, seedable, dependency-free. */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144665) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}
export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const u = s(xf), v = s(yf), w = s(zf);
  const L = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, seed);
  return L(
    L(L(c(0, 0, 0), c(1, 0, 0), u), L(c(0, 1, 0), c(1, 1, 0), u), v),
    L(L(c(0, 0, 1), c(1, 0, 1), u), L(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

/** What Scatter spreads when it is given no shape: a 20-unit cube. */
const SCATTER_CUBE: MeshData = buildPrimitive("cube", { sizeX: 20, sizeY: 20, sizeZ: 20 })!;

// ── The registry ─────────────────────────────────────────────────────────────

// ── Particles ────────────────────────────────────────────────────────────────

/** A stable random in [0, 1) for (seed, particle, life, channel). */
function rand(seed: number, i: number, life: number, k: number): number {
  let h = Math.imul(seed + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i + 1, 0xc2b2ae35) ^ Math.imul(life + 7, 0x27d4eb2f) ^ Math.imul(k + 13, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

const DIRS: Record<string, V3> = { "+z": [0, 0, 1], "-z": [0, 0, -1], "+x": [1, 0, 0], "-x": [-1, 0, 0], "+y": [0, 1, 0], "-y": [0, -1, 0] };

/**
 * PARTICLES — the mesh becomes the particle, emitted from the object's
 * origin and flown by its force fields: gravity, wind and turbulence. Closed
 * form in time (no simulation state), so every frame is exact on its own: it
 * scrubs, loops, renders in parallel and exports frame-for-frame. A stream
 * keeps `count` alive, each reborn with fresh randoms every lifetime; a burst
 * fires them all at once.
 */
function particles(mesh: MeshData, p: ModifierParams, ctx: ModifierCtx): MeshData {
  const count = Math.max(1, Math.min(2000, Math.round(Number(p.count))));
  const life = Math.max(0.05, Number(p.lifetime));
  const speed = Number(p.speed);
  const spread = (Math.min(180, Math.max(0, Number(p.spread))) * Math.PI) / 180;
  const size = Math.max(0, Number(p.size));
  const shrink = Math.min(1, Math.max(0, Number(p.shrink)));
  const spin = Number(p.spin);
  const seed = Math.round(Number(p.seed));
  const radius = Math.max(0, Number(p.radius));
  const accel: V3 = [Number(p.windX), Number(p.windY), Number(p.gravity)];
  const turb = Number(p.turbulence);
  const turbScale = Math.max(1, Number(p.turbulenceScale));
  const burst = p.mode === "burst";
  const axisDir = DIRS[String(p.direction)] ?? DIRS["+z"]!;
  // A basis around the emission axis, for the cone.
  const helper: V3 = Math.abs(axisDir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize3([axisDir[1] * helper[2] - axisDir[2] * helper[1], axisDir[2] * helper[0] - axisDir[0] * helper[2], axisDir[0] * helper[1] - axisDir[1] * helper[0]]);
  const w: V3 = [axisDir[1] * u[2] - axisDir[2] * u[1], axisDir[2] * u[0] - axisDir[0] * u[2], axisDir[0] * u[1] - axisDir[1] * u[0]];
  const t = ctx.timeSec;
  const nv = vertexCount(mesh);
  const positions: number[] = [];
  const faces: number[][] = [];
  for (let i = 0; i < count; i++) {
    const born = burst ? 0 : (i / count) * life;
    if (t < born) continue;
    const cycle = burst ? 0 : Math.floor((t - born) / life);
    if (burst && t - born >= life) continue;
    const age = t - born - cycle * life;
    const k = age / life;
    const r = (n: number) => rand(seed, i, cycle, n);
    // Direction inside the cone, uniform over the cap.
    const cosT = 1 - r(0) * (1 - Math.cos(spread));
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = r(1) * Math.PI * 2;
    const dir: V3 = [
      axisDir[0] * cosT + (u[0] * Math.cos(phi) + w[0] * Math.sin(phi)) * sinT,
      axisDir[1] * cosT + (u[1] * Math.cos(phi) + w[1] * Math.sin(phi)) * sinT,
      axisDir[2] * cosT + (u[2] * Math.cos(phi) + w[2] * Math.sin(phi)) * sinT,
    ];
    const v = speed * (0.75 + 0.5 * r(2));
    // Born anywhere inside the emitter sphere.
    const er = radius * Math.cbrt(r(3));
    const ea = r(4) * Math.PI * 2, eb = Math.acos(2 * r(5) - 1);
    const start: V3 = [er * Math.sin(eb) * Math.cos(ea), er * Math.sin(eb) * Math.sin(ea), er * Math.cos(eb)];
    const pos: V3 = [
      start[0] + dir[0] * v * age + 0.5 * accel[0] * age * age,
      start[1] + dir[1] * v * age + 0.5 * accel[1] * age * age,
      start[2] + dir[2] * v * age + 0.5 * accel[2] * age * age,
    ];
    if (turb) {
      const n = (o: number) => valueNoise3(pos[0] / turbScale + o, pos[1] / turbScale, pos[2] / turbScale + t * 0.5, seed + i) - 0.5;
      pos[0] += n(0) * turb * age * 2;
      pos[1] += n(31.7) * turb * age * 2;
      pos[2] += n(77.3) * turb * age * 2;
    }
    const grow = Math.min(1, age / Math.max(1e-3, life * 0.06));
    const sc = size * (1 - shrink * k) * grow * (0.7 + 0.6 * r(6));
    if (sc <= 1e-5) continue;
    // Tumble about a random axis.
    const ax = normalize3([r(7) - 0.5, r(8) - 0.5, r(9) - 0.5]);
    const ang = ((spin * (r(10) < 0.5 ? -1 : 1) * age + r(11) * 360) * Math.PI) / 180;
    const c = Math.cos(ang), sn = Math.sin(ang), tt = 1 - c;
    const [x, y, z] = ax;
    const m00 = tt * x * x + c, m01 = tt * x * y - sn * z, m02 = tt * x * z + sn * y;
    const m10 = tt * x * y + sn * z, m11 = tt * y * y + c, m12 = tt * y * z - sn * x;
    const m20 = tt * x * z - sn * y, m21 = tt * y * z + sn * x, m22 = tt * z * z + c;
    const base = positions.length / 3;
    for (let j = 0; j < nv; j++) {
      const px = mesh.positions[j * 3]! * sc, py = mesh.positions[j * 3 + 1]! * sc, pz = mesh.positions[j * 3 + 2]! * sc;
      positions.push(pos[0] + m00 * px + m01 * py + m02 * pz, pos[1] + m10 * px + m11 * py + m12 * pz, pos[2] + m20 * px + m21 * py + m22 * pz);
    }
    for (const f of mesh.faces) faces.push(f.map((v) => v + base));
  }
  const out: MeshData = { positions, faces };
  // Every particle is a copy of the shape, so it wears the shape's own picture.
  if (hasUv(mesh)) out.uv = Array.from({ length: positions.length / 3 / Math.max(1, nv) }, () => mesh.uv!).flat();
  return p.showEmitter === true ? joinMeshes(mesh, out) : out;
}

const DEFS: ModifierDef[] = [
  modifier({
    type: "subdivision",
    category: "generate",
    label: "Subdivision",
    blurb: "Smooth the shape by splitting every face",
    fields: [
      num("levels", "Levels", 2, { min: 0, max: 4, step: 1 }),
      { key: "mode", label: "Mode", kind: "select", default: "smooth", options: [{ value: "smooth", label: "Smooth" }, { value: "simple", label: "Simple" }] },
    ],
    apply(mesh, p) {
      let m = mesh;
      const levels = Math.max(0, Math.min(4, Math.round(Number(p.levels))));
      // Guard the explosion: each level multiplies faces by ~4.
      for (let i = 0; i < levels && m.faces.length < 250000; i++) m = catmullClark(m, p.mode === "simple");
      return m;
    },
  }),
  modifier({
    type: "mirror",
    category: "generate",
    label: "Mirror",
    blurb: "Model one part, get the others — on any of the three axes at once",
    fields: [num("merge", "Weld", 0.5, { min: 0, max: 20, step: 0.1, unit: "u", hint: "Joins the halves where they meet" })],
    toggles: [
      { key: "mirrorX", label: "X", hint: "Mirror across the YZ plane" },
      { key: "mirrorY", label: "Y", hint: "Mirror across the XZ plane" },
      { key: "mirrorZ", label: "Z", hint: "Mirror across the XY plane" },
      { key: "bisect", label: "Bisect", hint: "Cut away what already crosses to the other side first, so the halves meet cleanly" },
      { key: "flip", label: "Flip", hint: "Keep the other side instead" },
    ],
    toggleDefaults: { mirrorX: true, mirrorY: false, mirrorZ: false, bisect: false, flip: false },
    apply(mesh, p) {
      let out = mesh;
      const d = Number(p.merge);
      const sign = p.flip === true ? -1 : 1;
      for (const a of [0, 1, 2] as const) {
        if (p[["mirrorX", "mirrorY", "mirrorZ"][a]!] !== true) continue;
        if (p.bisect === true) out = bisectMesh(out, a, sign);
        const s: V3 = [1, 1, 1];
        s[a] = -1;
        const joined = joinMeshes(out, transformMesh(out, scale4(s)));
        // Weld only the seam: vertices sitting on the mirror plane.
        const seam = new Set<number>();
        for (let i = 0; i < vertexCount(joined); i++) if (Math.abs(joined.positions[i * 3 + a]!) <= d) seam.add(i);
        out = d > 0 ? weldMesh(joined, d, seam).mesh : joined;
      }
      return out;
    },
  }),
  modifier({
    type: "array",
    category: "generate",
    label: "Array",
    blurb: "Repeat the shape in a row or round a circle — each copy turning and scaling a step further",
    fields: [
      {
        key: "mode",
        label: "Layout",
        kind: "select",
        default: "linear",
        options: [
          { value: "linear", label: "Row" },
          { value: "radial", label: "Circle" },
        ],
      },
      num("count", "Count", 3, { min: 1, max: 200, step: 1 }),
      num("relX", "X", 1.1, { min: -4, max: 4, step: 0.05, unit: "×", bipolar: true, group: "relative", hint: "Gap in widths of the shape — 1 is touching", showIf: { key: "mode", equals: ["linear"] } }),
      num("relY", "Y", 0, { min: -4, max: 4, step: 0.05, unit: "×", bipolar: true, group: "relative", showIf: { key: "mode", equals: ["linear"] } }),
      num("relZ", "Z", 0, { min: -4, max: 4, step: 0.05, unit: "×", bipolar: true, group: "relative", showIf: { key: "mode", equals: ["linear"] } }),
      num("offX", "X", 0, { step: 1, unit: "u", group: "constant", hint: "Extra distance in units, on top of the relative gap", showIf: { key: "mode", equals: ["linear"] } }),
      num("offY", "Y", 0, { step: 1, unit: "u", group: "constant", showIf: { key: "mode", equals: ["linear"] } }),
      num("offZ", "Z", 0, { step: 1, unit: "u", group: "constant", showIf: { key: "mode", equals: ["linear"] } }),
      num("radius", "Radius", 400, { min: 0, max: 20000, step: 1, unit: "u", group: "radial", hint: "How far from the centre the copies stand", showIf: { key: "mode", equals: ["radial"] } }),
      num("arc", "Arc", 360, { min: -360, max: 360, step: 1, unit: "°", bipolar: true, group: "radial", hint: "360 closes the ring; less fans them out", showIf: { key: "mode", equals: ["radial"] } }),
      {
        key: "around",
        label: "Around",
        kind: "select",
        default: "z",
        group: "radial",
        options: [
          { value: "z", label: "Z — a carousel" },
          { value: "x", label: "X — a wheel" },
          { value: "y", label: "Y — a ferris wheel" },
        ],
        showIf: { key: "mode", equals: ["radial"] },
      },
      num("rotX", "Turn X", 0, { min: -360, max: 360, step: 1, unit: "°", bipolar: true, group: "step", hint: "Each copy turns this much more than the last, in place" }),
      num("rotY", "Turn Y", 0, { min: -360, max: 360, step: 1, unit: "°", bipolar: true, group: "step" }),
      num("rotZ", "Turn Z", 0, { min: -360, max: 360, step: 1, unit: "°", bipolar: true, group: "step" }),
      num("scaleStep", "Scale", 100, { min: 1, max: 400, step: 1, unit: "%", group: "step", hint: "Each copy is this size of the one before" }),
    ],
    groups: [
      { id: "relative", label: "Spacing" },
      { id: "constant", label: "Offset", collapsed: true },
      { id: "radial", label: "Circle" },
      { id: "step", label: "Each copy" },
    ],
    toggles: [{ key: "merge", label: "Merge where they touch", hint: "Weld copies that meet into one surface" }],
    toggleDefaults: { merge: false },
    apply: arrayOf,
  }),
  modifier({
    type: "solidify",
    category: "generate",
    label: "Solidify",
    blurb: "Give a surface thickness",
    fields: [
      num("thickness", "Thickness", 10, { min: -200, max: 200, step: 0.5, unit: "u", bipolar: true }),
      num("offset", "Offset", -1, { min: -1, max: 1, step: 0.05, bipolar: true, hint: "−1 grows inward, 1 outward, 0 both ways" }),
    ],
    apply(mesh, p) {
      const t = Number(p.thickness);
      const o = Number(p.offset);
      const normals = vertexNormals(mesh);
      const n = vertexCount(mesh);
      const outer = mapVertices(mesh, (x, y, z, i) => {
        const k = ((o + 1) / 2) * t;
        const nn = normals[i]!;
        return [x + nn[0] * k, y + nn[1] * k, z + nn[2] * k];
      });
      const inner = mapVertices(mesh, (x, y, z, i) => {
        const k = ((o - 1) / 2) * t;
        const nn = normals[i]!;
        return [x + nn[0] * k, y + nn[1] * k, z + nn[2] * k];
      });
      const shell = joinMeshes(outer, { ...inner, faces: inner.faces.map((f) => f.slice().reverse()) });
      // Rim: one quad per boundary edge, joining the two skins.
      const { list } = meshEdges(mesh);
      const rims: number[][] = [];
      for (const e of list) {
        if (e.faces.length !== 1) continue;
        const f = mesh.faces[e.faces[0]!]!;
        const i = f.indexOf(e.a);
        const forward = f[(i + 1) % f.length] === e.b;
        const [a, b] = forward ? [e.a, e.b] : [e.b, e.a];
        rims.push([b, a, a + n, b + n]);
      }
      return { ...shell, faces: [...shell.faces, ...rims], faceParts: shell.faceParts ? [...shell.faceParts, ...rims.map(() => "")] : undefined };
    },
  }),
  modifier({
    type: "twist",
    category: "deform",
    label: "Twist",
    blurb: "Wring the shape around an axis",
    fields: [num("angle", "Angle", 90, { min: -720, max: 720, step: 1, unit: "°", bipolar: true }), axis("z"), ...limits()],
    groups: [LIMITS_GROUP],
    apply(mesh, p) {
      const a = axisIndex(p);
      const b = meshBounds(mesh);
      const lo = b.min[a], len = Math.max(1e-6, b.max[a] - b.min[a]);
      const total = (Number(p.angle) * Math.PI) / 180;
      const [u, v] = a === 0 ? [1, 2] : a === 1 ? [2, 0] : [0, 1];
      return mapVertices(mesh, (x, y, z) => {
        const c: V3 = [x, y, z];
        const th = (limitFrac(p, (c[a] - lo) / len) - 0.5) * total;
        const cu = c[u]!, cv = c[v]!;
        c[u] = cu * Math.cos(th) - cv * Math.sin(th);
        c[v] = cu * Math.sin(th) + cv * Math.cos(th);
        return c;
      });
    },
  }),
  modifier({
    type: "bend",
    category: "deform",
    label: "Bend",
    blurb: "Curve the shape along its length",
    fields: [num("angle", "Angle", 90, { min: -360, max: 360, step: 1, unit: "°", bipolar: true }), axis("x"), ...limits()],
    groups: [LIMITS_GROUP],
    apply(mesh, p) {
      const theta = (Number(p.angle) * Math.PI) / 180;
      if (Math.abs(theta) < 1e-6) return mesh;
      const a = axisIndex(p);
      // Bend the `a` axis into an arc toward the side the shape is flat along
      // (a card curls like a page), else toward Z.
      const flat = flatAxis(mesh);
      const up = flat !== a ? flat : a === 2 ? 0 : 2;
      const b = meshBounds(mesh);
      const len = Math.max(1e-6, b.max[a] - b.min[a]);
      // The bent stretch is the limited one; past it the shape carries on
      // straight along the arc's end tangent (Blender's limits).
      const f0 = Math.min(Number(p.from ?? 0), Number(p.to ?? 100)) / 100;
      const f1 = Math.max(Number(p.from ?? 0), Number(p.to ?? 100)) / 100;
      const A0 = b.min[a] + f0 * len, A1 = b.min[a] + f1 * len;
      const L = Math.max(1e-6, A1 - A0);
      // Bent about the shape's centre (as Blender's about the origin), the
      // coordinate clamped to the limits: before them the shape is untouched.
      const mid = (b.max[a] + b.min[a]) / 2;
      const R = L / theta;
      return mapVertices(mesh, (x, y, z) => {
        const c: V3 = [x, y, z];
        const s = c[a] - mid;
        const sc = Math.max(A0 - mid, Math.min(A1 - mid, s));
        const extra = s - sc;
        const h = c[up];
        const phi = sc / R;
        c[a] = mid + (R - h) * Math.sin(phi) + extra * Math.cos(phi);
        c[up] = R - (R - h) * Math.cos(phi) + extra * Math.sin(phi);
        return c;
      });
    },
  }),
  modifier({
    type: "taper",
    category: "deform",
    label: "Taper",
    blurb: "Narrow one end",
    fields: [num("factor", "Factor", -0.5, { min: -1, max: 4, step: 0.01, bipolar: true }), axis("z"), ...limits()],
    groups: [LIMITS_GROUP],
    apply(mesh, p) {
      const a = axisIndex(p);
      const b = meshBounds(mesh);
      const len = Math.max(1e-6, b.max[a] - b.min[a]);
      const f = Number(p.factor);
      return mapVertices(mesh, (x, y, z) => {
        const c: V3 = [x, y, z];
        const k = 1 + f * limitFrac(p, (c[a] - b.min[a]) / len);
        for (let i = 0; i < 3; i++) if (i !== a) c[i] = c[i]! * k;
        return c;
      });
    },
  }),
  modifier({
    type: "wave",
    category: "deform",
    label: "Wave",
    blurb: "A rippling surface — runs on its own",
    fields: [
      num("amplitude", "Height", 10, { min: -200, max: 200, step: 0.5, unit: "u", bipolar: true }),
      num("wavelength", "Wavelength", 100, { min: 1, max: 2000, step: 1, unit: "u" }),
      num("speed", "Speed", 1, { min: -10, max: 10, step: 0.05, unit: "/s", bipolar: true, hint: "Waves per second — 0 holds still" }),
      { key: "direction", label: "Direction", kind: "select", default: "x", options: [{ value: "x", label: "Across" }, { value: "y", label: "Along" }, { value: "radial", label: "From centre" }] },
      num("falloff", "Falloff", 0, { min: 0, max: 20000, step: 1, unit: "u", group: "shape", hint: "The waves die out this far from the centre — 0 runs everywhere" }),
      num("decay", "Decay", 0, { min: 0, max: 1, step: 0.01, group: "shape", hint: "Each wavelength a little lower than the last, as they travel out" }),
      num("phase", "Offset", 0, { min: -1, max: 1, step: 0.01, bipolar: true, group: "shape", hint: "Where the wave starts — key it to push the wave by hand" }),
    ],
    groups: [{ id: "shape", label: "Shape", collapsed: true }],
    timeDriven: (m) => Number(m.speed ?? 1) !== 0,
    apply(mesh, p, ctx) {
      const A = Number(p.amplitude), L = Math.max(1, Number(p.wavelength)), s = Number(p.speed);
      const fall = Number(p.falloff ?? 0), decay = Math.max(0, Math.min(0.999, Number(p.decay ?? 0))), phase = Number(p.phase ?? 0);
      // The surface rises along the axis it is flat in (a floor: Z; a card: its
      // face's normal); the wave runs across or along the other two.
      const n = flatAxis(mesh);
      const [u, v] = n === 0 ? [1, 2] : n === 1 ? [0, 2] : [0, 1];
      return mapVertices(mesh, (x, y, z) => {
        const c: V3 = [x, y, z];
        const d = p.direction === "y" ? c[v]! : p.direction === "radial" ? Math.hypot(c[u]!, c[v]!) : c[u]!;
        let amp = A;
        if (fall > 0) {
          const t = Math.min(1, Math.hypot(c[u]!, c[v]!) / fall);
          amp *= (1 - t * t) * (1 - t * t);
        }
        if (decay > 0) amp *= Math.pow(1 - decay, Math.abs(d) / L);
        c[n] = c[n]! + amp * Math.sin(2 * Math.PI * (d / L - s * ctx.timeSec - phase));
        return c;
      });
    },
  }),
  modifier({
    type: "noise",
    category: "deform",
    label: "Noise",
    blurb: "Organic bumps along the surface",
    fields: [
      num("strength", "Strength", 15, { min: -200, max: 200, step: 0.5, unit: "u", bipolar: true }),
      num("scale", "Scale", 80, { min: 1, max: 2000, step: 1, unit: "u", hint: "Size of the bumps" }),
      num("speed", "Evolve", 0, { min: 0, max: 10, step: 0.05, unit: "/s", hint: "How fast the bumps churn — 0 holds still" }),
      num("seed", "Seed", 1, { min: 0, max: 9999, step: 1 }),
    ],
    timeDriven: (m) => Number(m.speed ?? 0) !== 0,
    apply(mesh, p, ctx) {
      const k = Number(p.strength), sc = Math.max(1, Number(p.scale)), seed = Math.round(Number(p.seed));
      const tz = Number(p.speed) * ctx.timeSec;
      const normals = vertexNormals(mesh);
      return mapVertices(mesh, (x, y, z, i) => {
        const d = valueNoise3(x / sc, y / sc, z / sc + tz, seed) * k;
        const n = normals[i]!;
        return [x + n[0] * d, y + n[1] * d, z + n[2] * d];
      });
    },
  }),
  modifier({
    type: "smooth",
    category: "deform",
    label: "Smooth",
    blurb: "Relax sharp detail",
    fields: [num("factor", "Factor", 0.5, { min: 0, max: 1, step: 0.01 }), num("iterations", "Repeat", 5, { min: 0, max: 50, step: 1 })],
    apply(mesh, p) {
      const f = Number(p.factor);
      const it = Math.max(0, Math.min(100, Math.round(Number(p.iterations))));
      const { list } = meshEdges(mesh);
      const nbr: number[][] = Array.from({ length: vertexCount(mesh) }, () => []);
      for (const e of list) {
        nbr[e.a]!.push(e.b);
        nbr[e.b]!.push(e.a);
      }
      let pos = mesh.positions.slice();
      for (let k = 0; k < it; k++) {
        const next = pos.slice();
        for (let i = 0; i < nbr.length; i++) {
          const ns = nbr[i]!;
          if (!ns.length) continue;
          for (let c = 0; c < 3; c++) {
            let s = 0;
            for (const j of ns) s += pos[j * 3 + c]!;
            next[i * 3 + c] = pos[i * 3 + c]! + (s / ns.length - pos[i * 3 + c]!) * f;
          }
        }
        pos = next;
      }
      return { ...mesh, positions: pos };
    },
  }),
  modifier({
    type: "spherify",
    category: "deform",
    label: "Spherify",
    blurb: "Pull the shape toward a ball",
    fields: [num("factor", "Factor", 0.5, { min: -1, max: 1, step: 0.01, bipolar: true })],
    apply(mesh, p) {
      const f = Number(p.factor);
      const b = meshBounds(mesh);
      const c: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      let r = 0;
      const n = vertexCount(mesh);
      for (let i = 0; i < n; i++) r += Math.hypot(mesh.positions[i * 3]! - c[0], mesh.positions[i * 3 + 1]! - c[1], mesh.positions[i * 3 + 2]! - c[2]);
      r /= Math.max(1, n);
      return mapVertices(mesh, (x, y, z) => {
        const d: V3 = [x - c[0], y - c[1], z - c[2]];
        const l = Math.hypot(...d) || 1;
        const k = 1 + f * (r / l - 1);
        return [c[0] + d[0] * k, c[1] + d[1] * k, c[2] + d[2] * k];
      });
    },
  }),
  modifier({
    type: "triangulate",
    category: "generate",
    label: "Triangulate",
    blurb: "Split every face into triangles",
    fields: [],
    apply(mesh) {
      const faces: number[][] = [];
      const parts: string[] = [];
      mesh.faces.forEach((f, fi) => {
        const t = triangulateFace(mesh, f);
        for (let i = 0; i < t.length; i += 3) {
          faces.push([t[i]!, t[i + 1]!, t[i + 2]!]);
          parts.push(mesh.faceParts?.[fi] ?? "");
        }
      });
      return { ...mesh, faces, ...(mesh.faceParts ? { faceParts: parts } : {}) };
    },
  }),
  modifier({
    type: "particles",
    category: "simulate",
    label: "Particles",
    blurb: "The shape becomes particles — a stream or a burst, flown by gravity, wind and turbulence",
    fields: [
      { key: "mode", label: "Emit", kind: "select", default: "stream", options: [{ value: "stream", label: "Stream" }, { value: "burst", label: "Burst" }] },
      num("count", "Count", 150, { min: 1, max: 2000, step: 1 }),
      num("lifetime", "Lifetime", 2, { min: 0.05, max: 20, step: 0.05, unit: "s" }),
      { key: "direction", label: "Direction", kind: "select", default: "+z", options: [{ value: "+z", label: "Up" }, { value: "-z", label: "Down" }, { value: "+x", label: "+X" }, { value: "-x", label: "−X" }, { value: "+y", label: "+Y" }, { value: "-y", label: "−Y" }] },
      num("speed", "Speed", 300, { min: -3000, max: 3000, step: 1, unit: "u/s", bipolar: true }),
      num("spread", "Spread", 30, { min: 0, max: 180, step: 1, unit: "°", hint: "Cone around the direction — 180 is every way" }),
      num("radius", "Emitter size", 0, { min: 0, max: 1000, step: 1, unit: "u", hint: "Particles are born anywhere inside this ball" }),
      num("size", "Size", 0.15, { min: 0, max: 4, step: 0.01, unit: "×", group: "look", hint: "Of the shape itself — 1 is full size" }),
      num("shrink", "Shrink", 1, { min: 0, max: 1, step: 0.01, group: "look", hint: "How much each one shrinks before it dies" }),
      num("spin", "Spin", 180, { min: -1440, max: 1440, step: 1, unit: "°/s", bipolar: true, group: "look" }),
      num("gravity", "Gravity", -600, { min: -3000, max: 3000, step: 1, unit: "u/s²", bipolar: true, group: "forces" }),
      num("windX", "Wind X", 0, { min: -3000, max: 3000, step: 1, unit: "u/s²", bipolar: true, group: "forces" }),
      num("windY", "Wind Y", 0, { min: -3000, max: 3000, step: 1, unit: "u/s²", bipolar: true, group: "forces" }),
      num("turbulence", "Turbulence", 0, { min: 0, max: 1000, step: 1, unit: "u", group: "forces" }),
      num("turbulenceScale", "Swirl size", 150, { min: 1, max: 2000, step: 1, unit: "u", group: "forces" }),
      num("seed", "Seed", 1, { min: 0, max: 9999, step: 1, group: "look" }),
    ],
    groups: [
      { id: "look", label: "Look" },
      { id: "forces", label: "Forces" },
    ],
    toggles: [{ key: "showEmitter", label: "Show the emitter", hint: "Keep the original shape visible beside its particles" }],
    toggleDefaults: { showEmitter: false },
    timeDriven: true,
    apply: particles,
  }),
  modifier({
    type: "bevel",
    category: "generate",
    label: "Bevel",
    blurb: "Round or chamfer the hard edges — catches light like real objects",
    fields: [
      num("width", "Width", 8, { min: 0, max: 200, step: 0.5, unit: "u" }),
      num("segments", "Segments", 3, { min: 1, max: 8, step: 1, hint: "1 is a flat chamfer, 3 and up a round edge" }),
      num("angle", "Angle limit", 30, { min: 0, max: 180, step: 1, unit: "°", hint: "Only edges sharper than this are bevelled" }),
    ],
    apply: (mesh, p) => bevelMesh(mesh, Number(p.width), Number(p.segments), Number(p.angle)),
  }),
  modifier({
    type: "weld",
    category: "generate",
    label: "Weld",
    blurb: "Merge points closer than a distance — closes seams",
    fields: [num("distance", "Distance", 1, { min: 0, max: 100, step: 0.1, unit: "u" })],
    apply: (mesh, p) => (Number(p.distance) > 0 ? weldMesh(mesh, Number(p.distance)).mesh : mesh),
  }),
  modifier({
    type: "decimate",
    category: "generate",
    label: "Decimate",
    blurb: "Fewer polygons — a lighter mesh, or a faceted low-poly look",
    fields: [num("ratio", "Keep", 0.5, { min: 0.01, max: 1, step: 0.01, hint: "The share of points to keep — 1 changes nothing" })],
    apply: (mesh, p) => decimate(mesh, Number(p.ratio)),
  }),
  modifier({
    type: "wireframe",
    category: "generate",
    label: "Wireframe",
    blurb: "Every edge becomes a strut — the technical, blueprint look",
    fields: [num("thickness", "Thickness", 2, { min: 0.05, max: 100, step: 0.05, unit: "u" })],
    toggles: [{ key: "keepOriginal", label: "Keep the surface", hint: "Draw the struts over the original faces" }],
    toggleDefaults: { keepOriginal: false },
    apply: (mesh, p) => {
      const frame = wireframe(mesh, Number(p.thickness));
      return p.keepOriginal === true ? joinMeshes(mesh, frame) : frame;
    },
  }),
  modifier({
    type: "build",
    category: "generate",
    label: "Build",
    blurb: "Faces appear one by one — key Progress for a build-on",
    fields: [
      num("progress", "Progress", 0.6, { min: 0, max: 1, step: 0.01, hint: "0 is nothing, 1 the whole shape — key it" }),
      {
        key: "order",
        label: "Order",
        kind: "select",
        default: "random",
        options: [
          { value: "random", label: "Random" },
          { value: "x", label: "Left to right" },
          { value: "z", label: "Bottom to top" },
          { value: "radial", label: "From the centre" },
        ],
      },
      num("seed", "Seed", 1, { min: 0, max: 9999, step: 1 }),
    ],
    toggles: [{ key: "reverse", label: "Reverse", hint: "Take the shape apart instead" }],
    toggleDefaults: { reverse: false },
    apply: build,
  }),
  modifier({
    type: "explode",
    category: "simulate",
    label: "Explode",
    blurb: "The surface shatters into its faces, flying and tumbling — key Progress",
    fields: [
      num("progress", "Progress", 0.4, { min: 0, max: 1, step: 0.01, hint: "0 is whole, 1 fully blown apart — key it" }),
      num("distance", "Distance", 300, { min: 0, max: 5000, step: 1, unit: "u", hint: "How far a piece flies along its face" }),
      num("spread", "Spread", 0.5, { min: 0, max: 4, step: 0.01, hint: "Randomness of each piece's path" }),
      num("spin", "Spin", 360, { min: -2880, max: 2880, step: 1, unit: "°", bipolar: true }),
      num("stagger", "Stagger", 0.3, { min: 0, max: 0.95, step: 0.01, hint: "Pieces leave one after another rather than at once" }),
      num("gravity", "Gravity", 0, { min: -3000, max: 3000, step: 1, unit: "u", bipolar: true, hint: "How far pieces fall by the end" }),
      num("seed", "Seed", 1, { min: 0, max: 9999, step: 1 }),
    ],
    apply: explode,
  }),
  modifier({
    type: "curve",
    category: "deform",
    label: "Curve",
    blurb: "Lay the shape along a path — text round a ribbon, a logo riding a loop; key Offset to slide it",
    fields: [
      layerRef("curve", "Path", "A path layer in this world — drawn, pen or a shape made a path"),
      axis("x"),
      num("offset", "Offset", 0, { min: -1, max: 1, step: 0.001, bipolar: true, hint: "Slide along the path — a share of its length; key it to travel" }),
    ],
    toggles: [{ key: "stretch", label: "Stretch to the path", hint: "Fit the shape's whole length to the path's" }],
    toggleDefaults: { stretch: false },
    detail: 48,
    apply(mesh, p, ctx) {
      const target = typeof p.curve === "string" && p.curve ? ctx.scene?.object(p.curve) : null;
      if (!target?.path || target.path.length < 2) return mesh;
      const path = target.path.map((q) => transformPoint(target.matrix, q));
      return deformAlongCurve(mesh, path, target.facing, axisIndex(p), Number(p.offset), p.stretch === true);
    },
  }),
  modifier({
    type: "shrinkwrap",
    category: "deform",
    label: "Shrinkwrap",
    blurb: "Hug another surface — a label onto a bottle, a logo pressed onto a sphere",
    fields: [
      layerRef("target", "Onto", "A mesh in this world to wrap onto"),
      num("offset", "Offset", 1, { min: -500, max: 500, step: 0.5, unit: "u", bipolar: true, hint: "Stand this far off the surface — a little keeps it from flickering" }),
      num("strength", "Strength", 1, { min: 0, max: 1, step: 0.01, hint: "Key it from 0 to 1 to press it on" }),
    ],
    detail: 48,
    apply(mesh, p, ctx) {
      const target = typeof p.target === "string" && p.target ? ctx.scene?.object(p.target) : null;
      if (!target?.mesh) return mesh;
      return shrinkwrapMesh(mesh, transformMesh(target.mesh, target.matrix), Number(p.offset), Number(p.strength));
    },
  }),
  modifier({
    type: "hook",
    category: "deform",
    label: "Hook",
    blurb: "The part of the shape near a controller follows it — pull, stretch and wobble a shape by animating an empty",
    fields: [
      layerRef("target", "Controller", "A controller (or any layer) in this world — where it stands at the start is where it grabs"),
      num("radius", "Reach", 200, { min: 1, max: 20000, step: 1, unit: "u", hint: "How far from the controller points follow" }),
      { key: "falloff", label: "Falloff", kind: "select", default: "smooth", options: [{ value: "smooth", label: "Smooth" }, { value: "linear", label: "Linear" }, { value: "constant", label: "Constant" }] },
      num("strength", "Strength", 1, { min: 0, max: 1, step: 0.01 }),
    ],
    readsRest: true,
    detail: 32,
    apply(mesh, p, ctx) {
      const target = typeof p.target === "string" && p.target ? ctx.scene?.object(p.target, { rest: true }) : null;
      if (!target?.rest) return mesh;
      // How the controller moved since rest, applied where it grabbed.
      const delta = mul4(target.matrix, invert4(target.rest));
      const c: V3 = [target.rest[12]!, target.rest[13]!, target.rest[14]!];
      const R = Math.max(1e-6, Number(p.radius)), k = Number(p.strength);
      const shape = (t: number) => (p.falloff === "constant" ? 1 : p.falloff === "linear" ? 1 - t : (1 - t * t) * (1 - t * t));
      return mapVertices(mesh, (x, y, z) => {
        const t = Math.hypot(x - c[0], y - c[1], z - c[2]) / R;
        if (t >= 1) return [x, y, z];
        const w = k * shape(t);
        const q = transformPoint(delta, [x, y, z]);
        return [x + (q[0] - x) * w, y + (q[1] - y) * w, z + (q[2] - z) * w];
      });
    },
  }),
  modifier({
    type: "scatter",
    category: "generate",
    label: "Scatter",
    blurb: "Copies of another mesh spread over the surface — stars on a planet, confetti on a title; key Count to grow them",
    fields: [
      layerRef("source", "Copies of", "A mesh in this world — or none for small cubes"),
      num("count", "Count", 60, { min: 0, max: 5000, step: 1, hint: "Key it to make copies appear one by one" }),
      num("size", "Size", 1, { min: 0.01, max: 20, step: 0.01, hint: "Times the copy's own size" }),
      num("sizeRandom", "Size variety", 0.4, { min: 0, max: 1, step: 0.01 }),
      num("turnRandom", "Turn variety", 1, { min: 0, max: 1, step: 0.01 }),
      num("offset", "Lift", 0, { min: -1000, max: 1000, step: 0.5, unit: "u", bipolar: true, hint: "How far off the surface they stand" }),
      num("seed", "Seed", 1, { min: 0, max: 9999, step: 1 }),
    ],
    toggles: [
      { key: "align", label: "Stand on the surface", hint: "Each copy stands along the surface — off: turned freely" },
      { key: "keep", label: "Keep the surface", hint: "Off leaves only the copies" },
    ],
    toggleDefaults: { align: true, keep: true },
    apply(mesh, p, ctx) {
      const src = typeof p.source === "string" && p.source ? ctx.scene?.object(p.source) : null;
      const item = src?.mesh ?? SCATTER_CUBE;
      return scatterOver(mesh, item, {
        count: Number(p.count),
        size: Number(p.size),
        sizeRandom: Number(p.sizeRandom),
        turnRandom: Number(p.turnRandom),
        offset: Number(p.offset),
        seed: Math.round(Number(p.seed)),
        align: p.align !== false,
        keep: p.keep !== false,
      });
    },
  }),
  modifier({
    type: "lattice",
    category: "deform",
    label: "Lattice",
    blurb: "Squash, bulge and lean the shape by moving the points of a cage around it — adding one fits the cage for you",
    fields: [
      layerRef("cage", "Cage", "A lattice cage in this world — Tab into it and move its points"),
      {
        key: "interpolation",
        label: "Blend",
        kind: "select",
        default: "smooth",
        options: [
          { value: "smooth", label: "Smooth" },
          { value: "linear", label: "Linear" },
        ],
      },
      num("strength", "Strength", 1, { min: 0, max: 1, step: 0.01, hint: "Key it from 0 to 1 to press the deform in" }),
    ],
    detail: 32,
    apply(mesh, p, ctx) {
      const cage = typeof p.cage === "string" && p.cage ? ctx.scene?.object(p.cage) : null;
      if (!cage?.lattice || !cage.mesh) return mesh;
      return latticeDeform(mesh, cage.mesh.positions, cage.lattice, invert4(cage.matrix), cage.matrix, p.interpolation !== "linear", Number(p.strength));
    },
  }),
  modifier({
    type: "displace",
    category: "deform",
    label: "Displace",
    blurb: "Push the surface out by a picture's brightness or by noise — embossed logos, relief, terrain",
    fields: [
      {
        key: "source",
        label: "By",
        kind: "select",
        default: "picture",
        options: [
          { value: "picture", label: "Its own picture" },
          { value: "depth", label: "Its depth" },
          { value: "noise", label: "Noise" },
        ],
      },
      num("strength", "Strength", 20, { min: -1000, max: 1000, step: 0.5, unit: "u", bipolar: true }),
      num("midlevel", "Midlevel", 0, { min: 0, max: 1, step: 0.01, hint: "The brightness that stays put — 0 pushes everything out, 0.5 dents the dark and lifts the light" }),
      // A relief from depth: which stretch of the picture's depth becomes height, and how it bends.
      num("near", "Near", 0, { min: 0, max: 1, step: 0.005, hint: "The depth that stands tallest — 0 is the nearest thing in the picture", showIf: { key: "source", equals: ["depth"] } }),
      num("far", "Far", 1, { min: 0, max: 1, step: 0.005, hint: "The depth that stays flat", showIf: { key: "source", equals: ["depth"] } }),
      num("curve", "Curve", 1, { min: 0.2, max: 5, step: 0.01, hint: "Bends the relief: under 1 lifts the middle distance, over 1 keeps only the nearest things proud", showIf: { key: "source", equals: ["depth"] } }),
      num("scale", "Noise size", 80, { min: 1, max: 5000, step: 1, unit: "u", showIf: { key: "source", equals: ["noise"] } }),
      num("seed", "Seed", 1, { min: 0, max: 9999, step: 1, showIf: { key: "source", equals: ["noise"] } }),
      { key: "direction", label: "Direction", kind: "select", default: "normal", options: [{ value: "normal", label: "Along the surface" }, { value: "x", label: "X" }, { value: "y", label: "Y" }, { value: "z", label: "Z" }] },
    ],
    detail: 96,
    apply(mesh, p, ctx) {
      const k = Number(p.strength), mid = Number(p.midlevel);
      if (p.source === "depth") {
        // Height from depth: the band near…far mapped to 1…0, bent by the curve.
        if (!ctx.depth || !hasUv(mesh)) return mesh;
        const near = Number(p.near ?? 0), far = Number(p.far ?? 1), curve = Math.max(0.05, Number(p.curve ?? 1));
        const span = Math.max(1e-6, far - near);
        const normals = p.direction === "normal" ? vertexNormals(mesh) : null;
        const dir: V3 | null = p.direction === "x" ? [1, 0, 0] : p.direction === "y" ? [0, 1, 0] : p.direction === "z" ? [0, 0, 1] : null;
        return mapVertices(mesh, (x, y, z, i) => {
          const depth = 1 - ctx.depth!.at(mesh.uv![i * 2]!, mesh.uv![i * 2 + 1]!);
          const h = Math.pow(1 - Math.min(1, Math.max(0, (depth - near) / span)), curve);
          const d = (h - mid) * k;
          const n = dir ?? normals![i]!;
          return [x + n[0] * d, y + n[1] * d, z + n[2] * d];
        });
      }
      const usePicture = p.source !== "noise" && !!ctx.picture && hasUv(mesh);
      const sc = Math.max(1, Number(p.scale)), seed = Math.round(Number(p.seed));
      const normals = p.direction === "normal" ? vertexNormals(mesh) : null;
      const dir: V3 | null = p.direction === "x" ? [1, 0, 0] : p.direction === "y" ? [0, 1, 0] : p.direction === "z" ? [0, 0, 1] : null;
      return mapVertices(mesh, (x, y, z, i) => {
        const h = usePicture ? ctx.picture!.at(mesh.uv![i * 2]!, mesh.uv![i * 2 + 1]!) : valueNoise3(x / sc, y / sc, z / sc, seed) * 0.5 + 0.5;
        const d = (h - mid) * k;
        const n = dir ?? normals![i]!;
        return [x + n[0] * d, y + n[1] * d, z + n[2] * d];
      });
    },
  }),
  modifier({
    type: "screw",
    category: "generate",
    label: "Screw",
    blurb: "Revolve a profile round an axis — a lathe: vases, glasses, bottles; with height, springs and spirals",
    fields: [
      num("angle", "Angle", 360, { min: -3600, max: 3600, step: 1, unit: "°", bipolar: true }),
      num("steps", "Steps", 32, { min: 3, max: 512, step: 1 }),
      num("height", "Height", 0, { min: -20000, max: 20000, step: 1, unit: "u", bipolar: true, hint: "How far it climbs over the whole turn — a spring" }),
      axis("z"),
    ],
    apply: (mesh, p) => screwMesh(mesh, Number(p.angle), Number(p.steps), Number(p.height), axisIndex(p)),
  }),
  modifier({
    type: "remesh",
    category: "generate",
    label: "Remesh",
    blurb: "Rebuild the shape from voxels — blocks for the voxel-art look, smooth for an even, clean surface",
    fields: [
      {
        key: "mode",
        label: "Mode",
        kind: "select",
        default: "blocks",
        options: [
          { value: "blocks", label: "Blocks" },
          { value: "smooth", label: "Smooth" },
        ],
      },
      num("cells", "Detail", 24, { min: 4, max: 96, step: 1, hint: "Cells across the longest side" }),
    ],
    apply: (mesh, p) => remeshMesh(mesh, Number(p.cells), p.mode === "smooth" ? "smooth" : "blocks"),
  }),
];

/** Keep what lies on one side of an axis plane (sign > 0: the positive side), flattening what crosses it onto the plane. */
function bisectMesh(mesh: MeshData, a: 0 | 1 | 2, sign: number): MeshData {
  const P = mesh.positions;
  const pos = P.slice();
  for (let i = a; i < pos.length; i += 3) if (pos[i]! * sign < 0) pos[i] = 0;
  const faces: number[][] = [];
  const parts: string[] = [];
  mesh.faces.forEach((f, fi) => {
    // A face wholly on the far side goes; one that crosses keeps its flattened part.
    if (f.every((v) => P[v * 3 + a]! * sign <= 1e-9) && f.some((v) => P[v * 3 + a]! * sign < -1e-9)) return;
    faces.push(f.slice());
    parts.push(mesh.faceParts?.[fi] ?? "");
  });
  return compactMesh({ ...mesh, positions: pos, faces, ...(mesh.faceParts ? { faceParts: parts } : {}) });
}

// ── Array ────────────────────────────────────────────────────────────────────

/**
 * ARRAY — copies in a ROW (relative gaps in the shape's own size, plus a
 * constant offset: Blender's) or round a CIRCLE about the object's origin
 * (C4D's radial cloner; the first copy stands in front), each copy turned and
 * scaled a step further than the last about its own centre — a staircase, a
 * spiral of cards, a fan, a carousel, a wheel of letters.
 */
function arrayOf(mesh: MeshData, p: ModifierParams): MeshData {
  const count = Math.max(1, Math.min(200, Math.round(Number(p.count))));
  const b = meshBounds(mesh);
  const c: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const rot: V3 = [Number(p.rotX ?? 0), Number(p.rotY ?? 0), Number(p.rotZ ?? 0)];
  const k = Math.max(0.01, Number(p.scaleStep ?? 100) / 100);
  const stepped = rot.some((r) => r !== 0) || k !== 1;
  const radial = p.mode === "radial";
  const step: V3 = [
    (b.max[0] - b.min[0]) * Number(p.relX) + Number(p.offX),
    (b.max[1] - b.min[1]) * Number(p.relY) + Number(p.offY),
    (b.max[2] - b.min[2]) * Number(p.relZ) + Number(p.offZ),
  ];
  const r = Number(p.radius ?? 0);
  const arc = Number(p.arc ?? 360);
  // A closed ring spaces copies by count; an open arc puts one at each end.
  const span = Math.abs(Math.abs(arc) - 360) < 1e-6 || count === 1 ? arc / count : arc / (count - 1);
  const around = p.around === "x" ? 0 : p.around === "y" ? 1 : 2;
  const start: V3 = around === 2 ? [0, -r, 0] : around === 0 ? [0, 0, r] : [r, 0, 0];
  let out: MeshData | null = null;
  for (let i = 0; i < count; i++) {
    // In place first: turn and scale about the copy's own centre.
    let m = stepped
      ? mul4(mul4(translate4(c), mul4(rotation4(rot[0] * i, rot[1] * i, rot[2] * i), scale4([k ** i, k ** i, k ** i]))), translate4([-c[0], -c[1], -c[2]]))
      : null;
    if (radial) {
      const a = span * i;
      const ring = mul4(rotation4(around === 0 ? a : 0, around === 1 ? a : 0, around === 2 ? a : 0), translate4(start));
      m = m ? mul4(ring, m) : ring;
    } else if (i > 0) {
      const t = translate4([step[0] * i, step[1] * i, step[2] * i]);
      m = m ? mul4(t, m) : t;
    }
    const copy = m ? transformMesh(mesh, m) : mesh;
    out = out ? joinMeshes(out, copy) : copy;
  }
  const all = out ?? mesh;
  return p.merge === true ? weldMesh(all, 0.5).mesh : all;
}

// ── Weld, decimate, wireframe, build, explode ────────────────────────────────

/**
 * DECIMATE by vertex clustering: points that share a cell of a grid merge into
 * their average, the cell sized so about `ratio` of the points survive (a few
 * bisection steps on the cell size). Faces that collapse disappear. Cheap and
 * stable, and the facets it leaves are the low-poly look people ask it for.
 */
function decimate(mesh: MeshData, ratio: number): MeshData {
  const n = vertexCount(mesh);
  if (ratio >= 0.999 || n < 8) return mesh;
  const target = Math.max(4, Math.round(n * ratio));
  const b = meshBounds(mesh);
  const span = Math.max(1e-6, b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const P = mesh.positions;
  const cluster = (cell: number) => {
    const ids = new Map<string, number>();
    const of = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const k = `${Math.floor((P[i * 3]! - b.min[0]) / cell)},${Math.floor((P[i * 3 + 1]! - b.min[1]) / cell)},${Math.floor((P[i * 3 + 2]! - b.min[2]) / cell)}`;
      let c = ids.get(k);
      if (c === undefined) ids.set(k, (c = ids.size));
      of[i] = c;
    }
    return { of, count: ids.size };
  };
  let lo = span / 4096, hi = span;
  let best = cluster(lo);
  for (let i = 0; i < 14; i++) {
    const mid = Math.sqrt(lo * hi);
    const c = cluster(mid);
    if (c.count > target) lo = mid;
    else (hi = mid), (best = c);
  }
  // Each cluster collapses onto its first member, moved to the cluster's average.
  const first = new Int32Array(best.count).fill(-1);
  const sum = new Float64Array(best.count * 3);
  const cnt = new Uint32Array(best.count);
  for (let i = 0; i < n; i++) {
    const c = best.of[i]!;
    if (first[c] === -1) first[c] = i;
    sum[c * 3] = sum[c * 3]! + P[i * 3]!;
    sum[c * 3 + 1] = sum[c * 3 + 1]! + P[i * 3 + 1]!;
    sum[c * 3 + 2] = sum[c * 3 + 2]! + P[i * 3 + 2]!;
    cnt[c]!++;
  }
  const target2 = new Int32Array(n);
  for (let i = 0; i < n; i++) target2[i] = first[best.of[i]!]!;
  const out = remapFaces(mesh, target2);
  for (let c = 0; c < best.count; c++) {
    const v = first[c]!;
    out.positions[v * 3] = sum[c * 3]! / cnt[c]!;
    out.positions[v * 3 + 1] = sum[c * 3 + 1]! / cnt[c]!;
    out.positions[v * 3 + 2] = sum[c * 3 + 2]! / cnt[c]!;
  }
  return compactMesh(out);
}

/**
 * WIREFRAME — a square strut along every edge, each a little longer than its
 * edge so neighbours overlap at the joints instead of leaving notches. Struts
 * wear the unwrap of their ends.
 */
function wireframe(mesh: MeshData, thickness: number): MeshData {
  const { list } = meshEdges(mesh);
  const P = mesh.positions;
  const own = hasUv(mesh) ? mesh.uv : null;
  const r = Math.max(0.01, thickness) / 2;
  const positions: number[] = [];
  const uv: number[] = [];
  const faces: number[][] = [];
  for (const e of list) {
    const a: V3 = [P[e.a * 3]!, P[e.a * 3 + 1]!, P[e.a * 3 + 2]!];
    const b: V3 = [P[e.b * 3]!, P[e.b * 3 + 1]!, P[e.b * 3 + 2]!];
    const d = sub(b, a);
    const len = Math.hypot(...d);
    if (len < 1e-9) continue;
    const t = normalize3(d);
    const ref: V3 = Math.abs(t[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const u = normalize3(cross(t, ref));
    const v = cross(t, u);
    const base = positions.length / 3;
    for (const [end, src, s] of [[a, e.a, -r], [b, e.b, r]] as Array<[V3, number, number]>) {
      for (const [cu, cv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        positions.push(
          end[0] + t[0] * s + (u[0] * cu! + v[0] * cv!) * r,
          end[1] + t[1] * s + (u[1] * cu! + v[1] * cv!) * r,
          end[2] + t[2] * s + (u[2] * cu! + v[2] * cv!) * r,
        );
        if (own) uv.push(own[src * 2]!, own[src * 2 + 1]!);
      }
    }
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4;
      faces.push([base + k, base + k1, base + 4 + k1, base + 4 + k]);
    }
    faces.push([base + 3, base + 2, base + 1, base], [base + 4, base + 5, base + 6, base + 7]);
  }
  const out: MeshData = { positions, faces };
  if (own) out.uv = uv;
  return out;
}

/** BUILD — the first `progress` of the faces, in an order: random, a sweep along an axis, or out from the centre. */
function build(mesh: MeshData, p: ModifierParams): MeshData {
  const n = mesh.faces.length;
  const progress = Math.max(0, Math.min(1, Number(p.progress)));
  const keep = Math.round(n * progress);
  if (keep >= n) return mesh;
  const seed = Math.round(Number(p.seed));
  const centres = mesh.faces.map((f) => faceCenter(mesh, f));
  const b = meshBounds(mesh);
  const mid: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const rank = (i: number): number => {
    const c = centres[i]!;
    switch (p.order) {
      case "x":
        return c[0];
      case "z":
        return c[2];
      case "radial":
        return Math.hypot(c[0] - mid[0], c[1] - mid[1], c[2] - mid[2]);
      default:
        return rand(seed, i, 0, 0);
    }
  };
  const order = mesh.faces.map((_, i) => i).sort((x, y) => rank(x) - rank(y) || x - y);
  const chosen = new Set(p.reverse === true ? order.slice(n - keep) : order.slice(0, keep));
  const faces: number[][] = [];
  const parts: string[] = [];
  mesh.faces.forEach((f, i) => {
    if (!chosen.has(i)) return;
    faces.push(f.slice());
    parts.push(mesh.faceParts?.[i] ?? "");
  });
  return compactMesh({ ...mesh, faces, ...(mesh.faceParts ? { faceParts: parts } : {}) });
}

/**
 * EXPLODE — every face becomes its own piece and leaves along its normal,
 * scattered, tumbling and (optionally) falling, each after a stagger of its
 * own. Closed form in `progress`, so it scrubs exactly; keyed 0 → 1 it is
 * the shatter.
 */
function explode(mesh: MeshData, p: ModifierParams): MeshData {
  const progress = Math.max(0, Math.min(1, Number(p.progress)));
  if (progress <= 0) return mesh;
  const dist = Number(p.distance), spread = Number(p.spread), spin = (Number(p.spin) * Math.PI) / 180;
  const stagger = Math.max(0, Math.min(0.95, Number(p.stagger))), gravity = Number(p.gravity);
  const seed = Math.round(Number(p.seed));
  const own = hasUv(mesh) ? mesh.uv : null;
  const P = mesh.positions;
  const positions: number[] = [];
  const uv: number[] = [];
  const faces: number[][] = [];
  const parts: string[] = [];
  mesh.faces.forEach((f, fi) => {
    const delay = rand(seed, fi, 1, 0) * stagger;
    const raw = Math.max(0, Math.min(1, (progress - delay) / Math.max(1e-6, 1 - stagger)));
    // Ease out: pieces burst, then drift.
    const t = 1 - (1 - raw) * (1 - raw);
    const n = faceNormal(mesh, f);
    const c = faceCenter(mesh, f);
    const jitter: V3 = [rand(seed, fi, 1, 1) - 0.5, rand(seed, fi, 1, 2) - 0.5, rand(seed, fi, 1, 3) - 0.5];
    const dir = normalize3([n[0] + jitter[0] * spread * 2, n[1] + jitter[1] * spread * 2, n[2] + jitter[2] * spread * 2]);
    const go = dist * t * (0.6 + 0.8 * rand(seed, fi, 1, 4));
    const off: V3 = [dir[0] * go, dir[1] * go, dir[2] * go - gravity * raw * raw];
    const ax = normalize3([rand(seed, fi, 1, 5) - 0.5, rand(seed, fi, 1, 6) - 0.5, rand(seed, fi, 1, 7) - 0.5]);
    const ang = spin * t * (rand(seed, fi, 1, 8) < 0.5 ? -1 : 1);
    const cs = Math.cos(ang), sn = Math.sin(ang), k = 1 - cs;
    const [x, y, z] = ax;
    const base = positions.length / 3;
    for (const v of f) {
      const q: V3 = [P[v * 3]! - c[0], P[v * 3 + 1]! - c[1], P[v * 3 + 2]! - c[2]];
      positions.push(
        c[0] + off[0] + (k * x * x + cs) * q[0] + (k * x * y - sn * z) * q[1] + (k * x * z + sn * y) * q[2],
        c[1] + off[1] + (k * x * y + sn * z) * q[0] + (k * y * y + cs) * q[1] + (k * y * z - sn * x) * q[2],
        c[2] + off[2] + (k * x * z - sn * y) * q[0] + (k * y * z + sn * x) * q[1] + (k * z * z + cs) * q[2],
      );
      if (own) uv.push(own[v * 2]!, own[v * 2 + 1]!);
    }
    faces.push(f.map((_, i) => base + i));
    parts.push(mesh.faceParts?.[fi] ?? "");
  });
  const out: MeshData = { positions, faces };
  if (mesh.faceParts) out.faceParts = parts;
  if (own) out.uv = uv;
  return out;
}

/** THE modifier registry — the `geometry` domain, keyed at `mdf.<id>.<field>`. */
export const MDF = createEffectRegistry<Modifier, ModifierDef>("geometry", "mdf", DEFS);
/** Every modifier kind, in palette order. */
export const MODIFIERS: readonly ModifierDef[] = MDF.types;

export function modifierDef(type: string): ModifierDef | undefined {
  return MDF.def(type);
}

/** `mdf.<id>.<field>` — the keyframe path grammar for a modifier field (the registry's `path`). */
export const MODIFIER_PATH = /^mdf\.([^.]+)\.(.+)$/;
export const modifierPath = (id: string, field: string): string => MDF.path(id, field);

/** A field or toggle's stored value on an instance, or its default. */
export function modifierValue(m: Modifier, def: Pick<ModifierDef, "fields" | "toggleDefaults">, key: string): number | string | boolean | undefined {
  const f = def.fields.find((x) => x.key === key);
  const fallback = f ? f.default : def.toggleDefaults?.[key];
  const v = m[key];
  return v !== undefined && typeof v === typeof fallback ? v : fallback;
}

/**
 * A modifier's values at an instant: stored → default, then its keyframe, then
 * modulators. Enum fields hold (they are never interpolated); toggles are modes
 * and never key.
 */
export function resolveModifierParams(
  m: Modifier,
  sampled: Record<string, KeyframeValue>,
  modulators: readonly Modulator[] | undefined,
  timeSec: number,
): ModifierParams {
  const def = MDF.def(m.type);
  const out: ModifierParams = {};
  if (!def) return out;
  for (const t of def.toggles ?? []) out[t.key] = modifierValue(m, def, t.key) === true;
  for (const f of def.fields) {
    const path = modifierPath(m.id, f.key);
    let v = modifierValue(m, def, f.key) as number | string;
    const keyed = sampled[path];
    if (keyed !== undefined && typeof keyed === typeof f.default) v = keyed as typeof v;
    if (typeof v === "number") {
      v = applyModulators(modulators, path, v, timeSec, sampled);
      if (f.min !== undefined) v = Math.max(f.min, v);
      if (f.max !== undefined) v = Math.min(f.max, v);
    }
    out[f.key] = v;
  }
  return out;
}

/** Does this stack change over time on its own (independent of keyframes)? */
export function modifiersAnimate(mods: readonly Modifier[]): boolean {
  return mods.some((m) => m.enabled && MDF.isMoving(m));
}

/** Run the stack in order. Disabled and unknown types pass through. */
export function applyModifierStack(
  mesh: MeshData,
  mods: readonly Modifier[],
  sampled: Record<string, KeyframeValue>,
  modulators: readonly Modulator[] | undefined,
  timeSec: number,
  env: Omit<ModifierCtx, "timeSec"> = {},
): MeshData {
  let out = mesh;
  for (const m of mods) {
    if (!m.enabled) continue;
    const enabledKey = sampled[modifierPath(m.id, "enabled")];
    if (enabledKey === false) continue;
    const def = MDF.def(m.type);
    if (!def) continue;
    out = def.apply(out, resolveModifierParams(m, sampled, modulators, timeSec), { timeSec, ...env });
  }
  return out;
}

const stackCache = new Map<string, MeshData>();

/**
 * A base mesh through its modifier stack at an instant — the one place a
 * stack runs, for a mesh and for a layer's body alike. The stack's keyed
 * values must already be baked into its cards (`bakeClipAt`). Cached on the
 * base's `key`, every card's values and — for a stack that runs on its own
 * (a wave, particles) — the time, so a still stack is built once.
 */
export function stackOnto(base: MeshData, key: string, modifiers: readonly Modifier[], localMs: number, env: StackEnv = {}): { key: string; mesh: MeshData } {
  if (env.skin) {
    // The rig first, cached on the skin's own key (pose, weights, placement).
    const k = `${key}|skin:${env.skin.key}`;
    let skinned = stackCache.get(k);
    if (!skinned) {
      skinned = env.skin.apply(base, key);
      if (stackCache.size > 128) stackCache.delete(stackCache.keys().next().value!);
      stackCache.set(k, skinned);
    }
    base = skinned;
    key = k;
  }
  const mods = activeModifiers(modifiers, env);
  if (mods.length === 0) return { key, mesh: base };
  const timeSec = localMs / 1000;
  const modKey = mods
    .map((m) => {
      const def = MDF.def(m.type);
      // What the card READ is part of what it made: the objects it reaches
      // for, and the picture it displaces by.
      const reach = (def?.fields ?? [])
        .filter((f) => f.kind === "layer" && typeof m[f.key] === "string" && m[f.key])
        .map((f) => env.scene?.object(String(m[f.key]), { rest: def?.readsRest })?.key ?? "∅")
        .join(",");
      const pic = m.type === "displace" && m.source === "depth" ? (env.depth?.key ?? "∅") : m.type === "displace" && m.source !== "noise" ? (env.picture?.key ?? "∅") : "";
      return `${m.type}(${Object.entries(m).filter(([k]) => k !== "id" && k !== "type" && k !== "enabled").map(([k, v]) => `${k}=${v}`).join(";")})${reach}${pic}`;
    })
    .join(">");
  const full = `${key}|${modKey}${modifiersAnimate(mods) ? `@${timeSec.toFixed(4)}` : ""}`;
  let out = stackCache.get(full);
  if (!out) {
    out = applyModifierStack(base, mods, {}, undefined, timeSec, { scene: env.scene, picture: env.picture, depth: env.depth });
    if (stackCache.size > 128) stackCache.delete(stackCache.keys().next().value!);
    stackCache.set(full, out);
  }
  return { key: full, mesh: out };
}

/** The cards that run here: switched on, and — in the viewport — not hidden from it. */
export function activeModifiers(modifiers: readonly Modifier[], env: { viewport?: boolean } = {}): Modifier[] {
  return modifiers.filter((m) => m.enabled && !(env.viewport && m.viewport === false));
}

/** Does the stack bend the surface (and so want points along it to bend)? */
export function stackDeforms(modifiers: readonly Modifier[]): boolean {
  return modifiers.some((m) => m.enabled && MDF.def(m.type)?.category === "deform");
}

/** How many points across the longest side a body wants before its stack runs (0 = leave it as it is). */
export function stackDetail(modifiers: readonly Modifier[]): number {
  let n = 0;
  for (const m of modifiers) {
    if (!m.enabled) continue;
    const def = MDF.def(m.type);
    if (def?.category === "deform") n = Math.max(n, def.detail ?? 32);
  }
  return n;
}
