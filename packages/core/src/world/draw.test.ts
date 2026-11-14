import { describe, expect, it } from "vitest";
import { createEmptyDocument, createPathClip, type Contour } from "..";
import { placeClip } from "../timeline/place";
import { createWorld } from "./ops";
import { evaluateWorld } from "./evaluate";
import { planeBasis, planeToLocal } from "./plane";
import { cross, normalize3, transformPoint, type V3 } from "./math";
import { contoursHaveDepth, fromPage, inkInSpace, landContours, pageFor, pageForward, pathOnPage, toPage, type DrawPage } from "./draw";

/** A curvy stroke whose handles overshoot its anchors — the shape the old centring got wrong. */
const curvy = (): Contour[] => [
  {
    closed: false,
    points: [
      { x: 0, y: 0, hIn: null, hOut: { x: 40, y: -90 } },
      { x: 120, y: 10, hIn: { x: 90, y: 120 }, hOut: { x: 150, y: -60 } },
      { x: 220, y: 30, hIn: { x: 200, y: 140 }, hOut: null },
    ],
  },
];

const tilted: DrawPage = (() => {
  const right = normalize3([0.8, 0.6, 0]);
  const up = normalize3(cross(right, normalize3([0.3, -0.4, -0.86])));
  return { anchor: [120, -40, 300], right, up: cross(cross(right, up), right) as V3 };
})();

describe("a stroke drawn in space lands where it was drawn", () => {
  it("every anchor of a new layer sits on its drawn world point (no jump on commit)", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    for (const page of [tilted, { anchor: [0, 0, 0] as V3, right: [1, 0, 0] as V3, up: [0, 0, 1] as V3 }]) {
      const drawn = curvy();
      const worldOf = drawn[0]!.points.map((p) => fromPage(page, p));
      const placed = pathOnPage(drawn, page)!;
      const clip = createPathClip({ frameId: frame.id, subpaths: placed.subpaths, startMs: 0, durationMs: 1000, fill: null });
      clip.transform = { ...clip.transform, ...placed.transform };
      placeClip(doc, clip, { landing: "surface" });
      const o = evaluateWorld(doc, frame, 0).objects.find((x) => x.id === clip.id)!;
      const basis = planeBasis(doc, clip);
      clip.subpaths[0]!.points.forEach((p, i) => {
        const w = transformPoint(o.matrix, planeToLocal(basis, p));
        for (let k = 0; k < 3; k++) expect(w[k]).toBeCloseTo(worldOf[i]![k]!, 4);
      });
    }
  });

  it("a page's coordinates round-trip and face the eye", () => {
    const p = { x: 31, y: -17, z: 4 };
    const back = toPage(tilted, fromPage(tilted, p));
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
    expect(back.z).toBeCloseTo(p.z, 9);
    // Seen from behind, an axis page turns round rather than showing its back.
    const fromFront = pageFor("front", { right: [1, 0, 0], up: [0, 0, 1], forward: [0, 1, 0] }, [0, 0, 0]);
    const fromBehind = pageFor("front", { right: [-1, 0, 0], up: [0, 0, 1], forward: [0, -1, 0] }, [0, 0, 0]);
    expect(pageForward(fromFront)[1]).toBeGreaterThan(0.99);
    expect(pageForward(fromBehind)[1]).toBeLessThan(-0.99);
    expect(fromBehind.up).toEqual([0, 0, 1]);
  });

  it("landing keeps anchors on the drawing and handles on the page; a point that lands nowhere drops the stroke", () => {
    const page: DrawPage = { anchor: [0, 0, 0], right: [1, 0, 0], up: [0, 0, 1] };
    // A "surface" 10 units in front of the page under x > 100; the page elsewhere.
    const onPage = (x: number, y: number): V3 => fromPage(page, { x, y });
    const surface = (x: number, y: number): V3 => fromPage(page, { x, y, z: x > 100 ? -10 : 0 });
    const landed = landContours(curvy(), surface, onPage, (w) => toPage(page, w))!;
    const pts = landed[0]!.points;
    expect(pts[0]!.z).toBeUndefined();
    expect(pts[1]!.z).toBeCloseTo(-10, 9);
    expect(pts[1]!.hIn).toEqual({ x: 90, y: 120 });
    expect(contoursHaveDepth(landed)).toBe(true);
    expect(landContours(curvy(), (x) => (x > 200 ? null : onPage(x, 0)), onPage, (w) => toPage(page, w))).toBeNull();
  });

  it("ink scales with the geometry, and its look scales with it through baseWidth", () => {
    const ink = inkInSpace([{ width: 6, baseWidth: 6 } as never], 2.5);
    expect(ink[0]!.width).toBeCloseTo(15, 9);
    expect(ink[0]!.baseWidth).toBe(6);
  });
});
