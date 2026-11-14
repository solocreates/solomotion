import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../history/document-store";
import { createAudioClip, createEmptyDocument } from "../factories";
import { frameDurationMs, locateClip } from "../timeline/ops";
import { frameLayerTree } from "../timeline/layer-tree";
import { editPath, pathToFrame } from "../navigation";
import type { NestedClip } from "../schema";
import { createCommandApi, type CommandContext } from ".";

/**
 * The API driven the way an agent drives it: through `call`, with JSON in and
 * JSON out, never touching the document directly. If a task here needs a
 * workaround, the API is missing a verb.
 */

function harness() {
  const store = createDocumentStore(createEmptyDocument("Test"));
  const api = createCommandApi();
  let playhead = 0;
  const ctx: CommandContext = {
    store,
    actor: "AI",
    historyKey: "turn-1",
    historyLabel: "Make a title card",
    session: {
      focusFrameId: () => store.getState().frames[0]?.id ?? null,
      playheadMs: () => playhead,
      selection: () => [],
    },
  };
  const call = async (id: string, input: unknown = {}) => {
    const res = await api.call(id, input, ctx);
    if (!res.ok) throw new Error(`${id}: ${res.error}${res.hint ? ` (${res.hint})` : ""}`);
    return res.value as Record<string, unknown>;
  };
  return { store, api, ctx, call, seek: (ms: number) => (playhead = ms) };
}

