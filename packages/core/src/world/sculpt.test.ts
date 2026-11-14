import { describe, expect, it } from "vitest";
import { buildPrimitive } from "./primitives";
import { SculptSession, dabsAlong, grabContours, sculptContours, type SculptStroke } from "./sculpt";
import type { MeshData } from "../schema";

/** A flat 200×200 grid, 20 segments, lying in XY facing +Z. */
const grid = (): MeshData => buildPrimitive("grid", { segments: 20 })!;
const z = (s: SculptSession, i: number) => s.positions[i * 3 + 2]!;
const nearest = (m: MeshData, x: number, y: number) => {
  let best = 0, bd = Infinity;
  for (let i = 0; i < m.positions.length / 3; i++) {
    const d = Math.hypot(m.positions[i * 3]! - x, m.positions[i * 3 + 1]! - y);
    if (d < bd) (bd = d), (best = i);
  }
  return best;
};
const stroke = (over: Partial<SculptStroke> = {}): SculptStroke => ({ brush: "draw", radius: 50, strength: 1, ...over });

describe("sculpting", () => {
  it("draw raises what is under the brush, along the surface, and nothing outside it", () => {
    const m = grid();
    const s = new SculptSession(m);
    const centre = nearest(m, 0, 0);
    const far = nearest(m, 90, 90);
    expect(s.dab([0, 0, 0], stroke())).toBeGreaterThan(0);
    expect(z(s, centre)).toBeGreaterThan(0.5);
    expect(z(s, far)).toBe(0);
    const sub = new SculptSession(m);
    sub.dab([0, 0, 0], stroke({ direction: -1 }));
    expect(z(sub, centre)).toBeLessThan(-0.5);
  });

  it("never changes topology — faces, parts and unwrap stay the mesh's own", () => {
    const m = grid();
    const s = new SculptSession(m);
    for (let x = -60; x <= 60; x += 6) s.dab([x, 0, 0], stroke({ brush: "inflate" }));
    const out = s.mesh();
    expect(out.faces).toBe(m.faces);
    expect(out.positions).toHaveLength(m.positions.length);
  });

  it("symmetry mirrors a dab across the object's own plane, exactly", () => {
    const m = grid();
    const s = new SculptSession(m);
    s.dab([50, 20, 0], stroke({ symmetry: [true, false, false] }));
    expect(z(s, nearest(m, -50, 20))).toBeCloseTo(z(s, nearest(m, 50, 20)), 9);
    expect(z(s, nearest(m, 50, 20))).toBeGreaterThan(0);
    // Y was not mirrored: the far side of Y stays put.
    expect(z(s, nearest(m, 50, -90))).toBe(0);
  });

  it("smooth relaxes a spike, and only within reach", () => {
    const m = grid();
    const spike = nearest(m, 0, 0);
    const lifted = { ...m, positions: m.positions.map((v, i) => (i === spike * 3 + 2 ? 40 : v)) };
    const s = new SculptSession(lifted);
    // The brush is a SPHERE: centred on the spike's flank, as the pen's ray would put it.
    for (let k = 0; k < 3; k++) s.dab([0, 0, 20], stroke({ brush: "smooth", radius: 30 }));
    expect(z(s, spike)).toBeLessThan(25);
    expect(z(s, nearest(m, 90, 0))).toBe(0);
  });

  it("flatten presses a bumpy area toward its own plane", () => {
    const m = grid();
    const bumpy = { ...m, positions: m.positions.map((v, i) => (i % 3 === 2 ? Math.sin(i * 1.7) * 6 : v)) };
    const s = new SculptSession(bumpy);
    const spread = (arr: ArrayLike<number>) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < arr.length; i += 3) {
        if (Math.hypot(arr[i]!, arr[i + 1]!) > 20) continue;
        lo = Math.min(lo, arr[i + 2]!), hi = Math.max(hi, arr[i + 2]!);
      }
      return hi - lo;
    };
    const before = spread(bumpy.positions);
    for (let k = 0; k < 4; k++) s.dab([0, 0, 0], stroke({ brush: "flatten", radius: 40 }));
    expect(spread(s.positions)).toBeLessThan(before * 0.5);
  });

  it("grab follows the TOTAL move, so repeating a move does not accumulate", () => {
    const m = grid();
    const s = new SculptSession(m);
    const centre = nearest(m, 0, 0);
    expect(s.beginGrab([0, 0, 0], stroke({ brush: "grab", falloff: "constant" }))).toBeGreaterThan(0);
    s.moveGrab([0, 0, 25]);
    s.moveGrab([0, 0, 25]);
    expect(z(s, centre)).toBeCloseTo(25, 9);
    s.endGrab();
    s.moveGrab([0, 0, 100]);
    expect(z(s, centre)).toBeCloseTo(25, 9);
  });

  it("front faces only leaves the far side of a shape alone under a big brush", () => {
    const sphere = buildPrimitive("uvSphere", { radius: 100, segments: 24, rings: 12 })!;
    const s = new SculptSession(sphere);
    const back = nearest({ ...sphere, positions: sphere.positions.map((v, i) => (i % 3 === 2 ? 0 : v)) }, 0, 100);
    const backBefore = [...s.positions.slice(back * 3, back * 3 + 3)];
    // Looking along −Y from in front: the brush reaches right through the sphere.
    s.dab([0, -100, 0], stroke({ radius: 400, view: [0, 1, 0] }));
    expect([...s.positions.slice(back * 3, back * 3 + 3)]).toEqual(backBefore);
  });

  it("dabs are spaced along the stroke and carry their rhythm across events", () => {
    const a = dabsAlong({ x: 0, y: 0 }, { x: 25, y: 0 }, 10, 0);
    expect(a.points.map((p) => p.x)).toEqual([10, 20]);
    const b = dabsAlong({ x: 25, y: 0 }, { x: 31, y: 0 }, 10, a.carry);
    expect(b.points.map((p) => p.x)).toEqual([30]);
    const c = dabsAlong({ x: 31, y: 0 }, { x: 33, y: 0 }, 10, b.carry);
    expect(c.points).toEqual([]);
    expect(c.carry).toBeCloseTo(3, 9);
  });
});

