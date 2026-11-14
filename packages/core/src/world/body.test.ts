import { describe, expect, it } from "vitest";
import { createEmptyDocument, createImageClip, createTextClip } from "../factories";
import { placeClip } from "../timeline/place";
import { locateClip } from "../timeline/ops";
import { getClipProperty, setClipProperty } from "../animation/paths";
import type { MeshData, VisualClip } from "../schema";
import { bodyFit, bodyThroughStack, bevelledCard, cardMesh, layerMaterial, needsBody } from "./body";
import { applyModifier, convertBodyToMesh, createMeshClip, createWorld } from "./ops";
import { setKeyframe } from "../animation/keyframes";
import type { MeshClip } from "../schema";
import { buildPrimitive } from "./primitives";
import { faceNormal, hasUv, meshBuffers, refineMesh, vertexCount } from "./mesh";
import { MDF, applyModifierStack } from "./modifiers";
import { worldClipPaths } from "./fields";
import { materialPreset, applyMaterialPreset } from "./material-presets";
import { extrudeSchema } from "../schema/world";

const RECT = { minX: -50, minY: -30, maxX: 50, maxY: 30 };

/** The unwrap of vertex i. */
const uvAt = (m: MeshData, i: number) => [m.uv![i * 2]!, m.uv![i * 2 + 1]!];

describe("a layer's body", () => {
  it("a flat card is one face looking down −Y, its unwrap in layer px", () => {
    const m = cardMesh(RECT, 0);
    expect(m.faces).toHaveLength(1);
    expect(faceNormal(m, m.faces[0]!)[1]).toBeCloseTo(-1);
    // Layer (x, y-down) sits at local (x, 0, −y) and is its own unwrap.
    expect([m.positions[0], m.positions[2]]).toEqual([-50, 30]);
    expect(uvAt(m, 0)).toEqual([-50, -30]);
  });

  it("a thick card is a closed slab: face at the front, sides their own part", () => {
    const m = cardMesh(RECT, 20);
    expect(m.faces).toHaveLength(6);
    expect(m.faceParts!.filter((p) => p === "side")).toHaveLength(4);
    expect(faceNormal(m, m.faces[0]!)[1]).toBeCloseTo(-1);
    expect(faceNormal(m, m.faces[1]!)[1]).toBeCloseTo(1);
    // The back vertex shares its front twin's unwrap: the picture shows through.
    expect(uvAt(m, 4)).toEqual(uvAt(m, 0));
  });

  it("a bevel keeps the unwrap with every vertex it cuts", () => {
    const m = bevelledCard(RECT, extrudeSchema.parse({ depth: 20, bevel: 4, bevelSegments: 2 }));
    expect(vertexCount(m)).toBeGreaterThan(8);
    expect(hasUv(m)).toBe(true);
  });

  it("refine splits long edges until none is, conforming, the unwrap interpolated", () => {
    const m = refineMesh(cardMesh(RECT, 0), 10);
    expect(m.faces.length).toBeGreaterThan(40);
    expect(hasUv(m)).toBe(true);
    for (const f of m.faces) {
      for (let i = 0; i < 3; i++) {
        const a = f[i]!, b = f[(i + 1) % 3]!;
        const d = Math.hypot(m.positions[a * 3]! - m.positions[b * 3]!, m.positions[a * 3 + 2]! - m.positions[b * 3 + 2]!);
        expect(d).toBeLessThanOrEqual(10 + 1e-6);
      }
      expect(faceNormal(m, f)[1]).toBeCloseTo(-1);
    }
    // Every vertex's unwrap is still its own layer position.
    for (let i = 0; i < vertexCount(m); i++) {
      expect(m.uv![i * 2]).toBeCloseTo(m.positions[i * 3]!);
      expect(m.uv![i * 2 + 1]).toBeCloseTo(-m.positions[i * 3 + 2]!);
    }
  });

  it("the unwrap survives subdivision, mirror, array and solidify — and the buffers read it", () => {
    const card = cardMesh(RECT, 0);
    const stack = ["subdivision", "array", "mirror", "solidify", "triangulate"].map((t) => MDF.create(t));
    const out = applyModifierStack(card, stack, {}, undefined, 0);
    expect(hasUv(out)).toBe(true);
    const b = meshBuffers(out, { shading: "auto", smoothAngle: 30 });
    // The buffers carry the mesh's own unwrap (layer px), not a 0..1 projection.
    expect(Math.max(...b.uvs)).toBeGreaterThan(1);
  });

  it("a bending stack gets points to bend — the card is refined first", () => {
    const bend = MDF.create("bend");
    const out = bodyThroughStack(cardMesh(RECT, 0), "card", [bend], 0);
    expect(out.mesh.faces.length).toBeGreaterThan(20);
    expect(hasUv(out.mesh)).toBe(true);
    // A stack that only generates is left alone.
    const arr = bodyThroughStack(cardMesh(RECT, 0), "card", [MDF.create("array")], 0);
    expect(arr.mesh.faces.length).toBe(3);
  });
});

