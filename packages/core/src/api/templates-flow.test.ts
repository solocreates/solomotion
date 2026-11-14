import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { locateClip } from "../timeline/ops";
import { createCommandApi, type CommandContext } from ".";

/** "Duplicate the comp, change the words" — the template move, driven through `call` as an agent drives it. */
function harness() {
  const store = createDocumentStore(createEmptyDocument("Channel"));
  const api = createCommandApi();
  const ctx: CommandContext = {
    store,
    actor: "AI",
    historyKey: "turn-1",
    historyLabel: "Build the series",
    session: { focusFrameId: () => store.getState().frames[0]?.id ?? null, playheadMs: () => 0, selection: () => [] },
  };
  const call = async (id: string, input: unknown = {}) => {
    const res = await api.call(id, input, ctx);
    if (!res.ok) throw new Error(`${id}: ${res.error}${res.hint ? ` (${res.hint})` : ""}`);
    return res.value as Record<string, unknown>;
  };
  return { store, call };
}

describe("templates through the API", () => {
  it("frame.duplicate copies a comp with new layers, onto another page", async () => {
    const { store, call } = harness();
    const lesson = (await call("frame.create", { name: "Lesson", width: 1920, height: 1080 })).id as string;
    await call("layer.create", { kind: "text", text: "salām", frameId: lesson });
    await call("page.create", { name: "Episode 2" });
    const copy = (await call("frame.duplicate", { id: lesson, name: "Lesson 2", pageId: "Episode 2" })).id as string;
    const doc = store.getState();
    const frame = doc.frames.find((f) => f.id === copy)!;
    expect(frame.name).toBe("Lesson 2");
    expect(doc.pages.find((p) => p.id === frame.pageId)?.name).toBe("Episode 2");
    const texts = (id: string) => doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === id && c.kind === "text");
    expect(texts(copy)).toHaveLength(1);
    expect(texts(copy)[0]!.id).not.toBe(texts(lesson)[0]!.id);
  });

  it("layers.copy brings a group and its members into another comp, keeping stack order and timing", async () => {
    const { store, call } = harness();
    const from = (await call("frame.create", { name: "Kit", width: 1080, height: 1080 })).id as string;
    const to = (await call("frame.create", { name: "Short", width: 1080, height: 1920 })).id as string;
    const back = (await call("layer.create", { kind: "shape", shape: "rect", width: 200, height: 80, frameId: from, startMs: 500 })).id as string;
    const word = (await call("layer.create", { kind: "text", text: "chāy", frameId: from, startMs: 500 })).id as string;
    const group = (await call("layers.group", { ids: [back, word], name: "Chip" })).groupId as string;
    const lone = (await call("layer.create", { kind: "shape", shape: "ellipse", width: 40, height: 40, frameId: from, startMs: 900 })).id as string;

    const { ids } = (await call("layers.copy", { ids: [group, lone], toFrameId: to })) as { ids: string[] };
    expect(ids).toHaveLength(2);
    const doc = store.getState();
    const copied = ids.map((id) => locateClip(doc, id)!);
    expect(copied.every((l) => l.clip.frameId === to)).toBe(true);
    // The group arrived as a group holding its two members.
    const g = copied.find((l) => l.clip.kind === "group")!;
    expect(doc.tracks.filter((t) => t.groupId === g.clip.id).flatMap((t) => t.clips)).toHaveLength(2);
    // Times kept; the originals untouched.
    expect(copied.map((l) => l.clip.startMs).sort()).toEqual([500, 900]);
    expect(locateClip(doc, group)!.clip.frameId).toBe(from);
  });
});
