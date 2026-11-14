import { describe, expect, it } from "vitest";
import {
  fbm2,
  hashU32,
  makeRng,
  previousStateSeed,
  rand01,
  resolveTemporalStep,
  steppedValue,
  valueNoise2,
  type TemporalClock,
} from "./temporal";
import { applyModulators, createModulator, evaluateModulator } from "./modulators";
import type { Modulator } from "../schema/modulators";

const clock = (over: Partial<TemporalClock> = {}): TemporalClock => ({
  seed: 7,
  rate: 24,
  jitter: 0,
  stutter: 0,
  ...over,
});

describe("temporal clock", () => {
  it("is deterministic — the same instant always resolves to the same state", () => {
    // THE contract: this is what makes an export match the preview it was
    // approved from, and what makes re-exporting produce the same file.
    const a = resolveTemporalStep(clock(), 3.14159);
    const b = resolveTemporalStep(clock(), 3.14159);
    expect(a).toEqual(b);
  });

  it("holds one state for a whole gate open, then advances", () => {
    // Two instants inside the same 1/24s share a state; the next frame does not.
    const inside = resolveTemporalStep(clock(), 10 / 24 + 0.001);
    const later = resolveTemporalStep(clock(), 10 / 24 + 0.04);
    const next = resolveTemporalStep(clock(), 11 / 24 + 0.001);
    expect(later.index).toBe(inside.index);
    expect(later.seed).toBe(inside.seed);
    expect(next.index).toBe(inside.index + 1);
    expect(next.seed).not.toBe(inside.seed);
  });

  it("advances monotonically and reports phase across the step", () => {
    let prev = -Infinity;
    for (let t = 0; t < 2; t += 1 / 240) {
      const s = resolveTemporalStep(clock(), t);
      expect(s.index).toBeGreaterThanOrEqual(prev);
      expect(s.phase).toBeGreaterThanOrEqual(0);
      expect(s.phase).toBeLessThanOrEqual(1);
      prev = s.index;
    }
  });

  it("jitter makes the beats irregular but never re-orders them", () => {
    // The whole point of the three-candidate probe in resolveTemporalStep: with
    // |offset| < 0.5 the boundaries stay sorted, so time never runs backwards.
    const jittery = clock({ jitter: 0.9 });
    const durations = new Set<string>();
    let prev = -Infinity;
    for (let t = 0; t < 4; t += 1 / 480) {
      const s = resolveTemporalStep(jittery, t);
      expect(s.index).toBeGreaterThanOrEqual(prev);
      prev = s.index;
      durations.add(s.durationSec.toFixed(5));
    }
    expect(durations.size).toBeGreaterThan(5); // beats genuinely vary in length
  });

  it("jitter of 0 leaves an exact metronome", () => {
    for (let i = 0; i < 20; i++) {
      const s = resolveTemporalStep(clock(), i / 24 + 1 / 48);
      expect(s.index).toBe(i);
      expect(s.durationSec).toBeCloseTo(1 / 24, 6);
    }
  });

  it("stutter makes beats reuse an earlier state", () => {
    // With stutter at 1 every beat is a repeat, so a long run collapses onto
    // far fewer distinct states than beats.
    const stuck = clock({ stutter: 1 });
    const states = new Set<number>();
    for (let i = 0; i < 40; i++) states.add(resolveTemporalStep(stuck, i / 24).seed);
    expect(states.size).toBeLessThan(20);
    // …and it terminates: the walk-back is capped, not guarded by stutter < 1.
    expect(Number.isFinite(resolveTemporalStep(stuck, 5).index)).toBe(true);
  });

  it("steppedValue snaps when smooth is 0 and glides when it is 1", () => {
    const c = clock({ rate: 4 });
    // Hard: the value is constant for the whole beat.
    const hardA = steppedValue(c, resolveTemporalStep(c, 1.01), 3, 0);
    const hardB = steppedValue(c, resolveTemporalStep(c, 1.2), 3, 0);
    expect(hardB).toBeCloseTo(hardA, 10);
    // Smooth: it moves within the beat.
    const softA = steppedValue(c, resolveTemporalStep(c, 1.01), 3, 1);
    const softB = steppedValue(c, resolveTemporalStep(c, 1.2), 3, 1);
    expect(softB).not.toBeCloseTo(softA, 3);
    for (const v of [hardA, hardB, softA, softB]) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("previousStateSeed reaches the state one beat back", () => {
    const c = clock({ rate: 10 });
    const step = resolveTemporalStep(c, 5.05);
    const before = resolveTemporalStep(c, 5.05 - 1 / 10);
    expect(previousStateSeed(c, step)).toBe(before.seed);
  });
});

describe("hashing & noise", () => {
  it("hashes are uint32, stable and coordinate-sensitive", () => {
    expect(hashU32(1, 2, 3)).toBe(hashU32(1, 2, 3));
    expect(hashU32(1, 2, 3)).not.toBe(hashU32(1, 2, 4));
    for (const args of [[0], [1, 1], [999, -4, 7]]) {
      const h = hashU32(...args);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it("rand01 is in range and reasonably uniform", () => {
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 4000; i++) {
      const v = rand01(42, i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)]!++;
    }
    for (const b of buckets) expect(b).toBeGreaterThan(250); // no empty decile
  });

  it("makeRng is a seeded, reproducible stream", () => {
    const a = makeRng(1234);
    const b = makeRng(1234);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect(new Set(first).size).toBe(3);
  });

  it("value noise is continuous — nearby points give nearby values", () => {
    for (let i = 0; i < 50; i++) {
      const x = i * 0.37;
      const near = Math.abs(valueNoise2(x, 1.5, 9) - valueNoise2(x + 0.01, 1.5, 9));
      expect(near).toBeLessThan(0.2);
    }
  });

  it("every fBm shape stays in range", () => {
    const shapes = ["value", "fractal", "turbulence", "ridged"] as const;
    for (const shape of shapes) {
      for (let i = 0; i < 200; i++) {
        const v = fbm2(i * 0.13, i * 0.29, 3, { shape, octaves: 4, gain: 0.5, lacunarity: 2 });
        expect(v).toBeGreaterThanOrEqual(-1.001);
        expect(v).toBeLessThanOrEqual(1.001);
      }
    }
  });

  it("evolve BOILS the field rather than sliding it", () => {
    // The distinction the `evolve` parameter exists for: raising it must change
    // the field's shape, not merely translate it. If it were a translation, some
    // spatial offset would reproduce the evolved field exactly.
    const opts = { shape: "fractal" as const, octaves: 4, gain: 0.5, lacunarity: 2 };
    const still = (x: number) => fbm2(x, 0, 5, opts);
    const moved = (x: number) => fbm2(x, 0, 5, { ...opts, evolve: 1 });
    let bestMatch = Infinity;
    for (let shift = -4; shift <= 4; shift += 0.05) {
      let err = 0;
      for (let i = 0; i < 40; i++) err += Math.abs(moved(i * 0.31) - still(i * 0.31 + shift));
      bestMatch = Math.min(bestMatch, err / 40);
    }
    expect(bestMatch).toBeGreaterThan(0.05); // no shift reproduces it
  });
});

describe("modulators", () => {
  const mod = (over: Partial<Modulator> = {}): Modulator => ({
    ...createModulator("opacity", { min: 0, max: 1 }),
    amount: 0.5,
    rate: 2,
    ...over,
  });

  it("leaves untargeted values completely alone", () => {
    const m = mod({ target: "opacity" });
    expect(applyModulators([m], "x", 100, 1.5)).toBe(100);
    expect(applyModulators(undefined, "opacity", 100, 1.5)).toBe(100);
    expect(applyModulators([], "opacity", 100, 1.5)).toBe(100);
  });

  it("add rides on top of the incoming value — the AE wiggle contract", () => {
    // This is what lets a property be keyframed AND shaken; a modulator that
    // replaced the value would force you to choose.
    const m = mod({ compose: "add", clampMin: null, clampMax: null });
    const signal = evaluateModulator(m, 1.234);
    expect(applyModulators([m], "opacity", 10, 1.234)).toBeCloseTo(10 + signal, 10);
  });

  it("multiply and replace do what they say", () => {
    const base = { clampMin: null, clampMax: null };
    const mul = mod({ compose: "multiply", ...base });
    const rep = mod({ compose: "replace", ...base });
    expect(applyModulators([mul], "opacity", 4, 2)).toBeCloseTo(4 * evaluateModulator(mul, 2), 10);
    expect(applyModulators([rep], "opacity", 4, 2)).toBeCloseTo(evaluateModulator(rep, 2), 10);
  });

  it("stacks in list order, then clamps the RESULT once", () => {
    // Clamping per-modulator would let the first one's range silently truncate
    // what the second one is allowed to produce.
    const slow = mod({ id: "a", compose: "add", amount: 5, rate: 0.5, clampMin: null, clampMax: null });
    const fast = mod({ id: "b", compose: "add", amount: 5, rate: 8, clampMin: 0, clampMax: 1 });
    const out = applyModulators([slow, fast], "opacity", 0.5, 1.7);
    expect(out).toBeGreaterThanOrEqual(0);
    expect(out).toBeLessThanOrEqual(1);
  });

  it("is deterministic and stays within amount + offset", () => {
    for (const shape of ["wiggle", "random", "wave", "pulse", "ramp"] as const) {
      const m = mod({ shape, amount: 3, offset: 1 });
      for (let t = 0; t < 3; t += 0.017) {
        const v = evaluateModulator(m, t);
        expect(evaluateModulator(m, t)).toBe(v);
        expect(Math.abs(v - 1)).toBeLessThanOrEqual(3.001);
      }
    }
  });

  it("its own fields are keyframable, so a shake can ramp in", () => {
    const m = mod({ id: "m1", shape: "wave", amount: 10, compose: "add", clampMin: null, clampMax: null });
    const silent = applyModulators([m], "opacity", 0, 0.3, { "mod.m1.amount": 0 });
    expect(silent).toBe(0);
    const loud = applyModulators([m], "opacity", 0, 0.3, { "mod.m1.amount": 100 });
    expect(Math.abs(loud)).toBeGreaterThan(0);
  });

  it("a disabled modulator contributes nothing", () => {
    expect(applyModulators([mod({ enabled: false })], "opacity", 0.5, 1)).toBe(0.5);
  });

  it("createModulator scales its default amplitude to the field's range", () => {
    // ±1 is invisible on a position in px and catastrophic on an opacity.
    expect(createModulator("opacity", { min: 0, max: 1 }).amount).toBeCloseTo(0.1, 6);
    expect(createModulator("x", { min: -400, max: 400 }).amount).toBeCloseTo(80, 6);
  });
});