describe("2D layers in a world take thickness, a material and modifiers", () => {
  function setup() {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc);
    const text = createTextClip({ frameId: frame.id, startMs: 0, durationMs: 2000, text: "Hi" });
    const image = createImageClip({ frameId: frame.id, startMs: 0, durationMs: 2000, assetId: "a" });
    placeClip(doc, text, { landing: "surface" });
    placeClip(doc, image, { landing: "surface" });
    const get = (id: string) => locateClip(doc, id)!.clip as VisualClip;
    return { doc, text: get(text.id), image: get(image.id) };
  }

  it("fit defaults: outline for vectors and stills, box for what moves on its own", () => {
    const { text, image } = setup();
    expect(bodyFit(text)).toBe("outline");
    expect(bodyFit(image)).toBe("outline");
    expect(bodyFit({ ...image, kind: "video" } as VisualClip)).toBe("box");
    expect(bodyFit({ ...image, extrude: extrudeSchema.parse({ fit: "box" }) })).toBe("box");
  });

  it("a flat picture is unlit until it is thick or given a surface", () => {
    const { image } = setup();
    expect(needsBody(image)).toBe(false);
    expect(layerMaterial(image).model).toBe("unlit");
    image.extrude = extrudeSchema.parse({ depth: 12 });
    expect(layerMaterial(image).model).toBe("pbr");
    expect(needsBody(image)).toBe(true);
  });

  it("material fields read what the layer shows and the first write makes it its own", () => {
    const { image } = setup();
    expect(getClipProperty(image, "material.roughness")).toBe(0.5);
    setClipProperty(image, "material.roughness", 0.2);
    expect(image.material?.roughness).toBe(0.2);
    expect(image.material?.model).toBe("unlit");
    expect(getClipProperty(image, "extrude.depth")).toBe(0);
    setClipProperty(image, "extrude.depth", 30);
    expect(image.extrude?.depth).toBe(30);
  });

  it("modifier fields are paths on any layer's stack", () => {
    const { image } = setup();
    const wave = MDF.create("wave");
    image.modifiers = [wave];
    expect(worldClipPaths(image)).toContain(`mdf.${wave.id}.amplitude`);
    setClipProperty(image, `mdf.${wave.id}.amplitude`, 33);
    expect(getClipProperty(image, `mdf.${wave.id}.amplitude`)).toBe(33);
  });

  it("a preset colours what is coloured by fills and leaves a picture's pixels be", () => {
    const { text, image } = setup();
    const gold = materialPreset("gold")!;
    const pixels = JSON.stringify(image.fills);
    applyMaterialPreset(image, gold);
    expect(image.material?.metalness).toBe(1);
    expect(JSON.stringify(image.fills)).toBe(pixels);
    applyMaterialPreset(text, gold);
    const top = text.fills[text.fills.length - 1]!;
    expect(top.type === "solid" && top.color).toBe("#f5c46b");
  });
});

