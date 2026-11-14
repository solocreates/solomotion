/**
 * THE edit context — one resolved answer to "where am I, what am I editing, and
 * where on the stage does it live?".
 *
 * Every surface reads this and nothing else: the stage (what to paint, what to
 * dim, where to place inner hit rects), the timeline (whose clips to show), the
 * breadcrumb, the inspector, playback (which frames advance, at what time), the
 * exporter. Before this, four files each re-derived their own half-answer with
 * subtly different rules — including two that disagreed about whether the
 * playhead was root time or target time.
 *
 * THE TIME RULE, stated once: `playheadMs` is ALWAYS the local time of the
 * TARGET comp (the timeline you are looking at). Ancestor times are derived
 * upward through each nested clip's trim + speed. Nothing maps downward, so
 * there is no second interpretation to get wrong.
 *
 * THE SPACE RULE, stated once: `matrix` maps the TARGET's own local coordinates
 * (origin at its top-left) into WORLD space, composing every hop's pose. A
 * surface that can map a point can therefore hit-test, drag, snap and draw
 * inside a deeply nested comp without knowing anything about nesting.
 *
 * `matrix` is the ONLY authority on where an edit target lives. A source frame
 * still carries an `x`/`y`, but that is PAGE-BOARD LAYOUT for a frame shown as
 * a free-standing artboard — it is not a coordinate origin, and reading it as
 * one is wrong the moment you are one hop deep. Every surface that used to
 * write `frame.x + frame.width / 2` is a bug waiting for a nested comp: the
 * stroke is measured against a rectangle nothing is painted in, which is
 * exactly the "my drawing lands in an empty area off to the side, dimmed"
 * report. Map through the context or do not map at all.
 *
 * There is no isolated/in-place split any more. You always edit where the
 * instance is painted, in the real scene, at the same camera. A second
 * placement mode meant a second answer to "where is the target", and the two
 * answers drifted.
 */

import { sampledScaleY } from "../animation/uniform-scale";
import { clipLocalTime } from "../animation/evaluate";
import { sampleKeyframes } from "../animation/keyframes";
import type { AnchorPoint, MotionDocument, Clip, Frame, KeyframeValue } from "../schema";
import { anchorLocal, CENTER_ANCHOR } from "../transform-map";
import { clipLocalTimeAtSource, clipSourceTimeAt } from "../timeline/ops";
import {
  frameEvalTimeMs,
  frameFps,
  frameIndexToMs,
  frameStillMs,
  frameStepMs,
  msToFrameIndex,
  quantizeMsToFrame,
} from "../timeline/fps";
import {
  IDENTITY,
  apply,
  applyInverse,
  boundsOf,
  multiply,
  quadOf,
  rotation as rotationM,
  scaling,
  shear,
  translation,
  type Mat2D,
  type Vec2,
} from "./matrix";
import { editPath, walkPath, type EditPath, type PathLink } from "./path";
import { frameWorkspace, type EditScopeKind, type ScopeWorkspace } from "./scope";

/** The sampled pose of a nested clip at an instant — its hop of the chain. */
export interface HopPose {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  skewX: number;
  skewY: number;
  /** Normalized PIVOT of the nested clip — where its position sits in its box. */
  anchor: AnchorPoint;
}

export interface ResolvedHop {
  clipId: string;
  clip: Clip;
  kind: EditScopeKind;
  parent: Frame;
  child: Frame;
  /** Parent-comp local time at the current playhead. */
  parentTimeMs: number;
  /** Child-comp local time at the current playhead. */
  childTimeMs: number;
  pose: HopPose;
  /** parent-local → child-local placement for this hop alone. */
  matrix: Mat2D;
}

