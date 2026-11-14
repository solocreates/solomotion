import { describe, expect, it } from "vitest";
import { boneSchema, rigSchema, weightStrokeSchema, type Bone, type WeightStroke } from "../schema/rig";
import { evaluateRig } from "./pose";
import { autoWeights, deformSegments, paintWeights, rigJoints, SLOTS, weightAt, type Weights } from "./weights";
import { gridSupport, sampleGrid, type Coverage, type GridSupport } from "./support";
import { identity4 } from "../world/math";

const bone = (b: Partial<Bone> & { id: string }): Bone => boneSchema.parse(b);

/** Two legs with a slit between them, joined at a hip band: ∩. */
const legs: Coverage = (x, y) => {
  if (y >= -40 && y < 0 && x >= -45 && x <= 45) return 1;
  if (y >= 0 && y <= 200 && ((x >= -45 && x <= -5) || (x >= 5 && x <= 45))) return 1;
  return 0;
};
const legRig = () =>
  evaluateRig(
    rigSchema.parse({
      bones: [
        bone({ id: "hip", rest: { x: 0, y: -40, rotation: 90, length: 30 } }),
        bone({ id: "left", parent: "hip", rest: { x: 40, y: 25, rotation: 0, length: 190 } }),
        bone({ id: "right", parent: "hip", rest: { x: 40, y: -25, rotation: 0, length: 190 } }),
      ],
    }),
    { planar: true },
  );
const box = { minX: -45, minY: -40, maxX: 45, maxY: 200 };

function sums(w: Weights): number[] {
  const out: number[] = [];
  for (let i = 0; i < w.count; i++) {
    let s = 0;
    for (let j = 0; j < SLOTS; j++) if (w.bone[i * SLOTS + j]! >= 0) s += w.w[i * SLOTS + j]!;
    out.push(s);
  }
  return out;
}

/** The weight of `id` at a point of the layer's space, read the way the warp reads it. */
function at(g: GridSupport, w: Weights, id: string, x: number, y: number): number {
  const inf = sampleGrid(g, w, x, y);
  const b = w.bones.indexOf(id);
  for (let k = 0; k < inf.bone.length; k++) if (inf.bone[k] === b) return inf.w[k]!;
  return 0;
}

describe("automatic weights (bone heat)", () => {
  it("names the bones the right way round (the left leg bone hangs at x = −25)", () => {
    const pose = legRig();
    expect(pose.byId.get("left")!.restHead[0]).toBeCloseTo(-25, 6);
    expect(pose.byId.get("right")!.restHead[0]).toBeCloseTo(25, 6);
  });

  it("never lets heat cross a gap the picture has — the slit between two legs", () => {
    const pose = legRig();
    const shaped = gridSupport(box, identity4(), legs);
    const boxed = gridSupport(box, identity4(), null);
    const ws = autoWeights(shaped, deformSegments(pose));
    const wb = autoWeights(boxed, deformSegments(pose));
    // The inside edge of the left leg, low down: far from the hip, near the slit.
    const throughAir = at(boxed, wb, "right", -6, 170);
    const throughShape = at(shaped, ws, "right", -6, 170);
    expect(throughShape).toBeLessThan(0.01);
    // Softening the hip joints spreads only along the shape, never through the slit.
    const soft = autoWeights(shaped, deformSegments(pose), { joints: rigJoints(pose, 1) });
    expect(at(shaped, soft, "right", -6, 170)).toBeLessThan(0.01);
    // With the box the heat leaks across — the bug the silhouette exists to prevent.
    expect(throughAir).toBeGreaterThan(throughShape + 0.05);
  });

  it("blends across a joint and holds each limb whole away from it", () => {
    const pose = evaluateRig(
      rigSchema.parse({ bones: [bone({ id: "upper", rest: { x: -100, y: 0, rotation: 0, length: 100 } }), bone({ id: "fore", parent: "upper", rest: { x: 100, y: 0, rotation: 0, length: 100 } })] }),
      { planar: true },
    );
    const g = gridSupport({ minX: -110, minY: -20, maxX: 110, maxY: 20 }, identity4(), null);
    const w = autoWeights(g, deformSegments(pose), { joints: rigJoints(pose, 0.35) });
    // Without the joint blend, heat alone creases a thin limb right at the joint.
    const hinge = autoWeights(g, deformSegments(pose));
    expect(Math.abs(at(g, hinge, "upper", -6, 0) - at(g, hinge, "upper", 6, 0))).toBeGreaterThan(0.5);
    expect(at(g, w, "upper", -90, 0)).toBeGreaterThan(0.97);
    expect(at(g, w, "fore", 90, 0)).toBeGreaterThan(0.97);
    const elbow = at(g, w, "upper", 0, 0);
    expect(elbow).toBeGreaterThan(0.3);
    expect(elbow).toBeLessThan(0.7);
    // Monotone along the arm: the upper's share only falls going out.
    const along = [-80, -40, -10, 0, 10, 40, 80].map((x) => at(g, w, "upper", x, 0));
    for (let i = 1; i < along.length; i++) expect(along[i]!).toBeLessThanOrEqual(along[i - 1]! + 1e-6);
    expect(Math.min(...sums(w))).toBeCloseTo(1, 5);
    expect(Math.max(...sums(w))).toBeCloseTo(1, 5);
  });
});

