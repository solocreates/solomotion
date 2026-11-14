import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument, createPathClip, createTrack } from "../factories";
import { locateClip } from "../timeline/ops";
import { createCommandApi, type CommandContext } from "../api";
import { pathGeometryAt } from "../vector/geometry";
import type { PathClip } from "../schema";

function harness() {
  const doc = createEmptyDocument("Test");
  const frameId = doc.frames[0]!.id;
  const p = (x: number, y: number) => ({ x, y, hIn: null, hOut: null });
  const mouth = createPathClip({ frameId, startMs: 0, durationMs: 1000, subpaths: [{ closed: false, points: [p(-20, 0), p(0, 0), p(20, 0)] }] });
  mouth.name = "Mouth";
  const t = createTrack("m");
  t.clips.push(mouth);
  doc.tracks.push(t);
  const store = createDocumentStore(doc);
  const api = createCommandApi();
  const ctx: CommandContext = {
    store,
    actor: "AI",
    historyKey: "turn-1",
    historyLabel: "Mouth",
    session: { focusFrameId: () => frameId, playheadMs: () => 0, selection: () => [] },
  };
  const call = async (id: string, input: unknown = {}) => {
    const res = await api.call(id, input, ctx);
    if (!res.ok) throw new Error(`${id}: ${res.error}${res.hint ? ` (${res.hint})` : ""}`);
    return res.value as Record<string, unknown>;
  };
  return { store, call, id: mouth.id };
}

describe("shape keys through the API", () => {
  it("creates, reshapes, weights, mirrors, inspects and removes", async () => {
    const { store, call, id } = harness();
    const open = await call("shapekey.create", { id, name: "Open.L", points: [{ index: 0, dy: 8 }] });
    expect(open.moved).toBe(1);
    expect(open.path).toBe(`key.${open.id}`);
    await call("shapekey.set", { id, weights: { "Open.L": 0.5 } });
    const clip = () => locateClip(store.getState(), id)!.clip as PathClip;
    expect(pathGeometryAt(clip(), {})[0]!.points[0]!.y).toBe(4);
    const mir = await call("shapekey.edit", { id, key: "Open.L", mirror: true });
    expect(mir.name).toBe("Open.R");
    const ins = await call("shapekey.inspect", { id, key: "Open.R" });
    expect((ins.shape as Array<{ points: number[][] }>)[0]!.points[2]).toEqual([20, 8]);
    await expect(call("shapekey.edit", { id, key: "Open.L", relativeTo: "Open.L" })).rejects.toThrow(/loop/);
    await call("shapekey.remove", { id, keys: ["Open.L", "Open.R"] });
    expect(clip().shapeKeys).toBeUndefined();
  });
});
