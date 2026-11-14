import { describe, expect, it } from "vitest";
import type { PathPoint, Subpath } from "../schema/vector";
import { copySubpaths, insertPointOnSegment, autoSmoothHandles } from "./geometry";
import { deleteNodes, isSmoothNode } from "./edit-engine";
import { extrudeNodes, mergeNodes, nodeSelection, runNodeVerb, subdivideNodes } from "./node-verbs";
import { beginTangentDrag, resolveTangentDrag } from "../tangents";

const pt = (x: number, y: number, extra: Partial<PathPoint> = {}): PathPoint => ({ x, y, hIn: null, hOut: null, ...extra });
const line = (pts: PathPoint[], closed = false, id = "s0"): Subpath => ({ id, closed, points: pts }) as Subpath;

describe("point verbs: one vocabulary for 2D and 3D", () => {
  it("a node's depth survives every copy and structural verb (a 3D stroke never goes flat)", () => {
    const subs = [line([pt(0, 0, { z: 5 }), pt(10, 0, { z: 8, hIn: { x: 6, y: 0, z: 9 }, hOut: { x: 14, y: 0 } }), pt(20, 0, { z: 2 })])];
    const copy = copySubpaths(subs);
    expect(copy[0]!.points[1]!.z).toBe(8);
    expect(copy[0]!.points[1]!.hIn!.z).toBe(9);
    deleteNodes(copy, [{ sub: 0, index: 0 }]);
    expect(copy[0]!.points.map((p) => p.z)).toEqual([8, 2]);
  });

  it("smoothing a node of a 3D line smooths its depth too; a flat one writes no depth", () => {
    const { hIn, hOut } = autoSmoothHandles({ x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: -6 }, { x: 20, y: 0, z: 6 });
    expect(hOut!.z).toBeCloseTo(2, 9);
    expect(hIn!.z).toBeCloseTo(-2, 9);
    const flat = autoSmoothHandles({ x: 10, y: 0 }, { x: 0, y: 0 }, { x: 20, y: 5 });
    expect(flat.hOut && "z" in flat.hOut).toBe(false);
  });

  it("a point added to a 3D curve lands on it, depth and all", () => {
    const sub = line([pt(0, 0, { z: 0 }), pt(30, 0, { z: 30 })]);
    const i = insertPointOnSegment(sub, 0, 0.5);
    expect(sub.points[i]!.z).toBeCloseTo(15, 9);
  });

  it("knows what a selection is: a segment, a pair of ends, its point type", () => {
    const subs = [line([pt(0, 0), pt(10, 0, { hIn: { x: 5, y: 0 }, hOut: { x: 15, y: 0 } }), pt(20, 0)])];
    const seg = nodeSelection(subs, [{ sub: 0, index: 0 }, { sub: 0, index: 1 }]);
    expect(seg.segment).toBe("curve");
    expect(nodeSelection(subs, [{ sub: 0, index: 0 }, { sub: 0, index: 2 }]).endpointPair).toBe(true);
    expect(nodeSelection(subs, [{ sub: 0, index: 1 }]).type).toBe("smooth");
    expect(nodeSelection(subs, [{ sub: 0, index: 0 }, { sub: 0, index: 1 }]).type).toBe("mixed");
  });

  it("toggles point type by what the selection mostly is (double-click, V)", () => {
    const subs = [line([pt(0, 0), pt(10, 10), pt(20, 0)])];
    runNodeVerb("toggleType", subs, [{ sub: 0, index: 1 }]);
    expect(isSmoothNode(subs[0]!.points[1]!)).toBe(true);
    runNodeVerb("toggleType", subs, [{ sub: 0, index: 1 }]);
    expect(subs[0]!.points[1]!.hIn).toBeNull();
  });
});

