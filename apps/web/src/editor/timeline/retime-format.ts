import { FREEZE_EPSILON } from "@solomotion/core";

/**
 * A PLAYBACK RATE IS A PERCENTAGE. One spelling, everywhere.
 *
 * It used to print multiples above 1 and percentages below — the editorial
 * habit of saying "2×" and "40%" — and inside one panel that reads as two
 * different quantities. A list showing `0.21 ×` in an editable field on one row
 * and `21%` in the row underneath makes you stop and work out that they are the
 * same number, every single time you look at it.
 *
 * Percent wins the tie because it is what the field can also ACCEPT: a
 * NumberInput showing 21 with a % unit is typed, scrubbed and compared against
 * 100 without anyone converting anything. It is also what Premiere, Resolve and
 * Final Cut all put in their retime UI, so 200% is not a surprise.
 */
export function formatRate(rate: number): string {
  if (Math.abs(rate) < FREEZE_EPSILON) return "freeze";
  const sign = rate < 0 ? "−" : "";
  const pct = Math.abs(rate) * 100;
  // Under 10% a whole number is a lie you can see (7% vs 7.5% is a doubling of
  // nothing); above it, decimals are noise.
  const text = pct < 10 ? pct.toFixed(1).replace(/\.0$/, "") : Math.round(pct).toString();
  return `${sign}${text}%`;
}

/** The same number for a control's value — percent, rounded the way it prints. */
export function ratePercent(rate: number): number {
  const pct = rate * 100;
  return Math.abs(pct) < 10 ? Math.round(pct * 10) / 10 : Math.round(pct);
}
