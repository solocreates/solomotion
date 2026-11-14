import { describe, expect, it } from "vitest";
import { createDocumentStore, type HistoryEntry } from "./document-store";
import { capHistory, documentFingerprint } from "./suspended-history";
import { createEmptyDocument, createShapeClip, createTextClip } from "../factories";
import { parseDocument, serializeDocument } from "../io";

/** A store that has been worked in: layers added by the factories, the way the editor adds them. */
function worked() {
  const store = createDocumentStore(createEmptyDocument("Worked"));
  const frameId = store.getState().frames[0]!.id;
  const ids: string[] = [];
  for (const make of [() => createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 1000 }), () => createTextClip({ frameId, text: "Hi", startMs: 0, durationMs: 1000 })]) {
    const clip = make();
    ids.push(clip.id);
    store.update("Add layer", (d) => void d.tracks[0]!.clips.push(clip));
  }
  return { store, ids };
}

/** The project as the next open hands it back: written by autosave, read through the parser. */
const reloaded = (doc: Parameters<typeof serializeDocument>[0]) => parseDocument(serializeDocument(doc));

const entry = (bytes: number, label = "e"): HistoryEntry => ({ label, at: 0, patches: [], inverse: [], bytes });

describe("capHistory", () => {
  it("keeps the nearest steps, oldest dropped first", () => {
    const undo = Array.from({ length: 10 }, (_, i) => entry(1, `u${i}`));
    const out = capHistory({ undo, redo: [] }, { steps: 4, bytes: 100 });
    expect(out.undo.map((e) => e.label)).toEqual(["u6", "u7", "u8", "u9"]);
  });
  it("stops at the byte cap, undo before redo", () => {
    const out = capHistory({ undo: [entry(5, "u0"), entry(5, "u1")], redo: [entry(5, "r0"), entry(5, "r1")] }, { steps: 64, bytes: 15 });
    expect(out.undo.map((e) => e.label)).toEqual(["u0", "u1"]);
    // Redo pops from the end: the step you would redo next is the one kept.
    expect(out.redo.map((e) => e.label)).toEqual(["r1"]);
  });
});

describe("documentFingerprint", () => {
  it("is the same for the live document and the one the next open reads back", () => {
    const { store } = worked();
    const live = store.getState();
    expect(serializeDocument(reloaded(live))).not.toBe(serializeDocument(live));
    expect(documentFingerprint(reloaded(live))).toBe(documentFingerprint(live));
  });
  it("changes when a newer save deleted a layer", () => {
    const { store, ids } = worked();
    const before = documentFingerprint(store.getState());
    store.update("Delete", (d) => void (d.tracks[0]!.clips = d.tracks[0]!.clips.filter((c) => c.id !== ids[0])));
    expect(documentFingerprint(store.getState())).not.toBe(before);
  });
});

describe("a suspended history over a reloaded document", () => {
  it("undoes and redoes as if the tab had never been put away", () => {
    const { store, ids } = worked();
    const history = structuredClone(capHistory(store.exportHistory()));
    const doc = reloaded(store.getState());

    const next = createDocumentStore(createEmptyDocument("Other"));
    next.replace(doc);
    next.importHistory(history);
    expect(next.undo()).toBe(true);
    expect(next.getState().tracks[0]!.clips.map((c) => c.id)).toEqual([ids[0]]);
    expect(next.redo()).toBe(true);
    expect(next.getState().tracks[0]!.clips.map((c) => c.id)).toEqual(ids);
  });
});
