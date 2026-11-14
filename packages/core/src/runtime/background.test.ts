import { describe, expect, it } from "vitest";
import { backgroundWaitMs, createBackgroundLane } from "./background";

const gate = { duty: 0.25, quietMs: 100 };

describe("backgroundWaitMs — when optional work may start", () => {
  it("starts at once when nothing ran and nobody is typing", () => {
    expect(backgroundWaitMs({ nowMs: 0, lastEndMs: -Infinity, lastCostMs: 0, lastInputMs: -Infinity }, gate)).toBe(0);
  });
  it("a job of C ms buys the foreground C·(1/duty − 1) ms back", () => {
    // 1 s job at 25 % duty → 3 s gap.
    expect(backgroundWaitMs({ nowMs: 1000, lastEndMs: 1000, lastCostMs: 1000, lastInputMs: -Infinity }, gate)).toBe(3000);
  });
  it("input holds work for the quiet window", () => {
    expect(backgroundWaitMs({ nowMs: 50, lastEndMs: -Infinity, lastCostMs: 0, lastInputMs: 20 }, gate)).toBe(70);
  });
});

describe("createBackgroundLane — one at a time, cost-paced, foreground first", () => {
  function harness(busy = { on: false }) {
    let t = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const lane = createBackgroundLane({
      gate,
      now: () => t,
      isBusy: () => busy.on,
      busyRetryMs: 500,
      setTimer: (fn, ms) => void timers.push({ at: t + ms, fn }),
    });
    const advance = (to: number) => {
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > to) break;
        timers.shift();
        t = Math.max(t, next.at);
        next.fn();
      }
      t = to;
    };
    return { lane, advance, setNow: (v: number) => (t = v), now: () => t, busy };
  }

  it("spaces a heavy job's successor by the duty gap", () => {
    const h = harness();
    const ran: number[] = [];
    const heavy = () => {
      ran.push(h.now());
      h.setNow(h.now() + 400); // a 400 ms synchronous render
    };
    h.lane.request(heavy);
    h.lane.request(heavy);
    h.advance(0);
    expect(ran).toEqual([0]);
    h.advance(1500);
    expect(ran).toEqual([0]);
    h.advance(1600); // 400 + 400·3
    expect(ran).toEqual([0, 1600]);
  });

  it("never starts while the foreground is busy", () => {
    const h = harness({ on: true });
    let ran = 0;
    h.lane.request(() => ran++);
    h.advance(2000);
    expect(ran).toBe(0);
    h.busy.on = false;
    h.advance(2500);
    expect(ran).toBe(1);
  });

  it("survives a job that throws", () => {
    const h = harness();
    let ran = 0;
    h.lane.request(() => {
      throw new Error("bad thumbnail");
    });
    h.lane.request(() => ran++);
    h.advance(100);
    expect(ran).toBe(1);
  });
});
