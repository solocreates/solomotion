import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip, createTextClip } from "./factories";
import {
  applyEdgeClipboard,
  applyLayerAnimToClips,
  clipEdgeDecors,
  edgeRefKey,
  findEdgeDecor,
  readEdgeDecor,
  removeEdgeDecor,
  retargetEdgeDecor,
  setEdgeDecorDuration,
  trackEdgeDecors,
} from "./timeline/clip-edges";
import { applyTransition, transitionTargets } from "./timeline/transitions";
import { transitionMixAt } from "./animation/transitions";
import type { MotionDocument, Track } from "./schema";

function doc2(): { doc: MotionDocument; track: Track; frameId: string } {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const track = doc.tracks[0]!;
  track.clips.push(createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 1000 }));
  track.clips.push(createTextClip({ frameId, text: "hello", startMs: 1000, durationMs: 1000 }));
  return { doc, track, frameId };
}

describe("clip edge decorations", () => {
  it("reports both grains on a text clip and only the layer grain elsewhere", () => {
    const { doc, track } = doc2();
    const shape = track.clips[0]!;
    const text = track.clips[1]!;
    applyLayerAnimToClips(doc, [shape.id, text.id], "fade", "in");
    if (text.kind === "text") text.animations.in = { ...text.animations.in!, preset: "typewriter" };

    expect(clipEdgeDecors(shape).map((d) => d.kind)).toEqual(["layer"]);
    const textKinds = clipEdgeDecors(text).map((d) => d.kind);
    expect(textKinds).toContain("layer");
    expect(textKinds).toContain("text");
  });

  it("an animation preset lands at LAYER grain on every clip kind, text included", () => {
    const { doc, track } = doc2();
    const ids = track.clips.map((c) => c.id);
    expect(applyLayerAnimToClips(doc, ids, "fade", "in")).toBe(2);
    for (const clip of track.clips) {
      expect(clip.kind === "audio" ? null : clip.animIn?.preset).toBe("fade");
    }
  });

  it("delete removes the decoration and nothing else", () => {
    const { doc, track } = doc2();
    const shape = track.clips[0]!;
    applyLayerAnimToClips(doc, [shape.id], "fade", "in");
    const ref = clipEdgeDecors(shape)[0]!.ref;
    expect(removeEdgeDecor(doc, ref)).toBe(true);
    expect(clipEdgeDecors(shape)).toHaveLength(0);
    expect(track.clips).toHaveLength(2);
    // Idempotent: a stale selection can't throw.
    expect(removeEdgeDecor(doc, ref)).toBe(false);
  });

  it("resizing a glyph animation scales the whole rhythm, not just one unit", () => {
    const { doc, track } = doc2();
    const text = track.clips[1]!;
    if (text.kind !== "text") throw new Error("expected text");
    text.animations.in = {
      preset: "typewriter",
      unit: "letter",
      durationMs: 100,
      staggerMs: 50,
      delayMs: 0,
      easing: { kind: "preset", name: "ease-out" },
      jitterMs: 0,
      scatterPx: 0,
      scatterDeg: 0,
      params: {},
    };
    const before = findEdgeDecor(doc, { kind: "text", clipId: text.id, side: "in" })!;
    setEdgeDecorDuration(doc, before.ref, before.durationMs * 2);
    const after = findEdgeDecor(doc, before.ref)!;
    expect(after.durationMs).toBeGreaterThan(before.durationMs * 1.8);
    // The ratio the user tuned survives the stretch.
    expect(text.animations.in!.staggerMs / text.animations.in!.durationMs).toBeCloseTo(0.5, 1);
  });

  it("retarget keeps the timing the user tuned", () => {
    const { doc, track } = doc2();
    const shape = track.clips[0]!;
    applyLayerAnimToClips(doc, [shape.id], "fade", "in");
    if (shape.kind !== "audio") shape.animIn!.durationMs = 777;
    retargetEdgeDecor(doc, { kind: "layer", clipId: shape.id, side: "in" }, "pop");
    if (shape.kind !== "audio") {
      expect(shape.animIn!.preset).toBe("pop");
      expect(shape.animIn!.durationMs).toBe(777);
    }
  });

  it("a glyph animation pasted on a shape becomes the same preset at layer grain", () => {
    const { doc, track } = doc2();
    const shape = track.clips[0]!;
    const text = track.clips[1]!;
    if (text.kind !== "text") throw new Error("expected text");
    text.animations.in = { ...text.animations.in!, preset: "pop", durationMs: 321 };
    const entry = readEdgeDecor(doc, { kind: "text", clipId: text.id, side: "in" })!;
    expect(entry.kind).toBe("text");
    expect(applyEdgeClipboard(doc, entry, [shape.id])).toBe(1);
    if (shape.kind !== "audio") {
      expect(shape.animIn?.preset).toBe("pop");
      expect(shape.animIn?.durationMs).toBe(321);
    }
  });

  it("a transition copies and pastes onto another selection's cuts", () => {
    const { doc, track, frameId } = doc2();
    const seam = transitionTargets(track, frameId).find((t) => t.kind === "seam")!;
    applyTransition(doc, seam, "cross-dissolve", { durationMs: 400, splitMs: 100 });
    const decor = trackEdgeDecors(doc, track, frameId)[0]!;
    const entry = readEdgeDecor(doc, decor.ref)!;
    expect(entry.kind === "transition" && entry.splitRatio).toBeCloseTo(0.25);
    removeEdgeDecor(doc, decor.ref);
    expect(trackEdgeDecors(doc, track, frameId)).toHaveLength(0);
    expect(applyEdgeClipboard(doc, entry, [track.clips[0]!.id])).toBeGreaterThan(0);
  });

  it("refs are stable, comparable keys", () => {
    expect(edgeRefKey({ kind: "layer", clipId: "c1", side: "in" })).toBe("layer:c1:in");
    expect(edgeRefKey({ kind: "transition", id: "t1" })).toBe("transition:t1");
  });
});

