"use client";

import {
  centerMatrix,
  groupChainMatrix,
  groupChainPlacement,
  locateClip,
  multiply,
  paintContextAt,
  enterContext,
  resolveClipContext,
  resolveEditContext,
  resolveFrameContext,
  toArray,
  worldToTargetScale,
  type MotionDocument,
  type EditContext,
  type Frame,
  type Mat2D,
  type Vec2,
} from "@solomotion/core";
import { useSession, useStageView } from "../state/session";
import type { NavState } from "../state/navigation";
import { clipLocalClamped } from "../inspector/animatable";
import { peekDoc } from "../state/document-context";

/**
 * THE STAGE'S COORDINATE SEAM — screen ⇄ world ⇄ the space a layer's transform
 * is actually written in, for whatever you are editing, at whatever depth.
 *
 * Every overlay used to carry its own copy of one expression:
 *
 *     world.x - (frame.x + frame.width / 2)
 *
 * That is the page-board position of a FREE-STANDING ARTBOARD. It is correct
 * only at depth 0. One hop in — a component, a nested comp, a flipbook cell's
 * drawing — the frame you are editing is not on the board at all: it lives on
 * the internal shelf with a leftover `x/y` nobody paints at, while its picture
 * is composed into the scene through the hop chain. So the brush measured a
 * stroke against an empty rectangle far from the artwork, handed the result to
 * a renderer that placed it through the chain, and the mark landed somewhere
 * else — outside the lit area, dimmed by the isolation scrim, with onion skins
 * ghosting a region nothing was in. Two coordinate authorities, one picture.
 *
 * There is one authority now: `EditContext.matrix`. This module wraps it in the
 * four mappings a surface actually asks for, plus `applyTo` so a canvas can be
 * put into local space once and then draw in the numbers the document stores.
 *
 * LOCAL means FRAME-CENTRE — origin at the middle of the comp, the space
 * `transform.x/y` lives in — because that is the space the overlays, the
 * inspector and the schema already agree on.
 */
export interface EditSpace {
  ctx: EditContext;
  /** The comp these coordinates belong to (`ctx.target`). */
  frame: Frame;
  /** Frame-centre local → world. */
  toWorld(p: Vec2): Vec2;
  /** World → frame-centre local. */
  fromWorld(p: Vec2): Vec2;
  /** Frame-centre local → canvas px (the overlay's own client coords). */
  toScreen(p: Vec2): Vec2;
  /** Canvas px → frame-centre local. */
  fromScreen(p: Vec2): Vec2;
  /**
   * Local units per SCREEN pixel. Multiply any screen-space tolerance — a
   * stabilizer leash, a snap radius, a simplify epsilon, a handle hit slop — by
   * this before comparing it against local distances, or the tool gets looser
   * the further you zoom in and tighter inside a scaled comp.
   */
  pxToLocal: number;
  /** Local units per WORLD unit (the hop chain's inverse scale; 1 at the root). */
  worldToLocal: number;
  /** Put a 2D context into local space: draw in document coordinates after this. */
  applyTo(g: CanvasRenderingContext2D): void;
}

/** The view transform, as its own matrix (world → canvas px). */
function viewMatrix(): Mat2D {
  const v = useStageView.getState();
  return { a: v.scale, b: 0, c: 0, d: v.scale, e: v.tx, f: v.ty };
}

/**
 * `pre` is a matrix applied INSIDE the comp before its chain — how a group's
 * delta joins the mapping without a second coordinate authority. Omitted for a
 * plain comp space, which is every caller that predates groups.
 */
export function editSpaceOf(ctx: EditContext, pre?: Mat2D): EditSpace {
  const base = centerMatrix(ctx);
  const m = pre ? multiply(base, pre) : base;
  const inv = invertOrIdentity(m);
  const worldToLocal = worldToTargetScale(ctx);
  return {
    ctx,
    frame: ctx.target,
    toWorld: (p) => applyM(m, p),
    fromWorld: (p) => applyM(inv, p),
    toScreen: (p) => {
      const w = applyM(m, p);
      const v = useStageView.getState();
      return { x: v.tx + w.x * v.scale, y: v.ty + w.y * v.scale };
    },
    fromScreen: (p) => {
      const v = useStageView.getState();
      return applyM(inv, { x: (p.x - v.tx) / v.scale, y: (p.y - v.ty) / v.scale });
    },
    // Read at USE, like `toScreen`: a space held across a zoom (a cached
    // render, a long drag) must not carry the scale it was made at.
    get pxToLocal() {
      return worldToLocal / Math.max(1e-6, useStageView.getState().scale);
    },
    worldToLocal,
    applyTo: (g) => {
      const v = viewMatrix();
      g.transform(v.a, v.b, v.c, v.d, v.e, v.f);
      g.transform(...toArray(m));
    },
  };
}

