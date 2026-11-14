import { describe, expect, it } from "vitest";
import "../index";
import type { MotionDocument, Clip, GroupClip } from "../schema";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { createCommandApi, type CommandContext } from "../api";
import { inProcessAc } from "../scripts/run-in-process";
import { getClipProperty } from "../animation/paths";
import { clipLookup } from "../timeline/frame-index";
import { resolvedDocAt } from "../evaluate/resolved-doc";
import { inputDefsOf } from "../components/inputs";
import { lifeOf, planBringToLife } from "./alive";

/**
 * "Make character" end to end: the plan, run through the registry as one
 * undo step, makes a drawing blink (both eyes together), breathe, nod and
 * talk — and running it again plans nothing.
 */

function harness() {
  const doc = createEmptyDocument("Alive");
  doc.assets.push({ id: "line", kind: "audio", name: "line.wav", mime: "audio/wav", bytes: 1, width: null, height: null, durationMs: 3000, fps: null, folderId: null, origin: null });
  const store = createDocumentStore(doc);
  const api = createCommandApi();
  let focus = doc.frames[0]!.id;
  const ctx: CommandContext = { store, actor: "You", session: { focusFrameId: () => focus, playheadMs: () => 0, selection: () => [] } };
  const call = async (id: string, input: unknown = {}) => {
    const res = await api.call(id, input, ctx);
    if (!res.ok) throw new Error(`${id}: ${res.error}${res.hint ? ` (${res.hint})` : ""}`);
    return res.value as Record<string, unknown>;
  };
  return { store, api, ctx, call, root: doc.frames[0]!.id, focusOn: (id: string) => (focus = id) };
}

const DUR = 4000;
const shape = (name: string, x: number, y: number, w: number, h: number, frameId?: string) => ({ kind: "shape", shape: "ellipse", width: w, height: h, x, y, name, fill: "#886644", startMs: 0, durationMs: DUR, ...(frameId && { frameId }) });

type H = ReturnType<typeof harness>;

/** Pip: a head, two eye switches (Open/Closed), a mouth switch of visemes. */
async function pip(h: H, frameId?: string, opts: { eyes?: "switch" | "plain" | "lids" } = {}) {
  const id = async (s: ReturnType<typeof shape>) => (await h.call("layer.create", s)).id as string;
  const ids: string[] = [await id(shape("Head", 0, 0, 300, 340, frameId))];
  for (const s of [["L", 60], ["R", -60]] as const) {
    if ((opts.eyes ?? "switch") === "switch") {
      const open = await id(shape("Open", s[1], -40, 50, 60, frameId));
      const closed = await id(shape("Closed", s[1], -40, 50, 6, frameId));
      ids.push((await h.call("switch.create", { ids: [open, closed], name: `Eye ${s[0]}`, show: "Open" })).switchId as string);
    } else {
      ids.push(await id(shape(`Eye ${s[0]}`, s[1], -40, 50, 60, frameId)));
      if (opts.eyes === "lids") ids.push(await id(shape(`Lid ${s[0]}`, s[1], -40, 54, 64, frameId)));
    }
    ids.push(await id(shape(`Pupil ${s[0]}`, s[1], -40, 16, 16, frameId)));
  }
  const mouths: string[] = [];
  for (const n of ["Rest", "MBP", "AI", "E", "O", "U"]) mouths.push(await id(shape(n, 0, 90, 110, 40, frameId)));
  ids.push((await h.call("switch.create", { ids: mouths, name: "Mouth", show: "Rest" })).switchId as string);
  return (await h.call("layers.group", { ids, name: "Pip" })).groupId as string;
}

const voice = async (h: H, name = "Voice") => (await h.call("layer.create", { kind: "media", assetId: "line", frameId: h.root, name, startMs: 0 })).id as string;

const clip = (doc: MotionDocument, id: string) => clipLookup(doc)(id) as Clip;
const named = (doc: MotionDocument, name: string) => doc.tracks.flatMap((t) => t.clips).find((c) => c.name === name)!;

