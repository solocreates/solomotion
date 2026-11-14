import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip } from "../factories";
import type { Keyframe, ShapeClip } from "../schema";
import { layerPictureSegment } from "./picture-steady";

const key = (id: string, timeMs: number, value: number): Keyframe =>
  ({ id, timeMs, value, easing: "linear" }) as unknown as Keyframe;

describe("steady segments", () => {
  const doc = createEmptyDocument();
  const base = createShapeClip({ frameId: doc.frames[0]!.id, shape: "rect", startMs: 0 }) as ShapeClip;

  it("a layer with nothing animated is one picture for its whole life", () => {
    const a = layerPictureSegment(doc, base, 100);
    const b = layerPictureSegment(doc, base, 9000);
    expect(a).not.toBeNull();
    expect(a!.key).toBe(b!.key);
  });

  it("a keyed layer holds still before its first key and after its last, as two different pictures", () => {
    const clip = { ...base, keyframes: [{ id: "t", property: "x", range: null, keys: [key("a", 2000, 0), key("b", 3000, 100)] }] };
    const before = layerPictureSegment(doc, clip, 500);
    const during = layerPictureSegment(doc, clip, 2500);
    const after = layerPictureSegment(doc, clip, 4000);
    expect(during).toBeNull();
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(before!.key).not.toBe(after!.key);
    // The edges themselves are moving — the conservative side.
    expect(layerPictureSegment(doc, clip, 2000)).toBeNull();
    expect(layerPictureSegment(doc, clip, 3000)).toBeNull();
  });

  it("a hold between two equal keys is still — hold, ease, hold is three segments, not one move", () => {
    const keys = [key("a", 0, 0), key("b", 1000, 0), key("c", 1200, 10), key("d", 5000, 10), key("e", 5000, 20), key("f", 8000, 20)];
    const clip = { ...base, keyframes: [{ id: "t", property: "x", range: null, keys }] };
    const first = layerPictureSegment(doc, clip, 500);
    const second = layerPictureSegment(doc, clip, 3000);
    const third = layerPictureSegment(doc, clip, 6000);
    expect(first).not.toBeNull();
    expect(layerPictureSegment(doc, clip, 1100)).toBeNull();
    expect(second).not.toBeNull();
    expect(third).not.toBeNull();
    // A zero-length jump still splits the pictures either side of it.
    expect(layerPictureSegment(doc, clip, 5000)).toBeNull();
    expect(new Set([first!.key, second!.key, third!.key]).size).toBe(3);
  });

  it("a position hold bent by spatial tangents may travel and return, so it moves", () => {
    const bent = { ...key("a", 0, 0), spatial: { in: null, out: { x: 40, y: -60 } } } as unknown as Keyframe;
    const clip = {
      ...base,
      keyframes: [
        { id: "x", property: "x", range: null, keys: [bent, key("b", 1000, 0)] },
        { id: "y", property: "y", range: null, keys: [key("c", 0, 0), key("d", 1000, 0)] },
      ],
    };
    expect(layerPictureSegment(doc, clip, 500)).toBeNull();
  });

  it("one key is a constant, not a movement", () => {
    const clip = { ...base, keyframes: [{ id: "t", property: "x", range: null, keys: [key("a", 2000, 5)] }] };
    expect(layerPictureSegment(doc, clip, 2000)).not.toBeNull();
  });

  it("an in-animation moves the layer over its own zone and nowhere else", () => {
    const clip = { ...base, animIn: { preset: "fade", durationMs: 500, easing: "linear", params: {} } } as unknown as ShapeClip;
    expect(layerPictureSegment(doc, clip, 200)).toBeNull();
    expect(layerPictureSegment(doc, clip, 2000)).not.toBeNull();
  });
});

describe("steady composites", () => {
  it("two instants with the same still contributors share a signature; a moving one breaks it", async () => {
    const { createTrack } = await import("../factories");
    const { compSteadyKey } = await import("./picture-steady");
    const doc = createEmptyDocument();
    const comp = doc.frames[0]!.id;
    const still = createShapeClip({ frameId: comp, shape: "rect", startMs: 0 }) as ShapeClip;
    const lane = createTrack("a");
    lane.clips.push(still);
    doc.tracks.push(lane);
    expect(compSteadyKey(doc, comp, 100, [still.id])).toBe(compSteadyKey(doc, comp, 900, [still.id]));

    const moving = { ...still, id: "m", keyframes: [{ id: "t", property: "x", range: null, keys: [key("a", 0, 0), key("b", 5000, 9)] }] };
    const lane2 = createTrack("b");
    lane2.clips.push(moving as ShapeClip);
    doc.tracks.push(lane2);
    expect(compSteadyKey(doc, comp, 100, [still.id, "m"])).toBeNull();
  });
});

