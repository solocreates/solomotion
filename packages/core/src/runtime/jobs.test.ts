import { describe, expect, it } from "vitest";
import { createJobQueue, isJobFinished } from "./jobs";

/**
 * The line exports stand in. What would rot silently: two jobs running at
 * once (the 2026-11-01 failure — six exports rendering together, all timing
 * out), a wait that never returns, or a cancelled job still holding the line.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A job body that records when it ran and reports twice. */
function render(log: string[], name: string, ms = 15) {
  return async (signal: AbortSignal, progress: (t: string) => void) => {
    log.push(`start ${name}`);
    progress("Exporting · 50%");
    await sleep(ms);
    if (signal.aborted) throw new Error("aborted");
    log.push(`end ${name}`);
    return `${name}.mp4`;
  };
}

describe("job queue", () => {
  it("runs seven jobs sent together one at a time, in order, and every one finishes", async () => {
    const q = createJobQueue<string>();
    const log: string[] = [];
    const ids = Array.from({ length: 7 }, (_, i) => q.enqueue({ label: `cut ${i}`, owner: "s1" }, render(log, `cut${i}`)).id);
    // Answered at once, with a place in line.
    expect(q.get(ids[0]!)!.state).toBe("running");
    expect(q.get(ids[6]!)!.ahead).toBe(6);
    const done = await q.wait(ids, 5_000);
    expect(done.map((j) => j.state)).toEqual(Array(7).fill("done"));
    expect(done.map((j) => j.result)).toEqual(ids.map((_, i) => `cut${i}.mp4`));
    // Never two at once: every start is followed by its own end.
    for (let i = 0; i < 7; i++) expect(log.slice(i * 2, i * 2 + 2)).toEqual([`start cut${i}`, `end cut${i}`]);
  });

  it("a wait is bounded: it answers with where each job is, and the work runs on", async () => {
    const q = createJobQueue<string>();
    const log: string[] = [];
    const a = q.enqueue({ label: "long" }, render(log, "long", 120));
    const b = q.enqueue({ label: "next" }, render(log, "next"));
    const heard: string[] = [];
    const early = await q.wait([a.id, b.id], 20, { onProgress: (t) => heard.push(t) });
    expect(early.map((j) => j.state)).toEqual(["running", "queued"]);
    expect(early[1]!.ahead).toBe(1);
    expect(heard).toContain("long · Exporting · 50%");
    expect(heard).toContain("next · Queued (1 ahead)");
    const later = await q.wait([a.id, b.id], 5_000);
    expect(later.every(isJobFinished)).toBe(true);
  });

  it("cancelling a queued job takes it out of line; cancelling the running one frees the line", async () => {
    const q = createJobQueue<string>();
    const log: string[] = [];
    const a = q.enqueue({ label: "a" }, render(log, "a", 80));
    const b = q.enqueue({ label: "b" }, render(log, "b"));
    const c = q.enqueue({ label: "c" }, render(log, "c"));
    expect(q.cancel(b.id)).toBe(true);
    expect(q.get(b.id)!.state).toBe("cancelled");
    expect(q.cancel(a.id)).toBe(true);
    const [ja, jc] = await q.wait([a.id, c.id], 5_000);
    expect(ja!.state).toBe("cancelled");
    expect(jc!.state).toBe("done");
    expect(log).not.toContain("start b");
    expect(q.cancel(c.id)).toBe(false);
  });

  it("a failure keeps its message and hint; list is per owner; run awaits and throws", async () => {
    const q = createJobQueue<string>();
    const bad = q.enqueue({ label: "bad", owner: "s2" }, async () => {
      throw Object.assign(new Error("Media missing."), { hint: "Import it again." });
    });
    q.enqueue({ label: "other", owner: "s1" }, async () => "ok");
    const [j] = await q.wait([bad.id], 1_000);
    expect(j).toMatchObject({ state: "failed", error: "Media missing.", hint: "Import it again." });
    expect(q.list("s2").map((x) => x.label)).toEqual(["bad"]);
    await expect(q.run({ label: "panel" }, async () => "file.mp4")).resolves.toBe("file.mp4");
    await expect(q.run({ label: "panel" }, async () => Promise.reject(new Error("no")))).rejects.toThrow("no");
  });

  it("keeps only the newest finished jobs", async () => {
    const q = createJobQueue<number>({ keep: 3 });
    const ids = Array.from({ length: 6 }, (_, i) => q.enqueue({ label: String(i) }, async () => i).id);
    await q.wait(ids, 1_000);
    expect(q.list().map((j) => j.result)).toEqual([3, 4, 5]);
  });
});
