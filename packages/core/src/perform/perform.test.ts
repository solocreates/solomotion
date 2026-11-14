import { describe, expect, it } from "vitest";
import type { GroupClip, KeyframeTrack, ShapeClip } from "../schema";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { locateClip } from "../timeline/ops";
import { groupClips } from "../timeline/groups";
import { makeSwitch } from "../timeline/switch-ops";
import { sampleKeyframeTrack, setKeyframe } from "../animation/keyframes";
import { createDocumentStore } from "../history/document-store";
import { createCommandApi } from "../api";
import { addPose, createPoseSet } from "../rig/pose-ops";
import { reduceSamplesToKeys, reduceDiscreteSamples, splitRuns, unwrapDegrees, type PerformSample } from "./reduce";
import { punchIn } from "./punch";
import { resolveTriggers, triggerSetsOf, performKeyFor } from "./triggers";
import { recordTake, recordTriggerTake, TakeRefused } from "./take";

/** A seeded PRNG, so "noise" is the same noise every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/** Play keys back the way the renderer does. */
function play(keys: ReturnType<typeof reduceSamplesToKeys>, dim: number, t: number): number {
  const track: KeyframeTrack = {
    id: "t",
    property: "v",
    range: null,
    keys: keys.map((k, i) => ({ id: `k${i}`, timeMs: k.t, value: k.v[dim]!, easing: k.easing[dim]! })),
  };
  return sampleKeyframeTrack(track, t) as number;
}

const STEP = 1000 / 60;

describe("reduceSamplesToKeys", () => {
  it("a noisy circle: the played curve stays within tolerance of the hand, extremes and timing kept", () => {
    const noise = rng(7);
    const samples: PerformSample[] = [];
    // Two turns of a 200px circle over 4 s at 60 Hz, ±1.5 px of tremor.
    for (let i = 0; i <= 240; i++) {
      const t = i * STEP;
      const a = (t / 2000) * Math.PI * 2;
      samples.push({ t, v: [200 * Math.cos(a) + noise() * 1.5, 200 * Math.sin(a) + noise() * 1.5] });
    }
    const tol = 4;
    const keys = reduceSamplesToKeys(samples, tol);
    expect(keys.length).toBeLessThan(samples.length / 4);
    expect(keys.length).toBeGreaterThan(8);
    // Shared times: a motion key stays an x/y pair.
    for (const k of keys) expect(k.v).toHaveLength(2);
    // Every sample, as played back, within tolerance.
    for (const s of samples) {
      expect(Math.abs(play(keys, 0, s.t) - s.v[0]!)).toBeLessThanOrEqual(tol + 1e-9);
      expect(Math.abs(play(keys, 1, s.t) - s.v[1]!)).toBeLessThanOrEqual(tol + 1e-9);
    }
    // The extremes (x = ±200 at t = 0, 1000, 2000…) survive on the beat.
    for (const at of [1000, 2000, 3000]) {
      const want = 200 * Math.cos((at / 2000) * Math.PI * 2);
      expect(Math.abs(play(keys, 0, at) - want)).toBeLessThan(tol + 2);
    }
    // First and last are the take's own ends.
    expect(keys[0]!.t).toBe(0);
    expect(keys[keys.length - 1]!.t).toBeCloseTo(4000, 6);
  });

  it("a zigzag: every corner is a key at its own instant", () => {
    const samples: PerformSample[] = [];
    const corners = [0, 300, 450, 900, 1000, 1600];
    const vals = [0, 100, -40, 80, 80, -100];
    for (let t = 0; t <= 1600; t += 10) {
      let j = 0;
      while (j < corners.length - 2 && t > corners[j + 1]!) j++;
      const u = (t - corners[j]!) / (corners[j + 1]! - corners[j]!);
      samples.push({ t, v: [vals[j]! + (vals[j + 1]! - vals[j]!) * u] });
    }
    const keys = reduceSamplesToKeys(samples, 0.5);
    const times = keys.map((k) => k.t);
    for (const c of corners) expect(times).toContain(c);
    for (const s of samples) expect(Math.abs(play(keys, 0, s.t) - s.v[0]!)).toBeLessThanOrEqual(0.5 + 1e-9);
    // A peak is a reversal: the curve does not overshoot it.
    let max = -Infinity;
    for (let t = 0; t <= 1600; t += 1) max = Math.max(max, play(keys, 0, t));
    expect(max).toBeLessThanOrEqual(100 + 0.5);
  });

  it("a frame grid puts every key on a frame; smoothing calms a shaky hold", () => {
    const noise = rng(3);
    const samples: PerformSample[] = [];
    for (let i = 0; i < 90; i++) samples.push({ t: i * 11.3 + 2, v: [50 + noise() * 3] });
    const grid = { stepMs: 1000 / 24 };
    const keys = reduceSamplesToKeys(samples, 1, { grid, smoothMs: 60 });
    for (const k of keys) expect(Math.abs(k.t / grid.stepMs - Math.round(k.t / grid.stepMs))).toBeLessThan(1e-3);
    expect(keys.length).toBeLessThanOrEqual(4);
  });

  it("zero-length: no samples → no keys; one instant → one key", () => {
    expect(reduceSamplesToKeys([], 1)).toEqual([]);
    const one = reduceSamplesToKeys([{ t: 500, v: [3] }, { t: 500, v: [4] }], 1);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ t: 500, v: [4] });
  });

  it("splits a wrapped take into passes and unwraps a dial", () => {
    const runs = splitRuns([{ t: 900 }, { t: 950 }, { t: 990 }, { t: 0 }, { t: 40 }]);
    expect(runs.map((r) => r.map((s) => s.t))).toEqual([[900, 950, 990], [0, 40]]);
    expect(unwrapDegrees([170, 179, -178, -170, 175])).toEqual([170, 179, 182, 190, 175]);
  });

  it("discrete: keys only where the value changes", () => {
    const keys = reduceDiscreteSamples([
      { t: 0, v: "Open" },
      { t: 10, v: "Open" },
      { t: 20, v: "Closed" },
      { t: 30, v: "Closed" },
      { t: 40, v: "Open" },
    ]);
    expect(keys).toEqual([{ t: 0, v: "Open" }, { t: 20, v: "Closed" }, { t: 40, v: "Open" }]);
  });
});

