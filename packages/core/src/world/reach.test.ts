import { describe, expect, it } from "vitest";
import type { MeshData } from "../schema";
import { MDF, type ModifierScene, type SceneObject } from "./modifiers";
import { buildPrimitive } from "./primitives";
import { cardMesh } from "./body";
import { refineMesh, vertexCount, meshEdges } from "./mesh";
import { identity4, translate4, type V3 } from "./math";
import { latticeMesh, resampleLattice } from "./lattice";
import { createEmptyDocument } from "../factories";
import { locateClip } from "../timeline/ops";
import { placeClip } from "../timeline/place";
import { addLattice, createMeshClip, createWorld } from "./ops";
import { evaluateGeometry, evaluateWorld, modifierScene, objectWorldBounds } from "./evaluate";
import type { MeshClip } from "../schema";

const paramsOf = (type: string, over: Record<string, unknown> = {}) => {
  const def = MDF.def(type)!;
  return { ...Object.fromEntries([...def.fields.map((f) => [f.key, f.default]), ...Object.entries(def.toggleDefaults ?? {})]), ...over } as Record<string, number | string | boolean>;
};
const run = (type: string, mesh: MeshData, over: Record<string, unknown> = {}, scene?: ModifierScene, picture?: { key: string; at(u: number, v: number): number }) =>
  MDF.def(type)!.apply(mesh, paramsOf(type, over), { timeSec: 0, scene, picture });
const sceneOf = (objects: Record<string, Partial<SceneObject>>): ModifierScene => ({
  object: (id) => (objects[id] ? ({ matrix: identity4(), mesh: null, path: null, facing: [0, -1, 0], key: id, ...objects[id] } as SceneObject) : null),
});
const pt = (m: MeshData, i: number): V3 => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];