describe("sculpting a drawing", () => {
  const line = () => [{ closed: false, points: [0, 1, 2, 3, 4].map((i) => ({ x: i * 10, y: i === 2 ? 20 : 0, hIn: null, hOut: i === 2 ? { x: 25, y: 20 } : null })) }];
  it("smooth relaxes a kink, holds an open line's ends, and carries handles with their anchor", () => {
    const out = sculptContours(line(), "smooth", { x: 20, y: 0 }, () => 1)[0]!.points;
    expect(out[2]!.y).toBeCloseTo(10, 9);
    expect(out[2]!.hOut!.y - out[2]!.y).toBeCloseTo(0, 9);
    expect(out[0]).toEqual(line()[0]!.points[0]);
    expect(out[4]).toEqual(line()[0]!.points[4]);
  });
  it("grab moves by weight × the total move, and never compounds", () => {
    const start = line();
    const w = [[0, 0.5, 1, 0.5, 0]];
    const a = grabContours(start, w, { x: 0, y: 8 });
    const b = grabContours(start, w, { x: 0, y: 8 });
    expect(a[0]!.points.map((p) => p.y)).toEqual([0, 4, 28, 4, 0]);
    expect(b).toEqual(a);
  });
  it("works in depth: a 3D line keeps its depth, Draw lifts it toward the eye, Flatten presses it back", () => {
    const deep = [{ closed: false, points: [0, 1, 2].map((i) => ({ x: i * 10, y: 0, z: i === 1 ? 12 : 4, hIn: null, hOut: null })) }];
    const smoothed = sculptContours(deep, "smooth", { x: 10, y: 0 }, (_c, i) => (i === 1 ? 1 : 0))[0]!.points;
    expect(smoothed[1]!.z).toBeCloseTo(8, 9); // halfway to its neighbours' depth
    expect(smoothed[0]!.z).toBe(4);
    const lifted = sculptContours(deep, "draw", { x: 10, y: 0 }, () => 1, 1, { radius: 50, toward: { x: 0, y: 0, z: -1 } })[0]!.points;
    expect(lifted[1]!.z).toBeCloseTo(12 - 5, 9);
    const flat = sculptContours(deep, "flatten", { x: 10, y: 0 }, () => 2)[0]!.points;
    expect(flat[1]!.z).toBeCloseTo(6, 9);
    const grabbed = grabContours(deep, [[0, 1, 0]], { x: 0, y: 0, z: 3 })[0]!.points;
    expect(grabbed[1]!.z).toBe(15);
  });
});
