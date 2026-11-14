import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES } from "@solomotion/templates";
import { parseDocument, serializeDocument } from "../io";
import { buildTemplateDocument, type TemplateSource } from "./template";
import { editPath, pathToFrame } from "../navigation";
import { landingFrameId } from "../pages";

const source = (BUILTIN_TEMPLATES as readonly TemplateSource[]).find((t) => t.id === "playground")!;

describe("Playground — the built-in starter", () => {
  it("builds every scene with its prompt card, filed on its page, from its own script", async () => {
    const { doc } = await buildTemplateDocument(source);
    expect(() => parseDocument(serializeDocument(doc))).not.toThrow();
    const names = doc.frames.map((f) => f.name);
    const scenes = names.filter((n) => /^\d\d · (?!Prompt)/.test(n));
    expect(scenes).toHaveLength(13); // 12 scenes + the cover
    expect(names.filter((n) => / · Prompt$/.test(n))).toHaveLength(13);
    // Every comp is filed on a page that exists (a world too).
    const ids = new Set(doc.pages.map((p) => p.id));
    for (const f of doc.frames) expect(ids.has(f.pageId!), f.name).toBe(true);
    const pages = doc.pages.map((p) => p.name);
    for (const p of ["★ Start here", "Type", "Styles", "UI & Hints", "Characters", "Heavy · Physics & 3D"]) expect(pages).toContain(p);
    // A scene shown on the cover's live wall keeps its own length.
    const quest = doc.frames.find((f) => f.name === "03 · Pixel Quest")!;
    expect(quest.durationMs).toBe(12000);
    // …and is still its own artboard: opening it never routes through the cover.
    expect(pathToFrame(doc, quest.id)).toEqual(editPath(quest.id));
    // It opens on the cover — the comp on screen — though the cover is built last.
    expect(landingFrameId(doc)).toBe(doc.frames.find((f) => f.name === "00 · Playground")!.id);
    // …at the instant its wall has arrived, not its empty first frame.
    expect(doc.frames.find((f) => f.name === "00 · Playground")!.playheadMs).toBe(2000);
    // Every card sits beside its scene, never on top of another comp on its page.
    for (const page of doc.pages) {
      const on = doc.frames.filter((f) => f.pageId === page.id).map((f) => [f.x, f.x + f.width] as const).sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < on.length; i++) expect(on[i]![0]).toBeGreaterThanOrEqual(on[i - 1]![1]);
    }
  }, 120_000);
});
