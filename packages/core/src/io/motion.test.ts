import { describe, expect, it } from "vitest";
import { createEmptyDocument, createTextClip, createCaptionClip, createAsset } from "../factories";
import { collectAssetIds, makeMotionManifest, motionManifestSchema } from "./motion";
import { collectFontFamilies } from "../text/font-faces";

function frameIdOf(doc: ReturnType<typeof createEmptyDocument>): string {
  return doc.frames[0]!.id;
}

describe("motion bundle contract", () => {
  it("collectAssetIds unions doc.assets with custom-sound blob ids", () => {
    const doc = createEmptyDocument();
    const img = createAsset({ kind: "image", name: "a.png", mime: "image/png", bytes: 10 });
    const vid = createAsset({ kind: "video", name: "b.mp4", mime: "video/mp4", bytes: 20 });
    doc.assets.push(img, vid);
    // A custom sound whose blob id is NOT registered in doc.assets.
    doc.customSounds.push({ id: "csnd_1", name: "pop", assetId: "asset_sound_only", hitMs: 0 });

    const ids = collectAssetIds(doc);
    expect(new Set(ids)).toEqual(new Set([img.id, vid.id, "asset_sound_only"]));
    expect(ids).toHaveLength(3);
  });

  it("collectAssetIds dedups a sound that also lives in doc.assets", () => {
    const doc = createEmptyDocument();
    const snd = createAsset({ kind: "audio", name: "s.wav", mime: "audio/wav", bytes: 5 });
    doc.assets.push(snd);
    doc.customSounds.push({ id: "csnd_1", name: "pop", assetId: snd.id, hitMs: 0 });
    expect(collectAssetIds(doc)).toEqual([snd.id]);
  });

  it("collectFontFamilies gathers text and caption families only", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    doc.tracks[0]!.clips.push(
      createTextClip({ frameId: fid, text: "hi", startMs: 0, style: { fontFamily: "Inter" } }),
      createCaptionClip({ frameId: fid, text: "cap", startMs: 0 }),
    );
    const fams = collectFontFamilies(doc);
    expect(fams.has("Inter")).toBe(true);
    // Caption's default family is present too (whatever the default is).
    expect(fams.size).toBeGreaterThanOrEqual(2);
  });

  it("makeMotionManifest sums media bytes and round-trips through the schema", () => {
    const doc = createEmptyDocument();
    const manifest = makeMotionManifest(doc, {
      ns: "studio",
      mediaIncluded: true,
      assets: [
        { id: "a1", kind: "image", name: "a.png", mime: "image/png", bytes: 100 },
        { id: "a2", kind: "audio", name: "b.wav", mime: "audio/wav", bytes: 250 },
      ],
      fonts: [{ family: "Neue Machina", fileName: "neue.otf" }],
      savedAt: 123,
    });
    expect(manifest.totalMediaBytes).toBe(350);
    expect(manifest.format).toBe("studio-motion");
    expect(manifest.mediaIncluded).toBe(true);
    // The manifest a bundle writes must validate on read.
    const parsed = motionManifestSchema.safeParse(JSON.parse(JSON.stringify(manifest)));
    expect(parsed.success).toBe(true);
  });
});
