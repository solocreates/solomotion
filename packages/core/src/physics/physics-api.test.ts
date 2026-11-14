import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { createCommandApi, type CommandContext } from "../api";
import type { VisualClip } from "../schema";

function harness() {
  const store = createDocumentStore(createEmptyDocument("Test"));
  const api = createCommandApi();
  const ctx: CommandContext = {
    store,
    actor: "AI",
    historyKey: "turn-1",
    historyLabel: "Physics",
    session: { focusFrameId: () => store.getState().frames[0]?.id ?? null, playheadMs: () => 0, selection: () => [] },
  };
  const call = async (id: string, input: unknown = {}) => {
    const res = await api.call(id, input, ctx);
    if (!res.ok) throw new Error(`${id}: ${res.error}${res.hint ? ` (${res.hint})` : ""}`);
    return res.value as Record<string, unknown>;
  };
  return { store, call };
}

type Inspect = { bodies: Array<{ name: string; at: { x: number; y: number; rotation: number } }>; forces: unknown[]; joints: unknown[]; simulating: boolean };

describe("physics through the API, the way an agent does it", () => {
  it("drops a word and a ball into a walled comp, blows them with a field, hangs a sign on a pin", async () => {
    const { call } = harness();
    await call("physics.scene", { walls: true, gravity: 981 });
    const ball = (await call("layer.create", { kind: "shape", shape: "ellipse", width: 80, height: 80, x: -200, y: -400, name: "Ball" })) as { id: string };
    const box = (await call("layer.create", { kind: "shape", shape: "rect", width: 160, height: 60, x: 200, y: -400, name: "Box" })) as { id: string };
    await call("physics.body", { ids: [ball.id, box.id], bounce: 0.2 });
    // A wind blowing right, everywhere.
    const wind = (await call("physics.force", { type: "wind", strength: 600, falloff: "none", name: "Wind" })) as { layerId: string; forceId: string };
    expect(wind.forceId).toBeTruthy();
    // A sign hanging from a pin in the air.
    const sign = (await call("layer.create", { kind: "shape", shape: "rect", width: 200, height: 40, x: 0, y: -100, name: "Sign" })) as { id: string };
    await call("physics.body", { ids: sign.id, damping: 0 });
    await expect(call("physics.joint", { id: wind.layerId, add: [{ type: "pin" }] })).rejects.toThrow(/not a body/);
    const j = (await call("physics.joint", { id: sign.id, add: [{ type: "pin", anchor: [-100, 0, 0] }] })) as { joints: Array<{ id: string; type: string }> };
    expect(j.joints).toHaveLength(1);

    const at = async (ms: number) => (await call("physics.inspect", { atMs: ms })) as Inspect;
    const start = await at(0);
    expect(start.bodies.find((b) => b.name === "Ball")!.at).toMatchObject({ x: -200, y: -400 });
    const later = await at(3000);
    const b = later.bodies.find((x) => x.name === "Ball")!.at;
    // Blown right into the right wall (x < 540 − 40) and down to the floor (y ≈ 960 − 40 for a 1080×1920 comp, or the comp's own bottom).
    expect(b.x).toBeGreaterThan(300);
    expect(b.x).toBeLessThan(541);
    expect(b.y).toBeGreaterThan(start.bodies.find((x) => x.name === "Ball")!.at.y + 300);
    // The sign's left end stays on its pin while it swings.
    const s = later.bodies.find((x) => x.name === "Sign")!.at;
    const r = (s.rotation * Math.PI) / 180;
    expect(Math.hypot(s.x - 100 * Math.cos(r) - -100, s.y - 100 * Math.sin(r) - -100)).toBeLessThan(4);
    expect(later.forces).toHaveLength(1);

    // Gone again: the layer stays where its keys and transform put it.
    await call("physics.body", { ids: ball.id, type: null });
    expect((await at(3000)).bodies.some((x) => x.name === "Ball")).toBe(false);
  });

  it("emits particles in a look, keys them like any card, and catalogues the looks", async () => {
    const { call, store } = harness();
    const rain = (await call("physics.emit", { look: "rain" })) as { layerId: string; emitterId: string; path: string };
    const doc = store.getState();
    const frame = doc.frames[0]!;
    const carrier = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === rain.layerId)! as VisualClip;
    // Rain is a strip across the comp's top, emitting downward: turned to aim down, so its length is its Y scale.
    expect(carrier.transform.y).toBeLessThan(-frame.height / 2);
    expect(carrier.transform.rotation).toBe(90);
    expect(carrier.transform.scaleY! * 100).toBeGreaterThan(frame.width);
    // Its splash came with it, a sub of the rain.
    expect(carrier.emitters!.map((e) => e.type)).toEqual(["stream", "sub"]);
    expect((rain as unknown as { emitterIds: string[] }).emitterIds).toHaveLength(2);
    expect(carrier.emitters![0]!.source).toBe("area");
    // A field passed wins over the look; the card keys like any other.
    const sparks = (await call("physics.emit", { look: "sparks", rate: 30, position: [0, 200] })) as { layerId: string; emitterId: string };
    const card = (store.getState().tracks.flatMap((t) => t.clips).find((c) => c.id === sparks.layerId)! as VisualClip).emitters![0]!;
    expect(card.rate).toBe(30);
    expect(card.shape).toBe("spark");
    await call("keyframes.set", { id: sparks.layerId, property: `emit.${sparks.emitterId}.rate`, keys: [{ at: 0, value: 0 }, { at: 500, value: 200 }] });
    const looks = (await call("catalog.list", { catalog: "emitters" })) as unknown as Array<{ id: string }>;
    expect(looks.map((l) => l.id)).toEqual(expect.arrayContaining(["stream", "burst", "hit", "look:confetti", "look:impact"]));
    // On hit, on an existing layer: its own hits.
    const impact = (await call("physics.emit", { id: sparks.layerId, look: "impact", threshold: 300 })) as { emitterId: string };
    const stack = (store.getState().tracks.flatMap((t) => t.clips).find((c) => c.id === sparks.layerId)! as VisualClip).emitters!;
    expect(stack.find((e) => e.id === impact.emitterId)).toMatchObject({ type: "hit", threshold: 300, shape: "spark" });
    await expect(call("physics.emit", { look: "sparks", instance: "nope" })).rejects.toThrow();
  });
});