export interface EditContext {
  path: EditPath;
  root: Frame;
  target: Frame;
  hops: ResolvedHop[];
  depth: number;
  workspace: ScopeWorkspace;
  /** Target-local (origin top-left) → world. */
  matrix: Mat2D;
  /** Cumulative pose of the target as painted on stage. */
  scaleX: number;
  scaleY: number;
  rotation: number;
  /** The target's local time = the playhead, by definition. */
  targetTimeMs: number;
  /** Every frame on the path → its local time at this playhead (root included). */
  frameTimes: Map<string, number>;
  /**
   * The frame that stays LIT while drilled — always the ROOT page frame, since
   * it is the thing actually painting the picture you are editing into. Null at
   * the top level (nothing is dimmed).
   */
  isolationFrameId: string | null;
  /** The frame whose media/audio is conducted (the one that paints pixels). */
  conductFrameId: string;
  conductTimeMs: number;
  /**
   * Non-null when the target sits beneath a STATIC frame and the playhead asks
   * for an instant the still does not show. The target's time is pinned (it is
   * `targetTimeMs`, not the playhead); this names the nested clip directly
   * under the still and the instant of its comp that would honour the ask —
   * `setStillMoment(doc, clipId, parentTimeMs, childTimeMs)` makes it true.
   */
  moment: StillMoment | null;
}

/** See `EditContext.moment`. */
export interface StillMoment {
  clipId: string;
  /** The still's own instant (the static frame's local time). */
  parentTimeMs: number;
  /** The instant of the comp directly below the still that the playhead asks for. */
  childTimeMs: number;
}

/**
 * Map a CHILD-local instant up into its parent's timeline — the exact inverse
 * of what the renderer does going down (`childTimeOf`), trim and ramps
 * included. A scope backed by something other than a nested clip carries time
 * straight through.
 */
function parentTimeOf(doc: MotionDocument, clip: Clip, childTimeMs: number): number {
  if (clip.kind !== "nested") return clip.startMs + Math.max(0, childTimeMs);
  return clip.startMs + clipLocalTimeAtSource(doc, clip, childTimeMs);
}

const ZERO_POSE: HopPose = {
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  skewX: 0,
  skewY: 0,
  anchor: CENTER_ANCHOR,
};

function num(kf: Record<string, KeyframeValue>, key: string, fallback: number): number {
  const v = kf[key];
  return typeof v === "number" ? v : fallback;
}

/** Keep a scale invertible without touching its sign (mirror). */
function nonZero(v: number): number {
  const mag = Math.max(0.0001, Math.abs(v));
  return v < 0 ? -mag : mag;
}

/** Sample a nested clip's pose at a PARENT-local time. */
export function hopPoseAt(clip: Clip, parentTimeMs: number): HopPose {
  return hopPoseAtLocal(clip, parentTimeMs - clip.startMs);
}

/**
 * Sample a nested clip's pose at a CLIP-local time — the clock the renderer
 * already holds. Callers with a local time must use this, never `hopPoseAt`:
 * passing a local time there subtracts `startMs` twice, so a layer starting
 * after 0 placed its inner hit rects (selection, gizmos) at its first key.
 */
export function hopPoseAtLocal(clip: Clip, localMs: number): HopPose {
  if (clip.kind !== "nested") return ZERO_POSE;
  const local = Math.min(Math.max(0, localMs), clip.durationMs);
  const kf = sampleKeyframes(clip.keyframes, local);
  const t = clip.transform;
  // SIGN-PRESERVING guard: a negative scale is a mirrored nested comp (see
  // resize.ts), and the hop matrix is inverted to map pointers INTO it — clamp
  // the magnitude away from zero (non-invertible) but never the sign, or every
  // click inside a mirrored comp would land on the wrong side.
  const scaleX = nonZero(num(kf, "scale", t.scale));
  const scaleY = nonZero(sampledScaleY(kf, t.scaleY) ?? scaleX);
  return {
    x: num(kf, "x", t.x),
    y: num(kf, "y", t.y),
    rotation: num(kf, "rotation", t.rotation),
    scaleX,
    scaleY,
    skewX: num(kf, "skewX", t.skewX),
    skewY: num(kf, "skewY", t.skewY),
    anchor: {
      x: num(kf, "anchor.x", t.anchor.x),
      y: num(kf, "anchor.y", t.anchor.y),
    },
  };
}

