import { describe, expect, it } from "vitest";
import {
  createEmptyDocument,
  parseDocument,
  serializeDocument,
  propertyDef,
  writeChannel,
  sampleKeyframes,
  locateClip,
  clipAnimatableProperties,
  type CameraClip,
  type MeshClip,
} from "..";
import {
  PRIMITIVES,
  buildPrimitive,
  meshEdges,
  faceNormal,
  faceCenter,
  meshBounds,
  vertexCount,
  recalcNormalsOutside,
  composeTrs,
  decomposeTrs,
  rotation4,
  eulerFromRotation,
  transformPoint,
  invert4,
  perspective4,
  mul4,
  matAxis,
  matPosition,
  normalize3,
  dot,
  sub,
  flatToWorld,
  worldToFlat,
  defaultCameraMatrix,
  extrude,
  insetFaces,
  loopCut,
  mergeVerts,
  deleteElements,
  edgeLoop,
  edgeKey,
  subdivideFaces,
  catmullClark,
  MODIFIERS,
  MDF,
  applyModifierStack,
  createWorld,
  createCameraClip,
  createMeshClip,
  evaluateWorld,
  evaluateGeometry,
  bakeClipAt,
  makeMeshEditable,
  transformVerts,
  translate4,
  separateFaces,
  selectedVerts,
  convertSelection,
  objectMotionPath,
  validSelection,
  proportionalWeights,
  mirrorSelection,
  createEmptyClip,
  setChildOf,
  bevelMesh,
  bisect,
  selectAll,
  vertexAt,
  type MeshSelection,
  type V3,
} from ".";
import { DOCUMENT_VERSION, modifierSchema, physicsSchema } from "../schema";
import { placeClip } from "../timeline/place";
import { triangulateFace } from "./mesh";
import type { MeshData } from "../schema";

