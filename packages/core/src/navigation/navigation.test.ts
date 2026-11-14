import { describe, expect, it } from "vitest";
import { createEmptyDocument, createFrame, createNestedClip, createTextClip, createTrack } from "../factories";
import { makeComponentFromFrame } from "../components";
import type { MotionDocument, NestedClip } from "../schema";
import {
  centerToWorld,
  childTimeOf,
  containsWorldPoint,
  editPath,
  enterContext,
  enterPath,
  normalizePath,
  pathToFrame,
  pathTrail,
  resolveEditContext,
  resolveFrameContext,
  targetFrameId,
  targetQuad,
  worldToCenter,
  worldToTarget,
} from ".";
import { compOwnerNested } from "../timeline/ops";

/**
 * A two-level scene: root frame → nested clip → child frame → nested clip →
 * grandchild frame, with the hops offset in time and space so the geometry and
 * time mapping are actually exercised rather than accidentally identity.
 */
function scene(): {
  doc: MotionDocument;
  rootId: string;
  childId: string;
  grandId: string;
  hop1: NestedClip;
  hop2: NestedClip;
  track: ReturnType<typeof createTrack>;
} {
  const doc = createEmptyDocument();
  const rootId = doc.frames[0]!.id;
  doc.frames[0]!.x = 100;
  doc.frames[0]!.y = 200;
  doc.frames[0]!.width = 1000;
  doc.frames[0]!.height = 1000;

  const child = createFrame({ name: "Child", width: 400, height: 400, pageId: "__internal__" });
  const grand = createFrame({ name: "Grand", width: 200, height: 200, pageId: "__internal__" });
  doc.frames.push(child, grand);

  const hop1 = createNestedClip({
    frameId: rootId,
    sourceFrameId: child.id,
    startMs: 1000,
    durationMs: 4000,
  });
  const hop2 = createNestedClip({
    frameId: child.id,
    sourceFrameId: grand.id,
    startMs: 500,
    durationMs: 3000,
  });
  const track = createTrack("t");
  track.clips.push(hop1, hop2);
  doc.tracks.push(track);
  return { doc, rootId, childId: child.id, grandId: grand.id, hop1, hop2, track };
}

describe("navigation path", () => {
  it("derives the target from the path — it can never disagree with it", () => {
    const { doc, rootId, childId, grandId, hop1, hop2 } = scene();
    expect(targetFrameId(doc, editPath(rootId))).toBe(rootId);
    expect(targetFrameId(doc, editPath(rootId, [hop1.id]))).toBe(childId);
    expect(targetFrameId(doc, editPath(rootId, [hop1.id, hop2.id]))).toBe(grandId);
  });

  it("breadcrumb has exactly one crumb per frame (no 'Frame 1 ▸ Frame 1')", () => {
    const { doc, rootId, hop1 } = scene();
    const trail = pathTrail(doc, editPath(rootId, [hop1.id]));
    expect(trail.map((c) => c.frameId)).toEqual([rootId, doc.frames[1]!.id]);
    expect(trail[trail.length - 1]!.isTarget).toBe(true);
    expect(new Set(trail.map((c) => c.frameId)).size).toBe(trail.length);
  });

  it("re-entering the clip you are already inside is idempotent", () => {
    const { doc, rootId, hop1 } = scene();
    const path = editPath(rootId, [hop1.id]);
    expect(enterPath(doc, path, hop1.id)).toEqual(path);
  });

  it("refuses a cycle and truncates a broken path instead of storing it", () => {
    const { doc, rootId, childId, hop1, hop2, track } = scene();
    // A clip in the child that points back at the root would be a cycle.
    const cycle = createNestedClip({ frameId: childId, sourceFrameId: rootId, startMs: 0, durationMs: 100 });
    track.clips.push(cycle);
    expect(enterPath(doc, editPath(rootId, [hop1.id]), cycle.id)).toBeNull();

    // Deleting the first hop truncates everything below it.
    track.clips = track.clips.filter((c) => c.id !== hop1.id);
    expect(normalizePath(doc, editPath(rootId, [hop1.id, hop2.id]))).toEqual(editPath(rootId));
  });

  it("derives a path from the document's own ancestry", () => {
    const { doc, rootId, grandId, hop1, hop2 } = scene();
    expect(pathToFrame(doc, grandId)).toEqual(editPath(rootId, [hop1.id, hop2.id]));
  });

  it("opens a comp filed on a page as its own root, however many clips link to it", () => {
    const { doc, rootId, childId } = scene();
    const child = doc.frames.find((f) => f.id === childId)!;
    child.pageId = doc.frames.find((f) => f.id === rootId)!.pageId; // a scene a cover shows once
    expect(pathToFrame(doc, childId)).toEqual(editPath(childId));
    expect(compOwnerNested(doc, childId)).toBeNull();
  });
});

