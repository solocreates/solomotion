import { afterEach, describe, expect, it } from "vitest";
import { ATOM_DEFAULT_FILL, brandFillColor, createShapeClip, setBrandFill } from "./index";

describe("brand fill", () => {
  afterEach(() => setBrandFill(ATOM_DEFAULT_FILL));

  it("is the Atom swatch until the app stamps one", () => {
    expect(brandFillColor()).toBe(ATOM_DEFAULT_FILL);
  });

  it("paints a shape drawn with no fill in the stamped primary", () => {
    setBrandFill("#36f1a8");
    const clip = createShapeClip({ frameId: "f", shape: "rect", startMs: 0 });
    const fill = clip.fills[0]!;
    expect(fill.type === "solid" && fill.color).toBe("#36F1A8");
  });

  it("ignores a value that is not a plain hex (a theme may compile oklch or color-mix)", () => {
    setBrandFill("color-mix(in oklab, red, blue)");
    expect(brandFillColor()).toBe(ATOM_DEFAULT_FILL);
  });
});