/** Signed volume × 6 — positive iff the closed mesh's faces wind outward. */
function signedVolume(m: MeshData): number {
  let v = 0;
  for (const f of m.faces) {
    const t = triangulateFace(m, f);
    for (let i = 0; i < t.length; i += 3) {
      const a = [m.positions[t[i]! * 3]!, m.positions[t[i]! * 3 + 1]!, m.positions[t[i]! * 3 + 2]!] as V3;
      const b = [m.positions[t[i + 1]! * 3]!, m.positions[t[i + 1]! * 3 + 1]!, m.positions[t[i + 1]! * 3 + 2]!] as V3;
      const c = [m.positions[t[i + 2]! * 3]!, m.positions[t[i + 2]! * 3 + 1]!, m.positions[t[i + 2]! * 3 + 2]!] as V3;
      v += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
  }
  return v;
}

/** Every edge shared by exactly two faces, each traversing it in opposite directions. */
function isClosedManifold(m: MeshData): boolean {
  const directed = new Map<string, number>();
  for (const f of m.faces) {
    for (let i = 0; i < f.length; i++) {
      const k = `${f[i]}>${f[(i + 1) % f.length]}`;
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of directed) {
    if (n !== 1) return false;
    const [a, b] = k.split(">");
    if (directed.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
}

const OPEN = new Set(["plane", "grid", "circle"]);

describe("primitives", () => {
  for (const def of PRIMITIVES) {
    it(`${def.id} builds clean, outward geometry`, () => {
      const m = buildPrimitive(def.id, {})!;
      expect(vertexCount(m)).toBeGreaterThan(2);
      expect(m.faces.every((f) => f.length >= 3 && new Set(f).size === f.length)).toBe(true);
      expect(m.faces.every((f) => f.every((v) => v >= 0 && v < vertexCount(m)))).toBe(true);
      if (OPEN.has(def.id)) {
        expect(m.faces.every((f) => faceNormal(m, f)[2] > 0.99)).toBe(true);
      } else {
        expect(isClosedManifold(m)).toBe(true);
        expect(signedVolume(m)).toBeGreaterThan(0);
      }
    });
  }

  it("convex primitives face away from their centre on every face", () => {
    for (const id of ["cube", "uvSphere", "icoSphere", "cylinder", "cone", "pyramid", "capsule"]) {
      const m = buildPrimitive(id, {})!;
      for (const f of m.faces) expect(dot(faceNormal(m, f), faceCenter(m, f))).toBeGreaterThan(0);
    }
  });

  it("a filleted cube stays inside its box and rounds its corners", () => {
    const m = buildPrimitive("cube", { fillet: 40, filletSegments: 4 })!;
    const b = meshBounds(m);
    expect(b.max[0]).toBeCloseTo(100, 5);
    expect(b.min[2]).toBeCloseTo(-100, 5);
    let far = 0;
    for (let i = 0; i < m.positions.length; i += 3) far = Math.max(far, Math.hypot(m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!));
    // A sharp corner sits at √3·100 ≈ 173; a rounded one well inside it.
    expect(far).toBeLessThan(165);
    expect(isClosedManifold(m)).toBe(true);
  });

  it("params outside their range are clamped, not trusted", () => {
    const m = buildPrimitive("uvSphere", { segments: 1, rings: 0 })!;
    expect(isClosedManifold(m)).toBe(true);
  });
});

describe("math", () => {
  it("XYZ euler survives a round trip through a matrix", () => {
    for (const e of [[10, 20, 30], [-45, 60, 170], [90, 0, 0], [0, -30, -120], [63.6, 0, 46.7]] as V3[]) {
      const back = eulerFromRotation(rotation4(...e));
      const again = rotation4(...back);
      const orig = rotation4(...e);
      for (let i = 0; i < 16; i++) expect(again[i]).toBeCloseTo(orig[i]!, 6);
    }
  });

  it("decompose undoes compose, mirrored scale included", () => {
    const trs = { position: [10, -20, 30] as V3, rotation: [15, -25, 35] as V3, scale: [2, 0.5, 3] as V3 };
    const d = decomposeTrs(composeTrs(trs));
    d.position.forEach((v, i) => expect(v).toBeCloseTo(trs.position[i]!, 6));
    d.scale.forEach((v, i) => expect(v).toBeCloseTo(trs.scale[i]!, 6));
    d.rotation.forEach((v, i) => expect(v).toBeCloseTo(trs.rotation[i]!, 4));
    const mirrored = composeTrs({ ...trs, scale: [-2, 0.5, 3] });
    const m2 = composeTrs(decomposeTrs(mirrored));
    for (let i = 0; i < 16; i++) expect(m2[i]).toBeCloseTo(mirrored[i]!, 6);
  });

  it("flat comp space and world space differ by one rotation", () => {
    const p: V3 = [12, -34, 56];
    expect(worldToFlat(flatToWorld(p))).toEqual(p);
    // Down in a flat comp is down in the world; away is +Y.
    expect(flatToWorld([0, 1, 0])[2]).toBe(-1);
    expect(flatToWorld([0, 0, 1])[1]).toBe(1);
  });

  it("the default camera frames the comp exactly at depth 0", () => {
    const W = 1920, H = 1080;
    const cam = defaultCameraMatrix(W, H);
    // Looking along +Y, up +Z (Blender's front camera).
    expect(matAxis(cam, 2)[1]).toBeCloseTo(-1, 6);
    expect(matAxis(cam, 1)[2]).toBeCloseTo(1, 6);
    const fovX = 2 * Math.atan(18 / 50);
    const fovY = 2 * Math.atan(Math.tan(fovX / 2) / (W / H));
    const vp = mul4(perspective4((fovY * 180) / Math.PI, W / H, 1, 100000), invert4(cam));
    const right = transformPoint(vp, [W / 2, 0, 0]);
    const top = transformPoint(vp, [0, 0, H / 2]);
    expect(right[0]).toBeCloseTo(1, 4);
    expect(top[1]).toBeCloseTo(1, 4);
  });
});

const cube = () => buildPrimitive("cube", {})!;
const topFace = (m: MeshData) => m.faces.findIndex((f) => faceNormal(m, f)[2] > 0.99);

describe("edit mode", () => {
  it("extruding the top face keeps a closed, outward solid that grows", () => {
    const m = cube();
    const sel: MeshSelection = { mode: "face", verts: [], edges: [], faces: [topFace(m)] };
    const ex = extrude(m, sel);
    expect(ex.mesh.faces.length).toBe(10);
    const moved = transformVerts(ex.mesh, selectedVerts(ex.mesh, ex.selection), translate4([0, 0, 100]));
    expect(isClosedManifold(moved)).toBe(true);
    expect(signedVolume(moved)).toBeGreaterThan(signedVolume(m));
    expect(meshBounds(moved).max[2]).toBeCloseTo(200, 5);
  });

  it("extruding an open plane's edge adds a wall", () => {
    const plane = buildPrimitive("plane", {})!;
    const k = edgeKey(plane.faces[0]![0]!, plane.faces[0]![1]!);
    const ex = extrude(plane, { mode: "edge", verts: [], edges: [k], faces: [] });
    expect(ex.mesh.faces.length).toBe(2);
    expect(ex.selection.edges.length).toBe(1);
  });

  it("inset makes an inner face and a ring, still closed", () => {
    const m = cube();
    const r = insetFaces(m, { mode: "face", verts: [], edges: [], faces: [topFace(m)] }, 20);
    expect(r.mesh.faces.length).toBe(10);
    expect(isClosedManifold(r.mesh)).toBe(true);
    const inner = r.mesh.faces[r.selection.faces[0]!]!;
    for (const v of inner) expect(Math.abs(r.mesh.positions[v * 3]!)).toBeCloseTo(80, 4);
  });

  it("a loop cut splits the ring of quads and stays watertight", () => {
    const m = cube();
    const top = m.faces[topFace(m)]!;
    const cut = loopCut(m, edgeKey(top[0]!, top[1]!));
    expect(cut.mesh.faces.length).toBe(10);
    expect(isClosedManifold(cut.mesh)).toBe(true);
    expect(cut.selection.edges.length).toBe(4);
  });

  it("an edge loop runs all the way round a grid row", () => {
    const g = buildPrimitive("grid", { segments: 4 })!;
    // An interior horizontal edge of the 5×5 vertex grid.
    const loop = edgeLoop(g, edgeKey(6, 11));
    expect(loop.length).toBeGreaterThanOrEqual(4);
  });

  it("merge at centre collapses a face to a point and the solid closes into a pyramid", () => {
    const m = cube();
    const r = mergeVerts(m, { mode: "face", verts: [], edges: [], faces: [topFace(m)] }, "center");
    expect(vertexCount(r.mesh)).toBe(5);
    expect(r.mesh.faces.length).toBe(5);
    expect(isClosedManifold(r.mesh)).toBe(true);
  });

  it("deleting a face opens the solid without orphaning a vertex", () => {
    const m = cube();
    const r = deleteElements(m, { mode: "face", verts: [], edges: [], faces: [0] }, "faces");
    expect(r.mesh.faces.length).toBe(5);
    expect(vertexCount(r.mesh)).toBe(8);
    const del = deleteElements(m, { mode: "vertex", verts: [0], edges: [], faces: [] }, "vertices");
    expect(vertexCount(del.mesh)).toBe(7);
    expect(del.mesh.faces.length).toBe(3);
  });

  it("subdividing one face splices midpoints into its neighbours", () => {
    const m = cube();
    const r = subdivideFaces(m, { mode: "face", verts: [], edges: [], faces: [topFace(m)] });
    expect(r.mesh.faces.length).toBe(9);
    expect(isClosedManifold(r.mesh)).toBe(true);
  });

  it("separate splits faces off with their own vertices", () => {
    const m = cube();
    const s = separateFaces(m, { mode: "face", verts: [], edges: [], faces: [topFace(m)] })!;
    expect(s.separated.faces.length).toBe(1);
    expect(vertexCount(s.separated)).toBe(4);
    expect(s.kept.faces.length).toBe(5);
  });

  it("selection converts between vertex, edge and face", () => {
    const m = cube();
    const f = convertSelection(m, { mode: "face", verts: [], edges: [], faces: [topFace(m)] }, "edge");
    expect(f.edges.length).toBe(4);
    expect(convertSelection(m, f, "vertex").verts.length).toBe(4);
    expect(convertSelection(m, f, "face").faces).toEqual([topFace(m)]);
  });

  it("recalculate outside fixes an inside-out solid", () => {
    const m = cube();
    const flipped = { ...m, faces: m.faces.map((f, i) => (i % 2 ? f.slice().reverse() : f)) };
    expect(signedVolume(recalcNormalsOutside(flipped))).toBeGreaterThan(0);
    expect(isClosedManifold(recalcNormalsOutside(flipped))).toBe(true);
  });
});

describe("modifiers", () => {
  it("Catmull–Clark rounds a cube into 24 quads, inside the original", () => {
    const s = catmullClark(cube());
    expect(s.faces.length).toBe(24);
    expect(s.faces.every((f) => f.length === 4)).toBe(true);
    expect(isClosedManifold(s)).toBe(true);
    expect(signedVolume(s)).toBeLessThan(signedVolume(cube()));
  });

  it("every registered modifier runs on a cube with its defaults", () => {
    for (const def of MODIFIERS) {
      const out = applyModifierStack(cube(), [{ id: "m1", type: def.type, enabled: true }], {}, undefined, 0.5);
      expect(out.positions.every(Number.isFinite), def.type).toBe(true);
      expect(out.faces.length, def.type).toBeGreaterThan(0);
    }
  });

  it("mirror welds the seam into one closed solid", () => {
    const half = transformVerts(cube(), new Set([0, 1, 2, 3, 4, 5, 6, 7]), translate4([100, 0, 0]));
    const out = applyModifierStack(half, [{ id: "m", type: "mirror", enabled: true, axis: "x" }], {}, undefined, 0);
    expect(meshBounds(out).min[0]).toBeCloseTo(-200, 5);
  });

  it("a keyed modifier field wins over its stored value", () => {
    const out = applyModifierStack(cube(), [{ id: "a", type: "array", enabled: true, count: 2 }], { "mdf.a.count": 4 }, undefined, 0);
    expect(out.faces.length).toBe(24);
  });

  it("modifiers are the geometry domain of the effect registry: flat, defaulted, keyed at mdf.<id>.<field>", () => {
    const bevel = MDF.create("bevel");
    expect(bevel.id).toMatch(/^mdf/);
    expect(bevel.width).toBe(8);
    expect(MDF.path(bevel.id, "width")).toBe(`mdf.${bevel.id}.width`);
    expect(MDF.def("particles")!.category).toBe("simulate");
    // A running wave moves on its own; a held one does not.
    expect(MDF.isMoving({ ...MDF.create("wave"), speed: 0 })).toBe(false);
    expect(MDF.isMoving(MDF.create("wave"))).toBe(true);
    // A pre-release v89 file kept its values in a `params` bag; it reads flat.
    const lifted = modifierSchema.parse({ id: "m", type: "twist", enabled: true, params: { angle: 45 } });
    expect(lifted).toEqual({ id: "m", type: "twist", enabled: true, angle: 45 });
  });
});

describe("worlds in the document", () => {
  it("a world round-trips through save and load", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc);
    const back = parseDocument(serializeDocument(doc));
    const f = back.frames.find((x) => x.id === frame.id)!;
    expect(f.world).toBeTruthy();
    const kinds = back.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === frame.id).map((c) => c.kind).sort();
    expect(kinds).toEqual(["camera", "light", "light", "mesh"]);
  });

  it("a v88 document opens at the current version untouched — no world, no rig", () => {
    const doc = createEmptyDocument();
    const raw = JSON.parse(serializeDocument(doc));
    raw.version = 88;
    const back = parseDocument(JSON.stringify(raw));
    expect(back.version).toBe(DOCUMENT_VERSION);
    expect(back.frames[0]!.world).toBeUndefined();
    expect(back.tracks.flatMap((t) => t.clips).some((c) => c.kind === "group" && c.rig)).toBe(false);
  });

  it("the topmost live camera is the one that shows; hiding it falls through", () => {
    const doc = createEmptyDocument();
    const { frame, clipIds } = createWorld(doc);
    const first = clipIds.map((id) => locateClip(doc, id)!.clip).find((c) => c.kind === "camera")!;
    expect(evaluateWorld(doc, frame, 500).camera.clipId).toBe(first.id);
    const second = createCameraClip({ frameId: frame.id, startMs: 0, durationMs: 1000, position: [0, -1000, 0], rotation: [90, 0, 0], name: "Close" });
    placeClip(doc, second, { landing: "surface" });
    expect(evaluateWorld(doc, frame, 500).camera.clipId).toBe(second.id);
    // After the close-up's span the main camera takes over again.
    expect(evaluateWorld(doc, frame, 1500).camera.clipId).toBe(first.id);
    locateClip(doc, second.id)!.clip.hidden = true;
    locateClip(doc, first.id)!.clip.hidden = true;
    expect(evaluateWorld(doc, frame, 500).camera.clipId).toBeNull();
  });

  it("the default camera looks at the cube along +Y", () => {
    const doc = createEmptyDocument();
    const { frame, clipIds } = createWorld(doc);
    const cam = evaluateWorld(doc, frame, 0).camera;
    // The starter camera aims at the origin: its −Z points at the cube.
    const fwd = normalize3(matAxis(cam.matrix, 2)).map((v) => -v) as V3;
    const toOrigin = normalize3(sub([0, 0, 0], matPosition(cam.matrix)));
    expect(dot(fwd, toOrigin)).toBeGreaterThan(0.999);
    void clipIds;
  });

  it("a look-at constraint aims a camera at a moving target", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    const ball = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 2000, primitive: "uvSphere", position: [300, 200, 50] });
    const cam = createCameraClip({ frameId: frame.id, startMs: 0, durationMs: 2000, position: [0, -800, 300] });
    cam.constraints = [{ id: "c1", type: "lookAt", targetId: ball.id, enabled: true, influence: 1 }];
    placeClip(doc, ball, { landing: "surface" });
    placeClip(doc, cam, { landing: "surface" });
    const w = evaluateWorld(doc, frame, 100);
    const fwd = normalize3(matAxis(w.camera.matrix, 2)).map((v) => -v) as V3;
    const dir = normalize3(sub([300, 200, 50], [0, -800, 300]));
    expect(dot(fwd, dir)).toBeGreaterThan(0.9999);
  });

  it("a follow constraint keeps the stored offset from its target", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    const car = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 2000, primitive: "cube", position: [500, 0, 0] });
    const cam = createCameraClip({ frameId: frame.id, startMs: 0, durationMs: 2000, position: [0, -600, 200] });
    cam.constraints = [{ id: "c2", type: "follow", targetId: car.id, enabled: true, influence: 1, rotation: false }];
    placeClip(doc, car, { landing: "surface" });
    placeClip(doc, cam, { landing: "surface" });
    const pos = matPosition(evaluateWorld(doc, frame, 0).camera.matrix);
    expect(pos).toEqual([500, -600, 200]);
  });

  it("a group moves, turns and carries what it holds", async () => {
    const { groupClips } = await import("../timeline/groups");
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    const a = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 2000, position: [100, 0, 0] });
    const b = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 2000, position: [-100, 0, 0] });
    placeClip(doc, a, { landing: "surface" });
    placeClip(doc, b, { landing: "surface" });
    const g = groupClips(doc, [a.id, b.id]);
    const group = locateClip(doc, typeof g === "string" ? g : (g as unknown as { id: string }).id)!.clip as import("..").VisualClip;
    group.transform.z = 50;
    group.transform.rotation = 90;
    const w = evaluateWorld(doc, frame, 0);
    const pa = matPosition(w.objects.find((o) => o.id === a.id)!.matrix);
    expect(pa[0]).toBeCloseTo(0, 6);
    expect(pa[1]).toBeCloseTo(100, 6);
    expect(pa[2]).toBeCloseTo(50, 6);
  });

  it("primitive params keyframe like any property and rebuild geometry", () => {
    const doc = createEmptyDocument();
    const { frame, clipIds } = createWorld(doc);
    const meshId = clipIds.find((id) => locateClip(doc, id)!.clip.kind === "mesh")!;
    const clip = locateClip(doc, meshId)!.clip as MeshClip;
    expect(propertyDef("geometry.sizeX")?.kind).toBe("number");
    writeChannel(clip, "geometry.sizeX", 0, 200, { forceKey: true });
    writeChannel(clip, "geometry.sizeX", 1000, 400, { forceKey: true });
    const mid = bakeClipAt(clip, 500);
    expect(mid.geometry.type === "primitive" && mid.geometry.params.sizeX).toBeCloseTo(300, 4);
    expect(meshBounds(evaluateGeometry(mid, 500).mesh!).max[0]).toBeCloseTo(150, 4);
    const paths = clipAnimatableProperties(clip).map((p) => p.path);
    expect(paths).toContain("geometry.fillet");
    expect(paths).toContain("material.roughness");
    expect(paths).toContain("z");
    void frame;
  });

  it("position x, y and z key as one property", () => {
    const doc = createEmptyDocument();
    const { clipIds } = createWorld(doc);
    const clip = locateClip(doc, clipIds[0]!)!.clip;
    writeChannel(clip, "x", 0, 10, { forceKey: true });
    writeChannel(clip, "x", 1000, 20, { forceKey: true });
    // z has never been keyed: writing it at one key must not drag the other.
    writeChannel(clip, "z", 1000, 300);
    const s0 = sampleKeyframes(clip.keyframes, 0);
    const s1 = sampleKeyframes(clip.keyframes, 1000);
    expect(s0.z).toBe(0);
    expect(s1.z).toBe(300);
  });

  it("camera lens fields are registry paths", () => {
    const def = propertyDef("camera.focalLength");
    expect(def?.appliesTo).toEqual(["camera"]);
    const cam = createCameraClip({ frameId: "f", startMs: 0, durationMs: 100 }) as CameraClip;
    writeChannel(cam, "camera.focalLength", 0, 85);
    expect(cam.camera.focalLength).toBe(85);
  });

  it("make editable turns a primitive into the same polygons", () => {
    const m = createMeshClip({ frameId: "f", startMs: 0, durationMs: 100, primitive: "cylinder" });
    const before = buildPrimitive("cylinder", {})!;
    expect(makeMeshEditable(m)).toBe(true);
    expect(m.geometry.type).toBe("mesh");
    expect(m.geometry.type === "mesh" && m.geometry.mesh.faces.length).toBe(before.faces.length);
    expect(meshEdges(m.geometry.type === "mesh" ? m.geometry.mesh : before).list.length).toBe(meshEdges(before).list.length);
  });
});

