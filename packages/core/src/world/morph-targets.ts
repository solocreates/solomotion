import type { MeshClip } from "../schema/clips";
import type { MeshData } from "../schema/world";
import type { MeshShapeDelta, ShapeKey } from "../schema/shape-keys";
import { accumulateMesh, sparsifyMesh } from "../shape-keys/delta";
import { meshBuffers, triangulateFace, type MeshBuffers } from "./mesh";
import { mixTerms } from "../shape-keys/mix";

/**
 * glTF MORPH TARGETS ⇄ SHAPE KEYS — the ONE adapter between the interchange
 * format's blendshapes and the document's shape keys (ADR-characters, "Shape
 * keys"). Pure, DOM-free and three.js-free, so tests, workers, agents and the
 * exporter read the same answer.
 *
 * glTF semantics this keeps: a target is a set of per-vertex POSITION offsets
 * relative to the base (never absolute), a mesh's `weights` are the default
 * influences (a node's `weights` override them), names travel in
 * `extras.targetNames`, morphs apply BEFORE skinning — which is the shape-key
 * contract's own order ("evaluated before bones").
 *
 * Axes and units convert HERE and nowhere else (ADR-3d): glTF is Y-up metres,
 * a world is Z-up centimetres, so (x, y, z)ₘ → (x, −z, y)·100 on the way in and
 * back on the way out. A delta is a vector and converts the same way.
 */

/**
 * Keys an import produces. An imported MODEL keeps its offsets in its file
 * (amendment 11: `source.kind = "asset"`, weights only — a model has no
 * vertices in core), keyed by the target's NAME: an avatar's head, teeth and
 * eyes each carry `jawOpen` at a different index, and one weight drives them
 * all. A mesh core owns (a "make editable" import, the round trip in tests)
 * gets `delta` keys, sparse like every stored mesh key.
 */
export type DeltaShapeKey = ShapeKey & { source: { kind: "delta"; delta: MeshShapeDelta } };

export function isMeshDeltaKey(k: ShapeKey): k is DeltaShapeKey {
  return k.source.kind === "delta" && k.source.delta.kind === "mesh";
}

// ── glTF, the parts this needs ───────────────────────────────────────────────

export interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  sparse?: {
    count: number;
    indices: { bufferView: number; byteOffset?: number; componentType: number };
    values: { bufferView: number; byteOffset?: number };
  };
}
export interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
}
export interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  mode?: number;
  targets?: Array<Record<string, number>>;
  extras?: { targetNames?: unknown };
}
export interface GltfMesh {
  name?: string;
  primitives: GltfPrimitive[];
  weights?: number[];
  extras?: { targetNames?: unknown; [k: string]: unknown };
}
export interface GltfNode {
  name?: string;
  mesh?: number;
  weights?: number[];
  children?: number[];
  [k: string]: unknown;
}
export interface GltfAnimation {
  name?: string;
  samplers: Array<{ input: number; output: number; interpolation?: string }>;
  channels: Array<{ sampler: number; target: { node?: number; path: string } }>;
}
export interface GltfJson {
  asset: { version: string; generator?: string };
  scene?: number;
  scenes?: Array<{ nodes?: number[]; name?: string }>;
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: Array<{ byteLength: number; uri?: string }>;
  animations?: GltfAnimation[];
  [k: string]: unknown;
}

/** One glTF file, parsed: its JSON and its binary buffers by index. */
export interface GltfFile {
  json: GltfJson;
  buffers: Uint8Array[];
}

export class GltfError extends Error {}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function readComponent(view: DataView, at: number, type: number, normalized: boolean): number {
  switch (type) {
    case 5126:
      return view.getFloat32(at, true);
    case 5120: {
      const v = view.getInt8(at);
      return normalized ? Math.max(v / 127, -1) : v;
    }
    case 5121: {
      const v = view.getUint8(at);
      return normalized ? v / 255 : v;
    }
    case 5122: {
      const v = view.getInt16(at, true);
      return normalized ? Math.max(v / 32767, -1) : v;
    }
    case 5123: {
      const v = view.getUint16(at, true);
      return normalized ? v / 65535 : v;
    }
    case 5125:
      return view.getUint32(at, true);
  }
  throw new GltfError(`Unknown accessor component type ${type}.`);
}

