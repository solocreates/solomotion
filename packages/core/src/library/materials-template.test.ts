import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES } from "@solomotion/templates";
import { parseDocument, serializeDocument } from "../io";
import { buildTemplateDocument, type TemplateSource } from "./template";
import { TEXTURE_LOOKS } from "../presets/builtin-effects";
import { lookShortId } from "../presets/looks";
import { frameEffectClip } from "../timeline/frame-effects";

const source = (BUILTIN_TEMPLATES as readonly TemplateSource[]).find((t) => t.id === "materials")!;

describe("Material library — the built-in template", () => {
  it("shows the one scene in EVERY Texture look, filed by family, with a morph reel", async () => {
    const { doc } = await buildTemplateDocument(source);
    expect(() => parseDocument(serializeDocument(doc))).not.toThrow();
    const pages = doc.pages.map((p) => p.name);
    expect(pages).toEqual(["★ Start here", "Craft", "Print", "Paint & ink", "Glass, metal & fluid", "Light & screens"]);
    // Every look the app ships is in it exactly once — a new look that is
    // not filed here fails, so the library never goes stale.
    const named = new Map(TEXTURE_LOOKS.map((l) => [l.name, lookShortId(l)]));
    const shown = doc.frames.map((f) => f.name).filter((n) => named.has(n));
    expect([...shown].sort()).toEqual([...named.keys()].sort());
    // Each styled comp nests the scene and carries its look on the frame.
    const scene = doc.frames.find((f) => f.name === "Scene")!;
    for (const f of doc.frames.filter((x) => named.has(x.name))) {
      const clips = doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === f.id);
      expect(clips.some((c) => c.kind === "nested" && c.sourceFrameId === scene.id), f.name).toBe(true);
      expect(frameEffectClip(doc, f.id)?.effects.length, f.name).toBeGreaterThan(0);
    }
    // The card opens on the cover: a STILL wall of nine (a card loops its comp on hover).
    const { landingFrameId } = await import("../pages");
    const cover = doc.frames.find((f) => f.id === landingFrameId(doc))!;
    expect(cover.name).toBe("Material library");
    expect(cover.mode).toBe("static");
    expect(doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === cover.id && c.kind === "nested")).toHaveLength(9);
    const reel = doc.frames.find((f) => f.name.startsWith("Morph"))!;
    const fx = frameEffectClip(doc, reel.id)!;
    expect(fx.keyframes.some((t) => t.property.endsWith(".morph"))).toBe(true);
  }, 120_000);
});