describe("the modifier library", () => {
  const cube = () => createMeshClip({ frameId: "f", startMs: 0, durationMs: 1000, primitive: "cube", name: "Cube" });

  it("every modifier runs on a card and keeps the picture's unwrap in step", () => {
    const card = refineMesh(cardMesh(RECT, 10), 20);
    for (const def of MDF.types) {
      const out = def.apply(card, Object.fromEntries([...def.fields.map((f) => [f.key, f.default]), ...Object.entries(def.toggleDefaults ?? {})]), { timeSec: 0.5 });
      expect(out.positions.every(Number.isFinite), def.type).toBe(true);
      expect(hasUv(out), def.type).toBe(true);
    }
  });

  it("a bend curls a card toward its face, not within its plane", () => {
    const bent = MDF.def("bend")!.apply(refineMesh(cardMesh(RECT, 0), 5), { angle: 90, axis: "x" }, { timeSec: 0 });
    const ys = [];
    for (let i = 1; i < bent.positions.length; i += 3) ys.push(bent.positions[i]!);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(5);
  });

  it("build keeps a share of the faces; at 1 it is the whole shape", () => {
    const m = refineMesh(cardMesh(RECT, 0), 10);
    const half = MDF.def("build")!.apply(m, { progress: 0.5, order: "x", seed: 1, reverse: false }, { timeSec: 0 });
    expect(half.faces.length).toBe(Math.round(m.faces.length / 2));
    expect(MDF.def("build")!.apply(m, { progress: 1, order: "random", seed: 1 }, { timeSec: 0 })).toBe(m);
  });

  it("explode at 0 is the shape untouched; later every face is its own piece", () => {
    const m = cardMesh(RECT, 10);
    const def = MDF.def("explode")!;
    const p = { progress: 0, distance: 100, spread: 0.5, spin: 90, stagger: 0.3, gravity: 0, seed: 1 };
    expect(def.apply(m, p, { timeSec: 0 })).toBe(m);
    const out = def.apply(m, { ...p, progress: 1 }, { timeSec: 0 });
    expect(vertexCount(out)).toBe(m.faces.reduce((n, f) => n + f.length, 0));
  });

  it("decimate keeps about the share asked for", () => {
    const m = refineMesh(cardMesh(RECT, 0), 4);
    const out = MDF.def("decimate")!.apply(m, { ratio: 0.25 }, { timeSec: 0 });
    expect(vertexCount(out)).toBeLessThan(vertexCount(m) * 0.5);
    expect(vertexCount(out)).toBeGreaterThan(4);
  });

  it("apply bakes the stack through the card into polygons; the look does not change", () => {
    const clip = cube();
    const sub = MDF.create("subdivision");
    const twist = MDF.create("twist");
    clip.modifiers = [sub, twist];
    const before = applyModifierStack(buildPrimitive("cube", {})!, clip.modifiers, {}, undefined, 0);
    expect(applyModifier(clip, sub.id, 0)).toBe(true);
    expect(clip.geometry.type).toBe("mesh");
    expect(clip.modifiers.map((m) => m.id)).toEqual([twist.id]);
    const after = applyModifierStack(clip.geometry.type === "mesh" ? clip.geometry.mesh : cardMesh(RECT, 0), clip.modifiers, {}, undefined, 0);
    expect(after.positions.length).toBe(before.positions.length);
    expect(after.positions[0]).toBeCloseTo(before.positions[0]!, 3);
  });

  it("array: a circle of copies at the radius, and copies that turn and shrink in place", () => {
    const card = cardMesh({ minX: -10, minY: -10, maxX: 10, maxY: 10 }, 0);
    const def = MDF.def("array")!;
    const base = Object.fromEntries([...def.fields.map((f) => [f.key, f.default]), ...Object.entries(def.toggleDefaults ?? {})]);
    const ring = def.apply(card, { ...base, mode: "radial", count: 4, radius: 300, arc: 360, around: "z" }, { timeSec: 0 });
    expect(ring.faces).toHaveLength(4);
    // Each copy's centre sits on the ring, a quarter turn apart.
    const centres = [0, 1, 2, 3].map((k) => {
      const pts = [0, 1, 2, 3].map((j) => (k * 4 + j) * 3);
      return [0, 1].map((axis) => pts.reduce((sum, i) => sum + ring.positions[i + axis]!, 0) / 4);
    });
    for (const [x, y] of centres) expect(Math.hypot(x!, y!)).toBeCloseTo(300, 3);
    expect(centres[0]![1]).toBeCloseTo(-300, 3);
    expect(centres[1]![0]).toBeCloseTo(300, 3);
    const stair = def.apply(card, { ...base, mode: "linear", count: 3, relX: 2, rotZ: 30, scaleStep: 50 }, { timeSec: 0 });
    // The third copy is a quarter the size, two steps along X.
    const third = [8, 9, 10, 11].map((v) => [stair.positions[v * 3]!, stair.positions[v * 3 + 1]!, stair.positions[v * 3 + 2]!]);
    const cx = third.reduce((s2, q) => s2 + q[0]!, 0) / 4;
    expect(cx).toBeCloseTo(80, 3);
    const span = Math.max(...third.map((q) => Math.hypot(q[0]! - cx, q[1]!, q[2]!)));
    expect(span).toBeCloseTo(Math.hypot(10, 10) / 4, 3);
  });
});

