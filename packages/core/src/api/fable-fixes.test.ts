import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { locateClip } from "../timeline/ops";
import { sampleKeyframes } from "../animation/keyframes";
import { resolveTextEffect } from "../animation/text-effects";
import { createCommandApi, type CommandContext } from ".";

/**
 * What the "How ideas go viral" film sessions hit on 2026-11-10
 * (a CreativeDesk feedback file), driven the way an agent drives it.
 */

function harness() {
  const store = createDocumentStore(createEmptyDocument("Test"));
  const api = createCommandApi();
  const ctx: CommandContext = {
    store,
    actor: "AI",
    historyKey: "turn-1",
    historyLabel: "Film",
    session: { focusFrameId: () => store.getState().frames[0]?.id ?? null, playheadMs: () => 0, selection: () => [] },
  };
  const raw = (id: string, input: unknown = {}) => api.call(id, input, ctx);
  const call = async (id: string, input: unknown = {}) => {
    const res = await raw(id, input);
    if (!res.ok) throw new Error(`${id}: ${res.error}${res.hint ? ` (${res.hint})` : ""}`);
    return res.value as Record<string, unknown>;
  };
  return { store, call, raw };
}

const rect = (name: string, frameId?: string) => ({ kind: "shape", shape: "rect", width: 50, height: 50, name, ...(frameId ? { frameId } : {}) });

describe("film fixes 2026-11-10", () => {
  it("layers.restack takes above/below on their own and names every form when it can't parse `to`", async () => {
    const { call, raw, store } = harness();
    const a = await call("layer.create", rect("A"));
    const b = await call("layer.create", rect("B"));
    await call("layers.restack", { ids: [a.id], below: b.id });
    const lane = (id: unknown) => locateClip(store.getState(), String(id))!.trackIndex;
    expect(lane(a.id)).toBeGreaterThan(lane(b.id));
    await call("layers.restack", { ids: [a.id], above: b.id });
    expect(lane(a.id)).toBeLessThan(lane(b.id));
    await call("layers.restack", { ids: [b.id], to: "top" });
    expect(lane(b.id)).toBeLessThan(lane(a.id));
    const bad = await raw("layers.restack", { ids: [a.id], to: "above" });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain('{above: "<layer id>"}');
  });

  it("layers.copy into another comp lands in front, not under its backdrop", async () => {
    const { call, store } = harness();
    const a = await call("layer.create", rect("A"));
    const b = await call("layer.create", rect("B"));
    const other = await call("frame.create", { name: "Other", width: 400, height: 400 });
    const bg = await call("layer.create", rect("BG", String(other.id)));
    const { ids } = (await call("layers.copy", { ids: [a.id, b.id], toFrameId: other.id })) as { ids: string[] };
    const lane = (id: unknown) => locateClip(store.getState(), String(id))!.trackIndex;
    const [ca, cb] = ids;
    expect(lane(ca)).toBeLessThan(lane(bg.id));
    expect(lane(cb)).toBeLessThan(lane(bg.id));
    // Their own order is kept: B was above A, so its copy is too.
    expect(lane(cb)).toBeLessThan(lane(ca));
  });

  it("a text effect's field is keyable at the path effects.add returns, and the key plays", async () => {
    const { call, store } = harness();
    const t = await call("layer.create", { kind: "text", text: "viral" });
    const fx = await call("effects.add", { id: t.id, domain: "text", type: "echo" });
    expect(fx.path).toBe(`tfx.${fx.effectId}.<field>`);
    await call("keyframes.set", { id: t.id, property: `tfx.${fx.effectId}.distance`, keys: [{ at: 0, value: 0 }, { at: 1000, value: 80 }] });
    // What the painter reads: the effect resolved against the layer's sampled keys.
    const c = locateClip(store.getState(), String(t.id))!.clip;
    if (c.kind !== "text") throw new Error("not text");
    const echo = c.style.textEffects.find((e) => e.id === fx.effectId)!;
    const echoAt = (ms: number) => resolveTextEffect(echo, sampleKeyframes(c.keyframes, ms), { glyphColor: "#ffffff" }) as unknown as { distance: number };
    expect(echoAt(0).distance).toBeCloseTo(0, 6);
    expect(echoAt(500).distance).toBeCloseTo(40, 6);
  });
});
