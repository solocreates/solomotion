import { describe, expect, it, vi } from "vitest";
import { isMissingChunk, lazyFamily, lazyModule, lazyModules, onLazyFailure, retryFailedLazyModules } from "./lazy";

const chunkError = () => Object.assign(new Error("Loading chunk 42 failed."), { name: "ChunkLoadError" });

describe("lazyModule", () => {
  it("fetches once, answers synchronously once it has arrived, and tells who waited", async () => {
    let calls = 0;
    const m = lazyModule("t/once", async () => ++calls);
    const heard: number[] = [];
    m.onReady((v) => heard.push(v));
    expect(m.peek()).toBeNull();
    expect(m.state).toBe("idle");
    const [a, b] = await Promise.all([m.load(), m.load()]);
    expect([a, b, calls]).toEqual([1, 1, 1]);
    expect(m.peek()).toBe(1);
    expect(heard).toEqual([1]);
    // Late listeners hear at once.
    m.onReady((v) => heard.push(v + 10));
    expect(heard).toEqual([1, 11]);
    expect(lazyModules().find((e) => e.id === "t/once")).toMatchObject({ state: "ready" });
  });

  it("want() starts the fetch on a miss — drawing code's question", async () => {
    let started = false;
    const m = lazyModule("t/want", async () => ((started = true), "engine"));
    expect(m.want()).toBeNull();
    expect(started).toBe(true);
    await m.load();
    expect(m.want()).toBe("engine");
  });

  it("retries a missing chunk with backoff inside one load", async () => {
    let n = 0;
    const m = lazyModule("t/flaky", async () => {
      if (++n < 3) throw chunkError();
      return "ok";
    }, { backoffMs: 1 });
    expect(await m.load()).toBe("ok");
    expect(n).toBe(3);
  });

  it("does not retry a module that threw — and a failure is never remembered", async () => {
    let n = 0;
    let broken = true;
    const failures: string[] = [];
    const off = onLazyFailure((f) => failures.push(`${f.id}:${f.missingChunk}`));
    const m = lazyModule("t/bug", async () => {
      n++;
      if (broken) throw new TypeError("x is not a function");
      return 7;
    }, { backoffMs: 1 });
    await expect(m.load()).rejects.toThrow(TypeError);
    expect(n).toBe(1);
    expect(m.state).toBe("failed");
    expect(failures).toEqual(["t/bug:false"]);
    broken = false;
    expect(await m.load()).toBe(7);
    off();
  });

  it("names a stale deploy: a chunk gone after every retry", async () => {
    const failures: boolean[] = [];
    const off = onLazyFailure((f) => failures.push(f.missingChunk));
    const m = lazyModule("t/gone", async () => {
      throw chunkError();
    }, { retries: 1, backoffMs: 1 });
    await expect(m.load()).rejects.toThrow();
    expect(failures).toEqual([true]);
    expect(isMissingChunk(new TypeError("Failed to fetch dynamically imported module: /x.js"))).toBe(true);
    off();
  });

  it("is known by id@version — the same pair is the same module, a new version a new one", async () => {
    const a = lazyModule("t/ver", async () => "v1", { version: "1" });
    expect(lazyModule("t/ver", async () => "other", { version: "1" })).toBe(a);
    const b = lazyModule("t/ver", async () => "v2", { version: "2" });
    expect(b).not.toBe(a);
    expect(await b.load()).toBe("v2");
  });
  it("retries only what failed when the host says the network is back — and whoever waited hears it", async () => {
    let online = false;
    const m = lazyModule("t/offline", async () => {
      if (!online) throw chunkError();
      return "light";
    }, { retries: 0 });
    const heard: string[] = [];
    m.onReady((v) => heard.push(v));
    await expect(m.load()).rejects.toThrow();
    expect(m.state).toBe("failed");
    online = true;
    expect(retryFailedLazyModules()).toBeGreaterThanOrEqual(1);
    await m.load();
    expect(heard).toEqual(["light"]);
    expect(retryFailedLazyModules()).toBe(lazyModules().filter((e) => e.state === "failed").length);
  });
  it("want() leaves a failed module alone for a while — a frame repaints faster than a network returns", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let calls = 0;
      const m = lazyModule("t/cooldown", async () => {
        calls++;
        throw chunkError();
      }, { retries: 0, wantCooldownMs: 1000 });
      await expect(m.load()).rejects.toThrow();
      m.want();
      m.want();
      expect(calls).toBe(1);
      vi.setSystemTime(Date.now() + 1000);
      m.want();
      expect(calls).toBe(2);
      await m.load().catch(() => {}); // joins the attempt want() started
      await m.load().catch(() => {});
      expect(calls).toBe(3); // an explicit load never waits
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("lazyFamily", () => {
  it("makes each member once from its table and hears every member land", async () => {
    const table: Record<string, () => Promise<string>> = { glass: async () => "glass!", analog: async () => "analog!" };
    const fam = lazyFamily<string, string>("t/fx", (k) => table[k]);
    const landed: string[] = [];
    fam.onAnyReady((k) => landed.push(k));
    expect(fam.get("nope")).toBeNull();
    expect(fam.want("glass")).toBeNull();
    expect(await fam.load("analog")).toBe("analog!");
    await fam.load("glass");
    expect(fam.peek("glass")).toBe("glass!");
    expect(landed.sort()).toEqual(["analog", "glass"]);
    expect(fam.get("glass")).toBe(fam.get("glass"));
  });
});
