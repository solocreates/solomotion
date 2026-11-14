import { describe, expect, it } from "vitest";
import {
  curveSegment,
  duplicateSegment,
  segmentOf,
  splitSegment,
  straightenSegment,
  translateNodes,
  deleteNodes,
} from "./edit-engine";
import type { Contour, PathPoint } from "../schema";

describe("segments — two adjacent anchors ARE the segment", () => {
  const line = (n: number, closed = false): Contour => ({
    closed,
    points: Array.from({ length: n }, (_, i) => ({ x: i * 10, y: 0, hIn: null, hOut: null })),
  });
  const at = (sub: number, index: number) => ({ sub, index });

  it("names the run between adjacent anchors, and nothing else", () => {
    const subs = [line(4)];
    expect(segmentOf(subs, [at(0, 1), at(0, 2)])).toEqual({ sub: 0, index: 1 });
    // Order does not matter; non-adjacent and cross-contour name nothing.
    expect(segmentOf(subs, [at(0, 2), at(0, 1)])).toEqual({ sub: 0, index: 1 });
    expect(segmentOf(subs, [at(0, 0), at(0, 2)])).toBeNull();
    expect(segmentOf([line(3), line(3)], [at(0, 0), at(1, 1)])).toBeNull();
    expect(segmentOf(subs, [at(0, 1)])).toBeNull();
  });

  it("names the CLOSING run of a loop (last → first)", () => {
    const subs = [line(4, true)];
    expect(segmentOf(subs, [at(0, 0), at(0, 3)])).toEqual({ sub: 0, index: 3 });
  });

  it("straightening drops only the arms facing the segment", () => {
    const subs = [line(3)];
    subs[0]!.points[0]!.hIn = { x: -5, y: 0 };
    subs[0]!.points[1]!.hOut = { x: 15, y: 5 };
    subs[0]!.points[0]!.hOut = { x: 3, y: 3 };
    subs[0]!.points[1]!.hIn = { x: 7, y: 3 };
    expect(straightenSegment(subs, [at(0, 0), at(0, 1)])).toBe(true);
    expect(subs[0]!.points[0]!.hOut).toBeNull();
    expect(subs[0]!.points[1]!.hIn).toBeNull();
    // The neighbouring runs' arms are untouched.
    expect(subs[0]!.points[0]!.hIn).toEqual({ x: -5, y: 0 });
    expect(subs[0]!.points[1]!.hOut).toEqual({ x: 15, y: 5 });
  });

  it("curving gives the chord thirds, and straighten undoes it", () => {
    const subs = [line(2)];
    expect(curveSegment(subs, [at(0, 0), at(0, 1)])).toBe(true);
    expect(subs[0]!.points[0]!.hOut).toEqual({ x: 10 / 3, y: 0 });
    straightenSegment(subs, [at(0, 0), at(0, 1)]);
    expect(subs[0]!.points[0]!.hOut).toBeNull();
  });

  it("duplicating yields a separate OPEN two-point run", () => {
    const subs = [line(4, true)];
    expect(duplicateSegment(subs, [at(0, 1), at(0, 2)])).toBe(true);
    expect(subs).toHaveLength(2);
    expect(subs[1]!.closed).toBe(false);
    expect(subs[1]!.points).toHaveLength(2);
    expect(subs[1]!.points[0]!.x).toBe(10 + 12);
    // The original is untouched.
    expect(subs[0]!.points).toHaveLength(4);
  });

  it("splitting inserts an anchor without moving the outline", () => {
    const subs = [line(3)];
    expect(splitSegment(subs, [at(0, 0), at(0, 1)])).toBe(1);
    expect(subs[0]!.points).toHaveLength(4);
    expect(subs[0]!.points[1]!.x).toBe(5); // midpoint of a straight run
  });

  it("every segment verb refuses a selection that names no segment", () => {
    const subs = [line(4)];
    const wide = [at(0, 0), at(0, 2)];
    expect(straightenSegment(subs, wide)).toBe(false);
    expect(curveSegment(subs, wide)).toBe(false);
    expect(duplicateSegment(subs, wide)).toBe(false);
    expect(splitSegment(subs, wide)).toBeNull();
    expect(subs).toHaveLength(1);
  });
});

