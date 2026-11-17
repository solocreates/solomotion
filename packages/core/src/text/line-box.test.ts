import { describe, expect, it } from "vitest";
import { FIXED_ASCENT_RATIO, lineBaseline, saneFace, type FaceMetrics } from "./line-box";
import { createEmptyDocument, createTextClip, defaultTextStyle } from "../factories";
import { parseDocument } from "../io";
import { DOCUMENT_VERSION } from "../schema/document";

const mono: FaceMetrics = { cap: 0.73, ascent: 1.02, descent: 0.3 };

describe("lineBaseline", () => {
  it("centered: the cap band's middle is the line box's middle, at any line height", () => {
    for (const lh of [0.9, 1, 1.15, 1.6]) {
      const em = 40;
      const box = em * lh;
      const baseline = lineBaseline("centered", em, box, mono);
      expect(baseline - (mono.cap * em) / 2).toBeCloseTo(box / 2, 9);
    }
  });

  it("centered, uncased script: the face's content area is centred", () => {
    const em = 40;
    const box = 60;
    const baseline = lineBaseline("centered", em, box, mono, "uncased");
    const top = baseline - mono.ascent * em;
    const bottom = baseline + mono.descent * em;
    expect(top).toBeCloseTo(box - bottom, 9);
  });

  it("fixed: the pre-v117 rule, blind to the face", () => {
    expect(lineBaseline("fixed", 40, 46, mono)).toBe(40 * FIXED_ASCENT_RATIO);
  });

  it("a face that cannot be measured falls back to a generic one", () => {
    expect(saneFace({ cap: NaN, ascent: 0, descent: -1 })).toEqual(saneFace(null));
    expect(saneFace(mono)).toEqual(mono);
  });
});

describe("v117 baseline migration", () => {
  it("new text is centered", () => {
    expect(defaultTextStyle().baseline).toBe("centered");
  });

  it("text saved before v117 keeps the fixed baseline", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: doc.frames[0]!.id, text: "hi", startMs: 0 });
    doc.tracks[0]!.clips.push(clip);
    const old = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    old.version = 116;
    const oldClip = (old.tracks as Array<{ clips: Array<{ style: Record<string, unknown> }> }>)[0]!.clips[0]!;
    delete oldClip.style.baseline;
    const migrated = parseDocument(JSON.stringify(old));
    expect(migrated.version).toBe(DOCUMENT_VERSION);
    const out = migrated.tracks[0]!.clips[0]!;
    if (out.kind !== "text") throw new Error("expected text");
    expect(out.style.baseline).toBe("fixed");
  });
});
