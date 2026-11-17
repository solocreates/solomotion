import { describe, expect, it } from "vitest";
import { MAX_LAYER_BUFFER_PX, regionCovers, seenWindow } from "../animation/layer-region";
import { bandsAround, planReproject, viewOverscanPx, WINDOW_MARGINS, type ViewRaster } from "./view-raster";

const W = 1000;
const H = 600;
const M = 200;
/** A raster just captured: the viewport in the middle, empty margins around it. */
const fresh = (over: Partial<ViewRaster> = {}): ViewRaster => ({
  view: { scale: 2, tx: 0, ty: 0 },
  dpr: 2,
  width: W + M * 2,
  height: H + M * 2,
  originX: -M,
  originY: -M,
  valid: { x: M, y: M, w: W, h: H },
  ...over,
});
const vp = { width: W, height: H };
const area = (rs: { w: number; h: number }[]) => rs.reduce((s, r) => s + r.w * r.h, 0);

/** Apply a pan plan, as the surface would. */
function after(r: ViewRaster, plan: ReturnType<typeof planReproject>): ViewRaster {
  if (plan.kind !== "pan") throw new Error("not a pan");
  return { ...r, valid: plan.valid, originX: plan.originX, originY: plan.originY };
}

describe("the camera is a view, not an edit", () => {
  it("a camera that has not moved is a straight copy", () => {
    const plan = planReproject(fresh(), { scale: 2, tx: 0, ty: 0 }, vp);
    expect(plan).toMatchObject({ kind: "pan", scroll: null, fill: [], srcX: M, srcY: M });
  });

  it("paints the leading band a whole margin deep, then pans for free inside it", () => {
    // 10 CSS px left = the content moves 20 device px left, exposing the right.
    let r = fresh();
    const first = planReproject(r, { scale: 2, tx: -10, ty: 0 }, vp);
    if (first.kind !== "pan") throw new Error("expected a pan");
    // Re-centred on the viewport, so there is a full margin ahead…
    expect(first.scroll).toEqual({ dx: -20, dy: 0 });
    expect(first.srcX).toBe(M);
    // …and the band is the sliver that came into view plus that margin — one
    // band, on the side of travel, the full height of what is held.
    expect(first.fill).toEqual([{ x: M + W - 20, y: M, w: M + 20, h: H }]);
    r = after(r, first);
    // The next 90 CSS px of the same pan paint nothing at all.
    for (const tx of [-20, -50, -100]) {
      const next = planReproject(r, { scale: 2, tx, ty: 0 }, vp);
      expect(next).toMatchObject({ kind: "pan", scroll: null, fill: [] });
    }
    // Turning back is free too: what was behind is still held.
    expect(planReproject(r, { scale: 2, tx: 0, ty: 0 }, vp)).toMatchObject({ kind: "pan", fill: [] });
  });

  it("keeps every pixel it claims: the copy always reads from inside what is held", () => {
    let r = fresh();
    let tx = 0;
    let ty = 0;
    for (let i = 0; i < 400; i++) {
      tx -= 7.3;
      ty += i % 3 === 0 ? 4.1 : -1.7;
      const plan = planReproject(r, { scale: 2, tx, ty }, vp);
      if (plan.kind !== "pan") throw new Error("a steady pan never needs a render");
      const { valid, srcX, srcY } = plan;
      expect(srcX).toBeGreaterThanOrEqual(valid.x);
      expect(srcY).toBeGreaterThanOrEqual(valid.y);
      expect(srcX + W).toBeLessThanOrEqual(valid.x + valid.w);
      expect(srcY + H).toBeLessThanOrEqual(valid.y + valid.h);
      expect(valid.x).toBeGreaterThanOrEqual(0);
      expect(valid.x + valid.w).toBeLessThanOrEqual(r.width);
      expect(valid.y + valid.h).toBeLessThanOrEqual(r.height);
      r = after(r, plan);
    }
  });

  it("a steady pan paints on a small share of its frames", () => {
    let r = fresh();
    let paints = 0;
    for (let i = 1; i <= 300; i++) {
      const plan = planReproject(r, { scale: 2, tx: -4 * i, ty: 0 }, vp); // 8 device px a frame
      if (plan.kind !== "pan") throw new Error("expected a pan");
      if (plan.fill.length > 0) paints++;
      r = after(r, plan);
    }
    // One band per margin of travel (200 px / 8 px = 25 frames), not one per frame.
    expect(paints).toBeLessThanOrEqual(300 / 25 + 1);
  });

  it("lands on whole device pixels, so a pan never resamples", () => {
    const plan = planReproject(fresh(), { scale: 2, tx: 0.2, ty: -0.2 }, vp);
    expect(plan).toMatchObject({ kind: "pan", fill: [], srcX: M, srcY: M });
  });

  it("a jump the raster mostly cannot cover is a render", () => {
    expect(planReproject(fresh(), { scale: 2, tx: -400, ty: 0 }, vp).kind).toBe("render");
  });

  it("zooming in scales what is held and exposes nothing", () => {
    // ×2 about the viewport centre (500, 300 device px → 250, 150 CSS).
    const plan = planReproject(fresh(), { scale: 4, tx: -250, ty: -150 }, vp);
    if (plan.kind !== "zoom") throw new Error("expected a zoom");
    expect(plan.holes).toEqual([]);
    expect(plan.dest).toEqual({ x: -500, y: -300, w: 2000, h: 1200 });
  });

  it("zooming out exposes a ring, and too much of one is a render", () => {
    const k = 0.9;
    const plan = planReproject(fresh(), { scale: 2 * k, tx: 250 * (1 - k), ty: 150 * (1 - k) }, vp);
    if (plan.kind !== "zoom") throw new Error("expected a zoom");
    expect(area(plan.holes)).toBeCloseTo(W * H * (1 - k * k), 3);
    expect(planReproject(fresh(), { scale: 1, tx: 125, ty: 75 }, vp).kind).toBe("render");
  });

  it("bandsAround tiles the difference exactly", () => {
    const outer = { x: 0, y: 0, w: 100, h: 60 };
    const inner = { x: 10, y: 20, w: 50, h: 30 };
    expect(area(bandsAround(outer, inner))).toBe(100 * 60 - 50 * 30);
    expect(bandsAround(outer, { x: 500, y: 0, w: 10, h: 10 })).toEqual([outer]);
    expect(bandsAround(outer, outer)).toEqual([]);
  });
});