function bufferViewBytes(file: GltfFile, index: number): { view: DataView; stride: number | undefined } {
  const bv = file.json.bufferViews?.[index];
  if (!bv) throw new GltfError(`Missing bufferView ${index}.`);
  const buf = file.buffers[bv.buffer];
  if (!buf) throw new GltfError(`Missing buffer ${bv.buffer}.`);
  const offset = buf.byteOffset + (bv.byteOffset ?? 0);
  if ((bv.byteOffset ?? 0) + bv.byteLength > buf.byteLength) throw new GltfError(`bufferView ${index} runs past its buffer.`);
  return { view: new DataView(buf.buffer, offset, bv.byteLength), stride: bv.byteStride };
}

/**
 * An accessor's values as floats, `count × components` long: interleaved
 * strides, normalized integers and SPARSE accessors (a base — or zeros when
 * there is no bufferView, the usual shape of a sparse morph target — with the
 * listed elements substituted) all resolved.
 */
export function readAccessor(file: GltfFile, index: number): { values: Float32Array; components: number } {
  const acc = file.json.accessors?.[index];
  if (!acc) throw new GltfError(`Missing accessor ${index}.`);
  const n = COMPONENTS[acc.type];
  const size = BYTES[acc.componentType];
  if (!n || !size) throw new GltfError(`Accessor ${index} has an unknown layout.`);
  const out = new Float32Array(acc.count * n);
  const normalized = !!acc.normalized;
  if (acc.bufferView !== undefined) {
    const { view, stride } = bufferViewBytes(file, acc.bufferView);
    const step = stride ?? n * size;
    const base = acc.byteOffset ?? 0;
    for (let i = 0; i < acc.count; i++) {
      for (let k = 0; k < n; k++) out[i * n + k] = readComponent(view, base + i * step + k * size, acc.componentType, normalized);
    }
  }
  if (acc.sparse && acc.sparse.count > 0) {
    const s = acc.sparse;
    const iv = bufferViewBytes(file, s.indices.bufferView).view;
    const vv = bufferViewBytes(file, s.values.bufferView).view;
    const isz = BYTES[s.indices.componentType];
    if (!isz) throw new GltfError(`Accessor ${index}: bad sparse index type.`);
    for (let j = 0; j < s.count; j++) {
      const at = readComponent(iv, (s.indices.byteOffset ?? 0) + j * isz, s.indices.componentType, false);
      if (at >= acc.count) throw new GltfError(`Accessor ${index}: sparse index ${at} out of range.`);
      for (let k = 0; k < n; k++) out[at * n + k] = readComponent(vv, (s.values.byteOffset ?? 0) + (j * n + k) * size, acc.componentType, normalized);
    }
  }
  return { values: out, components: n };
}

