import { describe, expect, it } from "vitest";
import { guideLineWorld, guideOwner, resolveGuideDrop } from "./guides";
import { pageSchema } from "./schema";
import { buildSnapCandidates, snapPoint } from "./snapping/viewport-snap";

const frames = [
  { id: "f1", x: 0, y: 0, width: 100, height: 100 },
  { id: "f2", x: 50, y: 50, width: 100, height: 100 },
];

describe("ruler guides live on frames AND on the page (D17)", () => {
  it("a drop inside a frame belongs to the topmost frame, frame-local", () => {
    expect(resolveGuideDrop(frames, "p", "x", { x: 70, y: 70 })).toEqual({ ownerId: "f2", kind: "frame", pos: 20 });
    expect(resolveGuideDrop(frames, "p", "y", { x: 10, y: 30 })).toEqual({ ownerId: "f1", kind: "frame", pos: 30 });
  });
  it("a drop anywhere else is a page guide in canvas space", () => {
    expect(resolveGuideDrop(frames, "p", "x", { x: -400, y: 900 })).toEqual({ ownerId: "p", kind: "page", pos: -400 });
  });
  it("older pages parse with no guides; the owner lookup reaches frames too", () => {
    expect(pageSchema.parse({ id: "p", name: "Page 1" }).guides ?? []).toEqual([]);
    const doc = { frames: [{ id: "f", x: 10, y: 20, width: 5, height: 5, guides: [] }], pages: [] } as never;
    expect(guideOwner(doc, "f")).toMatchObject({ kind: "frame", ox: 10, oy: 20 });
  });
  it("a page guide snaps a layer far from every frame", () => {
    const doc = { frames: [], pages: [{ id: "p", name: "P", guides: [{ id: "g", axis: "x", pos: 5000, color: null, style: null }] }] } as never;
    const owner = guideOwner(doc, "p")!;
    expect(owner.kind).toBe("page");
    const line = guideLineWorld(owner, owner.guides[0]!);
    const cand = buildSnapCandidates([], null, { toGuides: true } as never, [line]);
    const s = snapPoint(4997, 8000, cand, 6);
    expect(s.x).toBe(5000);
  });
});
