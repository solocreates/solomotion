import { describe, expect, it } from "vitest";
import type { MotionDocument, GroupClip, ShapeClip } from "../schema";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { locateClip } from "../timeline/ops";
import { groupClips } from "../timeline/groups";
import { makeSwitch } from "../timeline/switch-ops";
import { switchShownIds } from "../timeline/switch";
import { setKeyframe } from "../animation/keyframes";
import { getClipProperty } from "../animation/paths";
import { clipAnimatableProperties } from "../animation/clip-properties";
import { propertyDef } from "../animation/properties";
import { addExpression } from "../expressions/document";
import { fxToken } from "../schema/expressions";
import { settleDocument } from "../timeline/settled";
import { createWorld } from "../world/ops";
import { evaluateWorld } from "../world/evaluate";
import { createDocumentStore } from "../history/document-store";
import { createCommandApi } from "../api";
import { createRig } from "./ops";
import { resolvePoseName } from "./vocabulary";
import { applyPoseMixes, documentHasPoses, poseMixAt, poseOwnerOf, resolvePose, poseSetMixAt } from "./poses";
import { poseEnvAt, resolvedDocAt } from "../evaluate/resolved-doc";
import { addPose, bakePoseSet, createPoseSet, keyPose, mirrorPoseInSet, poseSetFromSwitch, removePoseSet } from "./pose-ops";

const linear = { ms: 100, ease: { kind: "linear" as const } };
const STEP = 1000 / 30;

/** A face: a group holding a mouth switch (Rest/AI/O) and a lid rectangle, 30 fps. */
function face() {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  doc.frames[0]!.fps = 30;
  const rect = (name: string, x = 0): ShapeClip => {
    const c = createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 4000, x, y: 0, width: 40, height: 20 }) as ShapeClip;
    c.name = name;
    const lane = createTrack(name);
    lane.clips.push(c);
    doc.tracks.push(lane);
    return c;
  };
  const rest = rect("Rest"), ai = rect("AI"), o = rect("O"), lid = rect("Lid"), lidL = rect("Lid.L", -30), lidR = rect("Lid.R", 30);
  const mouth = makeSwitch(doc, [rest.id, ai.id, o.id], { name: "Mouth" })!;
  const head = groupClips(doc, [mouth, lid.id, lidL.id, lidR.id], "Head")!;
  const g = () => locateClip(doc, head)!.clip as GroupClip;
  return { doc, frameId, head, mouth, lid, lidL, lidR, g };
}

/** A mouth set: switch member + lid y + lid colour per pose. */
function mouthSet(f: ReturnType<typeof face>) {
  const setId = createPoseSet(f.doc, f.head, { name: "Mouth", vocabulary: "visemes", blend: linear })!;
  const v = (sw: string, y: number, color: string) => [
    { clipId: f.mouth, path: "switch", value: sw },
    { clipId: f.lid.id, path: "y", value: y },
    { clipId: f.lid.id, path: `fill.${f.lid.fills[0]!.id}`, value: color },
  ];
  addPose(f.doc, f.head, setId, { name: "Rest", values: v("Rest", 0, "#000000") });
  addPose(f.doc, f.head, setId, { name: "AI", values: v("AI", 100, "#ffffff") });
  addPose(f.doc, f.head, setId, { name: "O", values: v("O", 50, "#ff0000") });
  return setId;
}

const clipIn = (doc: MotionDocument, id: string) => locateClip(doc, id)!.clip;

describe("vocabulary", () => {
  it("matches case, punctuation and aliases, then walks fallbacks, else null", () => {
    expect(resolvePoseName("visemes", "a i", ["X", "AI"])).toBe("AI");
    expect(resolvePoseName("visemes", "rest", ["X", "AI"])).toBe("X");
    expect(resolvePoseName("visemes", "U", ["Rest", "O"])).toBe("O"); // U → O
    expect(resolvePoseName("visemes", "FV", ["Rest", "AI"])).toBe("AI"); // FV → S → E → AI, breadth first
    expect(resolvePoseName("eyes", "shut", ["Open", "Half"])).toBe("Half"); // Closed → Half
    expect(resolvePoseName("visemes", "zzz", ["X"])).toBeNull();
    expect(resolvePoseName(null, "ai", ["X"])).toBeNull();
  });
});

describe("pose.<set> channel", () => {
  it("is an ordinary discrete path: enumerated, base-writable, unknown names fall to the first pose", () => {
    const f = face();
    const setId = mouthSet(f);
    const path = `pose.${setId}`;
    expect(propertyDef(path)?.kind).toBe("discrete");
    expect(clipAnimatableProperties(f.g()).some((p) => p.path === path)).toBe(true);
    expect(getClipProperty(f.g(), path)).toBe("Rest");
    const set = f.g().poses![0]!;
    expect(resolvePose(set, "ah")?.name).toBe("AI"); // alias
    expect(resolvePose(set, "MBP")?.name).toBe("Rest"); // MBP → X (no pose) → first pose
    expect(resolvePose(set, "nothing")?.name).toBe("Rest");
    expect(resolvePose(set, 2)?.name).toBe("O");
    expect(resolvePose({ ...set, poses: [] }, "AI")).toBeNull();
  });
});

