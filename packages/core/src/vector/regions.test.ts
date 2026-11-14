import { describe, expect, it } from "vitest";
import type { Contour } from "../schema";
import { isSeparable, regionIsSubdivided, separateRegions } from "./regions";

const pt = (x: number, y: number) => ({ x, y, hIn: null, hOut: null });

/** An axis-aligned box, wound CW (positive area under this ring convention). */
const box = (x: number, y: number, w: number, h: number): Contour => ({
  closed: true,
  points: [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)],
});

/** The same box wound the other way — a hole under the nonzero rule. */
const hole = (x: number, y: number, w: number, h: number): Contour => ({
  closed: true,
  points: [pt(x, y), pt(x, y + h), pt(x + w, y + h), pt(x + w, y)],
});

describe("separateRegions", () => {
  it("keeps a donut whole — a hole is not a piece of artwork", () => {
    // The whole reason contours share a clip: a hole cannot have its own fill.
    const regions = separateRegions([box(0, 0, 100, 100), hole(25, 25, 50, 50)]);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.indices).toEqual([0, 1]);
  });

  it("splits contours that merely sit beside each other", () => {
    const regions = separateRegions([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    expect(regions).toHaveLength(2);
    expect(regions.map((r) => r.indices)).toEqual([[0], [1]]);
  });

  it("frees an island inside a hole — the dot in a counter is its own piece", () => {
    const regions = separateRegions([
      box(0, 0, 100, 100),
      hole(20, 20, 60, 60),
      box(40, 40, 20, 20),
    ]);
    expect(regions).toHaveLength(2);
    expect(regions[0]!.indices).toEqual([0, 1]); // shape + its hole
    expect(regions[1]!.indices).toEqual([2]); // the island
  });

  it("under nonzero, a same-winding nested contour is painted solid — its own piece", () => {
    // This is what nonzero MEANS. Sharing one branch with even-odd would make
    // a same-wound inner box vanish into its container as a phantom hole.
    const regions = separateRegions([box(0, 0, 100, 100), box(25, 25, 50, 50)], "nonzero");
    expect(regions).toHaveLength(2);
  });

  it("under evenodd, any nesting is a hole regardless of winding", () => {
    const regions = separateRegions([box(0, 0, 100, 100), box(25, 25, 50, 50)], "evenodd");
    expect(regions).toHaveLength(1);
    expect(regions[0]!.indices).toEqual([0, 1]);
  });

  it("assigns a hole to its TIGHTEST container, not the outermost", () => {
    const regions = separateRegions(
      [box(0, 0, 200, 200), hole(10, 10, 180, 180), box(50, 50, 80, 80), hole(60, 60, 20, 20)],
      "nonzero",
    );
    // outer+its hole, then the inner island+its own hole.
    expect(regions).toHaveLength(2);
    expect(regions[0]!.indices).toEqual([0, 1]);
    expect(regions[1]!.indices).toEqual([2, 3]);
  });

  it("keeps an open squiggle as a piece — it encloses nothing but it IS artwork", () => {
    const squiggle: Contour = { closed: false, points: [pt(200, 200), pt(210, 205)] };
    const regions = separateRegions([box(0, 0, 100, 100), squiggle]);
    expect(regions).toHaveLength(2);
  });

  it("an open stroke drawn INSIDE a shape is still its own piece", () => {
    // Hole-ness requires an enclosed area. A line drawn across a shape is a
    // line you would want to colour, so it never dissolves into its container
    // — under either fill rule.
    const squiggle: Contour = { closed: false, points: [pt(40, 40), pt(60, 60)] };
    expect(separateRegions([box(0, 0, 100, 100), squiggle], "evenodd")).toHaveLength(2);
    expect(separateRegions([box(0, 0, 100, 100), squiggle], "nonzero")).toHaveLength(2);
  });

  it("loses nothing and reorders stably", () => {
    const input = [box(0, 0, 100, 100), box(200, 0, 10, 10), hole(25, 25, 50, 50)];
    const out = separateRegions(input).flatMap((r) => r.indices);
    expect([...out].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(out).toEqual([0, 2, 1]); // hole follows its owner; pieces keep order
  });

  it("survives identical overlapping contours instead of looping forever", () => {
    const regions = separateRegions([box(0, 0, 50, 50), box(0, 0, 50, 50)]);
    expect(regions.flatMap((r) => r.indices).sort()).toEqual([0, 1]);
  });

  it("handles the empty and single cases without touching geometry", () => {
    expect(separateRegions([])).toEqual([]);
    expect(separateRegions([box(0, 0, 10, 10)])).toHaveLength(1);
  });
});

describe("isSeparable", () => {
  it("is false for a donut and true for two shapes", () => {
    expect(isSeparable([box(0, 0, 100, 100), hole(25, 25, 50, 50)])).toBe(false);
    expect(isSeparable([box(0, 0, 10, 10), box(50, 0, 10, 10)])).toBe(true);
    expect(isSeparable([box(0, 0, 10, 10)])).toBe(false);
  });
});

describe("regionIsSubdivided — the bucket's gate on the exact-geometry shortcut", () => {
  /** An open two-point line, the shape a pen chord actually has. */
  const line = (x1: number, y1: number, x2: number, y2: number): Contour => ({
    closed: false,
    points: [pt(x1, y1), pt(x2, y2)],
  });
  const regionOf = (contours: Contour[]) => separateRegions(contours)[0]!;

  it("a chord across the shape subdivides it — the reported bug", () => {
    const square = regionOf([box(0, 0, 100, 100)]);
    // Corner to corner: both endpoints sit ON the boundary, the midpoint does not.
    expect(regionIsSubdivided(square, [line(0, 0, 100, 100)])).toBe(true);
  });

  it("artwork beside it, or touching one edge, does not", () => {
    const square = regionOf([box(0, 0, 100, 100)]);
    expect(regionIsSubdivided(square, [box(200, 0, 50, 50)])).toBe(false);
    expect(regionIsSubdivided(square, [line(0, 0, 0, 100)])).toBe(false);
  });

  it("an island inside DOES — the face is a donut, which is what the flood traced", () => {
    const square = regionOf([box(0, 0, 100, 100)]);
    expect(regionIsSubdivided(square, [box(30, 30, 20, 20)])).toBe(true);
  });

  it("a region is never subdivided by its own hole", () => {
    const donut = regionOf([box(0, 0, 100, 100), hole(30, 30, 40, 40)]);
    expect(donut.contours).toHaveLength(2);
    expect(regionIsSubdivided(donut, donut.contours)).toBe(false);
  });

  it("a shape with no inside cannot be cut up", () => {
    const open = regionOf([line(0, 0, 100, 0)]);
    expect(regionIsSubdivided(open, [line(50, -50, 50, 50)])).toBe(false);
  });
});
