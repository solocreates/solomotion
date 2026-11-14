import { describe, it, expect } from "vitest";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { createLayerEffect } from "../animation/layer-effects";
import { groupClips, groupClipById } from "./groups";
import { compositingUnitOf } from "./group-paint";
import { setKeyframe } from "../animation/keyframes";
import { groupBoxAt } from "./group-bounds";
import { clipBox } from "./ops";
import type { MotionDocument, ShapeClip } from "../schema";

const frameIdOf = (doc: MotionDocument) => doc.frames[0]!.id;

function shape(doc: MotionDocument, x: number, lane: string): ShapeClip {
  const clip = createShapeClip({ frameId: frameIdOf(doc), shape: "rect", startMs: 0 }) as ShapeClip;
  clip.durationMs = 4000;
  clip.width = 100;
  clip.height = 100;
  clip.transform.x = x;
  const track = createTrack(lane);
  track.clips.push(clip);
  doc.tracks.push(track);
  return clip;
}

describe("a group that carries a look is one compositing unit", () => {
  it("promotes a member to the outermost group that has to composite as a whole", () => {
    const doc = createEmptyDocument();
    const a = shape(doc, -80, "a");
    const b = shape(doc, 80, "b");
    const inner = groupClips(doc, [a.id, b.id])!;
    const outer = groupClips(doc, [inner])!;

    // Nothing carries a look yet: every layer composites for itself.
    expect(compositingUnitOf(doc, a.id)).toBeNull();

    // A look on the INNER group makes that group the unit.
    groupClipById(doc, inner)!.effects.push(createLayerEffect("glass"));
    expect(compositingUnitOf(doc, a.id)).toBe(inner);

    // A look on the OUTER one wins — the inner group's picture is part of it.
    groupClipById(doc, outer)!.effects.push(createLayerEffect("goo"));
    expect(compositingUnitOf(doc, a.id)).toBe(outer);
    expect(compositingUnitOf(doc, inner)).toBe(outer);
  });

  it("a KEYED fade is a look — the resting opacity alone would paint members at full strength", () => {
    const doc = createEmptyDocument();
    const a = shape(doc, 0, "a");
    const gid = groupClips(doc, [a.id])!;
    expect(compositingUnitOf(doc, a.id)).toBeNull();
    setKeyframe(groupClipById(doc, gid)!.keyframes, "opacity", 0, 1);
    setKeyframe(groupClipById(doc, gid)!.keyframes, "opacity", 500, 0);
    expect(compositingUnitOf(doc, a.id)).toBe(gid);
  });

  it("stays null for a plain container, however deeply nested", () => {
    const doc = createEmptyDocument();
    const a = shape(doc, 0, "a");
    const inner = groupClips(doc, [a.id])!;
    groupClips(doc, [inner]);
    expect(compositingUnitOf(doc, a.id)).toBeNull();
  });
});

describe("a group's box is measured at the playhead", () => {
  it("follows a member that is keyframed away, where the authored box does not", () => {
    const doc = createEmptyDocument();
    const a = shape(doc, -80, "a");
    const b = shape(doc, 80, "b");
    const gid = groupClips(doc, [a.id, b.id])!;
    const group = groupClipById(doc, gid)!;

    const authored = clipBox(doc, group);
    expect(authored.width).toBeCloseTo(260); // −130 … 130

    // b flies out to +380 by 2s. The document box never hears about it.
    b.keyframes.push({
      id: "trk-x",
      property: "x",
      range: null,
      keys: [
        { id: "k0", timeMs: 0, value: 80, easing: { kind: "linear" } },
        { id: "k1", timeMs: 2000, value: 380, easing: { kind: "linear" } },
      ],
    });
    expect(clipBox(doc, group).width).toBeCloseTo(authored.width);
    expect(groupBoxAt(doc, group, 0).width).toBeCloseTo(authored.width);
    expect(groupBoxAt(doc, group, 2000).width).toBeCloseTo(560); // −130 … 430
    expect(groupBoxAt(doc, group, 1000).width).toBeCloseTo(410);
  });

  it("leaves out a member that is not on screen yet", () => {
    const doc = createEmptyDocument();
    const a = shape(doc, -80, "a");
    const b = shape(doc, 80, "b");
    b.startMs = 2000;
    const gid = groupClips(doc, [a.id, b.id])!;
    const group = groupClipById(doc, gid)!;

    // At 0 only `a` is showing, so the group IS `a`.
    const early = groupBoxAt(doc, group, 0);
    expect(early.width).toBeCloseTo(100);
    expect(early.cx).toBeCloseTo(-80);
    // Once b starts, the group is both.
    expect(groupBoxAt(doc, group, 2500).width).toBeCloseTo(260);
  });
});
