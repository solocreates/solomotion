import { describe, expect, it } from "vitest";
import { createMeshClip } from "./ops";
import {
  attachFileShapeKeys,
  denseMeshDelta,
  fileShapeKeysFromGltf,
  gltfFromShapeKeys,
  readAccessor,
  readGltf,
  shapeKeysFromGltf,
  uniqueNames,
  weightsAnimationsFromGltf,
  writeGlb,
  type DeltaShapeKey,
  type GltfJson,
} from "./morph-targets";

const dense = (k: DeltaShapeKey, n: number) => denseMeshDelta(k.source.delta, n);
const weightsOf = (keys: ReadonlyArray<{ id: string; value?: number }>) => Object.fromEntries(keys.map((k) => [k.id, k.value ?? 0]));

/** Floats → base64 data URI, the way a hand-written .gltf embeds its buffer. */
function dataUri(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `data:application/octet-stream;base64,${btoa(s)}`;
}

function concat(parts: Array<Float32Array | Uint16Array | Uint32Array>): { bin: Uint8Array; offsets: number[] } {
  const offsets: number[] = [];
  let len = 0;
  for (const p of parts) {
    len = (len + 3) & ~3;
    offsets.push(len);
    len += p.byteLength;
  }
  const bin = new Uint8Array((len + 3) & ~3);
  parts.forEach((p, i) => bin.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), offsets[i]!));
  return { bin, offsets };
}

/**
 * A one-triangle mesh (glTF metres, Y up) with two targets: "jawOpen" moves
 * vertex 2 down 0.1 m; "smile" moves vertices 0 and 1 up 0.02 m.
 */
function handBuilt(opts: { names?: unknown; weights?: number[] } = {}): GltfJson {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const t0 = new Float32Array([0, 0, 0, 0, 0, 0, 0, -0.1, 0]);
  const t1 = new Float32Array([0, 0.02, 0, 0, 0.02, 0, 0, 0, 0]);
  const idx = new Uint16Array([0, 1, 2, 0]); // padded to 4 bytes
  const { bin, offsets } = concat([pos, t0, t1, idx]);
  const view = (i: number, len: number) => ({ buffer: 0, byteOffset: offsets[i]!, byteLength: len });
  return {
    asset: { version: "2.0" },
    buffers: [{ byteLength: bin.byteLength, uri: dataUri(bin) }],
    bufferViews: [view(0, 36), view(1, 36), view(2, 36), view(3, 6)],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    meshes: [
      {
        name: "Face",
        primitives: [{ attributes: { POSITION: 0 }, indices: 3, targets: [{ POSITION: 1 }, { POSITION: 2 }] }],
        weights: opts.weights ?? [0.25, 0],
        ...(opts.names === undefined ? { extras: { targetNames: ["jawOpen", "smile"] } } : { extras: { targetNames: opts.names } }),
      },
    ],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  };
}

const bytesOf = (json: GltfJson) => new TextEncoder().encode(JSON.stringify(json));

