/**
 * `@solomotion/lipsync/spectral` — the offline DSP analyze engine (lazy entry).
 * The root registers its metadata; this module is what `load()` imports.
 */
export { spectralImpl as impl, spectralImpl, spectralCues, type SpectralOptions } from "./engines/spectral";
export { fft, extractFeatures, type FrameFeatures } from "./dsp";
