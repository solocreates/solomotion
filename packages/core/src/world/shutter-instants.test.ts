import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip, type ShapeClip } from "..";
import { fxToken } from "../schema/expressions";
import { keyframeTrackSchema } from "../schema/animation";
import { placeClip } from "../timeline/place";
import { resolvedDocAt } from "../evaluate/resolved-doc";
import { createWorld } from "./ops";
import { evaluateWorld } from "./evaluate";

describe("a world posed at any instant", () => {
  it("moves an expression-driven object across a shutter posed from the frame's bake", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    const box = (name: string) => {
      const c = createShapeClip({ frameId: frame.id, shape: "rect", startMs: 0, durationMs: 4000, width: 40, height: 40, name }) as ShapeClip;
      placeClip(doc, c);
      return c;
    };
    // The carousel clock: x runs 0 → 28000 over 4 s (7000 units/s).
    const clock = box("Clock");
    clock.keyframes.push(keyframeTrackSchema.parse({ id: "k", property: "x", keys: [{ id: "a", timeMs: 0, value: 0, easing: { kind: "linear" } }, { id: "b", timeMs: 4000, value: 28000, easing: { kind: "linear" } }] }));
    const rider = box("Rider");
    doc.expressions.push({ id: "fx_ride", source: 'layer("Clock").x % 1000', name: "" });
    rider.drivers = { x: fxToken("fx_ride") };

    const at = (bake: ReturnType<typeof resolvedDocAt>, t: number) => evaluateWorld(bake, frame, t, { aliveAt: 2100 }).objects.find((o) => o.id === rider.id)!.matrix[12]!;
    // The frame's own bake, as the renderer holds it; the shutter asks ±8 ms.
    const bake = resolvedDocAt(doc, 2100, frame.id);
    const x0 = at(bake, 2100);
    expect(at(bake, 2108) - x0).toBeCloseTo(56, 6);
    expect(at(bake, 2092) - x0).toBeCloseTo(-56, 6);
  });
});
