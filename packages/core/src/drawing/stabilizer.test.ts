import { describe, expect, it } from "vitest";
import {
  SHIFT_SMOOTHING,
  createStabilizer,
  effectiveSmoothing,
  stabilizerPush,
  stabilizerRadius,
  type StabPoint,
} from "./stabilizer";

/** Feed a whole gesture through the filter and return what the tool drew. */
function run(path: StabPoint[], radius: number): StabPoint[] {
  const s = createStabilizer(path[0]!, radius);
  const out: StabPoint[] = [path[0]!];
  for (const p of path) out.push(...stabilizerPush(s, p, radius));
  return out;
}

/** A rightward sweep along y = 0. */
const sweep = (n = 60, step = 4): StabPoint[] =>
  Array.from({ length: n }, (_, i) => ({ x: i * step, y: 0 }));

describe("the release", () => {
  it("leaves the stroke exactly where the tool was", () => {
    // THE CONTRACT. Under smoothing the tool trails the cursor by up to a
    // leash, that lag is visible the whole time you draw, and lifting must not
    // change it. Three earlier versions caught up to the cursor in three
    // different ways and all three read the same on the canvas: a tail that
    // appeared after you had stopped drawing, hooking the line forward to meet
    // the pointer.
    const radius = 40;
    const path = sweep();
    const s = createStabilizer(path[0]!, radius);
    for (const p of path) stabilizerPush(s, p, radius);

    const drawn = { ...s.point };
    expect(run(path, radius).at(-1)).toEqual(drawn);
    // ...and it is genuinely behind the hand, which is what smoothing IS.
    expect(s.cursor.x - drawn.x).toBeCloseTo(radius, 4);
  });

  it("marks a tap, where there is no travel to leave behind", () => {
    const s = createStabilizer({ x: 10, y: 10 }, 40);
    stabilizerPush(s, { x: 12, y: 11 }, 40); // inside the leash: no travel yet
    expect(s.point).toEqual({ x: 10, y: 10 });
  });

  it("keeps the drawn line inside the tremor it filtered out", () => {
    const radius = 50;
    const path = Array.from({ length: 80 }, (_, i) => ({
      x: i * 3,
      y: Math.sin(i * 1.7) * 6 + Math.sin(i * 0.4) * 3,
    }));
    const worst = Math.max(...run(path, radius).map((p) => Math.abs(p.y)));
    expect(worst).toBeLessThan(6);
  });
});

describe("effectiveSmoothing", () => {
  it("is the tool's own setting with no modifier", () => {
    expect(effectiveSmoothing(0.8, false)).toBe(0.8);
    expect(effectiveSmoothing(0, false)).toBe(0);
  });

  it("⇧ reverses it in BOTH directions", () => {
    expect(effectiveSmoothing(0, true)).toBe(SHIFT_SMOOTHING);
    expect(effectiveSmoothing(0.8, true)).toBe(0);
  });

  it("clamps a setting from outside the UI", () => {
    expect(effectiveSmoothing(-1, false)).toBe(0);
    expect(effectiveSmoothing(4, false)).toBe(1);
    expect(effectiveSmoothing(4, true)).toBe(0);
  });

  it("drives the leash, so ⇧ turns a smoothed tool loose", () => {
    expect(stabilizerRadius(0.8, true)).toBe(0);
    expect(stabilizerRadius(0, true)).toBeGreaterThan(0);
  });
});
