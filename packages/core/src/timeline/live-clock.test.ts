import { describe, expect, it } from "vitest";
import { anchorLiveClock, cueLookaheadMs, liveClockAt } from "./live-clock";

describe("live clock — read off the master clock, never accumulated", () => {
  it("a late read is a later playhead, however long the frame took", () => {
    const c = anchorLiveClock(1000, 10, "audio");
    // A 600 ms render between two reads: the second read is 600 ms on, not stale.
    expect(liveClockAt(c, 10.6)).toBeCloseTo(1600);
    expect(liveClockAt(c, 11.2)).toBeCloseTo(2200);
  });
  it("runs backwards for pingpong and never before its anchor", () => {
    const c = anchorLiveClock(5000, 2, "wall", -1);
    expect(liveClockAt(c, 3)).toBeCloseTo(4000);
    expect(liveClockAt(c, 1)).toBe(5000);
  });
});

describe("cueLookaheadMs — slow ticks must not starve the sound", () => {
  it("keeps the base on a healthy frame rate and grows with the gap, capped", () => {
    expect(cueLookaheadMs(160, 16)).toBe(160);
    expect(cueLookaheadMs(160, 600)).toBe(900);
    expect(cueLookaheadMs(160, 5000)).toBe(1200);
  });
});
