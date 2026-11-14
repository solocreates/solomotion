import { describe, expect, it } from "vitest";
import type { GroupClip, ShapeClip } from "../schema";
import { createAssetAudioClip, createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { locateClip } from "../timeline/ops";
import { createRig } from "../rig/ops";
import { addPose, createPoseSet } from "../rig/pose-ops";
import { addBehavior } from "../behaviors/ops";
import { lipSyncPoseFor } from "../behaviors/evaluate";
import { docIndex, searchDocNodes } from "./doc-index";

function project() {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const rigId = createRig(doc, frameId, { name: "Pip", bones: [{ head: [0, 0], tail: [0, -100], name: "Torso" }] })!;
  const inner = createTrack("Mouth");
  inner.groupId = rigId;
  const mouth = createShapeClip({ frameId, shape: "ellipse", startMs: 0, durationMs: 4000, x: 0, y: 0, width: 40, height: 20 }) as ShapeClip;
  mouth.name = "Mouth";
  inner.clips.push(mouth);
  const voices = createTrack("Voices");
  const hello = createAssetAudioClip({ frameId, assetId: "a1", startMs: 1000, durationMs: 2000 });
  hello.name = "Hello line";
  const later = createAssetAudioClip({ frameId, assetId: "a2", startMs: 5000, durationMs: 1000 });
  later.name = "Goodbye";
  voices.clips.push(hello, later);
  doc.tracks.push(inner, voices);
  return { doc, frameId, rigId, mouth, hello, later };
}

describe("the document index", () => {
  it("is derived once per snapshot", () => {
    const p = project();
    expect(docIndex(p.doc)).toBe(docIndex(p.doc));
  });

  it("ranks a name prefix over a scattered match, and drops non-matches", () => {
    const layers = docIndex(project().doc).filter((n) => n.kind === "layer");
    expect(searchDocNodes(layers, "good")[0]!.name).toBe("Goodbye");
    expect(searchDocNodes(layers, "hl").map((n) => n.name)).toContain("Hello line");
    expect(searchDocNodes(layers, "zzz")).toEqual([]);
  });
});

describe("behaviors the cards build on", () => {
  it("Lip sync's mouth map: a person's choice wins, rest is 'In pauses', the rest resolves by name", () => {
    const p = project();
    const b = addBehavior(p.doc, p.rigId, "lipSync")!;
    expect(lipSyncPoseFor(b, "MBP")).toBe("MBP");
    b["as.MBP"] = "Closed";
    expect(lipSyncPoseFor(b, "MBP")).toBe("Closed");
    expect(lipSyncPoseFor(b, "X")).toBe("X");
    b.rest = "Smile";
    expect(lipSyncPoseFor(b, "X")).toBe("Smile");
  });

  it("a State machine is born running something: a free machine of the comp, else a state per pose", () => {
    const p = project();
    const set = createPoseSet(p.doc, p.rigId, { name: "Mood" })!;
    for (const name of ["Calm", "Happy", "Angry"]) addPose(p.doc, p.rigId, set, { name, values: [{ clipId: p.mouth.id, path: "opacity", value: 1 }] });
    const b = addBehavior(p.doc, p.rigId, "machine", { set })!;
    const frame = p.doc.frames.find((f) => f.id === p.frameId)!;
    const m = frame.machines!.find((x) => x.id === b.machine)!;
    expect(m.layers[0]!.states.map((s) => s.name)).toEqual(["Calm", "Happy", "Angry"]);
    expect(m.layers[0]!.states[1]!.output).toEqual({ kind: "pose", set, pose: "Happy" });
    // A second one does not steal the first's machine.
    const again = addBehavior(p.doc, p.rigId, "machine", { set })!;
    expect(again.machine).not.toBe(b.machine);
    expect((locateClip(p.doc, p.rigId)!.clip as GroupClip).behaviors!.length).toBe(2);
  });
});
