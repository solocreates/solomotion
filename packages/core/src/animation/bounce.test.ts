import { describe, expect, it } from "vitest";
import { cubicBezier } from "../easing";
import { bounceKeys, FALL, RISE } from "./bounce";

describe("bounce keys", () => {
  it("lands on the floor at every impact and on the end time, with decaying apexes", () => {
    const keys = bounceKeys(0, -300, 1000, 0, { count: 2, decay: 0.25 });
    // start, impact, apex, impact, apex — the caller's next key is the last landing.
    expect(keys.map((k) => k.value)).toEqual([-300, 0, -75, 0, -300 * 0.0625]);
    const last = keys.at(-1)!;
    // The last apex is followed by a fall of the same length as its rise.
    expect(1000 - last.at).toBeCloseTo(last.at - keys.at(-2)!.at, 6);
    expect(keys.map((k) => k.easing)).toEqual([FALL, RISE, FALL, RISE, FALL]);
  });

  it("falls as a parabola: the eased curve is t²", () => {
    const [x1, y1, x2, y2] = FALL.kind === "bezier" ? FALL.values : [0, 0, 1, 1];
    for (const t of [0.1, 0.35, 0.6, 0.9]) expect(cubicBezier(x1, y1, x2, y2, t)).toBeCloseTo(t * t, 4);
  });

  it("degenerates to a plain drop when there is nothing to fall", () => {
    expect(bounceKeys(0, 5, 100, 5)).toHaveLength(1);
  });
});
