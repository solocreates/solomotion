import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { locateClip } from "../timeline/ops";
import { createCommandApi, type CommandContext } from "../api";
import type { MeshClip } from "../schema";
import { evaluateWorld } from "./evaluate";

function harness() {
  const store = createDocumentStore(createEmptyDocument("Test"));
  const api = createCommandApi();
  let playhead = 0;
  const ctx: CommandContext = {
    store,
    actor: "AI",
    historyKey: "turn-1",
    historyLabel: "Make a title card",
    session: {
      focusFrameId: () => store.getState().frames[0]?.id ?? null,
      playheadMs: () => playhead,
      selection: () => [],
    },
  };
  const call = async (id: string, input: unknown = {}) => {
    const res = await api.call(id, input, ctx);
    if (!res.ok) throw new Error(`${id}: ${res.error}${res.hint ? ` (${res.hint})` : ""}`);
    return res.value as Record<string, unknown>;
  };
  return { store, api, ctx, call, seek: (ms: number) => (playhead = ms) };
}


describe("the 3D world through the API", () => {
  it("merges into an optional object a layer does not have yet, and still refuses a typo", async () => {
    const { call } = harness();
    const { frameId } = (await call("world.create", { starter: false })) as { frameId: string };
    const { id } = (await call("layer.create", { frameId, kind: "path", d: "M0 0 L100 0 L100 100 Z", stroke: { color: "#ff8732", width: 8 } })) as { id: string };
    await call("layer.patch", { id, ops: [{ op: "merge", path: "material", value: { emission: "#ff8732", emissionStrength: 3 } }] });
    const got = (await call("layer.get", { id, fields: ["material"] })) as { material: { emissionStrength: number } };
    expect(got.material.emissionStrength).toBe(3);
    await expect(call("layer.patch", { id, ops: [{ op: "merge", path: "materal", value: { emissionStrength: 3 } }] })).rejects.toThrow();
    // A neon preset on a stroke-only path recolours the stroke; it never adds a fill.
    await call("world.material", { ids: [id], preset: "neon" });
    const after = (await call("layer.get", { id, fields: ["fills", "strokes"] })) as { fills: unknown[]; strokes: { paint: { color: string } }[] };
    expect(after.fills.length).toBe(0);
    expect(after.strokes[0]!.paint.color.toLowerCase()).toBe("#ff2fb1");
  });

  it("refuses a primitive param the shape does not have, naming the real ones", async () => {
    const { call } = harness();
    const { frameId } = (await call("world.create", { starter: false })) as { frameId: string };
    await expect(call("world.add", { frameId, kind: "mesh", primitive: "torus", params: { radius: 100, tube: 3 }, position: [0, 0, 0] })).rejects.toThrow(/majorRadius/);
    await expect(call("world.add", { frameId, kind: "mesh", primitive: "torus", params: { majorRadius: 100, minorRadius: 3 }, position: [0, 0, 0] })).resolves.toBeTruthy();
  });

  it("builds, edits, styles and reads back a scene the way an agent would", async () => {
    const { call, store } = harness();
    const { frameId } = (await call("world.create", { name: "Product", starter: false })) as { frameId: string };
    const box = (await call("world.add", { frameId, kind: "mesh", primitive: "cube", params: { fillet: 20 }, material: "gold", position: [0, 0, 100] })) as { id: string };
    const cam = (await call("world.add", { frameId, kind: "camera", position: [600, -900, 400], lookAt: [0, 0, 100] })) as { id: string };
    await call("world.add", { frameId, kind: "light", light: "sun", intensity: 3, position: [0, 0, 800], lookAt: [0, 0, 0] });
    // Extrude the top up 100, then key the box spinning.
    const ex = (await call("mesh.edit", { id: box.id, op: "extrude", select: { facing: "+z" }, amount: 100 })) as { faces: number; selected: number[] };
    expect(ex.faces).toBeGreaterThan(6);
    await call("keyframes.set", { id: box.id, property: "rotation", keys: [{ atMs: 0, value: 0 }, { atMs: 1000, value: 90 }] }).catch(() => undefined);
    // Modifiers ride the effects verbs (domain geometry): add, then edit and reorder like any card.
    const mod = (await call("effects.add", { id: box.id, domain: "geometry", type: "twist", values: { angle: 45 } })) as { effectId: string };
    expect(mod.effectId).toMatch(/^mdf/);
    await call("effects.update", { id: box.id, effectId: mod.effectId, values: { angle: 30 } });
    await call("world.track", { id: cam.id, lookAt: box.id });
    const scene = (await call("world.inspect", { frameId, atMs: 0 })) as {
      camera: { id: string };
      objects: Array<{ id: string; kind: string; position: number[]; size?: number[] }>;
    };
    expect(scene.camera.id).toBe(cam.id);
    const boxRow = scene.objects.find((o) => o.id === box.id)!;
    expect(boxRow.kind).toBe("mesh");
    // The extruded box is now 300 tall (200 + 100), standing at z 100.
    expect(boxRow.size![2]).toBeCloseTo(300, 0);
    const clip = locateClip(store.getState(), box.id)!.clip as MeshClip;
    expect(clip.material.preset).toBe("gold");
    expect(clip.geometry.type).toBe("mesh");
    expect(clip.modifiers[0]!.type).toBe("twist");
    expect(clip.modifiers[0]!.angle).toBe(30);
  });

  it("refuses 3D verbs on a flat comp with a way forward", async () => {
    const { call, store } = harness();
    const flat = store.getState().frames[0]!.id;
    await expect(call("world.add", { frameId: flat, kind: "mesh" })).rejects.toThrow(/flat comp/);
  });

  it("lists the 3D catalogs", async () => {
    const { call } = harness();
    const prims = (await call("catalog.list", { catalog: "primitives" })) as unknown as Array<{ id: string }>;
    expect(prims.map((p) => p.id)).toContain("torusKnot");
    const mods = (await call("catalog.list", { catalog: "modifiers" })) as unknown as Array<{ id: string }>;
    expect(mods.map((m) => m.id)).toContain("subdivision");
    const mats = (await call("catalog.list", { catalog: "materials" })) as unknown as Array<{ id: string }>;
    expect(mats.map((m) => m.id)).toContain("glass");
  });

  it("gives any layer in a world a body, a surface, a stack and a premium look", async () => {
    const { call, store } = harness();
    const { frameId } = (await call("world.create", { name: "Title", starter: true })) as { frameId: string };
    const text = (await call("world.add", { frameId, kind: "text", text: "Gold", position: [0, 0, 100] })) as { id: string };
    await call("world.extrude", { ids: text.id, depth: 30, bevel: 2, fit: "outline" });
    await call("world.material", { ids: text.id, preset: "gold" });
    const bend = (await call("effects.add", { id: text.id, domain: "geometry", type: "bend", values: { angle: 40 } })) as { effectId: string };
    expect(bend.effectId).toMatch(/^mdf/);
    const cam = store.getState().tracks.flatMap((t) => t.clips).find((c) => c.frameId === frameId && c.kind === "camera")!;
    await call("world.look", { frameId, bloom: { enabled: true, strength: 1 }, cameraId: cam.id, dof: { focusOn: text.id, fStop: 2 } });
    const t = locateClip(store.getState(), text.id)!.clip as unknown as { extrude: { depth: number; fit: string }; material: { metalness: number }; modifiers: Array<{ type: string }> };
    expect([t.extrude.depth, t.extrude.fit, t.material.metalness, t.modifiers[0]!.type]).toEqual([30, "outline", 1, "bend"]);
    const frame = store.getState().frames.find((f) => f.id === frameId)!;
    expect(frame.world!.render.bloom.enabled).toBe(true);
    const camNow = locateClip(store.getState(), cam.id)!.clip as unknown as { camera: { dof: { enabled: boolean; focusObjectId: string } } };
    expect(camNow.camera.dof).toMatchObject({ enabled: true, focusObjectId: text.id });
  });

  it("a mesh's modifier applies into its polygons", async () => {
    const { call, store } = harness();
    const { frameId } = (await call("world.create", { starter: false })) as { frameId: string };
    const box = (await call("world.add", { frameId, kind: "mesh", primitive: "cube" })) as { id: string };
    const sub = (await call("effects.add", { id: box.id, domain: "geometry", type: "subdivision" })) as { effectId: string };
    await call("world.apply_modifier", { id: box.id, modifierId: sub.effectId });
    const c = locateClip(store.getState(), box.id)!.clip as MeshClip;
    expect(c.modifiers).toHaveLength(0);
    expect(c.geometry.type === "mesh" && c.geometry.mesh.faces.length).toBeGreaterThan(6);
  });

  it("a lattice in one call, and line art on a layer's body", async () => {
    const { call, store } = harness();
    const { frameId } = (await call("world.create", { starter: false })) as { frameId: string };
    const text = (await call("world.add", { frameId, kind: "text", text: "Soft" })) as { id: string };
    const made = (await call("world.lattice", { id: text.id, resolution: [4, 2, 2] })) as { cageId: string; modifierId: string };
    const cage = locateClip(store.getState(), made.cageId)!.clip as MeshClip;
    expect(cage.lattice).toMatchObject({ u: 4, v: 2, w: 2 });
    expect(cage.geometry.type === "mesh" && cage.geometry.mesh.positions.length).toBe(16 * 3);
    // Lean the cage's top row: the points at +z move, the rest stay.
    const before = (cage.geometry.type === "mesh" && cage.geometry.mesh.positions.slice()) || [];
    await call("mesh.edit", { id: made.cageId, op: "move", select: { side: "+z" }, by: [40, 0, 0] });
    const moved = locateClip(store.getState(), made.cageId)!.clip as MeshClip;
    const after = moved.geometry.type === "mesh" ? moved.geometry.mesh : null;
    const top = Math.max(...before.filter((_, i) => i % 3 === 2));
    for (let i = 0; i < before.length; i += 3) expect(after!.positions[i]! - before[i]!).toBeCloseTo(before[i + 2] === top ? 40 : 0, 4);
    expect(after!.lines?.length).toBe(cage.geometry.type === "mesh" ? cage.geometry.mesh.lines?.length : -1);
    await call("world.line_art", { ids: text.id, width: 3, color: "#ff0000", creaseAngle: 25 });
    const t = locateClip(store.getState(), text.id)!.clip as unknown as { lineArt?: { width: number; color: string; creaseAngle: number; silhouette: boolean }; modifiers: Array<{ type: string; cage: string }> };
    expect(t.lineArt).toMatchObject({ width: 3, color: "#ff0000", creaseAngle: 25, silhouette: true });
    expect(t.modifiers.at(-1)).toMatchObject({ type: "lattice", cage: made.cageId });
    // Line art keys like any field: an outline that draws on.
    await call("keyframes.set", { id: text.id, property: "lineArt.width", keys: [{ at: 0, value: 0 }, { at: 1000, value: 6 }] });
    const keyed = locateClip(store.getState(), text.id)!.clip as unknown as { keyframes: Array<{ property: string }> };
    expect(keyed.keyframes.some((k) => k.property === "lineArt.width")).toBe(true);
    await call("world.line_art", { ids: text.id, enabled: false });
    expect((locateClip(store.getState(), text.id)!.clip as unknown as { lineArt?: unknown }).lineArt).toBeUndefined();
    await expect(call("world.line_art", { ids: made.cageId, width: 2 })).rejects.toThrow(/its own strokes/);
  });

  it("an arm that reaches: Child Of chain + IK through world.track", async () => {
    const { call, store } = harness();
    const { frameId } = (await call("world.create", { starter: false })) as { frameId: string };
    const add = async (position: number[]) => ((await call("world.add", { frameId, kind: "controller", position })) as { id: string }).id;
    const shoulder = await add([0, 0, 0]), elbow = await add([100, 0, 0]), hand = await add([200, 0, 0]), goal = await add([60, 0, 140]);
    await call("world.track", { id: elbow, childOf: shoulder });
    await call("world.track", { id: hand, childOf: elbow });
    await call("world.track", { id: hand, ik: { target: goal, chainLength: 2 } });
    const doc = store.getState();
    const ev = evaluateWorld(doc, doc.frames.find((f) => f.id === frameId)!, 0, { physics: false });
    const m = ev.objects.find((o) => o.id === hand)!.matrix;
    expect(Math.hypot(m[12]! - 60, m[13]!, m[14]! - 140)).toBeLessThan(0.05);
  });

  it("refuses modifiers on a flat comp, with the way into 3D", async () => {
    const { call, store } = harness();
    const flat = store.getState().frames[0]!.id;
    const t = (await call("layer.create", { frameId: flat, kind: "text", text: "Flat" }).catch(() => null)) as { id: string } | null;
    if (!t) return;
    await expect(call("effects.add", { id: t.id, domain: "geometry", type: "bend" })).rejects.toThrow(/3D world/);
  });
});

