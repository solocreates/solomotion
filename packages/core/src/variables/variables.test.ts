import { describe, expect, it } from "vitest";
import {
  addVariable,
  createEmptyDocument,
  findVariableByCssName,
  suggestVariables,
  variableCssName,
  setVariableClock,
  variableValueAt,
  variableValueNow,
  type Variable,
} from "../index";

/**
 * Keyframable variables — the one seam (`variableValueNow`) every typed resolver
 * funnels through. Static variables read their literal; animated ones sample the
 * `"value"` track, with numbers lerping and colors blending via the shared
 * keyframe engine's value-based interpolation (no per-key registry entry).
 */
describe("keyframable variables", () => {
  const numberVar: Variable = {
    id: "v1",
    name: "Size",
    type: "number",
    value: 10,
    keyframes: [
      {
        id: "t1",
        property: "value",
        range: null,
        keys: [
          { id: "k1", timeMs: 0, value: 20, easing: { kind: "linear" } },
          { id: "k2", timeMs: 1000, value: 80, easing: { kind: "linear" } },
        ],
      },
    ],
  };

  const colorVar: Variable = {
    id: "v2",
    name: "Brand",
    type: "color",
    value: "#000000",
    keyframes: [
      {
        id: "t2",
        property: "value",
        range: null,
        keys: [
          { id: "k3", timeMs: 0, value: "#000000", easing: { kind: "linear" } },
          { id: "k4", timeMs: 1000, value: "#ffffff", easing: { kind: "linear" } },
        ],
      },
    ],
  };

  const staticVar: Variable = { id: "v3", name: "Weight", type: "fontWeight", value: 400 };

  it("samples a number track at an explicit time (lerp)", () => {
    expect(variableValueAt(numberVar, 0)).toBe(20);
    expect(variableValueAt(numberVar, 500)).toBe(50);
    expect(variableValueAt(numberVar, 1000)).toBe(80);
  });

  it("blends a color track at an explicit time", () => {
    expect(variableValueAt(colorVar, 0)).toBe("#000000");
    expect(variableValueAt(colorVar, 1000)).toBe("#ffffff");
    const mid = variableValueAt(colorVar, 500);
    expect(typeof mid).toBe("string");
    expect(mid).not.toBe("#000000");
    expect(mid).not.toBe("#ffffff");
  });

  it("a variable with no track reads its literal at any time", () => {
    expect(variableValueAt(staticVar, 0)).toBe(400);
    expect(variableValueAt(staticVar, 9999)).toBe(400);
  });

  it("variableValueNow honours the ambient clock, else the literal", () => {
    setVariableClock(null);
    expect(variableValueNow(numberVar)).toBe(10); // literal when clock unset
    setVariableClock(500);
    expect(variableValueNow(numberVar)).toBe(50); // sampled at the clock
    setVariableClock(null); // restore for other tests
  });
});

describe("variables by --name", () => {
  const doc = () => {
    const d = createEmptyDocument();
    addVariable(d, "color", "Brand deep", "#0b8a57");
    addVariable(d, "number", "Title size", 64);
    addVariable(d, "number", "Brand spacing", 24);
    return d;
  };
  it("spells a name the way it is typed", () => {
    expect(variableCssName("Brand deep")).toBe("--brand-deep");
    expect(variableCssName("  Größe 2 ")).toBe("--grosse-2");
  });
  it("finds the variable a --name means", () => {
    const d = doc();
    expect(findVariableByCssName(d, "--title-size")?.name).toBe("Title size");
    expect(findVariableByCssName(d, "--TITLE-SIZE ")?.name).toBe("Title size");
    expect(findVariableByCssName(d, "--nope")).toBeNull();
    expect(findVariableByCssName(d, "title-size")).toBeNull();
  });
  it("suggests by prefix, then anywhere, filtered by type", () => {
    const d = doc();
    expect(suggestVariables(d, "--brand").map((v) => v.name)).toEqual(["Brand deep", "Brand spacing"]);
    expect(suggestVariables(d, "--brand", ["number"]).map((v) => v.name)).toEqual(["Brand spacing"]);
    expect(suggestVariables(d, "--size").map((v) => v.name)).toEqual(["Title size"]);
    expect(suggestVariables(d, "--").length).toBe(3);
  });
});