describe("edit context", () => {
  it("maps the playhead UP through every hop (the playhead is TARGET time)", () => {
    const { doc, rootId, hop1, hop2 } = scene();
    const ctx = resolveEditContext(doc, editPath(rootId, [hop1.id, hop2.id]), 250)!;
    expect(ctx.targetTimeMs).toBe(250);
    // grand @250 → child @ hop2.startMs + 250 → root @ hop1.startMs + that.
    expect(ctx.frameTimes.get(doc.frames[1]!.id)).toBe(500 + 250);
    expect(ctx.frameTimes.get(rootId)).toBe(1000 + 750);
  });

  it("places the target in world space through the whole hop chain", () => {
    const { doc, rootId, hop1 } = scene();
    const ctx = resolveEditContext(doc, editPath(rootId, [hop1.id]), 0)!;
    // Child (400×400) centred in the 1000×1000 root, which sits at (100,200).
    const q = targetQuad(ctx);
    expect(q[0]).toEqual({ x: 100 + 300, y: 200 + 300 });
    expect(q[2]).toEqual({ x: 100 + 700, y: 200 + 700 });
    // Round-trip: a world point maps back to the target's own local coords.
    expect(worldToTarget(ctx, { x: 400, y: 500 })).toEqual({ x: 0, y: 0 });
    expect(containsWorldPoint(ctx, { x: 500, y: 600 })).toBe(true);
    expect(containsWorldPoint(ctx, { x: 120, y: 220 })).toBe(false);
  });

  it("edits a nested comp IN PLACE: root stays lit, root conducts, no camera move", () => {
    const { doc, rootId, hop1 } = scene();
    const ctx = resolveEditContext(doc, editPath(rootId, [hop1.id]), 0)!;
    expect(ctx.isolationFrameId).toBe(rootId);
    expect(ctx.conductFrameId).toBe(rootId);
  });

  it("a drawing/flipbook target opens its workspace but is STILL edited in place", () => {
    const { doc, rootId, hop1, childId } = scene();
    doc.frames.find((f) => f.id === childId)!.mode = "static";
    const ctx = resolveEditContext(doc, editPath(rootId, [hop1.id]), 0)!;
    // The workspace changes; where the target lives does NOT. Its own page x/y
    // is never an origin — the hop chain places it, exactly as for a comp.
    expect(ctx.workspace).toBe("static");
    expect(ctx.isolationFrameId).toBe(rootId);
    expect(ctx.conductFrameId).toBe(rootId);
    expect(targetQuad(ctx)[0]).toEqual({ x: 100 + 300, y: 200 + 300 });
  });

  it("labels a component hop as a component and a private comp as nested", () => {
    const { doc, rootId, hop1, childId } = scene();
    expect(pathTrail(doc, editPath(rootId, [hop1.id]))[1]!.badge).toBe("nested");
    makeComponentFromFrame(doc, childId);
    expect(pathTrail(doc, editPath(rootId, [hop1.id]))[1]!.badge).toBe("component");
  });

  it("a clip that moved to another comp invalidates the hop rather than lying", () => {
    const { doc, rootId, hop1, track } = scene();
    const stray = createTextClip({ frameId: "somewhere-else", text: "x", startMs: 0, durationMs: 10 });
    track.clips.push(stray);
    expect(enterPath(doc, editPath(rootId), stray.id)).toBeNull();
    hop1.frameId = "somewhere-else";
    expect(normalizePath(doc, editPath(rootId, [hop1.id]))).toEqual(editPath(rootId));
  });
});

/**
 * THE regression this whole coordinate seam exists for.
 *
 * A source comp lives on the internal shelf and keeps whatever `x`/`y` it was
 * created with — coordinates nothing ever paints at. Every drawing and vector
 * overlay used to map screen points with `frame.x + frame.width / 2`, so a
 * stroke drilled one level down was measured against an empty rectangle off to
 * the side of the artwork, then placed by the renderer through the hop chain.
 * The mark appeared somewhere else, outside the lit area, and onion skins
 * ghosted a region nothing was in.
 */
