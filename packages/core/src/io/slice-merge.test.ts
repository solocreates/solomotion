import { describe, expect, it } from "vitest";
import {
  createAsset,
  createEmptyDocument,
  createFrame,
  createImageClip,
  createNestedClip,
  createTextClip,
  createTrack,
} from "../factories";
import { createId } from "../ids";
import { documentSchema, type MotionDocument, type NestedClip } from "../schema";
import { mergeDocument } from "./merge";
import { sliceDocument } from "./slice";

/**
 * A source project with real cross-references: a root frame on "Page 1" holding
 * a text layer bound to a color variable and a nested INSTANCE of a component
 * ("Comp A") that lives on a second page and paints an imported image.
 */
function buildSource() {
  const doc = createEmptyDocument("Src");
  const rootFrame = doc.frames[0]!; // pageId null → Page 1
  rootFrame.name = "Root Scene"; // distinct from the target's own "Frame 1"

  const compsPage = { id: createId("page"), name: "Comps" };
  doc.pages.push(compsPage);

  const comp = createFrame({ name: "Comp A", pageId: compsPage.id });
  comp.component = { description: "reusable", setId: comp.id, variantName: "Main" };
  doc.frames.push(comp);

  const asset = createAsset({ kind: "image", name: "pic.png", mime: "image/png", bytes: 100 });
  doc.assets.push(asset);
  const compTrack = createTrack("Comp A", comp.id);
  compTrack.clips.push(createImageClip({ frameId: comp.id, assetId: asset.id, startMs: 0 }));
  doc.tracks.push(compTrack);

  const variable = { id: createId("var"), name: "Brand", type: "color" as const, value: "#ff0000" };
  doc.variables.push(variable);

  const text = createTextClip({ frameId: rootFrame.id, text: "hi", startMs: 0 });
  text.style.fontFamily = `var:${variable.id}`; // a bindable slot referencing the variable
  const nested = createNestedClip({ frameId: rootFrame.id, sourceFrameId: comp.id, startMs: 0 });
  doc.tracks[0]!.clips.push(text, nested);

  return { doc, rootFrame, comp, asset, variable, compsPage, text, nested };
}

const parses = (doc: MotionDocument) => documentSchema.safeParse(doc).success;
const allClips = (doc: MotionDocument) => doc.tracks.flatMap((t) => t.clips);

describe("sliceDocument", () => {
  it("carves a self-contained sub-document: frame + its nested comp, asset, variable, pages", () => {
    const { doc, rootFrame, comp, asset, variable } = buildSource();
    expect(parses(doc)).toBe(true);

    const slice = sliceDocument(doc, { frameIds: [rootFrame.id] }, "test");
    expect(parses(slice)).toBe(true);

    // The nested comp is pulled in WHOLE alongside the chosen frame.
    expect(slice.frames.map((f) => f.id).sort()).toEqual([rootFrame.id, comp.id].sort());
    // Its dependencies travel: the image's asset, the text's variable.
    expect(slice.assets.map((a) => a.id)).toEqual([asset.id]);
    expect(slice.variables.map((v) => v.id)).toEqual([variable.id]);
    // Both pages the frames live on come along.
    expect(slice.pages).toHaveLength(2);

    // Self-contained: every reference resolves within the slice.
    const frameIds = new Set(slice.frames.map((f) => f.id));
    for (const clip of allClips(slice)) {
      expect(frameIds.has(clip.frameId)).toBe(true);
      if (clip.kind === "nested") expect(frameIds.has(clip.sourceFrameId)).toBe(true);
    }
  });

  it("slices a single clip as a shell frame carrying only that clip", () => {
    const { doc, rootFrame, comp, text, variable } = buildSource();
    const slice = sliceDocument(doc, { clipIds: [text.id] }, "test");
    expect(parses(slice)).toBe(true);

    // Only the host frame (as a shell), not the sibling nested instance nor Comp A.
    expect(slice.frames.map((f) => f.id)).toEqual([rootFrame.id]);
    const clips = allClips(slice);
    expect(clips).toHaveLength(1);
    expect(clips[0]!.id).toBe(text.id);
    // The variable the text binds still travels; Comp A's asset does not.
    expect(slice.variables.map((v) => v.id)).toEqual([variable.id]);
    expect(slice.assets).toHaveLength(0);
    expect(slice.frames.some((f) => f.id === comp.id)).toBe(false);
  });

  it("throws when the selection resolves to no frames", () => {
    const { doc } = buildSource();
    expect(() => sliceDocument(doc, { frameIds: [] }, "test")).toThrow();
  });
});

