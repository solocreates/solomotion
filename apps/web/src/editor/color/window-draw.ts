"use client";

import {
  createId,
  findVisualClip,
  toSubpaths,
  type PowerWindow,
  type TrackShape,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import { beginRegionDraw, registerRegionConsumer } from "../stage/region-draw";

/**
 * DRAWING A POWER WINDOW WITH THE REAL TOOLS.
 *
 * The shape buttons used to call `makeWindow`, which produced a default-sized
 * ellipse in the middle of the layer no matter which of the four you pressed.
 * Four buttons, one outcome — the most dishonest control on the page.
 *
 * A window's silhouette is a `Subpath[]`. So is a shape clip's. So is a pen
 * path's. There was never a reason to invent a drawing tool for this: the
 * buttons ARM THE APP'S OWN TOOL and leave a target behind, and the two places
 * that finish a drawing hand their geometry here instead of making a layer.
 * Twelve lines at each seam, and the window tool is the pen tool — including
 * its snapping, its ⇧-constrain, its node editing and everything added to it
 * later.
 *
 * The arming, the one-shot target and the two creator seams are the shared
 * region-draw module's; this file is only what a window does with the outline.
 */

/**
 * Take a finished drawing as a grade window — the `window` consumer of the one
 * region-draw seam (`stage/region-draw.ts`).
 */
registerRegionConsumer("window", (store, target, contours, centre) => {
  const doc = store.getState();
  const clip = findVisualClip(doc, target.clipId);
  if (!clip) return;

  // Frame space → the LAYER's own space, which is where a window lives so that
  // it rides its clip. Undo the clip's pose; the contour is already centred.
  const t = clip.transform;
  const rad = (-t.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = centre.x - t.x;
  const dy = centre.y - t.y;
  const local = {
    x: (dx * cos - dy * sin) / (t.scale || 1),
    y: (dx * sin + dy * cos) / (t.scaleY ?? t.scale ?? 1),
  };
  // The contour arrives in FRAME units; the layer's own scale divides out too,
  // or a window drawn over a layer at 50% would be twice the size it looked.
  const k = 1 / (t.scale || 1);
  const scaled = contours.map((c) => ({
    closed: c.closed,
    points: c.points.map((p) => ({
      ...p,
      x: p.x * k,
      y: p.y * k,
      hIn: p.hIn ? { x: p.hIn.x * k, y: p.hIn.y * k } : null,
      hOut: p.hOut ? { x: p.hOut.x * k, y: p.hOut.y * k } : null,
    })),
  }));

  const window: PowerWindow = {
    id: createId("win"),
    name: `${target.shape[0]!.toUpperCase()}${target.shape.slice(1)} window`,
    enabled: true,
    source: {
      type: "shape",
      shape: target.shape,
      subpaths: toSubpaths(scaled),
      transform: { x: Math.round(local.x), y: Math.round(local.y), scale: 1, scaleY: null, rotation: 0 },
    },
    feather: 24,
    expand: 0,
    invert: false,
    combine: "union",
  };

  store.update("Draw window", (d) => {
    const c = findVisualClip(d, target.clipId);
    const card = c?.effects.find((e) => e.id === target.cardId);
    if (card?.type !== "grade") return;
    const node = card.graph.nodes.find((n) => n.id === target.nodeId);
    if (node?.kind === "corrector") node.key.windows.push(window);
  });
  toast.success("Window drawn");
});

/** Arm a window draw on a grade node. */
export function beginWindowDraw(target: { clipId: string; cardId: string; nodeId: string; shape: TrackShape }): void {
  beginRegionDraw({ kind: "window", ...target });
}
