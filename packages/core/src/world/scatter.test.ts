import { describe, expect, it } from "vitest";
import { scatterOver } from "./scatter";
import { buildPrimitive } from "./primitives";
import { cardMesh } from "./body";
import { vertexCount } from "./mesh";

describe("scatter", () => {
  const plane = buildPrimitive("plane", { sizeX: 1000, sizeY: 1000 })!;
  const item = buildPrimitive("cube", { sizeX: 10, sizeY: 10, sizeZ: 10 })!;
  const opts = { count: 50, size: 1, sizeRandom: 0, turnRandom: 1, align: true, offset: 0, seed: 7, keep: true };

  it("spreads copies over the surface, standing on it, the same every time", () => {
    const a = scatterOver(plane, item, opts);
    expect(vertexCount(a)).toBe(vertexCount(plane) + 50 * vertexCount(item));
    // Every copy's points stand within its own size of the plane (z within ±5 of the plane's z).
    const z0 = plane.positions[2]!;
    for (let i = vertexCount(plane) * 3 + 2; i < a.positions.length; i += 3) expect(Math.abs(a.positions[i]! - z0)).toBeLessThanOrEqual(5 + 1e-6);
    expect(scatterOver(plane, item, opts).positions).toEqual(a.positions);
  });

  it("more copies only add copies — the first ones stay where they were", () => {
    const few = scatterOver(plane, item, { ...opts, count: 10 });
    const more = scatterOver(plane, item, { ...opts, count: 20 });
    expect(more.positions.slice(0, few.positions.length)).toEqual(few.positions);
  });

  it("without the surface, only the copies; a picture's colour rides on each copy", () => {
    const only = scatterOver(plane, item, { ...opts, keep: false, count: 5 });
    expect(vertexCount(only)).toBe(5 * vertexCount(item));
    const card = cardMesh({ minX: -100, minY: -50, maxX: 100, maxY: 50 }, 0);
    const worn = scatterOver(card, item, { ...opts, count: 3 });
    expect(worn.uv!.length).toBe(vertexCount(worn) * 2);
    // All points of one copy share one place on the picture.
    const base = vertexCount(card) * 2;
    for (let k = 1; k < vertexCount(item); k++) expect(worn.uv![base + k * 2]).toBe(worn.uv![base]);
  });
});
