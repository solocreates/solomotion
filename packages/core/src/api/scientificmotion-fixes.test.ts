import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { locateClip } from "../timeline/ops";
import { frameEffectClip } from "../timeline/frame-effects";
import { createCommandApi, type CommandContext } from ".";

/**
 * What the ScientificMotion Shorts ("Two Balls, One Round Room", "6174") hit
 * on 2026-11-03, driven the way an agent drives it: through `call`.
 */

function harness() {
  const store = createDocumentStore(createEmptyDocument("Test"));
  const api = createCommandApi();
  let playhead = 0;
  const ctx: CommandContext = {
    store,
    actor: "AI",
    historyKey: "turn-1",
    historyLabel: "Shorts",
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
  return { store, call, seek: (ms: number) => (playhead = ms) };
}

describe("a comp's own effects: one stack, read, replaced and cleared through the API", () => {
  it("frame.get reads what effects.add put on the comp; frame.update replaces and clears it", async () => {
    const { store, call } = harness();
    const comp = store.getState().frames[0]!.id;
    expect(((await call("frame.get", { id: comp })) as { effects: unknown }).effects).toBeNull();
    const added = await call("effects.add", { id: comp, type: "grain" });
    // Said, not silent: the card is on the comp's own stack, carried by its layer.
    expect(added.comp).toBe(comp);
    const got = (await call("frame.get", { id: comp })) as { effects: { layerId: string; cards: Array<{ type: string }> }; durationMs: number };
    expect(got.effects.layerId).toBe(added.id);
    expect(got.effects.cards.map((c) => c.type)).toEqual(["grain"]);
    expect(got.durationMs).toBeGreaterThan(0);
    // Replace: the old card and its keys go, the new stack is the comp's.
    await call("keyframes.set", { id: added.id, property: `lfx.${added.effectId}.amount`, keys: [{ at: 0, value: 0.1 }, { at: 500, value: 0.4 }] });
    const replaced = (await call("frame.update", { id: comp, effects: [{ type: "vignette" }, { type: "grain" }] })) as { effects: { layerId: string; cards: Array<{ type: string; id: string }> } };
    expect(replaced.effects.layerId).toBe(added.id);
    expect(replaced.effects.cards.map((c) => c.type)).toEqual(["vignette", "grain"]);
    expect(replaced.effects.cards.every((c) => typeof c.id === "string" && c.id.length > 0)).toBe(true);
    expect(locateClip(store.getState(), String(added.id))!.clip.keyframes.some((t) => t.property.includes(String(added.effectId)))).toBe(false);
    // Clear: the comp has no effects of its own, and no empty processor is left behind.
    const cleared = (await call("frame.update", { id: comp, effects: [] })) as { effects: unknown };
    expect(cleared.effects).toBeNull();
    expect(frameEffectClip(store.getState(), comp)).toBeNull();
    expect(locateClip(store.getState(), String(added.id))).toBeNull();
  });
});

describe("a group's pivot is visible", () => {
  it("layer.get names the point a group scales about, and the camera maths it implies holds", async () => {
    const { store, call } = harness();
    const a = await call("layer.create", { kind: "shape", shape: "rect", width: 100, height: 100, x: 100, y: -50, startMs: 0, durationMs: 4000 });
    const b = await call("layer.create", { kind: "shape", shape: "rect", width: 100, height: 100, x: 300, y: 150, startMs: 0, durationMs: 4000 });
    const g = await call("layers.group", { ids: [a.id, b.id], name: "Camera" });
    const got = (await call("layer.get", { id: g.id })) as { pivot: { x: number; y: number }; transform: { x: number; y: number } };
    // The box of what it holds runs x 50..350, y −100..200: its centre.
    expect(got.pivot).toEqual({ x: 200, y: 50 });
    expect(got.transform).toMatchObject({ x: 0, y: 0 });
    // Zoom ×2 about comp point P = (300, 150) — b's centre — with the documented offset.
    const s = 2;
    const P = { x: 300, y: 150 };
    await call("layer.set", { ids: g.id, values: { scale: s, x: (1 - s) * (P.x - got.pivot.x), y: (1 - s) * (P.y - got.pivot.y) }, mode: "base" });
    const { groupChainMatrix } = await import("../timeline/group-space");
    const { apply } = await import("../navigation/matrix");
    const placed = apply(groupChainMatrix(store.getState(), String(b.id), () => 0), { x: 300, y: 150 });
    expect(placed.x).toBeCloseTo(P.x, 6);
    expect(placed.y).toBeCloseTo(P.y, 6);
  });
});

describe("a comp's length has one home", () => {
  it("a lone comp keeps its length when a second comp is added, even with a sound past its end", async () => {
    const { store, call } = harness();
    const comp = store.getState().frames[0]!.id;
    await call("frame.update", { id: comp, durationMs: 26000 });
    await call("layer.create", { kind: "shape", shape: "rect", width: 10, height: 10, startMs: 22000, durationMs: 4650 });
    expect(((await call("frame.get", { id: comp })) as { durationMs: number }).durationMs).toBe(26000);
    await call("frame.create", { name: "Two Balls", width: 1080, height: 1920 });
    const after = (await call("frame.get", { id: comp })) as { durationMs: number; durationFollowsContent: boolean };
    expect(after.durationMs).toBe(26000);
    expect(after.durationFollowsContent).toBe(false);
    // A comp made without a length says it follows its content.
    const free = await call("frame.create", { name: "Loose", width: 100, height: 100 });
    expect(((await call("frame.get", { id: free.id })) as { durationFollowsContent: boolean }).durationFollowsContent).toBe(true);
  });

  it("an older one-comp file keeps its length through the migration", async () => {
    const { parseDocument, serializeDocument } = await import("../io");
    const doc = createEmptyDocument("Old");
    const raw = JSON.parse(serializeDocument(doc)) as Record<string, unknown> & { frames: Array<Record<string, unknown>> };
    raw.version = 112;
    raw.durationMs = 26000;
    raw.frames[0]!.durationMs = null;
    const migrated = parseDocument(JSON.stringify(raw));
    expect(migrated.frames[0]!.durationMs).toBe(26000);
  });
});

describe("whole-millisecond times land on the frame they name", () => {
  it("layer.create {startMs: 133} at 30 fps starts on frame 4, not 3", async () => {
    const { call } = harness();
    await call("frame.update", { fps: 30 });
    const a = await call("layer.create", { kind: "shape", shape: "rect", width: 10, height: 10, startMs: 133, durationMs: 1000 });
    expect(a.startMs).toBeCloseTo(4000 / 30, 3);
    const b = await call("layer.create", { kind: "shape", shape: "rect", width: 10, height: 10, startMs: 1333, durationMs: 1000 });
    expect(b.startMs).toBeCloseTo(40000 / 30, 3);
    // A time inside a frame still floors to it.
    const c = await call("layer.create", { kind: "shape", shape: "rect", width: 10, height: 10, startMs: 120, durationMs: 1000 });
    expect(c.startMs).toBe(100);
  });
});

describe("a particle or force null tracks its comp's length", () => {
  it("made in a fresh comp, it spans the length the comp is given afterwards", async () => {
    const { store, call } = harness();
    const comp = (await call("frame.create", { name: "Texture", width: 1080, height: 1080 })) as { id: string };
    const sparks = await call("physics.emit", { frameId: comp.id, look: "sparks" });
    const wind = await call("physics.force", { frameId: comp.id, type: "wind" });
    await call("frame.update", { id: comp.id, durationMs: 24_000 });
    expect(locateClip(store.getState(), String(sparks.layerId))!.clip.durationMs).toBe(24_000);
    expect(locateClip(store.getState(), String(wind.layerId))!.clip.durationMs).toBe(24_000);
  });
});
