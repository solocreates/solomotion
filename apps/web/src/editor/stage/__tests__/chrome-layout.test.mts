import { describe, expect, it } from "vitest";
import { fitZonedBand } from "../chrome-layout";

const gap = 8;

describe("fitZonedBand", () => {
  it("keeps one row while nav, tool options and stage settings fit side by side", () => {
    expect(fitZonedBand({ band: 1200, start: 200, center: 560, end: 150, gap })).toBe("row");
  });

  it("stacks the tool options under the nav only when the three do not fit", () => {
    expect(fitZonedBand({ band: 760, start: 200, center: 560, end: 150, gap })).toBe("stacked");
  });

  it("never stacks under an EMPTY nav: the options sit beside the stage settings and scroll", () => {
    expect(fitZonedBand({ band: 500, start: 0, center: 560, end: 150, gap })).toBe("row");
  });

  it("counts a gap only between zones that are there", () => {
    expect(fitZonedBand({ band: 200 + 560 + 150 + 2 * gap, start: 200, center: 560, end: 150, gap })).toBe("row");
    expect(fitZonedBand({ band: 200 + 560 + 150 + 2 * gap - 1, start: 200, center: 560, end: 150, gap })).toBe("stacked");
  });
});
