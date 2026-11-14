import { describe, expect, it } from "vitest";
import { classifyFailure } from "./failure";
import { supervisor } from "./supervisor";
import { lazyModule } from "../lazy";

describe("failure classification", () => {
  it("names what a person can act on", () => {
    expect(classifyFailure(new TypeError("Failed to fetch"))).toBe("network");
    expect(classifyFailure(new TypeError("Failed to fetch"), { online: false })).toBe("offline");
    expect(classifyFailure(Object.assign(new Error("Bad Gateway"), { status: 502 }))).toBe("server");
    expect(classifyFailure({ name: "ChunkLoadError", message: "Loading chunk 812 failed." })).toBe("missing");
    expect(classifyFailure({ name: "NotSupportedError", message: "codec" })).toBe("unsupported");
    expect(classifyFailure(new RangeError("index out of bounds"))).toBe("bug");
  });

  it("a lazy load is visible while it runs, quiet once done, and kept when it fails", async () => {
    supervisor.reset();
    let release!: () => void;
    const ok = lazyModule("test/ok", () => new Promise<number>((r) => (release = () => r(1))), { label: "Depth model" });
    const loading = ok.load();
    expect(supervisor.running().map((t) => t.label)).toEqual(["Loading Depth model"]);
    release();
    await loading;
    expect(supervisor.tasks()).toHaveLength(0);

    const bad = lazyModule("test/bad", () => Promise.reject(new TypeError("Failed to fetch")), { retries: 0 });
    await bad.load().catch(() => {});
    expect(supervisor.tasks()[0]).toMatchObject({ state: "failed", failure: "network" });
  });
});
