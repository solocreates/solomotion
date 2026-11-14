import { describe, expect, it } from "vitest";
import type { GroupClip, ShapeClip } from "../schema";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { locateClip } from "../timeline/ops";
import { makeSwitch } from "../timeline/switch-ops";
import { getClipProperty } from "../animation/paths";
import { channelValueAt } from "../animation/channels";
import { addExpression } from "../expressions/document";
import { fxToken } from "../schema/expressions";
import { clipLookup } from "../timeline/frame-index";
import { createRig, poseBones } from "./ops";
import { posedPathsAt, poseComposeOf, poseOwnerOf } from "./poses";
import { addPose, beneathPoses, createPoseSet, updatePose } from "./pose-ops";
import { choosePose } from "./pose-choice";
import { parseDocument, serializeDocument } from "../io";
import { poseEnvAt, resolvedDocAt } from "../evaluate/resolved-doc";

const instant = { ms: 0, ease: { kind: "linear" as const } };

/** A rig with an arm, a Hand set (Rest / Wave turn the arm), 30 fps. */
function arm() {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  doc.frames[0]!.fps = 30;
  const rigId = createRig(doc, frameId, { name: "Pip", bones: [{ head: [0, 0], tail: [0, -100], name: "Arm" }] })!;
  const g = () => locateClip(doc, rigId)!.clip as GroupClip;
  const bone = g().rig!.bones[0]!.id;
  const path = `bone.${bone}.rotation`;
  const setId = createPoseSet(doc, rigId, { name: "Hand", blend: instant })!;
  const rest = addPose(doc, rigId, setId, { name: "Rest", values: [{ clipId: rigId, path, value: 0 }] })!;
  const wave = addPose(doc, rigId, setId, { name: "Wave", values: [{ clipId: rigId, path, value: 60 }] })!;
  // A fresh copy per read: the bake memoises on the document object, and these tests edit one in place.
  const shown = (atMs = 500) => getClipProperty(clipLookup(resolvedDocAt(structuredClone(doc), atMs, frameId))(rigId)!, path) as number;
  const own = (atMs = 500) => channelValueAt(g(), path, atMs) as number;
  return { doc, frameId, rigId, g, bone, path, setId, rest, wave, shown, own };
}

describe("poses are layers on what you posed by hand", () => {
  it("bone channels and shape keys layer; switches and colours stay the pose's", () => {
    expect(poseComposeOf("bone.b1.rotation")).toBe("add");
    expect(poseComposeOf("bone.b1.scale")).toBe("scale");
    expect(poseComposeOf("bone.b1.ik")).toBe("own");
    expect(poseComposeOf("key.k1")).toBe("add");
    expect(poseComposeOf("switch")).toBe("own");
    expect(poseComposeOf("x")).toBe("own");
  });

  it("your turn survives choosing a pose, and a pose changes only its own share", () => {
    const a = arm();
    poseBones(a.doc, a.rigId, [{ bone: a.bone, values: { rotation: 10 } }], 0);
    expect(a.shown()).toBe(10); // Rest adds nothing
    choosePose(a.doc, a.g(), a.g().poses![0]!, "Wave", 0);
    expect(a.shown()).toBe(70); // Wave 60 + your 10 — it used to be 60, your turn erased
    choosePose(a.doc, a.g(), a.g().poses![0]!, "Rest", 0);
    expect(a.shown()).toBe(10);
    // A layered path is nobody's: it stays yours to key, drag and perform.
    expect(poseOwnerOf(a.doc, a.rigId, a.path)).toBeNull();
  });

  it("a drag over a posed bone shows exactly where the hand put it", () => {
    const a = arm();
    choosePose(a.doc, a.g(), a.g().poses![0]!, "Wave", 0);
    const posed = posedPathsAt(a.doc, 500, a.frameId, poseEnvAt(a.doc, 500, a.frameId));
    // The drag measured 75° on screen; your layer gets what that takes under the wave.
    poseBones(a.doc, a.rigId, beneathPoses(posed, a.rigId, [{ bone: a.bone, values: { rotation: 75 } }]), 500);
    expect(a.own()).toBe(15);
    expect(a.shown()).toBe(75);
  });

  it("capturing a pose keeps the picture and moves your still tweak into the pose", () => {
    const a = arm();
    choosePose(a.doc, a.g(), a.g().poses![0]!, "Wave", 0);
    poseBones(a.doc, a.rigId, [{ bone: a.bone, values: { rotation: 12 } }], 0);
    expect(a.shown()).toBe(72);
    const id = addPose(a.doc, a.rigId, a.setId, { name: "Big wave", capture: { atMs: 500 } })!;
    expect(a.shown()).toBe(72); // nothing on screen moved
    expect(a.own()).toBe(0); // the tweak now lives in the pose
    expect(a.g().poses![0]!.poses.find((p) => p.id === id)!.values).toEqual([{ clipId: a.rigId, path: a.path, value: 72 }]);
    // Choosing Wave again is plain Wave — the tweak went with the new pose.
    choosePose(a.doc, a.g(), a.g().poses![0]!, "Wave", 0);
    expect(a.shown()).toBe(60);
  });

  it("an animated tweak stays yours when you update a pose from what you see", () => {
    const a = arm();
    choosePose(a.doc, a.g(), a.g().poses![0]!, "Wave", 0);
    poseBones(a.doc, a.rigId, [{ bone: a.bone, values: { rotation: 5 } }], 0, { key: true });
    poseBones(a.doc, a.rigId, [{ bone: a.bone, values: { rotation: 25 } }], 1000, { key: true });
    const before = a.shown(500);
    updatePose(a.doc, a.rigId, a.setId, a.wave, { capture: { atMs: 500 } });
    expect(a.shown(500)).toBeCloseTo(before, 6);
    expect(a.own(1000)).toBe(25); // your keys are untouched
  });
});

