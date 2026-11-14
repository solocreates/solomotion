import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EngineError,
  ExportError,
  MediaError,
  UnknownError,
  isEngineError,
  normalizeError,
} from "./errors";
import { buildBugReport, errors, reportError, tryOrReport } from "./report";
import { entityRef, resetSubjects, subjectLabel, withSubject } from "./subject";
import { supervise, supervisor } from "./supervisor";
import { setRuntimeClock } from "./clock";
import { setYieldStrategy } from "./chunk";

beforeEach(() => {
  errors.clear();
  resetSubjects();
  supervisor.reset();
});

afterEach(() => {
  setRuntimeClock(null);
  setYieldStrategy(null);
  resetSubjects();
});

describe("EngineError — a failure as a structured fact", () => {
  it("keeps the technical message and the human one apart", () => {
    const e = new ExportError({
      code: "export/encoder-failed",
      message: "VideoEncoder.configure threw NotSupportedError",
      userMessage: "This codec isn’t available in your browser.",
      context: { codec: "hevc" },
    });
    expect(e.name).toBe("ExportError");
    expect(e.userMessage).not.toBe(e.message);
    expect(e.toJSON()).toMatchObject({
      code: "export/encoder-failed",
      context: { codec: "hevc" },
      severity: "error",
      recoverable: true,
    });
  });

  it("walks the cause chain and survives a cycle", () => {
    const root = new Error("socket closed");
    const mid = new MediaError({ code: "media/decode", message: "decode failed", cause: root });
    const top = new ExportError({ code: "export/frame", message: "frame 12 failed", cause: mid });
    expect(top.chain().map((e) => e.message)).toEqual([
      "frame 12 failed",
      "decode failed",
      "socket closed",
    ]);
    // A self-referencing cause must terminate rather than hang — this module is
    // the one that runs while things are already going wrong.
    const loop = new EngineError({ code: "x/y", message: "a" });
    (loop as { cause?: unknown }).cause = loop;
    expect(loop.chain()).toHaveLength(1);
  });

  it("groups two occurrences of one bug and separates two different ones", () => {
    const a = new ExportError({ code: "export/frame", message: "boom" });
    const b = new ExportError({ code: "export/frame", message: "boom" });
    a.stack = "Error\n    at renderFrame (export.ts:1:1)";
    b.stack = "Error\n    at renderFrame (export.ts:1:1)";
    const c = new ExportError({ code: "export/mux", message: "boom" });
    c.stack = a.stack;
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });

  it("does not split one bug across the clips it happened to hit", () => {
    // Forty clips failing on one broken effect is ONE defect.
    const mk = (id: string) =>
      withSubject(entityRef("clip", id, id), () => {
        const e = new ExportError({ code: "export/frame", message: "boom" });
        e.stack = "Error\n    at renderFrame (export.ts:1:1)";
        return e;
      });
    expect(mk("c1").fingerprint).toBe(mk("c2").fingerprint);
    expect(mk("c1").subject?.id).toBe("c1");
  });
});

describe("normalizeError — one shape out, whatever went in", () => {
  it("passes ours through and merges new context onto it", () => {
    const original = new MediaError({ code: "media/decode", message: "no", context: { a: 1 } });
    const out = normalizeError(original, { frame: 12 });
    expect(out).toBe(original);
    expect(out.context).toEqual({ a: 1, frame: 12 });
  });

  it("wraps a native error but keeps its original throw site", () => {
    const native = new TypeError("x is not a function");
    native.stack = "TypeError: x is not a function\n    at deep (thing.ts:9:9)";
    const out = normalizeError(native);
    expect(out).toBeInstanceOf(UnknownError);
    expect(out.code).toBe("js/type-error");
    expect(out.cause).toBe(native);
    // The wrapper's own stack would point at normalizeError — useless.
    expect(out.stack).toContain("at deep (thing.ts:9:9)");
  });

  it("survives a thrown string, which is the case that breaks naive handlers", () => {
    const out = normalizeError("everything is fine");
    expect(isEngineError(out)).toBe(true);
    expect(out.code).toBe("unknown/non-error");
    expect(out.message).toContain("everything is fine");
  });
});

