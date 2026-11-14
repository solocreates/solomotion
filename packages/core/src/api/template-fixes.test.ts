import { describe, expect, it } from "vitest";
import "../index";
import type { NestedClip } from "../schema";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument, createFrame, createNestedClip, createTrack } from "../factories";
import { makeComponentFromFrame } from "../components";
import { locateClip } from "../timeline/ops";
import { buildPatternTile } from "../vector/pattern";
import { defaultPatternSpec } from "../schema/vector";
import { parseDocument, serializeDocument } from "../io";
import { clearScriptOutput, createdSince, docIds, dropKeptOutput } from "../scripts";
import { createCommandApi, type CommandContext } from ".";

/**
 * What the brand-template build hit on 2026-11-07 (notes/templates/ISSUES.md),
 * driven the way an agent drives it: through `call`.
 */

function harness() {
  const doc = createEmptyDocument("Test");
  const root = doc.frames[0]!;
  const master = createFrame({ name: "Mark", width: 200, height: 200 });
  doc.frames.push(master);
  makeComponentFromFrame(doc, master.id);
  const inst = { ...createNestedClip({ frameId: root.id, sourceFrameId: master.id, startMs: 0, durationMs: 4000, x: 0, y: 0 }), name: "Logo" };
  const t = createTrack(inst.name);
  t.clips.push(inst);
  doc.tracks.push(t);
  const store = createDocumentStore(doc);
  const api = createCommandApi();
  const ctx: CommandContext = {
    store,
    actor: "AI",
    historyKey: "turn-1",
    historyLabel: "Templates",
    session: { focusFrameId: () => root.id, playheadMs: () => 0, selection: () => [] },
  };
  const raw = (id: string, input: unknown = {}) => api.call(id, input, ctx);
  const call = async (id: string, input: unknown = {}) => {
    const res = await raw(id, input);
    if (!res.ok) throw new Error(`${id}: ${res.error}${res.hint ? ` (${res.hint})` : ""}`);
    return res.value as Record<string, unknown>;
  };
  return { store, call, raw, master, inst };
}

const rowGap = (kind: "dots" | "squares", aspect: number) => {
  const tile = buildPatternTile({ ...defaultPatternSpec(kind), spacing: 40, aspect }, (c) => c);
  const ys = [...new Set(tile.marks.map((m) => (m.kind === "circle" ? m.cy : m.kind === "rect" ? m.y + m.h / 2 : NaN)))].sort((a, b) => a - b);
  return { w: tile.w, gap: ys[1]! - ys[0]!, tileH: tile.h };
};

