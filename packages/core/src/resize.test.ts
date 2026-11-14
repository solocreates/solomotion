import { describe, expect, it } from "vitest";
import {
  clampScale,
  flipScalePair,
  mirrorScale,
  realizedFactor,
  resizeAnchorPoint,
  resizeCenter,
  resizePosition,
  solveResizeFactors,
  type ResizeBox,
  type ResizePose,
} from "./resize";
import { anchorLocal, mapLinear } from "./transform-map";

/** An unrotated 200×100 box centered at the origin, grabbed by its SE corner. */
const SE: ResizeBox = { cx: 0, cy: 0, rotation: 0, halfW: 100, halfH: 50, sx: 1, sy: 1 };
const FREE = { centerAnchor: false, keepAspect: false, allowMirror: true };

describe("solveResizeFactors", () => {
  it("is the identity at the grabbed corner", () => {
    const f = solveResizeFactors(SE, { x: 100, y: 50 }, FREE);
    expect(f.fx).toBeCloseTo(1);
    expect(f.fy).toBeCloseTo(1);
  });

  it("passes smoothly through zero into a mirror as the drag crosses its anchor", () => {
    // Anchor is the NW corner (-100, -50). Just short of it, then past it.
    expect(solveResizeFactors(SE, { x: -50, y: 50 }, FREE).fx).toBeCloseTo(0.25);
    expect(solveResizeFactors(SE, { x: -100, y: 50 }, FREE).fx).toBeCloseTo(0);
    expect(solveResizeFactors(SE, { x: -300, y: 50 }, FREE).fx).toBeCloseTo(-1);
  });

  it("clamps at zero instead of mirroring when mirroring is off", () => {
    const f = solveResizeFactors(SE, { x: -300, y: 50 }, { ...FREE, allowMirror: false });
    expect(f.fx).toBe(0);
  });

  it("couples magnitudes but not signs under aspect lock", () => {
    // Dragged well past the anchor on X, still positive on Y.
    const f = solveResizeFactors(SE, { x: -300, y: 25 }, { ...FREE, keepAspect: true });
    expect(f.fx).toBeCloseTo(-1);
    expect(f.fy).toBeCloseTo(1);
  });

  it("never lets an aspect-locked EDGE inherit a mirror from its pinned axis", () => {
    const east: ResizeBox = { ...SE, sy: 0 };
    const f = solveResizeFactors(east, { x: -300, y: 999 }, { ...FREE, keepAspect: true });
    expect(f.fx).toBeCloseTo(-1);
    expect(f.fy).toBeCloseTo(1); // magnitude follows, sign stays positive
  });

  it("reads the pointer as a half-extent when anchored to the center (⌥)", () => {
    const f = solveResizeFactors(SE, { x: 200, y: 50 }, { ...FREE, centerAnchor: true });
    expect(f.fx).toBeCloseTo(2);
    expect(f.fy).toBeCloseTo(1);
  });

  it("works in the box's own axes when rotated", () => {
    const rot: ResizeBox = { ...SE, rotation: 90 };
    // Local +X now points along world +Y: the grabbed corner sits at (-50, 100).
    const f = solveResizeFactors(rot, { x: -50, y: 100 }, FREE);
    expect(f.fx).toBeCloseTo(1);
    expect(f.fy).toBeCloseTo(1);
  });
});

describe("resizeCenter", () => {
  it("holds the anchor still while the box grows", () => {
    const c = resizeCenter(SE, { fx: 2, fy: 1 }, false);
    expect(c.x).toBeCloseTo(100); // NW corner still at x = -100
    expect(c.y).toBeCloseTo(0);
    expect(resizeAnchorPoint(SE, false)).toEqual({ x: -100, y: -50 });
  });

  it("folds the box over the pinned edge on a mirror", () => {
    // Same size, mirrored on X: the box lands entirely left of the anchor.
    const c = resizeCenter(SE, { fx: -1, fy: 1 }, false);
    expect(c.x).toBeCloseTo(-200); // center is now 100 left of the pinned x = -100
    expect(c.y).toBeCloseTo(0);
  });

  it("keeps the center pinned under ⌥ no matter the factors", () => {
    expect(resizeCenter(SE, { fx: -3, fy: 2 }, true)).toEqual({ x: 0, y: 0 });
  });
});

