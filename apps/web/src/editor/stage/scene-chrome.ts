import { parseHexColor, type SnapLineKind } from "@solomotion/core";
import { canvasTones, type CanvasTones } from "../theme/theme-tokens";

/**
 * The scene's chrome: everything the editor draws ON the picture — selection
 * boxes, grips, the pivot, the marquee, smart guides, readouts. ONE place
 * decides how it looks, and every value comes from the live theme
 * (`canvasTones`), so a green theme and a rose one each get a
 * complete, consistent set without a colour written at a call site.
 *
 * The rules:
 *  • ONE stroke weight (`SCENE.stroke`, 1 CSS px). The chrome canvas is
 *    full-resolution, so it lands as a crisp DPR-wide line. Emphasis is a
 *    fill, never a thicker line.
 *  • Grips are squares at the theme's `--r-xs`; dots are for things that are
 *    not resize handles (corner radius, shape controls, the picture's own).
 *  • Hit zones are core's (`HANDLE_HIT_PX`, `ROTATE_BAND_PX`,
 *    `transform-zones.ts`). Nothing here is ever read to decide what a pointer
 *    hit: a drawing can change without moving a single target.
 *  • Snap lines are ONE derived hue opposite the accent, so a snap that lands
 *    exactly on a selection edge still reads as a snap. The kind changes the
 *    LINE (dashes, end marks), never the colour.
 */
export const SCENE = {
  stroke: 1,
  /** Square grip side, CSS px. */
  grip: 7,
  /** Dot radius, CSS px. */
  dot: 3.5,
  /** The pivot ring's radius at rest and while held. */
  pivot: 5,
  pivotActive: 6.5,
  /** End ticks on a snap line. */
  tick: 3,
} as const;

export interface SceneInk {
  accent: string;
  onAccent: string;
  paper: string;
  muted: string;
  /** The snap hue: the accent's opposite. */
  snap: string;
  /** Onion skins: ahead is the accent (where the drawing is going), behind is
   *  its complement, so the two directions never read as one. */
  onionAhead: string;
  onionBehind: string;
  corner: number;
  codeFont: string;
}

let memo: { src: CanvasTones; ink: SceneInk } | null = null;

/** The scene's palette for the live theme. O(1) after the first call per theme. */
export function sceneInk(): SceneInk {
  const src = canvasTones();
  if (memo?.src === src) return memo.ink;
  const ink: SceneInk = {
    accent: src.accent,
    onAccent: src.onAccent,
    paper: src.paper,
    muted: src.muted,
    snap: turnHue(src.accent, 150, src.light, src.light ? "#d6247a" : "#ff4f9a"),
    onionAhead: src.accent,
    onionBehind: turnHue(src.accent, 180, src.light, src.light ? "#c2410c" : "#ff8a3d"),
    corner: src.corner,
    codeFont: src.codeFont,
  };
  memo = { src, ink };
  return ink;
}

/**
 * The accent turned round the wheel, held saturated. 150° is the snap hue
 * (green → magenta, pink → teal, violet → amber); 180° is the onion skin's
 * "behind". A non-hex accent (a theme may write `color-mix(…)`) gets
 * `fallback`.
 */
export function turnHue(accent: string, degrees: number, light: boolean, fallback: string): string {
  const c = parseHexColor(accent);
  if (!c) return fallback;
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = (((h * 60 + degrees) % 360) + 360) % 360;
  return hslHex(h, 0.92, light ? 0.46 : 0.64);
}

/** HSL → `#rrggbb`: hex, so a colour field can show and edit the result. */
function hslHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return `#${[0, 8, 4].map((n) => Math.round(f(n) * 255).toString(16).padStart(2, "0")).join("")}`;
}

// ── Grips ───────────────────────────────────────────────────────────────────

/**
 *  rest   paper fill, accent edge: a handle you can pull
 *  on     accent fill, paper edge: the selected one (what the arrows move)
 *  ghost  hollow, light edge: the PICTURE's own grips inside a crop, so they
 *         never read as the window's handles
 */
export type GripState = "rest" | "on" | "ghost";

function paintGrip(ctx: CanvasRenderingContext2D, state: GripState): void {
  const ink = sceneInk();
  ctx.lineWidth = SCENE.stroke;
  if (state === "ghost") {
    ctx.fillStyle = "rgba(14,14,18,0.55)";
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
  } else {
    ctx.fillStyle = state === "on" ? ink.accent : ink.paper;
    ctx.strokeStyle = state === "on" ? ink.paper : ink.accent;
  }
  ctx.fill();
  ctx.stroke();
}

/** A square resize grip, turned with its box (`angle`, radians). */
export function drawGrip(ctx: CanvasRenderingContext2D, x: number, y: number, state: GripState = "rest", angle = 0): void {
  const s = SCENE.grip;
  ctx.save();
  ctx.translate(x, y);
  if (angle) ctx.rotate(angle);
  ctx.beginPath();
  // The theme's corner, held to a fifth of the side: --r-xs at full strength
  // turns a 7px square into a dot, and a grip must read as a square.
  ctx.roundRect(-s / 2, -s / 2, s, s, Math.min(sceneInk().corner, s / 5));
  paintGrip(ctx, state);
  ctx.restore();
}

