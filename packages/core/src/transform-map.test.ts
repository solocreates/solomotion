import { describe, expect, it } from "vitest";
import { poseQuad, type LayerPose } from "./animation/motion";
import { NO_CONTENT, NO_CROP } from "./schema/clips";
import {
  anchorLocal,
  contentExtent,
  contentIsIdentity,
  contentScaleY,
  cropWindow,
  fitContent,
  mapContent,
  anchorMoveShift,
  rebaseAnchor,
  CENTER_ANCHOR,
  centerOffset,
  inverseLayerMatrix,
  layerMatrix,
  mapLocal,
  positionForCenter,
  unmapLocal,
  type LayerBasis,
} from "./transform-map";

/** A 200×100 layer, scaled 2×/3× with rotation and shear — nothing symmetric. */
const basis = (anchor = CENTER_ANCHOR): LayerBasis => ({
  scale: 2,
  scaleY: 3,
  rotation: 37,
  skewX: 12,
  skewY: -5,
  anchor,
  size: { width: 200, height: 100, cx: 0, cy: 0 },
});

describe("the pivot", () => {
  it("is the identity at the box centre", () => {
    expect(anchorLocal(CENTER_ANCHOR, { width: 200, height: 100, cx: 0, cy: 0 })).toEqual({ x: 0, y: 0 });
    expect(centerOffset(basis())).toEqual({ x: 0, y: 0 });
  });

  it("is measured in the layer's own centre-origin units", () => {
    expect(anchorLocal({ x: 0, y: 0 }, { width: 200, height: 100, cx: 0, cy: 0 })).toEqual({ x: -100, y: -50 });
    expect(anchorLocal({ x: 1, y: 1 }, { width: 200, height: 100, cx: 0, cy: 0 })).toEqual({ x: 100, y: 50 });
    // Outside 0..1 is legal — an orbit centre off to one side.
    expect(anchorLocal({ x: 2, y: 0.5 }, { width: 200, height: 100, cx: 0, cy: 0 })).toEqual({ x: 300, y: 0 });
  });

  it("survives a resize, because it is a fraction and not a distance", () => {
    const a = { x: 1, y: 1 }; // bottom-right corner
    expect(anchorLocal(a, { width: 200, height: 100, cx: 0, cy: 0 })).toEqual({ x: 100, y: 50 });
    expect(anchorLocal(a, { width: 800, height: 400, cx: 0, cy: 0 })).toEqual({ x: 400, y: 200 });
  });

  it("stays put under the layer's own map — the pivot is the fixed point", () => {
    const a = { x: 1, y: 0 }; // top-right corner
    const b = basis(a);
    // Its local coordinates map to a zero world offset from the position, at any
    // scale/rotation/shear: that is exactly what "everything happens about it" means.
    const al = anchorLocal(a, b.size);
    const d = mapLocal(al.x, al.y, b);
    expect(d.x).toBeCloseTo(0);
    expect(d.y).toBeCloseTo(0);
    expect(mapLocal(al.x, al.y, { ...b, scale: 9, rotation: 123 }).x).toBeCloseTo(0);
  });

  it("round-trips centre ↔ position", () => {
    const b = basis({ x: 0.2, y: 0.9 });
    const pos = { x: 40, y: -12 };
    const off = centerOffset(b);
    const centre = { x: pos.x + off.x, y: pos.y + off.y };
    const back = positionForCenter(centre, b);
    expect(back.x).toBeCloseTo(pos.x);
    expect(back.y).toBeCloseTo(pos.y);
  });
});

describe("anchorMoveShift", () => {
  it("keeps the ART still when the pivot moves", () => {
    // THE invariant behind "moving the pivot doesn't move the layer": after the
    // shift, an arbitrary local point must land in the same world spot.
    const from = CENTER_ANCHOR;
    const to = { x: 0, y: 1 }; // bottom-left corner
    const b0 = basis(from);
    const b1 = basis(to);
    const pos0 = { x: 100, y: 200 };
    const shift = anchorMoveShift(from, to, b0);
    const pos1 = { x: pos0.x + shift.x, y: pos0.y + shift.y };
    for (const [lx, ly] of [
      [0, 0],
      [100, 50],
      [-100, -50],
      [37, -11],
    ] as const) {
      const before = mapLocal(lx, ly, b0);
      const after = mapLocal(lx, ly, b1);
      expect(pos1.x + after.x).toBeCloseTo(pos0.x + before.x);
      expect(pos1.y + after.y).toBeCloseTo(pos0.y + before.y);
    }
  });

  it("is a no-op when the pivot doesn't actually move", () => {
    const s = anchorMoveShift(CENTER_ANCHOR, { x: 0.5, y: 0.5 }, basis());
    expect(s.x).toBeCloseTo(0);
    expect(s.y).toBeCloseTo(0);
  });
});

