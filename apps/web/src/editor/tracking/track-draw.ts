"use client";

import { createTrackerAt, subpathBounds, type TrackShape } from "@solomotion/core";
import { useSession } from "../state/session";
import { beginRegionDraw, registerRegionConsumer } from "../stage/region-draw";
import { startTrack, TRACK_FOLLOWS } from "./track-controller";

/**
 * DRAW TO TRACK — outline the thing, and it starts tracking, both ways.
 *
 * AE asks for a track point, a search box, an "Edit Target" dialog and a press
 * of Analyze; Resolve for a window, then a direction. Here the drawing IS the
 * request: the frame you drew on becomes the reference, the outline (exactly
 * as traced — the pen's curves survive) is the region, and analysis radiates
 * forward and backward from it at once. Stop, correct and resume from there.
 */
registerRegionConsumer("tracker", (store, target, contours, centre) => {
  const b = subpathBounds(contours);
  if (!b) return;
  const parametric = target.shape === "rect" || target.shape === "ellipse";
  const compMs = useSession.getState().playheadMs;
  let trackerId = "";
  store.update("Track object", (d) => {
    const tracker = createTrackerAt(d, {
      clipId: target.clipId,
      compMs,
      region: {
        shape: target.shape,
        x: centre.x,
        y: centre.y,
        width: Math.max(4, b.maxX - b.minX),
        height: Math.max(4, b.maxY - b.minY),
        // A box or an oval stays parametric (its handles resize it); a traced
        // outline is kept as traced.
        ...(parametric ? {} : { contours }),
      },
      // Drawn by hand, it is a THING: where, how big, how turned (the Follows
      // "Object" preset). Point, Surface and Outline are one click away.
      solve: { channels: [...TRACK_FOLLOWS.object] },
    });
    trackerId = tracker?.id ?? "";
  });
  if (!trackerId) return;
  useSession.getState().setActiveTracker(trackerId);
  void startTrack(store, trackerId, { kind: "all" });
});

/** Arm the stage to draw a new tracker on `clipId`'s footage. */
export function beginTrackDraw(clipId: string, shape: TrackShape): void {
  beginRegionDraw({ kind: "tracker", clipId, shape });
}

