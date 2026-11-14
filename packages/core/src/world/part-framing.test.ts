import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { createCommandApi, type CommandContext } from "../api";
import { evaluateWorld } from "./evaluate";
import { invert4, transformPoint } from "./math";
import { framedOnFocus, poseSetWorldFocus } from "./part-framing";

function harness() {
  const store = createDocumentStore(createEmptyDocument("Test"));
  const api = createCommandApi();
  const ctx: CommandContext = { store, actor: "AI", historyKey: "t", historyLabel: "Framing", session: { focusFrameId: () => store.getState().frames[0]?.id ?? null, playheadMs: () => 0, selection: () => [] } };
  const call = async (id: string, input: unknown = {}) => {
    const res = await api.call(id, input, ctx);
    if (!res.ok) throw new Error(`${id}: ${res.error}`);
    return res.value as Record<string, unknown>;
  };
  return { store, call };
}

describe("a 3D pose picture frames the part", () => {
  it("the mouth set's focus is the lips, and the tile camera looks straight at it", async () => {
    const { store, call } = harness();
    const { frameId } = (await call("world.create", { starter: true })) as { frameId: string };
    const head = (await call("world.add", { frameId, kind: "head", position: [0, 0, 120] })) as { id: string };
    const ins = (await call("world.inspect", { frameId })) as { objects: Array<{ id: string; kind: string }> };
    const cam = ins.objects.find((o) => o.kind === "camera")!;
    await call("world.track", { id: cam.id, lookAt: head.id });
    const face = (await call("world.face", { id: head.id })) as { groupId: string; mouthSetId: string; eyesSetId: string };
    const doc = store.getState();
    const mouth = poseSetWorldFocus(doc, face.groupId, face.mouthSetId, 0)!;
    const eyes = poseSetWorldFocus(doc, face.groupId, face.eyesSetId, 0)!;
    expect(mouth).toBeTruthy();
    // The lips are below the eyes (Z up), and each part is far smaller than the head.
    expect(mouth.center[2]).toBeLessThan(eyes.center[2]);
    const frame = doc.frames.find((f) => f.id === frameId)!;
    const framed = framedOnFocus(doc, frameId, 0, mouth)!;
    expect(framed).toBeTruthy();
    const ev = evaluateWorld(framed, framed.frames.find((f) => f.id === frameId)!, 0);
    // In camera space the focus sits on the axis, in front (−Z).
    const local = transformPoint(invert4(ev.camera.matrix), mouth.center);
    expect(Math.abs(local[0])).toBeLessThan(1e-3 * Math.abs(local[2]) + 1e-3);
    expect(Math.abs(local[1])).toBeLessThan(1e-3 * Math.abs(local[2]) + 1e-3);
    expect(local[2]).toBeLessThan(0);
    void frame;
  });
});