describe("frame-centre mapping ignores a source frame's page coordinates", () => {
  it("places a drilled comp by its CHAIN, not by its own x/y", () => {
    const { doc, rootId, hop1, childId } = scene();
    // Junk shelf coordinates: the old mapping would have read these.
    const child = doc.frames.find((f) => f.id === childId)!;
    child.x = -9999;
    child.y = 7777;
    const ctx = resolveEditContext(doc, editPath(rootId, [hop1.id]), 0)!;
    // Child (400x400) centred in the 1000x1000 root at page (100,200).
    expect(centerToWorld(ctx, { x: 0, y: 0 })).toEqual({ x: 600, y: 700 });
    expect(worldToCenter(ctx, { x: 600, y: 700 })).toEqual({ x: 0, y: 0 });
    // A corner of the child, in the child's own frame-centre coordinates.
    expect(centerToWorld(ctx, { x: -200, y: -200 })).toEqual({ x: 400, y: 500 });
  });

  it("carries the hop's pose — a moved, scaled instance moves the mapping with it", () => {
    const { doc, rootId, hop1 } = scene();
    hop1.transform.x = 50;
    hop1.transform.y = -30;
    hop1.transform.scale = 2;
    const ctx = resolveEditContext(doc, editPath(rootId, [hop1.id]), 0)!;
    // Centre follows the instance; a local offset is scaled by it.
    expect(centerToWorld(ctx, { x: 0, y: 0 })).toEqual({ x: 650, y: 670 });
    expect(centerToWorld(ctx, { x: 10, y: 10 })).toEqual({ x: 670, y: 690 });
    // Round-trip through the same chain, which is the property tools rely on.
    expect(worldToCenter(ctx, { x: 670, y: 690 })).toEqual({ x: 10, y: 10 });
  });

  it("resolves a frame's space from where you stand, without navigating", () => {
    const { doc, rootId, hop1, grandId } = scene();
    const stand = editPath(rootId);
    const ctx = resolveFrameContext(doc, stand, 0, grandId)!;
    expect(ctx.target.id).toBe(grandId);
    expect(ctx.path.hops.length).toBe(2);
    // Grand (200x200) centred in Child (400x400) centred in the root.
    expect(centerToWorld(ctx, { x: 0, y: 0 })).toEqual({ x: 600, y: 700 });
    expect(hop1.id).toBe(ctx.path.hops[0]);
  });

  it("a trimmed, sped-up instance maps through the renderer's own map at every depth", () => {
    const { doc, rootId, hop1, hop2, grandId } = scene();
    doc.frames.find((f) => f.id === grandId)!.durationMs = 20_000;
    // The instance shows the grand comp from 5.5s on, at double speed.
    hop2.trimInMs = 5500;
    hop2.playback = { ...hop2.playback, speed: 2 };
    const ctx = resolveEditContext(doc, editPath(rootId, [hop1.id, hop2.id]), 6500)!;
    const child = ctx.frameTimes.get(doc.frames[1]!.id)!;
    // grand@6500 is 1000ms of source past the trim → 500ms of wall time into hop2.
    expect(child).toBe(500 + 500);
    // And going back down lands on the instant the timeline stands on — the
    // stage paints what the playhead says, not trimIn later.
    expect(childTimeOf(doc, hop2, child)).toBe(6500);
    expect(childTimeOf(doc, hop1, ctx.frameTimes.get(rootId)!)).toBe(child);
  });

  it("enterContext steps one hop down and carries the instant with it", () => {
    const { doc, rootId, hop1, hop2, childId, grandId } = scene();
    const outer = resolveEditContext(doc, editPath(rootId, [hop1.id]), 800)!;
    expect(outer.target.id).toBe(childId);
    const inner = enterContext(doc, outer, hop2.id)!;
    expect(inner.target.id).toBe(grandId);
    // hop2 starts at 500 in the child's clock, so child@800 is grand@300.
    expect(inner.targetTimeMs).toBe(300);
    // And the chain still agrees with resolving the path outright.
    expect(inner.matrix).toEqual(resolveEditContext(doc, editPath(rootId, [hop1.id, hop2.id]), 300)!.matrix);
  });
});
