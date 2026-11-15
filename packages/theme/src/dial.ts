/**
 * THE DIAL — the mark's geometry, as pure functions.
 *
 * The wordmark's four o's are filled discs, each with a brighter quarter
 * pointing up, right, down, left: four frames of one turn, read clockwise. The
 * small mark is ONE dial (quarter up), and the loader is that dial turning a
 * quarter per beat. Every surface that draws the mark draws it from here, so
 * the wedge is the same shape in a 13px favicon and a 200px hero.
 */

/** Up, right, down, left — degrees clockwise from twelve o'clock. */
export const DIAL_DIRECTIONS = [0, 90, 180, 270] as const;

/** SVG path of a quarter wedge of an ellipse, centred on `dir` (0 = up). */
export function wedgePath(cx: number, cy: number, rx: number, ry: number, dir: number): string {
  const a = (deg: number) => ((deg - 90) * Math.PI) / 180;
  const p = (deg: number) => `${(cx + rx * Math.cos(a(deg))).toFixed(2)} ${(cy + ry * Math.sin(a(deg))).toFixed(2)}`;
  return `M${cx} ${cy}L${p(dir - 45)}A${rx} ${ry} 0 0 1 ${p(dir + 45)}Z`;
}

/** Where a font's own "o" sits, in a 100-unit em box, MEASURED rather than
 *  guessed, so the disc covers exactly the glyph it replaces. */
export interface OMetrics {
  /** Advance width of the "o". */
  adv: number;
  /** Baseline from the top of a 1em line box. */
  base: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** The subset of `TextMetrics` the measurement needs (a canvas provides it). */
export interface GlyphMetrics {
  width: number;
  actualBoundingBoxLeft: number;
  actualBoundingBoxRight: number;
  actualBoundingBoxAscent: number;
  actualBoundingBoxDescent: number;
  fontBoundingBoxAscent: number;
  fontBoundingBoxDescent: number;
}

/** Text metrics of "o" set at 100px → where the disc goes. */
export function oMetricsFrom(m: GlyphMetrics): OMetrics {
  const A = m.fontBoundingBoxAscent;
  const D = m.fontBoundingBoxDescent;
  const base = (100 - (A + D)) / 2 + A;
  const top = base - m.actualBoundingBoxAscent;
  const bot = base + m.actualBoundingBoxDescent;
  const left = -m.actualBoundingBoxLeft;
  const right = m.actualBoundingBoxRight;
  return { adv: m.width, base, cx: (left + right) / 2, cy: (top + bot) / 2, rx: (right - left) / 2, ry: (bot - top) / 2 };
}

/**
 * The wordmark's o's for one family, measured once per family and weight.
 * Space Grotesk 600 at 100px (the face next/font serves), as measured in
 * Chrome, ships as the default so the first paint is already right and the
 * client's one measurement changes nothing. Re-measure if the face changes:
 * a stale default is a visible jump on every boot.
 */
export const DEFAULT_O: OMetrics = { adv: 61.34, base: 84.5, cx: 30.67, cy: 59.79, rx: 25.75, ry: 26.11 };

/** "solomotion" split around its four o's, with the dial each one wears. */
export const WORDMARK_PARTS: ReadonlyArray<{ text: string } | { o: 0 | 1 | 2 | 3 }> = [
  { text: "s" },
  { o: 0 },
  { text: "l" },
  { o: 1 },
  { text: "m" },
  { o: 2 },
  { text: "ti" },
  { o: 3 },
  { text: "n" },
];

/**
 * THE ORBIT — a dial with moons. The centre dial turns; around it sit moons
 * that each spin on their own. When the centre's lit quarter sweeps toward a
 * moon, the moon is caught: it swings round to face the centre (tidal lock,
 * the Moon showing Earth one face), holds while the quarter passes, and when
 * the quarter moves on it lets go and drifts back into its own spin. The ring
 * itself never moves. Pure state + one step function, so the physics is
 * testable and the view only writes transforms.
 *
 * Nothing jumps: speeds ease (exponential, frame-rate independent), the catch
 * is a damped spring whose strength rises smoothly with how squarely the
 * quarter points at the moon, so the turn reads as mass, not a snap.
 */
export interface MoonState {
  /** Where the moon's lit quarter points, degrees (0 = up, clockwise). */
  a: number;
  /** Angular velocity, degrees per second. */
  v: number;
}

export interface OrbitState {
  /** Centre quarter's direction, degrees. */
  spin: number;
  /** Centre angular velocity, degrees per second. */
  spinV: number;
  moons: MoonState[];
}

/** The ring position of moon `i` of `n`, degrees from up, clockwise. */
export const moonAt = (i: number, n: number) => (i / n) * 360;

/** A moon's own spin, deg/s: varied per moon (and some turn the other way) so the ring never moves in step. */
export const moonSpin = (i: number) => (i % 3 === 0 ? -1 : 1) * (70 + ((i * 37) % 60));

export function orbitRest(n: number): OrbitState {
  return { spin: 0, spinV: 0, moons: Array.from({ length: n }, (_, i) => ({ a: (i * 97) % 360, v: 0 })) };
}

/** Shortest signed angle from `a` to `b`, in (-180, 180]. */
export function angleTo(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/** How squarely the centre's quarter points at a moon, 0..1 (a quarter about 40° wide catches). */
export function catchOf(spin: number, at: number): number {
  const c = Math.cos((angleTo(spin, at) * Math.PI) / 180);
  return c <= 0 ? 0 : Math.pow(c, 4);
}

/**
 * Advance the orbit by `dt` seconds toward a centre speed of `turnsPerSec`.
 * `dt` is clamped so a tab that slept for a minute resumes calmly.
 */
export function stepOrbit(s: OrbitState, turnsPerSec: number, dt: number): OrbitState {
  const t = Math.min(Math.max(dt, 0), 1 / 20);
  const ease = (tau: number) => 1 - Math.exp(-t / tau);
  const spinV = s.spinV + (turnsPerSec * 360 - s.spinV) * ease(0.45);
  const spin = (s.spin + spinV * t) % 360;
  const n = s.moons.length;
  const moons = s.moons.map((m, i) => {
    const at = moonAt(i, n);
    const pull = catchOf(spin, at);
    // Free: ease toward its own spin. Caught: a damped spring toward facing the centre.
    const face = at + 180;
    const k = 300;
    const c = 2 * Math.sqrt(k);
    // Semi-implicit: the damping terms are solved for the NEW velocity, so a
    // long frame cannot overshoot and ring.
    const drive = k * angleTo(m.a, face) * pull + moonSpin(i) * 2.2 * (1 - pull);
    const damp = c * pull + 2.2 * (1 - pull);
    const v = (m.v + drive * t) / (1 + damp * t);
    return { a: (m.a + v * t + 360) % 360, v };
  });
  return { spin, spinV, moons };
}