describe("command API", () => {
  it("builds a flipbook cell by cell and draws into each cell", async () => {
    const { call, store } = harness();
    const { id } = (await call("frame.create", { name: "Walk", mode: "flipbook", width: 640, height: 640, fps: 12 })) as { id: string };
    const sheet = (await call("flipbook.edit", { id, ops: [{ op: "add", count: 3, hold: 2 }] })) as {
      rows: Array<{ cells: Array<{ id: string; drawingId: string; frame: number; hold: number }> }>;
      made: string[];
    };
    const cells = sheet.rows[0]!.cells;
    expect(sheet.made).toHaveLength(3);
    // Frame 1 is the sheet's own first drawing; the three follow it, on twos.
    expect(cells.map((c) => c.hold).slice(-3)).toEqual([2, 2, 2]);
    expect(cells.slice(-3).map((c) => c.frame)).toEqual([cells.at(-4)!.frame + cells.at(-4)!.hold, cells.at(-4)!.frame + cells.at(-4)!.hold + 2, cells.at(-4)!.frame + cells.at(-4)!.hold + 4]);

    // A cell is an ordinary comp to draw into.
    const last = cells.at(-1)!;
    await call("layer.create", { kind: "shape", shape: "ellipse", width: 100, height: 100, fill: "#ff2e88", frameId: last.drawingId });
    const dup = (await call("flipbook.edit", { id, ops: [{ op: "duplicate", cellId: last.id }, { op: "hold", cellId: cells[0]!.id, frames: 3 }] })) as typeof sheet;
    const copy = dup.rows[0]!.cells.find((c) => c.id === dup.made[0])!;
    expect(store.getState().tracks.flatMap((t) => t.clips).filter((c) => c.frameId === copy.drawingId && c.kind === "shape")).toHaveLength(1);
    expect(dup.rows[0]!.cells[0]!.hold).toBe(3);

    await expect(call("flipbook.edit", { id: store.getState().frames[0]!.id, ops: [{ op: "addRow" }] })).rejects.toThrow(/not a flipbook/);
  });

  it("describes itself as provider-safe tools", () => {
    const tools = createCommandApi().toolSpecs();
    expect(tools.length).toBeGreaterThan(25);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(t.inputSchema.type).toBe("object");
      // A tool list is paid for on every request — keep each one lean.
      expect(JSON.stringify(t.inputSchema).length).toBeLessThan(9000);
    }
  });

  it("keys a modulator's own fields (a camera shake that ramps in on the hit)", async () => {
    const { call, store } = harness();
    const card = await call("layer.create", { kind: "shape", shape: "rect", width: 200, height: 200 });
    await call("layer.patch", { id: card.id, ops: [{ op: "set", path: "modulators", value: [{ id: "mod_shake", target: "x", shape: "wiggle", rate: 16, amount: 0 }] }] });
    await call("keyframes.set", {
      id: card.id,
      property: "mod.mod_shake.amount",
      keys: [{ at: 0, value: 0 }, { at: 100, value: 14, easing: "ease-out" }, { at: 420, value: 0 }],
    });
    const clip = locateClip(store.getState(), String(card.id))!.clip;
    expect(clip.keyframes.find((t) => t.property === "mod.mod_shake.amount")?.keys.map((k) => k.value)).toEqual([0, 14, 0]);
  });

  it("builds a card, styles it, animates it — and it is one undo step", async () => {
    const { call, store } = harness();
    const overview = await call("doc.overview");
    const comps = overview.comps as Array<{ id: string; size: number[] }>;
    expect(comps.length).toBe(1);

    const card = await call("layer.create", {
      kind: "shape",
      shape: "rect",
      width: 800,
      height: 400,
      fill: "#1B1B22",
      cornerRadius: 32,
      set: { opacity: 0.95 },
    });
    const title = await call("layer.create", {
      kind: "text",
      text: "Hello motion",
      style: { fontSize: 96, fontWeight: 800, color: "#FFFFFF" },
      placement: { above: card.id },
    });
    await call("text.style", { id: title.id, match: "motion", style: { color: "#7C5CFF" } });
    await call("animation.set", { id: title.id, slot: "in", preset: "fade-up", staggerMs: 40, easing: "ease-out-expo" });
    await call("keyframes.set", {
      id: card.id,
      property: "scale",
      keys: [
        { at: 0, value: 0.9, easing: "ease-out-back" },
        { at: 600, value: 1 },
      ],
    });
    const fx = await call("effects.add", { id: card.id, type: "shadow" });
    expect(String(fx.effectId)).toBeTruthy();

    const doc = store.getState();
    const text = locateClip(doc, String(title.id))!.clip;
    expect(text.kind === "text" && text.ranges.length).toBeGreaterThan(0);
    expect(text.kind === "text" && text.animations.in?.preset).toBe("fade-up");
    const rect = locateClip(doc, String(card.id))!.clip;
    expect(rect.keyframes.find((t) => t.property === "scale")?.keys.length).toBe(2);

    // Twenty writes, one request, one ⌘Z.
    expect(store.peekUndoLabel()).toBe("AI · Make a title card");
    store.undo();
    expect(store.getState().tracks.flatMap((t) => t.clips)).toHaveLength(0);
  });

  it("refuses bad input with an error a model can act on", async () => {
    const { api, ctx, call } = harness();
    const shape = await call("layer.create", { kind: "shape", shape: "ellipse", width: 100, height: 100 });

    const badPath = await api.call("layer.set", { ids: shape.id, values: { rotaton: 10 } }, ctx);
    expect(badPath.ok).toBe(false);
    expect(!badPath.ok && badPath.hint).toMatch(/rotation/);

    // A setting, not a value: layer.set names the verb that writes it.
    const setting = await api.call("layer.set", { ids: shape.id, values: { blendMode: "screen" } }, ctx);
    expect(!setting.ok && setting.hint).toMatch(/layer\.patch.*"path":"blendMode","value":"normal"/);
    await call("layer.patch", { id: shape.id, ops: [{ op: "set", path: "blendMode", value: "screen" }] });

    const badValue = await api.call("layer.patch", { id: shape.id, ops: [{ op: "set", path: "opacity", value: 7 }] }, ctx);
    expect(badValue.ok).toBe(false);
    expect(!badValue.ok && badValue.error).toMatch(/opacity/);

    const owned = await api.call("layer.patch", { id: shape.id, ops: [{ op: "set", path: "text", value: "x" }] }, ctx);
    expect(!owned.ok && owned.hint).toMatch(/text\.set/);

    const missing = await api.call("layer.get", { id: "clip_nope" }, ctx);
    expect(!missing.ok && missing.kind).toBe("api");
  });

  it("patches structure by stable id and validates the result", async () => {
    const { call, store } = harness();
    const t = await call("layer.create", { kind: "text", text: "Patch me" });
    await call("effects.add", { id: t.id, type: "glow" });
    const clip = locateClip(store.getState(), String(t.id))!.clip;
    const fxId = clip.kind === "text" ? clip.effects[0]!.id : "";
    await call("layer.patch", {
      id: t.id,
      ops: [
        { op: "set", path: `effects[id=${fxId}].enabled`, value: false },
        { op: "merge", path: "style", value: { align: "left", letterSpacing: 2 } },
      ],
    });
    const after = locateClip(store.getState(), String(t.id))!.clip;
    expect(after.kind === "text" && after.effects[0]!.enabled).toBe(false);
    expect(after.kind === "text" && after.style.align).toBe("left");
  });

  it("a group patched into a cutting mode gets a cutter, as Combine does", async () => {
    const { call, store } = harness();
    const word = await call("layer.create", { kind: "text", text: "WORD" });
    const dot = await call("layer.create", { kind: "shape", shape: "ellipse", width: 40, height: 40, fill: "#fff" });
    const { groupId } = (await call("layers.group", { ids: [word.id, dot.id] })) as { groupId: string };
    await call("layer.patch", { id: groupId, ops: [{ op: "set", path: "mode", value: "subtract" }] });
    const isStencil = (id: unknown) => {
      const c = locateClip(store.getState(), String(id))!.clip;
      return c.kind !== "audio" && c.isStencil;
    };
    // The top member (the dot, made last) cuts; the word is what gets cut.
    expect(isStencil(dot.id)).toBe(true);
    expect(isStencil(word.id)).toBe(false);
  });

  it("creates with several paints, unnamed text effects, and a waveform on a sound", async () => {
    const { call, store } = harness();
    const card = await call("layer.create", {
      kind: "shape", shape: "rect", width: 200, height: 100,
      fills: ["#112233", { type: "solid", color: "#ffffff", opacity: 0.2 }],
      strokes: [{ color: "#ff0000", width: 2 }],
    });
    expect(card.fills).toHaveLength(2);
    expect(card.strokes).toHaveLength(1);
    await expect(call("layer.create", { kind: "shape", shape: "rect", width: 1, height: 1, fill: "#000", fills: ["#fff"] })).rejects.toThrow(/fill` or `fills/);

    const title = await call("layer.create", { kind: "text", text: "Hi", style: { textEffects: [{ type: "glow", radius: 8 }] } });
    const t = locateClip(store.getState(), String(title.id))!.clip;
    expect(t.kind === "text" && t.style.textEffects[0]!.id).toBeTruthy();

    const frameId = store.getState().frames[0]!.id;
    store.update("Add a sound", (d) => {
      d.tracks[0]!.clips.push({ ...createAudioClip({ frameId, startMs: 1000, durationMs: 3000 }), id: "voice", name: "Voice" });
    });
    const wave = await call("layer.create", { kind: "waveform", target: "Voice", waveform: { template: "line" } });
    const w = locateClip(store.getState(), String(wave.id))!.clip;
    const voice = locateClip(store.getState(), "voice")!.clip;
    expect(w.kind === "waveform" && [w.targetClipId, w.startMs, w.durationMs, w.style.template]).toEqual(["voice", 1000, 3000, "line"]);
    expect(w.linkGroupId).toBe(voice.linkGroupId);
    expect(w.linkGroupId).toBeTruthy();
  });

  it("bounces a number key into real impact and apex keys", async () => {
    const { call, store } = harness();
    const ball = await call("layer.create", { kind: "shape", shape: "ellipse", width: 40, height: 40, startMs: 0 });
    await call("keyframes.set", { id: ball.id, property: "y", keys: [{ at: 0, value: -400, bounce: { count: 2 } }, { at: 1200, value: 300 }] });
    const c = locateClip(store.getState(), String(ball.id))!.clip;
    const keys = c.keyframes.find((t) => t.property === "y")!.keys;
    // drop, impact, apex, impact, apex, landing
    expect(keys.map((k) => k.value).filter((v) => v === 300)).toHaveLength(3);
    expect(keys).toHaveLength(6);
    await expect(call("keyframes.set", { id: ball.id, property: "position", keys: [{ at: 0, value: [0, 0], bounce: true }, { at: 500, value: [0, 100] }] })).rejects.toThrow(/bounce/);
  });

  it("batches with references to earlier results", async () => {
    const { call, store } = harness();
    const out = (await call("api.batch", {
      calls: [
        { command: "layer.create", input: { kind: "shape", shape: "rect", width: 200, height: 80, fill: "#222" } },
        { command: "layer.create", input: { kind: "text", text: "Button" } },
        { command: "layers.group", input: { ids: ["$0.id", "$1.id"], name: "Button", layout: { padding: { top: 16, right: 24, bottom: 16, left: 24 } } } },
      ],
    })) as unknown as Array<{ ok: boolean; value: Record<string, unknown> }>;
    expect(out.every((r) => r.ok)).toBe(true);
    const groupId = String(out[2]!.value.groupId);
    const group = locateClip(store.getState(), groupId)!.clip;
    expect(group.kind === "group" && group.layout).not.toBeNull();
    const tree = frameLayerTree(store.getState(), store.getState().frames[0]!.id);
    expect(tree[0]!.type === "group" && tree[0]!.children.length).toBe(2);
  });

  it("reads the live schema and every layer's own property list", async () => {
    const { call } = harness();
    const shape = await call("layer.create", { kind: "shape", shape: "star", width: 120, height: 120, fill: "#fc0" });
    await call("effects.add", { id: shape.id, type: "shadow" });
    const props = (await call("layer.properties", { id: shape.id })).properties as Array<{ path: string }>;
    const paths = props.map((p) => p.path);
    expect(paths).toContain("rotation");
    expect(paths.some((p) => p.startsWith("lfx."))).toBe(true);

    const sig = (await call("api.describe", { type: "text", path: "style" })) as unknown as string;
    expect(sig).toMatch(/fontSize/);
    const explode = (await call("catalog.get", { catalog: "modifiers", id: "explode" })) as { id: string };
    expect(explode.id).toBe("explode");
    await expect(call("catalog.get", { catalog: "primitives", id: "donut" })).rejects.toThrow(/torus/);
    const glass = (await call("catalog.get", { catalog: "layer-effects", id: "glass" })) as { fields: unknown[] };
    expect(glass.fields.length).toBeGreaterThan(3);
  });

  it("refuses a field the schema would have silently dropped, and names the real ones", async () => {
    const { call } = harness();
    await expect(call("layer.create", { kind: "shape", shape: "rect", width: 100, height: 100, stroke: { color: "#f00", thickness: 4 } }))
      .rejects.toThrow(/stroke\.thickness: not a field here.*width/);
    await expect(call("layer.create", { kind: "text", text: "Hi", style: { fontSise: 40 } })).rejects.toThrow(/did you mean "fontSize"/);
    await expect(call("layer.create", { kind: "shape", shape: "rect", width: 100, height: 100, stroke: { color: "#f00", width: 4 } })).resolves.toBeTruthy();
  });

  it("moves, trims and splits on the timeline", async () => {
    const { call, store } = harness();
    const a = await call("layer.create", { kind: "shape", shape: "rect", width: 50, height: 50, startMs: 0, durationMs: 4000 });
    await call("timeline.move", { ids: [a.id], startMs: 1000 });
    await call("timeline.trim", { id: a.id, endMs: 4000 });
    const split = await call("timeline.split", { id: a.id, atMs: 2500 });
    const doc = store.getState();
    const left = locateClip(doc, String(a.id))!.clip;
    const right = locateClip(doc, String(split.right))!.clip;
    expect([left.startMs, left.startMs + left.durationMs]).toEqual([1000, 2500]);
    expect(right.startMs + right.durationMs).toBe(4000);
  });

  it("lands a move or a trim exactly, changing lane when a neighbour is in the way", async () => {
    const { call, store } = harness();
    const rect = (startMs: number, durationMs: number) =>
      call("layer.create", { kind: "shape", shape: "rect", width: 50, height: 50, startMs, durationMs });
    const a = await rect(0, 2000);
    const b = await rect(3000, 3000);
    const lane = (id: unknown) => locateClip(store.getState(), String(id))!.track.id;
    expect(lane(a.id)).toBe(lane(b.id));

    // Into b's time: lands at 4000 on the lane above, and says who was there.
    const moved = await call("timeline.move", { ids: [a.id], startMs: 4000 });
    expect(moved.moved).toEqual([[4000, 6000]]);
    expect(moved.relaned).toMatchObject([{ id: a.id, blockedBy: { id: b.id } }]);
    expect(lane(a.id)).not.toBe(lane(b.id));

    // Back to its own time, then trimmed across b: the edge goes where it was asked.
    await call("timeline.move", { ids: [a.id], startMs: 0 });
    const c = await rect(3000, 1000);
    expect(lane(c.id)).toBe(lane(a.id));
    const trimmed = await call("timeline.trim", { id: a.id, endMs: 3500 });
    expect(trimmed.time).toEqual([0, 3500]);
    expect(trimmed.relaned).toMatchObject({ blockedBy: { id: c.id } });
    expect(trimmed.asked).toBeUndefined();
  });

  it("animates a group as one, and says what a group cannot take", async () => {
    const { call, store } = harness();
    const a = await call("layer.create", { kind: "shape", shape: "rect", width: 50, height: 50, x: -60 });
    const b = await call("layer.create", { kind: "shape", shape: "rect", width: 50, height: 50, x: 60 });
    const { groupId } = (await call("layers.group", { ids: [a.id, b.id], name: "Logo" })) as { groupId: string };
    await call("keyframes.set", { id: groupId, property: "y", keys: [{ at: 0, value: 200 }, { at: 600, value: 0 }] });
    await call("layer.set", { ids: groupId, values: { opacity: 0.5 } });
    const group = locateClip(store.getState(), groupId)!.clip;
    expect(group.keyframes.find((t) => t.property === "y")?.keys).toHaveLength(2);
    expect(group.kind === "group" && group.opacity).toBe(0.5);
    await expect(call("layer.set", { ids: groupId, values: { "crop.top": 10 } })).rejects.toThrow(/layers\.nest/);
  });

  it("files comps onto pages", async () => {
    const { call, store } = harness();
    const first = store.getState().frames[0]!;
    const reel = (await call("frame.create", { name: "Reel", width: 1080, height: 1920 })).id as string;
    const page = (await call("page.create", { name: "Reels", frameIds: [reel] })).id as string;
    const frame = (id: string) => store.getState().frames.find((f) => f.id === id)!;
    expect(frame(reel).pageId).toBe(page);
    // Beside what is already there, never on top of it.
    const cut = (await call("frame.create", { name: "Cutdown", width: 1080, height: 1920, pageId: "Reels" })).id as string;
    expect(frame(cut).pageId).toBe(page);
    expect(frame(cut).x).toBeGreaterThanOrEqual(frame(reel).x + frame(reel).width);
    await call("frame.update", { id: first.id, pageId: page });
    expect(frame(first.id).pageId).toBe(page);
    await expect(call("frame.update", { id: first.id, pageId: "Nowhere" })).rejects.toThrow(/No page/);
  });

  it("sets a comp's length through ops the same way as through durationMs (one door)", async () => {
    const { call, store } = harness();
    const id = store.getState().frames[0]!.id;
    // A lone comp's length lives on the document: a raw write to frame.durationMs used to be accepted and ignored.
    await call("frame.update", { id, ops: [{ op: "set", path: "durationMs", value: 42000 }] });
    expect(frameDurationMs(store.getState(), store.getState().frames[0]!)).toBe(42000);
    await call("frame.update", { id, durationMs: 9000 });
    expect(frameDurationMs(store.getState(), store.getState().frames[0]!)).toBe(9000);
  });

  it("renames, reorders and deletes pages", async () => {
    const { call, store } = harness();
    const first = store.getState().pages[0]!.id;
    const reel = (await call("frame.create", { name: "Reel", width: 1080, height: 1920 })).id as string;
    const reels = (await call("page.create", { name: "Reels", frameIds: [reel] })).id as string;
    await call("page.update", { id: first, name: "Start here" });
    await call("page.update", { id: "Reels", index: 0 });
    expect(store.getState().pages.map((p) => p.name)).toEqual(["Reels", "Start here"]);
    // A page with comps on it needs to be told what happens to them.
    await expect(call("page.delete", { id: reels })).rejects.toThrow(/still holds/);
    await call("page.delete", { id: reels, moveTo: "Start here" });
    expect(store.getState().pages.map((p) => p.name)).toEqual(["Start here"]);
    expect(store.getState().frames.find((f) => f.id === reel)!.pageId).toBe(first);
    await expect(call("page.delete", { id: first })).rejects.toThrow(/at least one page/);
  });

  it("never re-cuts a scene's own length when it is shown once inside another comp", async () => {
    const { call, store } = harness();
    const scene = (await call("frame.create", { name: "Scene", width: 1080, height: 1080, durationMs: 12000 })).id as string;
    const cover = (await call("frame.create", { name: "Cover", width: 1920, height: 1080, durationMs: 9000 })).id as string;
    const tile = (await call("layer.create", { kind: "comp", sourceFrameId: scene, frameId: cover, startMs: 0, durationMs: 9000 })).id as string;
    const len = () => store.getState().frames.find((f) => f.id === scene)!.durationMs;
    expect(len()).toBe(12000);
    await call("timeline.trim", { id: tile, endMs: 4000 });
    expect(len()).toBe(12000);
  });

  it("links a scene into another comp by default; makeUnique gives the layer its own copy", async () => {
    const { call, store } = harness();
    const scene = (await call("frame.create", { name: "Scene", width: 1080, height: 1080, durationMs: 12000 })).id as string;
    const cover = (await call("frame.create", { name: "Cover", width: 1920, height: 1080, durationMs: 9000 })).id as string;
    const tile = (await call("layer.create", { kind: "comp", sourceFrameId: scene, frameId: cover, startMs: 0, durationMs: 9000 })).id as string;
    await call("layer.patch", { id: tile, ops: [{ op: "set", path: "playback.loop", value: "loop" }] });
    const flags = async () => ((await call("layers.list", { frameId: cover })).layers as { id: string; flags?: string[] }[]).find((l) => l.id === tile)!.flags;
    // Linked: the scene keeps its page, its length and its own root.
    expect(await flags()).toContain("inside:linked");
    expect(pathToFrame(store.getState(), scene)).toEqual(editPath(scene));
    const { made } = (await call("layers.makeUnique", { ids: [tile] })) as { made: Record<string, string> };
    const copy = made[tile]!;
    const doc = store.getState();
    expect(await flags()).toContain("inside:embedded");
    expect(doc.frames.find((f) => f.id === copy)!.pageId).toBe("__internal__");
    expect(pathToFrame(doc, copy).hops).toEqual([tile]);
    // The original is untouched; the layer still loops the 12 s it showed.
    expect(doc.frames.find((f) => f.id === scene)!.durationMs).toBe(12000);
    expect((locateClip(doc, tile)!.clip as NestedClip).playback.loopLengthMs).toBe(12000);
    // Already embedded: nothing to do.
    expect(((await call("layers.makeUnique", { ids: [tile] })) as { made: object }).made).toEqual({});
  });

  it("creates a comp in a project that has none left", async () => {
    const { call, store } = harness();
    for (const f of [...store.getState().frames]) await call("frame.delete", { id: f.id });
    expect(store.getState().frames).toHaveLength(0);
    const { id } = (await call("frame.create", { name: "Fresh", width: 1080, height: 1920 })) as { id: string };
    expect(store.getState().frames.map((f) => f.id)).toEqual([id]);
  });

  it("refuses patch fields the schema would silently drop, and inserts into a list never written", async () => {
    const { call, store } = harness();
    const a = await call("layer.create", { kind: "shape", shape: "rect", width: 50, height: 50 });
    // the effects.add shape ({values:{…}}) inside a patch: refused by name, nothing lands
    await expect(
      call("layer.patch", { id: a.id, ops: [{ op: "set", path: "effects", value: [{ id: "fx_g", type: "glow", values: { size: 40 } }] }] }),
    ).rejects.toThrow(/Unknown field "effects\[0\]\.values"/);
    expect((locateClip(store.getState(), String(a.id))!.clip as { effects: unknown[] }).effects).toHaveLength(0);
    // flat fields land
    await call("layer.patch", { id: a.id, ops: [{ op: "set", path: "effects", value: [{ id: "fx_g", type: "glow", size: 40 }] }] });
    // modulators were never written on this layer: insert creates the list
    await call("layer.patch", { id: a.id, ops: [{ op: "insert", path: "modulators", value: { id: "m1", target: "opacity", shape: "wave", amount: 0.2 } }] });
    const clip = locateClip(store.getState(), String(a.id))!.clip as { modulators?: { id: string }[]; effects: { size?: number }[] };
    expect(clip.modulators?.map((m) => m.id)).toEqual(["m1"]);
    expect(clip.effects[0]!.size).toBe(40);
    // `list[-]` appends, via insert or set — even onto a list never written
    await call("layer.patch", { id: a.id, ops: [{ op: "insert", path: "effects[-]", value: { id: "fx_b", type: "boil" } }] });
    await call("layer.patch", { id: a.id, ops: [{ op: "set", path: "modulators[-]", value: { id: "m2", target: "x", shape: "wave", amount: 1 } }] });
    const b = await call("layer.create", { kind: "shape", shape: "rect", width: 50, height: 50 });
    await call("layer.patch", { id: b.id, ops: [{ op: "insert", path: "modulators[-]", value: { id: "m3", target: "x", shape: "wave", amount: 1 } }] });
    const after = locateClip(store.getState(), String(a.id))!.clip as { modulators: { id: string }[]; effects: { id: string }[] };
    expect(after.effects.map((e) => e.id)).toEqual(["fx_g", "fx_b"]);
    expect(after.modulators.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect((locateClip(store.getState(), String(b.id))!.clip as { modulators: { id: string }[] }).modulators.map((m) => m.id)).toEqual(["m3"]);
  });

  it("outlines a bare path but not a filled one", async () => {
    const { call, store } = harness();
    const filled = await call("layer.create", { kind: "path", d: "M0 0 L100 0 L50 80 Z", fill: "#FF3366" });
    const bare = await call("layer.create", { kind: "path", d: "M0 0 C 40 -60 120 -60 160 0" });
    const strokes = (id: unknown) => {
      const clip = locateClip(store.getState(), String(id))!.clip;
      return clip.kind === "path" ? clip.strokes.length : -1;
    };
    expect(strokes(filled.id)).toBe(0);
    expect(strokes(bare.id)).toBe(1);
  });

  it("places a path's points where its d says: an arc about 0,0 shares the circle's centre", async () => {
    const { call, store } = harness();
    const { layerMatrix, basisOfTransform } = await import("../transform-map");
    const { pathBox } = await import("../pivot");
    const landed = async (d: string, x: number, y: number, point: [number, number]) => {
      const { id } = await call("layer.create", { kind: "path", d, x, y });
      const clip = locateClip(store.getState(), String(id))!.clip;
      if (clip.kind !== "path") throw new Error("not a path");
      const m = layerMatrix(basisOfTransform(clip.transform, pathBox(clip.subpaths)));
      return [m[0] * point[0] + m[2] * point[1] + m[4] + clip.transform.x, m[1] * point[0] + m[3] * point[1] + m[5] + clip.transform.y];
    };
    const [ax, ay] = await landed("M 100 0 A 100 100 0 0 1 0 100", 40, -20, [100, 0]);
    expect(ax).toBeCloseTo(140, 6);
    expect(ay).toBeCloseTo(-20, 6);
    // Flat on an axis: still where d says.
    const [lx, ly] = await landed("M -50 30 L 50 30", 0, 0, [50, 30]);
    expect(lx).toBeCloseTo(50, 6);
    expect(ly).toBeCloseTo(30, 6);
  });

  it("reuses lanes scene after scene, shows them, and compacts on request", async () => {
    const { call, store } = harness();
    const rect = (startMs: number, durationMs: number) =>
      call("layer.create", { kind: "shape", shape: "rect", width: 50, height: 50, startMs, durationMs });
    for (const scene of [0, 3000, 6000]) {
      await rect(scene, 3000);
      await rect(scene, 3000);
      await rect(scene + 1000, 1000);
    }
    const listed = await call("layers.list");
    // Three layers overlap at most → three lanes, however many scenes.
    expect((listed.comp as { lanes: number }).lanes).toBe(3);
    const lanes = (listed.layers as Array<{ lane: number }>).map((l) => l.lane);
    expect(new Set(lanes)).toEqual(new Set([0, 1, 2]));

    // Sprawl made by hand (a lane per layer) is what compact undoes.
    store.update("sprawl", (d) => {
      for (const t of [...d.tracks]) {
        for (const c of [...t.clips]) {
          t.clips.splice(t.clips.indexOf(c), 1);
          d.tracks.unshift({ ...t, id: `t_${c.id}`, clips: [c], transitions: [] });
        }
      }
    });
    const compacted = await call("timeline.compact");
    expect(compacted.lanesBefore).toBeGreaterThan(3);
    expect(compacted.lanesAfter).toBe(3);
  });

  it("only undoes its own steps", async () => {
    const { api, ctx, call, store } = harness();
    await call("layer.create", { kind: "text", text: "mine" });
    store.update("User edit", (d) => void (d.name = "Renamed by a person"));
    const res = await api.call("history.undo", {}, ctx);
    expect(res.ok).toBe(false);
    expect(store.getState().name).toBe("Renamed by a person");
  });

  it("builds a colour grade from nodes holding ordinary colour cards", async () => {
    const { call, store } = harness();
    const img = await call("layer.create", { kind: "shape", shape: "rect", width: 400, height: 300, fill: "#88aacc" });
    const first = await call("grade.node", { id: img.id, name: "Balance" });
    const look = await call("grade.node", { id: img.id, name: "Look", after: first.nodeId });
    const colour = (await call("catalog.list", { catalog: "layer-effects" })) as unknown as Array<{ id: string; category: string }>;
    const card = colour.find((c) => /colou?r/i.test(c.category));
    expect(card).toBeTruthy();
    const fx = await call("grade.effect", { id: img.id, nodeId: look.nodeId, type: card!.id });
    expect(String(fx.path)).toMatch(/^lfx\..+\.n\..+\.fx\./);
    const graph = (await call("grade.read", { id: img.id })) as unknown as Array<{ nodes: Array<{ name: string }> }>;
    expect(graph[0]!.nodes.map((n) => n.name)).toEqual(expect.arrayContaining(["Balance", "Look"]));
    expect(store.getState().tracks.length).toBeGreaterThan(0);
  });

  it("nests layers into their own comp", async () => {
    const { call, store } = harness();
    const a = await call("layer.create", { kind: "shape", shape: "rect", width: 100, height: 100 });
    const b = await call("layer.create", { kind: "text", text: "Inside" });
    const nest = await call("layers.nest", { ids: [a.id, b.id], name: "Card" });
    expect(store.getState().frames.some((f) => f.id === nest.sourceFrameId)).toBe(true);
  });

  it("drives a property with a checked expression and adds a transition on a cut", async () => {
    const { api, ctx, call, store } = harness();
    const a = await call("layer.create", { kind: "shape", shape: "rect", width: 80, height: 80, startMs: 0, durationMs: 2000 });
    const bad = await api.call("expression.set", { id: a.id, property: "rotation", source: "wiggle(" }, ctx);
    expect(bad.ok).toBe(false);
    const ok = await call("expression.set", { id: a.id, property: "rotation", source: "#time * 0.09" });
    expect(locateClip(store.getState(), String(a.id))!.clip.drivers?.rotation).toBe(`fx:${ok.expressionId}`);
    const ref = (await call("expression.reference")) as { functions: unknown[] };
    expect(ref.functions.length).toBeGreaterThan(2);

    const b = await call("layer.create", { kind: "shape", shape: "rect", width: 80, height: 80, startMs: 2000, durationMs: 2000, placement: { groupId: undefined } });
    await call("timeline.move", { ids: [b.id], startMs: 2000 });
    const presets = (await call("catalog.list", { catalog: "transitions" })) as unknown as Array<{ id: string }>;
    const res = await api.call("transition.add", { ids: [a.id], preset: presets[0]!.id, edge: "out" }, ctx);
    expect(res.ok).toBe(true);
  });

  it("mints ids for inserted fills, stops and effects", async () => {
    const { call, store } = harness();
    const r = await call("layer.create", { kind: "shape", shape: "rect", width: 300, height: 200 });
    await call("layer.patch", {
      id: r.id,
      ops: [
        {
          op: "set",
          path: "fills",
          value: [{ type: "linear", stops: [{ offset: 0, color: "#FF3366" }, { offset: 1, color: "#7C5CFF" }] }],
        },
      ],
    });
    const clip = locateClip(store.getState(), String(r.id))!.clip;
    const fill = clip.kind === "shape" ? clip.fills[0] : undefined;
    expect(fill?.id).toBeTruthy();
    expect(fill && "stops" in fill && fill.stops.every((s) => s.id)).toBe(true);
  });

  it("morphs a path between two SVG outlines", async () => {
    const { call, store } = harness();
    const blob = await call("layer.create", { kind: "path", d: "M-100 -100 C -50 -100 50 -100 100 -100 C 100 -50 100 50 100 100 C 50 100 -50 100 -100 100 C -100 50 -100 -50 -100 -100 Z", fill: "#7C5CFF" });
    await call("keyframes.set", {
      id: blob.id,
      property: "geometry",
      keys: [
        { at: 0, value: "M-100 -100 C -50 -100 50 -100 100 -100 C 100 -50 100 50 100 100 C 50 100 -50 100 -100 100 C -100 50 -100 -50 -100 -100 Z", easing: "ease-in-out" },
        { at: 1000, value: "M0 -120 C 66 -120 120 -66 120 0 C 120 66 66 120 0 120 C -66 120 -120 66 -120 0 C -120 -66 -66 -120 0 -120 Z" },
      ],
    });
    const clip = locateClip(store.getState(), String(blob.id))!.clip;
    const track = clip.keyframes.find((t) => t.property === "geometry")!;
    expect(track.keys).toHaveLength(2);
    expect(Array.isArray(track.keys[1]!.value)).toBe(true);
  });

  it("separates a video's sound for a J-cut, and cuts pauses with the comp in sync", async () => {
    const { call, store } = harness();
    store.update("seed", (d) => {
      d.assets.push({ id: "v1", kind: "video", name: "talk.mp4", mime: "video/mp4", bytes: 1, width: 1920, height: 1080, durationMs: 20_000, fps: 30, folderId: null, origin: null });
    });
    const talk = (await call("layer.create", { kind: "media", assetId: "v1", startMs: 0, durationMs: 10_000 })).id as string;
    const title = (await call("layer.create", { kind: "text", text: "Later", startMs: 6000, durationMs: 1000 })).id as string;

    const { audioId } = (await call("audio.detach", { id: talk })) as { audioId: string };
    const video = locateClip(store.getState(), talk)!.clip;
    expect(video.kind === "video" && video.muted).toBe(true);
    // J-cut: the sound leads — its start trims earlier on its own, the picture stays.
    await call("timeline.trim", { id: audioId, startMs: 0, endMs: 9000 });
    expect(locateClip(store.getState(), talk)!.clip.durationMs).toBe(10_000);

    await call("audio.rejoin", { id: audioId });
    expect(locateClip(store.getState(), audioId)).toBeNull();

    const cut = await call("timeline.cut_ranges", { id: talk, ranges: [{ startMs: 2000, endMs: 3000 }, { startMs: 4000, endMs: 4500 }] });
    expect(cut).toMatchObject({ removedMs: 1500, cuts: 2 });
    expect((cut.pieces as string[]).length).toBe(3);
    // The title after the cuts slid back with them.
    expect(locateClip(store.getState(), title)!.clip.startMs).toBe(4500);
  });
});


