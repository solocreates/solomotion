import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { locateClip } from "../timeline/ops";
import { fitScale } from "../media/asset-clip";
import { serializeDocument } from "../io";
import { pixelCount } from "../navigation/matrix";
import { createCommandApi, type CommandContext } from ".";

/**
 * What film sessions hit on 2026-11-02 (notes/fix-pass-2026-11-02.md), driven
 * the way an agent drives it: through `call`.
 */

function harness() {
  const store = createDocumentStore(createEmptyDocument("Test"));
  const api = createCommandApi();
  let playhead = 0;
  const ctx: CommandContext = {
    store,
    actor: "AI",
    historyKey: "turn-1",
    historyLabel: "Film",
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

const clipOf = (store: ReturnType<typeof harness>["store"], id: unknown) => locateClip(store.getState(), String(id))!.clip;

describe("film fixes 2026-11-02", () => {
  it("text.style gives a word range its own text effect and outline", async () => {
    const { call, store } = harness();
    const title = await call("layer.create", { kind: "text", text: "not AI slop" });
    await call("text.style", { id: title.id, match: "slop", style: { textEffects: [{ type: "shadow", y: 6, blur: 0, color: "#000000" }] } });
    await call("text.style", { id: title.id, match: "AI", strokes: [{ color: "#ff2885", width: 3 }] });
    const text = clipOf(store, title.id);
    if (text.kind !== "text") throw new Error("not text");
    const slop = text.ranges.find((r) => r.overlay?.added.textEffects.length);
    expect(slop).toMatchObject({ start: 7, end: 11 });
    expect(slop!.overlay!.added.textEffects[0]).toMatchObject({ type: "shadow", y: 6 });
    // The effect is an ADDITION, never a scalar prop.
    expect(Object.keys(slop!.overlay!.props)).not.toContain("textEffects");
    const ai = text.ranges.find((r) => r.overlay?.added.strokes.length);
    expect(ai).toMatchObject({ start: 4, end: 6 });
    expect(ai!.overlay!.added.strokes[0]).toMatchObject({ width: 3 });
    // The layer itself keeps no outline.
    expect(text.strokes ?? []).toHaveLength(0);
  });

  it("a particle or force null spans its whole comp, not the document's 10 s", async () => {
    const { call, store } = harness();
    const comp = (await call("frame.create", { name: "Long", width: 1080, height: 1080, durationMs: 24_000 })) as { id: string };
    const sparks = await call("physics.emit", { frameId: comp.id, look: "sparks" });
    const wind = await call("physics.force", { frameId: comp.id, type: "wind" });
    expect(clipOf(store, sparks.layerId).durationMs).toBe(24_000);
    expect(clipOf(store, wind.layerId).durationMs).toBe(24_000);
  });

  it("keyframes.set says when a key lands where the layer is not", async () => {
    const { call } = harness();
    const dot = await call("layer.create", { kind: "shape", shape: "ellipse", width: 40, height: 40, durationMs: 2000 });
    const inside = await call("keyframes.set", { id: dot.id, property: "opacity", keys: [{ at: 0, value: 0 }, { at: 1000, value: 1 }] });
    expect(inside.warning).toBeUndefined();
    const late = await call("keyframes.set", { id: dot.id, property: "scale", keys: [{ at: 500, value: 1 }, { at: 3500, value: 2 }] });
    expect(String(late.warning)).toMatch(/outside the layer/);
  });

  it("a picture shaped like its comp lands filling it", () => {
    const comp = { width: 1080, height: 1920 };
    expect(fitScale({ width: 2160, height: 3840 }, comp)).toBe(0.5);
    expect(fitScale({ width: 1080, height: 1920 }, comp)).toBe(1);
    // Smaller and comp-shaped: native, never upscaled.
    expect(fitScale({ width: 540, height: 960 }, comp)).toBe(1);
    // Any other shape keeps its breathing room.
    expect(fitScale({ width: 4000, height: 3000 }, comp)).toBeCloseTo((1080 / 4000) * 0.9);
  });

  it("layer.pivot moves the pivot and holds the picture still, keys included", async () => {
    const { call, store } = harness();
    const box = await call("layer.create", { kind: "shape", shape: "rect", width: 200, height: 100, x: 300, y: 200, durationMs: 2000 });
    await call("layer.set", { ids: box.id, values: { rotation: 30 }, mode: "base" });
    await call("keyframes.set", { id: box.id, property: "x", keys: [{ at: 0, value: 300 }, { at: 1000, value: 500 }] });
    const before = clipOf(store, box.id);
    await call("layer.pivot", { ids: box.id, anchor: "top-left" });
    const after = clipOf(store, box.id);
    if (after.kind === "audio" || before.kind === "audio") throw new Error("audio");
    expect(after.transform.anchor).toEqual({ x: 0, y: 0 });
    // The corner sits where the centre was, rotated: the layer moved by the
    // rotated half-box, and every x key by the same vector.
    const rad = (30 * Math.PI) / 180;
    const dx = -100 * Math.cos(rad) + 50 * Math.sin(rad);
    const xKeys = after.keyframes.find((t) => t.property === "x")!.keys.map((k) => k.value as number);
    expect(xKeys[0]! - 300).toBeCloseTo(dx, 3);
    expect(xKeys[1]! - 500).toBeCloseTo(dx, 3);
  });

  it("a buffer is as wide as its picture, whatever single precision says", () => {
    // DOMMatrix stores 0.4 as 0.4000000059604645: 1080 of it is 432.0000064.
    expect(pixelCount(1080 * Math.fround(0.4))).toBe(432);
    expect(pixelCount(432.5)).toBe(433);
    expect(pixelCount(0)).toBe(1);
  });

  it("a saved document carries no expression nothing points at", async () => {
    const { call, store } = harness();
    const a = await call("layer.create", { kind: "shape", shape: "rect", width: 50, height: 50 });
    await call("expression.set", { id: a.id, property: "x", source: "#time * 100" });
    expect(store.getState().expressions).toHaveLength(1);
    await call("layers.delete", { ids: a.id });
    // Still held live, so undo brings the layer back whole…
    expect(store.getState().expressions).toHaveLength(1);
    // …but nothing written out carries it.
    expect(JSON.parse(serializeDocument(store.getState())).expressions).toHaveLength(0);
  });
});

describe("film fixes 2026-11-02, pass 2", () => {
  it("names a sound that rides nothing when it is written, and stops once it has something to ride", async () => {
    const { store, call } = harness();
    const sun = await call("layer.create", { kind: "shape", shape: "ellipse", width: 200, height: 200, name: "Sun" });
    const pop = { pack: "pop", volume: 0.8, randomness: 0, pitch: 1, phase: "in", trigger: { kind: "layer" } };
    // Keyframes are not an in-animation: the cue has no moment to fire on.
    await call("keyframes.set", { id: sun.id, property: "scale", keys: [{ at: 0, value: 0 }, { at: 600, value: 1 }] });
    const silent = await call("layer.patch", { id: sun.id, ops: [{ op: "set", path: "sounds", value: [pop] }] });
    expect(silent.warning).toMatch(/Silent: pop — it rides "Sun"'s in animation, and the layer has none/);
    await call("animation.set", { id: sun.id, slot: "in", preset: "fade-up" });
    const rides = await call("layer.patch", { id: sun.id, ops: [{ op: "set", path: "sounds[0].volume", value: 0.6 }] });
    expect(rides.warning).toBeUndefined();
    // An unrelated patch never warns.
    expect((await call("layer.patch", { id: sun.id, ops: [{ op: "set", path: "name", value: "Sol" }] })).warning).toBeUndefined();
    expect(clipOf(store, sun.id).sounds).toHaveLength(1);
  });

  it("answers layers.group with `id`, like every verb that makes something", async () => {
    const { call } = harness();
    const a = await call("layer.create", { kind: "shape", shape: "rect", width: 40, height: 40 });
    const b = await call("layer.create", { kind: "shape", shape: "rect", width: 40, height: 40, x: 100 });
    const g = await call("layers.group", { ids: [a.id, b.id], name: "Pair" });
    expect(g.id).toBeTruthy();
    expect(g.groupId).toBe(g.id);
    // …so a batch's `$n.id` reaches it.
    await call("keyframes.set", { id: g.id, property: "x", keys: [{ at: 0, value: 0 }, { at: 300, value: 200 }] });
  });
});
