import { describe, expect, it } from "vitest";
import { createPictureFill } from "./picture-fill";

describe("createPictureFill", () => {
  it("lets the first make of a frame through, then holds the budget", () => {
    const fill = createPictureFill(10);
    fill.beginFrame();
    expect(fill.mayMake("a")).toBe(true);
    fill.made("a", 25);
    expect(fill.mayMake("b")).toBe(false);
  });

  it("spends the budget across several cheap makes", () => {
    const fill = createPictureFill(10);
    fill.beginFrame();
    for (const k of ["a", "b", "c"]) {
      expect(fill.mayMake(k)).toBe(true);
      fill.made(k, 3);
    }
    expect(fill.mayMake("d")).toBe(true);
    fill.made("d", 3);
    expect(fill.mayMake("e")).toBe(false);
  });

  it("takes turns: a comp drawn first does not starve the ones drawn after it", () => {
    const fill = createPictureFill(10);
    const order = ["a", "b", "c"];
    const madeBy: string[] = [];
    for (let frame = 0; frame < 6; frame++) {
      fill.beginFrame();
      for (const k of order) {
        if (fill.mayMake(k)) {
          fill.made(k, 20);
          madeBy.push(k);
        }
      }
    }
    // One per frame (each costs the whole budget), every comp in turn.
    expect(madeBy).toEqual(["a", "b", "c", "a", "b", "c"]);
  });

  it("closes a round only once every comp still owed has had its turn", () => {
    const fill = createPictureFill(10);
    fill.beginFrame();
    expect(fill.mayMake("a")).toBe(true);
    fill.made("a", 20);
    expect(fill.mayMake("b")).toBe(false); // refused for budget: b is owed
    fill.beginFrame();
    expect(fill.mayMake("a")).toBe(false); // a waits for b
    expect(fill.mayMake("b")).toBe(true);
    fill.made("b", 20);
    fill.beginFrame(); // nobody owed was refused: a new round
    expect(fill.mayMake("a")).toBe(true);
  });
});
