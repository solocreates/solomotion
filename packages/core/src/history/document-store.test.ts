import { describe, expect, it } from "vitest";
import { createDocumentStore } from "./document-store";
import { createEmptyDocument } from "../factories";

describe("history depth by merge key — rewinding one request", () => {
  it("finds a turn split by the user's own edit, and brings all of it back", () => {
    const store = createDocumentStore(createEmptyDocument());
    const turn = { mergeKey: "agent:t1", mergeWindowMs: Infinity };
    store.update("before", (d) => void (d.name = "a"));
    store.update("AI · title", (d) => void (d.name = "b"), turn);
    store.update("user", (d) => void (d.name = "c")); // the user edits mid-turn
    store.update("AI · title", (d) => void (d.name = "d"), turn);
    store.update("user again", (d) => void (d.name = "e"));

    expect(store.undoDepthOf("agent:t1")).toBe(4);
    expect(store.undoDepthOf("nope")).toBeNull();

    for (let i = 0; i < 4; i++) store.undo();
    expect(store.getState().name).toBe("a");
    expect(store.undoDepthOf("agent:t1")).toBeNull();
    expect(store.redoDepthOf("agent:t1")).toBe(3);

    for (let i = 0; i < 3; i++) store.redo();
    expect(store.getState().name).toBe("d");
  });
});

describe("history is bounded by bytes", () => {
  it("a long merged turn undoes in order and redoes in order", () => {
    const store = createDocumentStore(createEmptyDocument());
    const turn = { mergeKey: "agent:t2", mergeWindowMs: Infinity };
    store.update("before", (d) => void (d.name = "start"));
    for (let i = 0; i < 2000; i++) store.update("AI", (d) => void (d.name = `n${i}`), turn);
    expect(store.getState().name).toBe("n1999");
    const depth = store.undoDepthOf("agent:t2")!;
    for (let i = 0; i < depth; i++) store.undo();
    expect(store.getState().name).toBe("start");
    for (let i = 0; i < depth; i++) store.redo();
    expect(store.getState().name).toBe("n1999");
  });

  it("drops the oldest heavy steps but always keeps the newest", () => {
    const store = createDocumentStore(createEmptyDocument());
    // ~4 MB per step (a 1M-char string, forward + inverse): 96 MB holds ~12.
    const big = (c: string) => c.repeat(1_000_000);
    for (let i = 0; i < 60; i++) store.update(`s${i}`, (d) => void (d.name = big(String.fromCharCode(65 + (i % 26)))));
    let undos = 0;
    while (store.undo()) undos++;
    expect(undos).toBeGreaterThan(0);
    expect(undos).toBeLessThan(30);
  });

  it("a merge that outgrows one entry opens another under the same key", () => {
    const store = createDocumentStore(createEmptyDocument());
    const turn = { mergeKey: "agent:t3", mergeWindowMs: Infinity };
    store.update("before", (d) => void (d.name = "start"));
    for (let i = 0; i < 6; i++) store.update("AI", (d) => void (d.name = "x".repeat(2_000_000) + i), turn);
    const depth = store.undoDepthOf("agent:t3")!;
    expect(depth).toBeGreaterThan(1);
    for (let i = 0; i < depth; i++) store.undo();
    expect(store.getState().name).toBe("start");
  });
});