describe("motion paths and stale selections", () => {
  it("a keyed object's path runs through its keys; a still one has none", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    const cube = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 1000, primitive: "cube" });
    cube.keyframes = [{ id: "t", property: "x", range: null, keys: [
      { id: "a", timeMs: 0, value: 0, easing: { kind: "linear" } },
      { id: "b", timeMs: 1000, value: 900, easing: { kind: "linear" } },
    ] }] as typeof cube.keyframes;
    placeClip(doc, cube, { landing: "surface" });
    const still = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 1000, primitive: "cube" });
    placeClip(doc, still, { landing: "surface" });
    const path = objectMotionPath(doc, frame, cube.id)!;
    expect(path.points.length).toBeGreaterThan(20);
    expect(path.points[0]![0]).toBeCloseTo(0, 3);
    expect(path.points.at(-1)![0]).toBeGreaterThan(890);
    expect(path.keys.length).toBe(2);
    expect(objectMotionPath(doc, frame, still.id)).toBeNull();
  });

  it("a selection past the mesh is trimmed to what the mesh has", () => {
    const cube = buildPrimitive("cube", {})!;
    const sel: MeshSelection = { mode: "vertex", verts: [0, 7, 40], edges: [edgeKey(0, 1), edgeKey(40, 41)], faces: [5, 9] };
    const v = validSelection(cube, sel);
    expect(v.verts).toEqual([0, 7]);
    expect(v.faces).toEqual([5]);
    expect(v.edges.length).toBeLessThanOrEqual(1);
    expect(validSelection(cube, v)).toBe(v);
  });
});

