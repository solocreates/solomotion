import { describe, expect, it } from "vitest";
import { impulseDelay, leadIn } from "./encoder-delay";

describe("encoder delay", () => {
  it("reads the delay off a decoded impulse, ringing and all", () => {
    const d = new Float32Array(9600);
    d[480 + 2592] = 0.9;
    d[480 + 2591] = -0.4; // codec ringing round the peak
    d[480 + 2593] = 0.5;
    expect(impulseDelay(d, 480)).toBe(2592);
  });

  it("says nothing when the probe came back silent or impossible", () => {
    expect(impulseDelay(new Float32Array(4800), 480)).toBeNull();
    const early = new Float32Array(4800);
    early[100] = 1; // before the impulse went in: not a delay
    expect(impulseDelay(early, 480)).toBeNull();
  });

  it("feeds the mix early by the delay and keeps its length", () => {
    const mix = Float32Array.from({ length: 10 }, (_, i) => i + 1);
    const fed = leadIn(mix, 3);
    expect(Array.from(fed)).toEqual([4, 5, 6, 7, 8, 9, 10, 0, 0, 0]);
    // after the encoder adds its 3 samples back, sample k of the output is sample k of the mix
    const out = [0, 0, 0, ...Array.from(fed)].slice(0, 10);
    expect(out.slice(3)).toEqual(Array.from(mix).slice(3));
    expect(leadIn(mix, 0)).toBe(mix);
  });
});