describe("punchIn", () => {
  const seed = (): KeyframeTrack[] => {
    const tracks: KeyframeTrack[] = [];
    for (const [t, v] of [[0, 0], [500, 10], [1000, 20], [1500, 30], [2000, 40], [2500, 50]] as const) {
      const k = setKeyframe(tracks, "x", t, v);
      if (t === 2000) k.easing = { kind: "bezier", values: [0.1, 0.2, 0.3, 0.9] };
    }
    return tracks;
  };

  it("replaces the take's range and keeps every key outside it exactly", () => {
    const tracks = seed();
    const outside = structuredClone(tracks[0]!.keys.filter((k) => k.timeMs < 900 || k.timeMs > 1600));
    const r = punchIn(tracks, "x", 900, 1600, [{ t: 900, v: 99 }, { t: 1250, v: -5 }, { t: 1600, v: 77 }]);
    expect(r).toEqual({ removed: 2, added: 3 });
    const keys = tracks[0]!.keys;
    for (const o of outside) expect(keys).toContainEqual(o);
    expect(keys.map((k) => k.timeMs)).toEqual([0, 500, 900, 1250, 1600, 2000, 2500]);
    // Other channels: untouched by construction.
    setKeyframe(tracks, "y", 1200, 5);
    punchIn(tracks, "x", 0, 2500, []);
    expect(tracks.find((t) => t.property === "y")!.keys).toHaveLength(1);
  });

  it("a fresh channel gains a guard holding its base one frame before the take", () => {
    const tracks: KeyframeTrack[] = [];
    punchIn(tracks, "rotation", 1000, 2000, [{ t: 1000, v: 5 }, { t: 2000, v: 45 }], { guardMs: STEP, baseValue: 0 });
    const k = tracks[0]!.keys;
    expect(k.map((x) => x.timeMs)).toEqual([1000 - STEP, 1000, 2000]);
    expect(sampleKeyframeTrack(tracks[0]!, 0)).toBe(0);
  });
});

