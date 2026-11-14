import { mapLocal, type LayerBasis, type LayerBox } from "../transform-map";
import type { AnchorPoint, Vec2 } from "../schema/common";

/**
 * MEASUREMENT — where was this layer, and how fast is it going?
 *
 * The floor under motion blur, and deliberately under more than that. One
 * function answers a question five surfaces ask, so they cannot answer it five
 * different ways:
 *
 *   the significance test    is this worth blurring at all?      (`px`)
 *   the sample count         how many samples do the pixels need? (`px`)
 *   the `velocity` tier      which way, and how far, do I smear?  (`dx, dy`)
 *   `#layer.speed` etc.      what does an expression see?         (all)
 *   the timeline (later)     shade the spans that move fast       (`px`)
 *
 * It is pure geometry over `transform-map.ts` — the SAME local→world map the
 * renderer, the hit rects, the on-canvas handles and the SVG/Lottie exporters
 * already share. That is the point: a measured motion and a drawn one are the
 * same arithmetic, so a smear can never point somewhere the layer did not go.
 *
 * ── Why this takes a POSE and not a clip ─────────────────────────────────────
 *
 * Sampling a clip's pose is per-kind (text bakes opacity, shapes resolve their
 * own `scaleY`, box kinds run the track drive) and that logic already exists,
 * once, in the renderer's `buildTransformPose`. Re-deriving it here would be a
 * second answer to "where is this layer", which is exactly the defect class
 * this codebase keeps deleting. So the caller supplies the pose sampler it
 * already has, and this file owns only the part nobody else owns: turning two
 * poses into a distance.
 */

/**
 * The transform channels, sampled at one instant. Structurally identical to the
 * renderer's `TransformPose` — stated here so core does not have to import from
 * a canvas module to describe a position.
 */
export interface LayerPose {
  x: number;
  y: number;
  scale: number;
  scaleY: number;
  rotation: number;
  skewX: number;
  skewY: number;
  anchor: AnchorPoint;
}

/** A layer's box corners in FRAME space: TL, TR, BR, BL. */
export type Quad = [Vec2, Vec2, Vec2, Vec2];

export interface LayerMotion {
  /**
   * The MAXIMUM corner travel, in frame px. The max and not the mean, because
   * that is what decides whether the eye sees a smear: a layer spinning about
   * its own centre has zero centre displacement and very visible motion, and a
   * centre-based measure would declare it still.
   */
  px: number;
  /** Mean translation of the whole quad — the direction a `velocity` tier smears. */
  dx: number;
  dy: number;
  /** Signed rotation across the interval, degrees. */
  rotationDeg: number;
  /** Scale ratio across the interval (1 = none). Growth is motion too. */
  scaleRatio: number;
}

export const NO_MOTION: LayerMotion = { px: 0, dx: 0, dy: 0, rotationDeg: 0, scaleRatio: 1 };

function basis(pose: LayerPose, box: LayerBox): LayerBasis {
  return {
    scale: pose.scale,
    scaleY: pose.scaleY,
    rotation: pose.rotation,
    skewX: pose.skewX,
    skewY: pose.skewY,
    anchor: pose.anchor,
    size: box,
  };
}

/**
 * The layer's four corners in frame space under one pose.
 *
 * Corners, rather than the centre, because every interesting motion a corner
 * sees is invisible at the centre — rotation, scale, shear and a pivoted swing
 * all move the silhouette while leaving the middle exactly where it was.
 *
 * `box` is the PIVOT BOX (what the normalized anchor is a fraction of);
 * `extent` is what the layer actually PAINTS, and defaults to the box because
 * for most layers they are the same rectangle. They part company the moment a
 * layer is cropped — see `cropWindow`, which states the split — and passing the
 * extent as the box instead resolves the pivot against a rectangle the painter
 * never used, which moves the quad by the crop's own offset times the scale.
 */
export function poseQuad(pose: LayerPose, box: LayerBox, extent: LayerBox = box): Quad {
  const b = basis(pose, box);
  const hw = extent.width / 2;
  const hh = extent.height / 2;
  const corner = (lx: number, ly: number): Vec2 => {
    const o = mapLocal(extent.cx + lx, extent.cy + ly, b);
    return { x: pose.x + o.x, y: pose.y + o.y };
  };
  return [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)];
}

/**
 * How far the layer travelled between two poses.
 *
 * `px` is the largest distance any corner covered. This one number is the whole
 * performance story of motion blur: below a threshold there is nothing to
 * integrate, so the renderer returns before it allocates a buffer, and a layer
 * that does not move costs one subtraction no matter how the shutter is set.
 * That is what makes motion blur affordable to leave switched on.
 */
export function poseMotion(a: LayerPose, b: LayerPose, box: LayerBox): LayerMotion {
  return {
    ...quadMotion(poseQuad(a, box), poseQuad(b, box)),
    rotationDeg: b.rotation - a.rotation,
    scaleRatio: a.scale === 0 ? 1 : b.scale / a.scale,
  };
}

/**
 * The same measurement, from two quads the caller already has.
 *
 * This is the half the RENDERER needs. A layer's placement on the stage is its
 * transform composed with its in/out animation pose and, mid-transition, with
 * the transition's pose too — a product of matrices, not a `LayerPose`. Measure
 * the corners it actually lands on and every one of those contributes to the
 * blur without this file having to know any of them exist. It is also why a
 * layer that flies in blurs correctly with no special case.
 */
export function quadMotion(qa: Quad, qb: Quad): LayerMotion {
  let px = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < 4; i++) {
    const dx = qb[i]!.x - qa[i]!.x;
    const dy = qb[i]!.y - qa[i]!.y;
    px = Math.max(px, Math.hypot(dx, dy));
    sx += dx;
    sy += dy;
  }
  return { px, dx: sx / 4, dy: sy / 4, rotationDeg: 0, scaleRatio: 1 };
}

/**
 * Below this much corner travel across the open shutter, there is nothing to
 * see and we do not blur.
 *
 * Three quarters of a pixel: a smear shorter than that cannot be told from
 * anti-aliasing, but drawing it still swaps the layer from its crisp raster to
 * a resampled, averaged one. At a third of a pixel that swap fired on the slow
 * end of every ease, frame on, frame off — the "small moves blink" bug. Above
 * this the blur does not switch on, it FADES in (`MOTION_FULL_PX`).
 */
export const MOTION_EPSILON_PX = 0.75;

/**
 * Travel at which motion blur reaches its full strength. Between the epsilon
 * and this, strength ramps smoothly with speed, so a layer easing to a stop
 * loses its blur continuously instead of popping sharp — and since it is a pure
 * function of measured travel, export and preview fade identically.
 */
export const MOTION_FULL_PX = 3;

/** Frame px of travel each sample should cover. See `resolveShutter`. */
export const SAMPLE_SPACING_PX = 1.5;

/**
 * Speed in frame px per second — what `#layer.speed` reports.
 *
 * Per SECOND and not per frame, deliberately: a value an expression reads must
 * not silently change meaning when the comp's rate does. A layer crossing 600px
 * in a second is doing that at 12fps and at 60fps alike, and an expression
 * written against it keeps working when the sheet is re-rated.
 */
export function motionSpeed(m: LayerMotion, intervalMs: number): number {
  return intervalMs <= 0 ? 0 : (m.px / intervalMs) * 1000;
}

/** Direction of travel in degrees (0 = +x, clockwise in screen space). */
export function motionHeading(m: LayerMotion): number {
  return (Math.atan2(m.dy, m.dx) * 180) / Math.PI;
}
