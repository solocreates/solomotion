import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import type { MotionDocument, Keyframe, KeyframeTrack, ShapeClip } from "../schema";
import { createFrameCache, type FramePayload } from "./frame-cache";
import { EDGE_PAD_MS, diffDocumentPicture, inSpans, localPictureChange } from "./picture-change";

/**
 * The window an edit reaches is the whole feature: too wide costs a re-render,
 * too narrow shows a stale picture at exactly the instant a person is looking
 * at. These pin the windows, and the edges.
 */

const key = (id: string, timeMs: number, value: number): Keyframe =>
  ({ id, timeMs, value, easing: "linear" }) as unknown as Keyframe;

const track = (keys: Keyframe[]): KeyframeTrack => ({ id: "kx", property: "x", range: null, keys });

function oneClip(over: Partial<ShapeClip> = {}): { doc: MotionDocument; clip: ShapeClip } {
  const doc = createEmptyDocument();
  const clip = { ...(createShapeClip({ frameId: doc.frames[0]!.id, shape: "rect", startMs: 0 }) as ShapeClip), ...over };
  const lane = createTrack("lane");
  lane.clips.push(clip);
  doc.tracks.push(lane);
  return { doc, clip };
}

function replaceClip(doc: MotionDocument, next: ShapeClip): MotionDocument {
  return {
    ...doc,
    tracks: doc.tracks.map((t) =>
      t.clips.some((c) => c.id === next.id) ? { ...t, clips: t.clips.map((c) => (c.id === next.id ? next : c)) } : t,
    ),
  };
}

const payload = (): FramePayload => ({ bytes: 1, release: () => {} });

describe("the local window", () => {
  const keys = [key("a", 1000, 0), key("b", 2000, 1), key("c", 3000, 2), key("d", 4000, 3), key("e", 5000, 4)];

  it("reaches two keys each side of an edited key, and no further", () => {
    const { clip } = oneClip({ keyframes: [track(keys)] });
    const edited = { ...clip, keyframes: [track(keys.map((k) => (k.id === "c" ? key("c", 3000, 9) : k)))] };
    const local = localPictureChange(clip, edited);
    expect(inSpans(local, 1000)).toBe(true);
    expect(inSpans(local, 5000)).toBe(true);
    expect(inSpans(local, 1000 - EDGE_PAD_MS - 1)).toBe(false);
    expect(inSpans(local, 5000 + EDGE_PAD_MS + 1)).toBe(false);
  });

  it("opens to infinity when the first or last key moves, because the value holds past them", () => {
    const { clip } = oneClip({ keyframes: [track(keys)] });
    const edited = { ...clip, keyframes: [track(keys.map((k) => (k.id === "a" ? key("a", 1000, 7) : k)))] };
    const local = localPictureChange(clip, edited);
    expect(inSpans(local, -1e9)).toBe(true);
    expect(inSpans(local, 3000)).toBe(true);
    expect(inSpans(local, 4000)).toBe(false);
  });

  it("is empty for a rename or a lock", () => {
    const { clip } = oneClip();
    expect(localPictureChange(clip, { ...clip, name: "x", locked: true })).toEqual([]);
  });

  it("is the whole clip for anything it does not model", () => {
    const { clip } = oneClip();
    expect(localPictureChange(clip, { ...clip, opacity: 0.3 })).toBe("all");
  });
});

describe("the comp window", () => {
  it("moving a clip from 2–4s to 3–5s reaches 2–5s, and leaves its layer pixels alone", () => {
    const { doc, clip } = oneClip({ startMs: 2000, durationMs: 2000 });
    const next = replaceClip(doc, { ...clip, startMs: 3000 });
    const d = diffDocumentPicture(doc, next).clips.get(clip.id)!;
    expect(d.change.local).toEqual([]);
    expect(inSpans(d.change.comp, 2000)).toBe(true);
    expect(inSpans(d.change.comp, 5000)).toBe(true);
    expect(inSpans(d.change.comp, 1000)).toBe(false);
    expect(inSpans(d.change.comp, 6000)).toBe(false);
  });

  it("drops only the frames inside the window from the frame cache", () => {
    const { doc, clip } = oneClip({ startMs: 2000, durationMs: 2000 });
    const comp = doc.frames[0]!.id;
    const cache = createFrameCache({ budgetBytes: 1e9 });
    const at = (t: number) => cache.put(comp, "v", t, payload(), { clipIds: new Set(t >= 2000 && t <= 4000 ? [clip.id] : []), frameIds: new Set([comp]) });
    for (const t of [1000, 2500, 4500, 6000]) at(t);
    cache.applyDocumentChange(doc, replaceClip(doc, { ...clip, startMs: 3000 }));
    // 4500 never listed the clip — it arrived there — and still has to go.
    expect([1000, 2500, 4500, 6000].map((t) => cache.has(comp, "v", t))).toEqual([true, false, false, true]);
  });

  it("a keyframe edit drops only its window, shifted to where the clip sits", () => {
    const keys = [key("a", 0, 0), key("b", 1000, 1), key("c", 2000, 2), key("d", 3000, 3), key("e", 4000, 4), key("f", 5000, 5)];
    const { doc, clip } = oneClip({ startMs: 10_000, durationMs: 6000, keyframes: [track(keys)] });
    const comp = doc.frames[0]!.id;
    const cache = createFrameCache({ budgetBytes: 1e9 });
    for (const t of [10_000, 12_500, 15_900]) cache.put(comp, "v", t, payload(), { clipIds: new Set([clip.id]), frameIds: new Set([comp]) });
    const edited = { ...clip, keyframes: [track(keys.map((k) => (k.id === "b" ? key("b", 1000, 9) : k)))] };
    cache.applyDocumentChange(doc, replaceClip(doc, edited));
    // Key b at 1s reaches to key d at 3s: 10–13s of the comp, padded.
    expect([10_000, 12_500, 15_900].map((t) => cache.has(comp, "v", t))).toEqual([false, false, true]);
  });

  it("restacking rows is a change even though no object changed", () => {
    const { doc } = oneClip();
    const other = createTrack("other");
    other.clips.push(createShapeClip({ frameId: doc.frames[0]!.id, shape: "rect", startMs: 0 }) as ShapeClip);
    const two = { ...doc, tracks: [...doc.tracks, other] };
    const swapped = { ...two, tracks: [...two.tracks].reverse() };
    expect(diffDocumentPicture(two, swapped).changedFrames.has(doc.frames[0]!.id)).toBe(true);
  });
});
