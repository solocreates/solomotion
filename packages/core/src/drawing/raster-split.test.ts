import { describe, expect, it } from "vitest";
import { labelRegions, separateInkRegions } from "./raster-split";

/** An RGBA buffer with opaque rectangles painted into it. */
function canvas(w: number, h: number, rects: Array<[number, number, number, number]>) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (const [x, y, rw, rh] of rects) {
    for (let j = y; j < y + rh; j++) {
      for (let i = x; i < x + rw; i++) {
        const k = (j * w + i) * 4;
        px[k] = 255;
        px[k + 1] = 255;
        px[k + 2] = 255;
        px[k + 3] = 255;
      }
    }
  }
  return px;
}

describe("separating a paint layer", () => {
  it("finds one region per island of ink, largest first", () => {
    const px = canvas(64, 64, [[2, 2, 4, 4], [40, 40, 10, 10]]);
    const regions = labelRegions(px, 64, 64);
    expect(regions).toHaveLength(2);
    expect(regions[0]!.area).toBe(100);
    expect(regions[0]!.bounds).toEqual({ x0: 40, y0: 40, x1: 50, y1: 50 });
    expect(regions[1]!.bounds).toEqual({ x0: 2, y0: 2, x1: 6, y1: 6 });
  });

  it("ink that touches is ONE piece, diagonals included", () => {
    const px = canvas(32, 32, [[4, 4, 4, 4], [8, 8, 4, 4]]);
    expect(labelRegions(px, 32, 32)).toHaveLength(1);
  });

  it("a soft brush's near-transparent tail is not ink", () => {
    const px = canvas(32, 32, [[2, 2, 4, 4], [20, 20, 4, 4]]);
    // A film of alpha 4 across the whole layer would join them if it counted.
    for (let i = 3; i < px.length; i += 4) if (px[i] === 0) px[i] = 4;
    expect(labelRegions(px, 32, 32)).toHaveLength(2);
  });

  it("never throws ink away: specks fold into the nearest real piece", () => {
    const px = canvas(64, 64, [[10, 10, 20, 20], [33, 20, 1, 1]]);
    const regions = separateInkRegions(px, 64, 64);
    expect(regions).toHaveLength(1);
    // The speck is inside the survivor's mask and its box.
    expect(regions[0]!.mask[20 * 64 + 33]).toBe(1);
    expect(regions[0]!.bounds.x1).toBe(34);
  });

  it("an empty layer has nothing to separate", () => {
    expect(labelRegions(canvas(16, 16, []), 16, 16)).toHaveLength(0);
  });
});