describe("#value — an expression that rides on the field's own value", () => {
  /** Two eye drawings in a switch, an Eyes set (Open / Closed / Angry) blinking every 4 s. */
  function eyes() {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    doc.frames[0]!.fps = 30;
    const draw = (name: string) => {
      const c = createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 20000, x: 0, y: 0, width: 40, height: 20 }) as ShapeClip;
      c.name = name;
      const lane = createTrack(name);
      lane.clips.push(c);
      doc.tracks.push(lane);
      return c.id;
    };
    const sw = makeSwitch(doc, [draw("Open"), draw("Closed"), draw("Angry")], { name: "Eye" })!;
    const rigId = createRig(doc, frameId, { name: "Pip", memberIds: [sw], bones: [{ head: [0, 0], tail: [0, -100], name: "Head" }] })!;
    const g = () => locateClip(doc, rigId)!.clip as GroupClip;
    const setId = createPoseSet(doc, rigId, { name: "Eyes", blend: instant, poses: ["Open", "Closed", "Angry"].map((n) => ({ name: n, values: [{ clipId: sw, path: "switch", value: n }] })) })!;
    const blink = addExpression(doc, 'if(blink(4) > 0, "Closed", #value)', "blink");
    g().drivers = { [`pose.${setId}`]: fxToken(blink.id) };
    const showsAt = (ms: number) => getClipProperty(clipLookup(resolvedDocAt(structuredClone(doc), ms, frameId))(sw)!, "switch");
    return { doc, g, setId, sw, showsAt };
  }

  it("an older project's fixed-open blink becomes a Blink behavior: open between blinks, shut in them", () => {
    const e = eyes();
    const set = e.g().poses!.find((s) => s.id === e.setId)!;
    e.doc.expressions[0]!.source = 'if(blink(4) > 0, "Closed", "Open")';
    set.show = "Angry"; // hidden by the old binding: it always showed Open
    const samples = Array.from({ length: 600 }, (_, i) => i * (1000 / 30));
    const migrated = parseDocument(serializeDocument({ ...e.doc, version: 95 }));
    const g = clipLookup(migrated)(e.g().id) as GroupClip;
    // v96 made it ride on the eyes' own choice (base: the old open name); v97 made it a behavior.
    expect(g.drivers ?? {}).toEqual({});
    expect(migrated.expressions).toEqual([]);
    expect(g.behaviors).toEqual([expect.objectContaining({ type: "blink", set: e.setId, closed: "Closed", every: 4 })]);
    expect(g.poses!.find((s) => s.id === e.setId)!.show).toBe("Open");
    const after = samples.map((t) => getClipProperty(clipLookup(resolvedDocAt(migrated, t, e.doc.frames[0]!.id))(e.sw)!, "switch"));
    expect(new Set(after)).toEqual(new Set(["Open", "Closed"]));
    expect(after.filter((v) => v === "Open").length).toBeGreaterThan(560);
  });

  it("a picked pose shows between blinks, and still blinks", () => {
    const e = eyes();
    const set = e.g().poses!.find((s) => s.id === e.setId)!;
    // The click keys the eyes' own choice instead of being refused as "live".
    expect(choosePose(e.doc, e.g(), set, "Angry", 0)).toEqual({ kind: "keyed" });
    const samples = Array.from({ length: 600 }, (_, i) => i * (1000 / 30));
    const shown = new Set(samples.map((t) => e.showsAt(t)));
    expect(shown).toEqual(new Set(["Angry", "Closed"]));
    expect(samples.filter((t) => e.showsAt(t) === "Angry").length).toBeGreaterThan(500);
  });
});