/** A round dot: corner radius, shape controls, the picture's corners. */
export function drawDot(ctx: CanvasRenderingContext2D, x: number, y: number, state: GripState = "rest"): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, SCENE.dot, 0, Math.PI * 2);
  paintGrip(ctx, state);
  ctx.restore();
}

// ── Lines ───────────────────────────────────────────────────────────────────

/** An accent outline through screen points (a box, a skewed box, a crop). */
export function strokeOutline(ctx: CanvasRenderingContext2D, pts: readonly { x: number; y: number }[], dash?: number[]): void {
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = sceneInk().accent;
  ctx.lineWidth = SCENE.stroke;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

/** The rubber band: a whisper of accent with a crisp edge. */
export function drawMarquee(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }): void {
  const ink = sceneInk();
  ctx.save();
  ctx.fillStyle = ink.accent;
  ctx.globalAlpha = 0.08;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = ink.accent;
  ctx.lineWidth = SCENE.stroke;
  ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
  ctx.restore();
}

/** A size or position readout: an accent pill centred on `cx`, its top at `top`. */
export function drawReadout(ctx: CanvasRenderingContext2D, label: string, cx: number, top: number): void {
  const ink = sceneInk();
  ctx.save();
  ctx.font = `500 10px ${ink.codeFont}`;
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(label).width;
  const h = 18;
  ctx.fillStyle = ink.accent;
  ctx.beginPath();
  ctx.roundRect(cx - tw / 2 - 6, top, tw + 12, h, h / 2);
  ctx.fill();
  ctx.fillStyle = ink.onAccent;
  ctx.fillText(label, cx - tw / 2, top + h / 2 + 0.5);
  ctx.restore();
}

// ── Snap lines ──────────────────────────────────────────────────────────────

export interface SnapSpan {
  kind: SnapLineKind;
  pos: number;
  lo: number;
  hi: number;
}

/**
 * Every flashed smart guide, in one pass — the layer drag and the vector
 * overlay both call this, so a snap reads the same wherever it happens.
 * Centre lines dash; node snaps end in dots; the rest end in ticks.
 */
export function drawSnapLines(
  ctx: CanvasRenderingContext2D,
  guides: { v: readonly SnapSpan[]; h: readonly SnapSpan[] },
  view: { scale: number; tx: number; ty: number },
): void {
  if (!guides.v.length && !guides.h.length) return;
  const ink = sceneInk();
  const t = SCENE.tick;
  ctx.save();
  ctx.lineWidth = SCENE.stroke;
  ctx.strokeStyle = ink.snap;
  ctx.fillStyle = ink.snap;
  const line = (vertical: boolean, l: SnapSpan) => {
    const p = Math.round((vertical ? view.tx : view.ty) + l.pos * view.scale) + 0.5;
    const a = (vertical ? view.ty : view.tx) + l.lo * view.scale;
    const b = (vertical ? view.ty : view.tx) + l.hi * view.scale;
    const at = (along: number, across: number) => (vertical ? [across, along] : [along, across]) as [number, number];
    ctx.setLineDash(l.kind === "center" ? [4, 3] : []);
    ctx.beginPath();
    ctx.moveTo(...at(a, p));
    ctx.lineTo(...at(b, p));
    ctx.stroke();
    ctx.setLineDash([]);
    if (l.kind === "node") {
      for (const e of [a, b]) {
        ctx.beginPath();
        ctx.arc(...at(e, p), 2, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.beginPath();
      for (const e of [a, b]) {
        ctx.moveTo(...at(e, p - t));
        ctx.lineTo(...at(e, p + t));
      }
      ctx.stroke();
    }
  };
  for (const l of guides.v) line(true, l);
  for (const l of guides.h) line(false, l);
  ctx.restore();
}

// ── Pivot ───────────────────────────────────────────────────────────────────

/**
 * The anchor point: a ring with a cross through it. At rest it is quiet paper
 * so it never competes with the selection; held (pivot mode, a drag, a landed
 * hold) it fills with the accent and tethers back to the box centre.
 */
export function drawPivot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  active: boolean,
  tether: { x: number; y: number } | null,
): void {
  const ink = sceneInk();
  const r = active ? SCENE.pivotActive : SCENE.pivot;
  const arm = r + 3;
  const shape = () => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.moveTo(x - arm, y);
    ctx.lineTo(x - r, y);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + arm, y);
    ctx.moveTo(x, y - arm);
    ctx.lineTo(x, y - r);
    ctx.moveTo(x, y + r);
    ctx.lineTo(x, y + arm);
  };
  ctx.save();
  if (active && tether) {
    ctx.strokeStyle = ink.accent;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = SCENE.stroke;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(tether.x, tether.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  // A soft halo first, so the mark survives on light and dark artwork alike.
  shape();
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = SCENE.stroke + 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = active ? ink.accent : ink.paper;
  ctx.globalAlpha = active ? 0.9 : 0.55;
  ctx.fill();
  ctx.globalAlpha = 1;
  shape();
  ctx.strokeStyle = active ? ink.accent : "#fff";
  ctx.lineWidth = SCENE.stroke;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 1.5, 0, Math.PI * 2);
  ctx.fillStyle = active ? ink.onAccent : "#fff";
  ctx.fill();
  ctx.restore();
}
