import { describe, expect, it } from "vitest";
import type { MotionDocument, Subpath } from "../schema";
import { createEmptyDocument, createPathClip, createRasterClip, createTrack } from "../factories";
import { multiPolyArea, subpathsToMultiPoly } from "../vector/polygon";
import { resolveStrokeTargets } from "./paint-target";
import {
  cutVectorByRegion,
  dissolvePoints,
  eraseSubpaths,
  eraseVectorSubpaths,
  type EraserPath,
} from "./vector-cut";

const pt = (x: number, y: number) => ({ x, y, hIn: null, hOut: null });
let n = 0;
const poly = (...xs: Array<[number, number]>): Subpath => ({
  id: `s${n++}`,
  closed: true,
  points: xs.map(([x, y]) => pt(x, y)),
});
const line = (...xs: Array<[number, number]>): Subpath => ({
  id: `s${n++}`,
  closed: false,
  points: xs.map(([x, y]) => pt(x, y)),
});
/** A 100×100 square centred on the origin. */
const square = () => poly([-50, -50], [50, -50], [50, 50], [-50, 50]);
/** An eraser dragged straight down the y axis at x, radius r. */
const swipe = (x: number, r: number): EraserPath => ({
  points: [
    { x, y: -80, radius: r },
    { x, y: 80, radius: r },
  ],
});
const area = (subs: Subpath[]) => multiPolyArea(subpathsToMultiPoly(subs));

describe("eraseVectorSubpaths — split", () => {
  it("cuts an open stroke into arcs and keeps the untouched anchors exact", () => {
    const stroke = line([-50, 0], [50, 0]);
    const result = eraseVectorSubpaths([stroke], swipe(0, 5), { mode: "split", filled: false });
    expect(result.kind).toBe("geometry");
    if (result.kind !== "geometry") return;
    expect(result.subpaths).toHaveLength(2);
    expect(result.subpaths[0]!.points[0]).toMatchObject({ x: -50, y: 0 });
    const ends = result.subpaths.flatMap((s) => s.points.map((p) => p.x));
    // The gap around x=0 is at least the eraser's diameter.
    expect(Math.max(...ends.filter((x) => x < 0))).toBeLessThanOrEqual(-5);
    expect(Math.min(...ends.filter((x) => x > 0))).toBeGreaterThanOrEqual(5);
  });

  it("CARVES filled art instead of opening its outline — the fill still encloses", () => {
    const before = area([square()]);
    const result = eraseVectorSubpaths([square()], swipe(0, 10), { mode: "split", filled: true });
    expect(result.kind).toBe("geometry");
    if (result.kind !== "geometry") return;
    // One swipe down the middle splits the square into two closed halves.
    expect(result.subpaths.every((s) => s.closed)).toBe(true);
    expect(area(result.subpaths)).toBeCloseTo(before - 100 * 20, -1);
  });

  it("deletes the clip when the last of it goes", () => {
    const result = eraseVectorSubpaths([square()], swipe(0, 200), { mode: "split", filled: true });
    expect(result.kind).toBe("delete");
  });

  it("misses cleanly — an untouched outline never reaches the document", () => {
    const result = eraseVectorSubpaths([square()], swipe(500, 5), { mode: "split", filled: true });
    expect(result.kind).toBe("none");
  });
});

describe("eraseVectorSubpaths — points and whole", () => {
  it("dissolves only the nodes under the brush, path unbroken", () => {
    const stroke = line([-50, 0], [0, 0], [50, 0]);
    const result = eraseVectorSubpaths([stroke], swipe(0, 5), { mode: "points", filled: false });
    expect(result.kind).toBe("geometry");
    if (result.kind !== "geometry") return;
    expect(result.subpaths).toHaveLength(1);
    expect(result.subpaths[0]!.points.map((p) => p.x)).toEqual([-50, 50]);
  });

  it("takes the whole path on any touch, geometry untouched", () => {
    expect(eraseVectorSubpaths([square()], swipe(50, 4), { mode: "whole", filled: true }).kind).toBe("delete");
    expect(eraseVectorSubpaths([square()], swipe(500, 4), { mode: "whole", filled: true }).kind).toBe("none");
  });

  it("erases inside a fill even when the outline is never crossed", () => {
    const inner: EraserPath = { points: [{ x: 0, y: 0, radius: 8 }] };
    expect(eraseVectorSubpaths([square()], inner, { mode: "whole", filled: true }).kind).toBe("delete");
    const carved = eraseVectorSubpaths([square()], inner, { mode: "split", filled: true });
    expect(carved.kind).toBe("geometry");
    if (carved.kind !== "geometry") return;
    // A hole, not a bite: the outer ring survives and a second ring appears.
    expect(carved.subpaths.length).toBe(2);
  });
});

describe("dissolvePoints", () => {
  it("drops a subpath that runs out of anchors, and reports a clean miss", () => {
    const stroke = line([0, 0], [1, 1]);
    expect(dissolvePoints([stroke], () => true)).toEqual([]);
    expect(dissolvePoints([stroke], () => false)).toBeNull();
  });
});

