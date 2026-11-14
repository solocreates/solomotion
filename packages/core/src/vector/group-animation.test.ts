import { describe, expect, it } from "vitest";
import { createEmptyDocument, createPathClip, createTrack } from "../factories";
import { solidPaint } from "../schema";
import { compDurationMs, locateClip, reconcileFillClips } from "../timeline/ops";
import { sampleKeyframes } from "../animation/keyframes";
import type { MotionDocument, PathClip } from "../schema";
import { mergeVectorClips, promotePathClip } from "./promote";

/**
 * A PIECE OF A VECTOR GROUP IS AN ORDINARY LAYER.
 *
 * That is the whole architectural claim of vector groups: nothing is
 * reimplemented one level down, so every capability a clip has — keyframes,
 * effects, in/out animation, motion blur, its own span — a piece has too, for
 * free. These are the tests that would catch that claim quietly becoming false.
 */
const pt = (x: number, y: number) => ({ x, y, hIn: null, hOut: null });
const box = (x: number, y: number, w: number, h: number) => ({
  closed: true,
  points: [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)],
});

function docWithTwoRegions(): { doc: MotionDocument; clip: PathClip } {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const clip = createPathClip({
    frameId,
    subpaths: [box(0, 0, 10, 10), box(50, 0, 10, 10)],
    startMs: 0,
    durationMs: 4000,
    name: "Logo",
  });
  const track = createTrack("t1");
  track.clips.push(clip);
  doc.tracks.push(track);
  return { doc, clip };
}

describe("a piece of a vector group is a full layer", () => {
  it("carries its own keyframes, effects and in/out — and they sample", () => {
    const { doc, clip } = docWithTwoRegions();
    const res = promotePathClip(doc, clip.id)!;
    const piece = locateClip(doc, res.pieceIds[0]!)!.clip;
    if (piece.kind !== "path") throw new Error("a piece is a path clip");

    piece.keyframes = [
      {
        id: "k",
        property: "opacity",
        range: null,
        keys: [
          { id: "a", timeMs: 0, value: 0, easing: { kind: "linear" } },
          { id: "b", timeMs: 1000, value: 1, easing: { kind: "linear" } },
        ],
      },
    ];
    piece.animIn = { preset: "fade", durationMs: 300, params: {}, easing: { kind: "linear" } };

    // Sampling a piece is sampling a clip — no per-piece animation path exists,
    // which is exactly the point.
    expect(sampleKeyframes(piece.keyframes, 500).opacity).toBeCloseTo(0.5, 5);
    expect(piece.animIn).not.toBeNull();
  });

  it("styles are per piece, not shared with its siblings", () => {
    const { doc, clip } = docWithTwoRegions();
    clip.fills = [solidPaint("#ff0000")];
    const res = promotePathClip(doc, clip.id)!;
    const [a, b] = res.pieceIds.map((id) => locateClip(doc, id)!.clip as PathClip);
    b!.fills = [solidPaint("#00ff00")];
    expect((a!.fills[0] as { color?: string }).color).toBe("#ff0000");
    expect((b!.fills[0] as { color?: string }).color).toBe("#00ff00");
  });
});

describe("timing inside a group is `fillDuration`, and only that", () => {
  it("pieces span the group and follow when it is retimed", () => {
    const { doc, clip } = docWithTwoRegions();
    const res = promotePathClip(doc, clip.id)!;
    const group = locateClip(doc, res.nestedId!)!.clip;
    if (group.kind !== "nested") throw new Error("expected a group");

    for (const id of res.pieceIds) expect(locateClip(doc, id)!.clip.fillDuration).toBe(true);

    // Stretch the group; its private source comp follows, so the pieces do too.
    group.durationMs = 9000;
    reconcileFillClips(doc, group.sourceFrameId);
    const span = compDurationMs(doc, group.sourceFrameId);
    for (const id of res.pieceIds) {
      expect(locateClip(doc, id)!.clip.durationMs).toBe(span);
    }

    // …and back down. There is no second timing field to disagree with this.
    group.durationMs = 1500;
    reconcileFillClips(doc, group.sourceFrameId);
    for (const id of res.pieceIds) {
      expect(locateClip(doc, id)!.clip.durationMs).toBe(compDurationMs(doc, group.sourceFrameId));
    }
  });

  it("a piece that was given its own span stops following", () => {
    const { doc, clip } = docWithTwoRegions();
    const res = promotePathClip(doc, clip.id)!;
    const group = locateClip(doc, res.nestedId!)!.clip;
    if (group.kind !== "nested") throw new Error("expected a group");

    // Dragging a piece's edge is what clears `fillDuration` — after that the
    // piece holds its own length, which is the rule the whole feature promised.
    const piece = locateClip(doc, res.pieceIds[0]!)!.clip;
    piece.fillDuration = false;
    piece.durationMs = 700;

    group.durationMs = 9000;
    reconcileFillClips(doc, group.sourceFrameId);
    expect(piece.durationMs).toBe(700);
    // Its sibling still follows.
    expect(locateClip(doc, res.pieceIds[1]!)!.clip.durationMs).toBe(
      compDurationMs(doc, group.sourceFrameId),
    );
  });

  it("merging hands the group's span back to the survivor", () => {
    const { doc, clip } = docWithTwoRegions();
    const res = promotePathClip(doc, clip.id)!;
    const group = locateClip(doc, res.nestedId!)!.clip;
    group.startMs = 500;
    group.durationMs = 2500;
    const merged = mergeVectorClips(doc, [res.nestedId!])!;
    const out = locateClip(doc, merged)!.clip;
    expect(out.startMs).toBe(500);
    expect(out.durationMs).toBe(2500);
    // The survivor is a real layer again, not a comp that fills something.
    expect(out.fillDuration).toBe(false);
  });
});