describe("an off-centre pivot", () => {
  // ⌥ resizes about the PIVOT, which is the box centre by default. Here the
  // pivot sits on the box's left edge, so ⌥ should grow the box rightward only.
  const pivoted: ResizeBox = { ...SE, pivot: { x: -100, y: 0 } };

  it("anchors ⌥ at the pivot, not the centre", () => {
    expect(resizeAnchorPoint(pivoted, true)).toEqual({ x: -100, y: 0 });
    expect(resizeAnchorPoint(SE, true)).toEqual({ x: 0, y: 0 });
  });

  it("measures the factor from the pivot to the grabbed handle", () => {
    // Handle starts at (100, 50); it is 200 to the right of the pivot. Twice that
    // distance is a factor of 2.
    const f = solveResizeFactors(pivoted, { x: 300, y: 50 }, { ...FREE, centerAnchor: true });
    expect(f.fx).toBeCloseTo(2);
    expect(f.fy).toBeCloseTo(1);
  });

  it("sweeps the box around the pivot rather than pinning the centre", () => {
    const c = resizeCenter(pivoted, { fx: 2, fy: 1 }, true);
    expect(c.x).toBeCloseTo(100); // centre was 100 right of the pivot → now 200
    expect(c.y).toBeCloseTo(0);
    // The default centred pivot still holds the centre perfectly still.
    expect(resizeCenter(SE, { fx: 2, fy: 1 }, true)).toEqual({ x: 0, y: 0 });
  });

  it("mirrors about the pivot when the drag crosses it", () => {
    const f = solveResizeFactors(pivoted, { x: -300, y: 50 }, { ...FREE, centerAnchor: true });
    expect(f.fx).toBeCloseTo(-1);
    expect(resizeCenter(pivoted, f, true).x).toBeCloseTo(-200);
  });
});

describe("realizedFactor", () => {
  it("reports the achieved ratio carrying the requested mirror", () => {
    // Asked to shrink past the anchor, but the geometry clamped at its 1px floor.
    expect(realizedFactor(1, 200, -0.001)).toBeCloseTo(-0.005);
    expect(realizedFactor(400, 200, 2)).toBeCloseTo(2);
  });
});

describe("clampScale", () => {
  it("clamps the magnitude and keeps the sign", () => {
    expect(clampScale(-100)).toBe(-50);
    expect(clampScale(-0.0001)).toBe(-0.01);
    expect(clampScale(0)).toBe(0.01); // a zero-scale layer could never be grabbed again
    expect(clampScale(-2)).toBe(-2);
  });
});

describe("mirrorScale", () => {
  it("flips only on a negative factor, magnitude untouched", () => {
    expect(mirrorScale(2.5, -0.4)).toBe(-2.5);
    expect(mirrorScale(-2.5, -0.4)).toBe(2.5);
    expect(mirrorScale(2.5, 0.4)).toBe(2.5);
  });
});

describe("flipScalePair", () => {
  it("materializes scaleY when a uniform layer flips on X only", () => {
    // The bug this prevents: negating `scale` alone on a uniform layer is a 180°
    // rotation, not a mirror, because `scaleY: null` follows it.
    expect(flipScalePair({ scale: 2, scaleY: null }, "x")).toEqual({ scale: -2, scaleY: 2 });
    expect(flipScalePair({ scale: 2, scaleY: null }, "y")).toEqual({ scale: 2, scaleY: -2 });
  });

  it("collapses back to uniform when the two agree again", () => {
    expect(flipScalePair({ scale: -2, scaleY: 2 }, "x")).toEqual({ scale: 2, scaleY: null });
  });

  it("leaves an independent pair independent", () => {
    expect(flipScalePair({ scale: 2, scaleY: 3 }, "y")).toEqual({ scale: 2, scaleY: -3 });
  });
});

/* ───────────────────────────── the resize invariant, for BOTH placements ── */

/**
 * WHERE A LAYER'S BOX POINT ACTUALLY LANDS — the two placement models, written
 * out from their own definitions rather than from the code under test, so the
 * assertions below are a statement about the DOCUMENT and not a tautology.
 *
 *   leaf    `x/y` IS the pivot            → pos +     L(local(u) − pivot)
 *   group   `x/y` is a DELTA about it     → pos + p + L(local(u) − pivot)
 *
 * `u` is a normalized box point: (0,0) the centre, (±0.5, ±0.5) the corners.
 */
function placedBoxPoint(
  pose: ResizePose,
  kind: "leaf" | "group",
  u: { x: number; y: number },
): { x: number; y: number } {
  const box = pose.size;
  const p = anchorLocal(pose.anchor, box);
  const local = { x: box.cx + u.x * box.width, y: box.cy + u.y * box.height };
  const d = mapLinear(local.x - p.x, local.y - p.y, pose);
  const originX = kind === "group" ? pose.x + p.x : pose.x;
  const originY = kind === "group" ? pose.y + p.y : pose.y;
  return { x: originX + d.x, y: originY + d.y };
}

/** The ResizeBox the stage builds from a pose: the PLACED box, in its own axes. */
function boxOf(pose: ResizePose, kind: "leaf" | "group", sx: -1 | 0 | 1, sy: -1 | 0 | 1): ResizeBox {
  const c = placedBoxPoint(pose, kind, { x: 0, y: 0 });
  const p = anchorLocal(pose.anchor, pose.size);
  const pivot = kind === "group" ? { x: pose.x + p.x, y: pose.y + p.y } : { x: pose.x, y: pose.y };
  return {
    cx: c.x,
    cy: c.y,
    rotation: pose.rotation,
    halfW: Math.abs(pose.size.width * pose.scale) / 2,
    halfH: Math.abs(pose.size.height * pose.scaleY) / 2,
    sx,
    sy,
    pivot,
  };
}

