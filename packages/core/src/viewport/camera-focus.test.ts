import { describe, expect, it } from "vitest";
import { isBoundsVisible, panToReveal } from "./camera";
import { focusAnchorOf } from "./focus";

const vp = { width: 1000, height: 600 };
const cam = { scale: 1, tx: 0, ty: 0 };

describe("smart focus never fights you (D16)", () => {
  it("does not move at all while any part of the target is on screen", () => {
    expect(panToReveal({ minX: 990, minY: 10, maxX: 4000, maxY: 50 }, cam, vp)).toBe(cam);
    expect(panToReveal({ minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 }, cam, vp)).toBe(cam);
  });
  it("off screen → the smallest pan, never a zoom", () => {
    const next = panToReveal({ minX: 1500, minY: 100, maxX: 1600, maxY: 200 }, cam, vp, 48);
    expect(next.scale).toBe(1);
    expect(next.ty).toBe(0); // y already overlapped — untouched
    expect(1600 + next.tx).toBe(1000 - 48); // its far edge lands just inside
    expect(isBoundsVisible({ minX: 1500, minY: 100, maxX: 1600, maxY: 200 }, next, vp)).toBe(true);
    const left = panToReveal({ minX: -900, minY: 700, maxX: -800, maxY: 800 }, { scale: 0.5, tx: 0, ty: 0 }, vp, 48);
    expect(left.scale).toBe(0.5);
    expect(-900 * 0.5 + left.tx).toBe(48);
  });
  it("a target bigger than the view shows its start", () => {
    const next = panToReveal({ minX: 3000, minY: 0, maxX: 9000, maxY: 10 }, cam, vp, 48);
    expect(3000 + next.tx).toBe(48);
  });
  it("garbage bounds (an empty emitter's NaN/Infinity box) never move the camera", () => {
    expect(panToReveal({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, cam, vp)).toBe(cam);
    expect(panToReveal({ minX: NaN, minY: 0, maxX: 1, maxY: 1 }, cam, vp)).toBe(cam);
  });
});

describe("unstable-bounds layers focus on their anchor", () => {
  it("emitters, bodies and force carriers answer with their anchor; others with their box", () => {
    expect(focusAnchorOf({ emitters: [{}] } as never)).toBe(true);
    expect(focusAnchorOf({ physics: {} } as never)).toBe(true);
    expect(focusAnchorOf({ forces: [{}] } as never)).toBe(true);
    expect(focusAnchorOf({ emitters: [] } as never)).toBe(false);
    expect(focusAnchorOf({} as never)).toBe(false);
  });
  it("an emitter whose particles cover the world is still focused by a pan to its anchor", () => {
    // The hit rect of a busy emitter: huge. Focusing THAT would never move (it
    // is always "visible"), or zoom out to nothing. The anchor is a point.
    const anchor = { x: 4000, y: 300 };
    const next = panToReveal({ minX: anchor.x, minY: anchor.y, maxX: anchor.x, maxY: anchor.y }, cam, vp, 48);
    expect(next.scale).toBe(1);
    expect(anchor.x + next.tx).toBe(1000 - 48);
  });
});
