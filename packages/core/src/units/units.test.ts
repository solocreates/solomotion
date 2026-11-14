import { describe, expect, it } from "vitest";
import type { MotionDocument, ShapeClip } from "../schema";
import { fxToken } from "../schema/expressions";
import { keyframeTrackSchema } from "../schema/animation";
import { createEmptyDocument, createGroupClip, createShapeClip, createTrack } from "../factories";
import { clipByIdIn } from "../timeline/frame-index";
import { resolvedDocAt } from "../evaluate/resolved-doc";
import { formatLengthSpec, isLengthPath, lengthAxisOf, parseLength, parseLengthSpec } from "./length";
import { writeProperties } from "../api/commands/edit";
import { withAuthoredLengths } from "./resolve";

/**
 * Relational units are a BAKE stage: whatever a field is written in, the bake
 * hands every reader comp px. Screen units divide by every scale on the way to
 * the output — the layer's own, its groups', the view a nest is seen through.
 */
function comp() {
  const doc = createEmptyDocument();
  const frame = doc.frames[0]!;
  const shape = (over: Partial<ShapeClip> = {}, trackGroup: string | null = null) => {
    const c = createShapeClip({ frameId: frame.id, shape: "rect", startMs: 0, durationMs: 10000, x: 0, y: 0, width: 10, height: 10 }) as ShapeClip;
    Object.assign(c, over);
    const t = createTrack("t");
    t.groupId = trackGroup;
    t.clips.push(c);
    doc.tracks.push(t);
    return c;
  };
  const at = (d: MotionDocument, id: string, ms = 0, view: { scale: number; width: number; height: number } | null = null) =>
    clipByIdIn(resolvedDocAt(d, ms, frame.id, false, null, view), id) as ShapeClip;
  return { doc, frame, shape, at };
}

