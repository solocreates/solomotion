"use client";

import {
  effectiveRanges,
  effectiveText,
  evaluateClipPose,
  locateClip,
  resolveTextStyle,
  type MotionDocument,
  type TextClip,
  type Vec2,
} from "@solomotion/core";
import { layoutOverridesFor, layoutTextClip } from "./render/text-layout";
import { planTextOnPath } from "./render/text-on-path";
import { pathTextGrip, type pathTextRide, stageDoc } from "./text-path-chrome";

/**
 * TEXT ON A PATH — what the overlay canvas paints for a bound text: the host's
 * outline as a guide, the grip you slide, and — while typing — the caret and
 * the selection ON THE CURVE, since the DOM editor that carries the keys has
 * no straight box to show them in.
 *
 * Everything is placed by the same plan the renderer paints with
 * (`planTextOnPath`), read from the same resolved document, so the caret is
 * between the letters it is between.
 */

export interface TextPathOverlayOpts {
  accent: string;
  /** Whether the grip is the thing being dragged (draws filled + larger). */
  sliding: boolean;
  /** While editing: the DOM selection in grapheme offsets, or null. */
  editing: { start: number; end: number } | null;
  /** Whether the caret is in its lit half (blink), when editing. */
  caretLit: boolean;
  playheadMs: number;
}

const GRIP_R = 5;
export const PATH_GRIP_HIT_PX = 9;

/** Draw the outline guide, the grip and (editing) the caret. Screen space. */
export function drawTextPathChrome(ctx: CanvasRenderingContext2D, clip: TextClip, opts: TextPathOverlayOpts): void {
  const doc = stageDoc();
  if (!doc) return;
  const grip = pathTextGrip(clip, doc);
  if (!grip) return;
  const { ride } = grip;

  ctx.save();
  // The guide: the contour the text rides, under everything. A dark halo under
  // the accent line, because the host is very often filled in the accent's own
  // hue (the default fill IS the brand colour) and a line in one colour on a
  // field of the same colour is a line nobody sees.
  ctx.beginPath();
  ride.pl.pts.forEach((pt, i) => {
    const s = ride.hs.toScreen(pt);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  if (ride.pl.closed) ctx.closePath();
  ctx.setLineDash([]);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = opts.accent;
  ctx.stroke();

  if (opts.editing) drawCaretAndSelection(ctx, doc, clip, ride.hs, opts);

  // The grip: a dot on the curve with a short bar along the tangent, so it
  // reads as "slide me along this", not as a pivot or a node.
  const s = ride.hs.toScreen(grip.local);
  ctx.translate(s.x, s.y);
  ctx.rotate(grip.angle);
  ctx.beginPath();
  ctx.moveTo(-GRIP_R - 6, 0);
  ctx.lineTo(GRIP_R + 6, 0);
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = 3.5;
  ctx.stroke();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, opts.sliding ? GRIP_R + 1.5 : GRIP_R, 0, Math.PI * 2);
  ctx.fillStyle = opts.sliding ? opts.accent : "#131316";
  ctx.fill();
  // A white ring, so the grip reads on the accent-filled host too.
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

/** Where the grip is on screen, for the hit test. */
export function textPathGripScreen(clip: TextClip): Vec2 | null {
  const grip = pathTextGrip(clip);
  return grip ? grip.ride.hs.toScreen(grip.local) : null;
}

/**
 * The caret between two letters on the curve, and the selection as one quad
 * per selected glyph — the DOM editor keeps the keys; the picture is here.
 */
function drawCaretAndSelection(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  raw: TextClip,
  hs: NonNullable<ReturnType<typeof pathTextRide>>["hs"],
  opts: TextPathOverlayOpts,
): void {
  const rclip = locateClip(doc, raw.id)?.clip;
  if (!rclip || rclip.kind !== "text") return;
  const local = Math.max(0, Math.min(rclip.durationMs, opts.playheadMs - rclip.startMs));
  const pose = evaluateClipPose(rclip, local);
  const text = effectiveText(rclip, local);
  const rStyle = resolveTextStyle(doc, rclip.style);
  const ranges = effectiveRanges(rclip, local);
  const layout = layoutTextClip(ctx, rclip, layoutOverridesFor(pose), text === rclip.text ? undefined : text, rStyle, ranges);
  const plan = planTextOnPath(doc, rclip, layout, local, pose.sampled);
  if (!plan) return;
  const sel = opts.editing!;
  const a = Math.min(sel.start, sel.end);
  const b = Math.max(sel.start, sel.end);

  // The quad of one laid glyph on the curve: its advance along the tangent,
  // its em box above and below the baseline.
  const quad = (i: number) => {
    const g = layout.glyphs[i];
    const p = plan.poses[i];
    if (!g || !p || !p.visible) return null;
    const cos = Math.cos(p.angle);
    const sin = Math.sin(p.angle);
    const hw = g.width / 2;
    const up = g.style.fontSize * 0.8;
    const down = g.style.fontSize * 0.25;
    const corner = (dx: number, dy: number) => hs.toScreen({ x: p.x + dx * cos - dy * sin, y: p.y + dx * sin + dy * cos });
    return [corner(-hw, -up), corner(hw, -up), corner(hw, down), corner(-hw, down)];
  };

  ctx.save();
  if (b > a) {
    ctx.fillStyle = opts.accent;
    ctx.globalAlpha = 0.35;
    for (let i = 0; i < layout.glyphs.length; i++) {
      const gi = layout.glyphs[i]!.graphemeIndex;
      if (gi < a || gi >= b) continue;
      const q = quad(i);
      if (!q) continue;
      ctx.beginPath();
      q.forEach((pt, k) => (k === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else if (opts.caretLit) {
    // The caret sits BEFORE grapheme `a`: at the left edge of the glyph laid
    // for it, or past the right edge of the last glyph when `a` is the end.
    let i = layout.glyphs.findIndex((g) => g.graphemeIndex >= a);
    let side = -1;
    if (i < 0) {
      i = layout.glyphs.length - 1;
      side = 1;
    }
    const g = layout.glyphs[i];
    const p = plan.poses[i];
    if (g && p) {
      const cos = Math.cos(p.angle);
      const sin = Math.sin(p.angle);
      const dx = (side * g.width) / 2;
      const size = g.style.fontSize;
      const top = hs.toScreen({ x: p.x + dx * cos + size * 0.85 * sin, y: p.y + dx * sin - size * 0.85 * cos });
      const bottom = hs.toScreen({ x: p.x + dx * cos - size * 0.25 * sin, y: p.y + dx * sin + size * 0.25 * cos });
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(bottom.x, bottom.y);
      ctx.strokeStyle = opts.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (layout.glyphs.length === 0) {
      // Empty text: the caret stands at the anchor.
      const grip = pathTextGrip(raw, doc);
      if (grip) {
        const s = grip.ride.hs.toScreen(grip.local);
        const size = rStyle.fontSize / Math.max(1e-6, hs.pxToLocal);
        ctx.translate(s.x, s.y);
        ctx.rotate(grip.angle);
        ctx.beginPath();
        ctx.moveTo(0, -size * 0.85);
        ctx.lineTo(0, size * 0.25);
        ctx.strokeStyle = opts.accent;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}