/**
 * The placement matrix of one hop: parent-local coordinates → child-local
 * coordinates. Mirrors the renderer's nested-clip transform exactly (T·R·K·S
 * about the parent's centre, then back off the child's own centre) — one
 * formula, so hit-testing and painting can never disagree.
 */
export function hopMatrix(pose: HopPose, parent: Frame, child: Frame): Mat2D {
  let m = translation(parent.width / 2 + pose.x, parent.height / 2 + pose.y);
  m = multiply(m, rotationM(pose.rotation));
  m = multiply(m, shear(pose.skewX, pose.skewY));
  m = multiply(m, scaling(pose.scaleX, pose.scaleY));
  // The nested clip's PIVOT is where its position sits, so step off it before
  // stepping to the child's top-left. Zero for a centered pivot (the default),
  // which is why this matrix was correct before pivots existed.
  const a = anchorLocal(pose.anchor, { width: child.width, height: child.height, cx: 0, cy: 0 });
  return multiply(m, translation(-a.x - child.width / 2, -a.y - child.height / 2));
}


/**
 * AN ANCESTOR'S INSTANT HAS TO BE ONE ITS OWN CLOCK CAN SHOW YOU FROM.
 *
 * Mapping the playhead up a chain gives the ancestor time that CONTAINS the
 * instant you are standing on. It does not give one the ancestor can render at,
 * and those are different things, because every comp renders on its own frame
 * grid: `drawFrameContent` floors the time it is handed to the grid of the
 * frame it is drawing, then descends into each nested clip from there.
 *
 * So a 12fps flipbook inside a 30fps page is the case that breaks. Standing on
 * the sheet's frame 2 maps up to 83.333ms — which is the frame's own START, and
 * therefore a boundary. The page floors it to its nearest 30fps instant, 66.667,
 * which is inside the sheet's frame 1, and paints frame 1. Frame 4 lands on
 * frame 3, frame 6 on frame 5: every other frame of the sheet showed its
 * predecessor while the breadcrumb, the sheet and the layers panel all said you
 * were somewhere else.
 *
 * Nothing is wrong with either clock. The boundary is: a coarser grid floors it
 * out of the frame it begins. But 100ms IS a 30fps instant and IS inside the
 * sheet's frame 2 — the moment exists, it was simply never asked for.
 *
 * So ask for it. Walk forward through the ancestor's own grid instants and take
 * the first one that descends — through exactly the steps the renderer takes —
 * back onto the frame you are standing on. The bound is the frame you occupy:
 * past its end there is nothing to find, and an ancestor grid too coarse to
 * hold one of your frames genuinely cannot show it, so the mapped time stands.
 *
 * This is a fact about what the RENDERER will do, so it is computed once here
 * and published in `frameTimes` — not re-derived by the stage, the exporter and
 * the thumbnails, which is how three surfaces come to disagree about which
 * frame is on screen.
 */
