import { describe, expect, it } from "vitest";
import { createEmptyDocument, createTextClip, createCaptionClip } from "../factories";
import { bestFace, documentFontUsage, faceKey, parseFaceStyle } from "./font-faces";
import { setKeyframe } from "../animation/keyframes";

describe("parseFaceStyle", () => {
  it("reads the named weight ladder", () => {
    expect(parseFaceStyle("Regular")).toEqual({ weight: 400, italic: false });
    expect(parseFaceStyle("Bold")).toEqual({ weight: 700, italic: false });
    expect(parseFaceStyle("Black")).toEqual({ weight: 900, italic: false });
    expect(parseFaceStyle("Thin")).toEqual({ weight: 100, italic: false });
  });

  // The substring trap: every one of these CONTAINS a shorter weight name.
  it("prefers the longest name so Semibold is not Bold", () => {
    expect(parseFaceStyle("SemiBold").weight).toBe(600);
    expect(parseFaceStyle("Demi Bold").weight).toBe(600);
    expect(parseFaceStyle("ExtraBold").weight).toBe(800);
    expect(parseFaceStyle("Ultra Light").weight).toBe(200);
    expect(parseFaceStyle("Extra-Light").weight).toBe(200);
  });

  it("reads italic and oblique, in any combination", () => {
    expect(parseFaceStyle("Bold Italic")).toEqual({ weight: 700, italic: true });
    expect(parseFaceStyle("Light Oblique")).toEqual({ weight: 300, italic: true });
    expect(parseFaceStyle("Italic")).toEqual({ weight: 400, italic: true });
  });

  it("takes a numeric weight over any name", () => {
    expect(parseFaceStyle("W700").weight).toBe(700);
    expect(parseFaceStyle("350").weight).toBe(350);
    expect(parseFaceStyle("Condensed 200 Italic")).toEqual({ weight: 200, italic: true });
  });

  it("falls back to upright regular rather than throwing", () => {
    expect(parseFaceStyle("")).toEqual({ weight: 400, italic: false });
    expect(parseFaceStyle("Condensed")).toEqual({ weight: 400, italic: false });
  });
});

describe("bestFace", () => {
  const faces = [
    { weight: 400, italic: false },
    { weight: 700, italic: false },
    { weight: 400, italic: true },
  ];

  it("matches exactly when it can", () => {
    expect(bestFace(faces, { weight: 700, italic: false })).toEqual({ weight: 700, italic: false });
    expect(bestFace(faces, { weight: 400, italic: true })).toEqual({ weight: 400, italic: true });
  });

  it("keeps the requested slant even at a worse weight", () => {
    // 700 upright is nearer in weight, but the caller asked for italic: hand
    // back the upright italic so the host slants the RIGHT shape.
    expect(bestFace(faces, { weight: 700, italic: true })).toEqual({ weight: 400, italic: true });
  });

  it("prefers heavier above 500 and lighter below 400 (CSS rule)", () => {
    const ladder = [{ weight: 300, italic: false }, { weight: 500, italic: false }, { weight: 900, italic: false }];
    expect(bestFace(ladder, { weight: 600, italic: false })!.weight).toBe(900);
    expect(bestFace(ladder, { weight: 200, italic: false })!.weight).toBe(300);
  });

  it("pairs 400 and 500 before anything else", () => {
    const ladder = [{ weight: 100, italic: false }, { weight: 500, italic: false }];
    expect(bestFace(ladder, { weight: 400, italic: false })!.weight).toBe(500);
  });

  it("always answers when there is any face at all", () => {
    expect(bestFace([{ weight: 800, italic: true }], { weight: 400, italic: false })!.weight).toBe(800);
    expect(bestFace([], { weight: 400, italic: false })).toBeNull();
  });
});