describe("the person's undo steps around an agent working beside them", () => {
  const turn = { mergeKey: "agent:t3", mergeWindowMs: Infinity, author: "agent" as const };
  const twoComps = () => {
    const doc = createEmptyDocument();
    doc.frames.push({ ...doc.frames[0]!, id: "reel", name: "Reel" });
    return doc;
  };

  it("undoes their own edit, keeps the agent's later work, and redoes it", () => {
    const store = createDocumentStore(twoComps());
    store.update("AI · start", (d) => void (d.frames[1]!.width = 640), turn);
    store.update("cover", (d) => void (d.frames[0]!.name = "Cover"));
    store.update("AI · keys", (d) => void (d.frames[1]!.height = 777), turn);
    store.update("AI · more", (d) => void d.frames.push({ ...d.frames[1]!, id: "extra", name: "Extra" }), turn);

    expect(store.undoOwn()).toBe("undone");
    let s = store.getState();
    expect(s.frames[0]!.name).not.toBe("Cover");
    expect(s.frames[1]!.height).toBe(777);
    expect(s.frames.map((f) => f.id)).toContain("extra");

    // The agent's steps (keys + more merged: one entry) still undo cleanly in
    // the world without the edit.
    store.undo();
    s = store.getState();
    expect(s.frames.map((f) => f.id)).not.toContain("extra");
    expect(s.frames[1]!.height).not.toBe(777);
    expect(s.frames[1]!.width).toBe(640);
  });

  it("redo brings the person's edit back on top of the agent's", () => {
    const store = createDocumentStore(twoComps());
    store.update("AI · start", (d) => void (d.frames[1]!.width = 640), turn);
    store.update("cover", (d) => void (d.frames[0]!.name = "Cover"));
    store.update("AI · keys", (d) => void (d.frames[1]!.height = 777), turn);
    store.undoOwn();
    store.redo();
    const s = store.getState();
    expect(s.frames[0]!.name).toBe("Cover");
    expect(s.frames[1]!.height).toBe(777);
  });

  it("an agent turn that began after the edit is undone as before", () => {
    const store = createDocumentStore(twoComps());
    store.update("cover", (d) => void (d.frames[0]!.name = "Cover"));
    store.update("AI · keys", (d) => void (d.frames[1]!.height = 777), turn);
    store.undoOwn();
    const s = store.getState();
    expect(s.frames[0]!.name).toBe("Cover");
    expect(s.frames[1]!.height).not.toBe(777);
  });

  it("refuses, untouched, when both changed the same thing", () => {
    const store = createDocumentStore(twoComps());
    store.update("AI · start", (d) => void (d.frames[1]!.width = 640), turn);
    store.update("mine", (d) => void (d.frames[1]!.height = 500));
    store.update("AI · keys", (d) => void (d.frames[1]!.height = 777), turn);
    const before = store.getState();
    expect(store.undoOwn()).toBe("conflict");
    expect(store.getState()).toBe(before);
  });
});

describe("patch rebase", () => {
  it("shifts a sibling past an insert and refuses an edit inside a removed element", async () => {
    const { patchAfter, RebaseConflict } = await import("./rebase");
    const edit = { op: "replace" as const, path: ["tracks", 2, "name"], value: "x" };
    expect(patchAfter(edit, { op: "add", path: ["tracks", 0], value: {} }, true).path).toEqual(["tracks", 3, "name"]);
    expect(patchAfter(edit, { op: "add", path: ["tracks", 5], value: {} }, true).path).toEqual(["tracks", 2, "name"]);
    expect(patchAfter(edit, { op: "remove", path: ["tracks", 1] }, true).path).toEqual(["tracks", 1, "name"]);
    expect(() => patchAfter(edit, { op: "remove", path: ["tracks", 2] }, true)).toThrow(RebaseConflict);
    expect(() => patchAfter(edit, { op: "replace", path: ["tracks", 2], value: {} }, true)).toThrow(RebaseConflict);
  });
});

describe("reaches", () => {
  it("says whether an id can come back: in the document, or through undo or redo", () => {
    const doc = createEmptyDocument();
    doc.assets.push({ id: "asset_kept", kind: "audio", name: "knock", mime: "audio/wav", bytes: 4, width: null, height: null, durationMs: 900, fps: null, folderId: null, origin: null });
    const store = createDocumentStore(doc);
    expect(store.reaches("asset_kept")).toBe(true);
    store.update("Delete media", (d) => void (d.assets = []));
    // Gone from the document, but one undo away.
    expect(store.getState().assets).toEqual([]);
    expect(store.reaches("asset_kept")).toBe(true);
    store.undo();
    expect(store.reaches("asset_kept")).toBe(true);
    expect(store.reaches("asset_never")).toBe(false);
    // A store whose history was cleared by a replace no longer reaches it.
    store.replace(createEmptyDocument());
    expect(store.reaches("asset_kept")).toBe(false);
  });
});

describe("a suspended history", () => {
  it("comes back, undoable and redoable, over the same document", () => {
    const a = createDocumentStore(createEmptyDocument("A"));
    a.update("Rename", (d) => void (d.name = "B"));
    a.update("Rename", (d) => void (d.name = "C"));
    a.undo();
    const history = JSON.parse(JSON.stringify(a.exportHistory()));
    const doc = a.getState();

    const b = createDocumentStore(createEmptyDocument("X"));
    b.replace(doc);
    expect(b.canUndo()).toBe(false);
    b.importHistory(history);
    expect(b.getState().name).toBe("B");
    expect(b.redo()).toBe(true);
    expect(b.getState().name).toBe("C");
    expect(b.undo()).toBe(true);
    expect(b.undo()).toBe(true);
    expect(b.getState().name).toBe("A");
  });
  it("replace still clears it", () => {
    const a = createDocumentStore(createEmptyDocument("A"));
    a.update("Rename", (d) => void (d.name = "B"));
    a.replace(createEmptyDocument("Z"));
    expect(a.exportHistory()).toEqual({ undo: [], redo: [] });
  });
});
