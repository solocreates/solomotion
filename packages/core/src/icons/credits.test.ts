import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { parseDocument, serializeDocument } from "../io";
import type { MotionDocument, IconOrigin, ShapeClip } from "../schema";
import { groupClipById, groupClips, ungroupClips } from "../timeline/groups";
import { clipProvenance, creditsText, iconCredits } from "./credits";

const LUCIDE: IconOrigin = { kind: "icon", id: "lucide:rocket", license: "ISC", author: "Lucide Contributors" };
const FLAG: IconOrigin = { kind: "icon", id: "circle-flags:ir", license: "CC-BY-4.0", author: "HatScripts" };

/** N leaves on their own lanes, each stamped with the given origin (or none). */
function leaves(doc: MotionDocument, origins: Array<IconOrigin | null>): ShapeClip[] {
  return origins.map((origin, i) => {
    const clip = createShapeClip({ frameId: doc.frames[0]!.id, shape: "rect", startMs: 0 }) as ShapeClip;
    clip.origin = origin;
    const lane = createTrack(`lane${i}`);
    lane.clips.push(clip);
    doc.tracks.push(lane);
    return clip;
  });
}

describe("provenance is derived for groups and survives every reshaping", () => {
  it("a group wrapped around one icon answers as the icon; a group of two icons answers nothing", () => {
    const doc = createEmptyDocument();
    const [a, b, c] = leaves(doc, [LUCIDE, LUCIDE, FLAG]);
    const icon = groupClipById(doc, groupClips(doc, [a!.id, b!.id])!)!;
    expect(clipProvenance(doc, icon)).toEqual(LUCIDE);

    const mixed = groupClipById(doc, groupClips(doc, [icon.id, c!.id])!)!;
    expect(clipProvenance(doc, mixed)).toBeNull();
    // The inner group still knows what it is from inside the mixed one.
    expect(clipProvenance(doc, icon)).toEqual(LUCIDE);
  });

  it("a group with one unattributed leaf did not come from anywhere", () => {
    const doc = createEmptyDocument();
    const [a, b] = leaves(doc, [LUCIDE, null]);
    const group = groupClipById(doc, groupClips(doc, [a!.id, b!.id])!)!;
    expect(clipProvenance(doc, group)).toBeNull();
  });

  it("ungrouping keeps the record on the paths, and a round trip through the file keeps it too", () => {
    const doc = createEmptyDocument();
    const [a, b] = leaves(doc, [LUCIDE, LUCIDE]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    ungroupClips(doc, [gid]);
    const back = parseDocument(serializeDocument(doc));
    const origins = back.tracks.flatMap((t) => t.clips).map((c) => c.origin);
    expect(origins).toEqual([LUCIDE, LUCIDE]);
  });
});

describe("the credits list", () => {
  it("lists each set once, each icon once, CC-BY marked as required, in a stable order", () => {
    const doc = createEmptyDocument();
    leaves(doc, [LUCIDE, LUCIDE, { ...LUCIDE, id: "lucide:house" }, FLAG, FLAG]);
    expect(iconCredits(doc)).toEqual([
      { prefix: "circle-flags", license: "CC-BY-4.0", author: "HatScripts", required: true, icons: ["ir"] },
      { prefix: "lucide", license: "ISC", author: "Lucide Contributors", required: false, icons: ["house", "rocket"] },
    ]);
  });

  it("renders as text with the required lines first and the catalogue's names when it has them", () => {
    const doc = createEmptyDocument();
    leaves(doc, [LUCIDE, FLAG]);
    const text = creditsText(iconCredits(doc), new Map([["lucide", "Lucide"]]));
    expect(text.split("\n")).toEqual([
      "Icons: circle-flags by HatScripts (CC-BY-4.0) — ir",
      "Icons: Lucide by Lucide Contributors (ISC) — rocket",
    ]);
  });

  it("is empty for a document that drew everything itself", () => {
    const doc = createEmptyDocument();
    leaves(doc, [null, null]);
    expect(iconCredits(doc)).toEqual([]);
    expect(creditsText([])).toBe("");
  });
});