function addressableTime(
  doc: MotionDocument,
  frames: Frame[],
  links: PathLink[],
  depth: number,
  usable: number,
  mappedMs: number,
  targetMs: number,
): number {
  const here = frames[depth];
  const target = frames[usable];
  if (!here || !target) return mappedMs;
  const targetFps = frameFps(doc, target);
  const want = msToFrameIndex(targetMs, targetFps);

  /**
   * Which of the target's frames this ancestor instant actually reaches — null
   * when it reaches none, because a hop on the way is not on screen at it.
   *
   * That liveness test is the whole of the check, and leaving it out is what
   * made the first version of this a no-op: `childTimeOf` CLAMPS, so an instant
   * before a cell begins descends into it as time 0 rather than as "not there".
   * Every candidate then looked like it reached the target and the mapped time
   * was always returned unchanged — the repair ran and repaired nothing.
   */
  const reaches = (at: number): number | null => {
    let t = at;
    for (let i = depth; i < usable; i++) {
      const parent = frames[i];
      const child = frames[i + 1];
      if (!parent || !child) return null;
      const qt = frameEvalTimeMs(doc, parent, t);
      // Exactly the renderer's own rule for whether a clip paints at an instant.
      if (clipLocalTime(links[i]!.clip, qt) === null) return null;
      t = childTimeOf(doc, links[i]!.clip, qt);
    }
    return msToFrameIndex(quantizeMsToFrame(t, targetFps), targetFps);
  };

  // The mapped time usually IS addressable, and then it is returned untouched —
  // this is a repair, not a second quantisation, and `frameTimes` stays the
  // mapped local time every other reader expects.
  if (reaches(mappedMs) === want) return mappedMs;

  const fps = frameFps(doc, here);
  const from = msToFrameIndex(mappedMs, fps);
  // One of the target's frames, expressed in this ancestor's steps, plus one
  // for the boundary itself. Past that there is nothing left to find.
  const reach = Math.ceil(frameStepMs(targetFps) / frameStepMs(fps)) + 1;
  for (let n = 1; n <= reach; n++) {
    const at = frameIndexToMs(from + n, fps);
    if (reaches(at) === want) return at;
  }
  return mappedMs;
}

/**
 * Resolve a path into the full context. `path` must already be normalised
 * (`normalizePath`); an unresolvable root yields null and the caller re-roots.
 */
export function resolveEditContext(
  doc: MotionDocument,
  path: EditPath,
  playheadMs: number,
): EditContext | null {
  const root = doc.frames.find((f) => f.id === path.rootFrameId);
  if (!root) return null;
  const links = walkPath(doc, path);

  // Frames, root-first. Times run the OTHER way: the playhead is the target's
  // own local time, so we map upward through each hop's trim + speed.
  const frames: Frame[] = [root];
  for (const link of links) {
    const child = doc.frames.find((f) => f.id === link.childFrameId);
    if (!child) break;
    frames.push(child);
  }
  const usable = Math.min(links.length, frames.length - 1);
  const target = frames[usable]!;

  const times: number[] = new Array(usable + 1).fill(0);
  times[usable] = Math.max(0, playheadMs);
  for (let i = usable - 1; i >= 0; i--) {
    times[i] = parentTimeOf(doc, links[i]!.clip, times[i + 1]!);
  }
  // …and then made ADDRESSABLE, which mapping alone does not make them.
  for (let i = 0; i < usable; i++) {
    times[i] = addressableTime(doc, frames, links, i, usable, times[i]!, times[usable]!);
  }

  // …and PINNED beneath a still. A static frame shows one instant whatever it
  // is asked, so everything below the deepest one on the path is not free: it
  // is wherever the still maps it. The playhead you asked for survives as
  // `moment` — the edit that would make the still show it.
  //
  // Above it nothing is asked of time either — a still is the same picture at
  // every instant — so the ancestors stand where they show the still at its
  // own instant, and scrubbing inside a still never moves the page around it.
  let moment: StillMoment | null = null;
  let still = -1;
  for (let i = 0; i < usable; i++) if (frames[i]!.mode === "static") still = i;
  if (still >= 0) {
    const asked = times[still + 1]!;
    times[still] = frameStillMs(frames[still]!) ?? 0;
    for (let i = still - 1; i >= 0; i--) times[i] = parentTimeOf(doc, links[i]!.clip, times[i + 1]!);
    for (let i = 0; i < still; i++) times[i] = addressableTime(doc, frames, links, i, still, times[i]!, times[still]!);
    for (let i = still; i < usable; i++) times[i + 1] = childTimeOf(doc, links[i]!.clip, times[i]!);
    if (Math.abs(times[usable]! - Math.max(0, playheadMs)) > 0.5) {
      moment = { clipId: links[still]!.clipId, parentTimeMs: frameStillMs(frames[still]!) ?? 0, childTimeMs: asked };
    }
  }

  // Space runs root-first: world = T(root.x, root.y) · hop₀ · hop₁ · …
  let matrix = translation(root.x, root.y);
  let scaleX = 1;
  let scaleY = 1;
  let rot = 0;
  const hops: ResolvedHop[] = [];
  for (let i = 0; i < usable; i++) {
    const link = links[i] as PathLink;
    const parent = frames[i]!;
    const child = frames[i + 1]!;
    const pose = hopPoseAt(link.clip, times[i]!);
    const m = hopMatrix(pose, parent, child);
    matrix = multiply(matrix, m);
    scaleX *= pose.scaleX;
    scaleY *= pose.scaleY;
    rot += pose.rotation;
    hops.push({
      clipId: link.clipId,
      clip: link.clip,
      kind: link.kind,
      parent,
      child,
      parentTimeMs: times[i]!,
      childTimeMs: times[i + 1]!,
      pose,
      matrix: m,
    });
  }

  const frameTimes = new Map<string, number>();
  for (let i = 0; i <= usable; i++) frameTimes.set(frames[i]!.id, times[i]!);

  // The ROOT is what actually paints the picture at any depth, so it conducts
  // and it is the frame that stays lit.
  return {
    path,
    root,
    target,
    hops,
    depth: usable,
    workspace: frameWorkspace(target),
    matrix,
    scaleX,
    scaleY,
    rotation: rot,
    targetTimeMs: times[usable]!,
    frameTimes,
    isolationFrameId: usable === 0 ? null : root.id,
    conductFrameId: root.id,
    conductTimeMs: times[0]!,
    moment,
  };
}

