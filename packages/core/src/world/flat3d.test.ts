import { describe, expect, it } from "vitest";
import {
  addExpression,
  addVariable,
  createEmptyDocument,
  createFrame,
  createShapeClip,
  createTextClip,
  defaultNodeRegistry,
  expressionById,
  exprToken,
  fxToken,
  locateClip,
  parseFxToken,
  resolveDriver,
  variableValueNow,
  varToken,
  type MotionDocument,
  type DriverEnv,
  type GroupClip,
  type VisualClip,
} from "..";
import { createRig } from "../rig/ops";
import { placeClip } from "../timeline/place";
import { activeCameraAt, addWorldClip, defaultCameraDistance, evaluateWorld, flatLayerMatrix, frameIntoWorld, layerDepthAt, moveIntoWorld, projectFlat, transformPoint, type V3 } from ".";

/** What the default camera of a W×H world shows a world point as, in frame px. */
function projectWorld(p: V3, w: number, h: number) {
  const D = defaultCameraDistance(w, h);
  const k = D / (p[1] + D);
  return { x: w / 2 + p[0] * k, y: h / 2 - p[2] * k };
}

function setup() {
  const doc = createEmptyDocument();
  const frame = createFrame({ name: "Layout", width: 1920, height: 1080 });
  doc.frames.push(frame);
  const card = createShapeClip({ frameId: frame.id, shape: "rect", startMs: 0, durationMs: 2000, x: 200, y: -100, width: 300, height: 200 });
  card.transform = { ...card.transform, rotation: 30, rotationX: 20, z: 300 };
  placeClip(doc, card, { landing: "surface" });
  return { doc, frame, card };
}

