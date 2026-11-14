import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import type { MotionDocument, ShapeClip } from "../schema";
import { createFrameCache, type FramePayload } from "./frame-cache";
import { diffDocumentPicture } from "./picture-change";
import { quantizeMsToFrame } from "../timeline/fps";

/**
 * The cache's KEY is cheap to change; its INVALIDATION is not. A miss costs a
 * render nobody notices — a false hit shows a frame that is quietly wrong, and
 * the person reporting it will not describe it as a cache bug. So this is
 * almost entirely about what has to die.
 */

function docWithClips(n: number): { doc: MotionDocument; clips: ShapeClip[] } {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const clips: ShapeClip[] = [];
  for (let i = 0; i < n; i++) {
    const clip = createShapeClip({ frameId, shape: "rect", startMs: i * 1000 }) as ShapeClip;
    const lane = createTrack(`lane${i}`);
    lane.clips.push(clip);
    doc.tracks.push(lane);
    clips.push(clip);
  }
  return { doc, clips };
}

/** Immer's contract, by hand: touching one clip replaces that clip and its row. */
function editClip(doc: MotionDocument, clipId: string, mutate: (c: ShapeClip) => void): MotionDocument {
  return {
    ...doc,
    tracks: doc.tracks.map((t) =>
      t.clips.some((c) => c.id === clipId)
        ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? (() => { const n = { ...c } as ShapeClip; mutate(n); return n; })() : c)) }
        : t,
    ),
  };
}

const payload = (bytes = 100): FramePayload & { released: boolean } => {
  const p = { bytes, released: false, release: () => { p.released = true; } };
  return p;
};

/** One variant for the ordinary cases; the variant tests name their own. */
const V = "v1";

const refs = (clipIds: string[], frameIds: string[]) => ({
  clipIds: new Set(clipIds),
  frameIds: new Set(frameIds),
});

describe("what an edit invalidates", () => {
  it("keeps the frames a changed clip never painted into", () => {
    const { doc, clips } = docWithClips(2);
    const cache = createFrameCache({ budgetBytes: 1e9 });
    const comp = doc.frames[0]!.id;
    // Frame 0 has only clip A on it; frame 1000 has only clip B.
    cache.put(comp, V, 0, payload(), refs([clips[0]!.id], [comp]));
    cache.put(comp, V, 1000, payload(), refs([clips[1]!.id], [comp]));

    cache.applyDocumentChange(doc, editClip(doc, clips[1]!.id, (c) => { c.startMs = 1500; }));

    // This is the whole feature: editing at 1000 does not throw away 0.
    expect(cache.has(comp, V, 0)).toBe(true);
    expect(cache.has(comp, V, 1000)).toBe(false);
  });

  it("invalidates a frame through a container it never named directly", () => {
    const { doc, clips } = docWithClips(2);
    const cache = createFrameCache({ budgetBytes: 1e9 });
    const comp = doc.frames[0]!.id;
    // The painter walked INTO the group, so the member is a contributor even
    // though the cached frame's top-level layer was the group.
    cache.put(comp, V, 0, payload(), refs(["group_1", clips[0]!.id], [comp]));

    cache.applyDocumentChange(doc, editClip(doc, clips[0]!.id, (c) => { c.startMs = 500; }));
    expect(cache.has(comp, V, 0)).toBe(false);
  });

  it("releases the pixels of everything it drops", () => {
    const { doc, clips } = docWithClips(1);
    const cache = createFrameCache({ budgetBytes: 1e9 });
    const comp = doc.frames[0]!.id;
    const p = payload();
    cache.put(comp, V, 0, p, refs([clips[0]!.id], [comp]));
    cache.applyDocumentChange(doc, editClip(doc, clips[0]!.id, (c) => { c.startMs = 500; }));
    expect(p.released).toBe(true);
    expect(cache.stats().bytes).toBe(0);
  });

  it("treats a clip that did not exist before as structural, because identity cannot see it", () => {
    const { doc } = docWithClips(1);
    const comp = doc.frames[0]!.id;
    const cache = createFrameCache({ budgetBytes: 1e9 });
    cache.put(comp, V, 0, payload(), refs(["other"], [comp]));

    const added = createShapeClip({ frameId: comp, shape: "rect", startMs: 0 }) as ShapeClip;
    const lane = createTrack("new");
    lane.clips.push(added);
    cache.applyDocumentChange(doc, { ...doc, tracks: [...doc.tracks, lane] });

    // The cached frame could not possibly list a clip that did not exist, so
    // contributor identity has nothing to say and the comp has to go.
    expect(cache.has(comp, V, 0)).toBe(false);
  });

  it("does not throw away pixels when a row is locked, renamed or resized", () => {
    const { doc } = docWithClips(1);
    const comp = doc.frames[0]!.id;
    const cache = createFrameCache({ budgetBytes: 1e9 });
    cache.put(comp, V, 0, payload(), refs([], [comp]));

    const next = { ...doc, tracks: doc.tracks.map((t) => ({ ...t, locked: true, name: "x", heightPx: 90 })) };
    cache.applyDocumentChange(doc, next);
    expect(cache.has(comp, V, 0)).toBe(true);
  });

  it("does throw them away when the row hides, loops or gains a transition", () => {
    const { doc } = docWithClips(1);
    const comp = doc.frames[0]!.id;
    for (const patch of [{ hidden: true }, { loop: "loop" as const }, { transitions: [] }]) {
      const cache = createFrameCache({ budgetBytes: 1e9 });
      cache.put(comp, V, 0, payload(), refs([], [comp]));
      cache.applyDocumentChange(doc, { ...doc, tracks: doc.tracks.map((t) => ({ ...t, ...patch })) });
      expect(cache.has(comp, V, 0)).toBe(false);
    }
  });

  it("falls back to clearing everything for a document field it does not model", () => {
    const { doc } = docWithClips(1);
    const comp = doc.frames[0]!.id;
    const cache = createFrameCache({ budgetBytes: 1e9 });
    cache.put(comp, V, 0, payload(), refs([], [comp]));
    cache.applyDocumentChange(doc, { ...doc, stageBackground: "#123456" });
    expect(cache.has(comp, V, 0)).toBe(false);
  });

  it("says nothing at all when the document did not move", () => {
    const { doc } = docWithClips(3);
    const delta = diffDocumentPicture(doc, doc);
    expect(delta.total).toBe(false);
    expect(delta.clips.size).toBe(0);
    expect(delta.changedFrames.size).toBe(0);
  });
});