describe("documentFontUsage", () => {
  const frameId = (doc: ReturnType<typeof createEmptyDocument>) => doc.frames[0]!.id;

  it("collects the base face with the text it renders", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameId(doc), startMs: 0, text: "hello" });
    clip.style.fontFamily = "Inter";
    clip.style.fontWeight = 700;
    doc.tracks[0]!.clips.push(clip);

    expect(documentFontUsage(doc)).toEqual([
      { family: "Inter", weight: 700, italic: false, text: "hello" },
    ]);
  });

  // The bug this walk exists to end: a range (or a caption's focus word) in a
  // second family used to be invisible to the bundler, so the project shipped
  // without that font file.
  it("sees range overlays, inheriting the axes the overlay leaves alone", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameId(doc), startMs: 0, text: "hello" });
    clip.style.fontFamily = "Inter";
    clip.style.fontWeight = 700;
    clip.ranges.push({
      id: "r1",
      start: 0,
      end: 2,
      overlay: { props: { fontFamily: "Anton" }, removed: [], added: { effects: [], fills: [], strokes: [], textEffects: [] } },
      animation: null,
      sounds: {},
    });
    doc.tracks[0]!.clips.push(clip);

    const uses = documentFontUsage(doc);
    expect(uses).toHaveLength(2);
    // Weight is INHERITED — the overlay only changed the family.
    expect(uses).toContainEqual({ family: "Anton", weight: 700, italic: false, text: "hello" });
  });

  it("sees a caption's focus family", () => {
    const doc = createEmptyDocument();
    const clip = createCaptionClip({ frameId: frameId(doc), startMs: 0, text: "one two" });
    clip.style.fontFamily = "Inter";
    clip.caption!.states.focus.overlay.props.fontFamily = "Anton";
    doc.tracks[0]!.clips.push(clip);

    expect(documentFontUsage(doc).map((u) => u.family).sort()).toEqual(["Anton", "Inter"]);
  });

  // A keyframed font swap drew every key after the first in a fallback: only
  // the resting style was ever asked for.
  it("sees keyed faces — layer keys and range keys — and keyed content", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameId(doc), startMs: 0, text: "hi" });
    clip.style.fontFamily = "Inter";
    clip.style.fontWeight = 400;
    const key = (property: string, timeMs: number, value: string | number, range?: { start: number; end: number }) =>
      setKeyframe(clip.keyframes, property, timeMs, value, undefined, range ?? null);
    key("fontFamily", 0, "Inter");
    key("fontFamily", 500, "Anton");
    key("fontWeight", 0, 400);
    key("fontWeight", 500, 800);
    key("text", 0, "hi");
    key("text", 500, "مرحبا");
    key("fontFamily", 0, "Lora", { start: 0, end: 1 });
    doc.tracks[0]!.clips.push(clip);

    const faces = documentFontUsage(doc).map((u) => `${u.family} ${u.weight}`).sort();
    expect(faces).toEqual(["Anton 400", "Anton 800", "Inter 400", "Inter 800", "Lora 400", "Lora 800"]);
    expect(documentFontUsage(doc)[0]!.text).toContain("مرحبا");
  });

  it("merges the text of every clip sharing one face", () => {
    const doc = createEmptyDocument();
    for (const text of ["ab", "cd"]) {
      const clip = createTextClip({ frameId: frameId(doc), startMs: 0, text });
      clip.style.fontFamily = "Inter";
      doc.tracks[0]!.clips.push(clip);
    }
    const uses = documentFontUsage(doc);
    expect(uses).toHaveLength(1);
    expect(uses[0]!.text).toBe("abcd");
  });

  it("keeps weights apart — they are different files", () => {
    const doc = createEmptyDocument();
    for (const weight of [400, 700]) {
      const clip = createTextClip({ frameId: frameId(doc), startMs: 0, text: "x" });
      clip.style.fontFamily = "Inter";
      clip.style.fontWeight = weight;
      doc.tracks[0]!.clips.push(clip);
    }
    expect(documentFontUsage(doc)).toHaveLength(2);
  });
});

describe("faceKey", () => {
  it("is one format, and separates what a font file separates", () => {
    expect(faceKey("Inter", 700, true)).toBe("Inter|700|1");
    expect(faceKey("Inter", 400, false)).not.toBe(faceKey("Inter", 700, false));
  });
});