describe("painted weights", () => {
  const arm = () => {
    const pose = evaluateRig(
      rigSchema.parse({ bones: [bone({ id: "upper", rest: { x: -100, y: 0, rotation: 0, length: 100 } }), bone({ id: "fore", parent: "upper", rest: { x: 100, y: 0, rotation: 0, length: 100 } })] }),
      { planar: true },
    );
    return { pose, segs: deformSegments(pose) };
  };
  const stroke = (s: Partial<WeightStroke>): WeightStroke => weightStrokeSchema.parse({ bone: "fore", radius: 30, strength: 1, ...s });

  it("add pulls a bone in, the others share the rest, every point still sums to one", () => {
    const { segs } = arm();
    const g = gridSupport({ minX: -110, minY: -20, maxX: 110, maxY: 20 }, identity4(), null);
    const auto = autoWeights(g, segs);
    const painted = paintWeights(auto, g, [stroke({ mode: "add", points: [-60, 0, 0, 1] })]);
    expect(at(g, painted, "fore", -60, 0)).toBeGreaterThan(at(g, auto, "fore", -60, 0) + 0.5);
    for (const s of sums(painted)) expect(s).toBeCloseTo(1, 5);
    // Untouched far away.
    expect(at(g, painted, "fore", 90, 0)).toBeCloseTo(at(g, auto, "fore", 90, 0), 6);
    // The memo's weights are never written into.
    expect(at(g, auto, "fore", -60, 0)).toBeLessThan(0.1);
  });

  it("subtracting a point's only bone hands it to the bone beside it, not to nothing", () => {
    const { segs } = arm();
    const g = gridSupport({ minX: -110, minY: -20, maxX: 110, maxY: 20 }, identity4(), null);
    const painted = paintWeights(autoWeights(g, segs), g, [stroke({ bone: "upper", mode: "subtract", strength: 1, points: [-95, 0, 0, 1] })]);
    const i = nearestPoint(g, -95, 0);
    expect(weightAt(painted, i, "upper")).toBeLessThan(0.05);
    expect(weightAt(painted, i, "fore")).toBeGreaterThan(0.95);
  });

  it("smooth evens a hard edge, and replay order matters (it is a history, not a set)", () => {
    const { segs } = arm();
    const g = gridSupport({ minX: -110, minY: -20, maxX: 110, maxY: 20 }, identity4(), null);
    const auto = autoWeights(g, segs);
    const hard = paintWeights(auto, g, [stroke({ mode: "replace", strength: 1, radius: 40, points: [40, 0, 0, 1] })]);
    const soft = paintWeights(auto, g, [stroke({ mode: "replace", strength: 1, radius: 40, points: [40, 0, 0, 1] }), stroke({ mode: "smooth", strength: 1, radius: 60, points: [0, 0, 0, 1, 20, 0, 0, 1] })]);
    const step = (w: Weights) => Math.abs(at(g, w, "fore", 10, 0) - at(g, w, "fore", -10, 0));
    expect(step(soft)).toBeLessThan(step(hard));
    const swapped = paintWeights(auto, g, [stroke({ mode: "smooth", strength: 1, radius: 60, points: [0, 0, 0, 1, 20, 0, 0, 1] }), stroke({ mode: "replace", strength: 1, radius: 40, points: [40, 0, 0, 1] })]);
    expect(Math.abs(at(g, swapped, "fore", 10, 0) - at(g, soft, "fore", 10, 0))).toBeGreaterThan(1e-3);
  });

  it("paint survives the art changing size — strokes replay over the new grid", () => {
    const { segs } = arm();
    const small = gridSupport({ minX: -110, minY: -20, maxX: 110, maxY: 20 }, identity4(), null);
    const big = gridSupport({ minX: -110, minY: -60, maxX: 110, maxY: 60 }, identity4(), null);
    const s = [stroke({ mode: "add", points: [-60, 0, 0, 1] })];
    const a = at(small, paintWeights(autoWeights(small, segs), small, s), "fore", -60, 0);
    const b = at(big, paintWeights(autoWeights(big, segs), big, s), "fore", -60, 0);
    expect(a).toBeGreaterThan(0.5);
    expect(Math.abs(a - b)).toBeLessThan(0.15);
  });

  it("a stroke for a bone the rig no longer has paints nothing", () => {
    const { segs } = arm();
    const g = gridSupport({ minX: -110, minY: -20, maxX: 110, maxY: 20 }, identity4(), null);
    const auto = autoWeights(g, segs);
    expect(paintWeights(auto, g, [stroke({ bone: "deleted", points: [0, 0, 0, 1] })]).w).toEqual(auto.w);
  });
});

function nearestPoint(g: GridSupport, x: number, y: number): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < g.count; i++) {
    const d = (g.local[i * 3]! - x) ** 2 + (g.local[i * 3 + 1]! - y) ** 2;
    if (d < bd) (bd = d), (best = i);
  }
  return best;
}
