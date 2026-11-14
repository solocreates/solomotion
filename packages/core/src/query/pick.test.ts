import { describe, expect, it } from "vitest";
import type { ShapeClip } from "../schema";
import { createAssetAudioClip, createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { createRig } from "../rig/ops";
import { createLayerEffect } from "../animation/layer-effects";
import { getClipProperty } from "../animation/paths";
import { gradeSlots } from "../grade/paths";
import { clipLookup } from "../timeline/frame-index";
import { resolvedDocAt } from "../evaluate/resolved-doc";
import { checkProgram } from "../expressions/check";
import { parseExpression } from "../expressions/parser";
import { layerPropertyIndex } from "../expressions/layer-api";
import { makeLayerApi } from "../evaluate/expr-context";
import { linkPropertyTo, propertyReadSource } from "../expressions/link";
import { searchDocNodes } from "./doc-index";
import { assignability } from "../expressions/types";
import {
  parsePropertyPickKey,
  pickAccepts,
  pickCandidates,
  pickKindOfKey,
  propertyPickKey,
  registerPickProvider,
  resolvePick,
  type PickCandidate,
} from "./pick";
import "./pick-providers";

function project() {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const rigId = createRig(doc, frameId, { name: "Pip", bones: [{ head: [0, 0], tail: [0, -100], name: "Torso" }] })!;
  const inner = createTrack("Mouth");
  inner.groupId = rigId;
  const mouth = createShapeClip({ frameId, shape: "ellipse", startMs: 0, durationMs: 4000, x: 0, y: 0, width: 40, height: 20 }) as ShapeClip;
  mouth.name = "Mouth";
  inner.clips.push(mouth);
  const lead = createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 4000, x: 0, y: 0, width: 40, height: 20 }) as ShapeClip;
  lead.name = "Lead";
  const blur = createLayerEffect("blur");
  const grade = createLayerEffect("grade");
  lead.effects = [blur, grade];
  const shapes = createTrack("Shapes");
  shapes.clips.push(lead);
  const voices = createTrack("Voices");
  const hello = createAssetAudioClip({ frameId, assetId: "a1", startMs: 1000, durationMs: 2000 });
  hello.name = "Hello line";
  const later = createAssetAudioClip({ frameId, assetId: "a2", startMs: 5000, durationMs: 1000 });
  later.name = "Goodbye";
  voices.clips.push(hello, later);
  doc.tracks.push(inner, shapes, voices);
  return { doc, frameId, rigId, mouth, lead, blur, grade, hello, later };
}

const ids = (cs: readonly PickCandidate[]) => cs.map((c) => c.id);

describe("the pick registry — what a field may point at, as data", () => {
  it("answers layer questions: voices in a comp, playing now, parts of a character, not me", () => {
    const p = project();
    const voices = pickCandidates(p.doc, { kinds: ["layer"], frameId: p.frameId, tags: ["voice"] });
    expect(voices.map((n) => n.name)).toEqual(["Hello line", "Goodbye"]);
    expect(ids(pickCandidates(p.doc, { kinds: ["layer"], tags: ["voice"], atMs: 1500 }))).toEqual([p.hello.id]);
    expect(ids(pickCandidates(p.doc, { kinds: ["layer"], within: p.rigId }))).toEqual([p.mouth.id]);
    expect(ids(pickCandidates(p.doc, { kinds: ["layer"], tags: ["voice"], exclude: [p.hello.id] }))).toEqual([p.later.id]);
    // Capabilities ride the doc index's tags.
    const audible = pickCandidates(p.doc, { kinds: ["layer"], tags: ["audible"] });
    expect(audible.every((c) => c.clip?.kind === "audio")).toBe(true);
    expect(ids(pickCandidates(p.doc, { kinds: ["layer"], tags: ["visual"], exclude: [p.rigId] }))).toEqual([p.mouth.id, p.lead.id]);
  });

  it("uses ONE predicate for the list and for the thing under the pointer", () => {
    const p = project();
    const filter = { kinds: ["layer"], tags: ["visual"], exclude: [p.lead.id] } as const;
    const listed = new Set(pickCandidates(p.doc, filter).map((c) => c.key));
    for (const c of pickCandidates(p.doc, { kinds: ["layer"] })) {
      expect(pickAccepts(p.doc, filter, c.key)).toBe(listed.has(c.key));
    }
    expect(pickAccepts(p.doc, filter, "clip:nope")).toBe(false);
  });

  it("lists every animatable value of a layer — effect fields and grade slots included — typed", () => {
    const p = project();
    const props = pickCandidates(p.doc, { kinds: ["property"], ofLayers: [p.lead.id] });
    const paths = props.map((c) => c.path);
    expect(paths).toContain("rotation");
    expect(paths).toContain(`lfx.${p.blur.id}.radius`);
    const slot = p.grade.type === "grade" ? gradeSlots(p.grade.graph)[0] : undefined;
    if (slot) expect(paths).toContain(`lfx.${p.grade.id}.${slot.suffix}`);
    // `fits` drops what cannot land in the field — by the checker's own rule.
    const text = pickCandidates(p.doc, { kinds: ["property"], ofLayers: [p.lead.id], fits: "vec2" });
    expect(text.every((c) => !c.type || assignability(c.type, "vec2") !== "none")).toBe(true);
    expect(text.length).toBeLessThan(props.length);
    // A property key round-trips, and names its owner.
    const key = propertyPickKey(p.lead.id, `lfx.${p.blur.id}.radius`);
    expect(parsePropertyPickKey(key)).toEqual({ clipId: p.lead.id, path: `lfx.${p.blur.id}.radius` });
    expect(resolvePick(p.doc, key)?.ownerId).toBe(p.lead.id);
    // Excluding a layer excludes its values: a field never links to itself.
    expect(pickCandidates(p.doc, { kinds: ["property"], frameId: p.frameId, exclude: [p.lead.id] }).some((c) => c.ownerId === p.lead.id)).toBe(false);
  });

  it("searches with the doc index's ranking", () => {
    const p = project();
    const layers = pickCandidates(p.doc, { kinds: ["layer"] });
    expect(searchDocNodes(layers, "good")[0]!.name).toBe("Goodbye");
    expect(searchDocNodes(layers, "zzz")).toEqual([]);
  });

  it("takes a foreign kind with ONE register call — the tracker seam", () => {
    const p = project();
    // `tracker:` is reserved: it parses before anything provides it, reads as
    // broken, and nobody else may take the prefix.
    expect(pickKindOfKey("tracker:t1")).toBe("tracker");
    expect(resolvePick(p.doc, "tracker:t1")).toBeNull();
    expect(() => registerPickProvider({ kind: "imposter", prefix: "tracker", noun: "x", candidates: () => [], resolve: () => null })).toThrow();

    const fake: PickCandidate = { key: "tracker:t1", kind: "tracker", id: "t1", name: "Eye", where: "Point tracker", tags: ["point"], hay: "eye point tracker", frameId: p.frameId, pageId: null, glyph: "tracker" };
    const off = registerPickProvider({
      kind: "tracker",
      prefix: "tracker",
      noun: "tracker",
      candidates: () => [fake],
      resolve: (_doc, id) => (id === "t1" ? fake : null),
    });
    try {
      expect(ids(pickCandidates(p.doc, { kinds: ["layer", "tracker"], frameId: p.frameId, tags: ["point"] }))).toEqual(["t1"]);
      expect(resolvePick(p.doc, "tracker:t1")?.name).toBe("Eye");
      expect(pickAccepts(p.doc, { kinds: ["tracker"], frameId: p.frameId }, "tracker:t1")).toBe(true);
      expect(pickAccepts(p.doc, { kinds: ["layer"] }, "tracker:t1")).toBe(false);
    } finally {
      off();
    }
    expect(resolvePick(p.doc, "tracker:t1")).toBeNull();
  });
});