describe("the budget", () => {
  it("evicts least recently used from OTHER ranges first and accounts the bytes back", () => {
    const cache = createFrameCache({ budgetBytes: 250 });
    cache.put("old", V, 0, payload(100), refs([], ["old"]));
    cache.put("old", V, 100, payload(100), refs([], ["old"]));
    cache.get("old", V, 0); // frame 0 is now the freshest of the old range
    cache.put("comp", V, 0, payload(100), refs([], ["comp"]));

    expect(cache.has("old", V, 100)).toBe(false);
    expect(cache.has("old", V, 0)).toBe(true);
    expect(cache.has("comp", V, 0)).toBe(true);
    expect(cache.stats().bytes).toBe(200);
  });

  it("HOLD fills to the ceiling and keeps what it has", () => {
    const cache = createFrameCache({ budgetBytes: 250, admission: "hold" });
    cache.put("comp", V, 0, payload(100), refs([], ["comp"]));
    cache.put("comp", V, 100, payload(100), refs([], ["comp"]));
    const refused = payload(100);
    cache.put("comp", V, 200, refused, refs([], ["comp"]));
    expect([0, 100, 200].map((t) => cache.has("comp", V, t))).toEqual([true, true, false]);
    expect(refused.released).toBe(true);
  });

  it("ROLL travels with the playhead: what is furthest behind goes first", () => {
    const cache = createFrameCache({ budgetBytes: 250 });
    cache.put("comp", V, 0, payload(100), refs([], ["comp"]));
    cache.put("comp", V, 100, payload(100), refs([], ["comp"]));
    cache.setFocus("comp", V, 200);
    cache.put("comp", V, 200, payload(100), refs([], ["comp"]));
    expect([0, 100, 200].map((t) => cache.has("comp", V, t))).toEqual([false, true, true]);
    expect(cache.stats().bytes).toBe(200);
  });

  it("ROLL gives up what is furthest ahead once nothing is behind", () => {
    const cache = createFrameCache({ budgetBytes: 250 });
    cache.setFocus("comp", V, 0);
    cache.put("comp", V, 900, payload(100), refs([], ["comp"]));
    cache.put("comp", V, 100, payload(100), refs([], ["comp"]));
    cache.put("comp", V, 0, payload(100), refs([], ["comp"]));
    expect([0, 100, 900].map((t) => cache.has("comp", V, t))).toEqual([true, true, false]);
  });

  it("rolls a comp's own frames before the precomp pictures they are made of", () => {
    const cache = createFrameCache({ budgetBytes: 400 });
    // A tile's picture, then the wall frames that walked it.
    cache.put("tile", V, 0, payload(50), refs([], ["tile"]));
    cache.put("wall", V, 0, payload(200), refs([], ["wall", "tile"]));
    cache.setFocus("wall", V, 100);
    cache.put("wall", V, 100, payload(200), refs([], ["wall", "tile"]));
    // The wall's oldest frame rolls; the tile it is made of stays.
    expect(cache.has("tile", V, 0)).toBe(true);
    expect([0, 100].map((t) => cache.has("wall", V, t))).toEqual([false, true]);
  });

  it("making a precomp picture evicts the composites built on it before its siblings", () => {
    const cache = createFrameCache({ budgetBytes: 400 });
    cache.put("a", V, 0, payload(50), refs([], ["a"]));
    cache.put("b", V, 0, payload(50), refs([], ["b"]));
    cache.put("wall", V, 0, payload(250), refs([], ["wall", "a", "b"]));
    cache.put("a", V, 100, payload(100), refs([], ["a"]));
    expect(cache.has("wall", V, 0)).toBe(false);
    expect([cache.has("a", V, 0), cache.has("b", V, 0), cache.has("a", V, 100)]).toEqual([true, true, true]);
  });

  it("gives up precomp pictures last, once nothing else is left to give", () => {
    const cache = createFrameCache({ budgetBytes: 1000 });
    cache.put("tile", V, 0, payload(100), refs([], ["tile"]));
    cache.put("wall", V, 0, payload(100), refs([], ["wall", "tile"]));
    cache.put("other", V, 0, payload(100), refs([], ["other"]));
    cache.setBudget(150);
    expect([cache.has("other", V, 0), cache.has("wall", V, 0), cache.has("tile", V, 0)]).toEqual([false, false, true]);
  });

  it("still shrinks to a smaller ceiling, sparing nobody", () => {
    const cache = createFrameCache({ budgetBytes: 1000 });
    cache.put("comp", V, 0, payload(100), refs([], ["comp"]));
    cache.put("comp", V, 100, payload(100), refs([], ["comp"]));
    cache.setBudget(150);
    expect(cache.stats().bytes).toBe(100);
  });

  it("refuses a frame bigger than the whole budget rather than thrashing", () => {
    const cache = createFrameCache({ budgetBytes: 100 });
    const p = payload(1000);
    cache.put("comp", V, 0, p, refs([], ["comp"]));
    expect(cache.has("comp", V, 0)).toBe(false);
    expect(p.released).toBe(true);
  });

  it("never stores a non-finite instant, which would match forever after", () => {
    const cache = createFrameCache({ budgetBytes: 1e9 });
    cache.put("comp", V, NaN, payload(), refs([], ["comp"]));
    expect(cache.stats().entries).toBe(0);
  });
});

