import { describe, expect, it } from "vitest";
import {
  addEffect,
  addGradientStop,
  addPaint,
  createShapeClip,
  gradientPaint,
  isGradientPaint,
  removeEffect,
  removeGradientStop,
  removePaint,
  setPaintType,
  solidPaint,
  strokeStyle,
  type Clip,
  type GradientPaint,
  type KeyframeTrack,
  type Paint,
} from "..";

/** A shape clip with known-id fills/strokes/effects/keyframes for path assertions. */
function fixture(over: {
  fills?: Paint[];
  keyframes?: KeyframeTrack[];
  effects?: Clip extends { effects: infer E } ? E : never;
} = {}): Clip {
  const base = createShapeClip({ frameId: "f", startMs: 0, shape: "rect" });
  return {
    ...base,
    fills: over.fills ?? [{ ...solidPaint("#ff0000"), id: "f1" }],
    strokes: [{ ...strokeStyle(solidPaint("#000000")), id: "s1" }],
    effects: over.effects ?? [],
    keyframes: over.keyframes ?? [],
  } as Clip;
}

const track = (property: string): KeyframeTrack => ({ id: `k:${property}`, property, range: null, keys: [] });
const paintOf = (clip: Clip, id: string) =>
  (clip as { fills: Paint[] }).fills.find((f) => f.id === id) as Paint;

describe("paint list add/remove", () => {
  it("appends a fill and a stroke", () => {
    const clip = fixture();
    expect((addPaint(clip, "fill") as { fills: Paint[] }).fills).toHaveLength(2);
    expect((addPaint(clip, "stroke") as { strokes: unknown[] }).strokes).toHaveLength(2);
  });

  it("removes a fill and prunes its keyframe tracks", () => {
    const clip = fixture({ keyframes: [track("fill.f1"), track("fill.f1.opacity"), track("opacity")] });
    const next = removePaint(clip, "fill", "f1") as { fills: Paint[]; keyframes: KeyframeTrack[] };
    expect(next.fills).toHaveLength(0);
    // the clip-wide opacity track survives; both fill.f1 tracks are gone
    expect(next.keyframes.map((t) => t.property)).toEqual(["opacity"]);
  });
});

describe("setPaintType", () => {
  it("solid → linear seeds two stops, preserves id/opacity, drops the stale color track", () => {
    const clip = fixture({
      fills: [{ ...solidPaint("#ff0000"), id: "f1", opacity: 0.5 }],
      keyframes: [track("fill.f1"), track("fill.f1.opacity")],
    });
    const next = setPaintType(clip, "fill", "f1", "linear") as { fills: Paint[]; keyframes: KeyframeTrack[] };
    const p = next.fills[0] as GradientPaint;
    expect(isGradientPaint(p)).toBe(true);
    expect(p.id).toBe("f1");
    expect(p.opacity).toBe(0.5);
    expect(p.stops).toHaveLength(2);
    // `fill.f1` (solid color) is no longer a valid path → pruned; opacity survives
    expect(next.keyframes.map((t) => t.property)).toEqual(["fill.f1.opacity"]);
  });

  it("gradient → solid migrates the first stop color and drops stop tracks", () => {
    const grad = { ...(gradientPaint("linear", [
      { id: "a", offset: 0, color: "#112233" },
      { id: "b", offset: 1, color: "#000000" },
    ]) as GradientPaint), id: "f1" };
    const clip = fixture({
      fills: [grad],
      keyframes: [track("fill.f1.stop.a.color"), track("fill.f1.opacity")],
    });
    const next = setPaintType(clip, "fill", "f1", "solid") as { fills: Paint[]; keyframes: KeyframeTrack[] };
    const p = paintOf(next as Clip, "f1");
    expect(p.type).toBe("solid");
    expect((p as { color: string }).color).toBe("#112233");
    expect(next.keyframes.map((t) => t.property)).toEqual(["fill.f1.opacity"]);
  });

  it("gradient → gradient keeps stops and geometry, only flips the sub-type", () => {
    const grad = { ...(gradientPaint("linear", [
      { id: "a", offset: 0, color: "#fff" },
      { id: "b", offset: 1, color: "#000" },
    ]) as GradientPaint), id: "f1" };
    const next = setPaintType(fixture({ fills: [grad] }), "fill", "f1", "radial");
    const p = paintOf(next, "f1") as GradientPaint;
    expect(p.type).toBe("radial");
    expect(p.stops).toHaveLength(2);
    expect(p.stops[0]!.id).toBe("a");
  });
});

describe("effects", () => {
  it("adds an effect from the registry", () => {
    const next = addEffect(fixture(), "blur") as { effects: { type: string }[] };
    expect(next.effects).toHaveLength(1);
    expect(next.effects[0]!.type).toBe("blur");
  });

  it("removes an effect and prunes its keyframe tracks", () => {
    const clip = fixture({ keyframes: [track("lfx.e1.radius"), track("opacity")] });
    const withEffect = { ...(clip as object), effects: [{ id: "e1", type: "blur", enabled: true, radius: 8 }] } as Clip;
    const next = removeEffect(withEffect, "e1") as { effects: unknown[]; keyframes: KeyframeTrack[] };
    expect(next.effects).toHaveLength(0);
    expect(next.keyframes.map((t) => t.property)).toEqual(["opacity"]);
  });
});

describe("gradient stops", () => {
  const gradFixture = () =>
    fixture({
      fills: [{ ...(gradientPaint("linear", [
        { id: "a", offset: 0, color: "#000000" },
        { id: "b", offset: 1, color: "#ffffff" },
      ]) as GradientPaint), id: "f1" }],
    });

  it("inserts a stop sorted by offset", () => {
    const next = addGradientStop(gradFixture(), "fill", "f1", 0.5);
    const p = paintOf(next, "f1") as GradientPaint;
    expect(p.stops.map((s) => s.offset)).toEqual([0, 0.5, 1]);
  });

  it("refuses to drop below two stops", () => {
    const next = removeGradientStop(gradFixture(), "fill", "f1", "a");
    expect((paintOf(next, "f1") as GradientPaint).stops).toHaveLength(2);
  });

  it("removes a stop above the minimum and prunes its tracks", () => {
    const three = addGradientStop(gradFixture(), "fill", "f1", 0.5);
    const midId = (paintOf(three, "f1") as GradientPaint).stops[1]!.id;
    const withKf = { ...(three as object), keyframes: [track(`fill.f1.stop.${midId}.color`), track("opacity")] } as Clip;
    const next = removeGradientStop(withKf, "fill", "f1", midId) as { fills: Paint[]; keyframes: KeyframeTrack[] };
    expect((next.fills[0] as GradientPaint).stops).toHaveLength(2);
    expect(next.keyframes.map((t) => t.property)).toEqual(["opacity"]);
  });
});