describe("proportional editing", () => {
  it("neighbours follow by distance, the selection fully, far vertices not at all", () => {
    const grid = buildPrimitive("grid", { sizeX: 400, sizeY: 400, subdivisionsX: 4, subdivisionsY: 4 })!;
    const centre = [...Array(vertexCount(grid)).keys()].reduce((best, i) => (Math.hypot(...vertexAt(grid, i)) < Math.hypot(...vertexAt(grid, best)) ? i : best), 0);
    const w = proportionalWeights(grid, new Set([centre]), 150);
    expect(w.get(centre)).toBe(1);
    const values = [...w.entries()].filter(([i]) => i !== centre).map(([, v]) => v);
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((v) => v > 0 && v < 1)).toBe(true);
    expect(w.size).toBeLessThan(vertexCount(grid));
  });
});

describe("particles", () => {
  it("are exact per instant: a stream fills up, a burst falls and dies", () => {
    const ico = buildPrimitive("icoSphere", {})!;
    const def = MODIFIERS.find((m) => m.type === "particles")!;
    const params = (over: Record<string, number | string>) => ({ ...Object.fromEntries(def.fields.map((f) => [f.key, f.default])), ...over });
    const at = (t: number, over: Record<string, number | string> = {}) => def.apply(ico, params({ count: 50, ...over }), { timeSec: t });
    const per = vertexCount(ico);
    expect(vertexCount(at(0.5))).toBeLessThan(vertexCount(at(1.9)));
    expect(vertexCount(at(5.013))).toBe(50 * per);
    // Same instant, same picture — no hidden state.
    expect(at(1.234).positions).toEqual(at(1.234).positions);
    const burst = (t: number) => at(t, { mode: "burst", gravity: -1000, speed: 0, spread: 0 });
    const lowest = (m: { positions: number[] }) => Math.min(...m.positions.filter((_, i) => i % 3 === 2));
    expect(lowest(burst(1))).toBeLessThan(lowest(burst(0.2)));
    expect(vertexCount(burst(2.5))).toBe(0);
  });
});

