/**
 * THE BRUSH HANDLE'S DENSITY LADDER — how much of itself the handle shows in
 * the height it has been given.
 *
 * The handle used to ask for a definite 356px and wear `max-h-full` on top of
 * it. That pair is a trap, and the screenshots of it are the proof: on a stage
 * shorter than 356 the clamp does not remove anything, it SHRINKS whatever is
 * flexible — and the only flexible parts are the faders. So a short stage got
 * the full inventory of chrome (three number fields, two buttons, three
 * hairlines) with the three controls those numbers belong to reduced to
 * coloured slivers a pointer cannot land on. The control had inverted itself:
 * all label, no instrument.
 *
 * A fader has a floor. Below roughly a thumb's width of throw it is not a
 * coarse control any more, it is a mis-tap. So the fixed parts have to be the
 * ones that give:
 *
 *      modes      the two switches — armed once, and also in the sheet
 *      fields     the typed number — the drag card and the tooltip still say it
 *      dials      lowest-priority first; size is the last one standing
 *
 * which is exactly the order of the score below. `dials` is worth ten fields
 * and a hundred modes, so the solver spends height on instruments before
 * readouts and on readouts before switches, and never has to be told the order
 * twice. It also means a two-dial layout can afford its fields again when a
 * three-dial one could not — the ladder is a search, not a staircase.
 *
 * Pure arithmetic on purpose: no DOM, no React. The one input it cannot derive
 * is how much room there is, which `StageChrome` measures and publishes
 * (`useChromeColumnHeight`).
 *
 * There is no test for this — apps/web has no runner. The numbers below are the
 * capsule's real metrics and are asserted only by looking at it.
 */

/** The capsule's own metrics. Change these here, never at the call site. */
const PAD = 5;
/** Exported so the capsule pads itself with the number the solver budgeted. */
export const HANDLE_PAD = PAD;
/** Between two things in the stack (`gap-1.5`). */
const GAP = 6;
const RULE = 1;
/** One row of chrome — `--control-h`, the mode row and the settings door. */
const BUTTON = 28;
/** The number field under a fader, and the gap that ties it to one (`gap-1`). */
const FIELD = 24;
const FIELD_GAP = 4;

/**
 * The least throw a fader may have and still be a fader. A thumb is ~44px, and
 * a vertical control shorter than that is a switch you can miss.
 */
const MIN_THROW = 44;
/**
 * What a fader gets when the room is there. The handle stops growing here
 * rather than filling a tall stage — it is a thing you hold, not a wall.
 */
const IDEAL_THROW = 68;

/** Which parts of itself the handle is showing. */
export interface HandleParts {
  /** How many dials survive, taken from the front of the tool's dial list. */
  dials: number;
  /** The typed number under each fader. */
  fields: boolean;
  /** The row of mode switches above the settings door. */
  modes: boolean;
}

export interface HandleLayout extends HandleParts {
  /** What to set the capsule's height to. */
  height: number;
}

/** Everything that is not throw, for one arrangement. */
function chromeOf(p: HandleParts): number {
  // Each dial is a section, then the mode row (if shown), then the door.
  const sections = p.dials + (p.modes ? 1 : 0) + 1;
  return (
    PAD * 2 +
    Math.max(0, sections - 1) * (GAP * 2 + RULE) +
    BUTTON * (p.modes ? 2 : 1) +
    (p.fields ? p.dials * (FIELD + FIELD_GAP) : 0)
  );
}

const minHeight = (p: HandleParts) => chromeOf(p) + MIN_THROW * p.dials;
const idealHeight = (p: HandleParts) => chromeOf(p) + IDEAL_THROW * p.dials;

/** Richness, in the order the handle should spend height. See the header. */
const score = (p: HandleParts) => p.dials * 100 + (p.fields ? 10 : 0) + (p.modes ? 1 : 0);

/**
 * The richest arrangement that genuinely fits, at the height it wants.
 *
 * `available` of 0 means nobody has measured yet (first paint): show
 * everything, and let the first real measurement settle it. Anything else is
 * honoured — including a column so short that nothing fits, where the floor
 * arrangement is returned and the capsule's own `max-h-full` does the clipping.
 */
export function resolveHandleLayout(available: number, dials: number, modes: boolean): HandleLayout {
  const full: HandleParts = { dials, fields: true, modes };
  if (dials <= 0) return { dials: 0, fields: false, modes, height: chromeOf({ dials: 0, fields: false, modes }) };
  if (available <= 0) return { ...full, height: idealHeight(full) };

  let best: HandleParts | null = null;
  for (let d = dials; d >= 1; d--) {
    for (const fields of [true, false]) {
      for (const m of modes ? [true, false] : [false]) {
        const p: HandleParts = { dials: d, fields, modes: m };
        if (minHeight(p) > available) continue;
        if (!best || score(p) > score(best)) best = p;
      }
    }
  }

  const p = best ?? { dials: 1, fields: false, modes: false };
  return { ...p, height: Math.max(minHeight(p), Math.min(available, idealHeight(p))) };
}
