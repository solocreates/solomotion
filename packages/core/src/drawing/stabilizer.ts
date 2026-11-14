/**
 * THE stroke stabiliser — one input filter behind every drawing gesture: the
 * pixel brush, the vector brush, the eraser and the free lasso.
 *
 * It is a PULL STRING, not an average. The tool trails the cursor on a leash of
 * `radius`: move inside the leash and the tool does not move at all (that is
 * where hand tremor, pen chatter and a mouse's stair-stepping live), move past
 * it and the tool is dragged along behind you. Blender's stabilised stroke and
 * Krita's stabiliser are this filter, and it is the one worth copying because
 * it is the one you can SEE — the leash is a real distance on screen, so the
 * chrome can draw it and the artist can aim with it, which a running average
 * can never offer.
 *
 * It is deliberately separate from `BrushPreset.strokePath.streamline`: that is
 * a brush's own micro-chase, part of how a marker feels. This is the tool's
 * leash, the same for whatever is armed, and it is what ⇧ boosts mid-stroke.
 *
 * Headless on purpose — it filters points in whatever space the caller works
 * in (the web overlay runs it in SCREEN px, so the leash means the same
 * distance at every zoom) and holds the leash state the chrome renders.
 */

export interface StabPoint {
  x: number;
  y: number;
}

/** Live state of one stabilised gesture — also exactly what the chrome draws. */
export interface StabilizerState {
  /** Where the tool actually is: the point that gets drawn/erased. */
  point: StabPoint;
  /** Where the pointer actually is. */
  cursor: StabPoint;
  /** Current leash length in the caller's units (0 = filter is off). */
  radius: number;
  /** 0..1 how far the leash is stretched — the chrome's pull/stretch signal. */
  tension: number;
}

/** Leash length at full strength. Beyond this, aiming stops being possible. */
export const MAX_STABILIZER_PX = 120;

/** What ⇧ smooths at when the tool itself is smoothing at nothing. */
export const SHIFT_SMOOTHING = 0.55;

/**
 * THE SMOOTHING IN FORCE — ⇧ REVERSES the tool's setting for as long as it is
 * held.
 *
 * It used to be a floor (`max(smoothing, 0.55)`), which gives you one of the
 * two things a modifier is for. A floor smooths an unsmoothed tool, and does
 * nothing at all for the other half of the job: getting a clean sharp line out
 * of a brush you have set to 80%, without opening a panel, changing it, drawing
 * one stroke and changing it back. A reversal gives both, costs the same key,
 * and is the same shape as every other modifier in this app — ⇧ on a snap, on a
 * detent, on a constraint — where it means "not the way you have it set".
 *
 * One function, so the stroke and the chrome that reports it cannot disagree
 * about what is armed: the handle's toggle lights up under ⇧ because it asks
 * this, not because it guesses.
 */
export function effectiveSmoothing(smoothing: number, shift: boolean): number {
  const own = Math.min(1, Math.max(0, smoothing));
  if (!shift) return own;
  return own > 0 ? 0 : SHIFT_SMOOTHING;
}

/** The leash a gesture should run with, at whatever ⇧ has made of the setting. */
export function stabilizerRadius(smoothing: number, shift: boolean): number {
  const strength = effectiveSmoothing(smoothing, shift);
  // Squared response: the first half of the slider is fine-grained (where
  // every usable setting lives) and the top end reaches for the long leash.
  return strength <= 0 ? 0 : Math.max(2, strength * strength * MAX_STABILIZER_PX);
}

export function createStabilizer(at: StabPoint, radius: number): StabilizerState {
  return {
    point: { x: at.x, y: at.y },
    cursor: { x: at.x, y: at.y },
    radius,
    tension: 0,
  };
}

/** Points closer than this are the same point — never emit a zero-length step. */
const MIN_STEP = 0.35;

/** Emitted steps are capped so a fast flick still lands as a line, not a jump. */
const MAX_STEP = 6;

/**
 * Feed the raw pointer position; returns the points the TOOL moved through
 * (possibly none — the whole point of a leash is that small motion does not
 * move the tool). `radius` is passed per call so ⇧ can change the leash
 * mid-stroke without re-creating anything.
 *
 * ## There is deliberately no RELEASE step, and that is the whole design
 *
 * A stroke ends where the TOOL is. The tool trails the cursor by up to a leash
 * — that lag IS the smoothing, it is drawn on screen the entire time you draw,
 * and you aim with it. So the end of a gesture is not a special moment needing
 * its own model: you lift, and the line stays exactly where it was.
 *
 * This file tried the alternative three times, and every version failed the
 * same way — ink appearing where the artist had not put it, at the one moment
 * nobody can redo:
 *
 *   v1  walked the tool to `cursor`. The last raw points of a gesture are its
 *       worst — you slow down, the tremor stops being outrun, a pen lurches as
 *       it leaves the glass — so this put a leash-length of precisely the noise
 *       the filter exists to remove back into the stroke.
 *   v2  extended along the tool's travel direction by the cursor offset
 *       projected onto it. Reads as self-tuning and is not: a pull string at
 *       rest sits EXACTLY one leash behind, sweeping or stopped, so the
 *       projection was always ≈ a full leash and every stroke ended with a
 *       straight tangential dash. On a curve, the dash leaves the curve.
 *   v3  replayed the swallowed points with the leash decaying to zero, so the
 *       ending at least followed the real hand path. Truer, and still wrong for
 *       the reason the other two were: at 100% smoothing it is 120px of line
 *       arriving after you stopped drawing, and you watch the stroke you had
 *       placed stretch forward to meet the cursor.
 *
 * Each was an answer to "how should the tool catch up", and the question is the
 * bug. Blender's stabilised stroke does not catch up either.
 *
 * The consequence is stated rather than compensated for: a smoothed stroke is
 * SHORTER than the gesture that drew it, by up to the leash. That is legible
 * (the leash chrome shows the gap the whole time), predictable, and identical
 * however the gesture ended — lifted on the canvas, dragged off the frame,
 * cancelled by the browser, or lost with the window. `heading`, the tail buffer
 * and `stabilizerDrain` are gone with it; nothing else ever read them.
 */
export function stabilizerPush(s: StabilizerState, p: StabPoint, radius: number): StabPoint[] {
  s.cursor = { x: p.x, y: p.y };
  s.radius = radius;
  if (radius <= 0) {
    s.tension = 0;
    // Walk rather than teleport: with no leash the tool IS the cursor, and a
    // step still has to arrive as a line so a fast flick is not a gap.
    const step = walkTo(s, p.x, p.y);
    return step.length > 0 ? step : [{ ...s.point }];
  }
  const dx = p.x - s.point.x;
  const dy = p.y - s.point.y;
  const d = Math.hypot(dx, dy);
  if (d <= radius) {
    s.tension = d / radius;
    return [];
  }
  s.tension = 1;
  return walkTo(s, p.x - (dx / d) * radius, p.y - (dy / d) * radius);
}

/** March the tool point to (x, y) in steps small enough to stay a line. */
function walkTo(s: StabilizerState, x: number, y: number): StabPoint[] {
  const dx = x - s.point.x;
  const dy = y - s.point.y;
  const d = Math.hypot(dx, dy);
  if (d < MIN_STEP) return [];
  const steps = Math.max(1, Math.ceil(d / MAX_STEP));
  const out: StabPoint[] = [];
  for (let i = 1; i <= steps; i++) {
    out.push({ x: s.point.x + (dx * i) / steps, y: s.point.y + (dy * i) / steps });
  }
  s.point = { x, y };
  return out;
}
