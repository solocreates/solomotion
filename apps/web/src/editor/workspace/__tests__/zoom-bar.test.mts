import { describe, expect, it } from "vitest";
import { centredAt, dragWindow, shownExtent, thumbRect, type AxisWindow } from "../zoom-bar";

// 10 s of content; showing 2–4 s; zoom allows 0.1 s … 20 s windows.
const w0: AxisWindow = { start: 2000, size: 2000, extent: 10000, minSize: 100, maxSize: 20000 };

describe("thumbRect", () => {
  it("maps the window onto the bar", () => {
    expect(thumbRect(2000, 2000, 10000, 1000, 24)).toEqual({ left: 200, width: 200 });
  });
  it("keeps a tiny window grabbable and inside the bar", () => {
    expect(thumbRect(9990, 5, 10000, 1000, 24)).toEqual({ left: 976, width: 24 });
  });
});

describe("dragWindow", () => {
  const e0 = shownExtent(w0);
  it("body pans 1:1, clamped to the ends", () => {
    expect(dragWindow("body", w0, e0, 3000)).toEqual({ start: 3000, size: 2000 });
    expect(dragWindow("body", w0, e0, -50)).toEqual({ start: 0, size: 2000 });
    expect(dragWindow("body", w0, e0, 9500)).toEqual({ start: 8000, size: 2000 });
  });
  it("end grip puts the end exactly at the pointer, start held", () => {
    expect(dragWindow("end", w0, e0, 6000)).toEqual({ start: 2000, size: 4000 });
    expect(dragWindow("end", w0, e0, 2010)).toEqual({ start: 2000, size: 100 });
  });
  it("start grip puts the start exactly at the pointer, end held", () => {
    expect(dragWindow("start", w0, e0, 1000)).toEqual({ start: 1000, size: 3000 });
    expect(dragWindow("start", w0, e0, 3990)).toEqual({ start: 3900, size: 100 });
  });
  it("zoomed out past the content: no jump at the press, then 1:1", () => {
    // Showing 0–30 s of a 10 s piece: the frozen bar stands for 30 s.
    const wide: AxisWindow = { ...w0, start: 0, size: 30000 };
    const e = shownExtent(wide);
    expect(e).toBe(30000);
    expect(dragWindow("end", wide, e, 30000)).toEqual({ start: 0, size: 30000 });
    expect(dragWindow("end", wide, e, 15000)).toEqual({ start: 0, size: 15000 });
  });
  it("never exceeds the axis's zoom bounds", () => {
    const e = 50000;
    expect(dragWindow("end", { ...w0, start: 0 }, e, 45000)).toEqual({ start: 0, size: 20000 });
  });
});

describe("centredAt", () => {
  it("centres on the click, never past either end", () => {
    expect(centredAt(w0, 5000)).toBe(4000);
    expect(centredAt(w0, 100)).toBe(0);
    expect(centredAt(w0, 9900)).toBe(8000);
  });
});