describe("empty instants", () => {
  it("are resolved without holding a byte", () => {
    const cache = createFrameCache({ budgetBytes: 1e9 });
    cache.markEmpty("c", V, 0);
    expect(cache.isEmpty("c", V, 0)).toBe(true);
    expect(cache.has("c", V, 0)).toBe(false);
    expect(cache.stats().bytes).toBe(0);
  });

  it("stop being empty when a clip in their comp is edited — even one that was never there", () => {
    // Moving a clip INTO a gap is a changed clip, not a structural change, and
    // it cannot be in the contributor list of an instant where nothing painted.
    const { doc, clips } = docWithClips(1);
    const comp = doc.frames[0]!.id;
    const cache = createFrameCache({ budgetBytes: 1e9 });
    cache.markEmpty(comp, V, 5000);
    cache.applyDocumentChange(doc, editClip(doc, clips[0]!.id, (c) => { c.startMs = 5000; }));
    expect(cache.isEmpty(comp, V, 5000)).toBe(false);
  });

  it("survive edits to other comps", () => {
    const { doc, clips } = docWithClips(1);
    const cache = createFrameCache({ budgetBytes: 1e9 });
    cache.markEmpty("elsewhere", V, 0);
    cache.applyDocumentChange(doc, editClip(doc, clips[0]!.id, (c) => { c.startMs = 10; }));
    expect(cache.isEmpty("elsewhere", V, 0)).toBe(true);
  });
});

