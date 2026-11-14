import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { locateClip } from "../timeline/ops";
import { createCommandApi, type CommandContext } from "../api";
import { evaluateEasing, splitEasing } from "../easing";
import { sampleKeyframes } from "./keyframes";
import { arcTangents } from "./motion-path";
import { isBakedTrack, keyDigest, simplifyKeyframes } from "./key-hygiene";
import type { KeyframeTrack } from "../schema";

function harness() {
  const store = createDocumentStore(createEmptyDocument("Keys"));
  const api = createCommandApi();
  const ctx: CommandContext = {
    store,
    actor: "AI",
    historyKey: "t",
    historyLabel: "Keys",
    session: { focusFrameId: () => store.getState().frames[0]?.id ?? null, playheadMs: () => 0, selection: () => [] },
  };
  const call = async (id: string, input: unknown = {}) => {
    const res = await api.call(id, input, ctx);
    if (!res.ok) throw new Error(`${id}: ${res.error}${res.hint ? ` (${res.hint})` : ""}`);
    return res.value as Record<string, unknown>;
  };
  return { store, call };
}

const dot = async (call: ReturnType<typeof harness>["call"]) =>
  String((await call("layer.create", { kind: "shape", shape: "ellipse", width: 40, height: 40, fill: "#D97757", startMs: 0, durationMs: 4000 })).id);

describe("hold", () => {
  it("waits for the next key, then cuts — and stays a hold when split", () => {
    expect(evaluateEasing({ kind: "hold" }, 0.999)).toBe(0);
    expect(evaluateEasing({ kind: "hold" }, 1)).toBe(1);
    expect(splitEasing({ kind: "hold" }, 0.4)).toEqual([{ kind: "hold" }, { kind: "hold" }]);
  });

  it("is one key per switch through the API", async () => {
    const { call, store } = harness();
    const id = await dot(call);
    await call("keyframes.set", { id, property: "opacity", keys: [{ at: 0, value: 1, easing: "hold" }, { at: 500, value: 0, easing: "hold" }, { at: 900, value: 1 }] });
    const clip = locateClip(store.getState(), id)!.clip;
    expect(sampleKeyframes(clip.keyframes, 499)["opacity"]).toBe(1);
    expect(sampleKeyframes(clip.keyframes, 500)["opacity"]).toBe(0);
    expect(sampleKeyframes(clip.keyframes, 899)["opacity"]).toBe(0);
  });
});

describe("arc", () => {
  it("is real ballistics under linear easing: x at constant speed, apex exactly `arc` above the higher end", () => {
    const a = { x: -300, y: 200 };
    const b = { x: 300, y: 100 };
    const t = arcTangents(a, b, 150)!;
    const c1 = { x: a.x + t.aOut.x, y: a.y + t.aOut.y };
    const c2 = { x: b.x + t.bIn.x, y: b.y + t.bIn.y };
    const at = (u: number) => {
      const v = 1 - u;
      return {
        x: v ** 3 * a.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u ** 3 * b.x,
        y: v ** 3 * a.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u ** 3 * b.y,
      };
    };
    let top = Infinity;
    for (let i = 0; i <= 1000; i++) {
      const p = at(i / 1000);
      expect(p.x).toBeCloseTo(a.x + (b.x - a.x) * (i / 1000), 6);
      top = Math.min(top, p.y);
    }
    expect(top).toBeCloseTo(100 - 150, 2);
    // Constant downward acceleration: equal second differences everywhere.
    const d2 = (u: number, h = 0.01) => at(u + h).y - 2 * at(u).y + at(u - h).y;
    expect(d2(0.2)).toBeCloseTo(d2(0.8), 6);
    // A negative arc sags below the lower end.
    const sag = arcTangents({ x: 0, y: 0 }, { x: 100, y: 0 }, -40)!;
    expect(sag.aOut.y).toBeGreaterThan(0);
  });

  it("keys a hop as one position key per landing", async () => {
    const { call, store } = harness();
    const id = await dot(call);
    await call("keyframes.set", {
      id,
      property: "position",
      keys: [
        { at: 0, value: [-300, 200], arc: 150 },
        { at: 600, value: [300, 100] },
      ],
    });
    const clip = locateClip(store.getState(), id)!.clip;
    expect(clip.keyframes.find((t) => t.property === "x")!.keys).toHaveLength(2);
    expect(clip.keyframes.find((t) => t.property === "x")!.keys[0]!.easing).toEqual({ kind: "linear" });
    let top = Infinity;
    for (let t = 0; t <= 600; t += 5) top = Math.min(top, Number(sampleKeyframes(clip.keyframes, t)["y"]));
    expect(top).toBeCloseTo(-50, 0);
    expect(Number(sampleKeyframes(clip.keyframes, 300)["x"])).toBeCloseTo(0, 6);
  });

  it("refuses an arc and a handle on the same segment, and arcs on scalar tracks", async () => {
    const { call } = harness();
    const id = await dot(call);
    await expect(call("keyframes.set", { id, property: "position", keys: [{ at: 0, value: [0, 0], arc: 50 }, { at: 400, value: [100, 0], in: [-20, -40] }] })).rejects.toThrow(/One curve per segment/);
    await expect(call("keyframes.set", { id, property: "x", keys: [{ at: 0, value: 0, arc: 50 }] })).rejects.toThrow(/motion path/);
  });

  it("sets the easing of a key that already stood at that time (replace: false)", async () => {
    const { call, store } = harness();
    const id = await dot(call);
    await call("keyframes.set", { id, property: "scale", keys: [{ at: 0, value: 1 }, { at: 300, value: 2 }] });
    await call("keyframes.set", { id, property: "scale", replace: false, keys: [{ at: 0, value: 1, easing: "ease-out-expo" }] });
    const k = locateClip(store.getState(), id)!.clip.keyframes.find((t) => t.property === "scale")!.keys[0]!;
    expect(k.easing).toEqual({ kind: "preset", name: "ease-out-expo" });
  });
});