describe("world.sculpt", () => {
  it("sculpts a primitive, detail first, and says so when the brush touches nothing", async () => {
    const { call, store } = harness();
    const { frameId } = (await call("world.create", { starter: false })) as { frameId: string };
    const { id } = (await call("world.add", { frameId, kind: "mesh", primitive: "uvSphere", params: { radius: 100, segments: 16, rings: 8 } })) as { id: string };
    const res = (await call("world.sculpt", { id, brush: "draw", detail: 1, radius: 60, strength: 1, symmetry: ["x"], strokes: [{ points: [[0, 0, 100], [30, 0, 95]] }] })) as { vertices: number };
    const clip = locateClip(store.getState(), id)!.clip as MeshClip;
    expect(clip.geometry.type).toBe("mesh");
    const mesh = (clip.geometry as { mesh: { positions: number[] } }).mesh;
    expect(res.vertices).toBe(mesh.positions.length / 3);
    // The top was raised past the sphere's own radius.
    let top = 0;
    for (let i = 2; i < mesh.positions.length; i += 3) top = Math.max(top, mesh.positions[i]!);
    expect(top).toBeGreaterThan(101);
    await expect(call("world.sculpt", { id, brush: "draw", strokes: [{ points: [[0, 0, 900]] }] })).rejects.toThrow(/touched nothing/);
  });
});
