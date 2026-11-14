/**
 * PATH CHROME — the one visual and interaction language for editing points on
 * the canvas. The vector pen (`VectorOverlay`) and motion paths (`motion-path`)
 * both paint and hit-test through this, so a node feels the same wherever you
 * meet one: same size, same grab radius, same response to a hover, same latch
 * before a press becomes a drag.
 *
 * It is deliberately headless — no React, no store, no DOM. Callers hand it a
 * 2D context, screen-space points and an accent; it hands back nothing. That is
 * what lets two very different surfaces share one look without merging.
 *
 * Two rules run through everything here:
 *
 *  · **Chrome must survive the artwork underneath it.** Every mark is laid over
 *    a dark underlay and finished in white or the accent, so a node stays legible
 *    on a white photo and on a black one. This is why the neutrals below are
 *    fixed rather than themed — they sit over the user's picture, not over the
 *    app's background. The ACCENT is always injected by the caller, which is
 *    what keeps the surface's own identity (and the theme) intact.
 *
 *  · **Interactive things react before you commit.** A node under the pointer
 *    grows and lights a halo; the halo is the touch target made briefly visible,
 *    so the generous grab radius below is something you feel rather than
 *    something you have to discover by missing.
 */

export interface Pt {
  x: number;
  y: number;
}

/**
 * Grab radii, in screen px. Shared so the two surfaces cannot drift into
 * "the pen feels sloppier than the motion path" — a complaint that is really
 * just two hit constants disagreeing.
 */
export const PATH_HIT = {
  anchor: 9,
  handle: 8,
  segment: 7,
  /** The start node's close-the-path ring, which should out-grab a plain node. */
  closeTarget: 11,
  /**
   * How far a press must travel before it counts as a DRAG rather than a click.
   *
   * This is LATCHED by callers: below the threshold nothing is written at all,
   * and once crossed the gesture stays a drag for the rest of the press. An
   * un-latched threshold — re-tested every pointermove — is what made placing a
   * pen point so twitchy: a 1px tremor tipped it over, so a point you meant to
   * drop as a hard corner came out faintly curved.
   */
  dragLatch: 4,
  /**
   * Drop a tangent knob back within this of its own anchor and the handle
   * DISSOLVES — the gesture for "make this a corner again" on both surfaces.
   */
  handleDissolve: 4,
} as const;

/** Radii of the marks themselves. Hover sizes are the "alive" half. */
export const PATH_SIZE = {
  anchor: 4,
  anchorHover: 5.5,
  handle: 3.5,
  handleHover: 4.75,
  /** The soft ring that reveals a node's touch target under the pointer. */
  halo: 11,
  insertBadge: 9,
} as const;

/** Chrome neutrals — fixed, because they sit over artwork, not over the theme. */
const UNDERLAY = "rgba(10, 10, 14, 0.62)";
const INK = "#ffffff";

/** How a node is currently participating in the edit. Drives size and fill. */
export type NodeState = "idle" | "hover" | "selected" | "active";

/** The glyph a surface stamps for a node — its own identity, shared geometry. */
export type NodeGlyph = "square" | "diamond" | "round";

export interface AnchorStyle {
  accent: string;
  glyph: NodeGlyph;
  state: NodeState;
  /** Draw the "you can close the path here" ring around it. */
  closeRing?: boolean;
}

/** Append a glyph's outline to the current path, centered on `p`. */
function traceGlyph(ctx: CanvasRenderingContext2D, p: Pt, glyph: NodeGlyph, r: number): void {
  ctx.beginPath();
  if (glyph === "round") {
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    return;
  }
  if (glyph === "diamond") {
    ctx.moveTo(p.x, p.y - r);
    ctx.lineTo(p.x + r, p.y);
    ctx.lineTo(p.x, p.y + r);
    ctx.lineTo(p.x - r, p.y);
    ctx.closePath();
    return;
  }
  // A square reads as "corner"; rounding it very slightly keeps it from looking
  // like a rendering artefact at 1x while still reading as a square.
  const s = r * 2;
  ctx.roundRect(p.x - r, p.y - r, s, s, 1.5);
}

/**
 * The soft ring that appears under the pointer. It is the grab radius drawn —
 * so the generous hit area announces itself instead of being a hidden mercy.
 */
