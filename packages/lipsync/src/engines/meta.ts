/**
 * Built-in engine METADATA — ids, versions and settings defaults, the cheap
 * half both the root registry and the lazy implementations import, so a
 * default lives in exactly one place. No implementation code here.
 */

export const SPECTRAL = {
  id: "spectral",
  version: 2,
  defaults: { minCueMs: 60, smoothing: 2, sensitivity: 0.5 },
} as const;

export const ALIGN = {
  id: "align",
  version: 1,
  /** language for G2P; minGapMs: shorter inter-word gaps hold the mouth instead of resting. */
  defaults: { language: "en", minGapMs: 80 },
} as const;

export const TEST_VOICE = {
  id: "test-voice",
  version: 1,
  defaults: { preset: "warm", seed: 1, rate: 1, sampleRate: 22050 },
} as const;