describe("cutVectorByRegion — the lasso on vectors", () => {
  const leftHalf = { loops: [[{ x: -80, y: -80 }, { x: 0, y: -80 }, { x: 0, y: 80 }, { x: -80, y: 80 }]] };

  it("splits filled art into two CLOSED pieces — the loop becomes the new border", () => {
    const result = cutVectorByRegion([square()], leftHalf, { mode: "cut", filled: true });
    expect(result.kind).toBe("split");
    if (result.kind !== "split") return;
    expect([...result.subpaths, ...result.taken].every((s) => s.closed)).toBe(true);
    expect(area(result.taken)).toBeCloseTo(5000, -1);
    expect(area(result.subpaths)).toBeCloseTo(5000, -1);
  });

  it("splits an open stroke into arcs", () => {
    const result = cutVectorByRegion([line([-50, 0], [50, 0])], leftHalf, { mode: "cut", filled: false });
    expect(result.kind).toBe("split");
  });

  it("picks the object whole when the loop swallows it", () => {
    const all = { loops: [[{ x: -80, y: -80 }, { x: 80, y: -80 }, { x: 80, y: 80 }, { x: -80, y: 80 }]] };
    expect(cutVectorByRegion([square()], all, { mode: "cut", filled: true }).kind).toBe("whole");
  });

  it("never rewrites geometry in whole mode", () => {
    expect(cutVectorByRegion([square()], leftHalf, { mode: "whole", filled: true }).kind).toBe("whole");
  });

  it("misses when the loop lands on empty canvas", () => {
    const far = { loops: [[{ x: 200, y: 200 }, { x: 260, y: 200 }, { x: 260, y: 260 }]] };
    expect(cutVectorByRegion([square()], far, { mode: "cut", filled: true }).kind).toBe("none");
  });
});

describe("eraseSubpaths keeps its old contract", () => {
  it("returns null on a miss so the caller skips the update", () => {
    expect(eraseSubpaths([square()], swipe(500, 5))).toBeNull();
  });
});

describe("resolveStrokeTargets", () => {
  const frameId = "frame_1";
  function docWith(): { doc: MotionDocument; ids: string[] } {
    const doc = createEmptyDocument();
    const top = createTrack();
    const mid = createTrack();
    const bottom = createTrack();
    const pathClip = createPathClip({ frameId, subpaths: [square()], startMs: 0 });
    const pixels = createRasterClip({ frameId, width: 10, height: 10, startMs: 0 });
    const hidden = createRasterClip({ frameId, width: 10, height: 10, startMs: 0 });
    hidden.hidden = true;
    top.clips.push(pathClip);
    mid.clips.push(pixels);
    bottom.clips.push(hidden);
    doc.tracks = [top, mid, bottom];
    return { doc, ids: [pathClip.id, pixels.id, hidden.id] };
  }

  it("all layers means all VISIBLE layers, topmost first, each with its medium", () => {
    const { doc, ids } = docWith();
    expect(resolveStrokeTargets(doc, frameId, [], "all")).toEqual([
      { clipId: ids[0], medium: "vector", frameId },
      { clipId: ids[1], medium: "raster", frameId },
    ]);
  });

  it("skips locked layers", () => {
    const { doc, ids } = docWith();
    doc.tracks[0]!.locked = true;
    expect(resolveStrokeTargets(doc, frameId, [], "all").map((t) => t.clipId)).toEqual([ids[1]]);
  });

  it("this layer follows the selection — whatever kind it is", () => {
    const { doc, ids } = docWith();
    expect(resolveStrokeTargets(doc, frameId, [ids[0]!], "current")).toEqual([
      { clipId: ids[0], medium: "vector", frameId },
    ]);
  });

  it("this layer falls back to the topmost when nothing usable is selected", () => {
    const { doc, ids } = docWith();
    expect(resolveStrokeTargets(doc, frameId, ["not-a-clip"], "current").map((t) => t.clipId)).toEqual([ids[0]]);
  });

  it("ignores a layer parked elsewhere on the timeline — all layers means all VISIBLE layers", () => {
    const { doc, ids } = docWith();
    doc.tracks[0]!.clips[0]!.startMs = 9000;
    doc.tracks[0]!.clips[0]!.durationMs = 1000;
    expect(resolveStrokeTargets(doc, frameId, [], "all", 0).map((t) => t.clipId)).toEqual([ids[1]]);
    expect(resolveStrokeTargets(doc, frameId, [], "all", 9500).map((t) => t.clipId)).toEqual([ids[0]]);
    // No time given (a flipbook cell's drawing) → no time gate.
    expect(resolveStrokeTargets(doc, frameId, [], "all").map((t) => t.clipId)).toEqual(ids.slice(0, 2));
  });

  it("ignores clips living in another frame", () => {
    const { doc } = docWith();
    expect(resolveStrokeTargets(doc, "frame_other", [], "all")).toEqual([]);
  });
});