describe("modifiers that reach the world", () => {
  const card = refineMesh(cardMesh({ minX: -100, minY: -20, maxX: 100, maxY: 20 }, 0), 10);

  it("curve: a straight path along X is the identity (up to where it starts); a circle bends the card round it", () => {
    const straight = sceneOf({ p: { path: [[-100, 0, 0], [300, 0, 0]] } });
    const out = run("curve", card, { curve: "p", axis: "x" }, straight);
    for (let i = 0; i < vertexCount(card); i++) {
      const a = pt(card, i), b = pt(out, i);
      expect(b[0]).toBeCloseTo(a[0], 4);
      expect(b[1]).toBeCloseTo(a[1], 4);
      expect(b[2]).toBeCloseTo(a[2], 4);
    }
    const R = 300;
    const circle: V3[] = Array.from({ length: 129 }, (_, i) => [R * Math.cos((i / 128) * Math.PI * 2), 0, R * Math.sin((i / 128) * Math.PI * 2)]);
    const round = run("curve", card, { curve: "p", axis: "x" }, sceneOf({ p: { path: circle } }));
    // Every point on the card's centre line lands on the circle.
    for (let i = 0; i < vertexCount(card); i++) {
      if (Math.abs(card.positions[i * 3 + 2]!) > 1e-6) continue;
      const q = pt(round, i);
      expect(Math.hypot(q[0], q[2])).toBeCloseTo(R, 0);
    }
  });

  it("curve: no path, or none in the scene, changes nothing", () => {
    expect(run("curve", card, { curve: "" })).toBe(card);
    expect(run("curve", card, { curve: "missing" }, sceneOf({}))).toBe(card);
  });

  it("shrinkwrap puts every point on the target's surface (plus the offset)", () => {
    const sphere = buildPrimitive("uvSphere", { radius: 200, segments: 48, rings: 24 })!;
    const out = run("shrinkwrap", card, { target: "s", offset: 0, strength: 1 }, sceneOf({ s: { mesh: sphere } }));
    for (let i = 0; i < vertexCount(out); i++) expect(Math.hypot(...pt(out, i))).toBeGreaterThan(195);
    for (let i = 0; i < vertexCount(out); i++) expect(Math.hypot(...pt(out, i))).toBeLessThan(201);
  });

  it("hook: points near where the controller grabbed follow its move; far ones stay", () => {
    const scene = sceneOf({ h: { rest: translate4([100, 0, 0]), matrix: translate4([100, 0, 200]) } });
    const out = run("hook", card, { target: "h", radius: 50, falloff: "constant", strength: 1 }, scene);
    for (let i = 0; i < vertexCount(card); i++) {
      const a = pt(card, i), b = pt(out, i);
      const near = Math.hypot(a[0] - 100, a[1], a[2]) < 50;
      expect(b[2] - a[2]).toBeCloseTo(near ? 200 : 0, 4);
    }
  });

  it("displace by its own picture: bright pushes out along the surface, dark stays", () => {
    const picture = { key: "p", at: (u: number) => (u > 0 ? 1 : 0) };
    const out = run("displace", card, { source: "picture", strength: 10, midlevel: 0, direction: "y" }, undefined, picture);
    for (let i = 0; i < vertexCount(card); i++) {
      const dy = out.positions[i * 3 + 1]! - card.positions[i * 3 + 1]!;
      expect(dy).toBeCloseTo(card.uv![i * 2]! > 0 ? 10 : 0, 6);
    }
  });

  it("screw revolves a profile into a closed surface of revolution", () => {
    const profile: MeshData = { positions: [100, 0, 0, 120, 0, 50, 80, 0, 100], faces: [], lines: [0, 1, 1, 2] };
    const out = run("screw", profile, { angle: 360, steps: 24, height: 0, axis: "z" });
    expect(out.faces).toHaveLength(48);
    expect(vertexCount(out)).toBe(3 * 24);
  });

  it("remesh: blocks and smooth both make closed surfaces of a cube", () => {
    const cube = buildPrimitive("cube", {})!;
    for (const mode of ["blocks", "smooth"]) {
      const out = run("remesh", cube, { mode, cells: 8 });
      expect(out.faces.length).toBeGreaterThan(20);
      // No holes: every edge has a face on both sides (voxels may meet at an edge, as Blender's blocks do).
      expect(meshEdges(out).list.every((e) => e.faces.length >= 2)).toBe(true);
    }
  });

  it("mirror on two axes makes four quarters; bisect trims what crossed first", () => {
    const quarter = cardMesh({ minX: 10, minY: -40, maxX: 50, maxY: -10 }, 0);
    const out = run("mirror", quarter, { mirrorX: true, mirrorZ: true, merge: 0 });
    expect(out.faces).toHaveLength(4);
    const crossing = cardMesh({ minX: -20, minY: -40, maxX: 50, maxY: -10 }, 0);
    const cut = run("mirror", crossing, { mirrorX: true, bisect: true, merge: 0 });
    for (let i = 0; i < vertexCount(cut); i++) expect(Math.abs(cut.positions[i * 3]!)).toBeLessThanOrEqual(50 + 1e-9);
  });

  it("bend limits: outside the limited stretch the shape carries on rigidly", () => {
    const out = run("bend", card, { angle: 90, axis: "x", from: 50, to: 100 });
    // The left half (x < 0) is untouched.
    for (let i = 0; i < vertexCount(card); i++) {
      if (card.positions[i * 3]! > -1e-6) continue;
      expect(pt(out, i)[0]).toBeCloseTo(pt(card, i)[0], 4);
      expect(pt(out, i)[1]).toBeCloseTo(pt(card, i)[1], 4);
    }
  });
});

