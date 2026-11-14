import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { createCommandApi, type CommandContext } from "../api";
import type { MotionDocument } from "../schema";
import { clearScriptOutput, createdSince, docIds } from "./output";
import { reify, reifyEqual, runScriptInProcess, scriptHere } from ".";

/**
 * THE ROUND-TRIP LAW, challenged: run(reify(x)) ≅ x on a document without x,
 * the printed code is stable when printed again, and a script whose ledger
 * adopted x edits it in place.
 */

const api = createCommandApi();

function harness(doc: MotionDocument = createEmptyDocument("Reify")) {
  const store = createDocumentStore(doc);
  let focus: string | null = store.getState().frames[0]?.id ?? null;
  const ctx: CommandContext = { store, actor: "Test", session: { focusFrameId: () => focus, playheadMs: () => 0, selection: () => [] } };
  const call = async <T = Record<string, unknown>>(id: string, input: unknown = {}): Promise<T> => {
    const res = await api.call(id, input, ctx);
    if (!res.ok) throw new Error(`${id}: ${res.error}${res.hint ? ` (${res.hint})` : ""}`);
    return res.value as T;
  };
  return { store, ctx, call, focusOn: (id: string) => (focus = id), focus: () => focus! };
}

type Id = { id: string };

/** A rich scene: typed text with a styled range and an entrance, a keyed card with a glow, a nested comp, a rig with IK, a switch with a blink, and two layers whose expressions read each other. */
async function richScene() {
  const h = harness();
  const main = h.focus();
  const part = await h.call<Id>("frame.create", { name: "Badge", width: 200, height: 200 });
  h.focusOn(part.id);
  await h.call("layer.create", { kind: "shape", shape: "ellipse", width: 120, height: 120, fill: "#22C55E", name: "Disc" });
  h.focusOn(main);

  const card = await h.call<Id>("layer.create", { kind: "shape", shape: "rect", name: "Card", width: 420, height: 240, cornerRadius: 24, fill: "#FF3366", startMs: 0, durationMs: 4000, x: -40, y: 20, set: { rotation: -4, opacity: 0.9 } });
  const glow = await h.call<{ effectId: string }>("effects.add", { id: card.id, type: "glow", values: { size: 18 } });
  await h.call("keyframes.set", { id: card.id, property: `lfx.${glow.effectId}.size`, keys: [{ at: 0, value: 4 }, { at: 800, value: 30, easing: "ease-out-expo" }] });
  const fillId = h.store.getState().tracks.flatMap((t) => t.clips).find((c) => c.id === card.id)!;
  await h.call("keyframes.set", { id: card.id, property: `fill.${(fillId as { fills: Array<{ id: string }> }).fills[0]!.id}`, keys: [{ at: 0, value: "#FF3366" }, { at: 1000, value: "#3366FF", easing: "linear" }] });

  const title = await h.call<Id>("layer.create", { kind: "text", text: "Hello world", name: "Title", startMs: 0, durationMs: 4000, style: { fontSize: 96, fontWeight: 800 }, y: -200 });
  await h.call("text.style", { id: title.id, match: "world", style: { color: "#FFD400" } });
  await h.call("animation.set", { id: title.id, slot: "in", preset: "fade-up", staggerMs: 40 });

  // Circular: each reads the other.
  await h.call("expression.set", { id: card.id, property: "x", source: 'layer("Title").x + 10' });
  await h.call("expression.set", { id: title.id, property: "y", source: 'layer("Card").y - 220' });

  await h.call("layer.create", { kind: "comp", sourceFrameId: part.id, name: "Badge 1", startMs: 0, durationMs: 4000, x: 300 });

  // A rig: two pieces, a chain with an IK control, a keyed bone, a switch with a blink.
  const upper = await h.call<Id>("layer.create", { kind: "shape", shape: "rect", name: "Upper arm", width: 100, height: 24, fill: "#888888", startMs: 0, durationMs: 4000, x: 50 });
  const lower = await h.call<Id>("layer.create", { kind: "shape", shape: "rect", name: "Forearm", width: 100, height: 20, fill: "#777777", startMs: 0, durationMs: 4000, x: 150 });
  const open = await h.call<Id>("layer.create", { kind: "shape", shape: "ellipse", name: "Open", width: 30, height: 30, fill: "#FFFFFF", startMs: 0, durationMs: 4000, y: -60 });
  const closed = await h.call<Id>("layer.create", { kind: "shape", shape: "rect", name: "Closed", width: 30, height: 4, fill: "#FFFFFF", startMs: 0, durationMs: 4000, y: -60 });
  const eye = await h.call<{ switchId: string }>("switch.create", { ids: [open.id, closed.id], name: "Eye" });
  await h.call("expression.set", { id: eye.switchId, property: "switch", source: 'if(blink(4) > 0, "Closed", "Open")' });
  const rig = await h.call<{ rigId: string; bones: Array<{ id: string; name: string }> }>("rig.create", {
    ids: [upper.id, lower.id, eye.switchId],
    name: "Arm",
    bones: [
      { head: [0, 0], tail: [100, 0], name: "Upper", parent: null },
      { head: [100, 0], tail: [200, 0], name: "Lower" },
      { head: [200, 40], tail: [230, 40], name: "Hand target", parent: null, deform: false, shape: "diamond" },
    ],
  });
  await h.call("rig.bone", { rigId: rig.rigId, edit: [{ bone: "Lower", ik: { target: "Hand target", chain: 2 } }] });
  const upperBone = rig.bones.find((b) => b.name === "Upper")!.id;
  await h.call("keyframes.set", { id: rig.rigId, property: `bone.${upperBone}.rotation`, keys: [{ at: 0, value: 0 }, { at: 500, value: 25 }] });

  const roots = h.store
    .getState()
    .tracks.filter((t) => !t.groupId)
    .flatMap((t) => t.clips)
    .filter((c) => c.frameId === main)
    .map((c) => c.id);
  return { ...h, main, roots };
}

