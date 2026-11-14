import { describe, expect, it } from "vitest";
import {
  FRAME_SIZE_PRESETS,
  aspectRatioLabel,
  framePresetMatches,
} from "./factories";

describe("aspectRatioLabel", () => {
  it("reduces while the terms stay readable", () => {
    expect(aspectRatioLabel(1920, 1080)).toBe("16:9");
    expect(aspectRatioLabel(1080, 1350)).toBe("4:5");
    expect(aspectRatioLabel(1000, 1500)).toBe("2:3");
    expect(aspectRatioLabel(1080, 1080)).toBe("1:1");
  });

  it("falls to a decimal ratio when the reduction stops meaning anything", () => {
    // 1024:429 is arithmetic, not a format anyone recognises.
    expect(aspectRatioLabel(2048, 858)).toBe("2.39:1");
    expect(aspectRatioLabel(1200, 630)).toBe("1.9:1");
    expect(aspectRatioLabel(858, 2048)).toBe("1:2.39");
  });

  it("never divides by zero", () => {
    expect(aspectRatioLabel(0, 100)).toBe("—");
  });
});

describe("framePresetMatches", () => {
  const bySlug = (id: string) => FRAME_SIZE_PRESETS.find((p) => p.id === id)!;

  it("finds a preset by the platform word its name no longer carries", () => {
    expect(framePresetMatches(bySlug("reels"), "tiktok")).toBe(true);
    expect(framePresetMatches(bySlug("hd"), "youtube")).toBe(true);
  });

  it("matches dimensions and ratios as typed", () => {
    expect(framePresetMatches(bySlug("reels"), "1920")).toBe(true);
    expect(framePresetMatches(bySlug("reels"), "1080x1920")).toBe(true);
    expect(framePresetMatches(bySlug("hd"), "16:9")).toBe(true);
  });

  it("narrows on every term", () => {
    expect(framePresetMatches(bySlug("uhd-4k"), "4k vertical")).toBe(false);
    expect(framePresetMatches(bySlug("uhd-4k"), "4k 3840")).toBe(true);
  });

  it("an empty query matches everything", () => {
    expect(FRAME_SIZE_PRESETS.every((p) => framePresetMatches(p, "  "))).toBe(true);
  });
});

describe("FRAME_SIZE_PRESETS", () => {
  it("maps one size to exactly one preset", () => {
    const keys = FRAME_SIZE_PRESETS.map((p) => `${p.width}x${p.height}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
