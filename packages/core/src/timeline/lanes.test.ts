import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip } from "../factories";
import type { MotionDocument } from "../schema";
import { placeClip } from "./place";
import { compactLanes, laneNumbers } from "./lanes";
import { frameLanes, frameLayerTree } from "./layer-tree";
import { addClipToTrack, locateClip } from "./ops";
import { createCarrierTrack } from "../factories";

/**
 * Lane hygiene: a scene built one layer at a time reuses the comp's lanes, and
 * the tidy-up never changes what covers what. Both are order-sensitive rules
 * that would rot silently — nothing renders wrong, the timeline just sprawls.
 */

function doc() {
  const d = createEmptyDocument("Lanes");
  return { d, frameId: d.frames[0]!.id };
}

function add(d: MotionDocument, frameId: string, startMs: number, durationMs: number, above?: string) {
  const clip = createShapeClip({ frameId, shape: "rect", startMs, durationMs });
  placeClip(d, clip, { landing: "settle", ...(above ? { aboveClipId: above } : {}) });
  return clip.id;
}

/** Paint order at an instant, bottom first — what the picture actually is. */
function paintOrder(d: MotionDocument, frameId: string, atMs: number): string[] {
  return frameLayerTree(d, frameId)
    .filter((n) => n.clip.startMs <= atMs && atMs < n.clip.startMs + n.clip.durationMs)
    .map((n) => n.clip.id)
    .reverse();
}

describe("settled placement", () => {
  it("births on top of what plays, and the next scene reuses the lanes", () => {
    const { d, frameId } = doc();
    const bg = add(d, frameId, 0, 5000);
    const title = add(d, frameId, 0, 3000);
    const sub = add(d, frameId, 0, 3000);
    expect(paintOrder(d, frameId, 1000)).toEqual([bg, title, sub]);
    const lanes = frameLanes(d, frameId).length;

    const bg2 = add(d, frameId, 5000, 5000);
    const title2 = add(d, frameId, 5000, 3000);
    expect(paintOrder(d, frameId, 6000)).toEqual([bg2, title2]);
    expect(frameLanes(d, frameId).length).toBe(lanes);
    // Scene two sat down on scene one's lanes, lowest first.
    expect(locateClip(d, bg2)!.track).toBe(locateClip(d, bg)!.track);
    expect(locateClip(d, title2)!.track).toBe(locateClip(d, title)!.track);
  });

  it("an anchored run (captions over a video) shares the lane beside the anchor", () => {
    const { d, frameId } = doc();
    const video = add(d, frameId, 0, 9000);
    const a = add(d, frameId, 0, 3000, video);
    const b = add(d, frameId, 3000, 3000, video);
    const c = add(d, frameId, 6000, 3000, video);
    const lane = locateClip(d, a)!.track;
    expect(locateClip(d, b)!.track).toBe(lane);
    expect(locateClip(d, c)!.track).toBe(lane);
    expect(paintOrder(d, frameId, 4000)).toEqual([video, b]);
  });

  it("never lands on a hidden or locked lane", () => {
    const { d, frameId } = doc();
    for (const t of d.tracks) t.hidden = true;
    const id = add(d, frameId, 0, 1000);
    expect(locateClip(d, id)!.track.hidden).toBe(false);
  });
});

describe("compactLanes", () => {
  it("packs by gravity without changing any frame's picture, then drops the empties", () => {
    const { d, frameId } = doc();
    // One lane per clip — what the surface rule used to leave behind.
    const make = (startMs: number, durationMs: number) => {
      const clip = createShapeClip({ frameId, shape: "rect", startMs, durationMs });
      const lane = createCarrierTrack(undefined, frameId);
      d.tracks.unshift(lane);
      addClipToTrack(lane, clip);
      return clip.id;
    };
    const bg = make(0, 10_000);
    const a = make(0, 3000);
    const b = make(3000, 3000);
    const c = make(1000, 1000); // overlaps a: must stay above it
    const before = [500, 1500, 3500, 7000].map((t) => paintOrder(d, frameId, t));

    const result = compactLanes(d, frameId);
    expect(result.moved).toBeGreaterThan(0);
    expect([500, 1500, 3500, 7000].map((t) => paintOrder(d, frameId, t))).toEqual(before);
    expect(result.lanesAfter).toBe(3);
    const lanes = laneNumbers(d, frameId);
    expect(lanes.get(locateClip(d, a)!.track.id)).toBe(lanes.get(locateClip(d, b)!.track.id));
    expect(lanes.get(locateClip(d, bg)!.track.id)).toBe(2);
    expect(lanes.get(locateClip(d, c)!.track.id)).toBe(0);
  });

  it("carries a transition with the clips it joins, and nothing crosses a locked lane", () => {
    const { d, frameId } = doc();
    d.tracks = [];
    const lane = (locked = false) => {
      const t = createCarrierTrack(undefined, frameId);
      t.locked = locked;
      d.tracks.push(t);
      return t;
    };
    const top = lane();
    const mid = lane();
    const wall = lane(true);
    const bottom = lane();
    const x = createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 1000 });
    const y = createShapeClip({ frameId, shape: "rect", startMs: 1000, durationMs: 1000 });
    addClipToTrack(top, x);
    addClipToTrack(top, y);
    top.transitions.push({ id: "tr", preset: "fade", frameId, aClipId: x.id, bClipId: y.id, durationMs: 200, splitMs: 100, easing: { kind: "linear" }, params: {}, color: null });
    // Nothing below overlaps x or y, so only the locked lane keeps them above it.
    const low = createShapeClip({ frameId, shape: "rect", startMs: 6000, durationMs: 1000 });
    addClipToTrack(wall, createShapeClip({ frameId, shape: "rect", startMs: 8000, durationMs: 1000 }));
    addClipToTrack(bottom, low);

    compactLanes(d, frameId);
    // x+y fell one lane (the empty `mid`), together, with their transition — not past the wall.
    const home = locateClip(d, x.id)!.track;
    expect(home).toBe(mid);
    expect(locateClip(d, y.id)!.track).toBe(mid);
    expect(mid.transitions.map((t) => t.id)).toEqual(["tr"]);
    expect(locateClip(d, low.id)!.track).toBe(bottom);
    expect(d.tracks).toContain(wall);
    expect(d.tracks).not.toContain(top);
  });
});
