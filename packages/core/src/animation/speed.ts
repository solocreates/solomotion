/**
 * The speed channel's constants, in a module with no imports: `properties.ts`
 * reads them while the module graph is still initialising, and through
 * `retime.ts` (→ clip-registry → …) they arrived as `undefined` whenever the
 * API was the first thing loaded — the Speed property then had no key.
 */

/** The path that holds a clip's speed keys — an ordinary animatable property. */
export const SPEED_PROPERTY = "playback.speed";

/** Never let a curve run backwards past a standstill by accident. */
export const MIN_SPEED = -16;
export const MAX_SPEED = 64;