describe("the margin", () => {
  it("is a quarter of the short side while a layer window still fits one buffer", () => {
    expect(viewOverscanPx(1600, 900)).toBe(225);
    // A snapped window — grown by WINDOW_MARGINS, so up to twice that a side —
    // never passes the cap, and so never has to drop resolution.
    for (const [w, h] of [[3000, 1800], [3900, 2200], [2560, 1440]] as const) {
      const grow = WINDOW_MARGINS * viewOverscanPx(w, h);
      expect(Math.max(w, h) + 4 * grow).toBeLessThanOrEqual(MAX_LAYER_BUFFER_PX);
    }
    expect(viewOverscanPx(5000, 3000)).toBe(0);
  });
});

describe("seenWindow — a magnified layer is kept as a tile, not as a viewport", () => {
  const whole = { x: -4000, y: -3000, width: 12000, height: 9000 };
  const grow = 100;
  const needAt = (x: number, y: number) => ({ x, y, width: 400, height: 240 });

  it("holds at least the margin beyond what is needed, at most twice it", () => {
    const need = needAt(123, 77);
    const win = seenWindow(need, whole, grow)!;
    expect(regionCovers(win, { x: need.x - grow, y: need.y - grow, width: need.width + 2 * grow, height: need.height + 2 * grow })).toBe(true);
    expect(win.width).toBeLessThanOrEqual(need.width + 4 * grow);
    expect(win.height).toBeLessThanOrEqual(need.height + 4 * grow);
  });

  it("is the SAME window for every camera position inside its cell", () => {
    const a = seenWindow(needAt(101, 1), whole, grow);
    expect(seenWindow(needAt(150, 40), whole, grow)).toEqual(a);
    expect(seenWindow(needAt(199, 59), whole, grow)).toEqual(a);
    // …and still covers the need after a pan of a whole margin.
    expect(regionCovers(a!, needAt(101 + grow, 1))).toBe(true);
    expect(seenWindow(needAt(260, 1), whole, grow)).not.toEqual(a);
  });

  it("with no margin is the exact cut — a run of frames pays for nothing extra", () => {
    expect(seenWindow(needAt(123, 77), whole, 0)).toEqual(needAt(123, 77));
  });

  it("holds the band a pan paints ahead: one margin past the viewport, from a margin of travel away", () => {
    // Raster margin m, window grown by WINDOW_MARGINS·m around the settled view.
    const m = 50;
    const settled = needAt(1000, 500);
    const win = seenWindow(settled, whole, WINDOW_MARGINS * m)!;
    for (const d of [-m, -m / 2, 0, m / 2, m]) {
      // The raster re-centred on a viewport that has travelled d: it ± m.
      const band = { x: settled.x + d - m, y: settled.y + d - m, width: settled.width + 2 * m, height: settled.height + 2 * m };
      expect(regionCovers(win, band)).toBe(true);
    }
  });

  it("never leaves the layer, and is null when it would be the whole of it", () => {
    const win = seenWindow({ x: -4050, y: -3050, width: 400, height: 240 }, whole, grow)!;
    expect(win.x).toBe(whole.x);
    expect(win.y).toBe(whole.y);
    expect(seenWindow({ x: -5000, y: -5000, width: 20000, height: 20000 }, whole, grow)).toBeNull();
  });
});
