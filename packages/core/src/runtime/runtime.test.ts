import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeClock } from "./clock";
import { runChunked, setYieldStrategy, type ChunkStep } from "./chunk";
import { DEFAULT_RUNTIME_CONFIG, resolveLimitMs } from "./config";
import { LIMIT_UNLIMITED, fixedLimit, registerTaskKind, taskKind } from "./kinds";
import { RuntimeLoopError, loopGuard } from "./guard";
import { TaskAborted, isTaskAborted } from "./signal";
import { supervise, supervisor } from "./supervisor";
import { Watchdog, diagnoseBlackBox } from "./watchdog";

/**
 * The runtime is the one system in the app whose failure mode is "nothing
 * happens, forever", so every claim it makes is pinned here against a fake
 * clock. Real time would make these slow and flaky, which for a deadline
 * engine is the same as untested.
 */

let t = 0;
const tick = (ms: number) => {
  t += ms;
};

beforeEach(() => {
  t = 1000;
  setRuntimeClock(() => t);
  // Yield without a real task queue, so slices are deterministic.
  setYieldStrategy(() => Promise.resolve());
  supervisor.reset();
});

afterEach(() => {
  setRuntimeClock(null);
  setYieldStrategy(null);
  vi.useRealTimers();
});

describe("resolveLimitMs — one budget, three authorities", () => {
  const kind = registerTaskKind({
    id: "test.fixed",
    label: "Fixed",
    hint: "",
    limit: fixedLimit(5_000),
    warnMs: 500,
    onExpire: "abort",
    cancellable: true,
  });
  const free = registerTaskKind({
    id: "test.free",
    label: "Free",
    hint: "",
    limit: LIMIT_UNLIMITED,
    warnMs: 500,
    onExpire: "warn",
    cancellable: true,
  });

  it("prefers the person's override, then the kind, then the global default", () => {
    const base = { ...DEFAULT_RUNTIME_CONFIG, defaultLimitMs: 9_000 };
    expect(resolveLimitMs(base, kind)).toBe(5_000);
    expect(resolveLimitMs(base, "task")).toBe(9_000);
    expect(resolveLimitMs({ ...base, limits: { "test.fixed": fixedLimit(200) } }, kind)).toBe(200);
  });

  it("keeps 'unlimited' unlimited — the global default must not shoot an export", () => {
    // The whole reason the limit is a three-state union: a kind that declares
    // it may run for an hour must not inherit a 30s default.
    expect(resolveLimitMs({ ...DEFAULT_RUNTIME_CONFIG, defaultLimitMs: 30_000 }, free)).toBeNull();
  });

  it("turns every limit off when the master switch is off", () => {
    expect(resolveLimitMs({ ...DEFAULT_RUNTIME_CONFIG, enabled: false }, kind)).toBeNull();
  });

  it("treats a per-kind override of 'unlimited' as unlimited", () => {
    const cfg = { ...DEFAULT_RUNTIME_CONFIG, limits: { "test.fixed": LIMIT_UNLIMITED } };
    expect(resolveLimitMs(cfg, kind)).toBeNull();
  });
});

describe("TaskSignal — the deadline a loop enforces on itself", () => {
  it("throws TaskAborted once the budget is spent, and names the task", async () => {
    const run = supervise({ kind: "test.fixed", label: "Grind", limitMs: 50 }, (signal) => {
      for (let i = 0; i < 1e6; i++) {
        tick(1);
        signal.tick();
      }
      return "finished";
    });
    await expect(run).rejects.toThrow(TaskAborted);
    await run.catch((e) => {
      expect(isTaskAborted(e)).toBe(true);
      expect((e as TaskAborted).reason).toBe("expired");
      expect((e as TaskAborted).label).toBe("Grind");
    });
  });

  it("adapts its stride so a heavy body does not overshoot its deadline", async () => {
    // 100ms per iteration against a 1s budget. A fixed 256-iteration stride
    // would sample the clock after 25 seconds; the adaptive one must stop
    // within a couple of iterations of the deadline.
    let iterations = 0;
    const run = supervise({ label: "Heavy", limitMs: 1_000 }, (signal) => {
      for (;;) {
        tick(100);
        iterations++;
        signal.tick();
      }
    });
    await expect(run).rejects.toThrow(TaskAborted);
    expect(iterations).toBeLessThan(40);
  });

  it("never expires a task with no limit", async () => {
    const out = await supervise({ label: "Free", limitMs: null }, (signal) => {
      for (let i = 0; i < 5_000; i++) {
        tick(10);
        signal.tick();
      }
      return 42;
    });
    expect(out).toBe(42);
  });
});