describe("lone-edge transitions", () => {
  const tr = (preset: string, a: string | null, b: string | null) => ({
    id: "t",
    preset,
    frameId: "f",
    aClipId: a,
    bClipId: b,
    durationMs: 500,
    splitMs: a && b ? 250 : a ? 500 : 0,
    easing: { kind: "linear" } as const,
    params: {},
    color: null,
  });

  it("a dip on a lone HEAD runs from the clip's first frame, not its middle", () => {
    const head = tr("dip-to-color", null, "b");
    const sides = { a: false, b: true };
    // Fully veiled at the start, clear at the end — and the picture is held
    // present throughout instead of popping on halfway.
    expect(transitionMixAt(head, 0, sides).veil).toBeCloseTo(1, 2);
    expect(transitionMixAt(head, 1, sides).veil).toBeCloseTo(0, 2);
    for (let i = 0; i <= 10; i++) {
      expect(transitionMixAt(head, i / 10, sides).b.opacity).toBe(1);
    }
  });

  it("a dip on a lone TAIL runs to the clip's last frame", () => {
    const tail = tr("dip-to-color", "a", null);
    const sides = { a: true, b: false };
    expect(transitionMixAt(tail, 0, sides).veil).toBeCloseTo(0, 2);
    expect(transitionMixAt(tail, 1, sides).veil).toBeCloseTo(1, 2);
  });

  it("a two-sided dip still plays the full arch", () => {
    const seam = tr("dip-to-color", "a", "b");
    expect(transitionMixAt(seam, 0.5).veil).toBeCloseTo(1, 2);
    expect(transitionMixAt(seam, 0).veil).toBeCloseTo(0, 2);
  });

  it("families that already ramp monotonically are untouched by a missing side", () => {
    const head = tr("cross-dissolve", null, "b");
    expect(transitionMixAt(head, 0, { a: false, b: true }).b.opacity).toBeCloseTo(0, 2);
    expect(transitionMixAt(head, 1, { a: false, b: true }).b.opacity).toBeCloseTo(1, 2);
  });
});
