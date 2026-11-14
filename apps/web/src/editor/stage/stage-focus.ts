"use client";

import {
  apply,
  boundsOf,
  clipFrameBounds,
  fitCamera,
  focusAnchorOf,
  panToReveal,
  isBoundsFullyVisible,
  isBoundsVisible,
  multiply,
  resolveClipContext,
  targetBounds,
  translation,
  type AABB,
  type MotionDocument,
} from "@solomotion/core";
import { useSession, useStageView } from "../state/session";
import { hitAABB, stageHitRects } from "./stage-geometry";

/**
 * The stage half of revealing a target — the Figma-Motion twin of
 * `timelineView.focusRange`. Reads the live stage viewport size off
 * `[data-stage-drop]` (the same DOM query FramePresets already uses to center
 * a new frame), so it works from anywhere without a React ref: the conductor
 * (`state/selection-reveal.ts`) runs outside the Stage component entirely.
 */

const FOCUS_PADDING_PX = 96;

function viewportRect(): { width: number; height: number } | null {
  const el = document.querySelector("[data-stage-drop]");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return { width: r.width, height: r.height };
}

/** Is any part of this world-space AABB on screen right now? The gate every
 *  stage auto-focus decision goes through — visible at all, however zoomed
 *  or panned, means the camera is left alone. */
export function isStageBoundsVisible(bounds: AABB): boolean {
  const viewport = viewportRect();
  if (!viewport) return true; // stage not mounted/measured — don't fight the caller
  return isBoundsVisible(bounds, useStageView.getState(), viewport);
}

/** Is ALL of it on screen? The gate a NAVIGATION uses: you asked to go there,
 *  so a sliver at the edge of the canvas is not "there". */
export function isStageBoundsFullyVisible(bounds: AABB): boolean {
  const viewport = viewportRect();
  if (!viewport) return true;
  return isBoundsFullyVisible(bounds, useStageView.getState(), viewport);
}

/**
 * SMART FOCUS (D16): bring `bounds` into view without fighting the person — no
 * move while any part shows, else the smallest pan, never a zoom. The one door
 * for every focus that was not explicitly asked for (a selection, an agent's
 * edit, a reveal); `focusStageOnBounds` is the asked-for zoom-to-fit.
 */
export function revealStageBounds(bounds: AABB): void {
  const viewport = viewportRect();
  if (!viewport) return;
  const cam = useStageView.getState();
  const next = panToReveal(bounds, { scale: cam.scale, tx: cam.tx, ty: cam.ty }, viewport, FOCUS_PADDING_PX / 2);
  if (next.tx !== cam.tx || next.ty !== cam.ty) useStageView.getState().set(next);
}

/** Zoom-to-fit `bounds` (Figma's Shift+2), at the stage's live viewport size —
 *  only for a focus the person ASKED for. No-op if the stage isn't mounted. */
export function focusStageOnBounds(bounds: AABB): void {
  const viewport = viewportRect();
  if (!viewport) return;
  useStageView.getState().set(fitCamera(bounds, viewport, { paddingPx: FOCUS_PADDING_PX, maxScale: 2 }));
}

/**
 * WHERE A LAYER IS ON THE CANVAS, in world space.
 *
 * What the stage last PAINTED is the truth — animated, posed, nested — so it
 * answers when it can. It cannot right after a navigation: the page or comp you
 * just went to has not drawn yet, and waiting for a paint is a race. The
 * headless answer covers that moment: the layer's own box mapped through the
 * world matrix of the comp it is reached in, the same resolver the inspector and
 * the gizmo use. A layer with no box of its own (a group, sound) answers with
 * its comp's rect, which is still the right place to look.
 */
export function stageBoundsOfClip(doc: MotionDocument, clipId: string): AABB | null {
  const s = useSession.getState();
  const found = resolveClipContext(doc, s.nav.path, s.playheadMs, clipId);
  // Emitters, rigid bodies and force carriers focus on their ANCHOR (D16):
  // their painted bounds are particles / this frame's simulation, unstable by
  // design. A point, so the reveal is a pan to where the layer is placed.
  if (found && "transform" in found.clip && focusAnchorOf(found.clip as Parameters<typeof focusAnchorOf>[0])) {
    const p = apply(found.ctx.matrix, { x: found.clip.transform.x, y: found.clip.transform.y });
    return { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
  }
  const hit = stageHitRects.current.find((h) => h.clipId === clipId);
  if (hit) return hitAABB(hit);
  if (!found) return null;
  const local = clipFrameBounds(doc, found.clip);
  if (!local) return targetBounds(found.ctx);
  const m = multiply(found.ctx.matrix, translation(local.minX, local.minY));
  return boundsOf(m, local.maxX - local.minX, local.maxY - local.minY);
}
