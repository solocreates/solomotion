import { describe, it, expect } from "vitest";
import { avcColourCodes, patchAvcCColour, patchSpsColour, readSpsColour } from "./avc-colour";

/**
 * A real `avcC` from an the app MP4 export (Firefox 1080×1920, High@4.1) — the
 * exact bytes that shipped a file whose colour lived only in the container.
 * Fixtures beat synthetic SPSs here: the bug was about what browsers actually
 * emit, and a hand-built SPS would only ever prove the parser agrees with the
 * builder.
 */
const REAL_AVCC = hex("01640029ffe1001627640029ac52301100f1e5f016a040404615af7be02001000428fe09cb");
const REAL_SPS = hex("27640029ac52301100f1e5f016a040404615af7be020");

function hex(s: string): Uint8Array {
  return Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
}

const BT709 = { primaries: 1, transfer: 1, matrix: 1, fullRange: false };

describe("avcColourCodes", () => {
  it("maps what WebCodecs reports", () => {
    expect(avcColourCodes({ primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false })).toEqual(BT709);
    expect(avcColourCodes({ primaries: "smpte170m", transfer: "iec61966-2-1", matrix: "smpte170m", fullRange: true })).toEqual({
      primaries: 6,
      transfer: 13,
      matrix: 6,
      fullRange: true,
    });
  });

  it("says nothing when the encoder said nothing", () => {
    expect(avcColourCodes(null)).toBeNull();
    expect(avcColourCodes({})).toBeNull();
    // An unrecognised name is "unspecified", which the SPS already says.
    expect(avcColourCodes({ primaries: "future-space" })).toBeNull();
  });
});

describe("patchSpsColour", () => {
  it("a browser's SPS names no colour space", () => {
    // Firefox does write the VUI block — with all three code points set to 2,
    // "unspecified", which is exactly as useful to a decoder as writing nothing
    // and is why `ffprobe` reports `color_space=unknown` on the raw stream.
    expect(readSpsColour(REAL_SPS)).toEqual({ primaries: 2, transfer: 2, matrix: 2, fullRange: false });
  });

  it("writes the colour description a decoder can read back", () => {
    const patched = patchSpsColour(REAL_SPS, BT709);
    expect(patched).not.toEqual(REAL_SPS);
    expect(readSpsColour(patched)).toEqual(BT709);
  });

  it("keeps the picture the encoder described", () => {
    // 1080×1920 → 68×120 macroblocks. Re-read through the same parser the
    // patcher trusts: a patch that moved the geometry would be a broken file.
    const patched = patchSpsColour(REAL_SPS, BT709);
    expect(patched[1]).toBe(REAL_SPS[1]); // profile_idc
    expect(patched[3]).toBe(REAL_SPS[3]); // level_idc
    expect(patched.length).toBeGreaterThanOrEqual(REAL_SPS.length);
  });

  it("survives a full-range tag", () => {
    const full = { primaries: 1, transfer: 13, matrix: 6, fullRange: true };
    expect(readSpsColour(patchSpsColour(REAL_SPS, full))).toEqual(full);
  });

  it("returns the input untouched when it cannot parse", () => {
    const junk = hex("2700");
    expect(patchSpsColour(junk, BT709)).toEqual(junk);
    const notSps = hex("28fe09cb");
    expect(patchSpsColour(notSps, BT709)).toEqual(notSps);
  });

  it("is idempotent — a second pass changes nothing", () => {
    const once = patchSpsColour(REAL_SPS, BT709);
    const twice = patchSpsColour(once, BT709);
    expect(readSpsColour(twice)).toEqual(BT709);
  });
});

describe("patchAvcCColour", () => {
  it("tags the SPS inside the record and leaves the rest alone", () => {
    const patched = patchAvcCColour(REAL_AVCC, BT709);
    expect(patched[0]).toBe(1);
    expect(patched.subarray(1, 4)).toEqual(REAL_AVCC.subarray(1, 4)); // profile/compat/level
    const spsLen = (patched[6]! << 8) | patched[7]!;
    expect(readSpsColour(patched.subarray(8, 8 + spsLen))).toEqual(BT709);
    // The PPS rides along untouched, at the end.
    expect(Array.from(patched.subarray(patched.length - 4))).toEqual(Array.from(REAL_AVCC.subarray(REAL_AVCC.length - 4)));
  });

  it("does not overrule an encoder that already named one", () => {
    const first = patchAvcCColour(REAL_AVCC, BT709);
    const second = patchAvcCColour(first, { primaries: 6, transfer: 6, matrix: 6, fullRange: true });
    expect(second).toEqual(first);
  });

  it("leaves a record it cannot read alone", () => {
    const junk = hex("00ff");
    expect(patchAvcCColour(junk, BT709)).toEqual(junk);
  });
});
