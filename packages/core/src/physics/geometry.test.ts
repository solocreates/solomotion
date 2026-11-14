import { describe, expect, it } from "vitest";
import { convexHull, convexPieces, isConvex, outlinePolygons, signedArea2, triangulate, type P2 } from "./geometry";
import { shapeCommands } from "../vector/geometry";

const area = (p: readonly P2[]) => signedArea2(p) / 2;

describe("collider geometry", () => {
  it("measures area with the winding's sign", () => {
    expect(area([[0, 0], [1, 0], [1, 1], [0, 1]])).toBeCloseTo(1, 9);
    expect(area([[0, 1], [1, 1], [1, 0], [0, 0]])).toBeCloseTo(-1, 9);
  });

  it("cuts an L into convex pieces that cover it exactly", () => {
    const L: P2[] = [[0, 0], [30, 0], [30, 10], [10, 10], [10, 40], [0, 40]];
    const pieces = convexPieces(L);
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    expect(pieces.length).toBeLessThanOrEqual(3);
    for (const p of pieces) expect(isConvex(p)).toBe(true);
    expect(pieces.reduce((s, p) => s + area(p), 0)).toBeCloseTo(area(L), 6);
  });

  it("cuts a five-point star into few convex pieces of the same area, and its hull is the five tips", () => {
    const star = outlinePolygons(shapeCommands({ shape: "star", width: 200, height: 200, pointCount: 5, innerRatio: 0.45, radius: 0, cornerRadius: 0 } as never), 200)[0]!;
    expect(star.length).toBe(10);
    const pieces = convexPieces(star);
    expect(pieces.length).toBeLessThanOrEqual(8);
    expect(pieces.reduce((s, p) => s + area(p), 0)).toBeCloseTo(area(star), 3);
    expect(convexHull(star).length).toBe(5);
  });

  it("triangulates any simple polygon into n − 2 triangles", () => {
    const comb: P2[] = [[0, 0], [50, 0], [50, 20], [40, 20], [40, 5], [30, 5], [30, 20], [20, 20], [20, 5], [10, 5], [10, 20], [0, 20]];
    expect(triangulate(comb)).toHaveLength(comb.length - 2);
    expect(convexPieces(comb).every(isConvex)).toBe(true);
  });

  it("fills holes: an O is one solid disc", () => {
    const ring = outlinePolygons(
      [
        ...shapeCommands({ shape: "ellipse", width: 100, height: 100 } as never),
        ...shapeCommands({ shape: "ellipse", width: 60, height: 60 } as never),
      ],
      100,
    );
    expect(ring).toHaveLength(1);
    expect(area(ring[0]!)).toBeGreaterThan(0);
  });
});
