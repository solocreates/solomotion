import { describe, expect, it } from "vitest";
import { createShapeClip, createTrack } from "../factories";
import { clipRenderLocalTime } from "../animation/evaluate";

describe("the cut belongs to the selection (preview only)", () => {
  const a = createShapeClip({ frameId: "f", shape: "rect", startMs: 0, durationMs: 1000 });
  const b = createShapeClip({ frameId: "f", shape: "rect", startMs: 1000, durationMs: 1000 });
  const track = createTrack("t");
  track.clips.push(a, b);

  it("plain rule: the incoming clip owns the cut", () => {
    expect(clipRenderLocalTime(track, a, 1000)).toBeNull();
    expect(clipRenderLocalTime(track, b, 1000)?.local).toBe(0);
  });

  it("a selected outgoing clip holds its end pose and the neighbour yields", () => {
    const ends = new Set([a.id]);
    expect(clipRenderLocalTime(track, a, 1000, ends)?.local).toBe(1000);
    expect(clipRenderLocalTime(track, b, 1000, ends)).toBeNull();
    // One frame later nothing is overridden.
    expect(clipRenderLocalTime(track, b, 1033, ends)?.local).toBe(33);
  });
});
