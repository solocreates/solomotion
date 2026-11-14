import { describe, expect, it } from "vitest";
import { webAudioAutoMakeupDb } from "./compressor";

describe("webAudioAutoMakeupDb", () => {
  it("adds nothing when nothing is compressed", () => {
    expect(webAudioAutoMakeupDb(0, 0, 4)).toBeCloseTo(0, 3);
    expect(webAudioAutoMakeupDb(-30, 10, 1)).toBeCloseTo(0, 1);
  });

  it("matches the hard-knee formula: 0.6 × the reduction at full scale", () => {
    // −24 dB at 4:1 leaves full scale at −18 dB: 18 dB of reduction, 10.8 dB back.
    expect(webAudioAutoMakeupDb(-24, 0, 4)).toBeCloseTo(10.8, 1);
  });

  it("is the hidden lift under the speech leveler (measured: +4 dB makeup became ~+10 dB)", () => {
    const db = webAudioAutoMakeupDb(-26, 18, 3);
    expect(db).toBeGreaterThan(5);
    expect(db).toBeLessThan(8);
  });

  it("grows as the threshold drops", () => {
    expect(webAudioAutoMakeupDb(-30, 6, 4)).toBeGreaterThan(webAudioAutoMakeupDb(-12, 6, 4));
  });
});