describe("mirror", () => {
  it("flips the selection across the pivot and keeps faces facing out", () => {
    const cube = buildPrimitive("cube", {})!;
    const all = selectAll(cube, "face");
    const m = mirrorSelection(cube, all, 0, [50, 0, 0]).mesh;
    const xs = [...Array(vertexCount(m)).keys()].map((i) => vertexAt(m, i)[0]);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(200, 6);
    expect(signedVolume(m)).toBeGreaterThan(0);
  });
});

describe("controllers and Child Of", () => {
  it("a chain follows its parents without jumping when parented", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    const span = { frameId: frame.id, startMs: 0, durationMs: 1000 };
    const ctrl = createEmptyClip({ ...span, position: [0, 0, 0] });
    const arm = createMeshClip({ ...span, primitive: "cube", position: [100, 0, 0] });
    const hand = createMeshClip({ ...span, primitive: "cube", position: [200, 0, 0] });
    for (const c of [ctrl, arm, hand]) placeClip(doc, c, { landing: "surface" });
    expect(setChildOf(doc, frame, arm.id, ctrl.id)).toBe(true);
    expect(setChildOf(doc, frame, hand.id, arm.id)).toBe(true);
    const pos = (id: string) => matPosition(evaluateWorld(doc, frame, 0).objects.find((o) => o.id === id)!.matrix);
    expect(pos(hand.id)[0]).toBeCloseTo(200, 6);
    // Turn the controller 90° about Z: the hand swings round to +Y.
    (locateClip(doc, ctrl.id)!.clip as import("..").VisualClip).transform.rotation = 90;
    expect(pos(hand.id)[0]).toBeCloseTo(0, 4);
    expect(pos(hand.id)[1]).toBeCloseTo(200, 4);
    expect(setChildOf(doc, frame, hand.id, null)).toBe(true);
    expect(pos(hand.id)[0]).toBeCloseTo(200, 6);
  });
});

