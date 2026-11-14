import { describe, expect, it } from "vitest";
import "../index";
import type { NestedClip } from "../schema";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument, createFrame, createNestedClip, createShapeClip, createTrack } from "../factories";
import { makeComponentFromFrame } from "../components";
import { createCommandApi, type CommandContext } from "../api";
import { locateClip } from "../timeline/ops";
import { instanceScope } from "./inputs";

/** Inputs driven the way an agent drives them: through `call`, JSON in and out. */
function harness() {
  const doc = createEmptyDocument("Test");
  const root = doc.frames[0]!;
  const master = createFrame({ name: "Character", width: 200, height: 200 });
  doc.frames.push(master);
  makeComponentFromFrame(doc, master.id);
  const body = { ...createShapeClip({ frameId: master.id, shape: "rect", startMs: 0, durationMs: 4000, width: 50, height: 50 }), name: "Body" };
  const inst = { ...createNestedClip({ frameId: root.id, sourceFrameId: master.id, startMs: 0, durationMs: 4000, x: 0, y: 0 }), name: "Hero" };
  for (const c of [body, inst]) {
    const t = createTrack(c.name);
    t.clips.push(c);
    doc.tracks.push(t);
  }
  const store = createDocumentStore(doc);
  const api = createCommandApi();
  const ctx: CommandContext = {
    store,
    actor: "AI",
    historyKey: "turn-1",
    historyLabel: "Inputs",
    session: { focusFrameId: () => root.id, playheadMs: () => 0, selection: () => [] },
  };
  const call = async (id: string, input: unknown = {}) => {
    const res = await api.call(id, input, ctx);
    if (!res.ok) throw new Error(`${id}: ${res.error}${res.hint ? ` (${res.hint})` : ""}`);
    return res.value as Record<string, unknown>;
  };
  return { store, call, master, body, inst };
}

describe("component inputs through the API", () => {
  it("define, expose, set by name with layer.set, key with keyframes.set", async () => {
    const { store, call, master, body, inst } = harness();
    const defined = (await call("component.inputs", { action: "define", frameId: master.id, def: { name: "Mood", type: "enum", options: ["Happy", "Sad"] } })) as { inputId: string };
    const exposed = (await call("component.inputs", { action: "expose", layerId: body.id, property: "opacity" })) as { inputId: string; inputs: Array<{ name: string; bound: unknown[] }> };
    expect(exposed.inputs.map((d) => d.name)).toEqual(["Mood", "Opacity"]);

    await call("layer.set", { ids: inst.id, values: { "input.mood": "sad", [`input.${exposed.inputId}`]: 0.4 }, mode: "base" });
    let hero = locateClip(store.getState(), inst.id)!.clip as NestedClip;
    expect(hero.inputValues).toEqual({ [defined.inputId]: "Sad", [exposed.inputId]: 0.4 });

    await call("keyframes.set", { id: inst.id, property: `input.${exposed.inputId}`, keys: [{ at: 0, value: 0 }, { at: 1000, value: 1 }] });
    hero = locateClip(store.getState(), inst.id)!.clip as NestedClip;
    expect(instanceScope(store.getState(), hero, 1000, null)!.values[exposed.inputId]).toBe(1);

    const props = (await call("layer.properties", { id: inst.id, group: "Inputs" })) as { properties?: Array<{ path: string }> } & Record<string, unknown>;
    expect(JSON.stringify(props)).toContain(`input.${defined.inputId}`);

    await call("component.inputs", { action: "remove", frameId: master.id, input: "Opacity" });
    const left = (await call("component.inputs", { action: "list", frameId: master.id })) as { inputs: Array<{ name: string }> };
    expect(left.inputs.map((d) => d.name)).toEqual(["Mood"]);
    expect(locateClip(store.getState(), body.id)!.clip.drivers?.opacity).toBeUndefined();
  });

  it("refuses an input path the instance's comp does not define", async () => {
    const { call, inst } = harness();
    await expect(call("layer.set", { ids: inst.id, values: { "input.nope": 1 } })).rejects.toThrow(/no property/);
  });
});