describe("template fixes 2026-11-07", () => {
  it("a dot or square lattice puts rows `spacing · aspect` apart", () => {
    for (const kind of ["dots", "squares"] as const) {
      expect(rowGap(kind, 1)).toEqual({ w: 40, gap: 40, tileH: 80 });
      expect(rowGap(kind, 0.5).gap).toBe(20);
    }
  });

  it("v116 halves a saved dots aspect and its keys, so the picture is unchanged", async () => {
    const { call, store } = harness();
    const r = await call("layer.create", {
      kind: "shape", shape: "rect", width: 100, height: 100,
      fills: [{ type: "pattern", pattern: { kind: "dots", spacing: 40, aspect: 2 } }, { type: "pattern", pattern: { kind: "stripes", aspect: 2 } }],
    });
    const fills = (locateClip(store.getState(), String(r.id))!.clip as { fills: Array<{ id: string }> }).fills;
    await call("keyframes.set", { id: r.id, property: `fill.${fills[0]!.id}.pattern.aspect`, keys: [{ at: 0, value: 3 }] });
    // Saved by v115, which drew a dots tile one `spacing · aspect` tall.
    const saved = JSON.parse(serializeDocument(store.getState())) as Record<string, any>;
    saved.version = 115;
    const oldTileH = 40 * 2;
    const clip = parseDocument(JSON.stringify(saved)).tracks.flatMap((t) => t.clips).find((c) => c.id === r.id) as unknown as Record<string, any>;
    expect(clip.fills[0].pattern.aspect).toBe(1);
    expect(clip.fills[1].pattern.aspect).toBe(2); // stripes were always right
    expect(clip.keyframes[0].keys[0].value).toBe(1.5);
    expect(buildPatternTile(clip.fills[0].pattern, (c) => c).h).toBe(oldTileH);
  });

  it("a pattern's fields are keyable and drivable through the API", async () => {
    const { call, store } = harness();
    const r = await call("layer.create", {
      kind: "shape", shape: "rect", width: 200, height: 200,
      fill: { type: "pattern", pattern: { kind: "dots", spacing: 30 } },
    });
    const fill = (locateClip(store.getState(), String(r.id))!.clip as { fills: Array<{ id: string }> }).fills[0]!;
    const props = JSON.stringify(await call("layer.properties", { id: r.id }));
    expect(props).toContain(`fill.${fill.id}.pattern.spacing`);
    expect(props).toContain(`fill.${fill.id}.pattern.offsetX`);
    expect(props).not.toContain(`fill.${fill.id}.pattern.amplitude`); // a dot lattice has no swing
    await call("keyframes.set", { id: r.id, property: `fill.${fill.id}.pattern.offsetX`, keys: [{ at: 0, value: 0 }, { at: 1000, value: 30 }] });
    await call("expression.set", { id: r.id, property: `fill.${fill.id}.pattern.spacing`, source: "30 + #time" });
    const clip = locateClip(store.getState(), String(r.id))!.clip;
    expect(clip.keyframes.map((k) => k.property)).toContain(`fill.${fill.id}.pattern.offsetX`);
    expect(Object.keys(clip.drivers ?? {})).toContain(`fill.${fill.id}.pattern.spacing`);
  });

  it("an instance's input is named the same way by layer.set, keyframes.set and expression.set", async () => {
    const { call, store, master, inst } = harness();
    const { inputId } = (await call("component.inputs", { action: "define", frameId: master.id, def: { name: "Mono", type: "number", min: 0, max: 1 } })) as { inputId: string };
    const keyed = await call("keyframes.set", { id: inst.id, property: "input.Mono", keys: [{ at: 0, value: 0 }, { at: 500, value: 5 }] });
    expect(keyed.property).toBe(`input.${inputId}`);
    await call("expression.set", { id: inst.id, property: "input.Mono", source: "0.5" });
    const hero = locateClip(store.getState(), inst.id)!.clip as NestedClip;
    const track = hero.keyframes.find((k) => k.property === `input.${inputId}`)!;
    expect(track.keys.map((k) => k.value)).toEqual([0, 1]); // clamped to the input's range, as layer.set does
    expect(Object.keys(hero.drivers ?? {})).toEqual([`input.${inputId}`]);
    const inspected = JSON.stringify(await call("keyframes.inspect", { id: inst.id, properties: ["input.Mono"] }));
    expect(inspected).toContain(inputId);
  });

  it("layer.create refuses a stray field with the fields of the kind that was asked for", async () => {
    const { raw } = harness();
    const shape = await raw("layer.create", { kind: "shape", shape: "rect", width: 10, height: 10, cornerRadiu: 4 });
    expect(shape.ok).toBe(false);
    if (shape.ok) return;
    expect(shape.error).toContain('did you mean "cornerRadius"');
    expect(shape.error).not.toMatch(/maxWidth|caption/);
    const text = await raw("layer.create", { kind: "text", text: "Hi", fills: [] });
    if (text.ok) throw new Error("accepted");
    expect(text.error).not.toContain('did you mean "fills"');
  });

  it("a replace takes back the project's last comp once the run has made another", async () => {
    const { store, call } = harness();
    // A project wholly made by its script: delete everything else first.
    const before = docIds(store.getState());
    const a = await call("frame.create", { name: "Cover", width: 100, height: 100 });
    const b = await call("frame.create", { name: "9:16", width: 90, height: 160 });
    const output = createdSince(before, store.getState());
    for (const f of store.getState().frames.filter((f) => f.id !== a.id && f.id !== b.id)) await call("frame.delete", { id: f.id });
    let kept: string[] = [];
    store.update("replace", (d) => void (kept = clearScriptOutput(d, output).kept));
    expect(kept).toHaveLength(1); // the last comp cannot go yet — and stays the script's
    const next = await call("frame.create", { name: "Cover", width: 100, height: 100 });
    let left: string[] = ["x"];
    store.update("settle", (d) => void (left = dropKeptOutput(d, kept).left));
    expect(left).toEqual([]);
    expect(store.getState().frames.map((f) => f.id)).toEqual([next.id]);
  });
});
