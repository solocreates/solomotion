import { describe, expect, it } from "vitest";
import { flattenCommands } from "../vector/polyline";
import { shapeCommands } from "../vector/geometry";
import {
  hostPolylinesAt,
  nearestOnOutline,
  offsetForArcLength,
  placeGlyphsOnPath,
  poseBounds,
  type GlyphAdvance,
} from "./on-path";
import { createEmptyDocument, createShapeClip, createTextClip, createTrack } from "../factories";
import { bindTextToPath, detachTextFromPath } from "../relations/text-path";
import { resolveDocumentRelations, documentHasRelations } from "../relations/resolve";
import { clipNaturalSize, deleteClip } from "../timeline/ops";
import { setKeyframe } from "../animation/keyframes";
import type { ShapeClip, TextClip } from "../schema";

/** A straight line from (0,0) to (100,0), flattened. */
const line = () => flattenCommands([{ type: "M", x: 0, y: 0 }, { type: "L", x: 100, y: 0 }])[0]!;
/** A 10-unit square, closed, clockwise on screen (y down). */
const square = () =>
  flattenCommands([
    { type: "M", x: 0, y: 0 },
    { type: "L", x: 10, y: 0 },
    { type: "L", x: 10, y: 10 },
    { type: "L", x: 0, y: 10 },
    { type: "Z" },
  ])[0]!;

const spec = { offset: 0, rise: 0, flip: false, follow: "tangent" as const, loop: true };
const glyphs = (...xs: number[]): GlyphAdvance[] => xs.map((x) => ({ x, width: 10, dy: 0 }));

describe("placeGlyphsOnPath", () => {
  it("puts a left-aligned run's first glyph centre at the offset, reading along the tangent", () => {
    const poses = placeGlyphsOnPath(glyphs(0, 10, 20), line(), spec, "left");
    expect(poses.map((p) => Math.round(p.x))).toEqual([5, 15, 25]);
    expect(poses.every((p) => p.y === 0 && p.angle === 0 && p.visible)).toBe(true);
  });

  it("centres a centred run about the offset", () => {
    const poses = placeGlyphsOnPath(glyphs(-15, -5, 5), line(), { ...spec, offset: 0.5 }, "center");
    expect(poses.map((p) => Math.round(p.x))).toEqual([40, 50, 60]);
  });

  it("offset is in LAPS — a full lap lands where it started", () => {
    const a = placeGlyphsOnPath(glyphs(0), square(), { ...spec, offset: 0.25 }, "left")[0]!;
    const b = placeGlyphsOnPath(glyphs(0), square(), { ...spec, offset: 1.25 }, "left")[0]!;
    expect(a.x).toBeCloseTo(b.x);
    expect(a.y).toBeCloseTo(b.y);
  });

  it("wraps across the seam when looping and hides past the end when not", () => {
    const looped = placeGlyphsOnPath(glyphs(0, 95), line(), spec, "left")[1]!;
    // Centre at 100 → wraps to 0.
    expect(looped.x).toBeCloseTo(0);
    expect(looped.visible).toBe(true);
    const clipped = placeGlyphsOnPath(glyphs(0, 96), line(), { ...spec, loop: false }, "left")[1]!;
    expect(clipped.visible).toBe(false);
  });

  it("rise lifts toward screen-up on a rightward line, and to the outside of a clockwise square", () => {
    const lifted = placeGlyphsOnPath(glyphs(0), line(), { ...spec, rise: 4 }, "left")[0]!;
    expect(lifted.y).toBeCloseTo(-4);
    // Top edge of the square travels rightward: up is outside (negative y).
    const top = placeGlyphsOnPath(glyphs(0), square(), { ...spec, offset: 0.1, rise: 2 }, "left")[0]!;
    expect(top.y).toBeCloseTo(-2);
    // Bottom edge travels leftward: up is still outside (y past 10).
    const bottom = placeGlyphsOnPath(glyphs(0), square(), { ...spec, offset: 0.6, rise: 2 }, "left")[0]!;
    expect(bottom.y).toBeCloseTo(12);
  });

  it("flip reverses travel and mirrors the up-vector — the other side, reading the other way", () => {
    const plain = placeGlyphsOnPath(glyphs(0, 10), line(), { ...spec, offset: 0.5, rise: 3 }, "left");
    const flipped = placeGlyphsOnPath(glyphs(0, 10), line(), { ...spec, offset: 0.5, rise: 3, flip: true }, "left");
    expect(plain[1]!.x).toBeGreaterThan(plain[0]!.x);
    expect(flipped[1]!.x).toBeLessThan(flipped[0]!.x);
    expect(plain[0]!.y).toBeCloseTo(-3);
    expect(flipped[0]!.y).toBeCloseTo(3);
    expect(Math.abs(flipped[0]!.angle)).toBeCloseTo(Math.PI);
  });

  it("upright keeps every glyph level while still sitting on the curve", () => {
    const poses = placeGlyphsOnPath(glyphs(0, 10, 20), square(), { ...spec, offset: 0.3, follow: "upright" }, "left");
    expect(poses.every((p) => p.angle === 0)).toBe(true);
    expect(poses.some((p) => p.x !== poses[0]!.x)).toBe(true);
  });

  it("a second line stacks against the up-vector (inside the curve)", () => {
    const [first, second] = placeGlyphsOnPath(
      [{ x: 0, width: 10, dy: 0 }, { x: 0, width: 10, dy: 12 }],
      line(),
      spec,
      "left",
    );
    expect(second!.y - first!.y).toBeCloseTo(12);
  });

  it("poseBounds ignores hidden glyphs", () => {
    const poses = placeGlyphsOnPath(glyphs(0, 200), line(), { ...spec, loop: false }, "left");
    const b = poseBounds(poses)!;
    expect(b.maxX).toBeCloseTo(5);
  });
});

