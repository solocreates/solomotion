import { describe, expect, it } from "vitest";
import type { Bone, BoneConstraint, GroupClip, Rig } from "../schema";
import { boneConstraintSchema, boneSchema, rigSchema } from "../schema/rig";
import { createEmptyDocument, createGroupClip, createShapeClip } from "../factories";
import { placeClip } from "../timeline/place";
import { locateClip } from "../timeline/ops";
import { moveIntoWorld } from "../world/flat3d";
import { mul4 } from "../world/math";
import { bakeRig, evaluateRig, letGoForBodies, rigPoseAt } from "./pose";
import { createRig, poseBones, setBoneProps } from "./ops";

const bone = (b: Partial<Bone> & { id: string }): Bone => boneSchema.parse(b);
const rig = (bones: Bone[]): Rig => rigSchema.parse({ bones });
const con = (c: Record<string, unknown>): BoneConstraint => boneConstraintSchema.parse({ id: "c1", ...c });
const finite = (r: Rig, planar = true) => evaluateRig(r, { planar }).bones.every((s) => [...s.head, ...s.tail, ...s.skin].every(Number.isFinite));

/** A face: a pupil pad (±20 each way) in an eye, and a ball to look at. */
function eye(c: Partial<BoneConstraint> & Record<string, unknown>, ball: [number, number], extra: Partial<Bone> = {}) {
  return rig([
    bone({ id: "pupil", deform: false, rest: { x: 0, y: 0, rotation: 0, length: 10 }, limits: { x: [-20, 20], y: [-20, 20] }, constraints: [con({ type: "look", target: { kind: "bone", bone: "ball" }, ...c })], ...extra }),
    bone({ id: "ball", deform: false, rest: { x: ball[0], y: ball[1], rotation: 0, length: 10 } }),
  ]);
}
const pupilAt = (r: Rig) => evaluateRig(r, { planar: true }).byId.get("pupil")!.head;

describe("look — a pupil follows a target inside its pad", () => {
  it("slides to the pad's edge toward a far target, round not square", () => {
    const right = pupilAt(eye({}, [300, 0]));
    expect(right[0]).toBeCloseTo(20, 6);
    expect(right[1]).toBeCloseTo(0, 6);
    // Diagonal: on the ellipse the pad draws, not in the box's corner.
    const diag = pupilAt(eye({}, [300, 300]));
    expect(Math.hypot(diag[0], diag[1])).toBeCloseTo(20, 6);
    expect(diag[0]).toBeCloseTo(diag[1], 6);
  });

  it("sits on a near target, and a radius holds it closer", () => {
    const near = pupilAt(eye({}, [6, -4]));
    expect(near[0]).toBeCloseTo(6, 6);
    expect(near[1]).toBeCloseTo(-4, 6);
    expect(pupilAt(eye({ radius: 5 }, [300, 0]))[0]).toBeCloseTo(5, 6);
  });

  it("a target exactly on the head is no move — never NaN", () => {
    const r = eye({}, [0, 0]);
    expect(pupilAt(r)).toEqual([0, 0, 0]);
    expect(finite(r)).toBe(true);
    expect(finite(eye({ radius: 0 }, [0, 0]))).toBe(true);
  });

  it("influence blends from the keyed place, and keys on bone.<id>.con.<cid>", () => {
    expect(pupilAt(eye({ influence: 0.5 }, [300, 0]))[0]).toBeCloseTo(10, 6);
    const g: GroupClip = { ...createGroupClip({ frameId: "f", startMs: 0, durationMs: 2000 }), rig: eye({}, [300, 0]) };
    g.keyframes = [
      { id: "k", property: "bone.pupil.con.c1", range: null, keys: [{ id: "a", timeMs: 0, value: 0, easing: { kind: "linear" } }, { id: "b", timeMs: 1000, value: 1, easing: { kind: "linear" } }] },
    ] as GroupClip["keyframes"];
    expect(evaluateRig(bakeRig(g, 0)!, { planar: true }).byId.get("pupil")!.head[0]).toBeCloseTo(0, 6);
    expect(evaluateRig(bakeRig(g, 250)!, { planar: true }).byId.get("pupil")!.head[0]).toBeCloseTo(5, 6);
  });

  it("a locked axis stays put: a slider only slides", () => {
    const r = eye({}, [300, 300], { limits: { x: [-20, 20], y: [0, 0] } });
    const at = pupilAt(r);
    expect(at[1]).toBeCloseTo(0, 9);
    expect(at[0]).toBeCloseTo(20, 6);
  });

  it("ignores a target hanging off itself (it would chase itself)", () => {
    const r = rig([
      bone({ id: "pupil", rest: { x: 0, y: 0, rotation: 0, length: 10 }, constraints: [con({ type: "look", target: { kind: "bone", bone: "kid" } })] }),
      bone({ id: "kid", parent: "pupil", rest: { x: 50, y: 0, rotation: 0, length: 10 } }),
    ]);
    expect(pupilAt(r)).toEqual([0, 0, 0]);
  });
});