describe("baked tracks", () => {
  const baked = (): KeyframeTrack => ({
    id: "t",
    property: "y",
    range: null,
    keys: Array.from({ length: 31 }, (_, i) => {
      const u = i / 30;
      const e = u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2; // an in-out move, sampled every frame
      return { id: `k${i}`, timeMs: (i * 1000) / 30, value: 400 * e, easing: { kind: "linear" } };
    }),
  });

  it("are recognised by their density", () => {
    expect(isBakedTrack(baked(), 1000 / 30)).toBe(true);
    const designed = baked();
    designed.keys = [designed.keys[0]!, designed.keys[30]!];
    expect(isBakedTrack(designed, 1000 / 30)).toBe(false);
  });

  it("simplify back into a few eased keys that replay within half a pixel", () => {
    const track = baked();
    const before = track.keys.map((k) => [k.timeMs, k.value as number] as const);
    const host = { keyframes: [track], transform: { x: 0, y: 0 } as never };
    const r = simplifyKeyframes(host, { stepMs: 1000 / 30, originMs: 0, select: () => true });
    expect(r.done[0]!.after).toBeLessThanOrEqual(5);
    for (const [t, v] of before) expect(Math.abs(Number(sampleKeyframes(host.keyframes, t)["y"]) - v)).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it("simplify a baked bounce into a key per impact and apex, with no stall at the floor", () => {
    // Three hops of a ball, sampled every frame the way a script bakes them.
    const hops = [[0, 600, 220], [600, 1000, 140], [1000, 1200, 70]] as const; // impacts and apexes on frames
    const yAt = (t: number) => {
      const h = hops.find(([a, b]) => t >= a && t <= b) ?? hops[2];
      const u = (t - h[0]) / (h[1] - h[0]);
      return 300 - 4 * h[2] * u * (1 - u);
    };
    const track: KeyframeTrack = {
      id: "y",
      property: "y",
      range: null,
      keys: Array.from({ length: 37 }, (_, i) => ({ id: `k${i}`, timeMs: (i * 1000) / 30, value: yAt((i * 1000) / 30), easing: { kind: "linear" } })),
    };
    const host = { keyframes: [track], transform: { x: 0, y: 0 } as never };
    simplifyKeyframes(host, { stepMs: 1000 / 30, originMs: 0, select: () => true });
    expect(track.keys.length).toBeLessThanOrEqual(7); // 3 apexes, 2 impacts, the two ends
    for (let t = 0; t <= 1200; t += 1000 / 30) expect(Math.abs(Number(sampleKeyframes(host.keyframes, t)["y"]) - yAt(t))).toBeLessThanOrEqual(0.5 + 1e-6);
    // Leaving the floor at speed: the frame after an impact is already well up.
    expect(300 - Number(sampleKeyframes(host.keyframes, 600 + 1000 / 30)["y"])).toBeGreaterThan(40);
  });

  it("print in one line a person can paste back", async () => {
    const { call } = harness();
    const id = await dot(call);
    await call("keyframes.set", { id, property: "opacity", keys: [{ at: 0, value: 0, easing: "ease-out-expo" }, { at: 300, value: 1, easing: "hold" }, { at: 900, value: 0 }] });
    const r = (await call("keyframes.inspect", { id })) as { tracks: Array<{ keys: string }> };
    expect(r.tracks[0]!.keys).toBe("0 0 ease-out-expo · 300 1 hold · 900 0");
    const audit = (await call("keyframes.inspect", {})) as { keys: number; baked: { tracks: number } };
    expect(audit.keys).toBe(3);
    expect(audit.baked.tracks).toBe(0);
    expect(keyDigest(baked(), 1000, 2)).toMatch(/^1000 0 linear · 1033\.3 0\.06 linear · … \+29$/);
  });
});

describe("camera rig", () => {
  it("nests a World that sits on the screen centre, so a Camera group holding it zooms about the centre", async () => {
    const { call, store } = harness();
    const far = String((await call("layer.create", { kind: "shape", shape: "rect", width: 100, height: 100, x: 2400, y: -300, startMs: 0, durationMs: 4000 })).id);
    const near = await dot(call);
    const world = (await call("layers.nest", { ids: [far, near], name: "World", fullFrame: true })) as { id: string; sourceFrameId: string };
    const doc = store.getState();
    const inst = locateClip(doc, world.id)!.clip;
    const src = doc.frames.find((f) => f.id === world.sourceFrameId)!;
    const main = doc.frames[0]!;
    expect([inst.kind === "nested" && inst.transform.x, inst.kind === "nested" && inst.transform.y]).toEqual([0, 0]);
    expect([src.width, src.height]).toEqual([main.width, main.height]);
  });
});