describe("mergeDocument", () => {
  it("re-ids everything and remaps every reference on the way in", () => {
    const src = buildSource();
    const slice = sliceDocument(src.doc, { frameIds: [src.rootFrame.id] }, "test");
    const target = createEmptyDocument("Target");

    const { doc: merged, report, assetIdMap } = mergeDocument(target, slice, { ns: "test" });
    expect(parses(merged)).toBe(true);

    // No incoming node id survives — all collisions impossible by construction.
    const mergedFrameIds = merged.frames.map((f) => f.id);
    expect(mergedFrameIds).not.toContain(src.rootFrame.id);
    expect(mergedFrameIds).not.toContain(src.comp.id);
    expect(merged.assets.map((a) => a.id)).not.toContain(src.asset.id);
    expect(merged.variables.map((v) => v.id)).not.toContain(src.variable.id);

    // Every nested clip's source resolves to a real merged frame.
    const frameIds = new Set(mergedFrameIds);
    for (const clip of allClips(merged)) {
      if (clip.kind === "nested") expect(frameIds.has((clip as NestedClip).sourceFrameId)).toBe(true);
    }

    // The var token was rewritten to the NEW variable id.
    const newVarId = merged.variables.find((v) => v.name === "Brand")!.id;
    const textClip = allClips(merged).find((c) => c.kind === "text")!;
    expect(textClip.style.fontFamily).toBe(`var:${newVarId}`);
    expect(newVarId).not.toBe(src.variable.id);

    // Asset id map lets the host migrate blob bytes to the new id.
    const newAssetId = assetIdMap[src.asset.id];
    expect(newAssetId).toBeTruthy();
    expect(merged.assets.map((a) => a.id)).toContain(newAssetId);

    expect(report.framesAdded).toBe(2);
    expect(report.assetsAdded).toBe(1);
  });

  it("reports the root (top-level) imported frame, not the nested dependency", () => {
    const src = buildSource();
    const slice = sliceDocument(src.doc, { frameIds: [src.rootFrame.id] }, "test");
    const { doc: merged, rootFrameIds, newFrameIds } = mergeDocument(createEmptyDocument("T"), slice, { ns: "test" });

    expect(newFrameIds).toHaveLength(2); // root + nested comp
    expect(rootFrameIds).toHaveLength(1); // only the root scene; Comp A is nested
    const root = merged.frames.find((f) => f.id === rootFrameIds[0])!;
    expect(root.name).toBe("Root Scene");
  });

  it("merges pages by name and creates only the novel ones", () => {
    const src = buildSource();
    const slice = sliceDocument(src.doc, { frameIds: [src.rootFrame.id] }, "test");
    const target = createEmptyDocument("Target"); // has a "Page 1"

    const { doc: merged, report } = mergeDocument(target, slice, { ns: "test" });

    // "Page 1" folds into the target's existing page; "Comps" is created.
    expect(report.pagesMerged).toBe(1);
    expect(report.pagesCreated).toBe(1);
    expect(merged.pages).toHaveLength(2);

    // The re-homed root frame sits on the target's ORIGINAL Page 1.
    const rehomedRoot = merged.frames.find((f) => f.name === "Root Scene")!;
    expect(rehomedRoot.pageId).toBe(target.pages[0]!.id);
  });

  it("re-importing the same slice is idempotent — no duplicate frames, assets, or voices", () => {
    const src = buildSource();
    const slice = sliceDocument(src.doc, { frameIds: [src.rootFrame.id] }, "test");

    const once = mergeDocument(createEmptyDocument("T"), slice, { ns: "test" }).doc;
    const again = mergeDocument(once, slice, { ns: "test" });
    const twice = again.doc;
    expect(parses(twice)).toBe(true);

    // Everything matched by identity and was reused — nothing accumulated.
    expect(again.report.framesAdded).toBe(0);
    expect(again.report.framesReused).toBeGreaterThan(0);
    expect(twice.frames.length).toBe(once.frames.length);
    expect(twice.assets.length).toBe(once.assets.length);
    expect(allClips(twice).length).toBe(allClips(once).length);
    const ids = twice.frames.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length); // still no duplicate ids
  });

  it("dedup:false forces literal copies when a caller really wants them", () => {
    const src = buildSource();
    const slice = sliceDocument(src.doc, { frameIds: [src.rootFrame.id] }, "test");
    const once = mergeDocument(createEmptyDocument("T"), slice, { ns: "test" }).doc;
    const twice = mergeDocument(once, slice, { ns: "test", dedup: false }).doc;
    expect(twice.frames.length).toBe(once.frames.length + 2);
  });
});
