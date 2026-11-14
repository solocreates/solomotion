import { afterEach, describe, expect, it } from "vitest";
import type { MotionDocument, GroupClip, ShapeClip } from "../schema";
import { createAssetAudioClip, createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { createDocumentStore } from "../history/document-store";
import { locateClip } from "../timeline/ops";
import { getClipProperty } from "../animation/paths";
import { writeChannel } from "../animation/channels";
import { clipLookup } from "../timeline/frame-index";
import { createRig } from "../rig/ops";
import { poseBlendFor, poseChoiceAt, poseSetMixAt, resolvePose } from "../rig/poses";
import { addPose, createPoseSet } from "../rig/pose-ops";
import { choosePose } from "../rig/pose-choice";
import { characterLanes } from "../rig/character-lanes";
import { poseEnvAt, resolvedDocAt } from "../evaluate/resolved-doc";
import { parseDocument, serializeDocument } from "../io";
import { createCommandApi, type CommandContext } from "../api";
import { installSpeechReader } from "../speech/reader";
import { BEHAVIOR } from "./registry";
import { blinkEvents, behaviorsChoiceAt, behaviorChannelWrites } from "./evaluate";
import { addBehavior, behaviorBlockAt, moveBehaviorBlock, overrideBehavior, removeBehavior, resetBehaviorOverrides, updateBehavior } from "./ops";

const instant = { ms: 0, ease: { kind: "linear" as const } };

/** A character with Eyes (Open / Half / Closed / Angry) on an eye's opacity, 30 fps, 20 s. */
function face() {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  doc.frames[0]!.fps = 30;
  const rigId = createRig(doc, frameId, { name: "Pip", bones: [{ head: [0, 0], tail: [0, -100], name: "Torso" }, { head: [0, -100], tail: [0, -160], name: "Head", parent: "Torso" }] })!;
  const g = () => locateClip(doc, rigId)!.clip as GroupClip;
  g().durationMs = 20_000;
  const track = createTrack("Eye");
  track.groupId = rigId;
  const eye = createShapeClip({ frameId, shape: "ellipse", startMs: 0, durationMs: 20_000, x: 0, y: 0, width: 40, height: 20 }) as ShapeClip;
  eye.name = "Eye";
  track.clips.push(eye);
  doc.tracks.push(track);
  const eyes = createPoseSet(doc, rigId, { name: "Eyes", vocabulary: "eyes", blend: instant })!;
  for (const [name, v] of [["Open", 1], ["Half", 0.5], ["Closed", 0], ["Angry", 0.8]] as const) addPose(doc, rigId, eyes, { name, values: [{ clipId: eye.id, path: "opacity", value: v }] });
  const set = () => g().poses!.find((s) => s.id === eyes)!;
  const wants = (t: number) => resolvePose(set(), poseChoiceAt(doc, g(), set(), t, poseEnvAt(doc, t, frameId)).value)?.name;
  const opacity = (t: number) => getClipProperty(clipLookup(resolvedDocAt(structuredClone(doc), t, frameId))(eye.id)!, "opacity") as number;
  return { doc, frameId, rigId, g, eye, eyes, set, wants, opacity };
}

/** The first blink of a Blink behavior (group-local ms). */
function firstBlink(f: ReturnType<typeof face>) {
  for (let t = 0; t < 20_000; t += 1000 / 30) if (f.wants(t) === "Closed") return t;
  throw new Error("no blink");
}

describe("behaviors — the live half of a character", () => {
  it("is a domain of the one effect registry, its numbers keyable at bhv.<id>.<field>", () => {
    expect(BEHAVIOR.domain).toBe("behavior");
    expect(BEHAVIOR.types.map((d) => d.type)).toEqual(["lipSync", "blink", "glance", "breathe", "sway", "nod", "cycle", "machine"]);
    expect(BEHAVIOR.path("b1", "every")).toBe("bhv.b1.every");
  });

  it("Blink is added tailored to the character: its eyes, its Closed and Half poses", () => {
    const f = face();
    const b = addBehavior(f.doc, f.rigId, "blink")!;
    expect(b.set).toBe(f.eyes);
    expect(b.closed).toBe("Closed");
    expect(b.half).toBe("Half");
  });

  it("blinks only while shut: your Angry eyes stay Angry between blinks, and still blink", () => {
    const f = face();
    addBehavior(f.doc, f.rigId, "blink", { half: "" });
    writeChannel(f.g(), `pose.${f.eyes}`, 0, "Angry", { forceKey: true });
    const t = firstBlink(f);
    expect(f.wants(t - 200)).toBe("Angry");
    expect(f.wants(t + 30)).toBe("Closed");
    expect(f.opacity(t + 30)).toBe(0);
    expect(f.opacity(t - 200)).toBe(0.8);
  });

  it("a blink with a Half pose passes through it on the way down and up (top and bottom lids)", () => {
    const f = face();
    addBehavior(f.doc, f.rigId, "blink", { length: 300 });
    const t = firstBlink(f);
    // Closed is reached after the first quarter: one frame before, it was Half.
    expect(f.wants(t - 1000 / 30)).toBe("Half");
  });

  it("is deterministic and replayable; the rhythm's fields shape it", () => {
    const a = blinkEvents(4, 120, 40, 17, 7, 60_000).map((e) => e.atMs);
    const b = blinkEvents(4, 120, 40, 17, 7, 60_000).map((e) => e.atMs);
    expect(a).toEqual(b);
    const even = blinkEvents(2, 120, 0, 0, 7, 20_000);
    const gaps = even.slice(1).map((e, i) => Math.round(e.atMs - even[i]!.atMs));
    expect(new Set(gaps).size).toBe(1);
    expect(gaps[0]).toBe(2000);
  });

  it("an override stands it aside, adds a blink in a gap, and survives regenerating", () => {
    const f = face();
    const b = addBehavior(f.doc, f.rigId, "blink", { half: "" })!;
    const t = firstBlink(f);
    const block = behaviorBlockAt(f.doc, f.g(), f.set(), b.id, t + 10, poseEnvAt(f.doc, t, f.frameId))!;
    expect(block.pose).toBe("Closed");
    overrideBehavior(f.doc, f.rigId, b.id, { fromMs: block.fromMs, toMs: block.toMs, pose: null });
    expect(f.wants(t + 10)).toBe("Open");
    overrideBehavior(f.doc, f.rigId, b.id, { fromMs: 500, toMs: 640, pose: "Closed" });
    expect(f.wants(560)).toBe("Closed");
    // A new rhythm regenerates every blink — and keeps both changes.
    updateBehavior(f.doc, f.rigId, b.id, { every: 3.1 });
    expect(f.wants(560)).toBe("Closed");
    expect(f.g().behaviors![0]!.overrides).toHaveLength(2);
    expect(resetBehaviorOverrides(f.doc, f.rigId, b.id)).toBe(2);
    expect(f.g().behaviors![0]!.overrides).toBeUndefined();
  });

  it("moving a blink block: it stands aside where it was and shows where it went", () => {
    const f = face();
    const b = addBehavior(f.doc, f.rigId, "blink", { half: "" })!;
    const t = firstBlink(f);
    const block = behaviorBlockAt(f.doc, f.g(), f.set(), b.id, t + 10)!;
    moveBehaviorBlock(f.doc, f.rigId, b.id, block, { fromMs: block.fromMs + 600, toMs: block.toMs + 600 });
    expect(f.wants(t + 10)).toBe("Open");
    expect(f.wants(t + 610)).toBe("Closed");
  });

  it("a Face pad pick during a blink overrides that blink, not your keys", () => {
    const f = face();
    const b = addBehavior(f.doc, f.rigId, "blink", { half: "" })!;
    const t = firstBlink(f);
    const r = choosePose(f.doc, f.g(), f.set(), "Angry", t + 10, { env: poseEnvAt(f.doc, t + 10, f.frameId) });
    expect(r.kind).toBe("overridden");
    expect(f.wants(t + 10)).toBe("Angry");
    expect(f.g().keyframes.some((k) => k.property === `pose.${f.eyes}`)).toBe(false);
    // Off a blink, a pick keys the eyes as always.
    expect(choosePose(f.doc, f.g(), f.set(), "Angry", 100, { record: true, env: poseEnvAt(f.doc, 100, f.frameId) }).kind).toBe("keyed");
    void b;
  });

  it("later behaviors win where two are active; a disabled one (or keyed off) says nothing", () => {
    const f = face();
    const cycle = addBehavior(f.doc, f.rigId, "cycle", {}, { steps: [{ pose: "Half", ms: 1000 }, { pose: "Angry", ms: 1000 }] })!;
    expect(f.wants(500)).toBe("Half");
    expect(f.wants(1500)).toBe("Angry");
    expect(f.wants(2500)).toBe("Half");
    addBehavior(f.doc, f.rigId, "blink", { half: "" });
    const t = firstBlink(f);
    expect(f.wants(t + 10)).toBe("Closed"); // Blink is later in the stack
    updateBehavior(f.doc, f.rigId, cycle.id, { enabled: false });
    expect(f.wants(500)).toBe("Open");
    // The switch is a channel too: keyed on at 0:04.
    writeChannel(f.g(), BEHAVIOR.path(cycle.id, "enabled"), 4000, true, { forceKey: true });
    writeChannel(f.g(), BEHAVIOR.path(cycle.id, "enabled"), 0, false, { forceKey: true });
    expect(f.wants(4500)).toBe("Half");
    expect(f.wants(500)).toBe("Open");
  });

  it("Breathe adds onto a bone's stretch — your keys stay underneath", () => {
    const f = face();
    const torso = f.g().rig!.bones.find((b) => b.name === "Torso")!.id;
    const b = addBehavior(f.doc, f.rigId, "breathe", { amount: 2, rate: 15 })!;
    // 15 breaths a minute: a full breath in at 2 s.
    const writes = behaviorChannelWrites(f.doc, f.g(), 2000);
    expect(writes).toEqual([{ clipId: f.rigId, path: `bone.${torso}.scale`, mode: "multiply", value: 1.02, behaviorId: b.id }]);
    writeChannel(f.g(), `bone.${torso}.scale`, 0, 1.5, { forceKey: true });
    const shown = getClipProperty(clipLookup(resolvedDocAt(structuredClone(f.doc), 2000, f.frameId))(f.rigId)!, `bone.${torso}.scale`) as number;
    expect(shown).toBeCloseTo(1.53, 6);
  });

  it("the timeline's lanes say who decided each block — keys, a behavior, an override", () => {
    const f = face();
    const b = addBehavior(f.doc, f.rigId, "blink", { half: "" })!;
    const t = firstBlink(f);
    overrideBehavior(f.doc, f.rigId, b.id, { fromMs: 300, toMs: 420, pose: "Closed" });
    const lane = characterLanes(f.doc, f.rigId, { fromMs: 0, toMs: t + 400 }, (x) => poseEnvAt(f.doc, x, f.frameId))[0]!;
    expect(lane.mode).toBe("live");
    expect(lane.behaviors.map((x) => x.type)).toEqual(["blink"]);
    const live = lane.blocks.filter((x) => x.source === "live");
    expect(live[0]).toMatchObject({ name: "Closed", behaviorId: b.id, overridden: true });
    expect(live[1]).toMatchObject({ name: "Closed", behaviorId: b.id });
    expect(live[1]!.overridden).toBeUndefined();
    expect(lane.blocks.find((x) => x.source !== "live")!.name).toBe("Open");
  });

  it("per-pair transitions: Open → Closed snaps, Closed → Open eases", () => {
    const f = face();
    f.set().blend = { ms: 200, ease: { kind: "linear" } };
    f.set().transitions = [{ from: "Open", to: "Closed", ms: 0 }];
    const open = f.set().poses.find((p) => p.name === "Open")!.id;
    const closed = f.set().poses.find((p) => p.name === "Closed")!.id;
    expect(poseBlendFor(f.set(), open, closed).ms).toBe(0);
    expect(poseBlendFor(f.set(), closed, open).ms).toBe(200);
    writeChannel(f.g(), `pose.${f.eyes}`, 1000, "Closed", { forceKey: true });
    writeChannel(f.g(), `pose.${f.eyes}`, 2000, "Open", { forceKey: true });
    writeChannel(f.g(), `pose.${f.eyes}`, 0, "Open", { forceKey: true });
    expect(poseSetMixAt(f.doc, f.g(), f.set(), 1000)!.weights.get(closed)).toBe(1);
    expect(poseSetMixAt(f.doc, f.g(), f.set(), 2100)!.weights.get(open)).toBeCloseTo(0.5, 2);
  });

  it("round-trips through a saved file", () => {
    const f = face();
    const b = addBehavior(f.doc, f.rigId, "blink")!;
    overrideBehavior(f.doc, f.rigId, b.id, { fromMs: 300, toMs: 420, pose: null });
    const back = parseDocument(serializeDocument(f.doc));
    const g = locateClip(back, f.rigId)!.clip as GroupClip;
    expect(g.behaviors![0]).toMatchObject({ type: "blink", set: f.eyes, closed: "Closed", overrides: [{ fromMs: 300, toMs: 420, pose: null }] });
    removeBehavior(back, f.rigId, b.id);
    expect((locateClip(back, f.rigId)!.clip as GroupClip).behaviors).toBeUndefined();
  });
});

describe("Lip sync — the mouth follows whichever voice is playing", () => {
  afterEach(() => installSpeechReader(null));

  /** A Mouth set (Rest / AI / O) and two voices, A at 0–1 s and B at 2–3 s, each one cue. */
  function talker() {
    const f = face();
    const mouthClip = f.eye; // any member clip carries the values
    const mouth = createPoseSet(f.doc, f.rigId, { name: "Mouth", vocabulary: "visemes", blend: instant })!;
    for (const [name, v] of [["Rest", 0.1], ["AI", 0.2], ["O", 0.3]] as const) addPose(f.doc, f.rigId, mouth, { name, values: [{ clipId: mouthClip.id, path: "rotation", value: v }] });
    const voices: Record<string, { cue: string }> = {};
    for (const [name, start, cue] of [["A", 0, "AI"], ["B", 2000, "O"]] as const) {
      const assetId = `asset_${name}`;
      f.doc.assets.push({ id: assetId, kind: "audio", name: `${name}.wav`, mime: "audio/wav", bytes: 1, width: null, height: null, durationMs: 1000, fps: null, folderId: null, origin: null } as MotionDocument["assets"][number]);
      const t = createTrack(`Voice ${name}`);
      t.clips.push(createAssetAudioClip({ frameId: f.frameId, assetId, startMs: start, durationMs: 1000, name }));
      f.doc.tracks.push(t);
      voices[assetId] = { cue };
    }
    installSpeechReader((assetId) => {
      const v = voices[assetId];
      return v ? ({ engine: "test", version: 1, settingsKey: "", durationMs: 1000, cues: [{ startMs: 0, endMs: 200, viseme: "X", confidence: 1 }, { startMs: 200, endMs: 800, viseme: v.cue, confidence: 1 }, { startMs: 800, endMs: 1000, viseme: "X", confidence: 1 }], energy: { hopMs: 10, values: new Array(100).fill(0.8) } } as never) : null;
    });
    const set = () => f.g().poses!.find((s) => s.id === mouth)!;
    const says = (t: number) => resolvePose(set(), poseChoiceAt(f.doc, f.g(), set(), t, poseEnvAt(f.doc, t, f.frameId)).value)?.name;
    return { ...f, mouth, set, says };
  }

  it("speaks with A, then B; between voices your keys show", () => {
    const m = talker();
    addBehavior(m.doc, m.rigId, "lipSync");
    writeChannel(m.g(), `pose.${m.mouth}`, 0, "O", { forceKey: true });
    expect(m.says(500)).toBe("AI");
    expect(m.says(2500)).toBe("O");
    expect(m.says(100)).toBe("Rest"); // a pause inside A: rest
    expect(m.says(1500)).toBe("O"); // no voice: your key
  });

  it("pauses can show your pose instead of rest", () => {
    const m = talker();
    addBehavior(m.doc, m.rigId, "lipSync", { pausesShowKeys: true });
    writeChannel(m.g(), `pose.${m.mouth}`, 0, "O", { forceKey: true });
    expect(m.says(100)).toBe("O");
    expect(m.says(500)).toBe("AI");
  });

  it("one voice by name ignores the other", () => {
    const m = talker();
    addBehavior(m.doc, m.rigId, "lipSync", { voice: "B" });
    expect(behaviorsChoiceAt(m.doc, m.g(), m.set(), 500)).toBeNull();
    expect(m.says(2500)).toBe("O");
  });
});

describe("behaviors, for agents", () => {
  it("add, inspect blocks, override, remove", async () => {
    const built = face();
    const store = createDocumentStore(built.doc);
    const api = createCommandApi();
    const ctx: CommandContext = { store, actor: "AI", historyKey: "t", historyLabel: "Behaviors", session: { focusFrameId: () => built.frameId, playheadMs: () => 0, selection: () => [] } };
    const run = async (id: string, input: unknown) => {
      const res = await api.call(id, input, ctx);
      if (!res.ok) throw new Error(`${id}: ${res.error}`);
      return res.value;
    };
    // Read the store's document from here on: every write replaces it.
    const f = { ...built, g: () => locateClip(store.getState(), built.rigId)!.clip as GroupClip, wants: (t: number) => {
      const doc = store.getState();
      const g = locateClip(doc, built.rigId)!.clip as GroupClip;
      const set = g.poses!.find((s) => s.id === built.eyes)!;
      return resolvePose(set, poseChoiceAt(doc, g, set, t, poseEnvAt(doc, t, built.frameId)).value)?.name;
    } };
    const added = (await run("behaviors.add", { groupId: f.rigId, type: "blink", fields: { half: "" } })) as { behavior: { id: string; set: string } };
    expect(added.behavior.set).toBe("Eyes");
    const t = firstBlink(f as never);
    const seen = (await run("behaviors.inspect", { groupId: f.rigId, blocks: true, fromMs: 0, toMs: t + 300 })) as { lanes: Array<{ blocks: Array<{ pose: string; source: string; behavior?: string }> }> };
    expect(seen.lanes[0]!.blocks.some((b) => b.pose === "Closed" && b.behavior === added.behavior.id)).toBe(true);
    await run("behaviors.override", { groupId: f.rigId, id: added.behavior.id, fromMs: t - 5, toMs: t + 200, pose: null });
    expect(f.wants(t + 10)).toBe("Open");
    await run("behaviors.remove", { groupId: f.rigId, id: "blink" });
    expect(f.g().behaviors).toBeUndefined();
  });
});
