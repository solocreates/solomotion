import { accentColor } from "../theme/theme-tokens";

// The rotation gesture's math + its on-canvas dial (the "clock"). Kept out of
// Stage so the angle accumulation, the shift-snap rule and the satisfying gauge
// live in ONE small place; Stage only feeds pointer state into these. Rotation
// is a plain keyframable transform property, so the gesture writes it exactly
// like x/y/scale — this file adds only the direct-manipulation feel on top.

/** Shift-snap increment while rotating (Figma uses 15° — a clean watch face). */
export const ROTATE_SNAP_DEG = 15;

const TAU = Math.PI * 2;

/** Turn the live #rrggbb accent into an `rgba(r,g,b,a)` factory so the dial's
 *  glows/ticks/hub all tint from the ONE brand accent (no baked-in hex). */
function accentTinter(hex: string): (a: number) => string {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (a: number) => `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Fold any angle change into (−180, 180]. Each pointer move contributes a small
 * step; summing these folded steps lets rotation wind PAST ±180 without ever
 * flipping — that's what makes the turn count infinite instead of Figma's clamp.
 */
export function normalizeDelta(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/** Snap an absolute angle to the nearest multiple of `step` (Shift). */
export function snapAngle(deg: number, step = ROTATE_SNAP_DEG): number {
  return Math.round(deg / step) * step;
}

/**
 * THE ROTATION RECOGNIZER — one accumulator, every subject that turns.
 *
 * Winding past ±180 without flipping, and ⇧-snapping the RESULT rather than the
 * pointer, are four lines each and they were written twice: once for the layer's
 * own rotate band and once for turning a picture inside its crop. Two copies of
 * an accumulator is how one of them ends up snapping the delta instead of the
 * angle, or losing a turn at the boundary, and the difference only shows up
 * after a full revolution — which is exactly the bug nobody reproduces.
 *
 * So the loop lives here, beside the two functions it is built from, and the
 * call sites keep only what is genuinely theirs: which point is the pivot, and
 * what to do with the angle that comes out. A third thing that turns (a gradient
 * handle, a repeater's step) inherits the feel for free.
 *
 * Screen or world coordinates both work — the tracker only ever measures angles
 * between points in ONE space, so it is the caller's job to be consistent, not
 * to say which.
 */
export interface RotateTracker {
  /**
   * Feed the pointer's current position; returns the subject's new ABSOLUTE
   * angle in degrees. `snap` (⇧ held) pins that angle to the nearest step —
   * which is what makes a snapped group turn by a clean increment rather than
   * by a clean delta from a crooked start.
   */
  angleAt: (p: { x: number; y: number }, snap: boolean) => number;
  /** Signed change from the subject's angle at press — what an orbit needs. */
  delta: () => number;
}

export function beginRotate(opts: {
  /** The point the subject turns about, in the same space as the pointer. */
  centre: { x: number; y: number };
  /** The pointer at press. */
  start: { x: number; y: number };
  /** The subject's angle at press, in degrees. */
  baseDeg: number;
  snapStep?: number;
}): RotateTracker {
  const step = opts.snapStep ?? ROTATE_SNAP_DEG;
  const angle = (p: { x: number; y: number }) =>
    (Math.atan2(p.y - opts.centre.y, p.x - opts.centre.x) * 180) / Math.PI;
  let last = angle(opts.start);
  let accum = 0;
  let applied = 0;
  return {
    angleAt(p, snap) {
      const cur = angle(p);
      // Fold each step into (−180,180] and sum, so the turn winds past ±180
      // instead of flipping (infinite rotation, not Figma's ±180 clamp).
      accum += normalizeDelta(cur - last);
      last = cur;
      const raw = opts.baseDeg + accum;
      const next = snap ? snapAngle(raw, step) : raw;
      applied = next - opts.baseDeg;
      return next;
    },
    delta: () => applied,
  };
}

interface DialOpts {
  /** Screen-space pivot (the box center the layer turns about). */
  cx: number;
  cy: number;
  /** Outer radius in screen px. */
  radius: number;
  /** The layer's live absolute rotation — may be any ± magnitude (infinite). */
  totalDeg: number;
  /** Shift held → the snap ticks light up like a watch face. */
  snapping: boolean;
  snapStep?: number;
}

/**
 * The rotation dial: a luminous watch face centered on the pivot. Zero sits at
 * 12 o'clock; the arc fills clockwise as you turn. Each COMPLETED revolution
 * leaves a concentric ring rippling outward — the "spring" winding up — so a
 * layer at 497° reads as one full ring plus a 137° arc, with the exact number in
 * the hub. Holding Shift lights the 15° ticks and pins the needle to the nearest
 * one. Pure drawing: give it a 2D context and the live angle, nothing else.
 */
export function drawRotationDial(ctx: CanvasRenderingContext2D, opts: DialOpts): void {
  const { cx, cy, radius, totalDeg, snapping } = opts;
  const snapStep = opts.snapStep ?? ROTATE_SNAP_DEG;
  const accent = accentColor();
  const tint = accentTinter(accent);
  const dir = totalDeg < 0 ? -1 : 1;
  const abs = Math.abs(totalDeg);
  const turns = Math.floor(abs / 360);
  const partial = abs - turns * 360; // 0..360 within the current revolution
  const needleDeg = dir * partial; // the layer's orientation, mod 360, signed

  // 0° at the top; clockwise positive (canvas Y points down, so this is natural).
  const toXY = (deg: number, r: number): [number, number] => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  };

  ctx.save();
  ctx.lineCap = "round";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Glass backdrop so the gauge reads over any artwork beneath it.
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 16, 0, TAU);
  ctx.fillStyle = "rgba(12,12,15,0.40)";
  ctx.fill();

  // Completed revolutions ripple OUTWARD — the spring filling up, one ring/turn.
  for (let i = 0; i < Math.min(turns, 7); i++) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 6 + i * 5, 0, TAU);
    ctx.strokeStyle = tint(Math.max(0.12, 0.5 - i * 0.06));
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // The active revolution's unfilled track.
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.strokeStyle = tint(0.16);
  ctx.lineWidth = 3;
  ctx.stroke();

  // Watch-face ticks every snapStep; the four quarters are longer + brighter.
  for (let d = 0; d < 360; d += snapStep) {
    const major = d % 90 === 0;
    const len = major ? 9 : 4.5;
    const [x1, y1] = toXY(d, radius - 1.5);
    const [x2, y2] = toXY(d, radius - 1.5 - len);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = snapping
      ? major
        ? tint(0.95)
        : tint(0.55)
      : major
        ? "rgba(255,255,255,0.32)"
        : "rgba(255,255,255,0.14)";
    ctx.lineWidth = major ? 2 : 1.5;
    ctx.stroke();
  }

  // The filling arc — from 12 o'clock, sweeping in the turn's direction.
  const start = -Math.PI / 2;
  const end = start + (needleDeg * Math.PI) / 180;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, start, end, dir < 0);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3.5;
  ctx.shadowColor = tint(0.75);
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // When snapping, mark the tick the needle is locked onto with a glowing dot.
  if (snapping) {
    const [sx, sy] = toXY(snapAngle(needleDeg, snapStep), radius);
    ctx.beginPath();
    ctx.arc(sx, sy, 3.5, 0, TAU);
    ctx.fillStyle = "#fff";
    ctx.shadowColor = accent;
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // The hand + its tip, riding the layer's live orientation.
  const [hx, hy] = toXY(needleDeg, radius - 2);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(hx, hy);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.shadowColor = tint(0.6);
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(hx, hy, 4, 0, TAU);
  ctx.fillStyle = accent;
  ctx.fill();

  // Central hub with the exact angle; a turn counter appears once past a full lap.
  ctx.beginPath();
  ctx.arc(cx, cy, 22, 0, TAU);
  ctx.fillStyle = "rgba(19,19,22,0.92)";
  ctx.fill();
  ctx.strokeStyle = tint(0.5);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = "#fff";
  ctx.font = "700 15px var(--font-jetbrains-mono), monospace";
  ctx.fillText(`${Math.round(totalDeg)}°`, cx, cy - (turns >= 1 ? 5 : 0));
  if (turns >= 1) {
    ctx.fillStyle = accent;
    ctx.font = "600 9px var(--font-jetbrains-mono), monospace";
    ctx.fillText(`${dir < 0 ? "−" : "+"}${turns} turn${turns > 1 ? "s" : ""}`, cx, cy + 9);
  }

  ctx.restore();
}
