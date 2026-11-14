/**
 * BLACKBODY COLOUR — the colour of something glowing at `kelvin`, the one
 * answer every surface asks: a Star's photosphere, particles coloured by
 * temperature, a grade. Two copies would disagree about what 5,800 K looks
 * like, so there is one, here.
 *
 * Computed, not looked up from a hand-tuned curve: Planck's law integrated
 * over the visible band against the CIE 1931 2° observer (Wyman, Sloan &
 * Shirley's analytic multi-lobe fit, accurate to the tabulated functions well
 * inside a JND), to XYZ, to linear sRGB, clipped into gamut, normalised so the
 * brightest channel is 1 (a chromaticity — how BRIGHT a thing is at that
 * temperature is the caller's to decide; T⁴ would make every ember black), and
 * encoded. 1,000 K is a dull red, 1,900 K a candle, 5,800 K sunlight, 6,500 K
 * white, 30,000 K the violent blue-white of a giant.
 *
 * Built once into a table every 50 K from 500 K to 50,000 K and read with a
 * lerp, so a shader's uniforms and a particle palette pay nothing per call.
 */

export interface Rgb01 {
  r: number;
  g: number;
  b: number;
}

/** The range the table covers; outside it the ends hold. */
export const BLACKBODY_MIN_K = 500;
export const BLACKBODY_MAX_K = 50000;
const STEP_K = 50;

/** One lobe of the CIE fit: a Gaussian with a different width either side of its peak. */
function lobe(l: number, mu: number, s1: number, s2: number): number {
  const t = (l - mu) / (l < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}

function cie(l: number): [number, number, number] {
  return [
    1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2),
    0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1),
    1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8),
  ];
}

/** Planck's spectral radiance at `nm` for `kelvin`, up to a constant (c₂ = hc/k). */
function planck(nm: number, kelvin: number): number {
  const l = nm * 1e-9;
  return 1 / (l ** 5 * (Math.exp(1.4388e-2 / (l * kelvin)) - 1));
}

const encode = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** Linear sRGB of a blackbody, brightest channel 1. */
function exact(kelvin: number): [number, number, number] {
  let X = 0, Y = 0, Z = 0;
  for (let nm = 380; nm <= 780; nm += 5) {
    const p = planck(nm, kelvin);
    const [x, y, z] = cie(nm);
    X += p * x, Y += p * y, Z += p * z;
  }
  const r = Math.max(0, 3.2406 * X - 1.5372 * Y - 0.4986 * Z);
  const g = Math.max(0, -0.9689 * X + 1.8758 * Y + 0.0415 * Z);
  const b = Math.max(0, 0.0557 * X - 0.204 * Y + 1.057 * Z);
  const m = Math.max(r, g, b) || 1;
  return [r / m, g / m, b / m];
}

let table: Float32Array | null = null;

function lut(): Float32Array {
  if (table) return table;
  const n = Math.round((BLACKBODY_MAX_K - BLACKBODY_MIN_K) / STEP_K) + 1;
  table = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) table.set(exact(BLACKBODY_MIN_K + i * STEP_K), i * 3);
  return table;
}

/** Linear-light blackbody colour, brightest channel 1 — what a shader that adds light wants. */
export function blackbodyLinear(kelvin: number): Rgb01 {
  const t = lut();
  const f = (Math.min(BLACKBODY_MAX_K, Math.max(BLACKBODY_MIN_K, Number.isFinite(kelvin) ? kelvin : 6500)) - BLACKBODY_MIN_K) / STEP_K;
  const i = Math.min(t.length / 3 - 2, Math.floor(f)), a = f - i;
  const at = (k: number) => t[i * 3 + k]! + (t[(i + 1) * 3 + k]! - t[i * 3 + k]!) * a;
  return { r: at(0), g: at(1), b: at(2) };
}

/** The sRGB colour (0..1, display-encoded) of a body glowing at `kelvin`. */
export function blackbody(kelvin: number): Rgb01 {
  const c = blackbodyLinear(kelvin);
  return { r: encode(c.r), g: encode(c.g), b: encode(c.b) };
}

/** `#rrggbb` of {@link blackbody}. */
export function blackbodyHex(kelvin: number): string {
  const c = blackbody(kelvin);
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