describe("glTF morph targets → shape keys", () => {
  it("reads names, deltas (Y-up m → Z-up cm) and default weights", () => {
    const [m] = shapeKeysFromGltf(readGltf(bytesOf(handBuilt())));
    expect(m!.keys.map((k) => k.name)).toEqual(["jawOpen", "smile"]);
    expect(m!.keys.map((k) => k.id)).toEqual(["jawOpen", "smile"]);
    expect(m!.keys.every((k) => k.source.kind === "delta" && k.source.delta.kind === "mesh")).toBe(true);
    // Sparse: "jawOpen" moves only vertex 2.
    expect(m!.keys[0]!.source.delta.verts).toEqual([2]);
    // glTF (0, 1, 0) m = up = world +Z 100 cm.
    expect(m!.mesh.positions.slice(6, 9).map((v) => v + 0)).toEqual([0, 0, 100]);
    expect(dense(m!.keys[0]!, 3).slice(6, 9).map((v) => Math.round(v * 1000) / 1000 + 0)).toEqual([0, 0, -10]);
    expect(m!.mesh.faces).toEqual([[0, 1, 2]]);
    expect(weightsOf(m!.keys)).toEqual({ jawOpen: 0.25, smile: 0 });
  });

  it("round-trips: import → export → import is equal", () => {
    const a = shapeKeysFromGltf(readGltf(bytesOf(handBuilt())))[0]!;
    const exported = gltfFromShapeKeys({ name: "Face", mesh: a.mesh, keys: a.keys });
    const glb = writeGlb(exported.json, exported.buffers[0]!);
    const b = shapeKeysFromGltf(readGltf(glb))[0]!;
    expect(b.keys.map((k) => [k.id, k.name])).toEqual(a.keys.map((k) => [k.id, k.name]));
    expect(weightsOf(b.keys)).toEqual(weightsOf(a.keys));
    expect(b.mesh.faces).toEqual(a.mesh.faces);
    b.mesh.positions.forEach((v, i) => expect(v).toBeCloseTo(a.mesh.positions[i]!, 4));
    b.keys.forEach((k, ki) => dense(k, 3).forEach((v, i) => expect(v).toBeCloseTo(dense(a.keys[ki]!, 3)[i]!, 4)));
    // The spec requires POSITION bounds on the base and on every target.
    for (const t of exported.json.meshes![0]!.primitives[0]!.targets!) expect(exported.json.accessors![t.POSITION!]!.min).toBeDefined();
    expect(exported.json.meshes![0]!.extras!.targetNames).toEqual(["jawOpen", "smile"]);
  });

  it("writes keyed weights as a weights animation and reads them back", () => {
    const a = shapeKeysFromGltf(readGltf(bytesOf(handBuilt())))[0]!;
    const out = gltfFromShapeKeys({ mesh: a.mesh, keys: a.keys, animation: { times: [0, 0.5, 1], weights: { jawOpen: [0, 1, 0] } } });
    const ch = out.json.animations![0]!.channels[0]!;
    expect(ch.target.path).toBe("weights");
    const back = weightsAnimationsFromGltf(readGltf(writeGlb(out.json, out.buffers[0]!)))[0]!;
    expect(back.times).toEqual([0, 0.5, 1]);
    expect(back.weights.jawOpen).toEqual([0, 1, 0]);
    // An unkeyed key holds its base weight through the animation.
    expect(back.weights.smile).toEqual([0, 0, 0]);
  });

  it("names a target with no name 'Key N' and suffixes duplicates Blender-style", () => {
    const missing = shapeKeysFromGltf(readGltf(bytesOf(handBuilt({ names: [] }))))[0]!;
    expect(missing.keys.map((k) => k.name)).toEqual(["Key 1", "Key 2"]);
    const dup = shapeKeysFromGltf(readGltf(bytesOf(handBuilt({ names: ["Mouth", "Mouth"] }))))[0]!;
    expect(dup.keys.map((k) => k.name)).toEqual(["Mouth", "Mouth.001"]);
    expect(new Set(dup.keys.map((k) => k.id)).size).toBe(2);
    expect(uniqueNames(["a", "a", "a.001", "a"])).toEqual(["a", "a.001", "a.001.001", "a.002"]);
    const odd = shapeKeysFromGltf(readGltf(bytesOf(handBuilt({ names: [42, "  "] }))))[0]!;
    expect(odd.keys.map((k) => k.name)).toEqual(["Key 1", "Key 2"]);
  });

  it("node weights override mesh weights", () => {
    const j = handBuilt();
    j.nodes![0]!.weights = [0, 0.75];
    expect(weightsOf(shapeKeysFromGltf(readGltf(bytesOf(j)))[0]!.keys)).toEqual({ jawOpen: 0, smile: 0.75 });
  });

  it("resolves a SPARSE target with no bufferView (zeros + substitutions)", () => {
    const j = handBuilt();
    // Target 0 becomes sparse: only vertex 2 moves, (0, -0.1, 0).
    const idx = new Uint8Array([2, 0, 0, 0]);
    const vals = new Float32Array([0, -0.1, 0]);
    const { bin, offsets } = concat([new Float32Array(new Uint8Array(readGltf(bytesOf(j)).buffers[0]!).buffer), new Float32Array(idx.buffer), vals]);
    j.buffers = [{ byteLength: bin.byteLength, uri: dataUri(bin) }];
    j.bufferViews!.push({ buffer: 0, byteOffset: offsets[1]!, byteLength: 1 }, { buffer: 0, byteOffset: offsets[2]!, byteLength: 12 });
    j.accessors![1] = {
      componentType: 5126,
      count: 3,
      type: "VEC3",
      sparse: { count: 1, indices: { bufferView: 4, componentType: 5121 }, values: { bufferView: 5 } },
    };
    const file = readGltf(bytesOf(j));
    expect(Array.from(readAccessor(file, 1).values).map((v) => Math.round(v * 100) / 100 + 0)).toEqual([0, 0, 0, 0, 0, 0, 0, -0.1, 0]);
    const m = shapeKeysFromGltf(file)[0]!;
    expect(dense(m.keys[0]!, 3).slice(6, 9).map((v) => Math.round(v * 1000) / 1000 + 0)).toEqual([0, 0, -10]);
  });

  it("refuses a target whose vertex count disagrees with the base", () => {
    const j = handBuilt();
    j.accessors![1]!.count = 2;
    expect(() => shapeKeysFromGltf(readGltf(bytesOf(j)))).toThrow(/target 0/);
  });

  it("an imported model's keys stay in the file, merged by name across meshes", () => {
    const j = handBuilt();
    // A second mesh (teeth) with the same jawOpen target at a different index.
    j.meshes!.push({ name: "Teeth", primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 2 }, { POSITION: 1 }] }], weights: [0, 0.5], extras: { targetNames: ["tongueOut", "jawOpen"] } });
    const r = fileShapeKeysFromGltf(readGltf(bytesOf(j)));
    expect(r.meshes).toBe(2);
    expect(r.keys.map((k) => k.name)).toEqual(["jawOpen", "smile", "tongueOut"]);
    expect(r.keys.map((k) => k.source)).toEqual([
      { kind: "asset", target: "jawOpen" },
      { kind: "asset", target: "smile" },
      { kind: "asset", target: "tongueOut" },
    ]);
    expect(weightsOf(r.keys).jawOpen).toBe(0.5);
    // Onto an imported model's clip: re-attaching keeps existing keys (and their values).
    const clip = createMeshClip({ frameId: "f", startMs: 0, durationMs: 1000, assetId: "asset_1" });
    attachFileShapeKeys(clip, readGltf(bytesOf(j)));
    clip.shapeKeys![1]!.value = 0.3;
    attachFileShapeKeys(clip, readGltf(bytesOf(j)));
    expect(clip.shapeKeys!.map((k) => [k.name, k.value ?? 0])).toEqual([["jawOpen", 0.5], ["smile", 0.3], ["tongueOut", 0]]);
    // A mesh core owns gets no asset keys.
    const own = createMeshClip({ frameId: "f", startMs: 0, durationMs: 1000, primitive: "cube" });
    expect(attachFileShapeKeys(own, readGltf(bytesOf(j)))).toEqual([]);
  });

  it("refuses a .gltf that needs an external buffer, naming it", () => {
    const j = handBuilt();
    j.buffers![0]!.uri = "face.bin";
    expect(() => readGltf(bytesOf(j))).toThrow(/face\.bin/);
  });
});