describe("a stroke in space", () => {
  it("is a closed tube that faces outward, its radius following the pressure profile", async () => {
    const { strokeTube } = await import("./stroke-tube");
    const { strokeStyle, solidPaint } = await import("../schema/vector");
    const { recalcNormalsOutside, meshEdges: edges } = await import("./mesh");
    const stroke = strokeStyle(solidPaint("#fff"), { width: 20, profile: { startWidth: 1, endWidth: 1, startLength: 0.5, endLength: 0.5, ease: 0, samples: [0.2, 1] } });
    const tube = strokeTube([[0, 0, 0], [100, 0, 0], [200, 0, 50]], stroke, { sides: 8 })!;
    expect(edges(tube).list.every((e) => e.faces.length === 2)).toBe(true);
    // Already outward: recalculating changes nothing.
    expect(recalcNormalsOutside(tube).faces).toEqual(tube.faces);
    const ringRadius = (i: number) => Math.hypot(tube.positions[i * 8 * 3 + 1]!, tube.positions[i * 8 * 3 + 2]!);
    expect(ringRadius(0)).toBeCloseTo(2, 1);
  });

  it("lattice: an untouched cage changes nothing; lifting its top lifts the shape in proportion (linear), softly (smooth)", () => {
    const card = refineMesh(cardMesh({ minX: -100, minY: -20, maxX: 100, maxY: 20 }, 0), 10);
    const spec = { u: 2, v: 2, w: 2, size: [240, 80, 80] as [number, number, number] };
    const rest = latticeMesh(spec);
    expect(rest.lines).toHaveLength(12 * 2);
    expect(run("lattice", card, { cage: "c" }, sceneOf({ c: { mesh: rest, lattice: spec } }))).toBe(card);
    const lifted: MeshData = { ...rest, positions: rest.positions.map((v, i) => (i % 3 === 2 && v > 0 ? v + 30 : v)) };
    const lin = run("lattice", card, { cage: "c", interpolation: "linear" }, sceneOf({ c: { mesh: lifted, lattice: spec } }));
    const soft = run("lattice", card, { cage: "c", interpolation: "smooth" }, sceneOf({ c: { mesh: lifted, lattice: spec } }));
    for (let i = 0; i < vertexCount(card); i++) {
      const a = pt(card, i);
      expect(pt(lin, i)[2] - a[2]).toBeCloseTo((30 * (a[2] + 40)) / 80, 6);
      expect(pt(lin, i)[0]).toBeCloseTo(a[0], 6);
      const ds = pt(soft, i)[2] - a[2];
      expect(ds).toBeGreaterThanOrEqual(0);
      expect(ds).toBeLessThanOrEqual(30);
    }
    // A finer grid keeps the shape: the new middle layer is lifted half way.
    const fine = resampleLattice(spec, lifted.positions, { ...spec, u: 3, v: 3, w: 3 });
    expect(fine.positions.length).toBe(27 * 3);
    for (let i = 0; i < 27; i++) {
      const rest = latticeMesh({ ...spec, u: 3, v: 3, w: 3 }).positions;
      expect(fine.positions[i * 3 + 2]! - rest[i * 3 + 2]!).toBeCloseTo(rest[i * 3 + 2]! > 0 ? 30 : rest[i * 3 + 2]! === 0 ? 15 : 0, 6);
    }
    // A grid that no longer matches (a point deleted) stands aside.
    const broken: MeshData = { ...lifted, positions: lifted.positions.slice(3) };
    expect(run("lattice", card, { cage: "c" }, sceneOf({ c: { mesh: broken, lattice: spec } }))).toBe(card);
  });

  it("add lattice: a cage fitted round the object, riding it, read by a card at the end of its stack", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    const cube = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 2000, primitive: "cube", position: [300, 0, 0] });
    placeClip(doc, cube, { landing: "surface" });
    const made = addLattice(doc, cube.id)!;
    const cage = locateClip(doc, made.cageId)!.clip as MeshClip;
    expect(cage.lattice).toMatchObject({ u: 3, v: 3, w: 3 });
    expect(cage.constraints?.[0]).toMatchObject({ type: "childOf", targetId: cube.id });
    const host = locateClip(doc, cube.id)!.clip as MeshClip;
    expect(host.modifiers.at(-1)).toMatchObject({ type: "lattice", cage: cage.id, id: made.modifierId });
    // The cage stands round the cube, wherever the cube is.
    const ev = evaluateWorld(doc, frame, 0, { physics: false });
    const cb = objectWorldBounds(ev.objects.find((o) => o.id === cage.id)!), hb = objectWorldBounds(ev.objects.find((o) => o.id === cube.id)!);
    for (let k = 0; k < 3; k++) {
      expect(cb.min[k]!).toBeLessThan(hb.min[k]! + 1e-6);
      expect(cb.max[k]!).toBeGreaterThan(hb.max[k]! - 1e-6);
    }
    // Untouched, the cube is itself; pull the cage's top layer up and the cube's top follows.
    const geo = () => {
      const e = evaluateWorld(doc, frame, 0, { physics: false });
      const self = e.objects.find((o) => o.id === cube.id)!;
      return evaluateGeometry(self.clip as MeshClip, 0, { scene: modifierScene(doc, frame, e, self) }).mesh!;
    };
    const base = buildPrimitive("cube", {})!;
    const top = Math.max(...base.positions.filter((_, i) => i % 3 === 2));
    expect(Math.max(...geo().positions.filter((_, i) => i % 3 === 2))).toBeCloseTo(top, 6);
    const g = cage.geometry.type === "mesh" ? cage.geometry.mesh : null;
    const zTop = Math.max(...g!.positions.filter((_, i) => i % 3 === 2));
    cage.geometry = { type: "mesh", mesh: { ...g!, positions: g!.positions.map((v, i) => (i % 3 === 2 && v === zTop ? v + 50 : v)) } };
    expect(Math.max(...geo().positions.filter((_, i) => i % 3 === 2))).toBeGreaterThan(top + 5);
  });
});