/** Run printed code on `doc` without the subject, the way a person would paste it into the Scripts panel. */
async function runOn(doc: MotionDocument, roots: readonly string[], frameId: string, code: string) {
  const without = produce(doc, (d) => void clearScriptOutput(d, { clipIds: [...roots], frameIds: [] }));
  const h = harness(without);
  h.focusOn(frameId);
  const before = docIds(h.store.getState());
  await runScriptInProcess(api, h.ctx, code, scriptHere(h.store.getState(), frameId));
  const made = createdSince(before, h.store.getState());
  return { doc: h.store.getState(), roots: made.clipIds };
}

describe("reify — code = visual", () => {
  it("round-trips a rich scene exactly, and prints the same code again from the copy", async () => {
    const s = await richScene();
    const doc = s.store.getState();
    const out = await reify(doc, { layers: s.roots }, { registry: api });
    if (process.env.REIFY_PRINT) console.log(out.code);
    expect(out.warnings).toEqual([]);
    expect(out.exact).toBe(true);
    // Idiomatic: verbs and names, not a dump.
    expect(out.code).toContain('await ac.layer.create({');
    expect(out.code).toContain("ac.rig.create(");
    expect(out.code).toContain('ik: { target: "Hand target"');
    expect(out.code).toContain("ac.switch.create(");
    expect(out.code).toMatch(/property: `lfx\.\$\{\w+\.effectId\}\.size`/);
    expect(out.code).toMatch(/property: `bone\.\$\{armBone\.Upper\}\.rotation`/);
    expect(out.code).toContain('sourceFrameId: "Badge"');
    expect(out.code).not.toMatch(/clip_[0-9a-z]{12}/);

    const back = await runOn(doc, s.roots, s.main, out.code);
    const eq = reifyEqual({ doc, roots: s.roots, frameId: s.main }, { doc: back.doc, roots: back.roots, frameId: s.main });
    expect(eq.diffs).toEqual([]);

    const again = await reify(back.doc, { layers: back.roots }, { registry: api });
    expect(again.code).toBe(out.code);
  });

  it("measures what no printer says — poses, shape keys, caret, a second fill — and still comes back exact", async () => {
    const h = harness();
    const mouth = await h.call<Id>("layer.create", { kind: "path", name: "Mouth", d: "M-40 0 C -20 20 20 20 40 0", stroke: { color: "#111111", width: 6 }, startMs: 0 });
    const open = await h.call<{ id: string }>("shapekey.create", { id: mouth.id, name: "Open", points: [{ index: 1, dy: 18 }] });
    await h.call("keyframes.set", { id: mouth.id, property: `key.${open.id}`, keys: [{ at: 0, value: 0 }, { at: 400, value: 1 }] });
    const a = await h.call<Id>("layer.create", { kind: "shape", shape: "ellipse", name: "A", width: 20, height: 20, startMs: 0 });
    const b = await h.call<Id>("layer.create", { kind: "shape", shape: "rect", name: "B", width: 20, height: 6, startMs: 0 });
    const sw = await h.call<{ switchId: string }>("switch.create", { ids: [a.id, b.id], name: "Lips" });
    const head = await h.call<{ groupId: string }>("layers.group", { ids: [sw.switchId, mouth.id], name: "Head" });
    await h.call("poses.create", { groupId: head.groupId, fromSwitch: sw.switchId, blend: { ms: 0 } });
    const t = await h.call<Id>("layer.create", { kind: "text", text: "type", name: "Caret", startMs: 0 });
    await h.call("layer.patch", { id: t.id, ops: [{ op: "merge", path: "caret", value: { enabled: true, style: "block" } }, { op: "insert", path: "fills", value: { type: "solid", color: "#00FFAA" } }] });
    await h.call("layer.patch", { id: t.id, ops: [{ op: "set", path: "feather", value: 3 }] });
    const doc = h.store.getState();
    const roots = [head.groupId, t.id];
    const out = await reify(doc, { layers: roots }, { registry: api });
    expect(out.warnings).toEqual([]);
    expect(out.exact).toBe(true);
    expect(out.code).toContain("ac.shapekey.create(");
    expect(out.code).toContain("ac.poses.create(");
    expect(out.code).toContain("Exact details");
    const back = await runOn(doc, roots, h.focus(), out.code);
    expect(reifyEqual({ doc, roots, frameId: h.focus() }, { doc: back.doc, roots: back.roots, frameId: h.focus() }).diffs).toEqual([]);
    expect((await reify(back.doc, { layers: back.roots }, { registry: api })).code).toBe(out.code);
  });

  it("orders circular expression references after every layer exists", async () => {
    const s = await richScene();
    const out = await reify(s.store.getState(), { layers: s.roots }, { registry: api });
    const lastCreate = Math.max(out.code.lastIndexOf("ac.layer.create("), out.code.lastIndexOf("ac.rig.create("));
    expect(out.code.indexOf("ac.expression.set(")).toBeGreaterThan(lastCreate);
  });

  it("keeps names with quotes, unicode and RTL intact, and escapes invisible bidi controls", async () => {
    const h = harness();
    const name = 'He said "hi" — مرحبا ‮evil';
    const t = await h.call<Id>("layer.create", { kind: "text", text: "سلام world `${x}` \\ end", name, startMs: 0 });
    const doc = h.store.getState();
    const out = await reify(doc, { layers: [t.id] }, { registry: api });
    expect(out.exact).toBe(true);
    expect(out.code).toContain("\\u202e");
    expect(out.code).not.toContain("‮");
    expect(out.code).toContain("مرحبا");
    const back = await runOn(doc, [t.id], h.focus(), out.code);
    expect(reifyEqual({ doc, roots: [t.id], frameId: h.focus() }, { doc: back.doc, roots: back.roots, frameId: h.focus() }).diffs).toEqual([]);
  });

  it("keeps a curved motion path: an arced hop comes back as the same arc", async () => {
    const h = harness();
    const dot = await h.call<Id>("layer.create", { kind: "shape", shape: "ellipse", name: "Dot", width: 40, height: 40, startMs: 0, durationMs: 2000 });
    await h.call("keyframes.set", { id: dot.id, property: "position", keys: [{ at: 0, value: [-200, 100], arc: 160 }, { at: 500, value: [200, 100], easing: "hold" }, { at: 900, value: [200, 0] }] });
    const doc = h.store.getState();
    const out = await reify(doc, { layers: [dot.id] }, { registry: api });
    expect(out.code).toContain('property: "position"');
    const back = await runOn(doc, [dot.id], h.focus(), out.code);
    expect(reifyEqual({ doc, roots: [dot.id], frameId: h.focus() }, { doc: back.doc, roots: back.roots, frameId: h.focus() }).diffs).toEqual([]);
  });

  it("disambiguates duplicate names deterministically", async () => {
    const h = harness();
    const ids: string[] = [];
    for (const x of [-100, 0, 100]) ids.push((await h.call<Id>("layer.create", { kind: "shape", shape: "ellipse", name: "Dot", width: 20, height: 20, x, startMs: 0 })).id);
    await h.call("keyframes.set", { id: ids[1], property: "opacity", keys: [{ at: 0, value: 0 }, { at: 300, value: 1 }] });
    const doc = h.store.getState();
    const a = await reify(doc, { layers: ids }, { registry: api });
    const b = await reify(doc, { layers: [...ids].reverse() }, { registry: api });
    expect(a.code).toBe(b.code);
    // Three "Dot"s get three distinct names; only the one read later is declared.
    expect(a.code).toMatch(/const dot2 = await/);
    expect(a.code).toContain("id: dot2.id");
    expect(a.exact).toBe(true);
  });

  it("keeps a selection's place under the layers above it, and a ledger that adopts it edits in place", async () => {
    const h = harness();
    const bottom = await h.call<Id>("layer.create", { kind: "shape", shape: "rect", name: "Bottom", width: 50, height: 50, startMs: 0 });
    const top = await h.call<Id>("layer.create", { kind: "shape", shape: "rect", name: "Top", width: 60, height: 60, startMs: 0 });
    const doc = h.store.getState();
    const out = await reify(doc, { layers: [bottom.id] }, { registry: api });
    expect(out.code).toContain('placement: { below: "Top" }');
    expect(out.owns.clipIds).toEqual([bottom.id]);

    // The Scripts panel's replace run: take back what the ledger owns, then run.
    const count = (d: MotionDocument) => d.tracks.flatMap((t) => t.clips).length;
    const edited = out.code.replace("width: 50", "width: 80");
    h.store.update("replace", (d) => void clearScriptOutput(d, { clipIds: out.owns.clipIds, frameIds: [] }));
    await runScriptInProcess(api, h.ctx, edited, scriptHere(h.store.getState(), h.focus()));
    const after = h.store.getState();
    expect(count(after)).toBe(count(doc));
    const clips = after.tracks.flatMap((t) => t.clips);
    const remade = clips.find((c) => c.name === "Bottom")!;
    expect(remade.kind === "shape" && remade.width).toBe(80);
    // Still under "Top".
    const z = (id: string) => after.tracks.findIndex((t) => t.clips.some((c) => c.id === id));
    expect(z(remade.id)).toBeGreaterThan(z(top.id));
  });

  it("script.reify saves a script whose ledger owns the layers — its first replace run edits them in place", async () => {
    const h = harness();
    const dot = await h.call<Id>("layer.create", { kind: "shape", shape: "ellipse", name: "Dot", width: 40, height: 40, startMs: 0 });
    const res = await h.call<{ code: string; exact: boolean; saved: { id: string } }>("script.reify", { layers: ["Dot"], save: "dot.js" });
    expect(res.exact).toBe(true);
    const script = h.store.getState().scripts.find((s) => s.id === res.saved.id)!;
    expect(script.output.clipIds).toEqual([dot.id]);
    // What the Scripts panel does on Run (replace): clear the ledger, then run the (edited) source.
    h.store.update("run", (d) => void clearScriptOutput(d, script.output));
    await runScriptInProcess(api, h.ctx, script.source.replace("width: 40", "width: 64"), scriptHere(h.store.getState(), h.focus()));
    const dots = h.store.getState().tracks.flatMap((t) => t.clips).filter((c) => c.name === "Dot");
    expect(dots).toHaveLength(1);
    expect(dots[0]!.kind === "shape" && dots[0]!.width).toBe(64);
  });

  it("prints a whole comp with its inputs and machine, and the machine alone for the board's Code tab", async () => {
    const h = harness();
    const ch = await h.call<Id>("frame.create", { name: "Pip", width: 200, height: 200 });
    h.focusOn(ch.id);
    await h.call("layer.create", { kind: "shape", shape: "ellipse", name: "Head", width: 120, height: 120, fill: "#FFCC00", startMs: 0 });
    await h.call("component.inputs", { action: "define", frameId: ch.id, def: { name: "Happy", type: "bool" } });
    await h.call("machine.create", {
      name: "Mood",
      layers: [{ states: [{ name: "Idle" }, { name: "Joy" }], transitions: [{ from: "Idle", to: "Joy", when: [{ kind: "input", input: "Happy", value: true }] }] }],
    });
    const doc = h.store.getState();
    const out = await reify(doc, { comp: ch.id }, { registry: api });
    expect(out.warnings).toEqual([]);
    expect(out.exact).toBe(true);
    expect(out.code).toContain("ac.frame.create(");
    expect(out.code).toContain("ac.component.inputs(");
    expect(out.code).toContain("ac.machine.create(");
    expect(out.owns.frameIds).toEqual([ch.id]);

    const machine = doc.frames.find((f) => f.id === ch.id)!.machines![0]!;
    const part = await reify(doc, { part: "machine", frameId: ch.id, id: machine.id }, { registry: api });
    expect(part.code.match(/ac\.machine\.create/g)).toHaveLength(1);
    expect(part.code).toContain('frameId: "Pip"');
  });
});