describe("pointer ↔ outline", () => {
  it("finds the nearest point and its arc length across contours", () => {
    const ring = flattenCommands(shapeCommands({ shape: "ellipse", width: 100, height: 100, cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 }, radius: 0, pointCount: 3, innerRatio: 0.5, arcRatio: 0.5 }));
    expect(ring.length).toBe(2);
    const hit = nearestOnOutline(ring, { x: 0, y: -26 })!;
    // Closer to the inner ring (radius 25) than the outer (50).
    expect(hit.contour).toBe(1);
    expect(hit.dist).toBeLessThan(1.5);
  });

  it("offsetForArcLength stays on the lap the drag started on", () => {
    expect(offsetForArcLength(50, 100)).toBeCloseTo(0.5);
    // Sliding from 0.98 across the seam to arc 2 → 1.02, not 0.02.
    expect(offsetForArcLength(2, 100, 0.98)).toBeCloseTo(1.02);
    // And back the other way.
    expect(offsetForArcLength(98, 100, 1.02)).toBeCloseTo(0.98);
    // Three laps in keeps counting laps.
    expect(offsetForArcLength(10, 100, 3.05)).toBeCloseTo(3.1);
  });
});

describe("the relation in a document", () => {
  function scene() {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const host = createShapeClip({ frameId, shape: "ellipse", startMs: 0, x: 40, y: 20, width: 200, height: 100 }) as ShapeClip;
    host.transform.rotation = 30;
    setKeyframe(host.keyframes, "x", 0, 40);
    setKeyframe(host.keyframes, "x", 1000, 140);
    const text = createTextClip({ frameId, text: "Hello", startMs: 0, x: 0, y: 0, presetId: null });
    const laneA = createTrack("host");
    laneA.clips.push(host);
    const laneB = createTrack("text");
    laneB.clips.push(text);
    doc.tracks.push(laneB, laneA);
    return { doc, host, text };
  }

  it("binds only to a shape or path in the same comp", () => {
    const { doc, host, text } = scene();
    expect(documentHasRelations(doc)).toBe(false);
    expect(bindTextToPath(doc, text, "nope")).toBe(false);
    expect(bindTextToPath(doc, text, host.id, { offset: 0.25 })).toBe(true);
    expect(text.path?.offset).toBe(0.25);
    expect(text.path?.loop).toBe(true);
  });

  it("the bound text's box IS the host's box", () => {
    const { doc, host, text } = scene();
    bindTextToPath(doc, text, host.id);
    expect(clipNaturalSize(doc, text)).toEqual(clipNaturalSize(doc, host));
  });

  it("resolving drives the text's transform from the host's, at the host's instant", () => {
    const { doc, host, text } = scene();
    bindTextToPath(doc, text, host.id);
    setKeyframe(text.keyframes, "x", 0, 999);
    const resolved = resolveDocumentRelations(doc, 500);
    const t = resolved.tracks.flatMap((tr) => tr.clips).find((c) => c.id === text.id) as TextClip;
    expect(t.transform.x).toBeCloseTo(90);
    expect(t.transform.rotation).toBe(30);
    expect(t.transform.y).toBe(20);
    // The text's own position key is gone — the host owns the transform now.
    expect(t.keyframes.find((k) => k.property === "x")).toBeUndefined();
    // Untouched clips keep identity.
    expect(resolved.tracks.flatMap((tr) => tr.clips).find((c) => c.id === host.id)).toBe(host);
  });

  it("the host's polylines follow its keyframed geometry", () => {
    const { host } = scene();
    setKeyframe(host.keyframes, "width", 0, 200);
    setKeyframe(host.keyframes, "width", 1000, 400);
    const a = hostPolylinesAt(host, 0)[0]!.length;
    const b = hostPolylinesAt(host, 1000)[0]!.length;
    expect(b).toBeGreaterThan(a * 1.3);
  });

  it("detaching bakes the host's transform so the text stays where it renders", () => {
    const { doc, host, text } = scene();
    bindTextToPath(doc, text, host.id);
    detachTextFromPath(doc, text, 500);
    expect(text.path).toBeNull();
    expect(text.transform.x).toBeCloseTo(90);
    expect(text.transform.rotation).toBe(30);
  });

  it("deleting the host sets its texts down as plain text", () => {
    const { doc, host, text } = scene();
    bindTextToPath(doc, text, host.id);
    expect(deleteClip(doc, host.id)).toBe(true);
    expect(text.path).toBeNull();
    expect(text.transform.rotation).toBe(30);
  });
});