describe("poseMixAt", () => {
  const names = (keys: Array<[number, string]>) => (t: number) => {
    let n = keys[0]![1];
    for (const [at, v] of keys) if (t >= at) n = v;
    return n;
  };

  it("does not blend at the very start", () => {
    const mix = poseMixAt(names([[0, "B"]]), 0, linear, STEP);
    expect(mix.chain).toHaveLength(1);
    expect(mix.weights.get("B")).toBe(1);
  });

  it("is a pure function of t: scrubbing backward equals forward", () => {
    const fn = names([[0, "A"], [200, "B"], [250, "C"], [600, "A"]]);
    const ts = Array.from({ length: 30 }, (_, i) => i * STEP);
    const fwd = ts.map((t) => JSON.stringify([...poseMixAt(fn, t, linear, STEP).weights]));
    const back = [...ts].reverse().map((t) => JSON.stringify([...poseMixAt(fn, t, linear, STEP).weights])).reverse();
    expect(back).toEqual(fwd);
  });

  it("stacks changes closer than the blend window, weights summing to 1, target = newest", () => {
    const fn = names([[0, "A"], [10 * STEP, "B"], [11 * STEP, "C"]]);
    const mix = poseMixAt(fn, 12 * STEP, linear, STEP);
    expect(mix.target).toBe("C");
    expect(mix.chain.map((s) => s.pose)).toEqual(["A", "B", "C"]);
    const sum = [...mix.weights.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 9);
    expect(mix.weights.get("A")!).toBeGreaterThan(0);
    // A full blend later, only C remains.
    expect([...poseMixAt(fn, 11 * STEP + 100 + STEP, linear, STEP).weights]).toEqual([["C", 1]]);
  });
});