/** A head standing up from the neck (rest pointing up the screen), its eye hanging off it. */
function head(c: Record<string, unknown>, extra: Partial<Bone> = {}) {
  return rig([
    bone({ id: "head", rest: { x: 0, y: 0, rotation: -90, length: 100 }, constraints: [con({ type: "track", ...c })], ...extra }),
    bone({ id: "eye", parent: "head", rest: { x: 60, y: 20, rotation: 0, length: 10 } }),
  ]);
}
const angleOf = (r: Rig, id = "head", planar = true) => {
  const s = evaluateRig(r, { planar }).byId.get(id)!;
  return (Math.atan2(s.tail[1] - s.head[1], s.tail[0] - s.head[0]) * 180) / Math.PI;
};

describe("track — a head turns to watch", () => {
  it("points its tail at the target, the short way, and carries what hangs off it", () => {
    const r = head({ target: { kind: "point", x: 100, y: -100 } });
    expect(angleOf(r)).toBeCloseTo(-45, 6);
    // The eye rode the turn: still 60 along, 20 across the head.
    const p = evaluateRig(r, { planar: true });
    const h = p.byId.get("head")!, e = p.byId.get("eye")!;
    expect(Math.hypot(e.head[0] - h.head[0], e.head[1] - h.head[1])).toBeCloseTo(Math.hypot(60, 20), 6);
  });

  it("its rotation limits hold the turn; influence turns part way", () => {
    expect(angleOf(head({ target: { kind: "point", x: 100, y: -100 } }, { limits: { rotation: [-20, 20] } }))).toBeCloseTo(-70, 6);
    expect(angleOf(head({ target: { kind: "point", x: 100, y: -100 }, influence: 0.5 }))).toBeCloseTo(-67.5, 6);
  });

  it("a target on its head is no turn — never NaN", () => {
    const r = head({ target: { kind: "point", x: 0, y: 0 } });
    expect(angleOf(r)).toBeCloseTo(-90, 9);
    expect(finite(r)).toBe(true);
  });

  it("then the pupil looks from where the turned head put the eye", () => {
    const r = head({ target: { kind: "point", x: 300, y: 0 } });
    r.bones.push(bone({ id: "pupil", parent: "eye", rest: { x: 0, y: 0, rotation: 0, length: 4 }, limits: { x: [-5, 5], y: [-5, 5] }, constraints: [con({ id: "c2", type: "look", target: { kind: "point", x: 300, y: 0 } })] }));
    const p = evaluateRig(r, { planar: true });
    const eyeAt = p.byId.get("eye")!.head, pupil = p.byId.get("pupil")!.head;
    // 5 px from the eye, toward the target.
    expect(Math.hypot(pupil[0] - eyeAt[0], pupil[1] - eyeAt[1])).toBeCloseTo(5, 6);
    const toward = (300 - eyeAt[0]) * (pupil[0] - eyeAt[0]) + (0 - eyeAt[1]) * (pupil[1] - eyeAt[1]);
    expect(toward).toBeGreaterThan(0);
  });

  it("in a world it turns in space, the tail along the line to the target", () => {
    const r = rig([bone({ id: "head", rest: { x: 0, y: 0, z: 0, rotation: 0, rotationY: -90, rotationX: 0, length: 100 }, constraints: [con({ type: "track", target: { kind: "point", x: 40, y: 50, z: 60 } })] })]);
    const s = evaluateRig(r, { planar: false }).byId.get("head")!;
    const d = [s.tail[0] - s.head[0], s.tail[1] - s.head[1], s.tail[2] - s.head[2]];
    const t = [40, 50, 60], L = Math.hypot(...t);
    for (let i = 0; i < 3; i++) expect(d[i]! / 100).toBeCloseTo(t[i]! / L, 6);
  });

  it("lets go where a simulation owns the bone", () => {
    const r = letGoForBodies(head({ target: { kind: "point", x: 100, y: -100 } }), new Set(["head"]));
    expect(angleOf(r)).toBeCloseTo(-90, 9);
  });
});