describe("strokes at create time", () => {
  it("takes a colour, the shorthand, or the stored stroke shape — and refuses a misspelled field", async () => {
    const { call, store } = harness();
    const strokeOf = (id: unknown) => {
      const clip = locateClip(store.getState(), id as string)!.clip as { strokes?: Array<Record<string, unknown>> };
      return clip.strokes?.[0];
    };
    const a = await call("layer.create", { kind: "shape", shape: "ellipse", width: 100, height: 100, stroke: "#FF0000" });
    expect(strokeOf(a.id)).toMatchObject({ width: 4, paint: { type: "solid", color: "#FF0000" } });

    const b = await call("layer.create", { kind: "shape", shape: "rect", width: 100, height: 100, stroke: { color: "#00FF00", width: 2 } });
    expect(strokeOf(b.id)).toMatchObject({ width: 2, paint: { color: "#00FF00" } });

    // What a model that has read the document writes (a GPT script did exactly this).
    const c = await call("layer.create", {
      kind: "path",
      d: "M0 0 L100 0",
      fill: null,
      stroke: { paint: { type: "solid", color: "#D4FF3F" }, width: 1.5, align: "outside", cap: "round", dash: [6, 4] },
    });
    expect(strokeOf(c.id)).toMatchObject({ width: 1.5, align: "outside", cap: "round", dash: [6, 4], paint: { color: "#D4FF3F" } });

    await expect(call("layer.create", { kind: "shape", shape: "rect", width: 10, height: 10, stroke: { color: "#fff", widht: 3 } })).rejects.toThrow(/widht.*did you mean "width"/);
    await expect(call("layer.create", { kind: "shape", shape: "rect", width: 10, height: 10, fill: { type: "solid", color: "#fff", opacty: 0.5 } })).rejects.toThrow(/opacty.*did you mean "opacity"/);
  });
  it("removes media nothing uses, and refuses media a layer still shows", async () => {
    const { call, store } = harness();
    const pic = (id: string) => ({ id, kind: "image" as const, name: `${id}.png`, mime: "image/png", bytes: 1, width: 10, height: 10, durationMs: null, fps: null, folderId: null, origin: null });
    store.update("seed", (d) => void d.assets.push(pic("a_used"), pic("a_spare1"), pic("a_spare2")));
    await call("layer.create", { kind: "media", assetId: "a_used" });
    await expect(call("media.remove", { assetIds: ["a_used"] })).rejects.toThrow(/Still in use/);
    expect((await call("media.remove", { unused: true })).removed).toHaveLength(2);
    expect(store.getState().assets.map((a) => a.id)).toEqual(["a_used"]);
  });

  it("nests a comp by the kind layers.list reports it as", async () => {
    const { call, store } = harness();
    const { id } = (await call("frame.create", { name: "Inner", width: 400, height: 400 })) as { id: string };
    const outer = store.getState().frames[0]!.id;
    const layer = await call("layer.create", { kind: "nested", sourceFrameId: id, frameId: outer });
    expect(locateClip(store.getState(), String(layer.id))?.clip.kind).toBe("nested");
  });
});