function applyM(m: Mat2D, p: Vec2): Vec2 {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

function invertOrIdentity(m: Mat2D): Mat2D {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

/** The space of wherever the user is STANDING (the open timeline's comp). */
export function navSpace(doc: MotionDocument | null = peekDoc()): EditSpace | null {
  const session = useSession.getState();
  if (!doc || !session.nav.path.rootFrameId) return null;
  const ctx = resolveEditContext(doc, session.nav.path, session.playheadMs);
  return ctx ? editSpaceOf(ctx) : null;
}

/**
 * The space ONE CLIP lives in — resolved from the clip, not from where the user
 * happens to be standing.
 *
 * This is the mapping a tool wants, because a gesture is always ABOUT something:
 * a stroke lands in a layer, a node drag edits a path, a motion path belongs to
 * a clip. That layer may sit one or more hops below the open timeline (a
 * flipbook cell's paint layer under the playhead; a layer selected from the
 * Layers panel without drilling in), and its space is its own, not the
 * timeline's. Falls back to the standing space for a clip that cannot be
 * placed — which is exactly the old behaviour at depth 0.
 */
export function clipSpace(clipId: string, doc: MotionDocument | null = peekDoc()): EditSpace | null {
  const session = useSession.getState();
  if (!doc || !session.nav.path.rootFrameId) return null;
  const found = resolveClipContext(doc, session.nav.path, session.playheadMs, clipId);
  return found ? editSpaceOf(found.ctx) : navSpace(doc);
}

/**
 * The space a FRAME currently occupies on the canvas.
 *
 * Use this — never `frame.x + frame.width / 2` — whenever you hold a frame and
 * need to map a point in or out of it. A frame reached by drilling is painted
 * through the hop chain, and its stored page coordinates point at an empty part
 * of the board.
 */
export function frameSpace(frameId: string, doc: MotionDocument | null = peekDoc(), at: SpaceMoment = liveMoment()): EditSpace | null {
  if (!doc || !at.path.rootFrameId) return null;
  const ctx = resolveFrameContext(doc, at.path, at.playheadMs, frameId);
  return ctx ? editSpaceOf(ctx) : null;
}

/**
 * Where and when a space is resolved: the drill path and the playhead. A
 * handler takes the live session's; a VIEW passes the values it subscribed to,
 * so its render depends on them through React instead of reading the session
 * behind it.
 */
export interface SpaceMoment {
  path: NavState["path"];
  playheadMs: number;
}

function liveMoment(): SpaceMoment {
  const s = useSession.getState();
  return { path: s.nav.path, playheadMs: s.playheadMs };
}

/**
 * The space ONE HOP DEEPER — the inside of a clip in the current space.
 *
 * A tool sometimes has to act one level below where the user is standing: a
 * brush stroke on a flipbook sheet lands in the cell under the playhead, not on
 * the sheet. That is a real hop through the real chain (trim, speed, pose and
 * all), not a special case to hand-map, and it never moves the user's
 * navigation.
 */
export function enterSpace(
  space: EditSpace,
  clipId: string,
  doc: MotionDocument | null = peekDoc(),
): EditSpace | null {
  const ctx = doc ? enterContext(doc, space.ctx, clipId) : null;
  return ctx ? editSpaceOf(ctx) : null;
}

/**
 * THE SPACE A NEW THING IS MADE IN — one answer for every tool.
 *
 * Almost always this is simply where you are standing. The exception is a
 * FLIPBOOK, where standing on the sheet means standing on a stack of frames:
 * what you make belongs to the one under the playhead, not to the sheet that
 * holds them. `paintContextAt` is the headless rule for that, and it has been
 * right for a long time — it was just private to the brush.
 *
 * So the pen and the brush landed in the cell while the shape tool, the text
 * tool and every drop target made things in the SHEET, one level up, floating
 * over every frame at once. Two answers to "where does this go", chosen by
 * which tool you happened to be holding.
 *
 * Null means a flipbook GAP: the playhead is over a slot with no frame in it,
 * so there is genuinely nowhere to put anything yet. That is not a failure —
 * it is the signal to materialise the slot first (`materializeArmedCell`).
 */
export function authoringSpace(doc: MotionDocument | null = peekDoc()): EditSpace | null {
  const stand = navSpace(doc);
  if (!stand || !doc) return null;
  const session = useSession.getState();
  const pc = paintContextAt(doc, stand.frame.id, session.playheadMs, session.selectedClipIds);
  if (!pc) return null;
  return pc.cell ? (enterSpace(stand, pc.cell.id, doc) ?? stand) : stand;
}

/**
 * THE frame a newly created thing belongs to, when you are DRILLED IN.
 *
 * One rule, stated once: while you are inside something, everything you make is
 * made there. Not in whichever artboard the cursor's world point happens to sit
 * inside — that test belongs to the top level, where artboards are laid out
 * side by side on a board and picking one by rectangle is exactly right (Figma).
 * One hop in, the rectangle test is meaningless: the comp you are editing is
 * painted THROUGH its instance, usually right on top of the parent artboard, so
 * the test picks the parent and the thing you drew falls out of the level you
 * were standing in.
 *
 * That is why a pen stroke drafted inside a flipbook cell used to commit as a
 * path in the page frame behind it. Returns null at the top level, where the
 * caller's own board hit-test is the right answer.
 */
export function standingFrameId(doc: MotionDocument | null = peekDoc()): string | null {
  const space = authoringSpace(doc) ?? navSpace(doc);
  return space && space.ctx.depth > 0 ? space.frame.id : null;
}

/* ─────────────────────────────────────────────────── a LAYER'S own space ── */

/**
 * THE SPACE ONE LAYER'S GEOMETRY IS WRITTEN IN — its comp's chain, plus every
 * GROUP that encloses it.
 *
 * `frameSpace` answers for a comp, and for a long time that was taken to be the
 * whole story: a layer's `transform.x/y` is measured from its comp's centre, so
 * map that point through the comp's chain and you are done. A group breaks it.
 * A group does not re-author what it holds — the members keep their own comp
 * coordinates, and the group carries a DELTA that moves, turns and scales the
 * lot on top (core `group-space.ts`). So a grouped layer's real place in its
 * comp is its own position CARRIED THROUGH that delta, at every level.
 *
 * Nothing outside the renderer knew that. The selection box looked right
 * because it is built from the renderer's own hit rects, which go through the
 * chain; every control drawn beside it — the pivot crosshair, the corner-radius
 * dots, the shape handles, the pen nodes, the gradient knobs, the snap lines —
 * came through `frameSpace` and landed exactly one group-delta away. Hence
 * "the border is always right but the roundness is always misplaced".
 *
 * Use this wherever you hold a CLIP. `frameSpace` remains correct, and remains
 * the right call, when the subject is the comp itself.
 */
export function layerSpace(clipId: string, doc: MotionDocument | null = peekDoc()): EditSpace | null {
  if (!doc) return null;
  const clip = locateClip(doc, clipId)?.clip;
  if (!clip || clip.kind === "audio") return null;
  const session = useSession.getState();
  if (!session.nav.path.rootFrameId) return null;
  const ctx = resolveFrameContext(doc, session.nav.path, session.playheadMs, clip.frameId);
  if (!ctx) return null;
  return editSpaceOf(ctx, groupChainMatrix(doc, clipId, (g) => clipLocalClamped(g, session.playheadMs)));
}

/**
 * The scale and rotation every enclosing container adds to a layer — the comp
 * hops AND the groups, in one number each.
 *
 * A handle is drawn at the size and angle it LOOKS, not the size and angle the
 * layer happens to carry, so every affordance multiplies its own pose by this.
 * Splitting it across two call sites is how the corner dots ended up the right
 * size inside a nested comp and the wrong size inside a scaled group.
 */
export function layerPlacement(
  clipId: string,
  doc: MotionDocument | null = peekDoc(),
): { scaleX: number; scaleY: number; rotation: number } {
  const flat = { scaleX: 1, scaleY: 1, rotation: 0 };
  if (!doc) return flat;
  const clip = locateClip(doc, clipId)?.clip;
  if (!clip || clip.kind === "audio") return flat;
  const session = useSession.getState();
  const g = groupChainPlacement(doc, clipId, (x) => clipLocalClamped(x, session.playheadMs));
  const comp = frameSpace(clip.frameId, doc)?.ctx;
  return {
    scaleX: g.scaleX * (comp?.scaleX ?? 1),
    scaleY: g.scaleY * (comp?.scaleY ?? 1),
    rotation: g.rotation + (comp?.rotation ?? 0),
  };
}
