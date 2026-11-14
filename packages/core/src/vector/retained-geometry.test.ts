import { describe, expect, it } from "vitest";
import { pathCommands, subpathBounds } from "./geometry";
import type { Contour } from "../schema/vector";

const square = (x: number): Contour => ({
  closed: true,
  points: [
    { x, y: 0 },
    { x: x + 10, y: 0 },
    { x: x + 10, y: 10 },
    { x, y: 10 },
  ],
}) as Contour;

describe("retained geometry", () => {
  it("compiles a frozen outline once and hands back the same frozen answer", () => {
    const outline = Object.freeze([Object.freeze(square(0)), Object.freeze(square(20))]) as ReadonlyArray<Contour>;
    const a = pathCommands(outline);
    expect(pathCommands(outline)).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(subpathBounds(outline)).toBe(subpathBounds(outline));
    expect(subpathBounds(outline)).toEqual({ minX: 0, minY: 0, maxX: 30, maxY: 10 });
  });

  it("recomputes a mutable working copy every time (a pen draft can change under it)", () => {
    const draft = [square(0)];
    const a = pathCommands(draft);
    draft.push(square(20));
    const b = pathCommands(draft);
    expect(b).not.toBe(a);
    expect(b.length).toBeGreaterThan(a.length);
    expect(subpathBounds(draft)!.maxX).toBe(30);
  });
});