/** A context for a bare frame with no drilling — the top-level case. */
export function rootContext(doc: MotionDocument, frameId: string, playheadMs: number): EditContext | null {
  return resolveEditContext(doc, editPath(frameId), playheadMs);
}

/* ------------------------------------------------------------------ geometry */

/** World point → target-local point. The inverse of `ctx.matrix`. */
export function worldToTarget(ctx: EditContext, p: Vec2): Vec2 {
  return applyInverse(ctx.matrix, p);
}

/** Target-local point → world point. */
export function targetToWorld(ctx: EditContext, p: Vec2): Vec2 {
  return apply(ctx.matrix, p);
}

/**
 * Convert a WORLD-space delta (what a pointer drag measures) into the target's
 * OWN local space — the space a clip's transform actually lives in. Identity at
 * the top level; at depth it undoes the cumulative scale, rotation and shear of
 * the instance you are editing through, so dragging a layer inside a half-size
 * rotated component moves it exactly as far as the cursor went and in the
 * direction the cursor went.
 */
export function worldDeltaToTarget(ctx: EditContext, dx: number, dy: number): Vec2 {
  if (ctx.depth === 0) return { x: dx, y: dy };
  const linear: Mat2D = { ...ctx.matrix, e: 0, f: 0 };
  return applyInverse(linear, { x: dx, y: dy });
}

/**
 * THE overlay mapping: the target's FRAME-CENTRE coordinates → world.
 *
 * Frame-centre (origin at the middle of the comp) is the space every clip's
 * `transform.x/y` is written in, so it is the space the stage overlays draw,
 * hit-test and place in. Composed once here — `T(centre) ` folded into the hop
 * chain — so an overlay can `setTransform` with it and then think purely in the
 * coordinates the document stores, at any nesting depth.
 *
 * This replaces the `frame.x + frame.width / 2` that seven surfaces each wrote
 * for themselves. That expression is the page-board position of a free-standing
 * artboard; it is only accidentally correct at depth 0 and is silently wrong
 * everywhere else.
 */
export function centerMatrix(ctx: EditContext): Mat2D {
  return multiply(ctx.matrix, translation(ctx.target.width / 2, ctx.target.height / 2));
}