// ── GLB container ────────────────────────────────────────────────────────────

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function decodeDataUri(uri: string): Uint8Array {
  const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(uri);
  if (!m) throw new GltfError("Unreadable data URI buffer.");
  if (!m[1]) return new TextEncoder().encode(decodeURIComponent(m[2]!));
  const bin = atob(m[2]!);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Read a .glb or a .gltf (JSON with data-URI buffers). An external `uri`
 * buffer cannot be resolved from bytes alone: pass `external` (uri → bytes),
 * or the file is refused with a message naming the missing part.
 */
export function readGltf(bytes: Uint8Array | ArrayBuffer, external?: (uri: string) => Uint8Array | null): GltfFile {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let json: GltfJson;
  let bin: Uint8Array | null = null;
  if (u8.byteLength >= 12 && dv.getUint32(0, true) === GLB_MAGIC) {
    const length = Math.min(dv.getUint32(8, true), u8.byteLength);
    let at = 12;
    let text = "";
    while (at + 8 <= length) {
      const len = dv.getUint32(at, true);
      const type = dv.getUint32(at + 4, true);
      const body = u8.subarray(at + 8, at + 8 + len);
      if (type === CHUNK_JSON) text = new TextDecoder().decode(body);
      else if (type === CHUNK_BIN && !bin) bin = body;
      at += 8 + len;
    }
    if (!text) throw new GltfError("This GLB has no JSON chunk.");
    json = JSON.parse(text) as GltfJson;
  } else {
    json = JSON.parse(new TextDecoder().decode(u8)) as GltfJson;
  }
  if (!json || typeof json !== "object" || !json.asset) throw new GltfError("Not a glTF file.");
  const buffers = (json.buffers ?? []).map((b, i) => {
    if (b.uri === undefined) {
      if (i === 0 && bin) return bin;
      throw new GltfError(`Buffer ${i} has no data.`);
    }
    if (b.uri.startsWith("data:")) return decodeDataUri(b.uri);
    const ext = external?.(b.uri);
    if (!ext) throw new GltfError(`This glTF needs "${b.uri}" beside it — export as .glb to keep everything in one file.`);
    return ext;
  });
  return { json, buffers };
}

/** Pack JSON + one binary buffer as a .glb (4-byte aligned chunks, as the spec requires). */
export function writeGlb(json: GltfJson, bin: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = (text.byteLength + 3) & ~3;
  const binLen = (bin.byteLength + 3) & ~3;
  const total = 12 + 8 + jsonLen + (bin.byteLength ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(text, 20);
  for (let i = 20 + text.byteLength; i < 20 + jsonLen; i++) out[i] = 0x20;
  if (bin.byteLength) {
    const at = 20 + jsonLen;
    dv.setUint32(at, binLen, true);
    dv.setUint32(at + 4, CHUNK_BIN, true);
    out.set(bin, at + 8);
  }
  return out;
}

// ── Names and ids ────────────────────────────────────────────────────────────

/** A target's name, or "Key N" (Blender's default) when the file gave none. */
function targetNamesOf(mesh: GltfMesh, count: number): string[] {
  const fromMesh = mesh.extras?.targetNames;
  const fromPrim = mesh.primitives[0]?.extras?.targetNames;
  const raw = Array.isArray(fromMesh) ? fromMesh : Array.isArray(fromPrim) ? fromPrim : [];
  return Array.from({ length: count }, (_, i) => {
    const n = raw[i];
    return typeof n === "string" && n.trim() ? n.trim() : `Key ${i + 1}`;
  });
}

/** Duplicate names get Blender's ".001" suffixes, in order, so every key stays addressable. */
export function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.map((name) => {
    if (!seen.has(name)) {
      seen.add(name);
      return name;
    }
    for (let k = 1; ; k++) {
      const next = `${name}.${String(k).padStart(3, "0")}`;
      if (!seen.has(next)) {
        seen.add(next);
        return next;
      }
    }
  });
}

/**
 * A key's id from its name — deterministic, so an import is reproducible and
 * a round trip compares equal; `key.<id>` stays a readable channel path
 * (`key.jawOpen`, `key.eyeBlink_L`).
 */
export function shapeKeyIdsFor(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base = name.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "key";
    let id = base;
    for (let k = 2; used.has(id); k++) id = `${base}_${k}`;
    used.add(id);
    return id;
  });
}

// ── Import ───────────────────────────────────────────────────────────────────

/** One glTF mesh's base and its targets, in world space (Z up, cm). */
export interface GltfMorphMesh {
  meshIndex: number;
  name: string;
  /** The base as editable polygons (triangles; primitives concatenated in order). */
  mesh: MeshData;
  /** Default weights are each key's resting `value` (absent = 0). */
  keys: DeltaShapeKey[];
}

const toWorld = (x: number, y: number, z: number, k: number): [number, number, number] => [x * k, -z * k, y * k];

