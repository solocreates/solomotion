import { describe, expect, it } from "vitest";
import { closeRun, openingTier } from "./resolution";

describe("a comp's tier memory", () => {
  it("never played: predicted from its parked frame", () => {
    expect(openingTier(null, 5, 30).tier).toBe("full");
    expect(openingTier(null, 500, 30).tier).not.toBe("full");
  });

  it("a cheap proven run opens the next one a tier sharper, falling back no further than proven", () => {
    const m = closeRun(null, "eighth", "eighth", 4);
    expect(openingTier(m, 4, 30)).toEqual({ tier: "quarter", floor: "eighth" });
  });

  it("a probe that stepped down is not tried again; the proven tier holds", () => {
    const proven = closeRun(null, "quarter", "quarter", 5);
    expect(openingTier(proven, 5, 30).tier).toBe("half");
    const failed = closeRun(proven, "half", "quarter", 5);
    expect(failed.ceiling).toBe("half");
    expect(openingTier(failed, 5, 30).tier).toBe("quarter");
  });

  it("a costly proven run stays where it is, under the cap", () => {
    const m = closeRun(null, "half", "half", 30);
    expect(openingTier(m, 30, 30).tier).toBe("half");
    expect(openingTier(closeRun(null, "full", "full", 2), 2, 30, "quarter").tier).toBe("quarter");
  });
});
