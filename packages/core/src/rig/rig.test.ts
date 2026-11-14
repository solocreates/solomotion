import { describe, expect, it } from "vitest";
import type { MotionDocument, GroupClip, ShapeClip } from "../schema";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { clipBox, locateClip } from "../timeline/ops";
import { groupBoxAt } from "../timeline/group-bounds";
import { groupChainMatrix } from "../timeline/group-space";
import { pruneGroups } from "../timeline/groups";
import { apply } from "../navigation/matrix";
import { addBone, bonesInRig, createRig, editBone, poseBones, removeBones, setBind, setBoneProps } from "./ops";
import { bakeRig, evaluateRig, rigPoseAt } from "./pose";
import { decide2d, memberOf } from "./bind";

/** A flat comp with rectangles placed in frame-centre px. */
function comp() {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const rect = (name: string, x: number, y: number, width: number, height: number): ShapeClip => {
    const c = createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 4000, x, y, width, height }) as ShapeClip;
    c.name = name;
    const lane = createTrack(name);
    lane.clips.push(c);
    doc.tracks.push(lane);
    return c;
  };
  return { doc, frameId, rect };
}

/** An arm along +x: shoulder (−100, 0) → elbow (0, 0) → wrist (100, 0). */
function arm() {
  const { doc, frameId, rect } = comp();
  const upper = rect("upper", -50, 0, 110, 30); // overlaps the elbow by 5 px
  const fore = rect("fore", 50, 0, 100, 26);
  const sleeve = rect("sleeve", 0, 0, 200, 20); // one piece the length of the arm
  const hat = rect("hat", -100, -120, 40, 20); // near no bone at all
  const id = createRig(doc, frameId, {
    memberIds: [upper.id, fore.id, sleeve.id, hat.id],
    bones: [
      { head: [-100, 0], tail: [0, 0], name: "Upper" },
      { head: [0, 0], tail: [100, 0], name: "Fore" },
    ],
  })!;
  const group = () => locateClip(doc, id)!.clip as GroupClip;
  const bone = (name: string) => group().rig!.bones.find((b) => b.name === name)!;
  return { doc, id, group, bone, upper, fore, sleeve, hat };
}

const decided = (doc: MotionDocument, gid: string, clipId: string) => {
  const g = locateClip(doc, gid)!.clip as GroupClip;
  return decide2d(doc, memberOf(doc, clipId)!, evaluateRig(g.rig!, { planar: true }));
};

