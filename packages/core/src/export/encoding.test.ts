import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIDEO_QUALITY,
  VIDEO_QUALITY_TIERS,
  avcCodecLadder,
  avcLevelFor,
  qualityBitrate,
  recommendedVideoBitrate,
  videoQuality,
} from "./encoding";

describe("recommendedVideoBitrate", () => {
  it("scales with pixels and rate instead of a flat constant", () => {
    const p720 = recommendedVideoBitrate(1280, 720, 30);
    const p1080 = recommendedVideoBitrate(1920, 1080, 30);
    expect(p720).toBe(11_059_200);
    expect(p1080 / p720).toBeCloseTo(2.25, 2);
    expect(recommendedVideoBitrate(1920, 1080, 60)).toBe(p1080 * 2);
  });

  it("floors tiny outputs and caps enormous ones", () => {
    expect(recommendedVideoBitrate(320, 180, 24)).toBe(8_000_000);
    expect(recommendedVideoBitrate(3840, 2160, 60)).toBe(120_000_000);
  });
});

describe("avcLevelFor", () => {
  it("picks the level the output actually needs", () => {
    expect(avcLevelFor(1280, 720, 30, 11_000_000)).toBe(0x1f); // 3.1
    expect(avcLevelFor(3840, 2160, 30, 99_000_000)).toBe(0x33); // 5.1
  });

  it("climbs for bitrate alone, not just frame size", () => {
    // 1080p30 fits level 4.0 by size, but 4.0 caps at 20 Mbps.
    expect(avcLevelFor(1920, 1080, 30, 18_000_000)).toBe(0x28); // 4.0
    expect(avcLevelFor(1920, 1080, 30, 25_000_000)).toBe(0x29); // 4.1
  });

  it("climbs for frame rate alone", () => {
    expect(avcLevelFor(1920, 1080, 60, 25_000_000)).toBe(0x2a); // 4.2
  });
});

describe("avcCodecLadder", () => {
  it("offers High, Main and Constrained Baseline at the derived level", () => {
    expect(avcCodecLadder(1280, 720, 30, 11_000_000)).toEqual([
      "avc1.64001F",
      "avc1.4D001F",
      "avc1.42E01F",
    ]);
  });

  it("never emits a 4K header for a 720p render", () => {
    expect(avcCodecLadder(1280, 720, 30, 11_000_000)).not.toContain("avc1.640033");
  });
});

describe("video quality tiers", () => {
  it("orders finer quality as a lower quantizer and a bigger file", () => {
    const [draft, high, master] = VIDEO_QUALITY_TIERS;
    expect(draft!.quantizer).toBeGreaterThan(high!.quantizer);
    expect(high!.quantizer).toBeGreaterThan(master!.quantizer);
    expect(draft!.bitrateScale).toBeLessThan(master!.bitrateScale);
  });

  it("falls back to the default tier for an unknown or missing id", () => {
    expect(videoQuality(undefined).id).toBe(DEFAULT_VIDEO_QUALITY);
  });

  it("scales the fallback bitrate off the same derived number", () => {
    const base = recommendedVideoBitrate(1280, 720, 30);
    expect(qualityBitrate("high", 1280, 720, 30)).toBe(base);
    expect(qualityBitrate("master", 1280, 720, 30)).toBe(base * 2);
  });
});
