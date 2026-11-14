import { describe, expect, it } from "vitest";
import { applyBend, beginBend, bendControls, bendWeight, cubicAt, nearestT, segmentControls } from "./bend";
import { isSmoothNode } from "./edit-engine";
import type { Contour } from "../schema";

const line = (): Contour[] => [
  { closed: false, points: [{ x: 0, y: 0, hIn: null, hOut: null }, { x: 300, y: 0, hIn: null, hOut: null }] } as Contour,
];

/** Distance from `p` to the sampled curve of segment 0 of sub 0. */
const distToCurve = (subs: Contour[], p: { x: number; y: number }) => {
  const c = segmentControls(subs[0]!, 0)!;
  let best = Infinity;
  for (let i = 0; i <= 2000; i++) {
    const q = cubicAt(...c, i / 2000);
    best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y));
  }
  return best;
};

describe("segment bend — the curve passes through the pointer", () => {
  it("bends a straight line through the pointer at the grabbed point", () => {
    const subs = line();
    const grab = beginBend(subs, 0, 0, { x: 100, y: 0 })!;
    expect(grab.t).toBeCloseTo(1 / 3, 3);
    const to = { x: 120, y: -80 };
    applyBend(subs, grab, to);
    const q = cubicAt(...segmentControls(subs[0]!, 0)!, grab.t);
    expect(q.x).toBeCloseTo(to.x, 3);
    expect(q.y).toBeCloseTo(to.y, 3);
    // Anchors never move.
    expect(subs[0]!.points[0]).toMatchObject({ x: 0, y: 0 });
    expect(subs[0]!.points[1]).toMatchObject({ x: 300, y: 0 });
  });

  it("hits the pointer exactly at every grab position along an S-curve", () => {
    for (const gx of [0.1, 0.25, 0.5, 0.7, 0.93]) {
      const subs: Contour[] = [
        {
          closed: false,
          points: [
            { x: 0, y: 0, hIn: null, hOut: { x: 80, y: -120 } },
            { x: 300, y: 40, hIn: { x: 200, y: 160 }, hOut: null },
          ],
        } as Contour,
      ];
      const c = segmentControls(subs[0]!, 0)!;
      const at = cubicAt(...c, gx);
      const grab = beginBend(subs, 0, 0, at)!;
      const to = { x: at.x + 37, y: at.y + 55 };
      applyBend(subs, grab, to);
      expect(distToCurve(subs, to)).toBeLessThan(0.05);
    }
  });

  it("is computed from the press: dragging back restores the original curve", () => {
    const subs = line();
    const grab = beginBend(subs, 0, 0, { x: 150, y: 0 })!;
    applyBend(subs, grab, { x: 150, y: 90 });
    applyBend(subs, grab, { x: 160, y: -40 });
    applyBend(subs, grab, { x: 150, y: 0 });
    const [, p1, p2] = segmentControls(subs[0]!, 0)!;
    // The neutral third-of-chord arms: the same straight line it started as.
    expect(p1.x).toBeCloseTo(100, 9);
    expect(p1.y).toBeCloseTo(0, 9);
    expect(p2.x).toBeCloseTo(200, 9);
    expect(p2.y).toBeCloseTo(0, 9);
  });

  it("a grab near one anchor moves mostly that anchor's handle", () => {
    const g = beginBend(line(), 0, 0, { x: 30, y: 0 })!;
    const { p1, p2 } = bendControls(g, { x: 30, y: 50 });
    expect(Math.abs(p1.y)).toBeGreaterThan(0);
    expect(p2.y).toBe(0);
    expect(bendWeight(0.1)).toBe(0);
    expect(bendWeight(0.9)).toBe(1);
    expect(bendWeight(0.5)).toBeCloseTo(0.5, 9);
  });

  it("keeps a smooth anchor smooth (the far arm turns with the bent one)", () => {
    const subs: Contour[] = [
      {
        closed: false,
        points: [
          { x: 0, y: 0, hIn: null, hOut: null },
          { x: 100, y: 0, hIn: { x: 70, y: 0 }, hOut: { x: 140, y: 0 } },
          { x: 200, y: 0, hIn: null, hOut: null },
        ],
      } as Contour,
    ];
    const grab = beginBend(subs, 0, 0, { x: 50, y: 0 })!;
    applyBend(subs, grab, { x: 50, y: -60 });
    const mid = subs[0]!.points[1]!;
    expect(isSmoothNode(mid)).toBe(true);
    expect(Math.hypot(mid.hOut!.x - 100, mid.hOut!.y)).toBeCloseTo(40, 6);
  });

  it("works on the closing segment of a loop", () => {
    const subs: Contour[] = [
      {
        closed: true,
        points: [
          { x: 0, y: 0, hIn: null, hOut: null },
          { x: 100, y: 0, hIn: null, hOut: null },
          { x: 100, y: 100, hIn: null, hOut: null },
        ],
      } as Contour,
    ];
    const grab = beginBend(subs, 0, 2, { x: 50, y: 50 })!;
    applyBend(subs, grab, { x: 20, y: 70 });
    const q = cubicAt(...segmentControls(subs[0]!, 2)!, grab.t);
    expect(q.x).toBeCloseTo(20, 3);
    expect(q.y).toBeCloseTo(70, 3);
  });

  it("nearestT finds the parameter of a point on the curve", () => {
    const c = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 300, y: 0 }] as const;
    expect(nearestT(...c, { x: 75, y: 20 })).toBeCloseTo(0.25, 3);
  });
});
