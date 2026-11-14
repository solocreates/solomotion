import {
  clipLocalTime,
  isClipHidden,
  isClipLocked,
  isVisualClip,
  locateClip,
  motionKeysOf,
  motionPointAt,
  motionSegmentControls,
  sampleKeyframes,
  type MotionDocument,
  type MotionKey,
  type VisualClip,
  compFps,
  frameStepMs,
  positionOrigin,
  type Vec2,
} from "@solomotion/core";
import {
  PATH_HIT,
  cubicAt,
  paintAnchor,
  paintDirectionChevrons,
  paintInsertBadge,
  paintPathStroke,
  paintTangent,
} from "./path-chrome";
import { layerSpace } from "./edit-space";
import { peekDoc } from "../state/document-context";
import { useSession } from "../state/session";

/**
 * Motion-path stage layer — headless. Builds the screen-space scene for the
 * selected clips' position keyframes (curves, anchors, tangent handles, speed
 * dots), hit-tests it, and paints it. The Stage owns the pointer and calls
 * these three functions; nothing here touches React or the DOM, so the same
 * scene drives painting AND gesture targeting from one geometry pass.
 */

export interface MotionViewport {
  scale: number;
  tx: number;
  ty: number;
}

interface ScreenPoint {
  x: number;
  y: number;
}

export interface MotionAnchorView {
  clipId: string;
  timeMs: number;
  /** Anchor + handle knobs, in screen space. */
  s: ScreenPoint;
  hIn: ScreenPoint | null;
  hOut: ScreenPoint | null;
  smooth: boolean;
}

export interface MotionSegmentView {
  clipId: string;
  a: MotionKey;
  b: MotionKey;
  /** Screen-space cubic control polygon (linear segments use the thirds). */
  sa: ScreenPoint;
  c1: ScreenPoint;
  c2: ScreenPoint;
  sb: ScreenPoint;
  curved: boolean;
}

export interface MotionClipPath {
  clipId: string;
  locked: boolean;
  /** World position of the clip's frame center — path points are offsets from it. */
  /** The comp these keys are written in — resolve its space to map in or out.
   *  NOT an origin point: at depth the mapping carries rotation and scale too. */
  frameId: string;
  anchors: MotionAnchorView[];
  segments: MotionSegmentView[];
  /**
   * Per-frame travel marks: where the layer is on each frame, and which way it
   * is heading there. Spacing still encodes TEMPO (they bunch up where the layer
   * moves slowly), and the heading now makes them read as direction too — a
   * motion path has a start and an end, unlike a vector outline, so saying which
   * way time runs is free information the shape was already carrying.
   */
  dots: Array<{ at: ScreenPoint; dir: ScreenPoint }>;
  /** Where the clip sits right now (playhead), on the path. */
  current: ScreenPoint | null;
}

export interface MotionScene {
  paths: MotionClipPath[];
}

export type MotionHit =
  | { kind: "anchor"; clipId: string; timeMs: number; locked: boolean }
  | { kind: "handle"; clipId: string; timeMs: number; end: "in" | "out"; locked: boolean }
  | { kind: "segment"; clipId: string; a: MotionKey; b: MotionKey; u: number; locked: boolean };

// Shared with the vector pen, so grabbing a motion key and grabbing a path node
// feel like the same act rather than two tools with different tolerances.
const ANCHOR_HIT = PATH_HIT.anchor;
const HANDLE_HIT = PATH_HIT.handle;
const SEGMENT_HIT = PATH_HIT.segment;

export const MOTION_ACCENT = "#8B5CF6";

