import { describe, expect, it } from "vitest";
import type { GroupClip, PathClip, ShapeClip } from "../schema";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { locateClip, clipBox } from "../timeline/ops";
import { anchorLocal, basisOfTransform, layerMatrix } from "../transform-map";
import { createRig, poseBones } from "./ops";
import { evaluateRig } from "./pose";
import { field2d, localSkins, memberOf, restToRig2d } from "./bind";
import { warpedVectorClip } from "./vector";

/** A sleeve along x, −100 … 100, under a two-bone arm; the bend is at x = 0. */
function sleeve() {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const s = createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 1000, x: 0, y: 0, width: 200, height: 20 }) as ShapeClip;
  const lane = createTrack("s");
  lane.clips.push(s);
  doc.tracks.push(lane);
  const rig = createRig(doc, frameId, { memberIds: [s.id], bones: [{ head: [-100, 0], tail: [0, 0] }, { head: [0, 0], tail: [100, 0] }] })!;
  const g = () => locateClip(doc, rig)!.clip as GroupClip;
  return { doc, s, rig, g };
}

function warp(doc: ReturnType<typeof sleeve>["doc"], gid: string, sid: string) {
  const g = locateClip(doc, gid)!.clip as GroupClip;
  const shape = locateClip(doc, sid)!.clip as ShapeClip;
  const pose = evaluateRig(g.rig!, { planar: true });
  const m = memberOf(doc, sid)!;
  const field = field2d(doc, m, shape, pose);
  const skins = localSkins(field.weights, pose, restToRig2d(doc, m, shape));
  return { out: warpedVectorClip(shape, {}, field, skins, 0.3), shape };
}

/** Where a layer's own point lands in the comp, through its own transform. */
function placed(clip: PathClip | ShapeClip, box: ReturnType<typeof clipBox>, p: { x: number; y: number }) {
  const L = layerMatrix(basisOfTransform(clip.transform, box));
  return { x: L[0] * p.x + L[2] * p.y + L[4] + clip.transform.x, y: L[1] * p.x + L[3] * p.y + L[5] + clip.transform.y };
}

describe("a bending vector", () => {
  it("at rest draws its own outline, where it was, with the same look", () => {
    const { doc, s, rig } = sleeve();
    const { out, shape } = warp(doc, rig, s.id);
    expect(out.kind).toBe("path");
    expect(out.fills).toBe(shape.fills);
    const pts = out.subpaths[0]!.points;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(-100, 6);
    expect(Math.max(...xs)).toBeCloseTo(100, 6);
    expect(Math.max(...ys)).toBeCloseTo(10, 6);
    // The pivot is still the same point of the comp.
    const before = anchorLocal(shape.transform.anchor, clipBox(doc, shape));
    const after = anchorLocal(out.transform.anchor, { width: 200, height: 20, cx: 0, cy: 0 });
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("bends a four-point rectangle at the elbow — the outline, not the corners", () => {
    const { doc, s, rig, g } = sleeve();
    const fore = g().rig!.bones[1]!.id;
    poseBones(doc, rig, [{ bone: fore, values: { rotation: 90 } }], 0);
    const { out } = warp(doc, rig, s.id);
    const pts = out.subpaths[0]!.points;
    // The far end swings down the screen toward (0, 100); the near end stays.
    expect(Math.max(...pts.map((p) => p.y))).toBeGreaterThan(80);
    expect(pts.filter((p) => p.x < -60).every((p) => Math.abs(p.y) <= 10 + 1e-6)).toBe(true);
    // It has points along its length to bend with — far more than four.
    expect(pts.length).toBeGreaterThan(20);
    // Placed by the same transform: the bent tip lands near the forearm's posed tip.
    const tip = pts.reduce((a, p) => (p.y > a.y ? p : a));
    const at = placed(out, { width: 1, height: 1, cx: 0, cy: 0 }, { x: 0, y: 0 });
    expect(Number.isFinite(at.x)).toBe(true);
    expect(tip.x).toBeGreaterThan(-15);
    expect(tip.x).toBeLessThan(15);
  });
});
