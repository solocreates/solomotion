import { describe, it, expect } from "vitest";
import { createEmptyDocument, createGroupClip, createShapeClip, createTrack } from "../factories";
import { flattenClipsToPath } from "./flatten";
import { groupClipById } from "../timeline/groups";
import { setKeyframe } from "../animation/keyframes";
import type { MotionDocument, Contour, GroupMode, ShapeClip } from "../schema";

function frameId(doc: MotionDocument): string {
  return doc.frames[0]!.id;
}

/** Net filled area of a flattened outline (outer rings + subtracted holes). */
function filledArea(subpaths: Contour[]): number {
  let net = 0;
  for (const s of subpaths) {
    const p = s.points;
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const q = p[(i + 1) % p.length]!;
      a += p[i]!.x * q.y - q.x * p[i]!.y;
    }
    net += a / 2;
  }
  return Math.abs(net);
}

/** A group clip on its own lane, inserted at `at` (0 = topmost). */
function putGroup(
  doc: MotionDocument,
  fid: string,
  id: string,
  mode: GroupMode,
  parentId: string | null = null,
): void {
  const group = createGroupClip({ frameId: fid, startMs: 0, durationMs: 5000, name: id, mode });
  group.id = id;
  const lane = createTrack(`lane_${id}`, fid, parentId);
  lane.clips.push(group);
  doc.tracks.unshift(lane);
}

/** Two rects (200×200) on their own tracks, grouped under `mode`. Track 0 = top. */
function twoRectGroup(mode: GroupMode, aX: number, bX: number): { doc: MotionDocument; ids: string[] } {
  const doc = createEmptyDocument();
  const fid = frameId(doc);
  const a = createShapeClip({ frameId: fid, shape: "rect", startMs: 0, x: aX }) as ShapeClip;
  const b = createShapeClip({ frameId: fid, shape: "rect", startMs: 0, x: bX }) as ShapeClip;
  const t2 = createTrack("t2");
  doc.tracks[0]!.clips.push(a); // top
  doc.tracks.push(t2);
  t2.clips.push(b); // bottom
  doc.tracks[0]!.groupId = "g";
  t2.groupId = "g";
  // The topmost member is the stencil — what `setGroupMode` promotes for you.
  a.isStencil = mode !== "pass" && mode !== "union";
  putGroup(doc, fid, "g", mode);
  // Selecting a member resolves to the GROUP (`expandSelectionToGroups`), so
  // that is what a flatten is handed.
  return { doc, ids: ["g"] };
}

describe("a group's silhouette is what is showing now", () => {
  it("a member that has not started yet is not in the outline, and a closed nested window empties", () => {
    const { doc, ids } = twoRectGroup("union", -50, 50);
    const [a, b] = doc.tracks.flatMap((t) => t.clips).filter((c) => c.kind === "shape");
    // `b` starts later: at 1s only `a` is on screen, at 3s both are.
    b!.startMs = 2000;
    expect(filledArea(flattenClipsToPath(doc, ids, { atMs: 1000 })!.subpaths)).toBeCloseTo(40000, 0);
    expect(filledArea(flattenClipsToPath(doc, ids, { atMs: 3000 })!.subpaths)).toBeCloseTo(60000, 0);
    // The static bake (⌘E) still reads every member as live.
    expect(filledArea(flattenClipsToPath(doc, ids)!.subpaths)).toBeCloseTo(60000, 0);
    // The group's own window closes over everything inside it.
    groupClipById(doc, "g")!.durationMs = 500;
    expect(flattenClipsToPath(doc, ids, { atMs: 1000 })).toBeNull();
    expect(a).toBeTruthy();
  });
});

describe("a member's in/out pose is in the outline", () => {
  it("a member scaling in is a smaller silhouette mid-animation, and none while faded out", () => {
    const doc = createEmptyDocument();
    const rect = createShapeClip({ frameId: frameId(doc), shape: "rect", startMs: 0 }) as ShapeClip;
    doc.tracks[0]!.clips.push(rect);
    doc.tracks[0]!.groupId = "g";
    putGroup(doc, frameId(doc), "g", "pass");
    const rest = filledArea(flattenClipsToPath(doc, ["g"], { atMs: 4000 })!.subpaths);
    rect.animIn = { preset: "scale-in", durationMs: 1000, easing: { kind: "preset", name: "ease-out-quart" }, params: { from: 0 } };
    // Mid-way in: smaller than at rest, larger than nothing.
    const mid = filledArea(flattenClipsToPath(doc, ["g"], { atMs: 500 })!.subpaths);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(rest);
    // Long after: exactly at rest.
    expect(filledArea(flattenClipsToPath(doc, ["g"], { atMs: 4000 })!.subpaths)).toBeCloseTo(rest, 0);
    // The static bake (⌘E) ignores the pose: it is the artwork, not a moment.
    expect(filledArea(flattenClipsToPath(doc, ["g"])!.subpaths)).toBeCloseTo(rest, 0);
  });
});

