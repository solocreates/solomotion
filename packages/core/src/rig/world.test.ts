import { describe, expect, it } from "vitest";
import type { MeshClip } from "../schema";
import { createEmptyDocument, createShapeClip } from "../factories";
import { placeClip } from "../timeline/place";
import { createMeshClip, createWorld } from "../world/ops";
import { evaluateGeometry, evaluateWorld } from "../world/evaluate";
import { matPosition, mul4 } from "../world/math";
import { createRig, poseBones, setBoneProps } from "./ops";
import { rigPoseAt } from "./pose";
import { moveIntoWorld } from "../world/flat3d";
import type { GroupClip } from "../schema";
import { bonesInRig } from "./ops";
import { locateClip } from "../timeline/ops";
import { moveClipsToScope } from "../timeline/groups";
import { bodyThroughStack, cardMesh } from "../world/body";

function scene() {
  const doc = createEmptyDocument();
  const { frame } = createWorld(doc, { starter: false });
  const span = { frameId: frame.id, startMs: 0, durationMs: 2000 };
  // A long bar along X, an arm's length: −200 … 200.
  const bar = createMeshClip({ ...span, primitive: "cube", params: { sizeX: 400, sizeY: 40, sizeZ: 40 }, name: "Bar" });
  // A small cube past the tip, near no bone: it rides the nearest.
  const prop = createMeshClip({ ...span, primitive: "cube", params: { sizeX: 40, sizeY: 40, sizeZ: 40 }, name: "Prop", position: [300, 0, 0] });
  placeClip(doc, bar, { landing: "surface" });
  placeClip(doc, prop, { landing: "surface" });
  const rig = createRig(doc, frame.id, {
    memberIds: [bar.id, prop.id],
    bones: [
      { head: [-200, 0, 0], tail: [0, 0, 0], name: "A" },
      { head: [0, 0, 0], tail: [200, 0, 0], name: "B" },
    ],
  })!;
  const boneId = (name: string) => (locateClip(doc, rig)!.clip as { rig: { bones: Array<{ id: string; name: string }> } }).rig.bones.find((b) => b.name === name)!.id;
  return { doc, frame, bar, prop, rig, boneId };
}

describe("a rig in a world", () => {
  it("stores world bones with depth, and draws them where they were put", () => {
    const { doc, rig } = scene();
    const g = locateClip(doc, rig)!.clip as { rig: Parameters<typeof bonesInRig>[0] };
    const at = [...bonesInRig(g.rig, false).values()];
    expect(at[1]!.tail[0]).toBeCloseTo(200, 6);
    expect(g.rig.bones.every((b) => b.rest.z !== undefined)).toBe(true);
  });

  it("at rest nothing moves and nothing is skinned", () => {
    const { doc, frame, bar, prop } = scene();
    const ev = evaluateWorld(doc, frame, 0);
    expect(ev.objects.find((o) => o.id === bar.id)!.skin).toBeUndefined();
    expect(matPosition(ev.objects.find((o) => o.id === prop.id)!.matrix)).toEqual([300, 0, 0]);
  });

  it("bends a mesh the bones run through, and carries a prop on its bone", () => {
    const { doc, frame, bar, prop, rig, boneId } = scene();
    poseBones(doc, rig, [{ bone: boneId("B"), values: { rotation: 90 } }], 0);
    const ev = evaluateWorld(doc, frame, 0);
    const o = ev.objects.find((x) => x.id === bar.id)!;
    expect(o.skin).toBeDefined();
    const bent = evaluateGeometry(o.clip as MeshClip, o.localMs, { skin: o.skin }).mesh!;
    const P = bent.positions;
    let maxY = -Infinity, atShoulder = 0;
    for (let i = 0; i < P.length; i += 3) {
      maxY = Math.max(maxY, P[i + 1]!);
      if (P[i]! < -190) atShoulder = Math.max(atShoulder, Math.abs(P[i + 1]!) - 20);
    }
    // The far half swung up toward +Y; the shoulder end did not move.
    expect(maxY).toBeGreaterThan(180);
    expect(atShoulder).toBeLessThan(1e-6);
    // The prop rides bone B whole: (300, 0, 0) turns about the elbow to (0, 300, 0).
    const p = matPosition(ev.objects.find((x) => x.id === prop.id)!.matrix);
    expect(p[0]).toBeCloseTo(0, 6);
    expect(p[1]).toBeCloseTo(300, 6);
  });

  it("bends a flat picture standing in the world through the weights of its silhouette", () => {
    const { doc, frame, rig, boneId } = scene();
    const card = createShapeClip({ frameId: frame.id, shape: "rect", startMs: 0, durationMs: 2000, width: 400, height: 40 });
    placeClip(doc, card, { landing: "surface" });
    moveClipsToScope(doc, [card.id], rig);
    poseBones(doc, rig, [{ bone: boneId("B"), values: { rotation: 90 } }], 0);
    const o = evaluateWorld(doc, frame, 0).objects.find((x) => x.id === card.id)!;
    expect(o.kind).toBe("plane");
    expect(o.skin).toBeDefined();
    // Its body: the card on its plane (u right, v down → local x, −z), skinned first.
    const base = cardMesh({ minX: -200, minY: -20, maxX: 200, maxY: 20 }, 0);
    const bent = bodyThroughStack(base, "card-test", [], 0, { skin: o.skin }).mesh;
    let maxY = -Infinity, leftMoved = 0;
    for (let i = 0; i < bent.positions.length; i += 3) {
      maxY = Math.max(maxY, bent.positions[i + 1]!);
      if (bent.positions[i]! < -150) leftMoved = Math.max(leftMoved, Math.abs(bent.positions[i + 1]!));
    }
    expect(maxY).toBeGreaterThan(150);
    expect(leftMoved).toBeLessThan(1e-6);
    // More points than the two triangles it was: a card has to have points to bend.
    expect(bent.positions.length).toBeGreaterThan(base.positions.length * 10);
  });
});

