import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip } from "../factories";
import type { MotionDocument, Keyframe, ShapeClip } from "../schema";
import { createDocumentStore } from "../history/document-store";
import { resolvedDocAt } from "../evaluate/resolved-doc";
import { pictureReadsSlotTokens } from "../evaluate/picture-tokens";
import { placedSourceOf } from "../nodes/resolve-clip";
import { layerBufferSegment, layerPictureSegment } from "./picture-steady";

/**
 * The layer cache's three questions, headless: is this layer's buffer valid
 * by identity (no paint-time token), which clip do its pixels belong to (a
 * bake that only moved it), and when is the buffer — not the frame — steady.
 */

const key = (id: string, timeMs: number, value: number): Keyframe =>
  ({ id, timeMs, value, easing: "linear" }) as unknown as Keyframe;

function docWith(clip: ShapeClip, expressions: MotionDocument["expressions"] = []): MotionDocument {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const placed = { ...clip, frameId };
  return { ...doc, expressions, tracks: [{ ...doc.tracks[0]!, clips: [placed] }] } as MotionDocument;
}

describe("layer buffers", () => {
  const doc = createEmptyDocument();
  const base = createShapeClip({ frameId: doc.frames[0]!.id, shape: "rect", startMs: 0 }) as ShapeClip;

  it("a layer that only slides keeps one buffer while the frame it lands in changes", () => {
    const clip = { ...base, keyframes: [{ id: "t", property: "x", range: null, keys: [key("a", 0, 0), key("b", 4000, 600)] }] };
    expect(layerPictureSegment(doc, clip, 2000)).toBeNull();
    const a = layerBufferSegment(doc, clip, 1000);
    const b = layerBufferSegment(doc, clip, 3000);
    expect(a).not.toBeNull();
    expect(a!.key).toBe(b!.key);
  });

  it("a scale or rotation key still changes the buffer: it resamples the artwork", () => {
    for (const property of ["scale", "rotation"]) {
      const clip = { ...base, keyframes: [{ id: "t", property, range: null, keys: [key("a", 0, 1), key("b", 4000, 2)] }] };
      expect(layerBufferSegment(doc, clip, 2000), property).toBeNull();
    }
  });

  it("a bake that only MOVES a clip hands back the stored clip, sharing everything it did not write", () => {
    const raw = { ...base, drivers: { x: "fx:slide" } } as ShapeClip;
    const d = docWith(raw, [{ id: "slide", source: "#time * 100", name: "" }]);
    const stored = d.tracks[0]!.clips[0]!;
    const at1 = resolvedDocAt(d, 1000, d.frames[0]!.id).tracks[0]!.clips[0]! as ShapeClip;
    const at2 = resolvedDocAt(d, 2000, d.frames[0]!.id).tracks[0]!.clips[0]! as ShapeClip;
    expect(at1.transform.x).not.toBe(at2.transform.x);
    expect(at1).not.toBe(stored);
    expect(placedSourceOf(at1)).toBe(stored);
    expect(placedSourceOf(at2)).toBe(stored);
    // Copy-on-write: only the path it wrote is new; the store's clip is untouched.
    expect(at1.effects).toBe((stored as ShapeClip).effects);
    expect((stored as ShapeClip).transform.x).toBe(raw.transform.x);
    // And the buffer is steady across both instants.
    expect(layerBufferSegment(d, stored, 1000)?.key).toBe(layerBufferSegment(d, stored, 2000)?.key);
  });

  it("a bake that writes anything else is its own picture", () => {
    const raw = { ...base, drivers: { rotation: "fx:spin" } } as ShapeClip;
    const d = docWith(raw, [{ id: "spin", source: "#time * 0.1", name: "" }]);
    const baked = resolvedDocAt(d, 1000, d.frames[0]!.id).tracks[0]!.clips[0]!;
    expect(placedSourceOf(baked)).toBe(baked);
  });

  it("only a token in a SLOT refuses identity caching — a driver is baked into a fresh clip", () => {
    expect(pictureReadsSlotTokens(doc, base)).toBe(false);
    expect(pictureReadsSlotTokens(doc, { ...base, drivers: { x: "fx:slide" } } as ShapeClip)).toBe(false);
    const filled = { ...base, fills: [{ ...(base.fills[0] ?? {}), color: "var:brand" }] } as unknown as ShapeClip;
    expect(pictureReadsSlotTokens(doc, filled)).toBe(true);
  });
});

describe("a store without history", () => {
  it("writes like any store and keeps nothing to undo", () => {
    const doc = createEmptyDocument();
    const store = createDocumentStore(doc, { history: false });
    expect(store.update("rename", (d) => void (d.name = "Built"))).toBe(true);
    expect(store.getState().name).toBe("Built");
    expect(store.update("no-op", () => {})).toBe(false);
    expect(store.canUndo()).toBe(false);
    expect(store.undo()).toBe(false);
  });
});
