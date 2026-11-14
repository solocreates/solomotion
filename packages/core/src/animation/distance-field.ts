/**
 * A SIGNED DISTANCE FIELD from a binary mask — exact Euclidean, in O(n).
 *
 * The one geometric fact a material needs about a layer: for every pixel, how
 * far is the nearest edge, and on which side am I. The GPU renderer answers it
 * with a jump-flood over the same seeds; this is the same answer in plain
 * arithmetic for the CPU fallback and for tests, so the two engines can be
 * held to one truth rather than two approximations.
 *
 * Felzenszwalb & Huttenlocher's lower-envelope transform: a 1-D pass along
 * every row, then along every column of the result. No search radius, no
 * iterations, no error — a pixel `k` in from a straight edge reports exactly
 * `k + 0.5`.
 *
 * Seeds are the INSIDE pixels that touch the outside (4-neighbourhood). Inside
 * pixels therefore measure the distance to their own boundary ring; outside
 * pixels measure the distance to it too and come back negative. Half a pixel
 * is added so the edge itself — which runs between the boundary ring and the
 * first outside pixel — reads as zero on both sides.
 */

const INF = 1e20;

/**
 * `inside` is one byte per pixel (non-zero = inside). Returns one float per
 * pixel: distance to the edge in px, positive inside, negative outside.
 * Pixels further than `reach` from any seed come back as ±`reach` — the
 * caller declared it does not care past there, and saying so lets it read the
 * field with a clamp instead of a branch.
 */
export function signedDistanceField(inside: Uint8Array, w: number, h: number, reach = Infinity): Float32Array {
  const n = w * h;
  const f = new Float32Array(n);
  const at = (x: number, y: number) => inside[y * w + x]! !== 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!at(x, y)) {
        f[i] = INF;
        continue;
      }
      const edge =
        x === 0 || y === 0 || x === w - 1 || y === h - 1 || !at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1);
      f[i] = edge ? 0 : INF;
    }
  }
  const d2 = squaredDistanceTransform(f, w, h);
  const out = new Float32Array(n);
  const cap = Number.isFinite(reach) ? reach : INF;
  for (let i = 0; i < n; i++) {
    const d = Math.sqrt(d2[i]!);
    // The true edge runs half a pixel outside the ring's centres.
    out[i] = inside[i]! !== 0 ? Math.min(cap, d + 0.5) : -Math.min(cap, Math.max(0, d - 0.5));
  }
  return out;
}

/** Squared EDT of a grid where seeds hold 0 and everything else INF. */
function squaredDistanceTransform(f: Float32Array, w: number, h: number): Float32Array {
  const n = Math.max(w, h);
  const line = new Float32Array(n);
  const d = new Float32Array(n);
  const v = new Int32Array(n);
  const z = new Float32Array(n + 1);
  const out = new Float32Array(w * h);

  // Rows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) line[x] = f[y * w + x]!;
    edt1d(line, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x]!;
  }
  // Columns.
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = out[y * w + x]!;
    edt1d(line, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y]!;
  }
  return out;
}

/** One-dimensional squared distance transform (lower envelope of parabolas). */
function edt1d(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dx = q - v[k]!;
    d[q] = dx * dx + f[v[k]!]!;
  }
}