describe("rigid bodies", () => {
  it("an active cube falls, lands on the ground and rests; frames are exact in any order", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    const cube = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 4000, primitive: "cube", position: [0, 0, 400] });
    cube.physics = physicsSchema.parse({ type: "active", bounce: 0 });
    placeClip(doc, cube, { landing: "surface" });
    const z = (t: number) => matPosition(evaluateWorld(doc, frame, t).objects.find((o) => o.id === cube.id)!.matrix)[2];
    expect(z(0)).toBeCloseTo(400, 3);
    const late = z(3000);
    expect(z(300)).toBeLessThan(400);
    expect(late).toBeGreaterThan(90);
    expect(late).toBeLessThan(110);
    // Scrubbing back and forth reads the same stored poses.
    expect(z(300)).toBe(z(300));
    expect(z(3000)).toBe(late);
  });
});

describe("bevel and knife", () => {
  it("a bevelled cube stays closed and outward, with strips and corners", () => {
    const cube = buildPrimitive("cube", {})!;
    const chamfer = bevelMesh(cube, 10, 1, 30);
    // 6 faces + 12 edge strips + 8 corner triangles.
    expect(chamfer.faces.length).toBe(26);
    expect(signedVolume(chamfer)).toBeGreaterThan(0);
    const round = bevelMesh(cube, 10, 3, 30);
    expect(round.faces.length).toBe(6 + 12 * 3 + 8);
    expect(signedVolume(round)).toBeLessThan(signedVolume(cube));
    expect(signedVolume(round)).toBeGreaterThan(signedVolume(cube) * 0.9);
  });

  it("the knife splits every face the plane crosses and keeps the mesh connected", () => {
    const cube = buildPrimitive("cube", {})!;
    const r = bisect(cube, [0, 0, 0], [1, 0, 0]);
    // The four faces the plane crosses split in two; the two parallel to it do not.
    expect(r.mesh.faces.length).toBe(10);
    expect(signedVolume(r.mesh)).toBeCloseTo(signedVolume(cube), 3);
    expect(r.selection.edges.length).toBe(4);
  });
});