describe("character.bringToLife", () => {
  it("one click: pose sets, blink, breathe, nod, talk — one undo step, and again plans nothing", async () => {
    const h = harness();
    const g = await pip(h);
    await voice(h);
    const before = h.store.getState();

    const out = (await h.call("character.bringToLife", { id: g })) as { life: Record<string, { on: boolean }>; voice: string; ran: number };
    expect(Object.fromEntries(Object.entries(out.life).map(([k, v]) => [k, v.on]))).toEqual({ talk: true, blink: true, breathe: true, nod: true, look: false });
    expect(out.voice).toBe("Voice");

    const doc = h.store.getState();
    const pipG = clip(doc, g) as GroupClip;
    expect(pipG.rig).toBeTruthy();
    expect(pipG.poses!.map((s) => [s.name, s.vocabulary])).toEqual([["Mouth", "visemes"], ["Eyes", "eyes"]]);
    const mouth = pipG.poses![0]!, eyes = pipG.poses![1]!;
    expect(mouth.poses.map((p) => p.name)).toEqual(["X", "MBP", "E", "AI", "O", "U"]);
    // Its life is BEHAVIORS — listed, tunable, deletable — not hidden expressions.
    expect(pipG.drivers ?? {}).toEqual({});
    expect(pipG.modulators ?? []).toEqual([]);
    expect(pipG.behaviors!.map((b) => [b.type, b.set ?? b.channel])).toEqual([
      ["lipSync", mouth.id],
      ["blink", eyes.id],
      ["breathe", "scaleY"],
      ["nod", "rotation"],
    ]);
    // It speaks with whichever voice plays; the blink shuts with the set's own Closed.
    expect(pipG.behaviors![0]!.voice).toBe("");
    expect(pipG.behaviors![1]).toMatchObject({ closed: "Closed", every: 4 });

    // ONE undo step, labelled for the person.
    h.store.undo();
    expect(JSON.stringify(h.store.getState())).toBe(JSON.stringify(before));
    h.store.redo();

    // Idempotent: nothing more to do.
    expect(planBringToLife(h.store.getState(), g)!.steps).toEqual([]);
    const life = lifeOf(h.store.getState(), g)!;
    expect(Object.fromEntries(Object.entries(life).map(([k, v]) => [k, v.on]))).toEqual({ blink: true, breathe: true, nod: true, look: false, talk: true });
  });

  it("both eyes blink on one rhythm, and breathing holds the bottom edge", async () => {
    const h = harness();
    const g = await pip(h);
    await h.call("character.bringToLife", { id: g, talk: false });
    const doc = h.store.getState();
    const eyeL = named(doc, "Eye L").id, eyeR = named(doc, "Eye R").id;
    let shut = 0;
    for (let t = 0; t < 12000; t += 20) {
      const at = resolvedDocAt(doc, t, h.root);
      const l = getClipProperty(clip(at, eyeL), "switch"), r = getClipProperty(clip(at, eyeR), "switch");
      expect(l).toBe(r);
      if (String(l).toLowerCase() === "closed") shut++;
    }
    expect(shut).toBeGreaterThan(2);
    // Breath: scaleY up to +1.2 %, y lifting by half the growth — the bottom edge stays (box height 340 → 0.003·340 ≈ 1).
    const samples = [0, 900, 1800, 2700].map((t) => clip(resolvedDocAt(doc, t, h.root), g));
    for (const s of samples) {
      const sy = Number(getClipProperty(s, "scaleY")), y = Number(getClipProperty(s, "y"));
      expect(sy).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(sy).toBeLessThanOrEqual(1.012 + 1e-9);
      expect(Math.abs(y + (sy - 1) * 170)).toBeLessThan(0.2);
    }
  });

  it("plain eyes squash, lids show: whatever the art, the Eyes set closes them", async () => {
    for (const eyes of ["plain", "lids"] as const) {
      const h = harness();
      const g = await pip(h, undefined, { eyes });
      await h.call("character.bringToLife", { id: g, talk: false });
      const set = (clip(h.store.getState(), g) as GroupClip).poses!.find((s) => s.vocabulary === "eyes")!;
      const closed = set.poses.find((p) => p.name === "Closed")!.values.map((v) => [v.path, v.value]);
      expect(closed).toEqual(eyes === "plain" ? [["scaleY", 0.1], ["scaleY", 0.1]] : [["opacity", 1], ["opacity", 1]]);
    }
  });

  it("a flat picture with drawn lids and a mouth set blinks and talks, folded into one undo step with the host's placement", async () => {
    const h = harness();
    const id = async (s: ReturnType<typeof shape>) => (await h.call("layer.create", s)).id as string;
    const picture = await id(shape("Photo", 0, 0, 400, 500));
    const lids = [await id(shape("Lid L", 60, -60, 50, 30)), await id(shape("Lid R", -60, -60, 50, 30))];
    const mouths: string[] = [];
    for (const n of ["X", "MBP", "AI", "E", "O"]) mouths.push(await id(shape(n, 0, 90, 110, 40)));
    const mouth = (await h.call("switch.create", { ids: mouths, name: "Mouth", show: "X" })).switchId as string;
    const g = (await h.call("layers.group", { ids: [picture, ...lids, mouth], name: "Photo" })).groupId as string;
    await voice(h);
    const before = h.store.getState();
    const { makeCharacterStore } = await import("../api");
    const store = makeCharacterStore(h.store, "flat-1");
    store.update("ignored", (d) => void (named(d, "Photo").name = "Pip"));
    const res = await h.api.call("character.bringToLife", { id: g }, { ...h.ctx, store });
    expect(res.ok).toBe(true);
    const doc = h.store.getState();
    const set = (clip(doc, g) as GroupClip).poses!.find((s) => s.vocabulary === "eyes")!;
    expect(set.poses.find((p) => p.name === "Closed")!.values.map((v) => v.path)).toEqual(["opacity", "opacity"]);
    expect((res as { value: { life: Record<string, { on: boolean }> } }).value.life.talk?.on).toBe(true);
    h.store.undo();
    expect(JSON.stringify(h.store.getState())).toBe(JSON.stringify(before));
  });

  it("toggles: false turns a behavior off; Look adds pupil pads that look at one control", async () => {
    const h = harness();
    const g = await pip(h);
    await h.call("character.bringToLife", { id: g, talk: false });
    await h.call("character.bringToLife", { id: g, breathe: false, look: true });
    const doc = h.store.getState();
    const pipG = clip(doc, g) as GroupClip;
    expect(pipG.modulators ?? []).toEqual([]);
    expect(pipG.rig!.bones.map((b) => b.name).sort()).toEqual(["Look", "Look.L", "Look.R", "Pupil.L", "Pupil.R"]);
    expect(pipG.rig!.bones.find((b) => b.name === "Pupil.L")!.constraints?.[0]?.type).toBe("look");
    const life = lifeOf(doc, g)!;
    expect([life.breathe.on, life.look.on, life.blink.on]).toEqual([false, true, true]);
    // Drag the Look control: the left pupil slides, inside its eye.
    await h.call("rig.pose", { rigId: g, poses: [{ bone: "Look", x: 200, y: 0 }] });
    const ins = (await h.call("rig.inspect", { rigId: g })) as { bones: Array<{ name: string; rest: { head: number[] }; now: { head: number[] } }> };
    const p = ins.bones.find((b) => b.name === "Pupil.L")!;
    expect(p.now.head[0]! - p.rest.head[0]!).toBeGreaterThan(5);
    expect(p.now.head[0]! - p.rest.head[0]!).toBeLessThanOrEqual(13.6);
  });

  it("dryRun is deterministic, changes nothing, and its script IS the run", async () => {
    const h = harness();
    const g = await pip(h);
    await voice(h);
    const before = h.store.getState();
    const a = (await h.call("character.bringToLife", { id: g, dryRun: true })) as { script: string; steps: unknown[] };
    const b = (await h.call("character.bringToLife", { id: g, dryRun: true })) as { script: string };
    expect(a.script).toBe(b.script);
    expect(h.store.getState()).toBe(before);
    expect(a.script).toMatch(/const s\d+ = await ac\.poses\.create/);
    expect(a.script).toMatch(/"set":s\d+\.setId/);

    // Running the printed script makes the same character the verb does.
    const ac = inProcessAc(h.api, h.ctx);
    await new Function("ac", `return (async () => {\n${a.script}\n})();`)(ac);
    const viaScript = h.store.getState();
    expect(planBringToLife(viaScript, g)!.steps).toEqual([]);
    expect((clip(viaScript, g) as GroupClip).poses!.map((s) => s.name)).toEqual(["Mouth", "Eyes"]);
  });

  it("an instance talks through its comp's Voice input, set in the outer comp", async () => {
    const h = harness();
    const comp = (await h.call("frame.create", { name: "Pip", width: 400, height: 400, fps: 30, durationMs: DUR })) as { id: string };
    h.focusOn(comp.id);
    await pip(h, comp.id);
    h.focusOn(h.root);
    const v = await voice(h, "Line A");
    const inst = (await h.call("layer.create", { kind: "comp", sourceFrameId: comp.id, frameId: h.root, name: "Pip 1", startMs: 0, durationMs: DUR })) as { id: string };
    const out = (await h.call("character.bringToLife", { id: inst.id, voice: v })) as { life: Record<string, { on: boolean }> };
    expect(out.life.talk?.on).toBe(true);
    const doc = h.store.getState();
    const g = named(doc, "Pip") as GroupClip;
    const mouth = g.poses!.find((s) => s.vocabulary === "visemes")!;
    // Lip sync and the nod hear whichever voice plays — inside an instance, its Voice input.
    expect(g.behaviors!.find((b) => b.type === "lipSync")).toMatchObject({ set: mouth.id, voice: "" });
    expect(g.behaviors!.find((b) => b.type === "nod")).toMatchObject({ voice: "" });
    const def = inputDefsOf(doc, comp.id).find((d) => d.name === "Voice")!;
    expect(getClipProperty(clip(doc, inst.id), `input.${def.id}`)).toBe("Line A");
    expect(planBringToLife(doc, inst.id)!.steps).toEqual([]);
  });
});