function triangleIndices(file: GltfFile, prim: GltfPrimitive, count: number): number[] {
  const mode = prim.mode ?? 4;
  const idx = prim.indices !== undefined ? Array.from(readAccessor(file, prim.indices).values) : Array.from({ length: count }, (_, i) => i);
  if (mode === 4) return idx;
  const out: number[] = [];
  if (mode === 5) for (let i = 0; i + 2 < idx.length; i++) out.push(...(i % 2 ? [idx[i + 1]!, idx[i]!, idx[i + 2]!] : [idx[i]!, idx[i + 1]!, idx[i + 2]!]));
  else if (mode === 6) for (let i = 1; i + 1 < idx.length; i++) out.push(idx[0]!, idx[i]!, idx[i + 1]!);
  return out;
}

/**
 * Every mesh of the file WITH morph targets, as base polygons + dense keys +
 * default weights. Primitives of one mesh share its targets (the spec: every
 * primitive has the same number), so their vertices concatenate and each key
 * spans them all. A target with no POSITION (normals-only) is a zero delta,
 * kept so indices — and the weights animation — still line up.
 */
export function shapeKeysFromGltf(file: GltfFile, opts: { unitScale?: number } = {}): GltfMorphMesh[] {
  const k = opts.unitScale ?? 100;
  const out: GltfMorphMesh[] = [];
  const nodeWeights = new Map<number, number[]>();
  for (const n of file.json.nodes ?? []) if (n.mesh !== undefined && n.weights && !nodeWeights.has(n.mesh)) nodeWeights.set(n.mesh, n.weights);
  (file.json.meshes ?? []).forEach((gm, meshIndex) => {
    const targetCount = Math.max(0, ...gm.primitives.map((p) => p.targets?.length ?? 0));
    if (targetCount === 0) return;
    const positions: number[] = [];
    const faces: number[][] = [];
    const deltas: number[][] = Array.from({ length: targetCount }, () => []);
    for (const prim of gm.primitives) {
      const posAcc = prim.attributes.POSITION;
      if (posAcc === undefined) continue;
      const pos = readAccessor(file, posAcc).values;
      const count = pos.length / 3;
      const first = positions.length / 3;
      for (let i = 0; i < count; i++) positions.push(...toWorld(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!, k));
      const tris = triangleIndices(file, prim, count);
      for (let t = 0; t + 2 < tris.length; t += 3) faces.push([first + tris[t]!, first + tris[t + 1]!, first + tris[t + 2]!]);
      for (let ti = 0; ti < targetCount; ti++) {
        const acc = prim.targets?.[ti]?.POSITION;
        const d = acc !== undefined ? readAccessor(file, acc).values : null;
        if (d && d.length !== count * 3) throw new GltfError(`Mesh "${gm.name ?? meshIndex}": target ${ti} has ${d.length / 3} vertices, the base ${count}.`);
        for (let i = 0; i < count; i++) {
          if (d) deltas[ti]!.push(...toWorld(d[i * 3]!, d[i * 3 + 1]!, d[i * 3 + 2]!, k));
          else deltas[ti]!.push(0, 0, 0);
        }
      }
    }
    const names = uniqueNames(targetNamesOf(gm, targetCount));
    const ids = shapeKeyIdsFor(names);
    const defaults = nodeWeights.get(meshIndex) ?? gm.weights ?? [];
    out.push({
      meshIndex,
      name: gm.name ?? `Mesh ${meshIndex + 1}`,
      mesh: { positions, faces },
      keys: names.map((name, i) => withValue({ id: ids[i]!, name, source: { kind: "delta" as const, delta: sparsifyMesh(deltas[i]!) } }, defaults[i])),
    });
  });
  return out;
}

/**
 * An imported MODEL's keys, for the asset path: one key per distinct target
 * NAME across all its meshes (an avatar's head, teeth and eyes each carry
 * `jawOpen`; one weight drives them all, as in every glTF player), deltas left
 * in the file. A default weight is the largest any mesh declares.
 */
