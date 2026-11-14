import { describe, expect, it } from "vitest";
import { createRasterClip } from "../factories";
import { mapLocal } from "../transform-map";
import { canGrowRaster, growRasterClip, grownRaster, padFor, GROW_BLOCK_PX } from "./canvas-bounds";

/**
 * The one property that matters: growing a layer must not MOVE it.
 *
 * A pixel at `px,py` in the old surface is at `px+left, py+top` in the new one,
 * and both must map to the same point in the parent's space — through whatever
 * rotation, scale and skew the layer is wearing. Everything else here is
 * arithmetic; this is the invariant.
 */
function parentPointOf(
  clip: { width: number; height: number; transform: { anchor: { x: number; y: number }; scale: number; scaleY: number | null; rotation: number; skewX: number; skewY: number; x: number; y: number } },
  px: number,
  py: number,
) {
  const basis = {
    scale: clip.transform.scale,
    scaleY: clip.transform.scaleY ?? clip.transform.scale,
    rotation: clip.transform.rotation,
    skewX: clip.transform.skewX,
    skewY: clip.transform.skewY,
    anchor: clip.transform.anchor,
    size: { width: clip.width, height: clip.height, cx: 0, cy: 0 },
  };
  const d = mapLocal(px - clip.width / 2, py - clip.height / 2, basis);
  return { x: clip.transform.x + d.x, y: clip.transform.y + d.y };
}

function poseClip(pose: Partial<{ scale: number; scaleY: number | null; rotation: number; skewX: number; skewY: number; anchor: { x: number; y: number } }>) {
  const clip = createRasterClip({ frameId: "f", width: 800, height: 600 });
  clip.transform = { ...clip.transform, x: 37, y: -12, ...pose } as typeof clip.transform;
  return clip;
}

describe("grownRaster", () => {
  const cases: Array<[string, Parameters<typeof poseClip>[0]]> = [
    ["identity", {}],
    ["rotated", { rotation: 33 }],
    ["scaled non-uniformly", { scale: 1.7, scaleY: 0.6 }],
    ["skewed", { skewX: 14, skewY: -8 }],
    ["off-centre pivot", { anchor: { x: 0.15, y: 0.9 } }],
    ["all at once", { rotation: -21, scale: 1.3, scaleY: 2.2, skewX: 9, skewY: 5, anchor: { x: 0.2, y: 0.75 } }],
  ];

  for (const [name, pose] of cases) {
    it(`keeps every pixel exactly where it was — ${name}`, () => {
      const clip = poseClip(pose);
      const pad = { left: 512, top: 256, right: 0, bottom: 1024 };
      // Three sample pixels, including the corners.
      const samples = [
        [0, 0],
        [800, 600],
        [317, 211],
      ] as const;
      const before = samples.map(([px, py]) => parentPointOf(clip, px, py));
      growRasterClip(clip, pad);
      const after = samples.map(([px, py]) => parentPointOf(clip, px + pad.left, py + pad.top));
      for (let i = 0; i < samples.length; i++) {
        expect(after[i]!.x).toBeCloseTo(before[i]!.x, 6);
        expect(after[i]!.y).toBeCloseTo(before[i]!.y, 6);
      }
    });
  }

  it("never moves transform.x/y", () => {
    const clip = poseClip({ rotation: 40 });
    const { x, y } = clip.transform;
    growRasterClip(clip, { left: 512, top: 0, right: 512, bottom: 0 });
    expect(clip.transform.x).toBe(x);
    expect(clip.transform.y).toBe(y);
  });

  it("grows the box by exactly the padding", () => {
    const g = grownRaster({ width: 100, height: 50, transform: { anchor: { x: 0.5, y: 0.5 } } }, { left: 10, top: 5, right: 20, bottom: 1 });
    expect(g.width).toBe(130);
    expect(g.height).toBe(56);
  });
});

describe("padFor", () => {
  it("returns null when the bounds already fit", () => {
    expect(padFor({ x0: 10, y0: 10, x1: 90, y1: 90 }, 100, 100)).toBeNull();
  });

  it("rounds up to whole blocks, on the sides that overflowed", () => {
    const pad = padFor({ x0: -3, y0: 20, x1: 140, y1: 60 }, 100, 100)!;
    expect(pad).toEqual({ left: GROW_BLOCK_PX, top: 0, right: GROW_BLOCK_PX, bottom: 0 });
  });

  it("clamps at the surface ceiling instead of allocating something impossible", () => {
    const pad = padFor({ x0: -900_000, y0: 0, x1: 100, y1: 100 }, 100, 100)!;
    expect(pad.left).toBeLessThanOrEqual(16384);
    expect(100 + pad.left + pad.right).toBeLessThanOrEqual(16384);
  });
});

describe("canGrowRaster", () => {
  it("refuses a cropped layer — the window and the new room contradict", () => {
    expect(canGrowRaster({ crop: { top: 0, right: 0, bottom: 0, left: 12 }, captureRevs: undefined })).toBe(false);
  });

  it("refuses a recorded layer — its snapshots are sized from this clip", () => {
    expect(canGrowRaster({ crop: { top: 0, right: 0, bottom: 0, left: 0 }, captureRevs: { s1: 3 } })).toBe(false);
  });

  it("allows a plain one", () => {
    expect(canGrowRaster({ crop: { top: 0, right: 0, bottom: 0, left: 0 }, captureRevs: {} })).toBe(true);
  });
  it("refuses a write into a capture snapshot — even the FIRST one, before captureRevs exists", () => {
    expect(canGrowRaster({ crop: { top: 0, right: 0, bottom: 0, left: 0 }, captureRevs: undefined }, "snapshot")).toBe(false);
  });
});

/**
 * The squash regression (Record mode → "my drawing shrank into a corner").
 *
 * The paint asked "may I grow?" before the commit wrote `captureRevs`; the box
 * writer asked again after, and got the other answer. The canvas grew, the box
 * did not. Now the question is asked once, and the writer follows the pixels.
 */
describe("growRasterClip follows the pixels", () => {
  it("applies the pad it is given even on a layer that has since become recorded", () => {
    const clip = createRasterClip({ frameId: "f", width: 640, height: 360 });
    clip.captureRevs = { snap_1: 1 };
    expect(growRasterClip(clip, { left: 0, top: 0, right: 512, bottom: 0 })).toBe(true);
    expect(clip.width).toBe(1152);
  });

  it("is a no-op for an empty pad", () => {
    const clip = createRasterClip({ frameId: "f", width: 640, height: 360 });
    expect(growRasterClip(clip, { left: 0, top: 0, right: 0, bottom: 0 })).toBe(false);
    expect(clip.width).toBe(640);
  });
});
