import type { KeyframeValue } from "../schema";

/**
 * THE ONE RULE FOR A LAYER'S Y SCALE AT AN INSTANT: its own keys, else its own
 * value, else (null) "uniform" — the caller's X scale.
 *
 * A null `scaleY` means "follow `scale`", and every pose reader used to check
 * that FIRST: `scaleY == null ? scale : keys…`. So keys written onto a uniform
 * layer — by the API, a preset, a paste, record mode — were stored, listed and
 * never rendered (the Playground's grid draw-on had to be rebuilt from stroked
 * paths). Keys are the more specific statement; they win.
 */
export function sampledScaleY(sampled: Readonly<Record<string, KeyframeValue>>, stored: number | null | undefined): number | null {
  const keyed = sampled["scaleY"];
  return typeof keyed === "number" ? keyed : (stored ?? null);
}