export function fileShapeKeysFromGltf(file: GltfFile): { keys: ShapeKey[]; meshes: number } {
  const order: string[] = [];
  const weightOf = new Map<string, number>();
  const nodeWeights = new Map<number, number[]>();
  for (const n of file.json.nodes ?? []) if (n.mesh !== undefined && n.weights && !nodeWeights.has(n.mesh)) nodeWeights.set(n.mesh, n.weights);
  let meshes = 0;
  (file.json.meshes ?? []).forEach((gm, mi) => {
    const count = Math.max(0, ...gm.primitives.map((p) => p.targets?.length ?? 0));
    if (!count) return;
    meshes++;
    const names = uniqueNames(targetNamesOf(gm, count));
    const defaults = nodeWeights.get(mi) ?? gm.weights ?? [];
    names.forEach((name, i) => {
      if (!weightOf.has(name)) order.push(name);
      const w = Number.isFinite(defaults[i]) ? defaults[i]! : 0;
      weightOf.set(name, Math.max(weightOf.get(name) ?? 0, w));
    });
  });
  const ids = shapeKeyIdsFor(order);
  const keys = order.map((name, i) => withValue({ id: ids[i]!, name, source: { kind: "asset" as const, target: name } }, weightOf.get(name)));
  return { keys, meshes };
}

/** A key with its resting weight — `value` only when the file set one (absent = 0). */
function withValue<K extends ShapeKey>(key: K, w: number | undefined): K {
  return Number.isFinite(w) && w !== 0 ? { ...key, value: w } : key;
}

// ── Export ───────────────────────────────────────────────────────────────────

/** Keyed weights for the file: times in seconds and, per key id, one weight per time. */
export interface WeightsAnimation {
  name?: string;
  times: number[];
  weights: Record<string, number[]>;
}

export interface GltfFromShapeKeysInput {
  name?: string;
  mesh: MeshData;
  /** Mesh delta keys are written; an asset key has nothing to write (its file already holds it). */
  keys: ReadonlyArray<ShapeKey>;
  animation?: WeightsAnimation;
  /** World units per glTF metre (default 100). */
  unitScale?: number;
}

class BinWriter {
  parts: Uint8Array[] = [];
  length = 0;
  views: GltfBufferView[] = [];
  accessors: GltfAccessor[] = [];
  push(data: Float32Array | Uint32Array, target?: number): number {
    while (this.length % 4) (this.parts.push(new Uint8Array(1)), this.length++);
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.views.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    this.parts.push(bytes.slice());
    this.length += bytes.byteLength;
    return this.views.length - 1;
  }
  accessor(data: Float32Array | Uint32Array, type: "SCALAR" | "VEC3", opts: { target?: number; bounds?: boolean } = {}): number {
    const view = this.push(data, opts.target);
    const n = COMPONENTS[type]!;
    const acc: GltfAccessor = { bufferView: view, componentType: data instanceof Float32Array ? 5126 : 5125, count: data.length / n, type };
    if (opts.bounds) {
      const min = Array.from({ length: n }, () => Infinity), max = Array.from({ length: n }, () => -Infinity);
      for (let i = 0; i < data.length; i++) {
        const c = i % n;
        min[c] = Math.min(min[c]!, data[i]!);
        max[c] = Math.max(max[c]!, data[i]!);
      }
      if (data.length === 0) min.fill(0), max.fill(0);
      acc.min = min;
      acc.max = max;
    }
    this.accessors.push(acc);
    return this.accessors.length - 1;
  }
  bytes(): Uint8Array {
    while (this.length % 4) (this.parts.push(new Uint8Array(1)), this.length++);
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) (out.set(p, at), (at += p.byteLength));
    return out;
  }
}

/**
 * A mesh and its shape keys as a self-contained glTF: one node, one mesh,
 * every dense key a morph target (POSITION offsets with the min/max the spec
 * requires), names in `extras.targetNames`, the base weights as the mesh's
 * default `weights`, and — when given — the keyed weights as an animation on
 * the node's `weights` path (LINEAR, sampled; the player interpolates).
 */
