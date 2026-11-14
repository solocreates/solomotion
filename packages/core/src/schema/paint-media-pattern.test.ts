import { describe, expect, it } from "vitest";
import {
  isGradientPaint,
  mediaPaint,
  paintColors,
  paintSchema,
  patternPaint,
  solidPaint,
} from "./vector";
import { createEmptyDocument, createImageClip, createTrack, createVideoClip } from "../factories";
import { parseDocument, serializeDocument } from "../io";

describe("media + pattern paints (v42)", () => {
  it("parses a media paint, applying defaults", () => {
    const p = paintSchema.parse({ id: "p1", type: "media", source: { type: "asset", assetId: "a1" } });
    expect(p.type).toBe("media");
    if (p.type !== "media") throw new Error("type");
    expect(p.fit).toBe("cover");
    expect(p.focus).toEqual({ x: 0.5, y: 0.5 });
    expect(p.tileScale).toBe(1);
    expect(p.opacity).toBe(1);
    expect(p.blendMode).toBe("normal");
  });

  it("parses a pattern paint, applying stripe defaults", () => {
    const p = paintSchema.parse({ id: "p2", type: "pattern", pattern: { kind: "stripes" } });
    if (p.type !== "pattern") throw new Error("type");
    expect(p.pattern.kind).toBe("stripes");
    expect(p.pattern.spacing).toBe(20);
    expect(p.pattern.thickness).toBe(10);
    expect(p.pattern.color).toBe("#1E1E1E");
  });

  it("constructors stamp ids + sane defaults", () => {
    const m = mediaPaint();
    expect(m.type).toBe("media");
    if (m.type === "media") expect(m.source).toEqual({ type: "self" });
    const pat = patternPaint();
    expect(pat.type).toBe("pattern");
    expect(m.id).not.toBe(pat.id);
  });

  it("isGradientPaint excludes solid, media and pattern", () => {
    expect(isGradientPaint(solidPaint("#fff"))).toBe(false);
    expect(isGradientPaint(mediaPaint())).toBe(false);
    expect(isGradientPaint(patternPaint())).toBe(false);
  });

  it("paintColors: pattern reports its colors, media reports none", () => {
    expect(paintColors(patternPaint())).toEqual(["#1E1E1E", "#FFFFFF"]);
    expect(paintColors(mediaPaint())).toEqual([]);
  });
});

describe("media clips carry a self fill", () => {
  it("new image/video clips seed a self media fill as fill #0", () => {
    const img = createImageClip({ frameId: "f1", assetId: "a1", startMs: 0 });
    expect(img.fills[0]).toMatchObject({ type: "media", source: { type: "self" } });
    const vid = createVideoClip({ frameId: "f1", assetId: "a2", startMs: 0 });
    expect(vid.fills[0]).toMatchObject({ type: "media", source: { type: "self" } });
  });

  it("heals a legacy media clip (no self fill) on load", () => {
    const doc = createEmptyDocument("t");
    const track = createTrack("v", doc.frames[0]!.id);
    const img = createImageClip({ frameId: doc.frames[0]!.id, assetId: "a1", startMs: 0 });
    // Simulate a pre-v42 document: footage was NOT a fill.
    img.fills = [];
    track.clips.push(img);
    doc.tracks.push(track);

    const loaded = parseDocument(serializeDocument(doc));
    const clip = loaded.tracks.flatMap((t) => t.clips).find((c) => c.kind === "image");
    if (!clip || clip.kind !== "image") throw new Error("image clip missing");
    expect(clip.fills[0]).toMatchObject({ type: "media", source: { type: "self" } });
  });

  it("migrates a pre-v40 numeric borderRadius to per-corner", () => {
    const doc = createEmptyDocument("t");
    const track = createTrack("v", doc.frames[0]!.id);
    const img = createImageClip({ frameId: doc.frames[0]!.id, assetId: "a1", startMs: 0 });
    track.clips.push(img);
    doc.tracks.push(track);

    // Simulate an old document: version 39 with a scalar borderRadius.
    const raw = JSON.parse(serializeDocument(doc)) as {
      version: number;
      tracks: Array<{ clips: Array<Record<string, unknown>> }>;
    };
    raw.version = 39;
    for (const t of raw.tracks) for (const c of t.clips) if (c.kind === "image") c.borderRadius = 12;

    const loaded = parseDocument(JSON.stringify(raw));
    const clip = loaded.tracks.flatMap((t) => t.clips).find((c) => c.kind === "image");
    if (!clip || clip.kind !== "image") throw new Error("image clip missing");
    expect(clip.borderRadius).toEqual({ tl: 12, tr: 12, br: 12, bl: 12 });
  });

  it("does not double-seed a clip that already has a self fill", () => {
    const doc = createEmptyDocument("t");
    const track = createTrack("v", doc.frames[0]!.id);
    const img = createImageClip({ frameId: doc.frames[0]!.id, assetId: "a1", startMs: 0 });
    track.clips.push(img);
    doc.tracks.push(track);

    const loaded = parseDocument(serializeDocument(doc));
    const clip = loaded.tracks.flatMap((t) => t.clips).find((c) => c.kind === "image");
    if (!clip || clip.kind !== "image") throw new Error("image clip missing");
    const selfFills = clip.fills.filter((f) => f.type === "media" && f.source.type === "self");
    expect(selfFills).toHaveLength(1);
  });
});