describe("the subject stack", () => {
  it("tags a failure raised by code that has never heard of subjects", () => {
    const deep = () => {
      throw new Error("null pointer");
    };
    let caught: unknown;
    withSubject(entityRef("effect", "fx_1", "Gaussian Blur"), () => {
      try {
        deep();
      } catch (e) {
        caught = normalizeError(e);
      }
    });
    expect((caught as EngineError).subject).toMatchObject({ kind: "effect", name: "Gaussian Blur" });
    expect(subjectLabel((caught as EngineError).subject!)).toBe("Effect “Gaussian Blur”");
  });

  it("records the whole path, outermost first", () => {
    withSubject(entityRef("plugin", "p1", "Captions"), () => {
      withSubject(entityRef("clip", "c1", "Title"), () => {
        const e = new EngineError({ code: "a/b", message: "x" });
        expect(e.subjects.map((s) => s.kind)).toEqual(["plugin", "clip"]);
        expect(e.toText()).toContain("Plugin “Captions” → Clip “Title”");
      });
    });
  });

  it("unwinds cleanly when the region throws — a dirty stack mis-blames everything after", () => {
    expect(() =>
      withSubject(entityRef("clip", "c1"), () => {
        throw new Error("boom");
      }),
    ).toThrow();
    expect(new EngineError({ code: "a/b", message: "x" }).subject).toBeNull();
  });

  it("re-establishes the subject inside every slice of a chunked task", async () => {
    setYieldStrategy(() => Promise.resolve());
    const seen: (string | null)[] = [];
    await supervise(
      { label: "Render", limitMs: null, sliceMs: 0, subject: entityRef("clip", "c9", "Hero") },
      function* () {
        for (let i = 0; i < 3; i++) {
          seen.push(new EngineError({ code: "a/b", message: "probe" }).subject?.id ?? null);
          yield;
        }
      },
    );
    // Including after the awaits between slices, which is the case a naive
    // ambient stack silently gets wrong.
    expect(seen).toEqual(["c9", "c9", "c9"]);
  });
});

describe("the error bus", () => {
  it("counts repeats as one report instead of flooding", () => {
    const boom = () => {
      const e = new ExportError({ code: "export/frame", message: "boom" });
      e.stack = "Error\n    at renderFrame (export.ts:1:1)";
      return e;
    };
    reportError(boom());
    reportError(boom());
    reportError(boom());
    expect(errors.reports()).toHaveLength(1);
    expect(errors.reports()[0]!.count).toBe(3);
  });

  it("tells subscribers whether a report is new, so only new ones interrupt", () => {
    const events: boolean[] = [];
    const stop = errors.subscribe((_, isNew) => events.push(isNew));
    const e = new ExportError({ code: "export/frame", message: "boom" });
    e.stack = "at one (a.ts:1:1)";
    reportError(e);
    reportError(e);
    stop();
    expect(events).toEqual([true, false]);
  });

  it("tryOrReport keeps the evidence that a bare catch would throw away", () => {
    const out = tryOrReport(() => {
      throw new Error("thumbnail failed");
    }, { clipId: "c1" });
    expect(out).toBeUndefined();
    expect(errors.reports()[0]!.error.context).toMatchObject({ clipId: "c1" });
  });

  it("reports a supervised task's real failure, but never a plain cancel", async () => {
    await expect(
      supervise({ label: "Breaks", limitMs: null }, () => {
        throw new ExportError({ code: "export/mux", message: "mux failed" });
      }),
    ).rejects.toThrow();
    expect(errors.reports().map((r) => r.error.code)).toEqual(["export/mux"]);

    errors.clear();
    const run = supervise({ label: "Stoppable", limitMs: null, sliceMs: 0 }, function* (s) {
      for (;;) {
        s.tick();
        yield;
      }
    });
    await Promise.resolve();
    supervisor.cancel(supervisor.running()[0]!.id);
    await run.catch(() => {});
    expect(errors.reports()).toHaveLength(0);
  });
});

describe("buildBugReport", () => {
  it("assembles a pasteable report with the things we always have to ask for", () => {
    const e = new ExportError({
      code: "export/encoder-failed",
      message: "configure threw",
      context: { codec: "hevc" },
      subject: entityRef("clip", "c1", "Title"),
    });
    const md = buildBugReport({
      appName: "Studio",
      appVersion: "2.16.0",
      environment: { Platform: "web", OS: "macOS", Browser: "Chrome 140" },
      errors: [{ id: "e1", fingerprint: "f", error: e, count: 3, firstAt: 1, lastAt: 2 }],
      freezes: [{ durationMs: 8750, label: "Export ‘Reel’" }],
      tasks: [{ kind: "export", label: "Export ‘Reel’", state: "failed", ms: 4200 }],
      logs: [{ ts: 0, level: "error", text: "encoder died" }],
      document: { Clips: 42, Fps: 60 },
      note: "Happens every time I export H.265.",
    });
    expect(md).toContain("## Studio bug report");
    expect(md).toContain("Happens every time I export H.265.");
    expect(md).toContain("| Version | 2.16.0 |");
    expect(md).toContain("export/encoder-failed");
    expect(md).toContain("×3");
    expect(md).toContain("Clip “Title”");
    expect(md).toContain("8.8s — while Export ‘Reel’");
    expect(md).toContain("encoder died");
  });

  it("is still a valid report when there is nothing but a version", () => {
    const md = buildBugReport({ appName: "Studio", appVersion: "2.16.0", environment: {} });
    expect(md).toContain("## Studio bug report");
    expect(md).not.toContain("### Errors");
  });
});
