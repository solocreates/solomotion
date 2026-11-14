import { describe, expect, it } from "vitest";
import { createEmptyDocument, createFrame, createNestedClip, createShapeClip, createTrack } from "../factories";
import type { MotionDocument, Clip } from "../schema";
import { compPictureDeps } from "./comp-signature";

/**
 * The board keeps every comp as a picture and repaints one only when this
 * token moves. Too eager and the board redraws heavy comps for nothing (the
 * Films-page lockup); too lax and it shows stale art. These pin both edges.
 */
function board(): { doc: MotionDocument; a: string; b: string; src: string } {
  const doc = createEmptyDocument();
  const a = doc.frames[0]!.id;
  const bFrame = createFrame({ name: "B" });
  const srcFrame = createFrame({ name: "Source" });
  doc.frames.push(bFrame, srcFrame);
  const lane = createTrack("shared lane");
  lane.clips.push(createShapeClip({ frameId: a, shape: "rect", startMs: 0 }) as Clip);
  lane.clips.push(createNestedClip({ frameId: bFrame.id, sourceFrameId: srcFrame.id, startMs: 0 } as never) as Clip);
  lane.clips.push(createShapeClip({ frameId: srcFrame.id, shape: "ellipse", startMs: 0 }) as Clip);
  doc.tracks.push(lane);
  return { doc: Object.freeze(doc) as MotionDocument, a, b: bFrame.id, src: srcFrame.id };
}
const editClip = (doc: MotionDocument, frameId: string): MotionDocument => ({
  ...doc,
  tracks: doc.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.frameId === frameId ? ({ ...c, opacity: 0.5 } as Clip) : c)) })),
});

describe("comp picture signature", () => {
  it("is stable for an unchanged document and memoised per snapshot", () => {
    const { doc, a } = board();
    expect(compPictureDeps(doc, a)).toBe(compPictureDeps(doc, a));
  });

  it("an edit in one comp does not repaint a comp that merely shares its lane", () => {
    const { doc, a, b } = board();
    const next = Object.freeze(editClip(doc, a)) as MotionDocument;
    expect(compPictureDeps(next, a).signature).not.toBe(compPictureDeps(doc, a).signature);
    expect(compPictureDeps(next, b).signature).toBe(compPictureDeps(doc, b).signature);
  });

  it("follows nesting: editing a source repaints every comp that shows it", () => {
    const { doc, b, src } = board();
    const next = Object.freeze(editClip(doc, src)) as MotionDocument;
    expect(compPictureDeps(next, b).signature).not.toBe(compPictureDeps(doc, b).signature);
    expect([...compPictureDeps(doc, b).frames].sort()).toEqual([b, src].sort());
  });

  it("moving or renaming a comp on the board is not a picture change", () => {
    const { doc, a } = board();
    const moved = Object.freeze({ ...doc, frames: doc.frames.map((f) => (f.id === a ? { ...f, x: f.x + 500, name: "Moved" } : f)) }) as MotionDocument;
    expect(compPictureDeps(moved, a).signature).toBe(compPictureDeps(doc, a).signature);
    const tinted = Object.freeze({ ...doc, frames: doc.frames.map((f) => (f.id === a ? { ...f, background: "#123456" } : f)) }) as MotionDocument;
    expect(compPictureDeps(tinted, a).signature).not.toBe(compPictureDeps(doc, a).signature);
  });
});
