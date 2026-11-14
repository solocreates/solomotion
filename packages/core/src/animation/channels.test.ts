import { describe, expect, it } from "vitest";
import { createShapeClip } from "../factories";
import { channelValueAt, writeChannel } from "./channels";
import { setKeyframe } from "./keyframes";

function keyedScale() {
  const clip = createShapeClip({ frameId: "f", shape: "rect", startMs: 0, durationMs: 2000 });
  setKeyframe(clip.keyframes, "scale", 0, 1);
  setKeyframe(clip.keyframes, "scale", 1000, 2);
  return clip;
}

describe("linked channels", () => {
  it("editing Y at keyframe A never touches keyframe B", () => {
    const clip = keyedScale();
    writeChannel(clip, "scaleY", 0, 0.5);
    expect(channelValueAt(clip, "scaleY", 0)).toBe(0.5);
    // B still shows what it showed before: the uniform partner's value there.
    expect(channelValueAt(clip, "scaleY", 1000)).toBe(2);
    expect(clip.transform.scaleY).not.toBeNull();
  });

  it("a lone, unanimated property still writes its base", () => {
    const clip = createShapeClip({ frameId: "f", shape: "rect", startMs: 0, durationMs: 2000 });
    expect(writeChannel(clip, "scaleY", 500, 0.7)).toBe("base");
    expect(clip.keyframes).toHaveLength(0);
  });
});
