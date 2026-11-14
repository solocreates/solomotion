import { describe, expect, it } from "vitest";
import { placeCallout, type Rect } from "./callout";

const VIEW: Rect = { x: 0, y: 0, width: 1000, height: 800 };
const SIZE = { width: 200, height: 40 };

describe("placeCallout", () => {
  it("sits above the layer, centred on it — the reading order people expect", () => {
    const anchor: Rect = { x: 400, y: 300, width: 100, height: 100 };
    const p = placeCallout({ anchor, size: SIZE, viewport: VIEW });
    expect(p.side).toBe("top");
    expect(p.fits).toBe(true);
    expect(p.x).toBe(400 + 50 - 100); // centred
    expect(p.y).toBe(300 - 10 - 40); // gap + its own height
  });

  it("flips below when the layer is against the top edge", () => {
    const anchor: Rect = { x: 400, y: 4, width: 100, height: 100 };
    const p = placeCallout({ anchor, size: SIZE, viewport: VIEW });
    expect(p.side).toBe("bottom");
    expect(p.y).toBe(4 + 100 + 10);
  });

  it("goes beside when neither above nor below has room", () => {
    const anchor: Rect = { x: 400, y: 10, width: 100, height: 760 };
    const p = placeCallout({ anchor, size: SIZE, viewport: VIEW });
    expect(p.side).toBe("right");
    expect(p.x).toBe(400 + 100 + 10);
  });

  it("clamps into the viewport near a corner instead of running off it", () => {
    const anchor: Rect = { x: 960, y: 300, width: 30, height: 30 };
    const p = placeCallout({ anchor, size: SIZE, viewport: VIEW });
    expect(p.side).toBe("top");
    expect(p.x).toBe(1000 - 8 - 200);
    expect(p.x + SIZE.width).toBeLessThanOrEqual(VIEW.width);
  });

  it("clamps at the left edge too", () => {
    const anchor: Rect = { x: 2, y: 300, width: 30, height: 30 };
    const p = placeCallout({ anchor, size: SIZE, viewport: VIEW });
    expect(p.x).toBe(8);
  });

  it("takes the roomiest side and says it does not fit, rather than vanishing", () => {
    // A layer filling a tiny viewport: nowhere is right, so the answer has to
    // be the least-wrong place plus an honest flag.
    const tiny: Rect = { x: 0, y: 0, width: 220, height: 100 };
    const anchor: Rect = { x: 10, y: 10, width: 200, height: 80 };
    const p = placeCallout({ anchor, size: SIZE, viewport: tiny });
    expect(p.fits).toBe(false);
    expect(p.x).toBeGreaterThanOrEqual(tiny.x);
    expect(p.y).toBeGreaterThanOrEqual(tiny.y);
  });

  it("honours a caller's preferred order", () => {
    const anchor: Rect = { x: 400, y: 300, width: 100, height: 100 };
    const p = placeCallout({ anchor, size: SIZE, viewport: VIEW, prefer: ["bottom", "top"] });
    expect(p.side).toBe("bottom");
  });

  it("respects gap and margin", () => {
    const anchor: Rect = { x: 400, y: 300, width: 100, height: 100 };
    const p = placeCallout({ anchor, size: SIZE, viewport: VIEW, gap: 24 });
    expect(p.y).toBe(300 - 24 - 40);
    const edge = placeCallout({
      anchor: { x: 980, y: 300, width: 10, height: 10 },
      size: SIZE,
      viewport: VIEW,
      margin: 20,
    });
    expect(edge.x).toBe(1000 - 20 - 200);
  });

  it("never returns a non-finite origin, whatever it is handed", () => {
    const p = placeCallout({
      anchor: { x: 0, y: 0, width: 0, height: 0 },
      size: { width: 0, height: 0 },
      viewport: { x: 0, y: 0, width: 0, height: 0 },
    });
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });
});