/** Build the scene for every selected clip that travels (≥ 2 position keys). */
export function buildMotionScene(
  doc: MotionDocument,
  clipIds: string[],
  view: MotionViewport,
  playheadMs: number,
): MotionScene {
  const toScreen = (wx: number, wy: number): ScreenPoint => ({
    x: view.tx + wx * view.scale,
    y: view.ty + wy * view.scale,
  });

  const paths: MotionClipPath[] = [];
  for (const clipId of clipIds) {
    const loc = locateClip(doc, clipId);
    if (!loc || !isVisualClip(loc.clip) || isClipHidden(loc.track, loc.clip)) continue;
    const clip = loc.clip as VisualClip;
    const frame = doc.frames.find((f) => f.id === clip.frameId);
    if (!frame) continue;
    const keys = motionKeysOf(clip);
    if (keys.length < 2) continue;

    // Position channel → world, through the ONE mapping that knows what a
    // position MEANS for this layer (`motionPlace`). Falls back to the frame's
    // page coordinates only when the layer cannot be placed at all.
    const place = motionPlace(clipId, doc);
    const at = (px: number, py: number) => {
      const w = place
        ? place.toWorld({ x: px, y: py })
        : { x: frame.x + frame.width / 2 + px, y: frame.y + frame.height / 2 + py };
      return toScreen(w.x, w.y);
    };

    const anchors: MotionAnchorView[] = keys.map((k) => ({
      clipId,
      timeMs: k.timeMs,
      s: at(k.x, k.y),
      hIn: k.tIn ? at(k.x + k.tIn.x, k.y + k.tIn.y) : null,
      hOut: k.tOut ? at(k.x + k.tOut.x, k.y + k.tOut.y) : null,
      smooth: !!(k.tIn || k.tOut),
    }));

    const segments: MotionSegmentView[] = [];
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i]!;
      const b = keys[i + 1]!;
      const { c1, c2, curved } = motionSegmentControls(a, b);
      segments.push({
        clipId,
        a,
        b,
        sa: at(a.x, a.y),
        c1: at(c1.x, c1.y),
        c2: at(c2.x, c2.y),
        sb: at(b.x, b.y),
        curved,
      });
    }

    // Speed dots: the TRUE eased position each frame (sampleKeyframes is the
    // same seam the renderer uses, so curves and easing read exactly). Capped
    // so marathon clips don't turn the path into a solid stripe.
    const first = keys[0]!.timeMs;
    const last = keys[keys.length - 1]!.timeMs;
    // Speed dots are drawn one frame apart ON THE CLIP'S OWN COMP grid.
    const frameMs = frameStepMs(compFps(doc, clip.frameId));
    const step = Math.max(frameMs, (last - first) / 240);
    const num = (v: unknown, fb: number) => (typeof v === "number" ? v : fb);
    const spots: ScreenPoint[] = [];
    for (let t = first + step; t < last - step / 2; t += step) {
      if (keys.some((k) => Math.abs(k.timeMs - t) < step / 2)) continue;
      const sampled = sampleKeyframes(clip.keyframes, t);
      spots.push(at(num(sampled["x"], clip.transform.x), num(sampled["y"], clip.transform.y)));
    }
    // Heading comes from the neighbouring samples, which are already ordered in
    // time — so direction costs nothing beyond the sampling we were doing anyway.
    const dots = spots.map((sp, i) => {
      const prev = spots[i - 1] ?? sp;
      const next = spots[i + 1] ?? sp;
      return { at: sp, dir: { x: next.x - prev.x, y: next.y - prev.y } };
    });

    const local = clipLocalTime(clip, playheadMs);
    let current: ScreenPoint | null = null;
    if (local !== null) {
      const sampled = sampleKeyframes(clip.keyframes, local);
      current = at(num(sampled["x"], clip.transform.x), num(sampled["y"], clip.transform.y));
    }

    paths.push({
      clipId,
      locked: isClipLocked(loc.track, loc.clip),
      frameId: frame.id,
      anchors,
      segments,
      dots,
      current,
    });
  }
  return { paths };
}

/** Hit-test the scene at a screen point. Handles beat anchors beat segments. */
export function hitMotionScene(scene: MotionScene, p: ScreenPoint): MotionHit | null {
  for (const path of scene.paths) {
    for (const a of path.anchors) {
      for (const end of ["in", "out"] as const) {
        const h = end === "in" ? a.hIn : a.hOut;
        if (h && Math.hypot(p.x - h.x, p.y - h.y) <= HANDLE_HIT) {
          return { kind: "handle", clipId: a.clipId, timeMs: a.timeMs, end, locked: path.locked };
        }
      }
    }
  }
  for (const path of scene.paths) {
    for (const a of path.anchors) {
      if (Math.hypot(p.x - a.s.x, p.y - a.s.y) <= ANCHOR_HIT) {
        return { kind: "anchor", clipId: a.clipId, timeMs: a.timeMs, locked: path.locked };
      }
    }
  }
  let best: { seg: MotionSegmentView; u: number; d: number; locked: boolean } | null = null;
  for (const path of scene.paths) {
    for (const seg of path.segments) {
      const STEPS = 40;
      for (let k = 1; k < STEPS; k++) {
        const u = k / STEPS;
        const v = 1 - u;
        const x =
          v * v * v * seg.sa.x + 3 * v * v * u * seg.c1.x + 3 * v * u * u * seg.c2.x + u * u * u * seg.sb.x;
        const y =
          v * v * v * seg.sa.y + 3 * v * v * u * seg.c1.y + 3 * v * u * u * seg.c2.y + u * u * u * seg.sb.y;
        const d = Math.hypot(p.x - x, p.y - y);
        if (d <= SEGMENT_HIT && (!best || d < best.d)) best = { seg, u, d, locked: path.locked };
      }
    }
  }
  if (best) {
    return {
      kind: "segment",
      clipId: best.seg.clipId,
      a: best.seg.a,
      b: best.seg.b,
      u: best.u,
      locked: best.locked,
    };
  }
  return null;
}

/**
 * A MOTION PATH IS DRAWN WHERE THE LAYER GOES — not where its numbers are.
 *
 * The curve plots a position CHANNEL, and two things stand between that channel
 * and a point on the canvas. Both are corrections this app has already made
 * elsewhere; the path simply had neither.
 *
 *   THE GROUP CHAIN. A layer inside a group is painted through that group's
 *   delta, so its path has to be. `frameSpace` answers for a comp and knows
 *   nothing about groups — `layerSpace` is the one that answers for a LAYER, and
 *   using it here is the same fix the pivot crosshair, the corner dots and the
 *   pen nodes each got in turn.
 *
 *   THE POSITION ORIGIN. A group's own `x/y` is a DELTA about its pivot rather
 *   than a place, so plotting its keys as points draws the curve exactly one
 *   pivot away from the artwork it belongs to (core `positionOrigin`).
 *
 * Keyed as one mapping rather than two corrections applied at each of the eight
 * call sites, because the INVERSE has to agree with it exactly: a dragged key is
 * written back through `fromWorld`, and a forward map that is missing a term its
 * inverse has is a path that creeps every time you touch it.
 */
