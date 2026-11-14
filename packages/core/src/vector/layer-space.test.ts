import { describe, expect, it } from "vitest";
import { createEmptyDocument, createPathClip, createTrack } from "../factories";
import type { MotionDocument, PathClip } from "../schema";
import { setPathGeometry } from "../pivot";
import { strokeStyle, solidPaint } from "../schema/vector";
import { contoursToLayer, layerSpace, strokesToLayer } from "./layer-space";

const pt = (x: number, y: number) => ({ x, y, hIn: null, hOut: null });
const box = (x: number, y: number, w: number, h: number) => ({
  closed: true,
  points: [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)],
});

function docWith(subpaths: ReturnType<typeof box>[]): { doc: MotionDocument; clip: PathClip } {
  const doc = createEmptyDocument();
  const clip = createPathClip({
    frameId: doc.frames[0]!.id,
    subpaths,
    startMs: 0,
    durationMs: 2000,
    name: "Drawing",
  });
  const track = createTrack("t");
  track.clips.push(clip);
  doc.tracks.push(track);
  return { doc, clip };
}

/** A pose with nothing left at its identity — every term must survive the round trip. */
function poseIt(clip: PathClip): void {
  clip.transform.x = 37;
  clip.transform.y = -14;
  clip.transform.scale = 1.6;
  clip.transform.scaleY = 0.75;
  clip.transform.rotation = 23;
  clip.transform.skewX = 11;
  clip.transform.skewY = -7;
  clip.transform.anchor = { x: 0.2, y: 0.85 };
}

describe("layerSpace", () => {
  it("is the exact inverse of the forward map under a full pose", () => {
    const { doc, clip } = docWith([box(120, 60, 40, 30)]);
    poseIt(clip);
    const space = layerSpace(doc, clip, 0);
    for (const [x, y] of [[0, 0], [200, -90], [-45, 310]] as const) {
      const back = space.toFrame(...(Object.values(space.at(x, y)) as [number, number]));
      expect(back.x).toBeCloseTo(x, 6);
      expect(back.y).toBeCloseTo(y, 6);
    }
  });

  /**
   * THE regression. A path's box is derived from its outline, so appending art
   * moves `box.cx`. The overlay used to add that offset onto `unmapLocal`'s
   * already-geometry-space answer, so the same frame point mapped to a
   * different geometry point after every stroke — the first line landed and
   * every one after it drifted.
   */
  it("maps a frame point to the same place no matter where the outline sits", () => {
    const { doc, clip } = docWith([box(-20, -15, 40, 30)]);
    poseIt(clip);
    const before = layerSpace(doc, clip, 0).at(90, 45);
    const seen = layerSpace(doc, clip, 0).toFrame(before.x, before.y);

    // Grow the artwork far off-origin, exactly as a second brush stroke does —
    // through the seam that rebases the pivot, so nothing is supposed to move.
    setPathGeometry(clip, [...clip.subpaths, { ...box(400, 300, 60, 60), id: "sub_2" }]);

    const after = layerSpace(doc, clip, 0).at(90, 45);
    // The geometry coordinate is unchanged, and it still paints where it did.
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    const now = layerSpace(doc, clip, 0).toFrame(after.x, after.y);
    expect(now.x).toBeCloseTo(seen.x, 6);
    expect(now.y).toBeCloseTo(seen.y, 6);
  });

  it("carries handles as points, so a drawn curve keeps its shape", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10)]);
    poseIt(clip);
    const space = layerSpace(doc, clip, 0);
    const drawn = [{
      closed: false,
      points: [
        { x: 10, y: 20, hIn: null, hOut: { x: 25, y: 20 } },
        { x: 60, y: 80, hIn: { x: 45, y: 80 }, hOut: null },
      ],
    }];
    const local = contoursToLayer(drawn, space);
    const p0 = local[0]!.points[0]!;
    const p1 = local[0]!.points[1]!;
    for (const [got, want] of [
      [p0, { x: 10, y: 20 }],
      [p1, { x: 60, y: 80 }],
      [p0.hOut!, { x: 25, y: 20 }],
      [p1.hIn!, { x: 45, y: 80 }],
    ] as const) {
      const back = space.toFrame(got.x, got.y);
      expect(back.x).toBeCloseTo(want.x, 6);
      expect(back.y).toBeCloseTo(want.y, 6);
    }
  });

  it("carries the INK into the layer's space with the geometry", () => {
    // Half a conversion is the bug: the outline was mapped and the width was
    // not, so a 50px stroke appended to a layer at 200% came back 100px. The
    // geometry landed perfectly, which is what made it read as the width being
    // thrown away rather than converted.
    const { doc, clip } = docWith([box(0, 0, 10, 10)]);
    clip.transform.scale = 2;
    clip.transform.scaleY = 2;
    const space = layerSpace(doc, clip, 0);
    const ink = { ...strokeStyle(solidPaint("#fff")), width: 50, baseWidth: 10 };
    const [local] = strokesToLayer([ink], space);
    expect(local!.width).toBeCloseTo(25, 6);
    // `baseWidth` deliberately stays: `strokeAtWidth` derives the dash, the
    // wave and the roughness from width/baseWidth, so leaving the reference
    // alone carries the whole pipeline into the layer's space too.
    expect(local!.baseWidth).toBe(10);
  });
});
