import { describe, expect, it } from "vitest";
import type { MotionDocument, ShapeClip } from "../schema";
import { fxToken } from "../schema/expressions";
import { keyframeTrackSchema } from "../schema/animation";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { clipByIdIn } from "../timeline/frame-index";
import { resolvedDocAt } from "./resolved-doc";

/**
 * "One layer can follow another" — `layer("Count").x` reads where Count IS:
 * its expression, keys or graph at this instant, not its stored base. The
 * "How many balls" navigator carried the count's formula in every chip because
 * a read of the driven Count came back 0.
 */
function comp() {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const layer = (name: string, x: number, drivers: Record<string, string> = {}) => {
    const c = createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 10000, x, y: 0, width: 10, height: 10 }) as ShapeClip;
    c.name = name;
    c.drivers = {};
    for (const [path, source] of Object.entries(drivers)) {
      const id = `fx_${name}_${path}`;
      doc.expressions.push({ id, source, name: "" });
      c.drivers[path] = fxToken(id);
    }
    const t = createTrack(name);
    t.clips.push(c);
    doc.tracks.push(t);
    return c.id;
  };
  const x = (d: MotionDocument, id: string, ms: number) => (clipByIdIn(resolvedDocAt(d, ms, frameId), id) as ShapeClip).transform.x;
  return { doc, layer, x };
}

describe("reading another layer", () => {
  it("reads its expression's result, through a chain", () => {
    const { doc, layer, x } = comp();
    const count = layer("Count", 0, { x: "floor(#time * 10) + 1" });
    const chip = layer("Chip", 0, { x: 'layer("Count").x * 150' });
    const label = layer("Label", 0, { x: 'layer("Chip").x + 40' });
    expect(x(doc, count, 1000)).toBe(11);
    expect(x(doc, chip, 1000)).toBe(1650);
    expect(x(doc, label, 1000)).toBe(1690);
    // Read before it is baked or after, the answer is the same instant's.
    expect(x(doc, label, 2500)).toBe(26 * 150 + 40);
  });

  it("reads its keys where it has no driver", () => {
    const { doc, layer, x } = comp();
    const lead = layer("Lead", 0);
    const shape = clipByIdIn(doc, lead) as ShapeClip;
    shape.keyframes.push(keyframeTrackSchema.parse({ id: "t", property: "x", keys: [{ id: "k0", timeMs: 0, value: 0, easing: { kind: "linear" } }, { id: "k1", timeMs: 1000, value: 100, easing: { kind: "linear" } }] }));
    const follow = layer("Follow", 0, { x: 'layer("Lead").x + 1' });
    expect(x(doc, follow, 500)).toBeCloseTo(51, 6);
  });

  it("cuts a cycle where it closes instead of overflowing", () => {
    const { doc, layer, x } = comp();
    const a = layer("A", 5, { x: 'layer("B").x + 1' });
    const b = layer("B", 7, { x: 'layer("A").x + 1' });
    const self = layer("Self", 3, { x: 'layer("Self").x * 2' });
    // A asks B, B asks A: the read that closes the loop gets A's stored 5.
    expect(x(doc, a, 0)).toBe(7);
    expect(x(doc, b, 0)).toBe(6);
    expect(x(doc, self, 0)).toBe(6);
  });
});