export interface MotionPlacement {
  toWorld(p: ScreenPoint): ScreenPoint;
  fromWorld(w: ScreenPoint): ScreenPoint;
}

export function motionPlace(
  clipId: string,
  doc: MotionDocument | null = peekDoc(),
): MotionPlacement | null {
  const clip = doc ? locateClip(doc, clipId)?.clip : null;
  const space = layerSpace(clipId, doc);
  if (!doc || !clip || !space) return null;
  const local = clipLocalTime(clip, useSession.getState().playheadMs) ?? 0;
  const o: Vec2 = positionOrigin(doc, clip, local);
  return {
    toWorld: (p) => space.toWorld({ x: p.x + o.x, y: p.y + o.y }),
    fromWorld: (w) => {
      const l = space.fromWorld(w);
      return { x: l.x - o.x, y: l.y - o.y };
    },
  };
}

/** World position of a motion key. */
export function motionAnchorWorld(path: MotionClipPath, key: MotionKey): ScreenPoint {
  return motionLocalToWorld(path.clipId, key);
}

/** A motion path's position channel → world. */
export function motionLocalToWorld(clipId: string, l: ScreenPoint): ScreenPoint {
  return motionPlace(clipId)?.toWorld(l) ?? l;
}

/** World → a motion path's position channel. */
export function motionWorldToLocal(clipId: string, w: ScreenPoint): ScreenPoint {
  return motionPlace(clipId)?.fromWorld(w) ?? w;
}

/**
 * Draw the scene. Everything but the accent comes from the shared path-chrome
 * kit, so a motion key and a vector node are recognisably the same species of
 * thing — violet because it is TIME you are editing, not geometry.
 *
 * `hover` is the same hit the Stage already resolves for the cursor, handed back
 * so the mark that lights up is guaranteed to be the one a press would grab.
 */
export function paintMotionScene(
  ctx: CanvasRenderingContext2D,
  scene: MotionScene,
  hover: MotionHit | null = null,
  pointer: ScreenPoint | null = null,
): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const path of scene.paths) {
    // The path itself, per segment (each has its own control polygon).
    paintPathStroke(
      ctx,
      () => {
        ctx.beginPath();
        for (const seg of path.segments) {
          ctx.moveTo(seg.sa.x, seg.sa.y);
          ctx.bezierCurveTo(seg.c1.x, seg.c1.y, seg.c2.x, seg.c2.y, seg.sb.x, seg.sb.y);
        }
      },
      { accent: MOTION_ACCENT },
    );

    // Travel marks — the AE-style tempo read (sparse = fast, dense = slow), now
    // also pointing the way time runs.
    paintDirectionChevrons(ctx, path.dots, { accent: MOTION_ACCENT, alpha: 0.6 });

    // Tangent handles: stem + round knob, the vector tool's own language.
    for (const a of path.anchors) {
      for (const end of ["in", "out"] as const) {
        const h = end === "in" ? a.hIn : a.hOut;
        if (!h) continue;
        const hot =
          hover?.kind === "handle" &&
          hover.clipId === a.clipId &&
          hover.timeMs === a.timeMs &&
          hover.end === end;
        paintTangent(ctx, a.s, h, { accent: MOTION_ACCENT, state: hot ? "active" : "idle" });
      }
    }

    // Anchors: diamonds — the keyframe glyph, now living on the canvas.
    for (const a of path.anchors) {
      const hot = hover?.kind === "anchor" && hover.clipId === a.clipId && hover.timeMs === a.timeMs;
      paintAnchor(ctx, a.s, {
        accent: MOTION_ACCENT,
        glyph: "diamond",
        state: hot ? "active" : a.smooth ? "selected" : "idle",
      });
    }

    // Where the clip is right now — the playhead riding the path.
    if (path.current) {
      ctx.beginPath();
      ctx.arc(path.current.x, path.current.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = MOTION_ACCENT;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
    }
  }

  // Hovering the curve itself offers a new key exactly where it would land, so
  // "can I add a point here, and where" is answered before you commit to a click.
  if (hover?.kind === "segment" && !hover.locked) {
    const path = scene.paths.find((mp) => mp.clipId === hover.clipId);
    const seg = path?.segments.find((sg) => sg.a.timeMs === hover.a.timeMs && sg.b.timeMs === hover.b.timeMs);
    if (seg) {
      const { at } = cubicAt(seg.sa, seg.c1, seg.c2, seg.sb, hover.u);
      paintInsertBadge(ctx, at, pointer, MOTION_ACCENT);
    }
  }
  ctx.restore();
}
