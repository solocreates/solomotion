import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { createCommandApi, type CommandContext } from ".";

describe("an addressing key passed as undefined", () => {
  it("is refused — never read as 'the focused comp'", async () => {
    const store = createDocumentStore(createEmptyDocument("Test"));
    const focused = store.getState().frames[0]!;
    const ctx: CommandContext = { store, actor: "Script", session: { focusFrameId: () => focused.id, playheadMs: () => 0, selection: () => [] } };
    const api = createCommandApi();
    const made: { id?: string } = {};
    const res = await api.call("frame.update", { id: made.id, name: "Renamed" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/^id is undefined/);
    expect(store.getState().frames[0]!.name).toBe(focused.name);
    // Left out, it still means the focused one.
    expect((await api.call("frame.update", { name: "Renamed" }, ctx)).ok).toBe(true);
    expect(store.getState().frames[0]!.name).toBe("Renamed");
  });
});
