import { describe, expect, it } from "vitest";
import type { GroupClip, ShapeClip } from "../schema";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { locateClip } from "../timeline/ops";
import { createRig, poseBones } from "../rig/ops";
import { addPose, addPoseFromLayer, createPoseSet } from "../rig/pose-ops";
import { choosePose } from "../rig/pose-choice";
import { poseEnvAt } from "./resolved-doc";
import { poseMatchAt, resetToPose } from "./pose-match";

const instant = { ms: 0, ease: { kind: "linear" as const } };

function arm() {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const rigId = createRig(doc, frameId, { name: "Pip", bones: [{ head: [0, 0], tail: [0, -100], name: "Arm" }] })!;
  const g = () => locateClip(doc, rigId)!.clip as GroupClip;
  const bone = g().rig!.bones[0]!.id;
  const path = `bone.${bone}.rotation`;
  const setId = createPoseSet(doc, rigId, { name: "Hand", blend: instant })!;
  const rest = addPose(doc, rigId, setId, { name: "Rest", values: [{ clipId: rigId, path, value: 0 }] })!;
  const wave = addPose(doc, rigId, setId, { name: "Wave", values: [{ clipId: rigId, path, value: 60 }] })!;
  const set = () => g().poses!.find((s) => s.id === setId)!;
  const match = (t = 500) => poseMatchAt(structuredClone(doc), g(), set(), t, poseEnvAt(doc, t, frameId));
  return { doc, frameId, rigId, g, bone, path, setId, rest, wave, set, match };
}

describe("which pose is showing — computed from what shows", () => {
  it("a picked pose shows; a hand tweak on top reads as modified; Reset takes it off", () => {
    const a = arm();
    choosePose(a.doc, a.g(), a.set(), "Wave", 0);
    expect(a.match()).toMatchObject({ chosen: a.wave, showing: [a.wave], modified: false });
    poseBones(a.doc, a.rigId, [{ bone: a.bone, values: { rotation: 12 } }], 0);
    expect(a.match()).toMatchObject({ chosen: a.wave, showing: [], modified: true });
    expect(resetToPose(a.doc, a.g(), a.set(), 500)).toBe(1);
    expect(a.match()).toMatchObject({ showing: [a.wave], modified: false });
  });

  it("a pose captured from now shows at once — no bookkeeping", () => {
    const a = arm();
    poseBones(a.doc, a.rigId, [{ bone: a.bone, values: { rotation: 30 } }], 0);
    expect(a.match().modified).toBe(true);
    const half = addPose(a.doc, a.rigId, a.setId, { name: "Half wave", capture: { atMs: 500 }, env: poseEnvAt(a.doc, 500, a.frameId) })!;
    choosePose(a.doc, a.g(), a.set(), half, 0);
    expect(a.match()).toMatchObject({ chosen: half, showing: [half], modified: false });
  });
});

describe("a pose from any layer", () => {
  it("shows that layer in the new pose only, in place of the part's other looks", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const rigId = createRig(doc, frameId, { name: "Pip", bones: [{ head: [0, 0], tail: [0, -100], name: "Root" }] })!;
    const add = (name: string) => {
      const c = createShapeClip({ frameId, shape: "ellipse", startMs: 0, durationMs: 5000, x: 0, y: 0, width: 40, height: 20 }) as ShapeClip;
      c.name = name;
      const t = createTrack(name);
      t.groupId = rigId;
      t.clips.push(c);
      doc.tracks.push(t);
      return c.id;
    };
    const eye = add("Eye");
    const heart = add("Heart eye");
    const setId = createPoseSet(doc, rigId, { name: "Eyes", blend: instant })!;
    addPose(doc, rigId, setId, { name: "Open", values: [{ clipId: eye, path: "scaleY", value: 1 }] });
    addPose(doc, rigId, setId, { name: "Closed", values: [{ clipId: eye, path: "scaleY", value: 0.1 }] });
    const poseId = addPoseFromLayer(doc, rigId, setId, heart)!;
    const set = (locateClip(doc, rigId)!.clip as GroupClip).poses![0]!;
    const pose = set.poses.find((p) => p.id === poseId)!;
    expect(pose.name).toBe("Heart eye");
    expect(pose.values).toEqual(expect.arrayContaining([{ clipId: heart, path: "opacity", value: 1 }, { clipId: eye, path: "opacity", value: 0 }]));
    for (const p of set.poses.filter((x) => x.id !== poseId)) expect(p.values).toEqual(expect.arrayContaining([{ clipId: heart, path: "opacity", value: 0 }, { clipId: eye, path: "opacity", value: 1 }]));
  });
});
