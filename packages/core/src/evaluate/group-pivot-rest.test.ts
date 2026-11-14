import { describe, expect, it } from "vitest";
import type { GroupClip, ShapeClip } from "../schema";
import { fxToken } from "../schema/expressions";
import { keyframeTrackSchema } from "../schema/animation";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { clipByIdIn } from "../timeline/frame-index";
import { groupClips } from "../timeline/groups";
import { groupChainMatrix } from "../timeline/group-space";
import { apply } from "../navigation/matrix";
import { resolvedDocAt } from "./resolved-doc";

/**
 * The flat camera rig: pins at mirrored corners, World inside Camera, pan =
 * World.y, zoom = Camera.scale. Camera's pivot is a fraction of its members'
 * REST box, so a pan never moves the zoom centre — whether the pan is keyed or
 * driven by an expression. The expression version used to pivot about the
 * panned box (screen = pan + s·y instead of s·(y + pan)).
 */
function rig(pan: "keyed" | "driven") {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const add = (name: string, x: number, y: number) => {
    const c = createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 10000, x, y, width: 10, height: 10 }) as ShapeClip;
    c.name = name;
    const t = createTrack(name);
    t.clips.push(c);
    doc.tracks.push(t);
    return c.id;
  };
  const pins = [add("Pin TL", -500, -500), add("Pin BR", 500, 500)];
  const star = add("Star", 0, 200);
  const world = groupClips(doc, [...pins, star], "World")!;
  const camera = groupClips(doc, [world], "Camera")!;
  (clipByIdIn(doc, camera) as GroupClip).transform.scale = 2;
  const w = clipByIdIn(doc, world) as GroupClip;
  if (pan === "driven") {
    doc.expressions.push({ id: "fx_pan", source: "-100", name: "" });
    w.drivers = { y: fxToken("fx_pan") };
  } else {
    w.keyframes.push(keyframeTrackSchema.parse({ id: "t", property: "y", keys: [{ id: "k0", timeMs: 0, value: -100, easing: { kind: "linear" } }] }));
  }
  const at = resolvedDocAt(doc, 500, frameId);
  return apply(groupChainMatrix(at, star, () => 500), { x: 0, y: 200 });
}

describe("group pivot at rest", () => {
  it("zooms about the same point whether the pan is keyed or driven", () => {
    for (const pan of ["keyed", "driven"] as const) {
      const p = rig(pan);
      expect(p.x).toBeCloseTo(0, 6);
      expect(p.y).toBeCloseTo(2 * (200 - 100), 6);
    }
  });
});
