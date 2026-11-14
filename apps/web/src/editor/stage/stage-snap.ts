"use client";

import {
  basisOfTransform,
  buildSnapCandidates,
  clipBox,
  clipFrameBounds,
  mapLocal,
  shapeCornerPoints,
  type AABB,
  type MotionDocument,
  type GuideLine,
  type SnapCandidates,
  type ViewportSnapSettings,
} from "@solomotion/core";
import { frameSpace } from "./edit-space";

/**
 * WORLD-space snap candidates for a frame, derived straight from the DOCUMENT
 * (sibling clip bounds + page edges/center + ruler guides). The stage builds
 * its own candidates from live screen hit-rects; overlays that don't own those
 * (the pen/vector layer) call THIS so a node/point they drag snaps to exactly
 * the same guides a layer does — one snap engine, every surface.
 *
 * Frame-centre → world rides the frame's own chain (`frameSpace`), so snapping
 * inside a nested comp offers targets that are on the artwork. Candidates are
 * axis-aligned boxes, so a comp instanced at an ANGLE can only be approximated
 * by their extent — stated here rather than silently wrong: the guides still
 * land on the right pixels, an angled parent just widens their boxes.
 */
export function frameSnapCandidates(
  doc: MotionDocument,
  frameId: string,
  excludeIds: Set<string>,
  settings: ViewportSnapSettings,
  /** Are the guide lines on screen? A HIDDEN guide must not snap — an invisible
   *  magnet is the worst kind. Figma, Illustrator and Photoshop all agree.
   *  Defaults true so a caller that has no opinion behaves as before. */
  guidesVisible = true,
): SnapCandidates | null {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame) return null;
  const space = frameSpace(frameId);
  const w = (lx: number, ly: number) =>
    space ? space.toWorld({ x: lx, y: ly }) : { x: frame.x + frame.width / 2 + lx, y: frame.y + frame.height / 2 + ly };
  const box = (minX: number, minY: number, maxX: number, maxY: number): AABB => {
    const a = w(minX, minY);
    const b = w(maxX, maxY);
    return {
      minX: Math.min(a.x, b.x),
      minY: Math.min(a.y, b.y),
      maxX: Math.max(a.x, b.x),
      maxY: Math.max(a.y, b.y),
    };
  };
  const targets: AABB[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.frameId !== frameId || excludeIds.has(clip.id)) continue;
      const b = clipFrameBounds(doc, clip); // frame-center relative
      if (!b) continue;
      targets.push(box(b.minX, b.minY, b.maxX, b.maxY));
    }
  }
  const page = box(-frame.width / 2, -frame.height / 2, frame.width / 2, frame.height / 2);
  const guides: GuideLine[] = (guidesVisible ? frame.guides : []).map((g) =>
    g.axis === "x"
      ? { axis: "x", pos: w(g.pos - frame.width / 2, 0).x, lo: page.minY, hi: page.maxY }
      : { axis: "y", pos: w(0, g.pos - frame.height / 2).y, lo: page.minX, hi: page.maxX },
  );
  return buildSnapCandidates(targets, page, settings, guides);
}

/**
 * WORLD-space positions of EVERY vector anchor in a frame — every path clip's
 * nodes and every shape clip's corners (their base transform; siblings aren't
 * keyframe-sampled). This is what lets a pen node snap to another object's
 * corner and vice-versa: one node cloud, no "which object owns it" — the
 * cross-object half of the unified node-to-node snapping. `exclude` drops the
 * clip being edited so it never fights its own live nodes (those are fed
 * separately with the editor's live pose).
 */
export function frameVectorNodesWorld(
  doc: MotionDocument,
  frameId: string,
  exclude: ReadonlySet<string>,
): Array<{ x: number; y: number }> {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame) return [];
  const space = frameSpace(frameId);
  const place = (lx: number, ly: number) =>
    space ? space.toWorld({ x: lx, y: ly }) : { x: frame.x + frame.width / 2 + lx, y: frame.y + frame.height / 2 + ly };
  const out: Array<{ x: number; y: number }> = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.frameId !== frameId || exclude.has(clip.id)) continue;
      if (clip.kind !== "path" && clip.kind !== "shape") continue;
      const t = clip.transform;
      // THE layer map, not a seventh hand-rolled rotate-and-scale: this one used
      // to drop the pivot, the Y scale and the shear, so a node of a squashed,
      // sheared or off-pivot object advertised a snap target that wasn't on it.
      const basis = basisOfTransform(t, clipBox(doc, clip));
      const toWorld = (lx: number, ly: number) => {
        const o = mapLocal(lx, ly, basis);
        return place(t.x + o.x, t.y + o.y);
      };
      if (clip.kind === "path") {
        for (const sub of clip.subpaths) for (const p of sub.points) out.push(toWorld(p.x, p.y));
      } else {
        for (const p of shapeCornerPoints({ ...clip, cornerOffsets: clip.cornerOffsets })) out.push(toWorld(p.x, p.y));
      }
    }
  }
  return out;
}
