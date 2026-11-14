import { describe, expect, it } from "vitest";
import { labelsToCues, planMouthSpans } from "./cues";
import { spectralEngine } from "./index";
import type { VisemeId } from "./visemes";

const SR = 44100;

/** Synthesize `seconds` of signal from a per-sample generator. */
function synth(seconds: number, gen: (t: number) => number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = gen(i / SR);
  return out;
}

/** A crude voiced "vowel": harmonics of 120Hz shaped by two formant peaks. */
function vowel(t: number, f1: number, f2: number): number {
  let s = 0;
  for (let h = 1; h <= 40; h++) {
    const hz = 120 * h;
    const w = Math.exp(-(((hz - f1) / 250) ** 2)) + 0.7 * Math.exp(-(((hz - f2) / 350) ** 2));
    s += w * Math.sin(2 * Math.PI * hz * t);
  }
  return s * 0.05;
}

describe("spectral engine", () => {
  it("hears silence as rest and speech as non-rest, with sane cue invariants", async () => {
    // 0.5s silence · 1s open vowel ("ah") · 0.5s silence
    const samples = synth(2, (t) => (t > 0.5 && t < 1.5 ? vowel(t, 750, 1300) : 0));
    const a = await spectralEngine.analyze({ samples, sampleRate: SR });

    expect(a.cues.length).toBeGreaterThan(0);
    expect(a.cues[0]!.viseme).toBe("X");
    expect(a.cues[a.cues.length - 1]!.viseme).toBe("X");
    const mid = a.cues.filter((c) => c.startMs < 1400 && c.endMs > 600);
    expect(mid.some((c) => c.viseme !== "X")).toBe(true);
    // Sorted, non-overlapping, gap-free, inside the sound.
    for (let i = 0; i < a.cues.length; i++) {
      const c = a.cues[i]!;
      expect(c.endMs).toBeGreaterThan(c.startMs);
      if (i > 0) expect(c.startMs).toBe(a.cues[i - 1]!.endMs);
      expect(c.confidence).toBeGreaterThan(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("separates an open vowel from a rounded-close one", async () => {
    const ah = await spectralEngine.analyze({ samples: synth(0.8, (t) => vowel(t, 750, 1300)), sampleRate: SR });
    const oo = await spectralEngine.analyze({ samples: synth(0.8, (t) => vowel(t, 300, 900)), sampleRate: SR });
    const main = (cues: typeof ah.cues): VisemeId => {
      const time = new Map<VisemeId, number>();
      for (const c of cues) if (c.viseme !== "X") time.set(c.viseme, (time.get(c.viseme) ?? 0) + c.endMs - c.startMs);
      return [...time.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    };
    expect(["AI", "O"]).toContain(main(ah.cues)); // open jaw
    expect(["U", "O"]).toContain(main(oo.cues)); // rounded
    expect(main(ah.cues)).not.toBe(main(oo.cues));
  });
});

describe("cue post-processing", () => {
  it("labelsToCues absorbs blips into neighbors", () => {
    const labels = ([] as VisemeId[]).concat(
      Array(20).fill("AI"),
      Array(2).fill("E"), // 20ms blip
      Array(20).fill("O"),
    );
    const cues = labelsToCues(labels, 10, 60);
    expect(cues.map((c) => c.viseme)).toEqual(["AI", "O"]);
    expect(cues[0]!.startMs).toBe(0);
    expect(cues[cues.length - 1]!.endMs).toBe(420);
  });

  it("planMouthSpans quantizes to the grid and merges same-viseme neighbors", () => {
    const spans = planMouthSpans(
      [
        { startMs: 0, endMs: 95, viseme: "AI", confidence: 1 },
        { startMs: 95, endMs: 130, viseme: "AI", confidence: 1 },
        { startMs: 130, endMs: 480, viseme: "O", confidence: 1 },
        { startMs: 480, endMs: 490, viseme: "E", confidence: 1 }, // rounds to zero width → dropped
      ],
      { quantizeMs: 1000 / 25 }, // 40ms grid
    );
    expect(spans.length).toBe(2);
    expect(spans[0]).toMatchObject({ startMs: 0, viseme: "AI" });
    expect(spans[1]!.viseme).toBe("O");
    for (const s of spans) {
      expect(s.startMs % 40).toBe(0);
      expect(s.durationMs % 40).toBe(0);
    }
    // Gap-free and ordered.
    expect(spans[1]!.startMs).toBe(spans[0]!.startMs + spans[0]!.durationMs);
  });
});