describe("applyPoseMixes (the bake)", () => {
  it("blends floats and colours, swaps discrete values at the START, drops the member's keys", () => {
    const f = face();
    const setId = mouthSet(f);
    const g = f.g();
    setKeyframe(g.keyframes, `pose.${setId}`, 0, "Rest");
    setKeyframe(g.keyframes, `pose.${setId}`, 10 * STEP, "AI");
    setKeyframe(clipIn(f.doc, f.lid.id).keyframes, "y", 0, -999); // the pose owns y: this key must not win
    const before = structuredClone(f.doc);
    // Exactly at the change: the switch already shows AI, the lid has not moved.
    const atChange = applyPoseMixes(f.doc, 10 * STEP, f.frameId);
    const mouth = clipIn(atChange, f.mouth) as GroupClip;
    expect([...switchShownIds(atChange, mouth, 10 * STEP)].map((id) => clipIn(atChange, id).name)).toEqual(["AI"]);
    expect(getClipProperty(clipIn(atChange, f.lid.id), "y")).toBeCloseTo(0, 6);
    // Half way through a linear 100 ms blend.
    const half = applyPoseMixes(f.doc, 10 * STEP + 50, f.frameId);
    const lid = clipIn(half, f.lid.id);
    expect(getClipProperty(lid, "y")).toBeCloseTo(50, 0);
    expect(lid.keyframes.some((k) => k.property === "y")).toBe(false);
    expect(String(getClipProperty(lid, `fill.${f.lid.fills[0]!.id}`)).toLowerCase()).toMatch(/^#(7f7f7f|808080)$/);
    // The input is never written into.
    expect(f.doc).toEqual(before);
  });

  it("a mixed pose leaves paths it does not name at their own value", () => {
    const f = face();
    const setId = mouthSet(f);
    addPose(f.doc, f.head, setId, { name: "Open", values: [{ clipId: f.mouth, path: "switch", value: "O" }] });
    setKeyframe(f.g().keyframes, `pose.${setId}`, 0, "AI");
    setKeyframe(f.g().keyframes, `pose.${setId}`, 10 * STEP, "Open");
    const half = applyPoseMixes(f.doc, 10 * STEP + 50, f.frameId);
    // AI's 100 easing toward the lid's own 0.
    expect(getClipProperty(clipIn(half, f.lid.id), "y")).toBeCloseTo(50, 0);
  });

  it("unknown name → vocabulary fallback → first pose; empty set and dangling values are harmless", () => {
    const f = face();
    const setId = mouthSet(f);
    f.g().poses![0]!.show = "U"; // U → O
    let out = applyPoseMixes(f.doc, 1000, f.frameId);
    expect(getClipProperty(clipIn(out, f.lid.id), "y")).toBe(50);
    f.g().poses![0]!.show = "qq"; // nothing → Rest
    out = applyPoseMixes(f.doc, 1000, f.frameId);
    expect(getClipProperty(clipIn(out, f.lid.id), "y")).toBe(0);
    // A value pointing at a deleted clip and a path nothing reads.
    f.g().poses![0]!.poses[0]!.values.push({ clipId: "gone", path: "x", value: 5 }, { clipId: f.lid.id, path: "nope.nothing", value: 1 });
    expect(() => applyPoseMixes(f.doc, 1000, f.frameId)).not.toThrow();
    createPoseSet(f.doc, f.head, { name: "Empty" });
    expect(() => applyPoseMixes(f.doc, 1000, f.frameId)).not.toThrow();
    expect(removePoseSet(f.doc, f.head, setId)).toBe(true);
  });

  it("an expression-driven name blends exactly like keys", () => {
    const f = face();
    const setId = mouthSet(f);
    const keyed = structuredClone(f.doc);
    const kg = clipIn(keyed, f.head) as GroupClip;
    setKeyframe(kg.keyframes, `pose.${setId}`, 0, "Rest");
    setKeyframe(kg.keyframes, `pose.${setId}`, 10 * STEP, "AI");
    const expr = addExpression(f.doc, `if(#frame >= 10, "AI", "Rest")`, "mouth");
    f.g().drivers = { [`pose.${setId}`]: fxToken(expr.id) };
    for (const t of [9 * STEP, 10 * STEP, 10 * STEP + 50, 12 * STEP, 20 * STEP]) {
      const a = getClipProperty(clipIn(applyPoseMixes(keyed, t, f.frameId), f.lid.id), "y");
      const b = getClipProperty(clipIn(resolvedDocAt(f.doc, t, f.frameId), f.lid.id), "y"); // the real bake: drivers → PoseMix
      expect(b).toBeCloseTo(a as number, 6);
    }
  });

  it("memoises only settled documents (measure 'before' on a clone)", () => {
    const f = face();
    const before = structuredClone(f.doc);
    expect(documentHasPoses(before)).toBe(false);
    const setId = mouthSet(f);
    expect(documentHasPoses(f.doc)).toBe(true); // an unsettled doc is recomputed after edits
    expect(poseOwnerOf(f.doc, f.lid.id, "y")).toEqual({ groupId: f.head, setId });
    settleDocument(before);
    expect(documentHasPoses(before)).toBe(false);
  });

  it("3D: a posed mesh stays posed through evaluateWorld's own key re-sampling", () => {
    const doc = createEmptyDocument();
    const { frame, clipIds } = createWorld(doc);
    const cube = clipIds[0]!;
    const head = groupClips(doc, [cube], "Head")!;
    const set = createPoseSet(doc, head, { name: "Turn", blend: { ms: 0 } })!;
    addPose(doc, head, set, { name: "Front", values: [{ clipId: cube, path: "rotation", value: 0 }] });
    addPose(doc, head, set, { name: "Side", values: [{ clipId: cube, path: "rotation", value: 90 }] });
    setKeyframe(clipIn(doc, cube).keyframes, "rotation", 0, 0);
    setKeyframe(clipIn(doc, cube).keyframes, "rotation", 900, 0);
    const reference = structuredClone(doc);
    clipIn(reference, cube).keyframes = [];
    (clipIn(reference, cube) as { transform: { rotation: number } }).transform.rotation = 90;
    keyPose(doc, head, set, "Side", 0, { key: true });
    const baked = applyPoseMixes(doc, 500, frame.id);
    const m = evaluateWorld(baked, frame, 500).objects.find((o) => o.id === cube)!.matrix;
    const r = evaluateWorld(reference, frame, 500).objects.find((o) => o.id === cube)!.matrix;
    expect([...m].map((v) => Math.round(v * 1000))).toEqual([...r].map((v) => Math.round(v * 1000)));
  });
});

describe("ops", () => {
  it("a set from a switch has one pose per member; bake to keys turns an expression into keys", () => {
    const f = face();
    const setId = poseSetFromSwitch(f.doc, f.head, f.mouth)!;
    const set = f.g().poses!.find((s) => s.id === setId)!;
    expect(set.poses.map((p) => p.name)).toEqual(["Rest", "AI", "O"]);
    expect(set.vocabulary).toBe("visemes");
    const expr = addExpression(f.doc, `if(#time >= 0.5, "O", "AI")`, "m");
    f.g().drivers = { [`pose.${setId}`]: fxToken(expr.id) };
    const n = bakePoseSet(f.doc, f.head, setId, { fromMs: 0, toMs: 1000 }, poseEnvAt(f.doc, 0, f.g().frameId));
    expect(n).toBe(2);
    expect(f.g().drivers?.[`pose.${setId}`]).toBeUndefined();
    const mix = poseSetMixAt(f.doc, f.g(), f.g().poses!.find((s) => s.id === setId)!, 800);
    expect(f.g().poses!.find((s) => s.id === setId)!.poses.find((p) => p.id === mix!.target)!.name).toBe("O");
  });

  it("mirror pose carries a side's value to the other side, reflected about its own rest", () => {
    const f = face();
    const setId = createPoseSet(f.doc, f.head, { name: "Wink" })!;
    const pose = addPose(f.doc, f.head, setId, { name: "Wink.L", values: [{ clipId: f.lidL.id, path: "x", value: -20 }, { clipId: f.lidL.id, path: "opacity", value: 0.2 }] })!;
    const id = mirrorPoseInSet(f.doc, f.head, setId, pose)!;
    const out = f.g().poses!.find((s) => s.id === setId)!.poses.find((p) => p.id === id)!;
    expect(out.name).toBe("Wink.R");
    expect(out.values).toEqual([
      { clipId: f.lidR.id, path: "x", value: 20 }, // Lid.L moved +10 from −30; Lid.R moves −10 from 30
      { clipId: f.lidR.id, path: "opacity", value: 0.2 },
    ]);
  });

  it("bones mirror through the rig's rule", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const rig = createRig(doc, frameId, { name: "Face", bones: [{ head: [0, 0], tail: [0, -100], name: "Head" }] })!;
    const g = locateClip(doc, rig)!.clip as GroupClip;
    // Two arms drawn mirrored.
    g.rig!.bones.push(
      { ...structuredClone(g.rig!.bones[0]!), id: "al", name: "Arm.L", parent: null, rest: { x: 10, y: 0, rotation: 30, length: 50 } },
      { ...structuredClone(g.rig!.bones[0]!), id: "ar", name: "Arm.R", parent: null, rest: { x: -10, y: 0, rotation: 150, length: 50 } },
    );
    const set = createPoseSet(doc, rig, { name: "Arms" })!;
    const p = addPose(doc, rig, set, { name: "Up.L", values: [{ clipId: rig, path: "bone.al.rotation", value: -40 }] })!;
    const id = mirrorPoseInSet(doc, rig, set, p)!;
    const out = g.poses!.find((s) => s.id === set)!.poses.find((x) => x.id === id)!;
    expect(out.values).toEqual([{ clipId: rig, path: "bone.ar.rotation", value: 40 }]);
  });
});

