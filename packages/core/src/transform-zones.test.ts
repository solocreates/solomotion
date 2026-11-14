import { describe, expect, it } from "vitest";
import { HANDLE_HIT_PX, ROTATE_BAND_PX, cornerBearing, edgeBearing, rotateZoneCorner, type ScreenPoint } from "./transform-zones";

const box = (cx: number, cy: number, w: number, h: number, deg = 0): ScreenPoint[] => {
  const r = (deg * Math.PI) / 180;
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x, y]) => ({ x: cx + x! * Math.cos(r) - y! * Math.sin(r), y: cy + x! * Math.sin(r) + y! * Math.cos(r) }));
};

const REACH = HANDLE_HIT_PX + ROTATE_BAND_PX;

describe("rotateZoneCorner", () => {
  const b = box(0, 0, 200, 100);
  const ne = b[1]!;

  it("claims the band beyond both edges of a corner", () => {
    expect(rotateZoneCorner({ x: ne.x + 9, y: ne.y - 9 }, b)).toBe(1);
  });

  it("leaves the resize handle alone", () => {
    expect(rotateZoneCorner({ x: ne.x + 4, y: ne.y - 4 }, b)).toBeNull();
  });

  it("stops at its reach", () => {
    const d = (REACH + 1) / Math.SQRT2;
    expect(rotateZoneCorner({ x: ne.x + d, y: ne.y - d }, b)).toBeNull();
  });

  it("never claims beside an edge, however near the corner", () => {
    expect(rotateZoneCorner({ x: ne.x - 2, y: ne.y - 14 }, b)).toBeNull();
    expect(rotateZoneCorner({ x: ne.x + 14, y: ne.y + 2 }, b)).toBeNull();
  });

  it("never claims inside the box", () => {
    expect(rotateZoneCorner({ x: ne.x - 10, y: ne.y + 10 }, b)).toBeNull();
  });

  it("follows the layer's rotation", () => {
    const turned = box(0, 0, 200, 100, 37);
    const c = turned[1]!;
    const out = (cornerBearing(turned, 1) * Math.PI) / 180;
    const at = { x: c.x + 14 * Math.cos(out), y: c.y + 14 * Math.sin(out) };
    expect(rotateZoneCorner(at, turned)).toBe(1);
  });

  it("does not care where the pivot is, because it is not told", () => {
    const small = box(500, 500, 40, 40);
    expect(rotateZoneCorner({ x: 500, y: 500 }, small)).toBeNull();
  });
});

describe("bearings", () => {
  it("a corner faces 45 degrees whatever the box's aspect", () => {
    expect(cornerBearing(box(0, 0, 1000, 10), 2)).toBeCloseTo(45);
    expect(cornerBearing(box(0, 0, 1000, 10), 1)).toBeCloseTo(-45);
  });

  it("turns with the layer", () => {
    expect(cornerBearing(box(0, 0, 300, 20, 30), 2)).toBeCloseTo(75);
    expect(edgeBearing(box(0, 0, 300, 20, 30), 1)).toBeCloseTo(30);
  });

  it("an edge faces its outward normal", () => {
    const b = box(0, 0, 100, 100);
    expect(edgeBearing(b, 0)).toBeCloseTo(-90);
    expect(edgeBearing(b, 1)).toBeCloseTo(0);
    expect(edgeBearing(b, 2)).toBeCloseTo(90);
    expect(Math.abs(edgeBearing(b, 3))).toBeCloseTo(180);
  });
});