describe("unmapLocal", () => {
  const basis = (over: Partial<LayerBasis> = {}): LayerBasis => ({
    scale: 1.7,
    scaleY: 0.6,
    rotation: 34,
    skewX: 12,
    skewY: -7,
    anchor: { x: 0.15, y: 0.85 },
    size: { width: 320, height: 180, cx: 0, cy: 0 },
    ...over,
  });

  it("round-trips mapLocal for any pivot, scale, shear and rotation", () => {
    const b = basis();
    for (const p of [
      { x: 0, y: 0 },
      { x: 90, y: -40 },
      { x: -160, y: 75 },
    ]) {
      const o = mapLocal(p.x, p.y, b);
      const back = unmapLocal(o.x, o.y, b);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it("puts the pivot itself at the layer's position (zero world offset)", () => {
    const b = basis();
    const a = anchorLocal(b.anchor, b.size);
    const o = mapLocal(a.x, a.y, b);
    expect(o.x).toBeCloseTo(0, 9);
    expect(o.y).toBeCloseTo(0, 9);
    // ...and the inverse agrees: no offset means "you are on the pivot".
    const back = unmapLocal(0, 0, b);
    expect(back.x).toBeCloseTo(a.x, 6);
    expect(back.y).toBeCloseTo(a.y, 6);
  });

  it("is unaffected by the pivot when the pivot is the box center", () => {
    const b = basis({ anchor: CENTER_ANCHOR, skewX: 0, skewY: 0 });
    const back = unmapLocal(mapLocal(50, 20, b).x, mapLocal(50, 20, b).y, b);
    expect(back.x).toBeCloseTo(50, 6);
    expect(back.y).toBeCloseTo(20, 6);
  });
});

describe("a box that isn't centred on the origin", () => {
  it("resolves the pivot against the box you can SEE, not the origin", () => {
    // A path whose outline drifted 60px right of its origin: "top-left" has to
    // mean the outline's top-left, or the nine-point picker lies about edited art.
    const box = { width: 200, height: 100, cx: 60, cy: -10 };
    expect(anchorLocal(CENTER_ANCHOR, box)).toEqual({ x: 60, y: -10 });
    expect(anchorLocal({ x: 0, y: 0 }, box)).toEqual({ x: -40, y: -60 });
    expect(anchorLocal({ x: 1, y: 1 }, box)).toEqual({ x: 160, y: 40 });
  });
});

describe("rebaseAnchor", () => {
  /** Morphing a 200×100 outline: drag the right edge 100px further right. */
  const before = { width: 200, height: 100, cx: 0, cy: 0 };
  const after = { width: 300, height: 100, cx: 50, cy: 0 };

  it("keeps the pivot on the same local point when the box changes under it", () => {
    for (const a of [CENTER_ANCHOR, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: -0.3 }]) {
      const rebased = rebaseAnchor(a, before, after);
      expect(anchorLocal(rebased, after).x).toBeCloseTo(anchorLocal(a, before).x, 9);
      expect(anchorLocal(rebased, after).y).toBeCloseTo(anchorLocal(a, before).y, 9);
    }
  });

  it("leaves every UNEDITED point of the art exactly where it was", () => {
    // The whole point of the rule: a node drag moves that node and nothing else.
    const a = { x: 1, y: 1 }; // pivot placed on the bottom-right corner
    const pose = { scale: 2, scaleY: 3, rotation: 37, skewX: 12, skewY: -5 };
    const b0: LayerBasis = { ...pose, anchor: a, size: before };
    const b1: LayerBasis = { ...pose, anchor: rebaseAnchor(a, before, after), size: after };
    for (const p of [
      { x: -100, y: -50 },
      { x: 0, y: 0 },
      { x: 33, y: 41 },
    ]) {
      expect(mapLocal(p.x, p.y, b1).x).toBeCloseTo(mapLocal(p.x, p.y, b0).x, 9);
      expect(mapLocal(p.x, p.y, b1).y).toBeCloseTo(mapLocal(p.x, p.y, b0).y, 9);
    }
  });

  it("holds the stored value on an axis that collapsed to nothing", () => {
    const flat = { width: 0, height: 100, cx: 0, cy: 0 };
    expect(rebaseAnchor({ x: 0.25, y: 1 }, before, flat).x).toBe(0.25);
  });
});

describe("cropWindow", () => {
  /** A 200×100 image, uncropped. */
  const box = { width: 200, height: 100, cx: 0, cy: 0 };

  it("is the box itself when nothing is cropped", () => {
    expect(cropWindow(NO_CROP, box)).toEqual(box);
  });

  it("carries an asymmetric crop as an OFFSET, not as a smaller centred box", () => {
    // 60 off the left, 10 off the bottom: the window is 140×90 and its centre
    // has moved right by 30 and up by 5. Losing that offset is what slides a
    // cropped layer's computed position away from where it paints.
    expect(cropWindow({ top: 0, right: 0, bottom: 10, left: 60 }, box)).toEqual({
      width: 140,
      height: 90,
      cx: 30,
      cy: -5,
    });
  });

  it("clamps rather than inverting when the insets meet or overshoot", () => {
    const w = cropWindow({ top: 200, right: 500, bottom: 0, left: 150 }, box);
    expect(w.width).toBe(0);
    expect(w.height).toBe(0);
    // An empty window still sits somewhere real — where the edges met.
    expect(w.cx).toBe(50);
    expect(w.cy).toBe(50);
  });

  it("rides a box that is itself off-origin (a path's outline)", () => {
    const off = { width: 200, height: 100, cx: 60, cy: -10 };
    expect(cropWindow({ top: 0, right: 40, bottom: 0, left: 0 }, off)).toEqual({
      width: 160,
      height: 100,
      cx: 40,
      cy: -10,
    });
  });
});

describe("a cropped layer's painted quad", () => {
  const box = { width: 200, height: 100, cx: 0, cy: 0 };
  const crop = { top: 0, right: 0, bottom: 0, left: 100 }; // right half only
  const pose = (over: Partial<LayerPose> = {}): LayerPose => ({
    x: 0,
    y: 0,
    scale: 1,
    scaleY: 1,
    rotation: 0,
    skewX: 0,
    skewY: 0,
    anchor: CENTER_ANCHOR,
    ...over,
  });

  /**
   * THE REGRESSION. A crop is not a resize: the pivot stays a fraction of the
   * FULL box while the window slides inside it, so the visible half of a 2×
   * layer sits 100px to the right of the layer's position — exactly where the
   * renderer paints it, because `withBoxClip` poses about the full box and
   * clips afterwards.
   */
  it("pivots about the full box and covers only the window", () => {
    const q = poseQuad(pose({ scale: 2, scaleY: 2 }), box, cropWindow(crop, box));
    expect(q.map((p) => [p.x, p.y])).toEqual([
      [0, -100],
      [200, -100],
      [200, 100],
      [0, 100],
    ]);
  });

  it("does not move the picture when the pivot is off-centre", () => {
    // Same window, pivot parked on the top-left corner: the quad is the whole
    // layer's own map applied to the window, never the window's own map.
    const p = pose({ scale: 2, scaleY: 2, anchor: { x: 0, y: 0 } });
    const q = poseQuad(p, box, cropWindow(crop, box));
    expect(q.map((c) => [c.x, c.y])).toEqual([
      [200, 0],
      [400, 0],
      [400, 200],
      [200, 200],
    ]);
  });

  it("drifts by scale × the window's offset when the two boxes are conflated", () => {
    // What the region used to do — passing the window in as the pivot box. The
    // drift is invisible while it only places a picture (the painter has the
    // right box) and cuts artwork in half the moment it SIZES A BUFFER.
    const p = pose({ scale: 2, scaleY: 2 });
    const win = cropWindow(crop, box);
    const wrong = poseQuad(p, win);
    const right = poseQuad(p, box, win);
    expect(wrong[0]!.x - right[0]!.x).toBe(-2 * win.cx);
  });
});

describe("layerMatrix", () => {
  /**
   * The matrix and the point map are the SAME map, and a preview drawn with one
   * has to land on the thing rendered with the other. Under every part of the
   * pose at once, because it is the parts nobody exercises — shear, and a pivot
   * that is off-centre because the layer GREW — that drifted in practice.
   */
  const basis: LayerBasis = {
    scale: 1.7,
    scaleY: 0.6,
    rotation: 37,
    skewX: 12,
    skewY: -8,
    // What `grownRaster` leaves behind after one 512px block on the right.
    anchor: { x: 0.5 - 256 / 1536, y: 0.5 },
    size: { width: 1536, height: 1080, cx: 0, cy: 0 },
  };

  const apply = (m: readonly number[], x: number, y: number) => ({
    x: m[0]! * x + m[2]! * y + m[4]!,
    y: m[1]! * x + m[3]! * y + m[5]!,
  });

  it("agrees with mapLocal everywhere", () => {
    const m = layerMatrix(basis);
    for (const [x, y] of [
      [0, 0],
      [-768, -540],
      [768, 540],
      [123.5, -47.25],
    ]) {
      const viaPoint = mapLocal(x!, y!, basis);
      const viaMatrix = apply(m, x!, y!);
      expect(viaMatrix.x).toBeCloseTo(viaPoint.x, 9);
      expect(viaMatrix.y).toBeCloseTo(viaPoint.y, 9);
    }
  });

  it("holds the pivot still — that is what makes it the pivot", () => {
    const m = layerMatrix(basis);
    const p = anchorLocal(basis.anchor, basis.size);
    const at = apply(m, p.x, p.y);
    expect(at.x).toBeCloseTo(0, 9);
    expect(at.y).toBeCloseTo(0, 9);
  });

  it("inverts, exactly, under non-uniform scale and shear together", () => {
    const m = layerMatrix(basis);
    const inv = inverseLayerMatrix(basis);
    for (const [x, y] of [
      [0, 0],
      [-768, -540],
      [321, 654],
    ]) {
      const there = apply(m, x!, y!);
      const back = apply(inv, there.x, there.y);
      expect(back.x).toBeCloseTo(x!, 6);
      expect(back.y).toBeCloseTo(y!, 6);
    }
  });

  it("agrees with unmapLocal", () => {
    const inv = inverseLayerMatrix(basis);
    const got = apply(inv, 100, -40);
    const want = unmapLocal(100, -40, basis);
    expect(got.x).toBeCloseTo(want.x, 9);
    expect(got.y).toBeCloseTo(want.y, 9);
  });

  it("is the identity for an untransformed centred layer", () => {
    const m = layerMatrix({
      scale: 1,
      scaleY: 1,
      rotation: 0,
      skewX: 0,
      skewY: 0,
      anchor: CENTER_ANCHOR,
      size: { width: 100, height: 50, cx: 0, cy: 0 },
    });
    // Element-wise, because a translation of exactly zero comes out as -0 and
    // that is a real number a canvas is perfectly happy with.
    [1, 0, 0, 1, 0, 0].forEach((v, i) => expect(m[i]).toBeCloseTo(v, 12));
  });

  it("translates by the pivot offset alone when nothing else is posed", () => {
    // The exact case the live brush preview was missing: a grown layer at rest.
    const m = layerMatrix({
      scale: 1,
      scaleY: 1,
      rotation: 0,
      skewX: 0,
      skewY: 0,
      anchor: { x: 0.5 - 256 / 1536, y: 0.5 },
      size: { width: 1536, height: 1080, cx: 0, cy: 0 },
    });
    expect(m[4]).toBeCloseTo(256, 9);
    expect(m[5]).toBeCloseTo(0, 9);
  });
});

/**
 * The picture inside the window.
 *
 * The whole reason this is a second transform rather than arithmetic inside a
 * gesture is that the two must not interfere. The first cut of it pivoted about
 * the WINDOW's centre — "zoom about what you can see" — and the window's centre
 * is a function of the insets, so reframing a crop dragged the footage along
 * with it. The first test below is that bug, and it is what decides the shape
 * of everything else here.
 */
describe("the content transform", () => {
  /** A 400x200 picture with a 200x100 window in its middle. */
  const box = { width: 400, height: 200, cx: 0, cy: 0 };
  const win = cropWindow({ top: 50, right: 100, bottom: 50, left: 100 }, box);

  it("THE CROP CANNOT MOVE THE PICTURE — at any zoom, pan or rotation", () => {
    // The map takes the BOX, never the window, so this holds by construction
    // rather than by arithmetic that happens to cancel. Assert it anyway: the
    // regression it guards against is invisible until a crop edge is dragged.
    const c = { x: 37, y: -14, scale: 2.5, scaleY: 1.75, rotation: 22 };
    const probe = { x: 120, y: -33 };
    const before = mapContent(probe.x, probe.y, c, box);
    for (const crop of [
      { top: 0, right: 0, bottom: 0, left: 0 },
      { top: 50, right: 100, bottom: 50, left: 100 },
      { top: 0, right: 300, bottom: 150, left: 0 },
      { top: 120, right: 20, bottom: 10, left: 260 },
    ]) {
      const w = cropWindow(crop, box);
      expect(w.width).toBeGreaterThan(0); // the windows really are different
      const after = mapContent(probe.x, probe.y, c, box);
      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
    }
  });

  it("identity leaves every point exactly where it was", () => {
    expect(contentIsIdentity(NO_CONTENT)).toBe(true);
    const p = mapContent(37, -12, NO_CONTENT, box);
    expect(p.x).toBeCloseTo(37, 9);
    expect(p.y).toBeCloseTo(-12, 9);
  });

  it("`scaleY: null` is uniform, and a number breaks the link", () => {
    expect(contentScaleY({ ...NO_CONTENT, scale: 2 })).toBe(2);
    expect(contentScaleY({ ...NO_CONTENT, scale: 2, scaleY: 0.5 })).toBe(0.5);
    // A non-1 uniform zoom is not identity, even though `scaleY` is still null.
    expect(contentIsIdentity({ ...NO_CONTENT, scale: 2 })).toBe(false);
  });

  it("zooms about the picture's own centre", () => {
    const c = { ...NO_CONTENT, scale: 3 };
    const centre = mapContent(box.cx, box.cy, c, box);
    expect(centre.x).toBeCloseTo(box.cx, 9);
    expect(centre.y).toBeCloseTo(box.cy, 9);
  });

  it("pans in FINAL px — a drag moves the picture 1:1 however far you are in", () => {
    // The translate is outside the zoom, so the pan a gesture writes is the
    // distance the pointer travelled, with nothing to divide by.
    const near = mapContent(10, 10, { ...NO_CONTENT, x: 60, y: -25 }, box);
    const far = mapContent(10, 10, { ...NO_CONTENT, scale: 8, x: 60, y: -25 }, box);
    const flat = mapContent(10, 10, { ...NO_CONTENT, scale: 8 }, box);
    expect(near.x - 10).toBeCloseTo(60, 9);
    expect(far.x - flat.x).toBeCloseTo(60, 9);
    expect(far.y - flat.y).toBeCloseTo(-25, 9);
  });

  it("the extent follows the paint — it is the picture, transformed", () => {
    expect(contentExtent(NO_CONTENT, box)).toEqual(box);
    const big = contentExtent({ ...NO_CONTENT, scale: 2 }, box);
    expect(big.width).toBeCloseTo(800, 6);
    expect(big.height).toBeCloseTo(400, 6);
    // A quarter turn swaps the axes of the covered rectangle.
    const turned = contentExtent({ ...NO_CONTENT, rotation: 90 }, box);
    expect(turned.width).toBeCloseTo(200, 6);
    expect(turned.height).toBeCloseTo(400, 6);
  });

  it("fill covers the window; fit puts the whole picture inside it", () => {
    // A 400x200 picture in a 200x100 window: both axes need x0.5 exactly.
    expect(fitContent(box, win, "fill").scale).toBeCloseTo(0.5, 9);
    expect(fitContent(box, win, "fit").scale).toBeCloseTo(0.5, 9);
    // A TALL window: fill takes the larger ratio (the picture overhangs),
    // fit takes the smaller (the picture sits inside with room to spare).
    const tall = { width: 100, height: 200, cx: 0, cy: 0 };
    expect(fitContent(box, tall, "fill").scale).toBeCloseTo(1, 9);
    expect(fitContent(box, tall, "fit").scale).toBeCloseTo(0.25, 9);
  });

  it("fit centres the picture on the window, wherever the window is", () => {
    const offset = cropWindow({ top: 0, right: 300, bottom: 100, left: 0 }, box);
    const c = fitContent(box, offset, "fit");
    const centre = mapContent(box.cx, box.cy, c, box);
    expect(centre.x).toBeCloseTo(offset.cx, 6);
    expect(centre.y).toBeCloseTo(offset.cy, 6);
  });

});