describe("the steady prefix of a stack", () => {
  it("splits at the first card that moves", async () => {
    const { steadyStackPrefix } = await import("./picture-steady");
    const { createLayerEffect } = await import("../animation/layer-effects");
    const doc = createEmptyDocument();
    const base = createShapeClip({ frameId: doc.frames[0]!.id, shape: "rect", startMs: 0 }) as ShapeClip;
    const blur = createLayerEffect("blur");
    const grain = { ...createLayerEffect("grain"), animate: true };
    const clip = { ...base, effects: [blur, grain] } as ShapeClip;
    const plan = steadyStackPrefix(doc, clip, 1000);
    expect(plan?.count).toBe(1);
    // Nothing moving: the layer is judged whole, not split.
    expect(steadyStackPrefix(doc, { ...base, effects: [blur] } as ShapeClip, 1000)).toBeNull();
    // Moving first: nothing before it to keep.
    expect(steadyStackPrefix(doc, { ...base, effects: [grain, blur] } as ShapeClip, 1000)).toBeNull();
  });
});

describe("group segments", () => {
  it("a group is still outside its members' keyed windows, carried into its own clock", async () => {
    const { createTrack, createGroupClip } = await import("../factories") as unknown as {
      createTrack: (n: string) => import("../schema").Track;
      createGroupClip?: unknown;
    };
    void createGroupClip;
    const doc = createEmptyDocument();
    const comp = doc.frames[0]!.id;
    const group = { ...(createShapeClip({ frameId: comp, shape: "rect", startMs: 1000 }) as ShapeClip), id: "g", kind: "group", durationMs: 8000 } as unknown as ShapeClip;
    const groupLane = createTrack("g");
    groupLane.clips.push(group);
    const row = { ...createTrack("row"), groupId: "g" };
    const member = { ...(createShapeClip({ frameId: comp, shape: "rect", startMs: 1000 }) as ShapeClip), durationMs: 8000, keyframes: [{ id: "t", property: "x", range: null, keys: [key("a", 3300, 0), key("b", 4500, 50)] }] };
    row.clips.push(member);
    doc.tracks.push(groupLane, row);

    // Member moves 3.3–4.5s of ITS time = 3.3–4.5s of the group's (same start).
    const before = layerPictureSegment(doc, group as never, 1000);
    const during = layerPictureSegment(doc, group as never, 4000);
    const after = layerPictureSegment(doc, group as never, 6000);
    expect(before).not.toBeNull();
    expect(during).toBeNull();
    expect(after).not.toBeNull();
    expect(before!.key).not.toBe(after!.key);
    // One picture for the whole tail.
    expect(layerPictureSegment(doc, group as never, 7900)!.key).toBe(after!.key);
  });
});

describe("stepped cards", () => {
  it("a looping Line boil is N pictures for the whole timeline, keyed by drawing", async () => {
    const { createLayerEffect } = await import("../animation/layer-effects");
    const doc = createEmptyDocument();
    const base = createShapeClip({ frameId: doc.frames[0]!.id, shape: "rect", startMs: 0 }) as ShapeClip;
    // 10 steps a second, 3 drawings: 0–99ms is drawing 0, 100–199 drawing 1 … 300 is drawing 0 again.
    const boil = { ...createLayerEffect("boil"), rate: 10, variants: 3 };
    const clip = { ...base, effects: [boil] } as ShapeClip;
    const at = (ms: number) => layerPictureSegment(doc, clip, ms)?.key;
    expect(at(20)).toBeDefined();
    expect(at(20)).toBe(at(80));
    expect(at(20)).not.toBe(at(150));
    expect(at(20)).toBe(at(320));
    // The effect clock's lead picks the drawing, not document time.
    expect(layerPictureSegment(doc, clip, 20, 100)?.key).toBe(at(150));
  });

  it("a card with a keyed field, or one that flows (film damage), still moves", async () => {
    const { createLayerEffect } = await import("../animation/layer-effects");
    const doc = createEmptyDocument();
    const base = createShapeClip({ frameId: doc.frames[0]!.id, shape: "rect", startMs: 0 }) as ShapeClip;
    const grain = { ...createLayerEffect("grain"), animate: true };
    const keyed = {
      ...base,
      effects: [grain],
      keyframes: [{ id: "t", property: `lfx.${grain.id}.amount`, range: null, keys: [key("a", 0, 0), key("b", 5000, 1)] }],
    } as unknown as ShapeClip;
    expect(layerPictureSegment(doc, keyed, 6000)).toBeNull();
    const flowing = { ...base, effects: [createLayerEffect("filmDamage")] } as ShapeClip;
    expect(layerPictureSegment(doc, flowing, 100)).toBeNull();
  });

  it("a card held still is one picture for the whole clip", async () => {
    const { createLayerEffect } = await import("../animation/layer-effects");
    const doc = createEmptyDocument();
    const base = createShapeClip({ frameId: doc.frames[0]!.id, shape: "rect", startMs: 0 }) as ShapeClip;
    const still = { ...base, effects: [{ ...createLayerEffect("filmDamage"), animate: false }] } as ShapeClip;
    expect(layerPictureSegment(doc, still, 100)?.key).toBe(layerPictureSegment(doc, still, 3100)?.key);
  });
});
