import { describe, expect, it } from "vitest";
import { createPathClip } from "./factories";
import { editPathGeometry, pathBox, setPathGeometry } from "./pivot";
import { anchorLocal, mapLocal, type LayerBasis } from "./transform-map";
import type { PathClip, Subpath } from "./schema";

/** A 200×100 rectangle-ish outline, centred on the clip's origin. */
const box200x100 = (): Subpath[] => [
  {
    id: "s0",
    closed: true,
    points: [
      { x: -100, y: -50, hIn: null, hOut: null },
      { x: 100, y: -50, hIn: null, hOut: null },
      { x: 100, y: 50, hIn: null, hOut: null },
      { x: -100, y: 50, hIn: null, hOut: null },
    ],
  },
];

const clipWithPivot = (anchor: { x: number; y: number }): PathClip => {
  const clip = createPathClip({ frameId: "f", subpaths: box200x100(), startMs: 0 });
  clip.transform = { ...clip.transform, scale: 2, scaleY: 3, rotation: 37, skewX: 12, skewY: -5, anchor };
  return clip;
};

/** Where a local point lands, in world offsets from the clip's position. */
const world = (clip: PathClip, p: { x: number; y: number }) => {
  const t = clip.transform;
  const b: LayerBasis = {
    scale: t.scale,
    scaleY: t.scaleY ?? t.scale,
    rotation: t.rotation,
    skewX: t.skewX,
    skewY: t.skewY,
    anchor: t.anchor,
    size: pathBox(clip.subpaths),
  };
  return mapLocal(p.x, p.y, b);
};

describe("editing a path's geometry", () => {
  it("moves ONLY the node you dragged, however far off-centre the pivot is", () => {
    // The reported bug: with a pivot placed anywhere but the centre, dragging one
    // node used to slide the entire shape, because the pivot is a fraction of a
    // box the drag had just resized.
    for (const anchor of [{ x: 0.5, y: 0.5 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1.6, y: 0.2 }]) {
      const clip = clipWithPivot(anchor);
      const untouched = { x: -100, y: 50 };
      const was = world(clip, untouched);
      editPathGeometry(clip, (subs) => {
        subs[0]!.points[1]!.x = 200; // drag the top-right node 100px right
      });
      const now = world(clip, untouched);
      expect(now.x).toBeCloseTo(was.x, 9);
      expect(now.y).toBeCloseTo(was.y, 9);
    }
  });

  it("leaves the pivot on the same point of the art (it is not dragged along)", () => {
    const clip = clipWithPivot({ x: 1, y: 1 }); // bottom-right corner
    const before = anchorLocal(clip.transform.anchor, pathBox(clip.subpaths));
    editPathGeometry(clip, (subs) => {
      subs[0]!.points[1]!.x = 200;
    });
    const after = anchorLocal(clip.transform.anchor, pathBox(clip.subpaths));
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    // ...and it is no longer the bottom-right corner, because the corner moved
    // and the pivot deliberately did not.
    // local x 100, in a box that is now 300 wide centred at x=50.
    expect(clip.transform.anchor.x).toBeCloseTo(0.5 + (100 - 50) / 300, 9);
  });

  it("rebases keyframed pivots too, so animated frames don't drift", () => {
    const clip = clipWithPivot({ x: 1, y: 0.5 });
    clip.keyframes.push({
      id: "t1",
      property: "anchor.x",
      range: null,
      keys: [
        { id: "k0", timeMs: 0, value: 0, easing: { kind: "linear" } },
        { id: "k1", timeMs: 500, value: 1, easing: { kind: "linear" } },
      ],
    });
    const boxBefore = pathBox(clip.subpaths);
    const localBefore = [0, 1].map((v) => anchorLocal({ x: v, y: 0.5 }, boxBefore).x);
    editPathGeometry(clip, (subs) => {
      subs[0]!.points[1]!.x = 200;
    });
    const boxAfter = pathBox(clip.subpaths);
    const keys = clip.keyframes[0]!.keys.map((k) => k.value as number);
    expect(anchorLocal({ x: keys[0]!, y: 0.5 }, boxAfter).x).toBeCloseTo(localBefore[0]!, 9);
    expect(anchorLocal({ x: keys[1]!, y: 0.5 }, boxAfter).x).toBeCloseTo(localBefore[1]!, 9);
  });

  it("holds the pivot through a wholesale outline swap (bake, knife, paste)", () => {
    const clip = clipWithPivot({ x: 0, y: 1 });
    const untouched = { x: -100, y: -50 };
    const was = world(clip, untouched);
    const swapped = box200x100();
    swapped[0]!.points.push({ x: 300, y: 400, hIn: null, hOut: null });
    setPathGeometry(clip, swapped);
    const now = world(clip, untouched);
    expect(now.x).toBeCloseTo(was.x, 9);
    expect(now.y).toBeCloseTo(was.y, 9);
  });

  it("is a no-op when the edit doesn't change the box", () => {
    const clip = clipWithPivot({ x: 0.25, y: 0.75 });
    editPathGeometry(clip, (subs) => {
      subs[0]!.points[0]!.hOut = { x: -50, y: -50 }; // a handle inside the box
    });
    expect(clip.transform.anchor).toEqual({ x: 0.25, y: 0.75 });
  });
});