describe("link anything to anything — an ordinary expression", () => {
  it("drives a property from another layer's EFFECT field, through the real bake", () => {
    const p = project();
    const radius = `lfx.${p.blur.id}.radius`;
    if (p.blur.type === "blur") p.blur.radius = 17;
    const id = linkPropertyTo(p.doc, p.mouth.id, "rotation", p.lead.id, radius);
    expect(id).not.toBeNull();
    const baked = clipLookup(resolvedDocAt(structuredClone(p.doc), 500, p.frameId));
    expect(getClipProperty(baked(p.mouth.id)!, "rotation")).toBe(17);
    // Re-linking the same path rewrites its expression instead of adding one.
    const again = linkPropertyTo(p.doc, p.mouth.id, "rotation", p.lead.id, "x");
    expect(again).toBe(id);
    expect(p.doc.expressions).toHaveLength(1);
  });

  it("names the layer by KEY, so a rename (or a twin) cannot retarget it", () => {
    const p = project();
    linkPropertyTo(p.doc, p.mouth.id, "opacity", p.lead.id, "opacity");
    p.lead.opacity = 0.25;
    // A second layer takes the name, and the original is renamed.
    const twin = createShapeClip({ frameId: p.frameId, shape: "rect", startMs: 0, durationMs: 4000, x: 0, y: 0, width: 4, height: 4 }) as ShapeClip;
    twin.name = "Lead";
    twin.opacity = 0.9;
    p.doc.tracks[1]!.clips.push(twin);
    p.lead.name = "Renamed";
    const baked = clipLookup(resolvedDocAt(structuredClone(p.doc), 500, p.frameId));
    expect(getClipProperty(baked(p.mouth.id)!, "opacity")).toBe(0.25);
  });

  it("checks a keyed reference against that layer's real surface", () => {
    const p = project();
    const api = makeLayerApi(p.doc, p.frameId, 0);
    const byName = (name: string) => {
      const id = api.idFor(name);
      return id ? layerPropertyIndex(api.propertiesOf(id)) : undefined;
    };
    const ok = checkProgram(parseExpression(propertyReadSource(p.lead.id, "rotation")), { variables: [], expect: "float", layerPropertiesByName: byName });
    expect(ok.diagnostics).toEqual([]);
    const typo = checkProgram(parseExpression(`${propertyReadSource(p.lead.id, "rotation")}x`), { variables: [], expect: "float", layerPropertiesByName: byName });
    expect(typo.diagnostics[0]?.message).toContain("rotation");
    // A path segment that is not a name falls back to the direct-read form.
    expect(propertyReadSource("c1", "fill.9a.color")).toBe('layer("clip:c1", "fill.9a.color")');
  });
});