function paintHalo(ctx: CanvasRenderingContext2D, p: Pt, accent: string, strength: number): void {
  if (strength <= 0) return;
  ctx.save();
  ctx.globalAlpha = 0.16 * strength;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(p.x, p.y, PATH_SIZE.halo, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.5 * strength;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(p.x, p.y, PATH_SIZE.halo, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/**
 * A path node. Selected and active nodes fill with the accent and read as
 * "this one is mine now"; idle nodes stay white-filled so they never compete
 * with the artwork. Every node carries a dark underlay so it survives on any
 * picture — the single most important thing about canvas chrome.
 */
export function paintAnchor(ctx: CanvasRenderingContext2D, p: Pt, style: AnchorStyle): void {
  const { accent, glyph, state } = style;
  const engaged = state === "selected" || state === "active";
  const lifted = state === "hover" || state === "active";
  const r = lifted ? PATH_SIZE.anchorHover : PATH_SIZE.anchor;

  ctx.save();
  ctx.lineJoin = "round";
  paintHalo(ctx, p, accent, state === "active" ? 1 : state === "hover" ? 0.75 : 0);

  // Underlay: a slightly fatter silhouette in near-black, so the crisp mark on
  // top never dissolves into a same-coloured background.
  traceGlyph(ctx, p, glyph, r + 1.2);
  ctx.fillStyle = UNDERLAY;
  ctx.fill();

  traceGlyph(ctx, p, glyph, r);
  ctx.fillStyle = engaged ? accent : INK;
  ctx.strokeStyle = engaged ? INK : accent;
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();

  if (style.closeRing) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, PATH_SIZE.halo - 2, 0, Math.PI * 2);
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * A tangent: the arm out to the knob, then the knob. The arm is deliberately
 * quiet — it is a relationship, not a target — while the knob gets the same
 * hover response as a node, because it is one.
 */
export function paintTangent(
  ctx: CanvasRenderingContext2D,
  anchor: Pt,
  handle: Pt,
  opts: { accent: string; state?: NodeState },
): void {
  const state = opts.state ?? "idle";
  const lifted = state === "hover" || state === "active";
  ctx.save();
  ctx.lineCap = "round";

  // Arm, over its own underlay for the same legibility reason as the nodes.
  ctx.beginPath();
  ctx.moveTo(anchor.x, anchor.y);
  ctx.lineTo(handle.x, handle.y);
  ctx.strokeStyle = UNDERLAY;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(anchor.x, anchor.y);
  ctx.lineTo(handle.x, handle.y);
  ctx.strokeStyle = opts.accent;
  ctx.globalAlpha = lifted ? 0.9 : 0.55;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.globalAlpha = 1;

  paintHalo(ctx, handle, opts.accent, state === "active" ? 1 : state === "hover" ? 0.75 : 0);
  const r = lifted ? PATH_SIZE.handleHover : PATH_SIZE.handle;
  ctx.beginPath();
  ctx.arc(handle.x, handle.y, r + 1.2, 0, Math.PI * 2);
  ctx.fillStyle = UNDERLAY;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(handle.x, handle.y, r, 0, Math.PI * 2);
  ctx.fillStyle = state === "active" ? opts.accent : INK;
  ctx.strokeStyle = state === "active" ? INK : opts.accent;
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * The "a node lands here" badge: a dashed leader from the pointer to the exact
 * point on the curve, and a plus at that point. It answers the two questions a
 * click on a path always raises — *will* this add a point, and *where* — before
 * you commit to finding out.
 */
export function paintInsertBadge(
  ctx: CanvasRenderingContext2D,
  at: Pt,
  from: Pt | null,
  accent: string,
): void {
  const r = PATH_SIZE.insertBadge;
  ctx.save();
  ctx.lineCap = "round";

  // Leader from the cursor, stopping short of the badge so it never crowds it.
  if (from) {
    const dx = at.x - from.x;
    const dy = at.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len > r + 6) {
      const ux = dx / len;
      const uy = dy / len;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(at.x - ux * (r + 2), at.y - uy * (r + 2));
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  // The badge: accent disc on a dark underlay, with a white plus.
  ctx.beginPath();
  ctx.arc(at.x, at.y, r + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = UNDERLAY;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const arm = r * 0.46;
  ctx.beginPath();
  ctx.moveTo(at.x - arm, at.y);
  ctx.lineTo(at.x + arm, at.y);
  ctx.moveTo(at.x, at.y - arm);
  ctx.lineTo(at.x, at.y + arm);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

/**
 * Little chevrons riding a path to show which way it runs. Each is drawn from a
 * point and the direction through it, so the caller decides the spacing — which
 * is how motion paths keep encoding tempo (chevrons bunch up where the layer
 * moves slowly) while also, now, encoding heading.
 */
export function paintDirectionChevrons(
  ctx: CanvasRenderingContext2D,
  marks: Array<{ at: Pt; dir: Pt }>,
  opts: { accent: string; alpha?: number; size?: number },
): void {
  const size = opts.size ?? 3.2;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = opts.alpha ?? 0.75;
  ctx.strokeStyle = opts.accent;
  ctx.lineWidth = 1.5;
  for (const m of marks) {
    const len = Math.hypot(m.dir.x, m.dir.y);
    if (len < 0.0001) continue;
    const ux = m.dir.x / len;
    const uy = m.dir.y / len;
    // Perpendicular, so the two arms splay behind the direction of travel.
    const px = -uy;
    const py = ux;
    const tipX = m.at.x + ux * size;
    const tipY = m.at.y + uy * size;
    ctx.beginPath();
    ctx.moveTo(tipX - ux * size * 1.6 + px * size * 0.9, tipY - uy * size * 1.6 + py * size * 0.9);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(tipX - ux * size * 1.6 - px * size * 0.9, tipY - uy * size * 1.6 - py * size * 0.9);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * A path's own stroke: dark underlay, then the accent. Callers pass a `trace`
 * that lays the geometry down, because each surface builds its curve
 * differently (per-segment control polygons vs. a compiled Path2D).
 */
export function paintPathStroke(
  ctx: CanvasRenderingContext2D,
  trace: () => void,
  opts: { accent: string; width?: number; alpha?: number; dash?: number[] },
): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (opts.dash) ctx.setLineDash(opts.dash);
  trace();
  ctx.strokeStyle = UNDERLAY;
  ctx.lineWidth = (opts.width ?? 1.5) + 1.5;
  ctx.stroke();
  trace();
  ctx.strokeStyle = opts.accent;
  ctx.globalAlpha = opts.alpha ?? 1;
  ctx.lineWidth = opts.width ?? 1.5;
  ctx.stroke();
  ctx.restore();
}

/**
 * Has a press travelled far enough to be a drag? Callers latch on this: once it
 * returns true they stop asking, so a gesture can never flicker back into a
 * click because the hand steadied.
 */
export function passedDragLatch(from: Pt, to: Pt): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= PATH_HIT.dragLatch;
}

/**
 * The point on a cubic at `u`, plus its direction there — the one place both
 * surfaces get "where exactly on this segment" from, for insert badges and
 * direction marks alike.
 */
export function cubicAt(a: Pt, c1: Pt, c2: Pt, b: Pt, u: number): { at: Pt; dir: Pt } {
  const v = 1 - u;
  const at = {
    x: v * v * v * a.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * b.x,
    y: v * v * v * a.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * b.y,
  };
  const dir = {
    x: 3 * v * v * (c1.x - a.x) + 6 * v * u * (c2.x - c1.x) + 3 * u * u * (b.x - c2.x),
    y: 3 * v * v * (c1.y - a.y) + 6 * v * u * (c2.y - c1.y) + 3 * u * u * (b.y - c2.y),
  };
  return { at, dir };
}

/**
 * A short phrase riding beside the cursor, naming what the next click will do —
 * "Close path", "Connect ends", "Add point".
 *
 * Illustrator answers this with cryptic superscript glyphs you have to learn;
 * a word costs the same pixels and needs no legend. It stays quiet by default:
 * callers pass an empty string for the pen's ordinary work, because a hint that
 * is always on is not a hint, it is furniture.
 *
 * Drawn in fixed neutrals over a dark pill for the same reason every other mark
 * here is — it sits over the user's artwork, not over the app's background.
 */
export function paintCursorHint(
  ctx: CanvasRenderingContext2D,
  at: Pt,
  text: string,
  accent: string,
): void {
  if (!text) return;
  ctx.save();
  ctx.font = "500 11px ui-sans-serif, -apple-system, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const padX = 6;
  const w = ctx.measureText(text).width + padX * 2;
  const h = 18;
  // Sits below-right of the crosshair, out of the way of the point being aimed at.
  const x = at.x + 14;
  const y = at.y + 12;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 5);
  ctx.fillStyle = UNDERLAY;
  ctx.fill();
  ctx.strokeStyle = `${accent}66`;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.fillText(text, x + padX, y + h / 2 + 0.5);
  ctx.restore();
}

/**
 * The ring that marks a node as the pen's live target — the point a click will
 * continue from, close onto, or connect to. `strength` fades it: a full ring is
 * "this exact node", a soft one is "one of the ends you could pick up".
 */
export function paintPenTarget(
  ctx: CanvasRenderingContext2D,
  at: Pt,
  accent: string,
  strength: "soft" | "live" = "live",
): void {
  ctx.save();
  const live = strength === "live";
  ctx.beginPath();
  ctx.arc(at.x, at.y, live ? 8 : 6, 0, Math.PI * 2);
  ctx.strokeStyle = live ? accent : `${accent}80`;
  ctx.lineWidth = live ? 2 : 1.5;
  ctx.stroke();
  if (live) {
    ctx.beginPath();
    ctx.arc(at.x, at.y, 11.5, 0, Math.PI * 2);
    ctx.strokeStyle = `${accent}44`;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  ctx.restore();
}
