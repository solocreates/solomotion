import { describe, expect, it } from "vitest";
import { cutRanges, normalizeCutRanges, type RippleMode } from "./cut-ranges";
import { createEmptyDocument, createTextClip } from "../factories";
import type { MotionDocument } from "../schema";

/**
 * A talking head (lane 0), its captions (lane 1) and a music bed (lane 2) —
 * the edit pause removal is for.
 */
function scene(): { doc: MotionDocument; talk: string; frameId: string } {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  while (doc.tracks.length < 3) doc.tracks.push({ ...doc.tracks[0]!, id: `t${doc.tracks.length}`, clips: [] });
  const talk = createTextClip({ frameId, text: "talk", startMs: 0, durationMs: 10_000 });
  doc.tracks[0]!.clips = [talk];
  doc.tracks[1]!.clips = [
    createTextClip({ frameId, text: "cap-a", startMs: 1000, durationMs: 800 }),
    createTextClip({ frameId, text: "cap-in-pause", startMs: 2200, durationMs: 600 }),
    createTextClip({ frameId, text: "cap-b", startMs: 6000, durationMs: 1000 }),
  ];
  doc.tracks[2]!.clips = [createTextClip({ frameId, text: "music", startMs: 0, durationMs: 12_000 })];
  return { doc, talk: talk.id, frameId };
}

const spans = (doc: MotionDocument, lane: number) => doc.tracks[lane]!.clips.map((c) => [c.startMs, c.startMs + c.durationMs]).sort((a, b) => a[0]! - b[0]!);
const PAUSES = [
  { startMs: 5000, endMs: 5500 },
  { startMs: 2000, endMs: 3000 },
];

describe("cutRanges", () => {
  it("sync: removes the time from the whole comp — captions follow their words, the music bed shortens instead of jumping", () => {
    const { doc, talk } = scene();
    const res = cutRanges(doc, talk, PAUSES, "sync");
    expect(res.removedMs).toBe(1500);
    expect(res.cut).toEqual([
      { startMs: 2000, endMs: 3000 },
      { startMs: 5000, endMs: 5500 },
    ]);
    expect(spans(doc, 0)).toEqual([
      [0, 2000],
      [2000, 4000],
      [4000, 8500],
    ]);
    expect(res.pieces).toHaveLength(3);
    expect(res.pieces[0]).toBe(talk);
    expect(spans(doc, 1)).toEqual([
      [1000, 1800],
      [4500, 5500],
    ]);
    expect(spans(doc, 2)).toEqual([[0, 10_500]]);
  });

  it("lane: only the layer's own lane closes up", () => {
    const { doc, talk } = scene();
    cutRanges(doc, talk, PAUSES, "lane");
    expect(spans(doc, 0)).toEqual([
      [0, 2000],
      [2000, 4000],
      [4000, 8500],
    ]);
    expect(spans(doc, 1)).toHaveLength(3);
    expect(spans(doc, 2)).toEqual([[0, 12_000]]);
  });

  it("none: leaves the holes for B-roll", () => {
    const { doc, talk } = scene();
    cutRanges(doc, talk, PAUSES, "none");
    expect(spans(doc, 0)).toEqual([
      [0, 2000],
      [3000, 5000],
      [5500, 10_000],
    ]);
  });

  it("a range at the head deletes that piece; linked layers are razored with it", () => {
    const { doc, talk } = scene();
    const wave = doc.tracks[2]!.clips[0]!;
    wave.durationMs = 10_000;
    doc.tracks[0]!.clips[0]!.linkGroupId = "L";
    wave.linkGroupId = "L";
    cutRanges(doc, talk, [{ startMs: 0, endMs: 1000 }], "lane" satisfies RippleMode);
    expect(spans(doc, 0)).toEqual([[0, 9000]]);
    expect(spans(doc, 2)).toEqual([[0, 9000]]);
  });

  it("normalizes: clamps to the layer, merges overlaps, drops slivers", () => {
    expect(
      normalizeCutRanges(
        [
          { startMs: -50, endMs: 100 },
          { startMs: 90, endMs: 200 },
          { startMs: 500, endMs: 500.4 },
          { startMs: 900, endMs: 1200 },
        ],
        { startMs: 0, endMs: 1000 },
      ),
    ).toEqual([
      { startMs: 0, endMs: 200 },
      { startMs: 900, endMs: 1000 },
    ]);
  });
});