describe("convert to mesh", () => {
  it("the body becomes a mesh where the layer stood; the layer moves into the comp it now wears", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    const text = createTextClip({ frameId: frame.id, startMs: 100, durationMs: 2000, text: "Hi" });
    Object.assign(text.transform, { x: 50, y: 20, z: 300, rotation: 30, scale: 2, scaleY: 3, scaleZ: 4 });
    setKeyframe(text.keyframes, "x", 0, 50);
    setKeyframe(text.keyframes, "scaleY", 0, 3);
    setKeyframe(text.keyframes, "fontSize", 0, 80);
    text.extrude = extrudeSchema.parse({ depth: 10 });
    placeClip(doc, text, { landing: "surface" });
    const rect = { minX: -60, minY: -30, maxX: 60, maxY: 30 };
    const id = convertBodyToMesh(doc, text.id, { mesh: cardMesh(rect, 10), rect, sideColor: "#123456", material: layerMaterial(text) })!;
    const mesh = locateClip(doc, id)!.clip as MeshClip;
    expect(mesh.kind).toBe("mesh");
    expect([mesh.transform.x, mesh.transform.z, mesh.transform.rotation, mesh.transform.scale]).toEqual([50, 300, 30, 2]);
    // The picture's height (scaleY) is the mesh's local Z; depth swaps the other way.
    expect([mesh.transform.scaleY, mesh.transform.scaleZ]).toEqual([4, 3]);
    expect(mesh.keyframes.map((k) => k.property).sort()).toEqual(["scaleZ", "x"]);
    expect(mesh.parts[0]).toMatchObject({ id: "side" });
    const comp = doc.frames.find((f) => f.id === mesh.texture!.frameId)!;
    expect([comp.width, comp.height]).toEqual([120, 60]);
    const inner = locateClip(doc, text.id)!.clip as VisualClip;
    expect(inner.frameId).toBe(comp.id);
    expect(inner.keyframes.map((k) => k.property)).toEqual(["fontSize"]);
    expect([inner.transform.x, inner.transform.y, inner.transform.scale, inner.extrude]).toEqual([0, 0, 1, undefined]);
    // The unwrap runs 0..1 across the comp, v up.
    const g = mesh.geometry.type === "mesh" ? mesh.geometry.mesh : null;
    expect(Math.min(...g!.uv!)).toBeCloseTo(0, 6);
    expect(Math.max(...g!.uv!)).toBeCloseTo(1, 6);
  });
});