describe("flat layers with depth", () => {
  it("no depth is no depth — and depth 0 projects 1:1", () => {
    const { card } = setup();
    expect(layerDepthAt({ ...card, transform: { ...card.transform, z: 0, rotationX: 0 } } as VisualClip, 0)).toBeNull();
    const m = flatLayerMatrix({ x: 200, y: -100, rotation: 0, scaleX: 1, scaleY: 1 }, { z: 0, rotationX: 0, rotationY: 0 }, 1920, 1080);
    const p = projectFlat(transformPoint(m, [50, 40, 0]), 1920, 1080)!;
    expect(p.x).toBeCloseTo(960 + 250, 6);
    expect(p.y).toBeCloseTo(540 - 60, 6);
  });

  it("depth pushes a layer away: smaller, toward the centre", () => {
    const m = flatLayerMatrix({ x: 400, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, { z: 1000, rotationX: 0, rotationY: 0 }, 1920, 1080);
    const p = projectFlat(transformPoint(m, [0, 0, 0]), 1920, 1080)!;
    expect(p.x).toBeGreaterThan(960);
    expect(p.x).toBeLessThan(960 + 400);
  });

  it("moving into a world keeps every pixel where it was", () => {
    const { doc, frame, card } = setup();
    const depth = layerDepthAt(card, 0)!;
    const flat = flatLayerMatrix({ x: 200, y: -100, rotation: 30, scaleX: 1, scaleY: 1 }, depth, frame.width, frame.height);
    const corners: [number, number][] = [[-150, -100], [150, -100], [150, 100], [-150, 100]];
    const before = corners.map(([u, v]) => projectFlat(transformPoint(flat, [u, v, 0]), frame.width, frame.height)!);

    const moved = moveIntoWorld(doc, [card.id])!;
    expect(moved).not.toBeNull();
    const world = doc.frames.find((f) => f.id === moved.frameId)!;
    expect(world.world).toBeDefined();
    expect(world.width).toBe(frame.width);
    const plane = evaluateWorld(doc, world, 0).objects.find((o) => o.id === card.id)!;
    expect(plane.kind).toBe("plane");
    // A picture plane's content lies on its local XZ, v down = −Z.
    const after = corners.map(([u, v]) => projectWorld(transformPoint(plane.matrix, [u, 0, -v]), world.width, world.height));
    after.forEach((p, i) => {
      expect(p.x).toBeCloseTo(before[i]!.x, 4);
      expect(p.y).toBeCloseTo(before[i]!.y, 4);
    });
    // The nested world sits where the layer was, at identity.
    const nested = locateClip(doc, moved.nestedId)!.clip as VisualClip;
    expect(nested.frameId).toBe(frame.id);
    expect(nested.transform.x).toBe(0);
  });

  it("keyed channels follow the change of axes", () => {
    const { doc, card } = setup();
    card.transform = { ...card.transform, rotationX: undefined, z: undefined };
    card.keyframes = [
      { id: "t1", property: "y", range: null, keys: [
        { id: "k1", timeMs: 0, value: -100, easing: { kind: "linear" } },
        { id: "k2", timeMs: 1000, value: 100, easing: { kind: "linear" } },
      ] },
      { id: "t2", property: "rotation", range: null, keys: [{ id: "k3", timeMs: 0, value: 45, easing: { kind: "linear" } }] },
    ] as VisualClip["keyframes"];
    moveIntoWorld(doc, [card.id]);
    const moved = locateClip(doc, card.id)!.clip as VisualClip;
    const z = moved.keyframes.find((t) => t.property === "z")!;
    expect(z.keys.map((k) => k.value)).toEqual([100, -100]);
    expect(moved.keyframes.find((t) => t.property === "rotationY")!.keys[0]!.value).toBe(45);
    expect(moved.keyframes.some((t) => t.property === "y" || t.property === "rotation")).toBe(false);
  });
});

/** A driver token → its value, through the funnel the app resolves drivers with (`makeDriverEnv`). */
function drive(doc: MotionDocument, token: string | undefined) {
  const read = (id: string) => {
    const v = doc.variables.find((x) => x.id === id);
    return v ? (variableValueNow(v) as number) : undefined;
  };
  const env: DriverEnv = {
    graphs: doc.graphs,
    registry: defaultNodeRegistry,
    fps: 30,
    readProperty: () => undefined,
    describeClip: () => [],
    readVariable: read,
    expressions: { table: doc.expressions, variables: doc.variables, sample: (v) => variableValueNow(v) as number },
  };
  return token === undefined ? undefined : resolveDriver(token, 0, env);
}

describe("drivers made 3D", () => {
  it("an expression-driven flat y drives world z negated — a new row; locals and comments intact", () => {
    const { doc, card } = setup();
    addVariable(doc, "number", "offset", 60);
    const source = "#half = #offset / 2;\n#half + 10 // nudge";
    const fx = addExpression(doc, source, "Bob");
    card.drivers = { y: fxToken(fx.id), rotationY: fxToken(fx.id), x: fxToken(fx.id) };
    expect(drive(doc, card.drivers.y)).toBe(40);

    moveIntoWorld(doc, [card.id]);
    const moved = locateClip(doc, card.id)!.clip as VisualClip;
    expect(Object.keys(moved.drivers!).sort()).toEqual(["rotation", "x", "z"]);
    expect(drive(doc, moved.drivers!.z)).toBe(-40);
    expect(drive(doc, moved.drivers!.rotation)).toBe(-40);
    // An unflipped channel keeps its token; both flips share ONE negated row.
    expect(moved.drivers!.x).toBe(fxToken(fx.id));
    expect(moved.drivers!.z).toBe(moved.drivers!.rotation);
    const negated = expressionById(doc, parseFxToken(moved.drivers!.z)!)!;
    expect(negated.id).not.toBe(fx.id);
    expect(negated.name).toBe("Bob · 3D");
    // The original row may be shared, so it is never rewritten.
    expect(expressionById(doc, fx.id)!.source).toBe(source);
  });

  it("a variable-driven flat y reads the variable negated; a graph-driven one keeps its token", () => {
    const { doc, card } = setup();
    const v = addVariable(doc, "number", "Lift \"amount\"", 25);
    const other = createShapeClip({ frameId: card.frameId, shape: "rect", startMs: 0, durationMs: 2000, x: 0, y: 0, width: 50, height: 50 });
    placeClip(doc, other, { landing: "surface" });
    card.drivers = { y: varToken(v.id) };
    other.drivers = { y: exprToken("graph1") };
    expect(drive(doc, card.drivers.y)).toBe(25);

    moveIntoWorld(doc, [card.id, other.id]);
    const moved = locateClip(doc, card.id)!.clip as VisualClip;
    expect(parseFxToken(moved.drivers!.z)).not.toBeNull();
    expect(drive(doc, moved.drivers!.z)).toBe(-25);
    expect((locateClip(doc, other.id)!.clip as VisualClip).drivers).toEqual({ z: exprToken("graph1") });
  });

  it("a driven bone's flat y drives its world z negated", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const card = createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 2000, x: 0, y: 0, width: 400, height: 40 });
    placeClip(doc, card, { landing: "surface" });
    const rig = createRig(doc, frameId, { memberIds: [card.id], bones: [{ head: [-200, 0], tail: [200, 0], name: "Arm" }] })!;
    const group = locateClip(doc, rig)!.clip as GroupClip;
    const bone = group.rig!.bones[0]!.id;
    group.drivers = { [`bone.${bone}.y`]: fxToken(addExpression(doc, "12").id) };

    moveIntoWorld(doc, [rig]);
    const g = locateClip(doc, rig)!.clip as GroupClip;
    expect(Object.keys(g.drivers!)).toEqual([`bone.${bone}.z`]);
    expect(drive(doc, g.drivers![`bone.${bone}.z`])).toBe(-12);
  });
});