describe("a rig in a flat comp", () => {
  it("keeps bones drawn in rig space, chained parent to child", () => {
    const { group, bone } = arm();
    const r = group().rig!;
    expect(bone("Fore").parent).toBe(bone("Upper").id);
    // The child is joined at its parent's tip: x = parent length in the parent's frame.
    expect(bone("Fore").rest.x).toBeCloseTo(100, 6);
    const at = bonesInRig(r, true).get(bone("Fore").id)!;
    expect(at.head[0]).toBeCloseTo(0, 6);
    expect(at.tail[0]).toBeCloseTo(100, 6);
  });

  it("binds a cut-out to the bone it is made of, and a long piece to bend", () => {
    const { doc, id, bone, upper, fore, sleeve, hat } = arm();
    expect(decided(doc, id, upper.id)).toEqual({ kind: "rigid", bone: bone("Upper").id });
    expect(decided(doc, id, fore.id)).toEqual({ kind: "rigid", bone: bone("Fore").id });
    expect(decided(doc, id, sleeve.id).kind).toBe("smooth");
    // Nothing runs through the hat: it rides the nearest bone.
    expect(decided(doc, id, hat.id)).toEqual({ kind: "rigid", bone: bone("Upper").id });
  });

  it("an explicit binding wins over the art", () => {
    const { doc, id, bone, sleeve, upper } = arm();
    setBind(doc, sleeve.id, { mode: "rigid", bone: bone("Fore").id });
    expect(decided(doc, id, sleeve.id)).toEqual({ kind: "rigid", bone: bone("Fore").id });
    setBind(doc, upper.id, { mode: "none" });
    expect(decided(doc, id, upper.id).kind).toBe("none");
    // Back to defaults leaves nothing stored.
    setBind(doc, sleeve.id, { mode: "auto", bone: null });
    expect((locateClip(doc, sleeve.id)!.clip as ShapeClip).bind).toBeUndefined();
  });

  it("a piece riding a bone is PLACED by it — the one matrix every control reads", () => {
    const { doc, id, bone, fore, upper } = arm();
    poseBones(doc, id, [{ bone: bone("Fore").id, values: { rotation: 90 } }], 0);
    const at = (clipId: string, p: { x: number; y: number }) => apply(groupChainMatrix(doc, clipId, () => 0), p);
    // The forearm turns about the elbow: its middle (50, 0) swings down to (0, 50).
    const mid = at(fore.id, { x: 50, y: 0 });
    expect(mid.x).toBeCloseTo(0, 6);
    expect(mid.y).toBeCloseTo(50, 6);
    // The upper arm did not move.
    const still = at(upper.id, { x: -50, y: 0 });
    expect(still.x).toBeCloseTo(-50, 9);
    expect(still.y).toBeCloseTo(0, 9);
  });

  it("dragging a joint re-aims both bones and keeps the wrist where it was", () => {
    const { doc, id, group, bone } = arm();
    editBone(doc, id, bone("Upper").id, { tail: [0, -40, 0] }, { children: "stay" });
    const at = bonesInRig(group().rig!, true);
    expect(at.get(bone("Upper").id)!.tail[1]).toBeCloseTo(-40, 4);
    expect(at.get(bone("Fore").id)!.head[1]).toBeCloseTo(-40, 4);
    expect(at.get(bone("Fore").id)!.tail[0]).toBeCloseTo(100, 4);
    expect(at.get(bone("Fore").id)!.tail[1]).toBeCloseTo(0, 4);
    // `follow` swings what hangs off it along.
    editBone(doc, id, bone("Upper").id, { tail: [0, 0, 0] }, { children: "follow" });
    const again = bonesInRig(group().rig!, true);
    expect(again.get(bone("Fore").id)!.head[1]).toBeCloseTo(0, 4);
  });

  it("removing a bone keeps its children in place and lets go of everything that named it", () => {
    const { doc, id, group, bone, sleeve } = arm();
    const hand = addBone(doc, id, { head: [100, 0], tail: [130, 0], parent: bone("Fore").id, name: "Hand" })!;
    setBoneProps(doc, id, hand, { ik: { target: bone("Upper").id } });
    poseBones(doc, id, [{ bone: bone("Fore").id, values: { rotation: 20 } }], 0, { key: true });
    setBind(doc, sleeve.id, { mode: "rigid", bone: bone("Fore").id });
    const foreId = bone("Fore").id;
    const before = bonesInRig(group().rig!, true).get(hand)!;
    removeBones(doc, id, [foreId]);
    const g = group();
    expect(g.rig!.bones.find((b) => b.id === hand)!.parent).toBe(bone("Upper").id);
    const after = bonesInRig(g.rig!, true).get(hand)!;
    expect(after.head[0]).toBeCloseTo(before.head[0], 6);
    expect(after.tail[0]).toBeCloseTo(before.tail[0], 6);
    expect(g.keyframes.some((t) => t.property.startsWith(`bone.${foreId}.`))).toBe(false);
    expect((locateClip(doc, sleeve.id)!.clip as ShapeClip).bind?.bone ?? null).toBeNull();
  });

  it("limits hold a control inside its range whatever moves it — a key past the end, a drag, a typed value", () => {
    const { doc, id, group, bone } = arm();
    // A slider: free along X from 0 to 40, locked across.
    const knob = addBone(doc, id, { head: [0, -80], tail: [10, -80], name: "Knob", parent: null, deform: false })!;
    setBoneProps(doc, id, knob, { shape: "circle", limits: { x: [40, 0], y: [0, 0] } });
    expect(group().rig!.bones.find((b) => b.id === knob)!.limits).toEqual({ x: [0, 40], y: [0, 0] }); // ends put in order
    // Written past the end: stored at the end, so the key says what the bone does.
    poseBones(doc, id, [{ bone: knob, values: { x: 75, y: 12 } }], 0);
    const stored = group().rig!.bones.find((b) => b.id === knob)!.pose!;
    expect([stored.x, stored.y]).toEqual([40, 0]);
    // A key from elsewhere (an old file, a driver) past the end is held by the evaluator.
    const raw = structuredClone(group());
    raw.rig!.bones.find((b) => b.id === knob)!.pose = { ...stored, x: -30 };
    expect(rigPoseAt(raw, 0, true)!.byId.get(knob)!.head[0]).toBeCloseTo(0, 9);
    // A rotation limit keeps a joint from folding the wrong way.
    setBoneProps(doc, id, bone("Fore").id, { limits: { rotation: [0, 150] } });
    poseBones(doc, id, [{ bone: bone("Fore").id, values: { rotation: -45 } }], 0);
    expect(group().rig!.bones.find((b) => b.name === "Fore")!.pose!.rotation).toBe(0);
    // Freed again.
    setBoneProps(doc, id, knob, { limits: null });
    expect(group().rig!.bones.find((b) => b.id === knob)!.limits).toBeNull();
  });

  it("refuses a parent that would make a loop", () => {
    const { doc, id, bone } = arm();
    setBoneProps(doc, id, bone("Upper").id, { parent: bone("Fore").id });
    expect(bone("Upper").parent).toBeNull();
  });

  it("a rig with bones and no art yet is a skeleton, not an empty group", () => {
    const { doc, frameId } = comp();
    const id = createRig(doc, frameId, { bones: [{ head: [0, 0], tail: [0, 100] }] })!;
    pruneGroups(doc);
    expect(locateClip(doc, id)).not.toBeNull();
  });

  it("the rig's live box is the posed art — riding pieces on their bones, bending ones bent — while its pivot box stays put", () => {
    const { doc, id, group, bone } = arm();
    const edges = (b: { width: number; height: number; cx: number; cy: number }) => ({ minX: b.cx - b.width / 2, maxX: b.cx + b.width / 2, minY: b.cy - b.height / 2, maxY: b.cy + b.height / 2 });
    // (A copy: the app writes immutably and the pose is memoised by identity; this test edits in place.)
    const still = structuredClone(doc);
    const rest = edges(groupBoxAt(still, locateClip(still, id)!.clip as GroupClip, 0));
    expect(rest.maxX).toBeCloseTo(100, 3);
    expect(rest.maxY).toBeCloseTo(15, 3);
    const authored = clipBox(doc, group());
    // Swing the forearm straight down: the forearm and the sleeve's far half go with it.
    poseBones(doc, id, [{ bone: bone("Fore").id, values: { rotation: 90 } }], 0);
    const posed = edges(groupBoxAt(doc, group(), 0));
    expect(posed.maxY).toBeGreaterThan(98);
    expect(posed.maxY).toBeLessThan(104);
    expect(posed.maxX).toBeLessThan(20); // nothing reaches x = 100 any more
    expect(posed.minX).toBeCloseTo(rest.minX, 3); // the hat rides the still upper arm
    // What the pivot is a fraction of does not follow the pose (or the group would drift as it turns).
    expect(clipBox(doc, group())).toEqual(authored);
  });

  it("keys a pose where asked, and the rig reads the key at its own time", () => {
    const { doc, id, group, bone } = arm();
    poseBones(doc, id, [{ bone: bone("Upper").id, values: { rotation: 0 } }], 0, { key: true });
    poseBones(doc, id, [{ bone: bone("Upper").id, values: { rotation: 90 } }], 1000, { key: true });
    const p = rigPoseAt(group(), 500, true)!;
    const tail = p.byId.get(bone("Upper").id)!.tail;
    expect(tail[0]).toBeCloseTo(-100 + Math.cos(Math.PI / 4) * 100, 6);
    expect(tail[1]).toBeCloseTo(Math.sin(Math.PI / 4) * 100, 6);
    // Unkeyed bones stay at rest, and the stored rig is never written by sampling.
    expect(bakeRig(group(), 500)!.bones.find((b) => b.name === "Fore")!.pose).toBeUndefined();
    expect(group().rig!.bones.find((b) => b.name === "Upper")!.pose?.rotation ?? 0).toBe(0);
  });
});

