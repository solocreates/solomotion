import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip } from "../factories";
import { createLayerEffect } from "../animation/layer-effects";
import type { LayerEffect, ShapeClip } from "../schema";
import { PreviewPacer, effectPreviewLoopMs, loopFrameCount, previewStack } from "./effect-preview";
import { stackPrefixAt, stackPrefixUnchanged, steadyStackPrefix } from "./picture-steady";

const doc = createEmptyDocument();
const withFx = (...effects: LayerEffect[]): ShapeClip =>
  ({ ...(createShapeClip({ frameId: doc.frames[0]!.id, shape: "rect", startMs: 0 }) as ShapeClip), effects });

describe("previewStack", () => {
  const [a, b, c] = [createLayerEffect("shadow"), createLayerEffect("grain"), createLayerEffect("glow")];
  const fx = [a, b, c];
  it("runs the stack up to the card, the card alone, or all of it — keeping the card objects", () => {
    expect(previewStack(fx, b.id, "through")).toEqual([a, b]);
    expect(previewStack(fx, b.id, "through")[0]).toBe(a);
    expect(previewStack(fx, b.id, "solo")).toEqual([b]);
    expect(previewStack(fx, b.id, "all")).toBe(fx);
    expect(previewStack(fx, c.id, "through")).toBe(fx);
  });
  it("leaves a stack that does not hold the card alone", () => {
    expect(previewStack(fx, "glyph-card", "solo")).toBe(fx);
  });
});

describe("effectPreviewLoopMs", () => {
  it("loops a sweep on its own period, a random card on a fixed one", () => {
    const shine = { ...createLayerEffect("shine"), duration: 1.6, delay: 0.4, loop: true } as LayerEffect;
    expect(effectPreviewLoopMs(shine)).toBe(2000);
    expect(effectPreviewLoopMs({ ...shine, loop: false } as LayerEffect)).toBe(2600);
    expect(effectPreviewLoopMs(createLayerEffect("grain"))).toBe(2000);
    expect(effectPreviewLoopMs({ ...shine, duration: 60 } as LayerEffect)).toBe(6000);
    expect(loopFrameCount(2000, 1000 / 24)).toBe(48);
  });
});

describe("PreviewPacer", () => {
  it("never paces a cheap render and spaces an expensive one by the duty", () => {
    const p = new PreviewPacer();
    p.note(0, 2);
    expect(p.mayRender(2)).toBe(true);
    const q = new PreviewPacer();
    q.note(0, 70);
    expect(q.mayRender(100)).toBe(false);
    expect(q.mayRender(70 + 70 * (1 / 0.35 - 1))).toBe(true);
  });
  it("calls a card heavy only once it has been measured twice over a frame", () => {
    const p = new PreviewPacer();
    p.note(0, 90);
    expect(p.heavy(41)).toBe(false);
    p.note(100, 190);
    expect(p.heavy(41)).toBe(true);
    p.reset();
    expect(p.heavy(41)).toBe(false);
  });
  it("lets a slow card with few pictures play — its whole loop builds in moments", () => {
    const p = new PreviewPacer();
    p.note(0, 80);
    p.note(100, 180);
    expect(p.heavy(33, 3)).toBe(false); // 3 × 80ms: a quarter second, then memory
    expect(p.heavy(33, 60)).toBe(true);
  });
});

describe("the stack split at a card", () => {
  const grade = createLayerEffect("blur");
  const grain = createLayerEffect("grain");
  const glow = createLayerEffect("glow");
  it("pins a prefix beneath the edited card, moving or not", () => {
    const clip = withFx(grain, grade, glow);
    expect(stackPrefixAt(doc, clip, 500, 2)).toMatchObject({ count: 2 });
    expect(stackPrefixAt(doc, clip, 500, 0)).toBeNull();
    // The natural split stops at the first moving card: nothing beneath grain.
    expect(steadyStackPrefix(doc, clip, 500)).toBeNull();
  });
  it("refuses a prefix that reads the backdrop", () => {
    const clip = withFx(createLayerEffect("glass"), glow);
    expect(stackPrefixAt(doc, clip, 0, 1)).toBeNull();
  });
  it("survives an edit to a card above it and nothing else", () => {
    const clip = withFx(grade, grain, glow);
    const tuned = { ...clip, effects: [grade, grain, { ...glow, enabled: false }] };
    expect(stackPrefixUnchanged(clip, tuned, 2)).toBe(true);
    expect(stackPrefixUnchanged(clip, tuned, 3)).toBe(false);
    const keyedAbove = { ...tuned, keyframes: [{ id: "k", property: `lfx.${glow.id}.intensity`, range: null, keys: [] }] };
    expect(stackPrefixUnchanged(clip, keyedAbove, 2)).toBe(true);
    const keyedBelow = { ...tuned, keyframes: [{ id: "k", property: `lfx.${grade.id}.radius`, range: null, keys: [] }] };
    expect(stackPrefixUnchanged(clip, keyedBelow, 2)).toBe(false);
    const moved = { ...tuned, transform: { ...clip.transform, x: 40 } };
    expect(stackPrefixUnchanged(clip, moved, 2)).toBe(false);
  });
});
