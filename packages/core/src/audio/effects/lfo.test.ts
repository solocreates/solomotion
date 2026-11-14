import { describe, expect, it } from "vitest";
import { lfoPhaseAt, lfoValue, lfoWave } from "./lfo";
import { bitcrushCurve } from "./curves";
import { biquadMagnitudeDb } from "../eq";
import { audioChainSignature, audioEffectsAt } from "./resolve";
import { AFX } from "./registry";
import type { LfoShape } from "../../schema/audio-effects";

/** What an OscillatorNode plays from a periodic wave, at θ (cycles). */
function play(wave: { real: Float32Array; imag: Float32Array }, cycles: number): number {
  let v = 0;
  for (let n = 1; n < wave.real.length; n++) {
    const a = 2 * Math.PI * n * cycles;
    v += wave.real[n]! * Math.cos(a) + wave.imag[n]! * Math.sin(a);
  }
  return v;
}

describe("LFOs in phase with the clip", () => {
  const shapes: LfoShape[] = ["sine", "triangle", "square", "sawtooth"];

  it("a wave rotated to a phase plays the shape from that phase — preview mid-clip meets the export", () => {
    for (const shape of shapes) {
      const phase = 0.3;
      const wave = lfoWave(shape, phase);
      // Away from the jumps, where a finite series rings.
      for (const t of [0.05, 0.12, 0.33, 0.61, 0.83]) {
        const want = lfoValue(shape, t + phase);
        const edge = shape === "square" || shape === "sawtooth" ? Math.min(...[0, 0.5, 1].map((e) => Math.abs(((t + phase) % 1) - e))) : 1;
        if (edge < 0.04) continue;
        expect(play(wave, t)).toBeCloseTo(want, shape === "sine" ? 6 : 1);
      }
    }
  });

  it("the phase is the clip's instant times the rate", () => {
    expect(lfoPhaseAt(2, 1250)).toBeCloseTo(2.5, 9);
    expect(lfoPhaseAt(0, 9000)).toBe(0);
  });
});

describe("bitcrush", () => {
  it("is a symmetric staircase with 2^bits levels across the range", () => {
    const c = bitcrushCurve(3, 0, 2001);
    const levels = new Set(Array.from(c, (v) => Math.round(v * 1000)));
    expect(levels.size).toBeLessThanOrEqual(9);
    expect(c[0]).toBe(-1);
    expect(c[c.length - 1]).toBe(1);
    expect(c[1000]).toBe(0);
  });
});

describe("the Filter's band-pass", () => {
  it("peaks at 0 dB at its centre and falls away either side", () => {
    const at = (f: number) => biquadMagnitudeDb({ type: "bandpass", freqHz: 1000, q: 2, gainDb: 0 }, f);
    expect(at(1000)).toBeCloseTo(0, 1);
    expect(at(100)).toBeLessThan(-12);
    expect(at(10000)).toBeLessThan(-12);
  });
});

describe("modulation cards in the chain", () => {
  it("a phaser's stage count is structure; its rate is a value", () => {
    const fx = AFX.def("phaser")!.create();
    const sig = (patch: Record<string, unknown>) => audioChainSignature(audioEffectsAt([{ ...fx, ...patch } as never], [], 0));
    expect(sig({ lfoRateHz: 0.4 })).toBe(sig({ lfoRateHz: 3 }));
    expect(sig({ stages: "6" })).not.toBe(sig({ stages: "12" }));
  });

  it("carries the instant it was resolved at, so an LFO can start in phase", () => {
    const fx = AFX.def("tremolo")!.create();
    expect(audioEffectsAt([fx], [], 1234)[0]!.localMs).toBe(1234);
  });
});
