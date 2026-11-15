/**
 * FUND IT, as numbers — shared by the website's /support page and the studio's
 * Support dialog, so the stops, the scale and the words are one decision.
 *
 * The amount bar is logarithmic, so $5 → $100 gets most of its length and
 * $500 is still reachable. It rests on the stops when near one; Shift frees
 * it to any whole dollar. Arrow keys jump stop to stop.
 */
export const FUND_MIN = 1;
export const FUND_MAX = 500;
export const FUND_STOPS = [5, 10, 25, 50, 100] as const;
export const FUND_DEFAULT = 25;

/**
 * The coin row, per cadence. A month tops out at $100; a one-time gift is a
 * bigger, rarer act, so its top coin (the full heart) is $500. Same length,
 * so switching cadence keeps your place in the row rather than your dollars.
 */
export type FundCadence = "monthly" | "once";
export const FUND_COINS: Record<FundCadence, readonly number[]> = {
  monthly: FUND_STOPS,
  once: [10, 25, 50, 100, 500],
};

export const fundFraction = (v: number) => Math.log(v / FUND_MIN) / Math.log(FUND_MAX / FUND_MIN);
export const fundFromFraction = (f: number) => FUND_MIN * Math.pow(FUND_MAX / FUND_MIN, Math.min(1, Math.max(0, f)));

/** Where an amount rests: the nearest stop if close, else whole dollars. */
export function settleFund(v: number, free = false): number {
  const whole = Math.round(Math.min(FUND_MAX, Math.max(FUND_MIN, v)));
  if (free) return whole;
  const f = fundFraction(whole);
  return FUND_STOPS.find((s) => Math.abs(fundFraction(s) - f) < 0.045) ?? whole;
}

/** One arrow press: the next stop that way (past the last, +50). */
export function stepFund(v: number, dir: 1 | -1): number {
  if (dir > 0) return FUND_STOPS.find((s) => s > v) ?? Math.min(FUND_MAX, v + 50);
  return [...FUND_STOPS].reverse().find((s) => s < v) ?? FUND_MIN;
}

/** What the page says back to an amount. Honest: a feeling, not a price list. */
export function fundLine(v: number): string {
  if (v >= 100) return "Founding-supporter territory.";
  if (v >= 50) return "That's a feature, sooner.";
  if (v >= 25) return "That's real hours on the studio.";
  if (v >= 10) return "That's a bug fixed sooner.";
  if (v >= 5) return "Coffee for the next late night.";
  return "Every dollar counts.";
}

/** GitHub Sponsors opens on the right tab; it takes no amount in its URL. */
export function sponsorTabUrl(base: string, monthly: boolean): string {
  return `${base}?frequency=${monthly ? "recurring" : "one-time"}`;
}
