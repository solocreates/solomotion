"use client";

import {
  clipBox,
  hostContour,
  hostLocalTime,
  hostPolylinesAt,
  isPathText,
  pathHostOf,
  placeGlyphsOnPath,
  poseBounds,
  type MotionDocument,
  type GlyphAdvance,
  type KeyframeValue,
  type LayerBox,
  type PathGlyphPose,
  type PathHostClip,
  type PathPlacementSpec,
  type Polyline,
  type TextClip,
} from "@solomotion/core";
import type { TextLayout } from "./text-layout";

/**
 * TEXT ON A PATH — the web half: a laid-out block meets its host's outline.
 *
 * Core owns the map (`text/on-path.ts`); this file only feeds it what the web
 * knows and core cannot — the measured glyph advances — and hands the poses
 * to whoever asks. The canvas painter, the buffer sizer, the caret overlay and
 * the slide handle all call `planTextOnPath` with the same layout, so a
 * letter is in one place.
 */

export interface OnPathPlan {
  host: PathHostClip;
  /** The contour the text rides, at the host's instant. */
  pl: Polyline;
  spec: PathPlacementSpec;
  /** One pose per LAID glyph, in the host's local space. */
  poses: PathGlyphPose[];
  /** The host's pivot box — the text's box while bound. */
  box: LayerBox;
}

/** The spec with its keyframed numbers sampled at this instant. */
export function sampledPathSpec(clip: TextClip & { path: NonNullable<TextClip["path"]> }, sampled: Record<string, KeyframeValue>): PathPlacementSpec {
  const n = (k: string, d: number) => (typeof sampled[k] === "number" ? (sampled[k] as number) : d);
  return {
    offset: n("path.offset", clip.path.offset),
    rise: n("path.rise", clip.path.rise),
    flip: clip.path.flip,
    follow: clip.path.follow,
    loop: clip.path.loop,
  };
}

/** The layout's glyphs as advances: x along the baseline, dy below the first line. */
export function layoutAdvances(layout: TextLayout): GlyphAdvance[] {
  let firstBaseline = Infinity;
  for (const g of layout.glyphs) firstBaseline = Math.min(firstBaseline, g.y);
  if (!Number.isFinite(firstBaseline)) firstBaseline = 0;
  return layout.glyphs.map((g) => ({ x: g.x, width: g.width, dy: g.y - firstBaseline }));
}

/**
 * Where every glyph of this text goes, or null when the text is not on a path
 * (or its host cannot be found — then it draws as plain text, by design).
 *
 * `localMs` is the TEXT's local time; the host's instant is derived from the
 * comp time the two share, so a host that starts later still shows the text
 * its outline at the right moment.
 */
export function planTextOnPath(
  doc: MotionDocument,
  clip: TextClip,
  layout: TextLayout,
  localMs: number,
  sampled: Record<string, KeyframeValue>,
): OnPathPlan | null {
  if (!isPathText(clip)) return null;
  const host = pathHostOf(doc, clip);
  if (!host) return null;
  const compMs = clip.startMs + localMs;
  const pl = hostContour(hostPolylinesAt(host, hostLocalTime(host, compMs)), clip.path.contour);
  if (!pl) return null;
  const spec = sampledPathSpec(clip, sampled);
  const poses = placeGlyphsOnPath(layoutAdvances(layout), pl, spec, clip.style.align);
  return { host, pl, spec, poses, box: clipBox(doc, host) };
}

/**
 * What a text on a path INKS, in the host's local space: every visible glyph's
 * pose grown by the glyph's own reach — its half-advance along the baseline
 * and its line height above and below, whichever way it is turned.
 */
export function onPathExtent(plan: OnPathPlan, layout: TextLayout): { minX: number; minY: number; maxX: number; maxY: number } {
  let reach = 0;
  for (const g of layout.glyphs) {
    reach = Math.max(reach, g.width / 2, g.style.fontSize * Math.max(1, g.style.lineHeight));
  }
  const b = poseBounds(plan.poses, reach + Math.abs(plan.spec.rise));
  if (b) return b;
  // Nothing visible: a point on the path is still where the layer "is".
  const p = plan.pl.pts[0] ?? { x: 0, y: 0 };
  return { minX: p.x - 1, minY: p.y - 1, maxX: p.x + 1, maxY: p.y + 1 };
}