describe("making things 3D", () => {
  it("a frame made 3D keeps its place and wraps a world holding all it had, for its whole length", () => {
    const doc = createEmptyDocument();
    const frame = doc.frames[0]!;
    const a = createTextClip({ frameId: frame.id, startMs: 0, durationMs: 1000, text: "A" });
    const b = createTextClip({ frameId: frame.id, startMs: 500, durationMs: 1000, text: "B" });
    placeClip(doc, a, { landing: "surface" });
    placeClip(doc, b, { landing: "surface" });
    const r = frameIntoWorld(doc, frame.id)!;
    expect(r).toBeTruthy();
    expect(frame.world).toBeUndefined();
    const world = doc.frames.find((f) => f.id === r.frameId)!;
    expect(world.world).toBeTruthy();
    const inWorld = doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === world.id);
    expect(inWorld.filter((c) => c.kind !== "camera").map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    // …and opens with a real camera layer, the one that frames the comp as before.
    const cams = inWorld.filter((c) => c.kind === "camera");
    expect(cams).toHaveLength(1);
    expect(activeCameraAt(doc, world, 0)).toBe(cams[0]!.id);
    const nested = locateClip(doc, r.nestedId)!.clip;
    expect(nested.frameId).toBe(frame.id);
    expect(nested.startMs).toBe(0);
  });

  it("an empty frame made 3D gets a fresh starter world", () => {
    const doc = createEmptyDocument();
    const r = frameIntoWorld(doc, doc.frames[0]!.id)!;
    const kinds = doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === r.frameId).map((c) => c.kind).sort();
    expect(kinds).toEqual(["camera", "light", "light", "mesh"]);
  });

  it("+ Clip › 3D world is a world nested as a layer, the parent's size", () => {
    const doc = createEmptyDocument();
    const parent = doc.frames[0]!;
    const r = addWorldClip(doc, parent.id, { startMs: 200, durationMs: 1500 })!;
    const world = doc.frames.find((f) => f.id === r.frameId)!;
    expect([world.width, world.height]).toEqual([parent.width, parent.height]);
    const nested = locateClip(doc, r.nestedId)!.clip;
    expect([nested.startMs, nested.durationMs]).toEqual([200, 1500]);
  });
});