describe("what arrives from outside the document", () => {
  it("drops only the frames a relinked source painted into", () => {
    const cache = createFrameCache({ budgetBytes: 1e9 });
    cache.put("c", V, 0, payload(), refs(["video"], ["c"]));
    cache.put("c", V, 100, payload(), refs(["text"], ["c"]));
    cache.invalidateSubject("video");
    expect(cache.has("c", V, 0)).toBe(false);
    expect(cache.has("c", V, 100)).toBe(true);
  });

  it("keeps a variant you leave, so coming back to it finds the frames", () => {
    const cache = createFrameCache({ budgetBytes: 1e9 });
    cache.put("c", "zoom-1", 0, payload(), refs([], ["c"]));
    // Working at another zoom must not destroy the frames built at this one —
    // a cache that erases itself when a setting moves is the single thing that
    // makes one feel untrustworthy.
    cache.put("c", "zoom-2", 0, payload(), refs([], ["c"]));
    expect(cache.has("c", "zoom-1", 0)).toBe(true);
    expect(cache.has("c", "zoom-2", 0)).toBe(true);
  });

  it("reports coverage per variant, so a bar cannot promise another view's pixels", () => {
    const cache = createFrameCache({ budgetBytes: 1e9 });
    cache.put("c", "a", 0, payload(), refs([], ["c"]));
    cache.put("c", "a", 100, payload(), refs([], ["c"]));
    cache.put("c", "b", 0, payload(), refs([], ["c"]));
    expect(cache.coveredTimes("c", "a")).toEqual([0, 100]);
    expect(cache.coveredTimes("c", "b")).toEqual([0]);
  });

  it("invalidates an edited clip across every variant it painted into", () => {
    const { doc, clips } = docWithClips(1);
    const comp = doc.frames[0]!.id;
    const cache = createFrameCache({ budgetBytes: 1e9 });
    cache.put(comp, "a", 0, payload(), refs([clips[0]!.id], [comp]));
    cache.put(comp, "b", 0, payload(), refs([clips[0]!.id], [comp]));
    cache.applyDocumentChange(doc, editClip(doc, clips[0]!.id, (c) => { c.startMs = 500; }));
    // Staleness is not a property of how you were looking at it.
    expect(cache.has(comp, "a", 0)).toBe(false);
    expect(cache.has(comp, "b", 0)).toBe(false);
  });
});

describe("shared pictures", () => {
  it("count the bytes once however many instants hold them", () => {
    const cache = createFrameCache({ budgetBytes: 1e9 });
    const owner = { ...payload(100), shareKey: "still" };
    cache.put("c", V, 0, owner, refs(["a"], ["c"]));
    cache.put("c", V, 100, { ...payload(100), shareKey: "still" }, refs(["a"], ["c"]));
    cache.put("c", V, 200, { ...payload(100), shareKey: "still" }, refs(["a"], ["c"]));
    expect(cache.stats().bytes).toBe(100);
    expect(cache.stats().entries).toBe(3);
    expect(cache.shared("still")).toBe(owner);
  });

  it("release the pixels only when the last instant lets go", () => {
    const { doc, clips } = docWithClips(1);
    const comp = doc.frames[0]!.id;
    const cache = createFrameCache({ budgetBytes: 1e9 });
    const owner = payload(100);
    const shared = Object.assign(owner, { shareKey: "still" });
    cache.put(comp, V, 0, shared, refs([clips[0]!.id], [comp]));
    cache.put(comp, V, 600_000, { ...payload(100), shareKey: "still" }, refs(["other"], [comp]));
    // Editing the clip drops the instant it painted — the other still holds.
    cache.applyDocumentChange(doc, editClip(doc, clips[0]!.id, (c) => { c.opacity = 0.5; }));
    expect(owner.released).toBe(false);
    expect(cache.stats().bytes).toBe(100);
    cache.clear();
    expect(owner.released).toBe(true);
    expect(cache.stats().bytes).toBe(0);
  });
});


describe("an instant is found however it was computed", () => {
  it("a lookahead stepping t + i·step finds what the stage stored at quantized instants", () => {
    const cache = createFrameCache({ budgetBytes: 1e9 });
    const step = 1000 / 30;
    for (let i = 0; i < 90; i++) {
      cache.put("c", V, quantizeMsToFrame(i * step + 0.4, 30), payload(), refs(["a"], ["c"]));
    }
    const from = quantizeMsToFrame(2500, 30);
    for (let i = 0; i <= 6; i++) expect(cache.has("c", V, from + i * step)).toBe(true);
    for (let i = 0; i < 90; i++) expect(cache.has("c", V, i * step)).toBe(true);
  });
});
