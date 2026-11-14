import { describe, expect, it } from "vitest";
import { solveIk } from "./ik";
import { dist3, matPosition, translate4, type V3 } from "./math";
import { createEmptyDocument } from "../factories";
import { placeClip } from "../timeline/place";
import { createEmptyClip, createMeshClip, createWorld } from "./ops";
import { evaluateWorld } from "./evaluate";

describe("inverse kinematics", () => {
  const arm = () => [translate4([0, 0, 0]), translate4([100, 0, 0]), translate4([200, 0, 0])];

  it("reaches a target lying on the line through its elbow (FABRIK used to straighten past it)", () => {
    // A bent arm whose elbow sits exactly on root→target: every pass pulled the
    // elbow along that line and the hand came to rest 30 units beyond the goal.
    const bent = [translate4([0, 0, 0]), translate4([100, 0, 0]), translate4([169.28, 40, 0])];
    const out = solveIk(bent, [150, 0, 0], null);
    expect(dist3(matPosition(out[2]!), [150, 0, 0])).toBeLessThan(0.05);
    expect(dist3(matPosition(out[1]!), [0, 0, 0])).toBeCloseTo(100, 6);
    // It keeps turning the way it turned: the elbow folds to the side away from the hand's lean.
    expect(matPosition(out[1]!)[1]).toBeLessThan(0);
  });

  it("a two-joint arm reaches a target in reach, keeping its bone lengths", () => {
    const target: V3 = [100, 100, 0];
    const out = solveIk(arm(), target, null);
    const [r, e, t] = out.map(matPosition) as [V3, V3, V3];
    expect(dist3(t, target)).toBeLessThan(0.05);
    expect(dist3(r, [0, 0, 0])).toBeLessThan(1e-9);
    expect(dist3(r, e)).toBeCloseTo(100, 6);
    expect(dist3(e, t)).toBeCloseTo(100, 6);
  });

  it("out of reach, it straightens toward the target", () => {
    const out = solveIk(arm(), [0, 500, 0], null);
    const t = matPosition(out[2]!);
    expect(t[1]).toBeCloseTo(200, 3);
    expect(Math.abs(t[0])).toBeLessThan(0.5);
  });

  it("a pole decides which way the elbow bends", () => {
    for (const side of [1, -1]) {
      const out = solveIk(arm(), [150, 0, 0], [75, 0, 200 * side]);
      expect(Math.sign(matPosition(out[1]!)[2])).toBe(side);
      expect(dist3(matPosition(out[2]!), [150, 0, 0])).toBeLessThan(0.05);
    }
  });

  it("in a world: the hand reaches the target and what hangs on the forearm comes along", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    const at = (name: string, p: V3) => {
      const e = createEmptyClip({ frameId: frame.id, startMs: 0, durationMs: 2000, name, position: p });
      placeClip(doc, e, { landing: "surface" });
      return e;
    };
    const shoulder = at("shoulder", [0, 0, 0]);
    const elbow = at("elbow", [100, 0, 0]);
    const hand = at("hand", [100, 0, 0]);
    const goal = at("goal", [80, 0, 120]);
    const sleeve = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 2000, primitive: "cube", position: [50, 0, 0] });
    placeClip(doc, sleeve, { landing: "surface" });
    const parent = (c: { constraints?: unknown[] }, to: string) => (c.constraints = [{ id: `p${to}`, type: "childOf", targetId: to, enabled: true, influence: 1, inverse: null }]);
    parent(elbow, shoulder.id);
    parent(hand, elbow.id);
    parent(sleeve, elbow.id);
    const before = evaluateWorld(doc, frame, 0, { physics: false });
    const pos = (ev: typeof before, id: string) => matPosition(ev.objects.find((o) => o.id === id)!.matrix);
    const gap = dist3(pos(before, sleeve.id), pos(before, elbow.id));
    hand.constraints = [...(hand.constraints ?? []), { id: "ik", type: "ik", targetId: goal.id, enabled: true, influence: 1, chainLength: 2, poleId: null }] as typeof hand.constraints;
    const ev = evaluateWorld(doc, frame, 0, { physics: false });
    expect(dist3(pos(ev, hand.id), [80, 0, 120])).toBeLessThan(0.05);
    expect(dist3(pos(ev, sleeve.id), pos(ev, elbow.id))).toBeCloseTo(gap, 4);
    expect(dist3(pos(ev, shoulder.id), [0, 0, 0])).toBeLessThan(1e-9);
  });
});
