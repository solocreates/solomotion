import { describe, expect, it } from "vitest";
import { createPathClip } from "../factories";
import { basisOfTransform, mapLocal } from "../transform-map";
import { pathBox } from "../pivot";
import { bakeClipAt } from "../world/evaluate";
import { setKeyframe } from "./keyframes";
import { pathOutlineAt, writePathOutline } from "./path-outline";
import type { PathClip, Subpath } from "../schema";

const line = (): Subpath[] => [{ id: "c1", closed: false, points: [{ x: -100, y: 0 }, { x: 0, y: -40 }, { x: 100, y: 0 }] } as Subpath];

/** Where point `i` of the outline the clip SHOWS at `t` lands, in comp space. */
function placed(clip: PathClip, i: number, t: number) {
  const at = bakeClipAt(clip, t) as PathClip;
  const subs = pathOutlineAt(clip, t);
  const p = subs[0]!.points[i]!;
  return mapLocal(p.x, p.y, basisOfTransform(at.transform, pathBox(subs)));
}

describe("writing a path's outline", () => {
  it("moving one point moves only that point (the pivot is held)", () => {
    const clip = createPathClip({ frameId: "f", startMs: 0, subpaths: line() });
    const before = [placed(clip, 0, 0), placed(clip, 1, 0)];
    const next = line();
    next[0]!.points[2] = { x: 400, y: 300, hIn: null, hOut: null };
    expect(writePathOutline(clip, next, 0)).toBe("base");
    const after = [placed(clip, 0, 0), placed(clip, 1, 0)];
    for (let i = 0; i < 2; i++) {
      expect(after[i]!.x).toBeCloseTo(before[i]!.x, 6);
      expect(after[i]!.y).toBeCloseTo(before[i]!.y, 6);
    }
  });

  it("an animated outline gets a key there — a morph — and nothing else moves, at any key", () => {
    const clip = createPathClip({ frameId: "f", startMs: 0, durationMs: 2000, subpaths: line() });
    const wide = line();
    wide[0]!.points[0] = { x: -300, y: 0, hIn: null, hOut: null };
    setKeyframe(clip.keyframes, "geometry", 0, line());
    setKeyframe(clip.keyframes, "geometry", 1000, wide);
    const atZero = [0, 1, 2].map((i) => placed(clip, i, 0));
    const atOneBefore = [0, 1].map((i) => placed(clip, i, 1000));
    const moved = wide.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) }));
    moved[0]!.points[2] = { x: 260, y: 220, hIn: null, hOut: null };
    expect(writePathOutline(clip, moved, 1000)).toBe("key");
    // The base is untouched; the key at 1000 is the new shape.
    expect(clip.subpaths[0]!.points[2]).toEqual({ x: 100, y: 0 });
    expect(pathOutlineAt(clip, 1000)[0]!.points[2]).toMatchObject({ x: 260, y: 220 });
    // At 1000 the untouched points held still…
    const atOneAfter = [0, 1].map((i) => placed(clip, i, 1000));
    for (let i = 0; i < 2; i++) {
      expect(atOneAfter[i]!.x).toBeCloseTo(atOneBefore[i]!.x, 6);
      expect(atOneAfter[i]!.y).toBeCloseTo(atOneBefore[i]!.y, 6);
    }
    // …and the OTHER key renders exactly as before.
    const again = [0, 1, 2].map((i) => placed(clip, i, 0));
    for (let i = 0; i < 3; i++) {
      expect(again[i]!.x).toBeCloseTo(atZero[i]!.x, 6);
      expect(again[i]!.y).toBeCloseTo(atZero[i]!.y, 6);
    }
  });

  it("recording keys a still outline", () => {
    const clip = createPathClip({ frameId: "f", startMs: 0, subpaths: line() });
    expect(writePathOutline(clip, line(), 500, { record: true })).toBe("key");
    expect(clip.keyframes.some((t) => t.property === "geometry")).toBe(true);
  });
});
