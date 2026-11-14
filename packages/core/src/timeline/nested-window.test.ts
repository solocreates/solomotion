import { describe, expect, it } from "vitest";
import { frameHasOpaquePaper, isOpaqueColor, isTransparentColor, nestedClipsContent } from "./nested-window";

const comp = (background: string, overflow = 0.25, fills: never[] = []) => ({ background, overflow, fills });

describe("nestedClipsContent", () => {
  it("lets a transparent part spill and windows an opaque scene (Auto)", () => {
    expect(nestedClipsContent({ clipContent: null }, comp("#00000000"))).toBe(false);
    expect(nestedClipsContent({ clipContent: null }, comp("#FFF0E8"))).toBe(true);
  });
  it("honours the comp's own crop and never-crop", () => {
    expect(nestedClipsContent({ clipContent: null }, comp("#00000000", 0))).toBe(true);
    expect(nestedClipsContent({ clipContent: null }, comp("#FFF0E8", 1))).toBe(false);
  });
  it("the clip's switch wins", () => {
    expect(nestedClipsContent({ clipContent: true }, comp("#00000000", 1))).toBe(true);
    expect(nestedClipsContent({ clipContent: false }, comp("#FFFFFF", 0))).toBe(false);
  });
  it("reads alpha in every colour form", () => {
    for (const c of ["transparent", "#12345600", "#1230", "rgba(0,0,0,0)", "hsla(10, 20%, 30%, 0)"]) expect(isTransparentColor(c)).toBe(true);
    for (const c of ["#123456", "#12345601", "#123", "rgba(0,0,0,0.5)"]) expect(isTransparentColor(c)).toBe(false);
  });
});

describe("frameHasOpaquePaper", () => {
  it("reads opaque hex and rgb, and nothing it cannot be sure of", () => {
    expect(["#fff", "#F4EEDF", "#f4eedfff", "rgb(1, 2, 3)", "rgba(1,2,3,1)", "hsl(10 20% 30%)"].map(isOpaqueColor)).toEqual([true, true, true, true, true, true]);
    expect(["#f4eedf80", "rgba(1,2,3,0.5)", "transparent", "var:paper", "red"].map(isOpaqueColor)).toEqual([false, false, false, false, false]);
  });

  it("needs a full, normal, solid fill when the comp has fills", () => {
    const fill = (over: Record<string, unknown>) => ({ type: "solid", color: "#fff", opacity: 1, blendMode: "normal", enabled: true, ...over });
    const frame = (fills: unknown[]) => ({ background: "#fff", fills }) as Parameters<typeof frameHasOpaquePaper>[0];
    expect(frameHasOpaquePaper(frame([fill({})]))).toBe(true);
    expect(frameHasOpaquePaper(frame([fill({ opacity: 0.5 })]))).toBe(false);
    expect(frameHasOpaquePaper(frame([fill({ blendMode: "multiply" })]))).toBe(false);
    expect(frameHasOpaquePaper(frame([fill({ enabled: false })]))).toBe(false);
  });
});