describe("merge (M): many nodes become one", () => {
  it("neighbours collapse to their centre and keep the curve's outer handles", () => {
    const subs = [line([pt(0, 0), pt(10, 0, { hIn: { x: 8, y: -2 } }), pt(14, 0, { hOut: { x: 16, y: 2 } }), pt(30, 0)])];
    const r = mergeNodes(subs, [{ sub: 0, index: 1 }, { sub: 0, index: 2 }]);
    const pts = subs[0]!.points;
    expect(pts).toHaveLength(3);
    expect(pts[1]!.x).toBe(12);
    // Each outer handle rode its own anchor's move.
    expect(pts[1]!.hIn).toEqual({ x: 10, y: -2 });
    expect(pts[1]!.hOut).toEqual({ x: 14, y: 2 });
    expect(r.select).toEqual([{ sub: 0, index: 1 }]);
  });

  it("two ends of two lines join into one run at the merge point", () => {
    const subs = [line([pt(0, 0), pt(10, 0)], false, "a"), line([pt(14, 0), pt(30, 0)], false, "b")];
    mergeNodes(subs, [{ sub: 0, index: 1 }, { sub: 1, index: 0 }]);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.points.map((p) => p.x)).toEqual([0, 12, 30]);
  });

  it("a line's own two ends close it", () => {
    const subs = [line([pt(0, 0), pt(10, 10), pt(1, 1)])];
    mergeNodes(subs, [{ sub: 0, index: 0 }, { sub: 0, index: 2 }]);
    expect(subs[0]!.closed).toBe(true);
    expect(subs[0]!.points).toHaveLength(2);
  });

  it("middles of different lines weld into one node (a junction), in depth too", () => {
    const subs = [line([pt(0, 0), pt(10, 0, { z: 4 }), pt(20, 0)], false, "a"), line([pt(10, -10), pt(12, 2), pt(10, 10)], false, "b")];
    mergeNodes(subs, [{ sub: 0, index: 1 }, { sub: 1, index: 1 }]);
    const a = subs[0]!.points[1]!, b = subs[1]!.points[1]!;
    expect(a.weldId).toBeTruthy();
    expect(a.weldId).toBe(b.weldId);
    expect([a.x, a.y]).toEqual([b.x, b.y]);
    expect(a.z).toBeCloseTo(2, 9);
  });
});

describe("extrude (E): a new point grows from each node", () => {
  it("from an open end the line continues; the new point is the selection", () => {
    const subs = [line([pt(0, 0), pt(10, 0, { z: 3 })])];
    const r = extrudeNodes(subs, [{ sub: 0, index: 1 }]);
    expect(subs[0]!.points).toHaveLength(3);
    expect(subs[0]!.points[2]!.z).toBe(3);
    expect(r.select).toEqual([{ sub: 0, index: 2 }]);
    const head = extrudeNodes(subs, [{ sub: 0, index: 0 }]);
    expect(subs[0]!.points).toHaveLength(4);
    expect(head.select).toEqual([{ sub: 0, index: 0 }]);
  });

  it("from a middle node a welded branch starts", () => {
    const subs = [line([pt(0, 0), pt(10, 0), pt(20, 0)])];
    const r = extrudeNodes(subs, [{ sub: 0, index: 1 }]);
    expect(subs).toHaveLength(2);
    expect(subs[1]!.points[0]!.weldId).toBe(subs[0]!.points[1]!.weldId);
    expect(r.select).toEqual([{ sub: 1, index: 1 }]);
  });
});

describe("subdivide: a point on every selected segment", () => {
  it("splits each segment whose ends are both selected, on the curve", () => {
    const subs = [line([pt(0, 0), pt(10, 0), pt(20, 0), pt(30, 0)])];
    const r = subdivideNodes(subs, [0, 1, 2].map((index) => ({ sub: 0, index })));
    expect(subs[0]!.points.map((p) => p.x)).toEqual([0, 5, 10, 15, 20, 30]);
    expect(r.select).toHaveLength(5);
  });
});

describe("a handle drag keeps a smooth node smooth", () => {
  it("an uneven smooth node's partner turns and keeps its own length; ⌥ breaks it", () => {
    const start = beginTangentDrag({ x: 10, y: 0 }, { x: -4, y: 0 });
    expect(start.symmetric).toBe(false);
    const r = resolveTangentDrag(start, { vector: { x: 0, y: 10 }, alt: false, shift: false, dissolveWithin: 1 });
    expect(r.partner!.x).toBeCloseTo(0, 9);
    expect(r.partner!.y).toBeCloseTo(-4, 9);
    expect(resolveTangentDrag(start, { vector: { x: 0, y: 10 }, alt: true, shift: false, dissolveWithin: 1 }).partner).toBeNull();
  });

  it("works on 3D arms", () => {
    const start = beginTangentDrag({ x: 0, y: 0, z: 6 }, { x: 0, y: 0, z: -6 });
    expect(start.symmetric).toBe(true);
    const r = resolveTangentDrag(start, { vector: { x: 3, y: 0, z: 4 }, alt: false, shift: false, dissolveWithin: 1 });
    expect(r.partner).toEqual({ x: -3, y: -0, z: -4 });
  });
});