export function gltfFromShapeKeys(input: GltfFromShapeKeysInput): GltfFile {
  const k = 1 / (input.unitScale ?? 100);
  const m = input.mesh;
  const count = m.positions.length / 3;
  // Muted keys sit out of the mix, so they sit out of the file too. A key's
  // stored Δ is relative to its reference and the app's mix is the plain sum
  // base + Σ wᵢ·Δᵢ — exactly glTF's — so each target is the key's OWN Δ
  // (never its chain), and the file plays the same shape the app shows.
  const keys = input.keys.filter(isMeshDeltaKey).filter((key) => !key.mute);
  const dense = keys.map((key) => {
    const d = new Float64Array(m.positions.length);
    const delta = key.source.delta;
    if (delta.verts.some((v) => v >= count)) throw new GltfError(`Shape key "${key.name}" moves a vertex the mesh does not have.`);
    accumulateMesh(d, delta, 1);
    return d;
  });
  const fromWorld = (src: ArrayLike<number>): Float32Array => {
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      out[i] = src[i]! * k;
      out[i + 1] = src[i + 2]! * k;
      out[i + 2] = -src[i + 1]! * k;
    }
    return out;
  };
  const w = new BinWriter();
  const pos = w.accessor(fromWorld(m.positions), "VEC3", { target: 34962, bounds: true });
  const tris: number[] = [];
  for (const f of m.faces) tris.push(...triangulateFace(m, f));
  const idx = w.accessor(new Uint32Array(tris), "SCALAR", { target: 34963 });
  const targets = dense.map((d) => ({ POSITION: w.accessor(fromWorld(d), "VEC3", { target: 34962, bounds: true }) }));
  const weights = keys.map((key) => key.value ?? 0);
  const json: GltfJson = {
    asset: { version: "2.0", generator: "SoloMotion engine" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: input.name ?? "Mesh", mesh: 0 }],
    meshes: [
      {
        name: input.name ?? "Mesh",
        primitives: [{ attributes: { POSITION: pos }, indices: idx, mode: 4, ...(targets.length ? { targets } : {}) }],
        ...(targets.length ? { weights, extras: { targetNames: keys.map((key) => key.name) } } : {}),
      },
    ],
  };
  const anim = input.animation;
  if (anim && targets.length && anim.times.length) {
    const times = new Float32Array(anim.times);
    const out = new Float32Array(anim.times.length * keys.length);
    anim.times.forEach((_, ti) => keys.forEach((key, ki) => (out[ti * keys.length + ki] = anim.weights[key.id]?.[ti] ?? weights[ki]!)));
    const input_ = w.accessor(times, "SCALAR", { bounds: true });
    const output = w.accessor(out, "SCALAR");
    json.animations = [{ name: anim.name ?? "Shape keys", samplers: [{ input: input_, output, interpolation: "LINEAR" }], channels: [{ sampler: 0, target: { node: 0, path: "weights" } }] }];
  }
  const bin = w.bytes();
  json.buffers = [{ byteLength: bin.byteLength }];
  json.bufferViews = w.views;
  json.accessors = w.accessors;
  return { json, buffers: [bin] };
}

/**
 * The keyed weights a file carries, per target name: each `weights` channel's
 * samples (times in seconds), for re-keying `key.<id>` after an import.
 */
export function weightsAnimationsFromGltf(file: GltfFile): Array<{ name: string; meshIndex: number; times: number[]; weights: Record<string, number[]> }> {
  const out: Array<{ name: string; meshIndex: number; times: number[]; weights: Record<string, number[]> }> = [];
  for (const anim of file.json.animations ?? []) {
    for (const ch of anim.channels) {
      if (ch.target.path !== "weights" || ch.target.node === undefined) continue;
      const meshIndex = file.json.nodes?.[ch.target.node]?.mesh;
      const gm = meshIndex !== undefined ? file.json.meshes?.[meshIndex] : undefined;
      const sampler = anim.samplers[ch.sampler];
      if (!gm || !sampler || meshIndex === undefined) continue;
      const count = Math.max(0, ...gm.primitives.map((p) => p.targets?.length ?? 0));
      if (!count) continue;
      const times = Array.from(readAccessor(file, sampler.input).values);
      const values = readAccessor(file, sampler.output).values;
      // CUBICSPLINE stores (in-tangent, value, out-tangent) per key; keep the values.
      const cubic = sampler.interpolation === "CUBICSPLINE";
      const ids = shapeKeyIdsFor(uniqueNames(targetNamesOf(gm, count)));
      const weights: Record<string, number[]> = {};
      ids.forEach((id, ki) => (weights[id] = times.map((_, ti) => values[(cubic ? ti * 3 + 1 : ti) * count + ki] ?? 0)));
      out.push({ name: anim.name ?? "Animation", meshIndex, times, weights });
    }
  }
  return out;
}