describe("flatten-to-path booleans", () => {
  it("a lone shape passes through as an exact editable rect (no polygonisation)", () => {
    const doc = createEmptyDocument();
    const rect = createShapeClip({ frameId: frameId(doc), shape: "rect", startMs: 0 }) as ShapeClip;
    doc.tracks[0]!.clips.push(rect);
    const r = flattenClipsToPath(doc, [rect.id]);
    expect(r).not.toBeNull();
    expect(r!.subpaths).toHaveLength(1);
    expect(r!.subpaths[0]!.points).toHaveLength(4); // still 4 corners, not a dense polyline
    expect(filledArea(r!.subpaths)).toBeCloseTo(40000, 0);
  });

  it("union merges two overlapping rects into ONE outline of the correct area", () => {
    // Overlap 100px in x → 200² + 200² − (100×200) = 60000.
    const { doc, ids } = twoRectGroup("union", -50, 50);
    const r = flattenClipsToPath(doc, ids);
    expect(r).not.toBeNull();
    expect(r!.subpaths).toHaveLength(1);
    expect(filledArea(r!.subpaths)).toBeCloseTo(60000, 0);
  });

  it("subtract knocks the upper rect out of the bottom one (bottom minus top)", () => {
    // Bottom (b, track 1) minus top (a, track 0). Overlap 20000 → 40000 − 20000.
    const { doc, ids } = twoRectGroup("subtract", -50, 50);
    const r = flattenClipsToPath(doc, ids);
    expect(r).not.toBeNull();
    expect(filledArea(r!.subpaths)).toBeCloseTo(20000, 0);
  });

  it("intersect keeps only the shared region", () => {
    const { doc, ids } = twoRectGroup("intersect", -50, 50);
    const r = flattenClipsToPath(doc, ids);
    expect(r).not.toBeNull();
    expect(filledArea(r!.subpaths)).toBeCloseTo(20000, 0); // 100×200 overlap
  });

  it("disjoint union keeps both as separate curves (exact, no boolean)", () => {
    const { doc, ids } = twoRectGroup("union", -500, 500); // far apart
    const r = flattenClipsToPath(doc, ids);
    expect(r).not.toBeNull();
    expect(r!.subpaths).toHaveLength(2);
    expect(r!.subpaths.every((s) => s.points.length === 4)).toBe(true);
    expect(filledArea(r!.subpaths)).toBeCloseTo(80000, 0);
  });

  it("bakes each clip's own transform into a common comp space", () => {
    // Same two overlapping rects, but the bottom one is shifted via transform.x
    // that the union must honour — area still resolves against real positions.
    const { doc, ids } = twoRectGroup("union", 0, 100); // overlap 100 → 60000
    const r = flattenClipsToPath(doc, ids);
    expect(filledArea(r!.subpaths)).toBeCloseTo(60000, 0);
  });

  it("composites at any depth — a union nested inside a subtract", () => {
    const doc = createEmptyDocument();
    const fid = frameId(doc);
    // Bottom base rect, then a union of two rects above it, all under a subtract.
    const base = createShapeClip({ frameId: fid, shape: "rect", startMs: 0, x: 0 }) as ShapeClip;
    // Two small rects whose union sits INSIDE the base (so subtract cuts a hole).
    const u1 = createShapeClip({ frameId: fid, shape: "rect", startMs: 0, x: -40, width: 100, height: 100 }) as ShapeClip;
    const u2 = createShapeClip({ frameId: fid, shape: "rect", startMs: 0, x: 40, width: 100, height: 100 }) as ShapeClip;
    const t2 = createTrack("t2");
    const t3 = createTrack("t3");
    doc.tracks[0]!.clips.push(u1); // top
    doc.tracks.push(t2, t3);
    t2.clips.push(u2);
    t3.clips.push(base); // bottom
    // outer subtract group holds base + inner union group
    doc.tracks[0]!.groupId = "gi";
    t2.groupId = "gi";
    t3.groupId = "go";
    putGroup(doc, fid, "gi", "union", "go");
    // The nested UNION is the subtract's stencil — a group has a silhouette of
    // its own, so it can be the thing that cuts.
    groupClipById(doc, "gi")!.isStencil = true;
    putGroup(doc, fid, "go", "subtract", null);
    const r = flattenClipsToPath(doc, ["go"]);
    expect(r).not.toBeNull();
    // base (40000) minus the union of the two overlapping upper rects — a valid,
    // finite, non-empty region at depth 2.
    const area = filledArea(r!.subpaths);
    expect(area).toBeGreaterThan(0);
    expect(area).toBeLessThan(40000);
    expect(Number.isFinite(area)).toBe(true);
  });
});

