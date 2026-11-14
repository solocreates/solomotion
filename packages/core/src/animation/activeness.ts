import type { KeyframeValue } from "../schema";

/**
 * ACTIVENESS — "is this switch on at this instant?", answered once for the
 * whole app.
 *
 * Every stack in the app has a switch: an effect's eye, a modulator's toggle, a
 * stroke's visibility, a sound layer's mute. Until now those switches were the
 * one property that could not move in time — you could animate a blur's radius
 * to zero but you could not turn the blur OFF at 00:04, which is exactly the
 * Blender/AE move ("keyframe the modifier's enable") people reach for.
 *
 * The fix is deliberately not a new concept. `enabled` becomes an ordinary
 * animatable property of kind `discrete` — the kind that HOLDS between keys
 * with no tween, which `italic`, `fontFamily` and `text` already are. That
 * means the curve editor, the dope sheet, record mode, the keyframe menu, copy/
 * paste-properties and the exporters all understand it the day it ships,
 * because none of them learned anything new.
 *
 * What DOES need writing is this: a renderer must read the SAMPLED switch, not
 * the stored one. That is one function, and every consumer calls it, so a
 * stack that forgets is a stack that visibly ignores its own keyframes rather
 * than a stack that quietly disagrees with the timeline.
 *
 * The stored `enabled` stays the base value — a clip with no `…enabled` track
 * behaves exactly as before, at zero cost.
 */

/** The field name every switch keyframes under (`lfx.<id>.enabled`, …). */
export const ENABLED_FIELD = "enabled";

/**
 * A switch's value at `sampled`'s instant: a keyed `enabled` beats the stored
 * one, and anything else falls back to the base.
 *
 * Non-boolean sampled values are coerced rather than refused, because a
 * discrete track can legitimately hold the 0/1 a driver or an imported
 * document wrote — and a switch that ignored those would read as broken.
 */
export function switchedOn(
  base: boolean,
  path: string,
  sampled: Record<string, KeyframeValue> | undefined,
): boolean {
  const v = sampled?.[path];
  if (v === undefined) return base;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v >= 0.5;
  if (typeof v === "string") return v !== "" && v !== "false" && v !== "0";
  return base;
}

/**
 * The members of a switched list that are on right now — the shape every
 * effect stack, modulator list and sound chain wants.
 *
 * `pathOf` is the caller's own path grammar (`lfx.`, `afx.`, `mod.`), so this
 * knows nothing about domains and a new one costs a call site, not a branch.
 */
export function activeAt<T extends { id: string; enabled: boolean }>(
  items: readonly T[] | undefined,
  pathOf: (id: string) => string,
  sampled: Record<string, KeyframeValue> | undefined,
): T[] {
  if (!items || items.length === 0) return [];
  return items.filter((i) => switchedOn(i.enabled, pathOf(i.id), sampled));
}

/** Is anything in this list on right now? (The cheap "skip the stack" guard.) */
export function anyActiveAt<T extends { id: string; enabled: boolean }>(
  items: readonly T[] | undefined,
  pathOf: (id: string) => string,
  sampled: Record<string, KeyframeValue> | undefined,
): boolean {
  return (items ?? []).some((i) => switchedOn(i.enabled, pathOf(i.id), sampled));
}
