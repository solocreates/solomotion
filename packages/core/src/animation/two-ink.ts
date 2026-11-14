/**
 * TWO-INK SEPARATION — how much of each of two inks prints a colour on paper,
 * the question a risograph (and any two-colour press) answers per drum.
 *
 * Inks are subtractive: a layer of ink at coverage `a` passes `T^a` of each
 * channel, where T is the ink's colour over the paper's (its transmittance).
 * Two inks over paper P give P·Tₐ^a·T_b^b, so in log space the colour is a
 * linear blend of the two inks' log-transmittances. Solving that for (a, b) by
 * least squares over the three channels, clamped to [0, 1], is the honest
 * separation: warm colours land on a pink drum, cool and dark ones on a blue
 * one, and their overlaps print the purples a riso is loved for — where a
 * gradient map could only paint everything one hue by brightness.
 *
 * Pure numbers, so the renderer and a test agree. Channels are 0..255.
 */
export function twoInkSeparation(
  color: readonly [number, number, number],
  paper: readonly [number, number, number],
  inkA: readonly [number, number, number],
  inkB: readonly [number, number, number],
): [number, number] {
  return twoInkSeparator(paper, inkA, inkB)(color[0], color[1], color[2]);
}

/**
 * The same separation with the paper and inks fixed — what a screen of ten
 * thousand cells wants: the inks' logs and the normal matrix are worked out
 * once, and each cell costs three logs and a 2×2 solve.
 */
export function twoInkSeparator(
  paper: readonly [number, number, number],
  inkA: readonly [number, number, number],
  inkB: readonly [number, number, number],
): (r: number, g: number, b: number) => [number, number] {
  const p = [Math.max(1, paper[0]), Math.max(1, paper[1]), Math.max(1, paper[2])];
  const ta = [0, 1, 2].map((c) => Math.log(clampT(inkA[c]! / p[c]!)));
  const tb = [0, 1, 2].map((c) => Math.log(clampT(inkB[c]! / p[c]!)));
  // Normal equations of min |a·ta + b·tb − y|².
  const aa = ta[0]! * ta[0]! + ta[1]! * ta[1]! + ta[2]! * ta[2]!;
  const ab = ta[0]! * tb[0]! + ta[1]! * tb[1]! + ta[2]! * tb[2]!;
  const bb = tb[0]! * tb[0]! + tb[1]! * tb[1]! + tb[2]! * tb[2]!;
  const det = aa * bb - ab * ab;
  return (r, g, bl) => {
    const y0 = Math.log(clampT(r / p[0]!));
    const y1 = Math.log(clampT(g / p[1]!));
    const y2 = Math.log(clampT(bl / p[2]!));
    const ay = ta[0]! * y0 + ta[1]! * y1 + ta[2]! * y2;
    const by = tb[0]! * y0 + tb[1]! * y1 + tb[2]! * y2;
    let a = det > 1e-9 ? (ay * bb - by * ab) / det : aa > 0 ? ay / aa : 0;
    let b = det > 1e-9 ? (by * aa - ay * ab) / det : bb > 0 ? by / bb : 0;
    // A negative coverage is not printable: pin it and re-solve the other alone.
    if (a < 0) {
      a = 0;
      b = bb > 0 ? by / bb : 0;
    } else if (b < 0) {
      b = 0;
      a = aa > 0 ? ay / aa : 0;
    }
    return [clamp01(a), clamp01(b)];
  };
}

/** Transmittance, kept off zero (black ink still has a log) and at most paper. */
function clampT(t: number): number {
  return t < 0.02 ? 0.02 : t > 1 ? 1 : t;
}

function clamp01(v: number): number {
  return v <= 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}
