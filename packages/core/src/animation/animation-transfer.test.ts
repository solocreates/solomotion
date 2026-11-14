import { describe, expect, it } from "vitest";
import { createEmptyDocument, createPathClip, createTextClip } from "../factories";
import { layerPresetsFor, layerSpecFromPreset } from "./layer-animation";
import { specFromPreset } from "./presets";
import { captureLayerAnimation, captureTextAnimation, parseAnimationCapture, toLayerAnimation, toTextAnimation } from "./animation-transfer";

const pt = (x: number, y: number) => ({ x, y, hIn: null, hOut: null });

describe("an animation copied from one edge lands on another", () => {
  it("layer → layer keeps the tuning, and refuses a preset the destination cannot draw", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const path = createPathClip({ frameId, subpaths: [{ closed: false, points: [pt(0, 0), pt(10, 0)] }], startMs: 0 });
    const text = createTextClip({ frameId, text: "hi", startMs: 0 });
    const draw = { ...layerSpecFromPreset("draw"), durationMs: 1234 };
    draw.params.order = 2;
    const cap = captureLayerAnimation(draw);
    const onPath = toLayerAnimation(cap, layerPresetsFor(doc, path))!;
    expect(onPath.durationMs).toBe(1234);
    expect(onPath.params.order).toBe(2);
    // A text layer has no outline; the draw-on is not offered there.
    expect(toLayerAnimation(cap, layerPresetsFor(doc, text))).toBeNull();
  });

  it("text ↔ layer crosses grains, carrying the rhythm only where it means something", () => {
    const glyph = specFromPreset("fade-up");
    glyph.staggerMs = 77;
    glyph.durationMs = 400;
    const cap = captureTextAnimation(glyph);
    const asLayer = toLayerAnimation(cap, [{ id: "fade-up" }] as never)!;
    expect(asLayer.durationMs).toBe(400);
    expect("staggerMs" in asLayer).toBe(false);
    // Back to text: the rhythm survived the round trip through the capture.
    const back = toTextAnimation(cap)!;
    expect(back.staggerMs).toBe(77);
    // A layer copy has no rhythm; a text paste takes the preset's defaults.
    const fromLayer = toTextAnimation(captureLayerAnimation(layerSpecFromPreset("fade-up")))!;
    expect(fromLayer.staggerMs).toBe(specFromPreset("fade-up").staggerMs);
    // A layer-only preset cannot become glyph motion.
    expect(toTextAnimation(captureLayerAnimation(layerSpecFromPreset("draw")))).toBeNull();
  });

  it("survives the clipboard as JSON, and rejects what is not a capture", () => {
    const cap = captureLayerAnimation(layerSpecFromPreset("fade"));
    expect(parseAnimationCapture(JSON.parse(JSON.stringify(cap)))).toEqual(cap);
    expect(parseAnimationCapture({ kind: "animation" })).toBeNull();
    expect(parseAnimationCapture("fade")).toBeNull();
  });
});
