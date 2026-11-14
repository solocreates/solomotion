import type { MotionDocument, VisualClip } from "../schema";
import type { GradeKey, PowerWindow } from "../schema/grade";
import type { Contour } from "../schema/vector";
import { contourAtPose } from "../tracking/contour";
import type { RegionPose } from "../tracking/pose";
import { trackContourInClip } from "../tracking/read";
import { clipShowsSource, sourceToLocalMatrix } from "../tracking/footage";
import { readDepthFrame, type DepthFrame } from "../tracking/depth/frame";
import { clipSourcePhaseAt } from "../timeline/ops";
import type { Mat2D } from "../navigation/matrix";

/**
 * POWER WINDOWS, RESOLVED — a window's silhouette in frame space at one time.
 *
 * This is the join between the colour page and the tracker, and it is one
 * function rather than an integration: a window whose source is a tracker reads
 * `trackedContour`, which reads the same bake a sticker's transform reads. There
 * is no "tracked mask" feature separate from tracking, no second contour model,
 * and no conversion step — which is why a window becomes tracked by changing
 * one field.
 *
 * Rasterising is the renderer's job. Core hands over geometry, because geometry
 * is what a canvas, a WebGL path and an SVG export each want in their own way.
 */

export interface WindowContext {
  /** Null when only drawn windows can resolve (no document in hand). */
  doc: MotionDocument | null;
  /** The graded layer — windows are drawn in ITS local space, inside its buffer. */
  clip: VisualClip | null;
  /** Its local time. */
  localMs: number;
}

export interface ResolvedWindow {
  id: string;
  /** Closed contours in FRAME space, centre-relative (empty for a depth band). */
  contours: Contour[];
  /**
   * A DEPTH BAND instead of contours: the footage's map, how its source px
   * sit in the layer's local space, and the band. The renderer fills it as a
   * raster (`deviceWindows`).
   */
  depth?: { frame: DepthFrame; toLocal: Mat2D; sourceWidth: number; sourceHeight: number; near: number; far: number; softness: number };
  feather: number;
  expand: number;
  invert: boolean;
  combine: PowerWindow["combine"];
}

/** One window's geometry now, or null when its source cannot be resolved. */
export function resolveWindow(win: PowerWindow, ctx: WindowContext): ResolvedWindow | null {
  if (!win.enabled) return null;
  let contours: Contour[] | null;

  if (win.source.type === "depth") {
    const src = win.source;
    const tracker = ctx.doc?.trackers.find((t) => t.id === src.trackerId);
    const clip = ctx.clip;
    if (!ctx.doc || !clip || tracker?.kind !== "depth" || !clipShowsSource(clip, tracker.source)) return null;
    const asset = ctx.doc.assets.find((a) => a.id === tracker.source.assetId);
    const sourceMs = clip.kind === "image" ? 0 : clipSourcePhaseAt(ctx.doc, clip, ctx.localMs).sourceMs;
    const frame = readDepthFrame(tracker, sourceMs);
    if (!frame || !asset?.width || !asset.height) return null;
    return {
      id: win.id,
      contours: [],
      depth: { frame, toLocal: sourceToLocalMatrix(ctx.doc, clip, ctx.localMs), sourceWidth: asset.width, sourceHeight: asset.height, near: src.near, far: src.far, softness: src.softness },
      feather: win.feather,
      expand: win.expand,
      invert: win.invert,
      combine: win.combine,
    };
  }
  if (win.source.type === "shape") {
    const t = win.source.transform;
    const pose: RegionPose = { x: t.x, y: t.y, scale: t.scale, scaleY: t.scaleY, rotation: t.rotation };
    contours = contourAtPose({ shape: win.source.shape, subpaths: win.source.subpaths, feather: 0, expand: 0, invert: false }, pose);
  } else {
    // The tracker's outline in this layer's own space, through the one reader.
    // A tracker that is gone, that watches other footage, or a time outside the
    // clip yields NOTHING rather than a window at the origin — a correction that
    // relocates to the corner of frame is worse than one plainly absent, and the
    // board marks the window so it is findable.
    const trackerId = win.source.trackerId;
    const tracker = ctx.doc?.trackers.find((t) => t.id === trackerId);
    contours = tracker && ctx.doc && ctx.clip ? trackContourInClip(ctx.doc, tracker, ctx.clip, ctx.localMs) : null;
  }

  if (!contours || contours.length === 0) return null;
  return {
    id: win.id,
    contours,
    feather: win.feather,
    expand: win.expand,
    invert: win.invert,
    combine: win.combine,
  };
}

/** Every resolvable window on a key, in list order. */
export function resolveWindows(key: GradeKey, ctx: WindowContext): ResolvedWindow[] {
  const out: ResolvedWindow[] = [];
  for (const w of key.windows) {
    const r = resolveWindow(w, ctx);
    if (r) out.push(r);
  }
  return out;
}

/** Windows that name a tracker which no longer exists — the board's warning. */
export function brokenWindows(key: GradeKey, has: (trackerId: string) => boolean): string[] {
  return key.windows
    .filter((w) => (w.source.type === "tracker" || w.source.type === "depth") && !has(w.source.trackerId))
    .map((w) => w.id);
}
