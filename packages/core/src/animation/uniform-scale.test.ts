import { describe, expect, it } from "vitest";
import { createEmptyDocument, createTextClip } from "../factories";
import type { KeyframeTrack, TextClip } from "../schema";
import { evaluateClipPose } from "./evaluate";
import { channelValueAt } from "./channels";
import { setKeyframe } from "./keyframes";

const tracks: KeyframeTrack[] = [];
setKeyframe(tracks, "scaleY", 0, 0);
setKeyframe(tracks, "scaleY", 1000, 1);

describe("a uniform layer's scaleY keys", () => {
  const doc = createEmptyDocument();
  const base = createTextClip({ frameId: doc.frames[0]!.id, text: "Grid", startMs: 0 }) as TextClip;
  const keyed = { ...base, transform: { ...base.transform, scale: 1, scaleY: null }, keyframes: tracks } as TextClip;

  it("render: keys on a null scaleY are the Y scale, not ignored", () => {
    expect(evaluateClipPose(keyed, 500).scaleY).toBeCloseTo(0.5);
    expect(evaluateClipPose(keyed, 500).scale).toBe(1);
  });

  it("read back: the channel reports what renders", () => {
    expect(channelValueAt(keyed, "scaleY", 500)).toBeCloseTo(0.5);
  });

  it("without keys a null scaleY still follows scale", () => {
    const uniform = { ...base, transform: { ...base.transform, scale: 2, scaleY: null } } as TextClip;
    expect(evaluateClipPose(uniform, 500).scaleY).toBe(2);
  });
});