/** Frame-centre local → world. */
export function centerToWorld(ctx: EditContext, p: Vec2): Vec2 {
  return apply(centerMatrix(ctx), p);
}

/** World → frame-centre local. */
export function worldToCenter(ctx: EditContext, p: Vec2): Vec2 {
  return applyInverse(centerMatrix(ctx), p);
}

/**
 * How many TARGET-LOCAL units one world unit spans — the scalar a screen-space
 * tolerance (a stabilizer leash, a snap radius, a simplify epsilon) has to be
 * divided by before it means anything inside a scaled comp. Geometric mean of
 * the two axes, so a non-uniform scale gives one honest average rather than
 * picking a side.
 */
export function worldToTargetScale(ctx: EditContext): number {
  return 1 / Math.sqrt(Math.abs(ctx.scaleX * ctx.scaleY) || 1);
}

/**
 * Step INTO a clip from a resolved context, carrying the instant down through
 * its trim and speed — the pure, non-navigating half of "enter". A tool that
 * must act one level deeper than the user is standing (a paint stroke landing
 * in a flipbook cell under the playhead) builds its space with this instead of
 * moving the user's navigation, and instead of hand-rolling the hop.
 */
export function enterContext(doc: MotionDocument, ctx: EditContext, clipId: string): EditContext | null {
  const hop = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
  if (!hop || hop.frameId !== ctx.target.id) return null;
  const next = editPath(ctx.path.rootFrameId, [...ctx.path.hops, clipId]);
  return resolveEditContext(doc, next, childTimeOf(doc, hop, ctx.targetTimeMs));
}

/** The target frame's four corners in world space (TL, TR, BR, BL). */
export function targetQuad(ctx: EditContext): [Vec2, Vec2, Vec2, Vec2] {
  return quadOf(ctx.matrix, ctx.target.width, ctx.target.height);
}

/** World-space AABB of the target frame — camera fitting, scrim cut-outs. */
export function targetBounds(ctx: EditContext): { minX: number; minY: number; maxX: number; maxY: number } {
  return boundsOf(ctx.matrix, ctx.target.width, ctx.target.height);
}

/** Is a world point inside the edit target's painted area? */
export function containsWorldPoint(ctx: EditContext, p: Vec2): boolean {
  const local = worldToTarget(ctx, p);
  return local.x >= 0 && local.y >= 0 && local.x <= ctx.target.width && local.y <= ctx.target.height;
}

/**
 * Map the playhead from the target's time up to an ancestor's time — the
 * breadcrumb's "jump out to here keeps the same instant" behaviour.
 */
export function timeAtDepth(ctx: EditContext, depth: number): number {
  if (depth >= ctx.depth) return ctx.targetTimeMs;
  const hop = ctx.hops[Math.max(0, depth)];
  return hop ? hop.parentTimeMs : ctx.targetTimeMs;
}

/**
 * Map an instant DOWN into a clip's inside — the time the child comp should sit
 * at when you step into it, so entering never jumps the picture. The exact
 * inverse of the upward mapping `resolveEditContext` uses, through the clip's
 * trim, speed and loop.
 */
export function childTimeOf(doc: MotionDocument, clip: Clip, parentTimeMs: number): number {
  // A STATIC parent is evaluated at its still whatever time it is handed, so
  // that is the instant its children are descended from — the renderer's rule
  // (`frameEvalTimeMs`), stated for navigation.
  const parent = doc.frames.find((f) => f.id === clip.frameId);
  const at = (parent && frameStillMs(parent)) ?? parentTimeMs;
  const local = Math.min(Math.max(0, at - clip.startMs), clip.durationMs);
  if (clip.kind !== "nested") return local;
  // THE renderer's own map (trim, ramps, loop cycle) — a second formula here is
  // how the timeline stood on one instant while the stage painted another.
  return clipSourceTimeAt(doc, clip, local);
}

/** Identity context matrix helper for callers that need a neutral value. */
export const IDENTITY_MATRIX = IDENTITY;
