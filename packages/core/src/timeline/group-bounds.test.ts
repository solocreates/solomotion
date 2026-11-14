import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip } from "../factories";
import { clipFrameBounds, locateClip } from "./ops";
import { groupClips } from "./groups";

/** A group's box is where its members are, moved by its delta — never a box centred on the delta. */
describe("a group's bounds", () => {
  const twoShapes = () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const place = (x: number, y: number) => {
      const c = createShapeClip({ frameId, startMs: 0, shape: "rect" });
      return { ...c, width: 100, height: 100, transform: { ...c.transform, x, y } };
    };
    const a = place(300, 0);
    const b = place(500, 100);
    doc.tracks[0]!.clips.push(a);
    doc.tracks.push({ ...doc.tracks[0]!, id: "second", clips: [b] });
    const id = groupClips(doc, [a.id, b.id])!;
    const group = locateClip(doc, id)!.clip;
    if (group.kind !== "group") throw new Error("expected a group");
    return { doc, group };
  };

  it("sits on its members", () => {
    const { doc, group } = twoShapes();
    expect(clipFrameBounds(doc, group)).toEqual({ minX: 250, minY: -50, maxX: 550, maxY: 150 });
  });

  it("moves by its delta", () => {
    const { doc, group } = twoShapes();
    const moved = { ...group, transform: { ...group.transform, x: 100, y: -20 } };
    expect(clipFrameBounds(doc, moved)).toEqual({ minX: 350, minY: -70, maxX: 650, maxY: 130 });
  });
});

/** A cropped layer's bounds are its window — what paints — with the pixels left where they were. */
describe("a cropped layer's bounds", () => {
  it("are the crop window, scaled about the box's pivot", () => {
    const doc = createEmptyDocument();
    const c = createShapeClip({ frameId: doc.frames[0]!.id, startMs: 0, shape: "rect" });
    const clip = {
      ...c,
      width: 400,
      height: 600,
      crop: { top: 0, right: 0, bottom: 100, left: 100 },
      transform: { ...c.transform, scale: 0.5 },
    };
    expect(clipFrameBounds(doc, clip)).toEqual({ minX: -50, minY: -150, maxX: 100, maxY: 100 });
  });
});