/**
 * A group's stroke has to run around what the group looks like RIGHT NOW, so
 * the reducer can be asked for a moment instead of for the design-time bake.
 * Everything else about it — the composite modes, the nesting, the ⌘E default —
 * is unchanged, which is the whole reason `atMs` is an option and not a second
 * flattener.
 */
describe("flatten at a moment (atMs)", () => {
  const movingRect = (): { doc: MotionDocument; id: string } => {
    const doc = createEmptyDocument();
    const rect = createShapeClip({ frameId: frameId(doc), shape: "rect", startMs: 0, x: 0 }) as ShapeClip;
    setKeyframe(rect.keyframes, "x", 0, 0);
    setKeyframe(rect.keyframes, "x", 1000, 500);
    doc.tracks[0]!.clips.push(rect);
    return { doc, id: rect.id };
  };

  it("ignores the animation by default — ⌘E bakes what you designed", () => {
    const { doc, id } = movingRect();
    const a = flattenClipsToPath(doc, [id])!;
    const b = flattenClipsToPath(doc, [id])!;
    expect(a.bounds.minX).toBeCloseTo(b.bounds.minX, 5);
    expect(a.bounds.minX).toBeCloseTo(-100, 5); // the declared x, not a sampled one
  });

  it("follows a moving member when a time is given", () => {
    const { doc, id } = movingRect();
    const at0 = flattenClipsToPath(doc, [id], { atMs: 0 })!;
    const at1s = flattenClipsToPath(doc, [id], { atMs: 1000 })!;
    expect(at0.bounds.minX).toBeCloseTo(-100, 5);
    expect(at1s.bounds.minX).toBeCloseTo(400, 5);
  });

  it("follows a scaling member", () => {
    const { doc, id } = movingRect();
    const clip = doc.tracks[0]!.clips.find((c) => c.id === id)! as ShapeClip;
    setKeyframe(clip.keyframes, "scale", 0, 1);
    setKeyframe(clip.keyframes, "scale", 1000, 2);
    const small = flattenClipsToPath(doc, [id], { atMs: 0 })!;
    const big = flattenClipsToPath(doc, [id], { atMs: 1000 })!;
    expect(filledArea(big.subpaths)).toBeCloseTo(filledArea(small.subpaths) * 4, 1);
  });

  it("drops a member that is not on screen at that moment", () => {
    const doc = createEmptyDocument();
    const fid = frameId(doc);
    const early = createShapeClip({ frameId: fid, shape: "rect", startMs: 0, x: 0 }) as ShapeClip;
    early.durationMs = 1000;
    const late = createShapeClip({ frameId: fid, shape: "rect", startMs: 2000, x: 400 }) as ShapeClip;
    late.durationMs = 1000;
    doc.tracks[0]!.clips.push(early, late);
    const at500 = flattenClipsToPath(doc, [early.id, late.id], { atMs: 500 })!;
    // Only the first rect is live, so the outline is one 200×200 square.
    expect(filledArea(at500.subpaths)).toBeCloseTo(200 * 200, 1);
  });

  it("still honours the composite mode at a moment", () => {
    const { doc } = twoRectGroup("subtract", 0, 0);
    const both = flattenClipsToPath(doc, ["g"], { atMs: 0 });
    // Two coincident rects, one subtracted from the other: nothing is left.
    expect(both == null || filledArea(both.subpaths) < 1).toBe(true);
  });
});