describe("runChunked — the part that keeps the app responsive", () => {
  it("yields between slices and reports progress as it goes", async () => {
    let yields = 0;
    setYieldStrategy(() => {
      yields++;
      return Promise.resolve();
    });
    const steps: number[] = [];
    const out = await supervise({ label: "Slices", limitMs: null, sliceMs: 10 }, function* (s) {
      for (let i = 0; i < 10; i++) {
        s.tick();
        tick(4); // three iterations fills a 10ms slice
        yield { progress: (i + 1) / 10 };
      }
      return "done";
    });
    expect(out).toBe("done");
    expect(yields).toBeGreaterThan(2);
    expect(steps).toEqual([]);
  });

  it("closes the generator on abort so its finally still runs", async () => {
    let cleaned = false;
    const run = supervise({ label: "Holds a resource", limitMs: 20, sliceMs: 5 }, function* (s) {
      try {
        for (;;) {
          s.tick();
          tick(10);
          yield;
        }
      } finally {
        cleaned = true;
      }
    });
    await expect(run).rejects.toThrow(TaskAborted);
    expect(cleaned).toBe(true);
  });

  it("stops at the next yield when someone presses Stop", async () => {
    let ran = 0;
    const run = supervise({ label: "Stoppable", limitMs: null, sliceMs: 1 }, function* (s) {
      for (;;) {
        s.tick();
        ran++;
        tick(2);
        yield;
      }
    });
    // Let it start, then cancel the one live task.
    await Promise.resolve();
    supervisor.cancel(supervisor.running()[0]!.id);
    await expect(run).rejects.toMatchObject({ reason: "cancelled" });
    expect(ran).toBeGreaterThan(0);
  });
});

describe("the supervisor's table", () => {
  it("shows work while it runs and keeps the outcome afterwards", async () => {
    const seen: number[] = [];
    const stop = supervisor.subscribe(() => seen.push(supervisor.running().length));
    await supervise({ label: "Quick", limitMs: null }, () => "ok");
    stop();
    expect(seen[0]).toBe(1);
    expect(supervisor.running()).toHaveLength(0);
    expect(supervisor.tasks()[0]).toMatchObject({ label: "Quick", state: "done" });
  });

  it("records a thrown error as failed, not as cancelled", async () => {
    await expect(
      supervise({ label: "Breaks", limitMs: null }, () => {
        throw new Error("bad pixels");
      }),
    ).rejects.toThrow("bad pixels");
    expect(supervisor.tasks()[0]).toMatchObject({ state: "failed", error: "bad pixels" });
  });

  it("marks a 'warn' kind overdue instead of shooting it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = supervise({ kind: "write", label: "Saving", limitMs: 100 }, async () => {
      await gate;
      return "saved";
    });
    tick(500);
    supervisor.pump();
    expect(supervisor.running()[0]).toMatchObject({ overdue: true, state: "running" });
    release();
    await expect(run).resolves.toBe("saved");
  });

  it("expires an awaiting body that never ticks, when the kind allows it", async () => {
    const run = supervise({ kind: "image", label: "Hung fetch", limitMs: 100 }, async (s) => {
      await new Promise<void>((_, reject) => s.onAbort(() => reject(s.error())));
      return "never";
    });
    tick(200);
    supervisor.pump();
    await expect(run).rejects.toMatchObject({ reason: "expired" });
  });

  it("leaves 'write' alone even when the master switch is on", () => {
    expect(taskKind("write")?.onExpire).toBe("warn");
    expect(resolveLimitMs(DEFAULT_RUNTIME_CONFIG, "write")).toBeNull();
  });
});

