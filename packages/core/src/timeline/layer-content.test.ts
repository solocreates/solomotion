import { describe, expect, it } from "vitest";
import {
  createEmptyDocument,
  createFrame,
  createNestedClip,
  createShapeClip,
  createTrack,
} from "../factories";
import { groupClipById, groupClips } from "./groups";
import { layerBlendsThrough, layerContentRefs } from "./layer-content";
import type { MotionDocument, Clip, ShapeClip } from "../schema";

/**
 * This walk decides when a CONTAINER's cached pixels have gone stale
 * (`layer-cache.ts`). A miss here does not render slowly, it renders the wrong
 * picture — the old contents of a group or a component, served forever —
 * so the cases worth pinning down are the ones where the container's own clip
 * object is provably untouched while its picture changed.
 */

const frameIdOf = (doc: MotionDocument) => doc.frames[0]!.id;
const has = (refs: unknown[], o: unknown) => refs.includes(o);
const find = (doc: MotionDocument, id: string): Clip =>
  doc.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;

function addShape(doc: MotionDocument, lane: string, frameId?: string): ShapeClip {
  const clip = createShapeClip({ frameId: frameId ?? frameIdOf(doc), shape: "rect", startMs: 0 }) as ShapeClip;
  const track = createTrack(lane);
  track.clips.push(clip);
  doc.tracks.push(track);
  return clip;
}

describe("what a container's picture is made of", () => {
  it("a leaf is only itself — its clip identity already says everything", () => {
    const doc = createEmptyDocument();
    const shape = addShape(doc, "lane");
    expect(layerContentRefs(doc, shape)).toEqual([]);
  });

  it("a group collects every member and every row carrying one", () => {
    const doc = createEmptyDocument();
    const a = addShape(doc, "a");
    const b = addShape(doc, "b");
    const gid = groupClips(doc, [a.id, b.id])!;
    const group = groupClipById(doc, gid)!;

    const refs = layerContentRefs(doc, group);
    expect(has(refs, find(doc, a.id))).toBe(true);
    expect(has(refs, find(doc, b.id))).toBe(true);
    // The row's PICTURE-BEARING FIELDS, not the row object: hiding it or
    // looping it changes what the group paints.
    const rowOfA = doc.tracks.find((t) => t.clips.some((c) => c.id === a.id))!;
    expect(has(refs, rowOfA.loop)).toBe(true);
    expect(has(refs, rowOfA.transitions)).toBe(true);
    expect(has(refs, rowOfA)).toBe(false);
  });

  it("does not change when a row is locked, renamed, recoloured or resized", () => {
    const doc = createEmptyDocument();
    const a = addShape(doc, "a");
    const b = addShape(doc, "b");
    const gid = groupClips(doc, [a.id, b.id])!;
    const group = groupClipById(doc, gid)!;
    const before = layerContentRefs(doc, group);

    // Locking a heavy background layer is what a person does to make an editor
    // FASTER. Pushing the row object meant it threw the group's pixels away.
    const row = doc.tracks.find((t) => t.clips.some((c) => c.id === a.id))!;
    row.locked = true;
    row.name = "renamed";
    row.color = "#ff0000";
    row.heightPx = 120;

    const after = layerContentRefs(doc, group);
    expect(after).toEqual(before);
  });

  it("DOES change when a row is hidden", () => {
    const doc = createEmptyDocument();
    const a = addShape(doc, "a");
    const b = addShape(doc, "b");
    const gid = groupClips(doc, [a.id, b.id])!;
    const group = groupClipById(doc, gid)!;
    const before = layerContentRefs(doc, group);

    doc.tracks.find((t) => t.clips.some((c) => c.id === a.id))!.hidden = true;
    expect(layerContentRefs(doc, group)).not.toEqual(before);
  });

  it("a nested comp collects the source frame's contents — which is what a component instance is", () => {
    const doc = createEmptyDocument();
    const source = createFrame({ name: "Comp" });
    doc.frames.push(source);
    const inner = addShape(doc, "inner", source.id);

    const nested = createNestedClip({ frameId: frameIdOf(doc), sourceFrameId: source.id, startMs: 0 });
    const lane = createTrack("host");
    lane.clips.push(nested);
    doc.tracks.push(lane);

    const refs = layerContentRefs(doc, nested);
    expect(has(refs, find(doc, inner.id))).toBe(true);
    // The frame itself: its size and background are part of the picture and
    // live on no clip.
    expect(has(refs, source)).toBe(true);
  });

  it("recurses — a group inside a component reaches the group's members", () => {
    const doc = createEmptyDocument();
    const source = createFrame({ name: "Comp" });
    doc.frames.push(source);
    const a = addShape(doc, "a", source.id);
    const b = addShape(doc, "b", source.id);
    const gid = groupClips(doc, [a.id, b.id])!;

    const nested = createNestedClip({ frameId: frameIdOf(doc), sourceFrameId: source.id, startMs: 0 });
    const lane = createTrack("host");
    lane.clips.push(nested);
    doc.tracks.push(lane);

    const refs = layerContentRefs(doc, nested);
    expect(has(refs, groupClipById(doc, gid)!)).toBe(true);
    expect(has(refs, find(doc, a.id))).toBe(true);
    expect(has(refs, find(doc, b.id))).toBe(true);
  });

  it("a comp that contains itself terminates instead of recursing forever", () => {
    const doc = createEmptyDocument();
    const source = createFrame({ name: "Comp" });
    doc.frames.push(source);

    // An instance of the comp, placed INSIDE that same comp.
    const selfRef = createNestedClip({ frameId: source.id, sourceFrameId: source.id, startMs: 0 });
    const inner = createTrack("inner");
    inner.clips.push(selfRef);
    doc.tracks.push(inner);

    const host = createNestedClip({ frameId: frameIdOf(doc), sourceFrameId: source.id, startMs: 0 });
    const lane = createTrack("host");
    lane.clips.push(host);
    doc.tracks.push(lane);

    expect(() => layerContentRefs(doc, host)).not.toThrow();
    expect(has(layerContentRefs(doc, host), selfRef)).toBe(true);
  });
});

describe("layerBlendsThrough", () => {
  const nestedOver = (background: string, clipContent: boolean | null) => {
    const doc = createEmptyDocument();
    const source = createFrame({ name: "Scene" });
    source.background = background;
    doc.frames.push(source);
    const ink = addShape(doc, "ink", source.id);
    (find(doc, ink.id) as ShapeClip).blendMode = "multiply";
    const nested = createNestedClip({ frameId: frameIdOf(doc), sourceFrameId: source.id, startMs: 0 });
    nested.clipContent = clipContent;
    const lane = createTrack("host");
    lane.clips.push(nested);
    doc.tracks.push(lane);
    return { doc, nested };
  };

  it("a multiply ink inside a transparent comp reaches the parent", () => {
    const { doc, nested } = nestedOver("#00000000", true);
    expect(layerBlendsThrough(doc, nested)).toBe(true);
  });

  it("over an opaque paper, seen through its window, it blends with the paper alone", () => {
    const { doc, nested } = nestedOver("#F4EEDF", true);
    expect(layerBlendsThrough(doc, nested)).toBe(false);
  });

  it("an opaque comp that spills past its box still blends through outside it", () => {
    const { doc, nested } = nestedOver("#F4EEDF", false);
    expect(layerBlendsThrough(doc, nested)).toBe(true);
  });
});
