import { describe, expect, it } from "vitest";
import { mapSpanThroughCount, numberAlignedView } from "./count-up";

describe("ranges follow a number's width at rest", () => {
  it("the '+' after '0' is still the '+' after '40'", () => {
    const view = numberAlignedView("0+", "40+")!;
    expect(mapSpanThroughCount(view, 1, 2)).toEqual({ start: 2, end: 3 });
    // A range on the number covers the whole new number.
    expect(mapSpanThroughCount(view, 0, 1)).toEqual({ start: 0, end: 2 });
  });

  it("no mapping when anything but the numbers changed", () => {
    expect(numberAlignedView("0 users", "40 people")).toBeNull();
  });
});