describe("a bone drawn from one piece to another", () => {
  /** Two shapes and one bone from the first's centre to the second's — the clock. */
  function clock() {
    const { doc, frameId, rect } = comp();
    const face = rect("face", -300, 0, 160, 160);
    const hand = rect("hand", 100, 0, 120, 120);
    const id = createRig(doc, frameId, { memberIds: [face.id, hand.id], bones: [{ head: [-300, 0], tail: [100, 0], name: "Hand" }] })!;
    return { doc, id, face, hand };
  }

  it("the piece it reaches rides it; the piece it starts in is what it hangs from", () => {
    const { doc, id, face, hand } = clock();
    expect(decided(doc, id, hand.id)).toMatchObject({ kind: "rigid" });
    expect(decided(doc, id, face.id)).toEqual({ kind: "none" });
  });

  it("turning the bone swings the far piece about the joint and leaves the near one where it is", () => {
    const { doc, id, face, hand } = clock();
    const g = locateClip(doc, id)!.clip as GroupClip;
    poseBones(doc, id, [{ bone: g.rig!.bones[0]!.id, values: { rotation: 90 } }], 0);
    const at = (c: ShapeClip) => apply(groupChainMatrix(doc, c.id, () => 0), { x: c.transform.x, y: c.transform.y });
    // A quarter turn clockwise on screen about (−300, 0): the hand goes 400 below the joint.
    expect(at(hand).x).toBeCloseTo(-300, 3);
    expect(at(hand).y).toBeCloseTo(400, 3);
    expect(at(face).x).toBeCloseTo(-300, 6);
    expect(at(face).y).toBeCloseTo(0, 6);
  });

  it("a chain: the middle piece rides the bone that reaches it, not the one that leaves it", () => {
    const { doc, frameId, rect } = comp();
    const a = rect("a", -300, 0, 100, 100), b = rect("b", 0, 0, 100, 100), c = rect("c", 300, 0, 100, 100);
    const id = createRig(doc, frameId, {
      memberIds: [a.id, b.id, c.id],
      bones: [
        { head: [-300, 0], tail: [0, 0], name: "One" },
        { head: [0, 0], tail: [300, 0], name: "Two" },
      ],
    })!;
    const g = locateClip(doc, id)!.clip as GroupClip;
    const [one, two] = g.rig!.bones;
    expect(decided(doc, id, a.id)).toEqual({ kind: "none" });
    expect(decided(doc, id, b.id)).toEqual({ kind: "rigid", bone: one!.id });
    expect(decided(doc, id, c.id)).toEqual({ kind: "rigid", bone: two!.id });
  });
});
