import { describe, expect, it } from "vitest";
import { createAsset, createAssetAudioClip, createEmptyDocument, createFrame, createImageClip, createNestedClip } from "../factories";
import { assetsUsedByFrame } from "./asset-usage";

function seeded() {
  const doc = createEmptyDocument("Test");
  const main = doc.frames[0]!;
  const inner = createFrame({ name: "Inner" });
  const other = createFrame({ name: "Other" });
  doc.frames.push(inner, other);
  const asset = (name: string, kind: "image" | "audio" = "audio") =>
    createAsset({ kind, name, mime: kind === "audio" ? "audio/wav" : "image/png", bytes: 10, width: null, height: null, durationMs: 1000 });
  const vo = asset("vo");
  const pic = asset("pic", "image");
  const hit = asset("hit");
  const nestedSfx = asset("nested");
  const elsewhere = asset("elsewhere");
  doc.assets.push(vo, pic, hit, nestedSfx, elsewhere);
  const [t1, t2, t3] = doc.tracks;
  t1!.clips.push(createAssetAudioClip({ frameId: main.id, assetId: vo.id, startMs: 0 }));
  // A hit sound's custom file lives in a field no list of "media fields" names.
  const ball = createImageClip({ frameId: main.id, assetId: pic.id, startMs: 0 });
  (ball as unknown as { sounds: unknown[] }).sounds = [{ id: "clack", custom: { assetId: hit.id } }];
  t2!.clips.push(ball, createNestedClip({ frameId: main.id, sourceFrameId: inner.id, startMs: 0 }));
  t3!.clips.push(
    createAssetAudioClip({ frameId: inner.id, assetId: nestedSfx.id, startMs: 0 }),
    createAssetAudioClip({ frameId: other.id, assetId: elsewhere.id, startMs: 0 }),
  );
  return { doc, main, other, ids: { vo: vo.id, pic: pic.id, hit: hit.id, nestedSfx: nestedSfx.id, elsewhere: elsewhere.id } };
}

describe("assetsUsedByFrame", () => {
  it("names every asset a comp's render reads — its layers, hit sounds and nested comps", () => {
    const { doc, main, ids } = seeded();
    expect(assetsUsedByFrame(doc, main.id).sort()).toEqual([ids.vo, ids.pic, ids.hit, ids.nestedSfx].sort());
  });

  it("leaves out media only another comp uses", () => {
    const { doc, other, ids } = seeded();
    expect(assetsUsedByFrame(doc, other.id)).toEqual([ids.elsewhere]);
  });

  it("survives a comp nested in itself", () => {
    const { doc, main, ids } = seeded();
    doc.tracks[0]!.clips.push(createNestedClip({ frameId: main.id, sourceFrameId: main.id, startMs: 0 }));
    expect(assetsUsedByFrame(doc, main.id)).toContain(ids.vo);
  });
});
