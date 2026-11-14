import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { groupClipById, groupClips } from "./groups";
import { editScopeClipIds, partitionScene } from "./scene-partition";
import { editPath } from "../navigation/path";
import type { MotionDocument, ShapeClip } from "../schema";

/**
 * The partition decides what the stage is allowed to NOT re-render. A wrong
 * `null` costs speed; a wrong partition shows a stale picture, so the refusals
 * are what these tests are mostly about.
 */

const frameIdOf = (doc: MotionDocument) => doc.frames[0]!.id;

/** Lanes are pushed in order; later lanes paint ON TOP (paint order reverses). */
function stack(doc: MotionDocument, n: number): ShapeClip[] {
  const out: ShapeClip[] = [];
  for (let i = 0; i < n; i++) {
    const clip = createShapeClip({ frameId: frameIdOf(doc), shape: "rect", startMs: 0 }) as ShapeClip;
    const lane = createTrack(`lane${i}`);
    lane.clips.push(clip);
    doc.tracks.push(lane);
    out.push(clip);
  }
  return out;
}

describe("cutting the scene around what is changing", () => {
  it("puts everything painted before the change below it and everything after above", () => {
    const doc = createEmptyDocument();
    const [a, b, c] = stack(doc, 3);
    const p = partitionScene(doc, doc.frames, new Set([b!.id]))!;

    expect(p).not.toBeNull();
    expect(p.changing.has(b!.id)).toBe(true);
    // One of the two is below and the other above — which way round depends on
    // paint order, and the point is that neither is in the changing run.
    expect(p.below.has(b!.id)).toBe(false);
    expect(p.above.has(b!.id)).toBe(false);
    expect(p.below.size + p.above.size).toBe(2);
    expect(p.below.has(a!.id) || p.above.has(a!.id)).toBe(true);
    expect(p.below.has(c!.id) || p.above.has(c!.id)).toBe(true);
  });

  it("refuses a scattered set — there is no single below and above", () => {
    const doc = createEmptyDocument();
    const [a, , c] = stack(doc, 3);
    // Something that is NOT changing sits between two things that are.
    expect(partitionScene(doc, doc.frames, new Set([a!.id, c!.id]))).toBeNull();
  });

  it("refuses when a layer above reads the pixels behind it", () => {
    const doc = createEmptyDocument();
    const [, mid] = stack(doc, 3);
    const p = partitionScene(doc, doc.frames, new Set([mid!.id]))!;
    const above = doc.tracks.flatMap((t) => t.clips).find((x) => x.id === [...p.above][0])!;
    // A material refracts what is beneath it, which is the layer that is
    // changing — asked of the effect registry, not by naming "glass".
    if (above.kind === "audio") throw new Error("a stack of visual layers");
    above.effects.push({ id: "lfx_1", type: "glass", enabled: true } as never);
    expect(partitionScene(doc, doc.frames, new Set([mid!.id]))).toBeNull();
  });

  it("refuses when a layer above carries a non-normal blend", () => {
    const doc = createEmptyDocument();
    const [, mid] = stack(doc, 3);
    const p = partitionScene(doc, doc.frames, new Set([mid!.id]))!;
    const above = doc.tracks.flatMap((t) => t.clips).find((x) => x.id === [...p.above][0])!;
    if (above.kind === "audio") throw new Error("a stack of visual layers");
    above.blendMode = "multiply";
    expect(partitionScene(doc, doc.frames, new Set([mid!.id]))).toBeNull();
  });

  it("refuses a driven document outright — identity means nothing in one", () => {
    const doc = createEmptyDocument();
    const [a] = stack(doc, 2);
    doc.variables.push({ id: "var_1" } as never);
    expect(partitionScene(doc, doc.frames, new Set([a!.id]))).toBeNull();
  });

  it("promotes a member to the group that composites it, rather than refusing", () => {
    const doc = createEmptyDocument();
    const [a, b] = stack(doc, 2);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    const group = groupClipById(doc, gid)!;
    // A look on the group means its members make ONE picture, so one of them
    // cannot be lifted out of it.
    group.effects.push({ id: "lfx_1", type: "glass", enabled: true } as never);

    const p = partitionScene(doc, doc.frames, new Set([a!.id]))!;
    expect(p).not.toBeNull();
    expect(p.changing.has(gid)).toBe(true);
    expect(p.changing.has(b!.id)).toBe(true); // the sibling came with it
  });
});

describe("what the current edit can change", () => {
  it("is the leaf when you are editing one clip in place", () => {
    expect([...editScopeClipIds(editPath("frame_1"), "clip_text")]).toEqual(["clip_text"]);
  });

  it("is the OUTERMOST hop when you are drilled in — the scene around it sees one instance", () => {
    const path = editPath("frame_1", ["clip_outer", "clip_inner"]);
    expect([...editScopeClipIds(path, "clip_deep_leaf")]).toEqual(["clip_outer"]);
  });

  it("is nothing when you are merely looking at the root", () => {
    expect(editScopeClipIds(editPath("frame_1"), null).size).toBe(0);
  });
});
