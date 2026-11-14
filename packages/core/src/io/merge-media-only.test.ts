import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "../factories";
import { mergeDocument } from "./merge";
import type { MotionDocument } from "../schema";

describe("mergeDocument with media only", () => {
  it("brings media in with no pages or comps (project.import media)", () => {
    const target = createEmptyDocument("Here");
    const source = createEmptyDocument("There");
    const asset = { id: "asset_src1", kind: "image", name: "logo.png", mime: "image/png", bytes: 1200, width: 64, height: 64 } as unknown as MotionDocument["assets"][number];
    const shell: MotionDocument = { ...source, pages: [], frames: [], tracks: [], variables: [], expressions: [], markers: [], trackers: [], customSounds: [], mediaFolders: [], assets: [asset] };
    const { doc, assetIdMap, rootFrameIds } = mergeDocument(target, shell, { ns: "test" });
    expect(rootFrameIds).toEqual([]);
    expect(doc.frames).toHaveLength(target.frames.length);
    expect(doc.assets.map((a) => a.name)).toContain("logo.png");
    expect(assetIdMap["asset_src1"]).toBeTruthy();
    // Twice: the same file is reused, not added again.
    const again = mergeDocument(doc, shell, { ns: "test" });
    expect(again.doc.assets.filter((a) => a.name === "logo.png")).toHaveLength(1);
  });
});
