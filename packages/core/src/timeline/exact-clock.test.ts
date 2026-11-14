import { describe, expect, it } from "vitest";
import {
  exactClockAdvance,
  exactClockShown,
  exactClockVerdict,
  startExactClock,
  type ExactClock,
  type ExactClockTiming,
} from "./exact-clock";

const T30: ExactClockTiming = { stepMs: 1000 / 30, paced: true, tickMs: 1000 / 60, stallMs: 1500 };

/** Drive the clock on display ticks; `showAfter(i)` = ms instant i takes to be shown. */
function run(t: ExactClockTiming, ticks: number, showAfter: (instant: number) => number) {
  let clock: ExactClock = startExactClock(0);
  let instant = 0;
  const advancedAt: number[] = [];
  for (let k = 0; k <= ticks; k++) {
    const now = k * t.tickMs;
    if (clock.shownAt === null && now - clock.waitingSince >= showAfter(instant)) clock = exactClockShown(clock, now);
    const v = exactClockVerdict(clock, now, t);
    if (v !== "wait") {
      clock = exactClockAdvance(clock, now, t);
      instant++;
      advancedAt.push(now);
    }
  }
  return { instant, advancedAt };
}

describe("exact clock", () => {
  it("plays fast frames at real time — every second tick for 30fps on 60Hz", () => {
    const { instant, advancedAt } = run(T30, 60, () => 0);
    expect(instant).toBe(30);
    const gaps = advancedAt.slice(1).map((a, i) => Math.round(a - advancedAt[i]!));
    expect(new Set(gaps)).toEqual(new Set([33]));
  });

  it("never advances before the instant is shown", () => {
    let c = startExactClock(0);
    expect(exactClockVerdict(c, 500, T30)).toBe("wait");
    c = exactClockShown(c, 500);
    expect(exactClockVerdict(c, 500, T30)).toBe("advance");
  });

  it("re-anchors after a slow frame instead of catching up in a burst", () => {
    // Instant 3 takes 200ms; everything else is instant.
    const { advancedAt } = run(T30, 40, (i) => (i === 3 ? 200 : 0));
    const gaps = advancedAt.slice(1).map((a, i) => a - advancedAt[i]!);
    // After the stall, every step is a full frame again — no zero-length steps.
    expect(Math.min(...gaps)).toBeGreaterThan(30);
  });

  it("a slow comp runs as fast as it is made, not slower", () => {
    // Every frame takes 50ms to make (> one 33ms frame).
    const { instant } = run(T30, 60, () => 50);
    // 1s of ticks ≈ 1000/(50 + one tick to notice) frames — not halved by pacing on top.
    expect(instant).toBeGreaterThanOrEqual(14);
  });

  it("an unpaced build advances the moment each instant is shown", () => {
    const { instant } = run({ ...T30, paced: false }, 30, () => 0);
    expect(instant).toBe(31);
  });

  it("a comp slower than the display holds each frame for its whole duration", () => {
    const T4 = { ...T30, stepMs: 250 };
    const { advancedAt } = run(T4, 120, () => 0);
    const gaps = advancedAt.slice(1).map((a, i) => Math.round(a - advancedAt[i]!));
    for (const g of gaps) expect(Math.abs(g - 250)).toBeLessThanOrEqual(9);
  });

  it("releases a stalled instant after stallMs", () => {
    const c = startExactClock(0);
    expect(exactClockVerdict(c, 1499, T30)).toBe("wait");
    expect(exactClockVerdict(c, 1500, T30)).toBe("stalled");
  });
});