/**
 * An imported model's morph targets onto its mesh clip, as asset keys with
 * their default weights — what dropping an avatar does. A target the clip
 * already has a key for (same target name) keeps that key, its value and its
 * keyframes; new targets append. Returns the clip's keys.
 */
export function attachFileShapeKeys(clip: MeshClip, file: GltfFile): ShapeKey[] {
  if (clip.geometry.type !== "asset") return clip.shapeKeys ?? [];
  const current = clip.shapeKeys ?? [];
  const have = new Set(current.flatMap((k) => (k.source.kind === "asset" ? [String(k.source.target)] : [])));
  const used = new Set(current.map((k) => k.id));
  const next = [...current];
  for (const k of fileShapeKeysFromGltf(file).keys) {
    if (k.source.kind !== "asset" || have.has(String(k.source.target))) continue;
    let id = k.id;
    for (let n = 2; used.has(id); n++) id = `${k.id}_${n}`;
    used.add(id);
    next.push({ ...k, id });
  }
  clip.shapeKeys = next;
  return next;
}

/** A mesh key's offsets as a dense xyz run over `count` vertices (zeros where unmoved). */
export function denseMeshDelta(delta: MeshShapeDelta, count: number): number[] {
  const out = new Array<number>(count * 3).fill(0);
  accumulateMesh(out, delta, 1);
  return out;
}

/**
 * What an exporter needs to write a mesh clip's DELTA keys as morph targets
 * on the buffers a renderer draws: the BASE drawn as corners (not the
 * morphed shape the viewport shows — the file's weights morph it), one
 * corner-offset run per key, and each key's weight at the instant (`baked`
 * from `bakeClipAt`, so keys and drivers are already in `value`).
 *
 * Null when there is nothing to write, or when a modifier stands between the
 * keys and the picture (its output is not the base's topology; the file then
 * carries the evaluated shape, as before).
 */
export interface MorphExport {
  base: MeshBuffers;
  names: string[];
  ids: string[];
  weights: number[];
  /** xyz per corner, per key — relative offsets (glTF's and three's `morphTargetsRelative`). */
  targets: Float32Array[];
}

export function meshMorphExport(baked: MeshClip): MorphExport | null {
  const g = baked.geometry;
  if (g.type !== "mesh" || baked.modifiers.some((m) => m.enabled)) return null;
  const keys = (baked.shapeKeys ?? []).filter(isMeshDeltaKey).filter((k) => !k.mute);
  if (!keys.length) return null;
  const base = meshBuffers(g.mesh, { shading: baked.shading, smoothAngle: baked.smoothAngle, uv: baked.uv });
  const count = g.mesh.positions.length / 3;
  const targets = keys.map((k) => {
    const dense = denseMeshDelta(k.source.delta, count);
    const out = new Float32Array(base.corners.length * 3);
    base.corners.forEach((v, c) => {
      out[c * 3] = dense[v * 3]!;
      out[c * 3 + 1] = dense[v * 3 + 1]!;
      out[c * 3 + 2] = dense[v * 3 + 2]!;
    });
    return out;
  });
  return { base, names: uniqueNames(keys.map((k) => k.name)), ids: keys.map((k) => k.id), weights: keys.map((k) => k.value ?? 0), targets };
}

/** The weight of each of a baked clip's keys now, by id (for sampling a weights animation). */
export function shapeKeyWeightsNow(baked: MeshClip): Map<string, number> {
  return new Map(mixTerms(baked.shapeKeys, undefined).map((t) => [t.key.id, t.weight]));
}
