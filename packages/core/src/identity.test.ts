import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "./factories";
import { engineIdentity, stampedId } from "./identity";
import { frameOrigin, mergeDocument } from "./io/merge";
import { makeMotionManifest, motionManifestSchema } from "./io/motion";
import { sliceDocument } from "./io/slice";
import { SEQUENCE_MIME, isSequenceMime } from "./media/sequence";
import { isPresetBundleText, makePresetBundle, parsePresetBundle } from "./presets/bundle";
import { exportVariables, isVariableFile } from "./variables";

/**
 * Two products on one engine open each other's files. Every vendor-stamped id
 * is WRITTEN with the writer's namespace and READ for any namespace, so these
 * tests write as one product ("alpha") and read as another ("beta").
 */
describe("vendor-stamped ids cross between products", () => {
  it("writes the writer's namespace and reads any", () => {
    const id = stampedId("", "-", "motion");
    expect(id.of("alpha")).toBe("alpha-motion");
    expect(id.matches("alpha-motion")).toBe(true);
    expect(id.matches("beta-motion")).toBe(true);
    for (const bad of ["motion", "-motion", "Alpha-motion", "alpha-motion-x", "alpha.motion", "1a-motion", 7, null])
      expect(id.matches(bad)).toBe(false);
  });

  it("derives the scheme from the namespace and refuses a bad one", () => {
    expect(engineIdentity({ name: "Alpha", ns: "alpha", webOrigin: "https://a.example.com" })).toEqual({ name: "Alpha", ns: "alpha", webOrigin: "https://a.example.com", scheme: "alpha:" });
    expect(() => engineIdentity({ name: "Alpha", ns: "Alpha Cut", webOrigin: "https://a.example.com" })).toThrow();
  });

  it("a .motion manifest from one product parses in the other", () => {
    const m = makeMotionManifest(createEmptyDocument(), { ns: "alpha", mediaIncluded: false });
    expect(m.format).toBe("alpha-motion");
    expect(motionManifestSchema.safeParse(m).success).toBe(true);
    expect(motionManifestSchema.safeParse({ ...m, format: "beta-motion" }).success).toBe(true);
    expect(motionManifestSchema.safeParse({ ...m, format: "motion-ish" }).success).toBe(false);
  });

  it("a frame's origin survives a slice in one product and a merge in the other, so re-import dedups", () => {
    const src = createEmptyDocument("Src");
    src.frames[0]!.name = "Root Scene"; // not the target's own "Frame 1"
    const slice = sliceDocument(src, { frameIds: [src.frames[0]!.id] }, "alpha");
    expect(slice.frames[0]!.pluginData?.["alpha.origin"]).toBe(src.frames[0]!.id);
    const once = mergeDocument(createEmptyDocument("T"), slice, { ns: "beta" }).doc;
    const imported = once.frames.find((f) => frameOrigin(f) === src.frames[0]!.id);
    expect(imported?.pluginData?.["beta.origin"]).toBe(src.frames[0]!.id);
    const again = mergeDocument(once, slice, { ns: "beta" });
    expect(again.report.framesReused).toBe(1);
    expect(again.report.framesAdded).toBe(0);
  });

  it("a packed sequence is a sequence whoever packed it", () => {
    expect(SEQUENCE_MIME.of("alpha")).toBe("image/x-alpha-sequence");
    expect(isSequenceMime("image/x-beta-sequence")).toBe(true);
    expect(isSequenceMime("image/png")).toBe(false);
  });

  it("preset and variables files read across products", () => {
    const text = JSON.stringify(makePresetBundle([], { ns: "alpha" }));
    expect(isPresetBundleText(text)).toBe(true);
    expect(parsePresetBundle(text).format).toBe("alpha-presets");
    const vars = exportVariables(createEmptyDocument(), null, "alpha");
    expect(vars.kind).toBe("alpha.variables");
    expect(isVariableFile({ ...vars, kind: "beta.variables" })).toBe(true);
    expect(isVariableFile({ ...vars, kind: "variables" })).toBe(false);
  });
});
