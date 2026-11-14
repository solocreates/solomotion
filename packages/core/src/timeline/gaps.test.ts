import { describe, expect, it } from "vitest";
import { closeAllGaps, closeGap, gapAt, trackGaps } from "./gaps";
import { groupClips } from "./groups";
import { createEmptyDocument, createTextClip } from "../factories";
import type { MotionDocument, Clip } from "../schema";

/** One lane holding clips at the given [start, duration] pairs. */
function lane(spans: Array<[number, number]>): { doc: MotionDocument; trackId: string; frameId: string } {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const track = doc.tracks[0]!;
  track.clips = spans.map(([startMs, durationMs], i) =>
    createTextClip({ frameId, text: `c${i}`, startMs, durationMs }),
  );
  return { doc, trackId: track.id, frameId };
}

describe("timeline gaps", () => {
  it("reads the holes between clips, and the one before the first", () => {
    const { doc, trackId, frameId } = lane([
      [1000, 1000],
      [3000, 1000],
    ]);
    expect(trackGaps(doc, trackId, frameId).map((g) => [g.startMs, g.endMs])).toEqual([
      [0, 1000],
      [2000, 3000],
    ]);
  });

  it("has no tail gap — there is nothing after it to pull back", () => {
    const { doc, trackId, frameId } = lane([[0, 1000]]);
    expect(trackGaps(doc, trackId, frameId)).toEqual([]);
  });

  it("ignores clips belonging to another comp on the same track", () => {
    const { doc, trackId, frameId } = lane([
      [0, 1000],
      [2000, 1000],
    ]);
    doc.tracks[0]!.clips[1]!.frameId = "other-comp";
    expect(trackGaps(doc, trackId, frameId)).toEqual([]);
  });

  it("finds the gap under a time, and nothing under a clip", () => {
    const { doc, trackId, frameId } = lane([
      [0, 1000],
      [2000, 1000],
    ]);
    expect(gapAt(doc, trackId, frameId, 1500)?.startMs).toBe(1000);
    expect(gapAt(doc, trackId, frameId, 500)).toBeNull();
    expect(gapAt(doc, trackId, frameId, 2000)).toBeNull(); // the gap's end is exclusive
  });

  it("closing a gap pulls everything after it back by exactly its length", () => {
    const { doc, trackId, frameId } = lane([
      [0, 1000],
      [2000, 1000],
      [4000, 1000],
    ]);
    const gap = gapAt(doc, trackId, frameId, 1500)!;
    expect(closeGap(doc, gap)).toBe(true);
    expect(doc.tracks[0]!.clips.map((c) => c.startMs)).toEqual([0, 1000, 3000]);
  });

  it("refuses rather than half-doing it when a locked clip holds the lane", () => {
    const { doc, trackId, frameId } = lane([
      [0, 1000],
      [2000, 1000],
      [4000, 1000],
    ]);
    doc.tracks[0]!.clips[2]!.locked = true;
    expect(closeGap(doc, gapAt(doc, trackId, frameId, 1500)!)).toBe(false);
    expect(doc.tracks[0]!.clips.map((c) => c.startMs)).toEqual([0, 2000, 4000]);
  });

  it("packs a whole lane in one pass, without going off by a hole", () => {
    const { doc, trackId, frameId } = lane([
      [500, 1000],
      [3000, 1000],
      [9000, 1000],
    ]);
    expect(closeAllGaps(doc, trackId, frameId)).toBe(true);
    expect(doc.tracks[0]!.clips.map((c) => c.startMs)).toEqual([0, 1000, 2000]);
    expect(closeAllGaps(doc, trackId, frameId)).toBe(false); // idempotent
  });

  /**
   * THE ONE THAT BIT. A group's bar is a handle on contents living on OTHER
   * lanes, so a ripple that writes `startMs` itself slides the bar and leaves
   * everything inside it behind — the group torn in half by an edit that never
   * mentioned it. Closing a gap has to move a clip the way the document means
   * "move", which is `moveClip`, which carries a group's contents.
   */
  it("a group carries its contents when a gap closes in front of it", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const lane0 = doc.tracks[0]!;
    const lane1 = doc.tracks[1]!;
    const a = createTextClip({ frameId, text: "a", startMs: 3000, durationMs: 1000 });
    const b = createTextClip({ frameId, text: "b", startMs: 3000, durationMs: 1000 });
    lane0.clips = [a];
    lane1.clips = [b];
    const groupId = groupClips(doc, [a.id, b.id])!;
    expect(groupId).toBeTruthy();

    const all = () => doc.tracks.flatMap((t) => t.clips);
    const bar = all().find((c): c is Clip => c.id === groupId)!;
    const barTrack = doc.tracks.find((t) => t.clips.some((c) => c.id === groupId))!;
    const before = bar.startMs;

    // A head gap on the BAR's lane: close it and the whole group slides left.
    const gap = gapAt(doc, barTrack.id, frameId, before / 2)!;
    expect(gap.startMs).toBe(0);
    expect(closeGap(doc, gap)).toBe(true);

    const after = all().find((c) => c.id === groupId)!;
    expect(after.startMs).toBe(0);
    const delta = before - after.startMs;
    expect(all().find((c) => c.id === a.id)!.startMs).toBe(3000 - delta);
    expect(all().find((c) => c.id === b.id)!.startMs).toBe(3000 - delta);
  });

  it("packing stops at a locked clip and keeps everything after it in place", () => {
    const { doc, trackId, frameId } = lane([
      [500, 1000],
      [3000, 1000],
      [9000, 1000],
    ]);
    doc.tracks[0]!.clips[1]!.locked = true;
    closeAllGaps(doc, trackId, frameId);
    expect(doc.tracks[0]!.clips.map((c) => c.startMs)).toEqual([0, 3000, 4000]);
  });
});
