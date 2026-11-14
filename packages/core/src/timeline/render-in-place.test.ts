import { describe, expect, it } from "vitest";
import { createEmptyDocument, createGroupClip, createImageClip, createTextClip, createTrack } from "../factories";
import { clipFrameTime } from "../animation/evaluate";
import { locateClip } from "./ops";
import { applyRenderInPlace, carryContainer, isRenderedInPlace, revertRenderInPlace } from "./render-in-place";

function rendered(frameId: string) {
  return createImageClip({ frameId, assetId: "seq-1", startMs: 0, durationMs: 2000 });
}

describe("render in place — media in the slot, the original kept whole", () => {
  it("swaps in media with the original's identity and brings the original back exactly", () => {
    const doc = createEmptyDocument();
    const fid = doc.frames[0]!.id;
    const text = createTextClip({ frameId: fid, text: "hello", startMs: 500, durationMs: 2000 });
    text.linkGroupId = "grp1";
    doc.tracks[0]!.clips.push(text);

    applyRenderInPlace(doc, text.id, { rendered: rendered(fid), assetId: "seq-1", sound: null, signature: "s" });
    const now = locateClip(doc, text.id)!.clip;
    expect(now.kind).toBe("image");
    expect(now.startMs).toBe(500);
    expect(now.linkGroupId).toBe("grp1");

    // A re-render keeps the TRUE original, never a render of a render — and
    // carries the render's container onto the new media, as the app does.
    const again = rendered(fid);
    carryContainer(locateClip(doc, text.id)!.clip, again);
    const released = applyRenderInPlace(doc, text.id, { rendered: again, assetId: "seq-2", sound: null, signature: "s2" });
    expect(released).toEqual(["seq-1"]);

    const back = revertRenderInPlace(doc, text.id)!;
    expect(back).toEqual({ released: ["seq-2"], wrapped: false });
    const restored = locateClip(doc, text.id)!.clip;
    expect(restored.kind === "text" && restored.text).toBe("hello");
    expect(restored.linkGroupId).toBe("grp1");
    expect(isRenderedInPlace(doc, text.id)).toBe(false);
  });

  it("a group's rows leave with it and come back with it, shifted by any move", () => {
    const doc = createEmptyDocument();
    const fid = doc.frames[0]!.id;
    const group = createGroupClip({ frameId: fid, startMs: 0, durationMs: 2000 });
    doc.tracks[0]!.clips.push(group);
    const row = createTrack("row", fid, group.id);
    const member = createTextClip({ frameId: fid, text: "in", startMs: 100, durationMs: 1000 });
    row.clips.push(member);
    doc.tracks.push(row);

    applyRenderInPlace(doc, group.id, { rendered: rendered(fid), assetId: "seq-1", sound: null, signature: "s" });
    expect(locateClip(doc, member.id)).toBeNull();
    locateClip(doc, group.id)!.clip.startMs = 300; // moved in time only

    expect(revertRenderInPlace(doc, group.id)!.wrapped).toBe(false);
    expect(locateClip(doc, group.id)!.clip.kind).toBe("group");
    expect(locateClip(doc, member.id)!.clip.startMs).toBe(400);
  });

  it("edits made to the render come back ON the original, as its wrapper", () => {
    const doc = createEmptyDocument();
    const fid = doc.frames[0]!.id;
    const text = createTextClip({ frameId: fid, text: "hi", startMs: 0, durationMs: 2000 });
    doc.tracks[0]!.clips.push(text);
    applyRenderInPlace(doc, text.id, { rendered: rendered(fid), assetId: "seq-1", sound: null, signature: "s" });
    const r = locateClip(doc, text.id)!.clip;
    if (r.kind === "audio") throw new Error();
    r.transform.x = 80;
    r.opacity = 0.5;

    expect(revertRenderInPlace(doc, text.id)!.wrapped).toBe(true);
    const wrapper = doc.tracks.flatMap((t) => t.clips).find((c) => c.kind === "nested")!;
    expect(wrapper.kind === "nested" && wrapper.transform.x).toBe(80);
    expect(wrapper.kind === "nested" && wrapper.opacity).toBe(0.5);
    const inner = locateClip(doc, text.id)!.clip;
    expect(inner.kind === "text" && inner.transform.x).toBe(text.transform.x);
  });
});

describe("a layer's own frame rate", () => {
  it("holds each picture until the next frame of its rate, at any rate", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: doc.frames[0]!.id, text: "x", startMs: 0, durationMs: 5000 });
    expect(clipFrameTime(clip, 123)).toBe(123);
    clip.fps = 12;
    expect(clipFrameTime(clip, 100)).toBeCloseTo(83.333, 2);
    clip.fps = 1 / 3; // a picture every three seconds
    expect(clipFrameTime(clip, 2999)).toBe(0);
    expect(clipFrameTime(clip, 3000)).toBeCloseTo(3000, 6);
  });
});

describe("v79 → v80", () => {
  it("a bake whose original was deleted becomes a sequence clip inside its comp", async () => {
    const { parseDocument, serializeDocument } = await import("../io");
    const { createFrame, createNestedClip } = await import("../factories");
    const doc = createEmptyDocument();
    const inner = createFrame({ name: "inner", width: 100, height: 100 });
    doc.frames.push(inner);
    const nested = createNestedClip({ frameId: doc.frames[0]!.id, sourceFrameId: inner.id, startMs: 0, durationMs: 1000 });
    doc.tracks[0]!.clips.push(nested);
    const raw = JSON.parse(serializeDocument(doc));
    raw.version = 79;
    raw.assets = [{ id: "r1", kind: "render", name: "x (rendered)", mime: "application/x-studio-render", bytes: 1, width: 100, height: 100, durationMs: 1000, folderId: null }];
    raw.tracks[0].clips[0].bake = { assetId: "r1", signature: "s", scale: 1, wrapped: true, keptOriginal: false };
    // The upgrade mints the READING product's sequence mime; with none it refuses rather than guess.
    expect(() => parseDocument(JSON.stringify(raw))).toThrow();
    const out = parseDocument(JSON.stringify(raw), "studio");
    expect(out.assets[0]).toMatchObject({ kind: "image", mime: "image/x-studio-sequence" });
    const insideRender = out.tracks.flatMap((t) => t.clips).find((c) => c.frameId === inner.id);
    expect(insideRender).toMatchObject({ kind: "image", assetId: "r1" });
  });
});
