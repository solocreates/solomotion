import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { createCommandApi, type CommandContext } from ".";

/**
 * An icon beside a label (2026-11-17): a path's x/y is its `d` origin, so an
 * icon drawn below its origin, placed at the label's y, sat low. The layer now
 * says where the middle of its art is.
 */
function harness() {
  const store = createDocumentStore(createEmptyDocument("Test"));
  const api = createCommandApi();
  const ctx: CommandContext = {
    store,
    actor: "AI",
    historyKey: "turn-1",
    historyLabel: "Icons",
    session: { focusFrameId: () => store.getState().frames[0]?.id ?? null, playheadMs: () => 0, selection: () => [] },
  };
  return async (id: string, input: unknown = {}) => {
    const res = await api.call(id, input, ctx);
    if (!res.ok) throw new Error(`${id}: ${res.error}`);
    return res.value as Record<string, unknown>;
  };
}

describe("where an icon's middle is", () => {
  // A drop: from y −10 to y 40 about its own origin, so its middle is 15 below it.
  const DROP = "M0 -10L20 10L0 40L-20 10Z";

  it("layer.create reports the art's centre when x/y is not it", async () => {
    const call = harness();
    const made = await call("layer.create", { kind: "path", d: DROP, fill: "#fff", x: 100, y: 200 });
    expect(made.center).toEqual({ x: 100, y: 215 });
    expect(String(made.note)).toMatch(/center/);
  });

  it("layer.get's box.center follows the pivot, scale and rotation", async () => {
    const call = harness();
    const made = await call("layer.create", { kind: "path", d: DROP, fill: "#fff", x: 100, y: 200 });
    expect(((await call("layer.get", { id: made.id, fields: ["box"] })).box as { center: unknown }).center).toEqual({ x: 100, y: 215 });
    await call("layer.set", { ids: [made.id], values: { scale: 2, rotation: 90 }, mode: "base" });
    // 15 below the pivot, doubled, turned a quarter clockwise: 30 to the LEFT of it.
    expect(((await call("layer.get", { id: made.id, fields: ["box"] })).box as { center: unknown }).center).toEqual({ x: 70, y: 200 });
  });

  it("a shape and a centred path say nothing extra: their x/y is the centre", async () => {
    const call = harness();
    const shape = await call("layer.create", { kind: "shape", shape: "rect", width: 40, height: 20, x: 5, y: 6 });
    expect(shape.center).toBeUndefined();
    expect(((await call("layer.get", { id: shape.id, fields: ["box"] })).box as { center: unknown }).center).toEqual({ x: 5, y: 6 });
    const centred = await call("layer.create", { kind: "path", d: "M-10 -10L10 -10L10 10L-10 10Z", x: 0, y: 0 });
    expect(centred.center).toBeUndefined();
  });
});