describe("a flat rig made 3D", () => {
  it("poses exactly as it did flat — rests, keyed turns, moves, thickness and limits through the change of axes", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const card = createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 2000, x: 0, y: 0, width: 400, height: 40 });
    placeClip(doc, card, { landing: "surface" });
    const rig = createRig(doc, frameId, {
      memberIds: [card.id],
      bones: [
        { head: [-200, 10], tail: [0, -30], name: "Upper" },
        { head: [0, -30], tail: [200, 20], name: "Fore" },
      ],
    })!;
    const g0 = locateClip(doc, rig)!.clip as GroupClip;
    const id = (n: string) => g0.rig!.bones.find((b) => b.name === n)!.id;
    setBoneProps(doc, rig, id("Upper"), { limits: { y: [-10, 30] } });
    poseBones(doc, rig, [{ bone: id("Upper"), values: { y: 50, scale: 1.2, scaleY: 0.5 } }], 0); // y held to 30
    poseBones(doc, rig, [{ bone: id("Fore"), values: { rotation: 0 } }], 0, { key: true });
    poseBones(doc, rig, [{ bone: id("Fore"), values: { rotation: 70 } }], 1000, { key: true });
    // Measured on a copy: the app converts inside an immutable update, and the pose memo keys on identity.
    const still = structuredClone(doc);
    const flat = (t: number) => rigPoseAt(locateClip(still, rig)!.clip as GroupClip, t, true)!;
    const before = [0, 400, 1000].map((t) => flat(t).bones.map((b) => ({ head: b.head, tail: b.tail, skin: b.skin })));

    expect(moveIntoWorld(doc, [rig])).not.toBeNull();
    const g = locateClip(doc, rig)!.clip as GroupClip;
    expect(doc.frames.find((f) => f.id === g.frameId)!.world).toBeTruthy();
    // Flat (x, y-down, z-away) → world (x, z-away, −y): Z up.
    const C = (p: readonly number[]) => [p[0]!, p[2]!, -p[1]!];
    [0, 400, 1000].forEach((t, k) => {
      const w = rigPoseAt(g, t, false)!;
      w.bones.forEach((b, i) => {
        const f = before[k]![i]!;
        for (const [a, e] of [[b.head, C(f.head)], [b.tail, C(f.tail)]] as const) expect(Math.hypot(a[0] - e[0]!, a[1] - e[1]!, a[2] - e[2]!)).toBeLessThan(1e-6);
        // The whole skin — stretch and thickness included — is the flat one carried through the axes: C·S·C⁻¹.
        const Cm = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1], Ci = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
        const want = mul4(mul4(Cm, f.skin), Ci);
        expect(Math.max(...b.skin.map((v, j) => Math.abs(v - want[j]!)))).toBeLessThan(1e-6);
      });
    });
    // The limit came across with its axis: flat y [−10, 30] is world z [−30, 10].
    expect(g.rig!.bones.find((b) => b.name === "Upper")!.limits).toEqual({ z: [-30, 10] });
    expect(g.keyframes.some((k) => k.property === `bone.${id("Fore")}.rotationY`)).toBe(true);
  });
});