describe("relational units", () => {
  it("spx divides by the layer's own scale and the view", () => {
    const { doc, shape, at } = comp();
    const c = shape({ units: { width: { unit: "spx" } } });
    c.transform.scale = 4;
    expect(at(doc, c.id).width).toBeCloseTo(2.5);
    expect(at(doc, c.id, 0, { scale: 13000, width: 1080, height: 1920 }).width).toBeCloseTo(10 / 4 / 13000, 12);
    // A different view is a different bake, not a stale one.
    expect(at(doc, c.id, 0, { scale: 12, width: 1080, height: 1920 }).width).toBeCloseTo(10 / 48, 12);
  });

  it("a placement in spx ignores the layer's own scale but not its group's", () => {
    const { doc, frame, shape, at } = comp();
    const g = createGroupClip({ frameId: frame.id, startMs: 0, durationMs: 10000 });
    g.transform.scale = 2;
    const gt = createTrack("g");
    gt.clips.push(g);
    doc.tracks.push(gt);
    const c = shape({ units: { x: { unit: "spx" }, width: { unit: "spx" } } }, g.id);
    c.transform.x = 100;
    c.transform.scale = 5;
    const out = at(doc, c.id);
    expect(out.transform.x).toBeCloseTo(50);
    expect(out.width).toBeCloseTo(1);
  });

  it("fw, fh and % size against the comp", () => {
    const { doc, frame, shape, at } = comp();
    const c = shape({ width: 50, height: 10, units: { width: { unit: "fw" }, height: { unit: "%" } } });
    c.transform.scale = 3; // comp units are layout units: transforms do not enter
    const out = at(doc, c.id);
    expect(out.width).toBeCloseTo(frame.width / 2);
    expect(out.height).toBeCloseTo(frame.height / 10);
  });

  it("keys are in the field's unit, and are owned by the bake", () => {
    const { doc, shape, at } = comp();
    const c = shape({ units: { width: { unit: "vw" } } });
    c.keyframes.push(keyframeTrackSchema.parse({ id: "k", property: "width", keys: [{ id: "a", timeMs: 0, value: 0, easing: { kind: "linear" } }, { id: "b", timeMs: 1000, value: 10, easing: { kind: "linear" } }] }));
    const view = { scale: 2, width: 1000, height: 500 };
    const out = at(doc, c.id, 500, view);
    // 5vw of a 1000 px output = 50 output px = 25 comp px through a ×2 view.
    expect(out.width).toBeCloseTo(25);
    expect(out.keyframes.some((t) => t.property === "width")).toBe(false);
  });

  it("expressions mix units like calc()", () => {
    const { doc, frame, shape, at } = comp();
    const c = shape();
    doc.expressions.push({ id: "fx_w", source: "fw(50) - spx(8)", name: "" });
    c.drivers = { width: fxToken("fx_w") };
    expect(at(doc, c.id).width).toBeCloseTo(frame.width / 2 - 8);
    expect(at(doc, c.id, 0, { scale: 4, width: frame.width, height: frame.height }).width).toBeCloseTo(frame.width / 2 - 2);
  });

  it("knows its lengths, axes and text form", () => {
    expect(isLengthPath("fontSize")).toBe(true);
    expect(isLengthPath("opacity")).toBe(false);
    expect(isLengthPath("stroke.s1.width")).toBe(true);
    expect(isLengthPath("stroke.s1.opacity")).toBe(false);
    const { shape } = comp();
    const c = shape();
    expect(lengthAxisOf(c, "width")).toBe("x");
    expect(lengthAxisOf(c, "layout.padding.top")).toBe("y");
    expect(lengthAxisOf(c, "stroke.s1.width")).toBe("d");
    expect(parseLength("2spx")).toEqual({ value: 2, unit: "spx" });
    expect(parseLength(" -3.5 FW ")).toEqual({ value: -3.5, unit: "fw" });
    expect(parseLength("50%")).toEqual({ value: 50, unit: "%" });
    expect(parseLength("12")).toEqual({ value: 12, unit: "px" });
    expect(parseLength("2em")).toBeNull();
  });

  it("layer.set takes a unit as text, keeps it, and converts keys when it changes", () => {
    const { doc, frame, shape, at } = comp();
    const c = shape({ width: 100 });
    writeProperties(c, { width: "2spx", height: "50fh" }, 0, "base", doc);
    expect(c.units).toEqual({ width: { unit: "spx" }, height: { unit: "fh" } });
    expect(c.width).toBe(2);
    writeProperties(c, { width: 3 }, 0, "base", doc);
    expect(c.units?.width?.unit).toBe("spx");
    expect(at(doc, c.id).height).toBeCloseTo(frame.height / 2);
    // Switching unit keeps the size: 3 spx at ×1 is 3 px, in fw that is 300 / width.
    writeProperties(c, { width: "10px" }, 0, "base", doc);
    expect(c.units?.width).toBeUndefined();
    expect(() => writeProperties(c, { opacity: "2spx" }, 0, "base", doc)).toThrow(/not a length/);
  });

  it("bounds hold a relative size between screen limits, CSS clamp()", () => {
    const { doc, frame, shape, at } = comp();
    const c = shape();
    writeProperties(c, { width: "clamp(1spx, 0.2fw, 6spx)" }, 0, "base", doc);
    expect(c.units?.width).toEqual({ unit: "fw", min: { value: 1, unit: "spx" }, max: { value: 6, unit: "spx" } });
    const view = (scale: number) => ({ scale, width: frame.width, height: frame.height });
    const natural = frame.width * 0.002;
    // ×1: the frame share, inside the bounds.
    expect(at(doc, c.id, 0, view(1)).width).toBeCloseTo(Math.min(6, Math.max(1, natural)));
    // ×1000: 0.2fw is enormous on screen, held at 6 screen px.
    expect(at(doc, c.id, 0, view(1000)).width * 1000).toBeCloseTo(6);
    // ×0.01: it would vanish, held at 1 screen px.
    expect(at(doc, c.id, 0, view(0.01)).width * 0.01).toBeCloseTo(1);
    // A bare number afterwards keeps the bounds.
    writeProperties(c, { width: 0.3 }, 0, "base", doc);
    expect(c.units?.width?.max).toEqual({ value: 6, unit: "spx" });
    expect(parseLengthSpec("max(1spx, 2fw)")).toEqual({ value: 2, unit: "fw", bounds: { min: { value: 1, unit: "spx" } } });
    expect(parseLengthSpec("min(2fw, 6spx)")).toEqual({ value: 2, unit: "fw", bounds: { max: { value: 6, unit: "spx" } } });
    expect(formatLengthSpec(0.2, c.units!.width)).toBe("clamp(1spx, 0.3fw, 6spx)".replace("0.3", "0.2"));
  });

  it("an editing surface reads what was written, the stage reads px", () => {
    const { doc, frame, shape } = comp();
    const c = shape();
    writeProperties(c, { width: "40fw" }, 0, "base", doc);
    const baked = resolvedDocAt(doc, 0, frame.id);
    expect((clipByIdIn(baked, c.id) as ShapeClip).width).toBeCloseTo(frame.width * 0.4);
    expect((clipByIdIn(withAuthoredLengths(baked, doc), c.id) as ShapeClip).width).toBe(40);
  });
});
