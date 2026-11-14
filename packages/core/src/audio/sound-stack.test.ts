import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip, createTextClip, makeSoundLayer } from "../factories";
import { buildSoundCues, availableTriggers, clipHasSound } from "./cues";
import { easingPeak } from "../easing";
import { applyTransition, transitionTargets } from "../timeline/transitions";
import type { MotionDocument } from "../schema";

const frameIdOf = (d: MotionDocument) => d.frames[0]!.id;

/**
 * The stack's headless contract. These pin the two things that would silently
 * rot: WHERE a hit lands (the anchor arithmetic, shared by all three triggers)
 * and WHICH clips can carry which trigger.
 */
describe("sound stack", () => {
  it("a shape's layer animation fires ONE hit — sound is no longer text-only", () => {
    const doc = createEmptyDocument();
    const clip = createShapeClip({ frameId: frameIdOf(doc), shape: "rect", startMs: 500, durationMs: 2000 });
    clip.animIn = { preset: "fade", durationMs: 400, easing: { kind: "linear" }, params: {} };
    clip.sounds = [makeSoundLayer({ kind: "layer" }, "in", { anchor: "start" })];
    doc.tracks[0]!.clips.push(clip);

    const cues = buildSoundCues(doc, 0, 10000, frameIdOf(doc));
    expect(cues).toHaveLength(1);
    expect(cues[0]!.timeMs).toBe(500);
  });

  it("no animation on the edge = no event to ride = silence", () => {
    const doc = createEmptyDocument();
    const clip = createShapeClip({ frameId: frameIdOf(doc), shape: "rect", startMs: 0, durationMs: 2000 });
    clip.sounds = [makeSoundLayer({ kind: "layer" }, "in")];
    doc.tracks[0]!.clips.push(clip);
    expect(buildSoundCues(doc, 0, 10000, frameIdOf(doc))).toHaveLength(0);
  });

  it("anchor + offset compose: an OUT hit lands against the clip's TAIL", () => {
    const doc = createEmptyDocument();
    const clip = createShapeClip({ frameId: frameIdOf(doc), shape: "rect", startMs: 1000, durationMs: 2000 });
    clip.animOut = { preset: "fade", durationMs: 500, easing: { kind: "linear" }, params: {} };
    // The out span is [2500, 3000]. `end` − 100 ms of lead ⇒ 2900.
    clip.sounds = [makeSoundLayer({ kind: "layer" }, "out", { anchor: "end", offsetMs: -100 })];
    doc.tracks[0]!.clips.push(clip);
    expect(buildSoundCues(doc, 0, 10000, frameIdOf(doc))[0]!.timeMs).toBe(2900);
  });

  it("`peak` follows the EASING, so retiming the curve retimes the sound", () => {
    const doc = createEmptyDocument();
    const mk = (easing: Parameters<typeof easingPeak>[0]) => {
      const d = createEmptyDocument();
      const clip = createShapeClip({ frameId: frameIdOf(d), shape: "rect", startMs: 0, durationMs: 2000 });
      clip.animIn = { preset: "fade", durationMs: 1000, easing, params: {} };
      clip.sounds = [makeSoundLayer({ kind: "layer" }, "in", { anchor: "peak" })];
      d.tracks[0]!.clips.push(clip);
      return buildSoundCues(d, 0, 10000, frameIdOf(d))[0]!.timeMs;
    };
    void doc;
    // An ease-OUT front-loads its velocity, an ease-IN back-loads it. A stored
    // number could not know that; a derived one cannot get it wrong.
    const easeOut = mk({ kind: "preset", name: "ease-out" });
    const easeIn = mk({ kind: "preset", name: "ease-in" });
    expect(easeOut).toBeLessThan(easeIn);
    // Linear has no climax — the midpoint is the honest answer.
    expect(mk({ kind: "linear" })).toBe(500);
  });

  it("a transition hit reads the SEAM's live geometry, not a copy of it", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const a = createShapeClip({ frameId: fid, shape: "rect", startMs: 0, durationMs: 1000 });
    const b = createShapeClip({ frameId: fid, shape: "rect", startMs: 1000, durationMs: 1000 });
    const track = doc.tracks[0]!;
    track.clips.push(a, b);
    const seam = transitionTargets(track, fid).find((t) => t.kind === "seam")!;
    applyTransition(doc, seam, "cross-dissolve");
    // B's head sound rides the seam; centred by default, so it lands ON the cut.
    b.sounds = [makeSoundLayer({ kind: "transition" }, "in", { anchor: "start" })];

    const tr = track.transitions[0]!;
    const first = buildSoundCues(doc, 0, 10000, fid)[0]!.timeMs;
    // Widen the transition — the sound must move with it, because nothing about
    // the seam is duplicated onto the clip.
    tr.durationMs *= 2;
    tr.splitMs = tr.durationMs / 2;
    expect(buildSoundCues(doc, 0, 10000, fid)[0]!.timeMs).toBeLessThan(first);
  });

  it("triggers are a CAPABILITY of the clip, not a per-kind branch in the UI", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const text = createTextClip({ frameId: fid, text: "hi", startMs: 0, durationMs: 1000 });
    const shape = createShapeClip({ frameId: fid, shape: "rect", startMs: 0, durationMs: 1000 });
    const track = doc.tracks[0]!;
    expect(availableTriggers(text, track)).toEqual(["text", "layer", "transition"]);
    expect(availableTriggers(shape, track)).toEqual(["layer", "transition"]);
    // Off a lane there is no seam to attach to.
    expect(availableTriggers(shape, null)).toEqual(["layer"]);
  });

  it("a disabled entry is silent but detection still reports the clip", () => {
    const doc = createEmptyDocument();
    const clip = createShapeClip({ frameId: frameIdOf(doc), shape: "rect", startMs: 0, durationMs: 1000 });
    clip.animIn = { preset: "fade", durationMs: 200, easing: { kind: "linear" }, params: {} };
    clip.sounds = [makeSoundLayer({ kind: "layer" }, "in", { enabled: false })];
    doc.tracks[0]!.clips.push(clip);
    expect(buildSoundCues(doc, 0, 10000, frameIdOf(doc))).toHaveLength(0);
    expect(clipHasSound(doc, clip)).toBe(false);
  });

  it("layering is the point: two entries on one phase both fire", () => {
    const doc = createEmptyDocument();
    const clip = createShapeClip({ frameId: frameIdOf(doc), shape: "rect", startMs: 0, durationMs: 2000 });
    clip.animIn = { preset: "fade", durationMs: 600, easing: { kind: "linear" }, params: {} };
    clip.sounds = [
      makeSoundLayer({ kind: "layer" }, "in", { pack: "soft", anchor: "start" }),
      makeSoundLayer({ kind: "layer" }, "in", { pack: "thock", anchor: "end" }),
    ];
    doc.tracks[0]!.clips.push(clip);
    const cues = buildSoundCues(doc, 0, 10000, frameIdOf(doc));
    expect(cues.map((c) => [c.pack, c.timeMs])).toEqual([
      ["soft", 0],
      ["thock", 600],
    ]);
  });
});
