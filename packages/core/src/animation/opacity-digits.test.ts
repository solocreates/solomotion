import { describe, expect, it } from "vitest";
import {
  emptyOpacityDigits,
  isOpacityDigitKey,
  OPACITY_DIGIT_WINDOW_MS,
  pushOpacityDigit,
  type OpacityDigitBuffer,
} from "./opacity-digits";

/** Type a run of digits with a fixed gap between them; returns every percent. */
function type(keys: string[], gapMs = 100): number[] {
  let buf: OpacityDigitBuffer = emptyOpacityDigits;
  let t = 1000;
  const out: number[] = [];
  for (const k of keys) {
    const r = pushOpacityDigit(buf, k, t);
    if (!r) continue;
    out.push(r.percent);
    buf = r.next;
    t += gapMs;
  }
  return out;
}

describe("opacity digit gesture", () => {
  it("reads a lone digit as tens", () => {
    expect(type(["5"])).toEqual([50]);
    expect(type(["1"])).toEqual([10]);
    expect(type(["9"])).toEqual([90]);
  });

  it("treats 0 as the back-to-opaque key", () => {
    expect(type(["0"])).toEqual([100]);
  });

  it("refines to the literal pair when a second digit lands in time", () => {
    expect(type(["5", "2"])).toEqual([50, 52]);
    expect(type(["0", "5"])).toEqual([100, 5]);
    expect(type(["1", "0"])).toEqual([10, 10]);
  });

  it("makes 00 fully transparent", () => {
    expect(type(["0", "0"])).toEqual([100, 0]);
  });

  it("starts over on a third digit", () => {
    expect(type(["2", "5", "7"])).toEqual([20, 25, 70]);
  });

  it("starts over once the window has passed", () => {
    expect(type(["5", "2"], OPACITY_DIGIT_WINDOW_MS + 1)).toEqual([50, 20]);
  });

  it("accepts a digit exactly on the window boundary", () => {
    expect(type(["5", "2"], OPACITY_DIGIT_WINDOW_MS)).toEqual([50, 52]);
  });

  it("ignores anything that is not a digit", () => {
    expect(pushOpacityDigit(emptyOpacityDigits, "a", 0)).toBeNull();
    expect(pushOpacityDigit(emptyOpacityDigits, "", 0)).toBeNull();
    expect(isOpacityDigitKey("4")).toBe(true);
    expect(isOpacityDigitKey("F4")).toBe(false);
    expect(isOpacityDigitKey("Shift")).toBe(false);
  });
});