describe("moving a node re-flows the curve around it", () => {
  /** Three anchors on a line, the middle one SMOOTH (mirrored arms). */
  const smoothRun = (): Contour[] => [
    {
      closed: false,
      points: [
        { x: 0, y: 0, hIn: null, hOut: { x: 10, y: 0 } },
        { x: 50, y: 0, hIn: { x: 40, y: 0 }, hOut: { x: 60, y: 0 } },
        { x: 100, y: 0, hIn: { x: 90, y: 0 }, hOut: null },
      ],
    },
  ];
  const armOut = (p: PathPoint) => ({ x: p.hOut!.x - p.x, y: p.hOut!.y - p.y });
  const len = (v: { x: number; y: number }) => Math.hypot(v.x, v.y);

  it("moves the anchor with its handles", () => {
    const subs = smoothRun();
    translateNodes(subs, [{ sub: 0, index: 1 }], 0, 30);
    expect(subs[0]!.points[1]).toMatchObject({ x: 50, y: 30 });
    expect(subs[0]!.points[1]!.hIn).toEqual({ x: 40, y: 30 });
  });

  it("re-aims a SMOOTH neighbour's tangent and keeps its length", () => {
    const subs = smoothRun();
    const before = len(armOut(subs[0]!.points[0]!));
    translateNodes(subs, [{ sub: 0, index: 1 }], 0, 30);
    const after = armOut(subs[0]!.points[0]!);
    // The endpoint now aims at where the middle anchor WENT, not where it was.
    expect(after.y).toBeGreaterThan(0);
    expect(len(after)).toBeCloseTo(before, 6);
  });

  it("leaves a CORNER neighbour alone", () => {
    const subs = smoothRun();
    subs[0]!.points[0]!.hOut = null; // a hard corner has nothing to re-aim
    subs[0]!.points[2]!.hIn = null;
    translateNodes(subs, [{ sub: 0, index: 1 }], 0, 30);
    expect(subs[0]!.points[0]).toMatchObject({ x: 0, y: 0, hOut: null });
    expect(subs[0]!.points[2]).toMatchObject({ x: 100, y: 0, hIn: null });
  });

  it("does not re-aim the node you dragged, or a neighbour that moved with it", () => {
    const subs = smoothRun();
    translateNodes(subs, [{ sub: 0, index: 0 }, { sub: 0, index: 1 }], 0, 30);
    // Both moved, so both keep the arms the artist steered — only the untouched
    // tail re-aims.
    expect(subs[0]!.points[1]!.hOut).toEqual({ x: 60, y: 30 });
    expect(subs[0]!.points[2]!.hIn!.y).toBeGreaterThan(0);
  });

  it("wraps on a closed run", () => {
    const subs: Contour[] = [
      {
        closed: true,
        points: [
          { x: 0, y: 0, hIn: { x: -10, y: 0 }, hOut: { x: 10, y: 0 } },
          { x: 50, y: 0, hIn: { x: 40, y: 0 }, hOut: { x: 60, y: 0 } },
          { x: 25, y: 40, hIn: { x: 35, y: 40 }, hOut: { x: 15, y: 40 } },
        ],
      },
    ];
    translateNodes(subs, [{ sub: 0, index: 0 }], 0, -40);
    // Index 2 is index 0's neighbour only because the run wraps.
    expect(subs[0]!.points[2]!.hOut!.y).not.toBe(40);
  });
});

describe("deleting nodes", () => {
  const pt = (x: number, y: number, weldId?: string): PathPoint => ({ x, y, hIn: null, hOut: null, ...(weldId ? { weldId } : {}) });
  it("drops the anchors, the subpaths too short to stay, and welds left joining nothing", () => {
    const subs = [
      { id: "a", closed: false, points: [pt(0, 0), pt(10, 0, "w"), pt(20, 0)] },
      { id: "b", closed: false, points: [pt(0, 5), pt(10, 5, "w")] },
    ];
    expect(deleteNodes(subs, [{ sub: 1, index: 0 }, { sub: 0, index: 2 }])).toBe(true);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.points.map((p) => p.x)).toEqual([0, 10]);
    expect(subs[0]!.points[1]!.weldId).toBeUndefined();
  });
  it("reports an emptied path so the caller removes the layer", () => {
    const subs = [{ id: "a", closed: false, points: [pt(0, 0), pt(1, 1)] }];
    expect(deleteNodes(subs, [{ sub: 0, index: 0 }])).toBe(false);
  });
});