describe("triggers", () => {
  const rest = () => "Rest";

  it("latch: a key at each press, releases ignored", () => {
    const r = resolveTriggers(
      [
        { t: 100, kind: "down", value: "AI" },
        { t: 180, kind: "up", value: "AI" },
        { t: 400, kind: "down", value: "O" },
      ],
      "latch",
      rest,
    );
    expect(r.keys).toEqual([{ t: 100, v: "AI" }, { t: 400, v: "O" }]);
    expect(r.clear).toEqual([]);
  });

  it("touch: holds stack and release returns to what showed before", () => {
    const r = resolveTriggers(
      [
        { t: 100, kind: "down", value: "AI" },
        { t: 200, kind: "down", value: "O" },
        { t: 300, kind: "up", value: "O" },
        { t: 400, kind: "up", value: "AI" },
        { t: 600, kind: "down", value: "E" },
        { t: 700, kind: "up", value: "E" },
      ],
      "touch",
      rest,
    );
    expect(r.keys).toEqual([
      { t: 100, v: "AI" },
      { t: 200, v: "O" },
      { t: 300, v: "AI" },
      { t: 400, v: "Rest" },
      { t: 600, v: "E" },
      { t: 700, v: "Rest" },
    ]);
    expect(r.clear).toEqual([[100, 400], [600, 700]]);
  });

  it("touch across a loop wrap: the hold is cut at the end and resumed at the start", () => {
    const r = resolveTriggers(
      [
        { t: 900, kind: "down", value: "AI" },
        { t: 100, kind: "up", value: "AI" },
      ],
      "touch",
      rest,
      { loop: { startMs: 0, endMs: 1000 } },
    );
    expect(r.keys).toEqual([{ t: 0, v: "AI" }, { t: 100, v: "Rest" }, { t: 900, v: "AI" }, { t: 1000, v: "Rest" }]);
    expect(r.clear).toEqual([[900, 1000], [0, 100]]);
  });

  it("perform keys follow the spec rows and never use R", () => {
    expect(performKeyFor(0, 0)).toBe("1");
    expect(performKeyFor(0, 9)).toBe("0");
    expect(performKeyFor(0, 10)).toBeNull();
    expect(performKeyFor(1, 3)).toBe("t");
  });
});

/** A face: a head group holding a mouth switch (Rest/AI/O), 30 fps. */
function face() {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  doc.frames[0]!.fps = 30;
  const rect = (name: string): ShapeClip => {
    const c = createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 4000, x: 0, y: 0, width: 40, height: 20 }) as ShapeClip;
    c.name = name;
    const lane = createTrack(name);
    lane.clips.push(c);
    doc.tracks.push(lane);
    return c;
  };
  const dot = rect("Dot");
  const mouthIds = ["Rest", "AI", "O"].map((n) => rect(n).id);
  const mouth = makeSwitch(doc, mouthIds, { name: "Mouth" })!;
  const head = groupClips(doc, [mouth], "Head")!;
  return { doc, frameId, head, mouth, dot };
}

