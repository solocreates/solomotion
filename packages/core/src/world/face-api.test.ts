import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { locateClip } from "../timeline/ops";
import { createCommandApi, type CommandContext } from "../api";
import { applyPoseMixes } from "../rig/poses";

function harness() {
  const store = createDocumentStore(createEmptyDocument("Test"));
  const api = createCommandApi();
  const ctx: CommandContext = {
    store,
    actor: "AI",
    historyKey: "turn-1",
    historyLabel: "Faces",
    session: { focusFrameId: () => store.getState().frames[0]?.id ?? null, playheadMs: () => 0, selection: () => [] },
  };
  const call = async (id: string, input: unknown = {}) => {
    const res = await api.call(id, input, ctx);
    if (!res.ok) throw new Error(`${id}: ${res.error}${res.hint ? ` (${res.hint})` : ""}`);
    return res.value as Record<string, unknown>;
  };
  const fail = async (id: string, input: unknown) => {
    const res = await api.call(id, input, ctx);
    return res.ok ? null : res.error;
  };
  return { store, call, fail };
}

describe("faces through the API", () => {
  it("world_add head → world_face → a keyed viseme opens the mouth", async () => {
    const { store, call, fail } = harness();
    const { frameId } = (await call("world.create", { starter: false })) as { frameId: string };
    const { id } = (await call("world.add", { frameId, kind: "head" })) as { id: string };
    const dry = await call("world.face", { id, dryRun: true });
    expect(dry).toMatchObject({ convention: "visemes", keys: 11, missing: [] });
    const r = (await call("world.face", { id })) as { groupId: string; mouthSetId: string; eyesSetId: string };
    const group = locateClip(store.getState(), r.groupId)!.clip;
    expect(group.kind).toBe("group");
    // Key the Mouth set to AI and read the bake: key.AI is driven to 1.
    await call("poses.key", { groupId: r.groupId, set: r.mouthSetId, pose: "AI", atMs: 0 });
    const doc = applyPoseMixes(store.getState(), 500, frameId);
    const head = locateClip(doc, id)!.clip;
    const ai = head.kind === "mesh" ? head.shapeKeys!.find((k) => k.id === "AI") : null;
    expect(ai?.value ?? 0).toBeCloseTo(1, 3);
    // A mesh with no keys is refused with a way forward.
    const { id: cube } = (await call("world.add", { frameId, kind: "mesh" })) as { id: string };
    expect(await fail("world.face", { id: cube })).toMatch(/no shape keys/);
  });
});