describe("loopGuard", () => {
  it("names the loop it stopped", () => {
    const guard = loopGuard("walkPath", 10);
    expect(() => {
      for (;;) guard();
    }).toThrow(RuntimeLoopError);
    try {
      const g = loopGuard("walkPath", 3);
      for (;;) g();
    } catch (e) {
      expect((e as RuntimeLoopError).loop).toBe("walkPath");
      expect((e as RuntimeLoopError).message).toContain("walkPath");
    }
  });

  it("costs nothing for a loop that terminates", () => {
    const guard = loopGuard("fine", 100);
    let n = 0;
    for (let i = 0; i < 50; i++) {
      guard();
      n++;
    }
    expect(n).toBe(50);
  });
});

describe("the watchdog", () => {
  it("reports the gap minus its own interval, and names the suspect", async () => {
    const dog = new Watchdog();
    dog.reset(t);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = supervise({ label: "Tracking ‘Logo’", limitMs: null }, () => gate);
    await Promise.resolve();

    tick(250);
    expect(dog.beat({ freezeMs: 3_000, expectedMs: 250, at: t })).toBeNull();

    tick(9_000);
    const freeze = dog.beat({ freezeMs: 3_000, expectedMs: 250, at: t });
    expect(freeze?.durationMs).toBe(8_750);
    expect(freeze?.tasks[0]?.label).toBe("Tracking ‘Logo’");
    release();
    await run;
  });

  it("does not call a suspended page a freeze", () => {
    const dog = new Watchdog();
    dog.reset(t);
    // Hidden for 40s: the host throttled the timer, nothing was blocked.
    dog.suspend();
    tick(40_000);
    expect(dog.beat({ freezeMs: 3_000, expectedMs: 250, at: t })).toBeNull();
    // The next ordinary gap is measured from the resume, not from before it.
    tick(250);
    expect(dog.beat({ freezeMs: 3_000, expectedMs: 250, at: t })).toBeNull();
    // A gap only sleep can explain is not a freeze either.
    tick(10 * 60_000);
    expect(dog.beat({ freezeMs: 3_000, expectedMs: 250, at: t })).toBeNull();
    expect(dog.freezes()).toHaveLength(0);
  });

  it("records a witnessed block exactly, with the tasks open at its start", async () => {
    const dog = new Watchdog();
    dog.reset(t);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = supervise({ label: "Decoding ‘Intro.mov’", limitMs: null }, () => gate);
    await Promise.resolve();
    expect(dog.block({ startedAt: t + 10, durationMs: 900, freezeMs: 3_000 })).toBeNull();
    const freeze = dog.block({ startedAt: t + 10, durationMs: 4_200, freezeMs: 3_000 });
    expect(freeze?.durationMs).toBe(4_200);
    expect(freeze?.tasks[0]?.label).toBe("Decoding ‘Intro.mov’");
    release();
    await run;
  });

  it("diagnoses a black box from a session that never got to clear it", () => {
    expect(diagnoseBlackBox(null).crashed).toBe(false);
    const d = diagnoseBlackBox({
      at: 1,
      version: "1.0.0",
      tasks: [{ kind: "export", label: "Export ‘Reel’", startedMs: 4000 }],
      freezes: [
        { durationMs: 500, label: "a" },
        { durationMs: 9000, label: "b" },
      ],
      errors: [],
    });
    expect(d).toEqual({ crashed: true, culprit: "Export ‘Reel’", freezeMs: 9000, errors: [] });
  });
});