describe("IK honours rotation limits", () => {
  /** An arm along +X, the forearm bending only clockwise on screen (0…120°), reaching for a control. */
  function arm(target: [number, number], limits: Bone["limits"] = { rotation: [0, 120] }) {
    return rig([
      bone({ id: "upper", rest: { x: 0, y: 0, rotation: 0, length: 100 } }),
      bone({ id: "fore", parent: "upper", rest: { x: 100, y: 0, rotation: 30, length: 80 }, limits, ik: { target: "ctrl", chain: 2, pole: null, flip: false, mix: 1 } }),
      bone({ id: "ctrl", deform: false, rest: { x: target[0], y: target[1], rotation: 0, length: 10 } }),
    ]);
  }
  const bend = (r: Rig) => {
    const p = evaluateRig(r, { planar: true });
    const u = p.byId.get("upper")!, f = p.byId.get("fore")!;
    const a = Math.atan2(u.tail[1] - u.head[1], u.tail[0] - u.head[0]), b = Math.atan2(f.tail[1] - f.head[1], f.tail[0] - f.head[0]);
    // The pose channel: the bend less the 30° it was drawn with.
    return { deg: ((((b - a) * 180) / Math.PI + 540) % 360) - 180 - 30, tip: f.tail, joined: Math.hypot(u.tail[0] - f.head[0], u.tail[1] - f.head[1]) };
  };

  it("reaches a target its limits allow, exactly", () => {
    const { tip, deg } = bend(arm([120, 60]));
    expect(Math.hypot(tip[0] - 120, tip[1] - 60)).toBeLessThan(0.05);
    expect(deg).toBeGreaterThanOrEqual(-1e-6);
    expect(deg).toBeLessThanOrEqual(120 + 1e-6);
  });

  it("never folds past a stop, even when the free solve would", () => {
    // Close to the shoulder: a free elbow folds ~150°. Held at 90, it gets as near as it can.
    const r = arm([30, 10], { rotation: [0, 90] });
    const { deg, joined } = bend(r);
    expect(deg).toBeLessThanOrEqual(90 + 1e-6);
    expect(deg).toBeGreaterThanOrEqual(-1e-6);
    expect(joined).toBeLessThan(1e-6);
  });

  it("an unreachable target: stable, no jitter frame to frame", () => {
    let last: number | null = null;
    let lastUpper: number | null = null;
    for (let i = 0; i <= 120; i++) {
      const a = (i / 120) * Math.PI * 1.5;
      const r = arm([Math.cos(a) * 600, Math.sin(a) * 600], { rotation: [10, 120] });
      const { deg, tip } = bend(r);
      // Out of reach, the limited elbow stays at its straightest allowed: 10° from its rest bend.
      expect(deg).toBeCloseTo(10, 3);
      const p = evaluateRig(r, { planar: true }).byId.get("upper")!;
      const up = (Math.atan2(p.tail[1], p.tail[0]) * 180) / Math.PI;
      if (lastUpper !== null) expect(Math.abs(((up - lastUpper + 540) % 360) - 180)).toBeLessThan(3);
      lastUpper = up;
      // The same frame twice is the same answer.
      expect(bend(arm([Math.cos(a) * 600, Math.sin(a) * 600], { rotation: [10, 120] })).tip).toEqual(tip);
      last = deg;
    }
    expect(last).not.toBeNull();
  });
});

describe("a constrained flat rig made 3D poses as it did flat", () => {
  it("track and look carried through the change of axes", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const card = createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 2000, x: 0, y: -60, width: 60, height: 120 });
    placeClip(doc, card, { landing: "surface" });
    const id = createRig(doc, frameId, {
      memberIds: [card.id],
      bones: [
        { head: [0, 0], tail: [0, -120], name: "Head" },
        { head: [20, -80], tail: [30, -80], name: "Pupil", parent: null, deform: false },
        { head: [200, -150], tail: [210, -150], name: "Ball", parent: null, deform: false },
      ],
    })!;
    const g0 = locateClip(doc, id)!.clip as GroupClip;
    const bid = (n: string) => g0.rig!.bones.find((b) => b.name === n)!.id;
    setBoneProps(doc, id, bid("Head"), { limits: { rotation: [-30, 30] } });
    setBoneProps(doc, id, bid("Pupil"), { limits: { x: [-8, 8], y: [-8, 8] } });
    const g = locateClip(doc, id)!.clip as GroupClip;
    g.rig!.bones.find((b) => b.name === "Head")!.constraints = [con({ type: "track", target: { kind: "bone", bone: bid("Ball") } })];
    g.rig!.bones.find((b) => b.name === "Pupil")!.constraints = [con({ id: "c2", type: "look", target: { kind: "point", x: 200, y: 40 } })];
    poseBones(doc, id, [{ bone: bid("Ball"), values: { x: 0 } }], 0, { key: true });
    poseBones(doc, id, [{ bone: bid("Ball"), values: { x: -300 } }], 1000, { key: true });
    const still = structuredClone(doc);
    const flat = (t: number) => rigPoseAt(locateClip(still, id)!.clip as GroupClip, t, true)!;
    const before = [0, 500, 1000].map((t) => flat(t).bones.map((b) => b.skin));
    // The track is really held by its limit at some instant (the test means something).
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(before[0]![0]!.some((v, j) => Math.abs(v - I[j]!) > 1e-3)).toBe(true); // the head turned
    expect(before[0]![1]!.some((v, j) => Math.abs(v - I[j]!) > 1e-3)).toBe(true); // the pupil slid
    expect(moveIntoWorld(doc, [id])).not.toBeNull();
    const w = locateClip(doc, id)!.clip as GroupClip;
    const Cm = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1], Ci = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
    [0, 500, 1000].forEach((t, k) => {
      rigPoseAt(w, t, false)!.bones.forEach((b, i) => {
        const want = mul4(mul4(Cm, before[k]![i]!), Ci);
        expect(Math.max(...b.skin.map((v, j) => Math.abs(v - want[j]!)))).toBeLessThan(1e-6);
      });
    });
  });
});
