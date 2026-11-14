/**
 * Ruler units + tick math (headless). The canvas draws in world pixels; a ruler
 * just RELABELS those pixels in the user's chosen unit and picks pleasant tick
 * intervals. Pure so the tick logic is testable and a native adapter can reuse
 * the same "nice numbers" everywhere.
 */

export type RulerUnit = "px" | "pt" | "mm" | "cm" | "in";
export const RULER_UNITS: RulerUnit[] = ["px", "pt", "mm", "cm", "in"];

/** World pixels per 1 unit, at the CSS reference of 96 px/inch. */
export const PX_PER_UNIT: Record<RulerUnit, number> = {
  px: 1,
  pt: 96 / 72,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  in: 96,
};

export const RULER_UNIT_LABEL: Record<RulerUnit, string> = {
  px: "Pixels",
  pt: "Points",
  mm: "Millimetres",
  cm: "Centimetres",
  in: "Inches",
};

/** Round n up to the nearest 1/2/5 × 10^k — the classic ruler/axis step. */
function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const f = n / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * pow;
}

/**
 * The world-pixel spacing of major ruler ticks so labels sit roughly
 * `targetPx` screen-pixels apart at the current `zoom`, snapped to a nice value
 * in the chosen unit. Returns both the world step and the unit-space step (for
 * labels).
 */
export function rulerStep(zoom: number, unit: RulerUnit, targetPx = 72): { world: number; unit: number } {
  const perUnit = PX_PER_UNIT[unit];
  // Desired step in unit space to hit targetPx on screen.
  const rawUnit = targetPx / zoom / perUnit;
  const stepUnit = niceCeil(rawUnit);
  return { world: stepUnit * perUnit, unit: stepUnit };
}

/** Format a world-pixel coordinate as a unit label (integers where possible). */
export function formatRuler(worldPx: number, unit: RulerUnit): string {
  const v = worldPx / PX_PER_UNIT[unit];
  const rounded = Math.round(v * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, "");
}