/** Pull the SE corner to `pointer` and report where the PINNED corner ended up. */
function pinnedCornerAfterResize(
  pose: ResizePose,
  kind: "leaf" | "group",
  pointer: { x: number; y: number },
  centerAnchor = false,
) {
  const box = boxOf(pose, kind, 1, 1);
  const f = solveResizeFactors(box, pointer, { centerAnchor, keepAspect: false, allowMirror: true });
  const next = { scale: pose.scale * f.fx, scaleY: pose.scaleY * f.fy, size: pose.size };
  const c = resizeCenter(box, f, centerAnchor);
  const pos = resizePosition(pose, next, { x: c.x - box.cx, y: c.y - box.cy });
  const after: ResizePose = { ...pose, ...next, x: pos.x, y: pos.y };
  // The anchor of a corner drag is the OPPOSITE corner; under ⌥ it is the pivot.
  const u = centerAnchor
    ? { x: pose.anchor.x - 0.5, y: pose.anchor.y - 0.5 }
    : { x: -0.5, y: -0.5 };
  return {
    before: placedBoxPoint(pose, kind, u),
    after: placedBoxPoint(after, kind, u),
  };
}

describe("resizePosition — the pinned point does not move", () => {
  const base = {
    scale: 1,
    scaleY: 1,
    rotation: 0,
    skewX: 0,
    skewY: 0,
    anchor: { x: 0.5, y: 0.5 },
  };

  /**
   * THE CASE THAT WAS BROKEN FOR YEARS. A group's box is the union of its
   * members, so its centre is wherever the artwork happens to sit — nowhere near
   * the layer's origin — and its `x/y` is a delta about a pivot derived from
   * that box. Every earlier attempt measured the pivot offset from the ORIGIN,
   * which reports a correction for a layer that needs none, so the group slid by
   * (Δscale × the artwork's own offset) on every pointer move.
   */
  it("holds a GROUP whose artwork sits far from the comp centre", () => {
    const pose: ResizePose = {
      ...base,
      x: 0,
      y: 0,
      size: { width: 400, height: 200, cx: 300, cy: -150 },
    };
    const { before, after } = pinnedCornerAfterResize(pose, "group", { x: 700, y: 10 });
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("holds a group that is already moved, turned and scaled", () => {
    const pose: ResizePose = {
      ...base,
      x: 120,
      y: -60,
      scale: 1.4,
      scaleY: 0.8,
      rotation: 23,
      size: { width: 400, height: 200, cx: 300, cy: -150 },
    };
    const { before, after } = pinnedCornerAfterResize(pose, "group", { x: 900, y: 120 });
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("holds a group with an off-centre pivot", () => {
    const pose: ResizePose = {
      ...base,
      x: 40,
      y: 0,
      anchor: { x: 0, y: 1 },
      size: { width: 400, height: 200, cx: 300, cy: -150 },
    };
    const { before, after } = pinnedCornerAfterResize(pose, "group", { x: 620, y: 40 });
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("holds a PATH-shaped leaf — an outline that wandered off its own origin", () => {
    const pose: ResizePose = {
      ...base,
      x: 50,
      y: 50,
      rotation: 17,
      anchor: { x: 0.2, y: 0.8 },
      size: { width: 120, height: 90, cx: 40, cy: -25 },
    };
    const { before, after } = pinnedCornerAfterResize(pose, "leaf", { x: 260, y: 180 });
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("holds an ordinary leaf with an off-centre pivot under rotation and shear", () => {
    const pose: ResizePose = {
      ...base,
      x: -30,
      y: 15,
      scale: 0.7,
      scaleY: 1.3,
      rotation: -41,
      anchor: { x: 1, y: 0 },
      size: { width: 300, height: 180, cx: 0, cy: 0 },
    };
    const { before, after } = pinnedCornerAfterResize(pose, "leaf", { x: 180, y: 240 });
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("holds the PIVOT itself under ⌥, for a group and a leaf alike", () => {
    const size = { width: 400, height: 200, cx: 300, cy: -150 };
    const pose: ResizePose = { ...base, x: 20, y: -10, anchor: { x: 0.1, y: 0.9 }, size };
    for (const kind of ["group", "leaf"] as const) {
      const { before, after } = pinnedCornerAfterResize(pose, kind, { x: 700, y: 60 }, true);
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });

  it("a mirror folds the layer over its pinned corner rather than teleporting it", () => {
    const pose: ResizePose = {
      ...base,
      x: 0,
      y: 0,
      size: { width: 200, height: 100, cx: 0, cy: 0 },
    };
    // Drag the SE corner well past the NW anchor: both axes flip.
    const { before, after } = pinnedCornerAfterResize(pose, "leaf", { x: -300, y: -200 });
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });
});