describe("recordTake on a document", () => {
  it("a position take keys x and y together, on frames, and a second pass across the wrap wins its range", () => {
    const f = face();
    const dot = locateClip(f.doc, f.dot.id)!.clip;
    const samples = [];
    // Pass 1: 2000 → 3000 ms; the loop wraps; pass 2: 0 → 500 ms.
    for (let t = 2000; t <= 3000; t += STEP) samples.push({ t, v: [t / 10, -t / 20] });
    for (let t = 0; t <= 500; t += STEP) samples.push({ t, v: [7, 7] });
    const r = recordTake(f.doc, f.dot.id, ["x", "y"], samples, { stepMs: 1000 / 30 });
    expect(r.runs).toBe(2);
    const xs = dot.keyframes.find((t) => t.property === "x")!.keys;
    const ys = dot.keyframes.find((t) => t.property === "y")!.keys;
    expect(xs.map((k) => k.timeMs)).toEqual(ys.map((k) => k.timeMs));
    for (const k of xs) expect(Math.abs(k.timeMs * 0.03 - Math.round(k.timeMs * 0.03))).toBeLessThan(1e-3);
    // Linear motion reduces to its ends; the second pass holds 7.
    expect(sampleKeyframeTrack({ ...dot.keyframes.find((t) => t.property === "x")!, keys: xs }, 2500)).toBeCloseTo(250, 0);
    expect(sampleKeyframeTrack(dot.keyframes.find((t) => t.property === "x")!, 250)).toBe(7);
  });

  it("re-performing a range replaces only that range on that channel", () => {
    const f = face();
    const dot = locateClip(f.doc, f.dot.id)!.clip;
    for (const t of [0, 1000, 2000, 3000]) setKeyframe(dot.keyframes, "rotation", t, t / 100);
    setKeyframe(dot.keyframes, "opacity", 1500, 0.5);
    const before = structuredClone(dot.keyframes);
    const samples = [];
    for (let t = 1200; t <= 2400; t += STEP) samples.push({ t, v: [90] });
    recordTake(f.doc, f.dot.id, ["rotation"], samples, { stepMs: 1000 / 30 });
    const rot = dot.keyframes.find((t) => t.property === "rotation")!.keys;
    const old = before.find((t) => t.property === "rotation")!.keys;
    expect(rot).toContainEqual(old[0]);
    expect(rot).toContainEqual(old[1]);
    expect(rot).toContainEqual(old[3]);
    expect(rot.find((k) => k.timeMs === 2000)).toBeUndefined();
    expect(dot.keyframes.find((t) => t.property === "opacity")).toEqual(before.find((t) => t.property === "opacity"));
  });

  it("a discrete take on a switch keys only its changes", () => {
    const f = face();
    const sw = locateClip(f.doc, f.mouth)!.clip;
    const samples = [0, 33, 66, 100, 133].map((t, i) => ({ t: 1000 + t, v: [i < 2 ? "AI" : "O"] }));
    const r = recordTake(f.doc, f.mouth, ["switch"], samples, { stepMs: 1000 / 30 });
    const keys = sw.keyframes.find((t) => t.property === "switch")!.keys;
    // Guard (what showed before), AI, O.
    expect(keys.map((k) => k.value)).toEqual(["", "AI", "O"].map((v, i) => (i === 0 ? keys[0]!.value : v)));
    expect(r.keys.switch).toBe(3);
  });

  it("zero-length take: one instant, one key; none, nothing", () => {
    const f = face();
    const dot = locateClip(f.doc, f.dot.id)!.clip;
    expect(recordTake(f.doc, f.dot.id, ["x"], []).keys.x).toBe(0);
    expect(dot.keyframes).toHaveLength(0);
    recordTake(f.doc, f.dot.id, ["x"], [{ t: 600, v: [12] }]);
    const xs = dot.keyframes.find((t) => t.property === "x")!.keys;
    expect(xs.map((k) => [k.timeMs, k.value])).toEqual([[600, 12]]);
  });

  it("a switch run by a pose set is armed through the set; its own path refuses a take", () => {
    const f = face();
    const set = createPoseSet(f.doc, f.head, { name: "Mouth", blend: { ms: 0, ease: { kind: "linear" } } })!;
    for (const n of ["Rest", "AI", "O"]) addPose(f.doc, f.head, set, { name: n, values: [{ clipId: f.mouth, path: "switch", value: n }] });
    const head = locateClip(f.doc, f.head)!.clip as GroupClip;
    const sw = locateClip(f.doc, f.mouth)!.clip;
    const sets = triggerSetsOf(f.doc, [head, sw]);
    expect(sets.map((s) => s.path)).toEqual([`pose.${set}`]);
    expect(sets[0]!.values).toEqual(["Rest", "AI", "O"]);
    expect(() => recordTake(f.doc, f.mouth, ["switch"], [{ t: 0, v: ["AI"] }])).toThrow(TakeRefused);
    const r = recordTriggerTake(f.doc, f.head, `pose.${set}`, [{ t: 500, kind: "down", value: "AI" }, { t: 900, kind: "up", value: "AI" }], "touch", { stepMs: 1000 / 30 });
    expect(r.keys[`pose.${set}`]).toBeGreaterThanOrEqual(2);
    const keys = head.keyframes.find((t) => t.property === `pose.${set}`)!.keys;
    // Guard (what showed before), the press, the release back to it.
    expect(keys).toHaveLength(3);
    [500 - 1000 / 30, 500, 900].forEach((t, i) => expect(keys[i]!.timeMs).toBeCloseTo(t, 6));
    expect(keys[1]!.value).toBe("AI");
    expect(keys[2]!.value).toBe(keys[0]!.value);
  });
});

describe("perform.take verb", () => {
  it("an agent acts a drag and a latch, one undo step each", async () => {
    const f = face();
    const store = createDocumentStore(f.doc);
    const api = createCommandApi();
    const ctx = { store, actor: "AI", session: { focusFrameId: () => f.frameId, playheadMs: () => 0, selection: () => [] } };
    const call = async (id: string, input: unknown) => {
      const r = await api.call(id, input, ctx);
      if (!r.ok) throw new Error(`${id}: ${r.error}`);
      return r.value as { keys: Record<string, number>; passes: number };
    };
    const samples = [];
    for (let at = 0; at <= 1000; at += 20) samples.push({ at, value: [Math.sin(at / 160) * 100, at / 5] });
    const r = await call("perform.take", { id: f.dot.id, paths: ["x", "y"], samples, tolerance: 1 });
    expect(r.passes).toBe(1);
    expect(r.keys.x).toBeGreaterThan(3);
    expect(store.canUndo()).toBe(true);
    await call("perform.take", { id: f.mouth, path: "switch", mode: "latch", events: [{ at: 300, kind: "down", value: "O" }] });
    store.undo();
    expect(locateClip(store.getState(), f.mouth)!.clip.keyframes.find((t) => t.property === "switch")).toBeUndefined();
    await expect(call("perform.take", { id: f.dot.id, path: "x" })).rejects.toThrow(/Nothing performed/);
  });
});