describe("poses verbs", () => {
  it("an agent makes a mouth set from a switch, keys a line and reads the blend back", async () => {
    const f = face();
    const store = createDocumentStore(f.doc);
    const api = createCommandApi();
    const ctx = { store, actor: "AI", session: { focusFrameId: () => f.frameId, playheadMs: () => 0, selection: () => [] } };
    const call = async (id: string, input: unknown) => {
      const r = await api.call(id, input, ctx);
      if (!r.ok) throw new Error(`${id}: ${r.error}`);
      return r.value as Record<string, unknown>;
    };
    const made = (await call("poses.create", { groupId: f.head, fromSwitch: f.mouth, blend: { ms: 0 } })) as { vocabulary: string };
    expect(made.vocabulary).toBe("visemes");
    await call("poses.key", { groupId: f.head, set: "Mouth", keys: [{ atMs: 0, pose: "Rest" }, { atMs: 500, pose: "AI" }] });
    const seen = (await call("poses.inspect", { groupId: f.head, atMs: 600 })) as { sets: Array<{ now: string; keyed: boolean }> };
    expect(seen.sets[0]).toMatchObject({ now: "AI", keyed: true });
    await expect(call("poses.key", { groupId: f.head, set: "Mouth", pose: "Nope" })).rejects.toThrow(/No pose/);

    // The timeline's view, for agents: blocks, then the block edits.
    const lanes = (await call("poses.inspect", { groupId: f.head, blocks: true })) as { sets: Array<{ mode: string; blocks: Array<{ pose: string; source: string; keyMs?: number; fromMs: number }> }> };
    expect(lanes.sets[0]!.mode).toBe("keyed");
    expect(lanes.sets[0]!.blocks.map((b) => [b.pose, b.keyMs])).toEqual([["Rest", 0], ["AI", 500]]);
    await call("poses.key", { groupId: f.head, set: "Mouth", move: { fromMs: 500, toMs: 800 } });
    await call("poses.key", { groupId: f.head, set: "Mouth", remove: 0 });
    const after = (await call("poses.inspect", { groupId: f.head, blocks: true })) as typeof lanes;
    expect(after.sets[0]!.blocks.map((b) => [b.pose, b.keyMs])).toEqual([["AI", 800]]);
    await expect(call("poses.key", { groupId: f.head, set: "Mouth", remove: 123 })).rejects.toThrow(/No pose key/);
  });
});
