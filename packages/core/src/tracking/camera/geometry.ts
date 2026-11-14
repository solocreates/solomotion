import { apply3, choleskySolve, det3, expSO3, mul3, nullVector, svd3, transpose3, vadd, vdot, vlen, vnorm, vscale, vsub, type M3, type V3 } from "./linalg";

/**
 * MULTIPLE-VIEW GEOMETRY — the pieces the camera solve is assembled from.
 *
 * Conventions (computer vision, solver-internal): a camera maps a world point
 * X to camera space by `Xc = R·X + t` (world → camera), looks down +Z with x
 * right and y DOWN, and projects to pixels by `u = f·x/z + cx`. Points handed
 * to these functions are NORMALISED image coordinates — `(u − cx)/f` — so the
 * geometry is independent of the lens, and thresholds arrive divided by f.
 */

export interface Pose {
  R: M3;
  t: V3;
}

export const IDENTITY_POSE = (): Pose => ({ R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });

export function toCamera(p: Pose, X: V3): V3 {
  return vadd(apply3(p.R, X), p.t);
}

/** The camera's centre in the world: −Rᵀt. */
export function cameraCentre(p: Pose): V3 {
  return vscale(apply3(transpose3(p.R), p.t), -1);
}

// ── Essential matrix ─────────────────────────────────────────────────────────

/** Sampson distance of a correspondence to x2ᵀ E x1 = 0, in normalised units. */
export function sampson(E: M3, x1: number, y1: number, x2: number, y2: number): number {
  const ex0 = E[0]! * x1 + E[1]! * y1 + E[2]!;
  const ex1 = E[3]! * x1 + E[4]! * y1 + E[5]!;
  const ex2 = E[6]! * x1 + E[7]! * y1 + E[8]!;
  const et0 = E[0]! * x2 + E[3]! * y2 + E[6]!;
  const et1 = E[1]! * x2 + E[4]! * y2 + E[7]!;
  const num = x2 * ex0 + y2 * ex1 + ex2;
  const den = ex0 * ex0 + ex1 * ex1 + et0 * et0 + et1 * et1;
  return den > 0 ? Math.abs(num) / Math.sqrt(den) : Infinity;
}

/** Linear (8+ point) essential matrix through `idx`, projected onto the essential manifold. */
export function essentialFrom(a: ArrayLike<number>, b: ArrayLike<number>, idx: ArrayLike<number>): M3 | null {
  const n = idx.length;
  if (n < 8) return null;
  const rows = new Float64Array(n * 9);
  for (let k = 0; k < n; k++) {
    const i = idx[k]!;
    const x1 = a[2 * i]!, y1 = a[2 * i + 1]!, x2 = b[2 * i]!, y2 = b[2 * i + 1]!;
    rows.set([x2 * x1, x2 * y1, x2, y2 * x1, y2 * y1, y2, x1, y1, 1], k * 9);
  }
  const e = nullVector(rows, n, 9);
  const { U, s, V } = svd3(e);
  const m = (s[0] + s[1]) / 2;
  if (!(m > 0)) return null;
  // E = U · diag(1,1,0) · Vᵀ
  const D: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 0];
  return mul3(mul3(U, D), transpose3(V));
}

export interface RansacResult<T> {
  model: T;
  inliers: Uint8Array;
  count: number;
}

/**
 * Essential matrix by RANSAC over correspondences `a[i] ↔ b[i]` (flat xy,
 * normalised). `threshold` is the Sampson distance an inlier stays within.
 * The winner is refitted on all its inliers.
 */
export function essentialRansac(a: ArrayLike<number>, b: ArrayLike<number>, threshold: number, iterations: number, rand: () => number): RansacResult<M3> | null {
  const n = a.length / 2;
  if (n < 8) return null;
  let best: M3 | null = null;
  let bestCount = 0;
  const sample = new Int32Array(8);
  const score = (E: M3) => {
    let c = 0;
    for (let i = 0; i < n; i++) if (sampson(E, a[2 * i]!, a[2 * i + 1]!, b[2 * i]!, b[2 * i + 1]!) < threshold) c++;
    return c;
  };
  for (let it = 0; it < iterations; it++) {
    for (let k = 0; k < 8; k++) {
      let pick: number;
      do pick = Math.floor(rand() * n);
      while (sample.subarray(0, k).includes(pick));
      sample[k] = pick;
    }
    const E = essentialFrom(a, b, sample);
    if (!E) continue;
    const c = score(E);
    if (c > bestCount) {
      bestCount = c;
      best = E;
      // Adaptive stop: once this many inliers make a miss astronomically unlikely.
      const w = c / n;
      const need = Math.log(0.001) / Math.log(Math.max(1e-9, 1 - Math.pow(w, 8)));
      if (it > need && it > 64) break;
    }
  }
  if (!best) return null;
  // Refit on the inliers, twice (the refit's inlier set can only grow).
  for (let pass = 0; pass < 2; pass++) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (sampson(best, a[2 * i]!, a[2 * i + 1]!, b[2 * i]!, b[2 * i + 1]!) < threshold) idx.push(i);
    const E = essentialFrom(a, b, idx);
    if (!E) break;
    const c = score(E);
    if (c < bestCount) break;
    best = E;
    bestCount = c;
  }
  const inliers = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) if (sampson(best, a[2 * i]!, a[2 * i + 1]!, b[2 * i]!, b[2 * i + 1]!) < threshold) (inliers[i] = 1), count++;
  return { model: best, inliers, count };
}

/**
 * The relative pose (second camera, first at the identity) an essential matrix
 * stands for: four candidates, the one that puts the most points IN FRONT of
 * both cameras wins (cheirality). `t` has unit length — the scale of a
 * two-view reconstruction is not observable.
 */
export function poseFromEssential(E: M3, a: ArrayLike<number>, b: ArrayLike<number>, inliers: Uint8Array): { pose: Pose; front: number } | null {
  let { U, V } = svd3(E);
  if (det3(U) < 0) U = U.map((v, i) => (i % 3 === 2 ? -v : v));
  if (det3(V) < 0) V = V.map((v, i) => (i % 3 === 2 ? -v : v));
  const W: M3 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
  const Vt = transpose3(V);
  const R1 = mul3(mul3(U, W), Vt);
  const R2 = mul3(mul3(U, transpose3(W)), Vt);
  const u3: V3 = [U[2]!, U[5]!, U[8]!];
  const cands: Pose[] = [
    { R: R1, t: u3 },
    { R: R1, t: vscale(u3, -1) },
    { R: R2, t: u3 },
    { R: R2, t: vscale(u3, -1) },
  ];
  const P0 = IDENTITY_POSE();
  let best: Pose | null = null;
  let bestFront = -1;
  for (const c of cands) {
    let front = 0;
    for (let i = 0; i < inliers.length; i++) {
      if (!inliers[i]) continue;
      const X = triangulate([P0, c], [a[2 * i]!, a[2 * i + 1]!, b[2 * i]!, b[2 * i + 1]!]);
      if (X && X[2] > 0 && toCamera(c, X)[2] > 0) front++;
    }
    if (front > bestFront) {
      bestFront = front;
      best = c;
    }
  }
  return best ? { pose: best, front: bestFront } : null;
}

// ── Homography (the degeneracy test) ─────────────────────────────────────────

function homographyFrom(a: ArrayLike<number>, b: ArrayLike<number>, idx: ArrayLike<number>): M3 | null {
  const n = idx.length;
  if (n < 4) return null;
  const rows = new Float64Array(2 * n * 9);
  for (let k = 0; k < n; k++) {
    const i = idx[k]!;
    const x = a[2 * i]!, y = a[2 * i + 1]!, u = b[2 * i]!, v = b[2 * i + 1]!;
    rows.set([-x, -y, -1, 0, 0, 0, u * x, u * y, u], 2 * k * 9);
    rows.set([0, 0, 0, -x, -y, -1, v * x, v * y, v], (2 * k + 1) * 9);
  }
  const h = nullVector(rows, 2 * n, 9);
  return Math.abs(h[8]!) > 1e-12 ? h.map((v) => v / h[8]!) : h;
}

export function homographyError(H: M3, x: number, y: number, u: number, v: number): number {
  const w = H[6]! * x + H[7]! * y + H[8]!;
  if (Math.abs(w) < 1e-12) return Infinity;
  return Math.hypot((H[0]! * x + H[1]! * y + H[2]!) / w - u, (H[3]! * x + H[4]! * y + H[5]!) / w - v);
}

/**
 * A homography by RANSAC. Used to ask "does a plane or a pure rotation
 * explain this pair as well as real 3D does?" — if it does, the pair carries
 * no usable depth and must not seed the reconstruction (the classic failure of
 * initialising on a pan).
 */
export function homographyRansac(a: ArrayLike<number>, b: ArrayLike<number>, threshold: number, iterations: number, rand: () => number): RansacResult<M3> | null {
  const n = a.length / 2;
  if (n < 4) return null;
  let best: M3 | null = null;
  let bestCount = 0;
  const sample = new Int32Array(4);
  for (let it = 0; it < iterations; it++) {
    for (let k = 0; k < 4; k++) {
      let pick: number;
      do pick = Math.floor(rand() * n);
      while (sample.subarray(0, k).includes(pick));
      sample[k] = pick;
    }
    const H = homographyFrom(a, b, sample);
    if (!H) continue;
    let c = 0;
    for (let i = 0; i < n; i++) if (homographyError(H, a[2 * i]!, a[2 * i + 1]!, b[2 * i]!, b[2 * i + 1]!) < threshold) c++;
    if (c > bestCount) {
      bestCount = c;
      best = H;
    }
  }
  if (!best) return null;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (homographyError(best, a[2 * i]!, a[2 * i + 1]!, b[2 * i]!, b[2 * i + 1]!) < threshold) idx.push(i);
  const refit = homographyFrom(a, b, idx) ?? best;
  const inliers = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) if (homographyError(refit, a[2 * i]!, a[2 * i + 1]!, b[2 * i]!, b[2 * i + 1]!) < threshold) (inliers[i] = 1), count++;
  return { model: refit, inliers, count };
}

// ── Triangulation ────────────────────────────────────────────────────────────

/**
 * The point seen at normalised `xy[2k], xy[2k+1]` by `poses[k]` — linear
 * (DLT) over every view. Null when the rays are (near) parallel.
 */
export function triangulate(poses: Pose[], xy: ArrayLike<number>): V3 | null {
  const n = poses.length;
  const rows = new Float64Array(2 * n * 4);
  for (let k = 0; k < n; k++) {
    const { R, t } = poses[k]!;
    const x = xy[2 * k]!, y = xy[2 * k + 1]!;
    // x·P3 − P1, y·P3 − P2 with P = [R | t].
    for (let c = 0; c < 4; c++) {
      const p1 = c < 3 ? R[c]! : t[0];
      const p2 = c < 3 ? R[3 + c]! : t[1];
      const p3 = c < 3 ? R[6 + c]! : t[2];
      rows[(2 * k) * 4 + c] = x * p3 - p1;
      rows[(2 * k + 1) * 4 + c] = y * p3 - p2;
    }
  }
  const h = nullVector(rows, 2 * n, 4);
  if (Math.abs(h[3]!) < 1e-12) return null;
  return [h[0]! / h[3]!, h[1]! / h[3]!, h[2]! / h[3]!];
}

/** The widest angle (degrees) between rays from the camera centres to X — how well it is triangulated. */
export function triangulationAngle(centres: V3[], X: V3): number {
  let best = 0;
  for (let i = 0; i < centres.length; i++)
    for (let j = i + 1; j < centres.length; j++) {
      const a = vnorm(vsub(X, centres[i]!));
      const b = vnorm(vsub(X, centres[j]!));
      best = Math.max(best, Math.acos(Math.max(-1, Math.min(1, vdot(a, b)))));
    }
  return (best * 180) / Math.PI;
}

// ── Pose from known points (PnP by robust Gauss–Newton) ──────────────────────

export interface PoseFit {
  pose: Pose;
  /** Inlier flags against `threshold`. */
  inliers: Uint8Array;
  count: number;
  /** RMS error over inliers, normalised units. */
  rms: number;
}

/**
 * Refine a camera's pose against points it sees: Gauss–Newton on the
 * reprojection error with a Huber weight, from `start` (in video, the
 * neighbouring frame's pose — never far off). Outliers beyond `threshold`
 * (normalised) are dropped between rounds, so a passer-by's features do not
 * pull the camera.
 */
export function refinePose(start: Pose, X: ArrayLike<number>, xy: ArrayLike<number>, threshold: number, rounds = 3): PoseFit {
  const n = xy.length / 2;
  let pose: Pose = { R: start.R.slice(), t: [...start.t] as V3 };
  let use = new Uint8Array(n).fill(1);
  const H = new Float64Array(36);
  const g = new Float64Array(6);
  for (let round = 0; round < rounds; round++) {
    const huber = threshold * (round === 0 ? 4 : 1.5);
    for (let it = 0; it < 12; it++) {
      H.fill(0);
      g.fill(0);
      let used = 0;
      for (let i = 0; i < n; i++) {
        if (!use[i]) continue;
        const Xi: V3 = [X[3 * i]!, X[3 * i + 1]!, X[3 * i + 2]!];
        const c = vadd(apply3(pose.R, Xi), pose.t);
        if (c[2] <= 1e-9) continue;
        const iz = 1 / c[2];
        const px = c[0] * iz, py = c[1] * iz;
        const rx = px - xy[2 * i]!, ry = py - xy[2 * i + 1]!;
        const e = Math.hypot(rx, ry);
        const w = e <= huber ? 1 : huber / e;
        // d(px,py)/dc
        const a0 = iz, a2 = -px * iz, b1 = iz, b2 = -py * iz;
        // The update is applied on the LEFT (T ← ΔT·T), so dc/dω = −[c]×, dc/dt = I.
        const S = [0, c[2], -c[1], -c[2], 0, c[0], c[1], -c[0], 0]; // −skew(c), row-major
        const J0 = [a0 * S[0]! + a2 * S[6]!, a0 * S[1]! + a2 * S[7]!, a0 * S[2]! + a2 * S[8]!, a0, 0, a2];
        const J1 = [b1 * S[3]! + b2 * S[6]!, b1 * S[4]! + b2 * S[7]!, b1 * S[5]! + b2 * S[8]!, 0, b1, b2];
        for (let r = 0; r < 6; r++) {
          g[r] = g[r]! + w * (J0[r]! * rx + J1[r]! * ry);
          for (let q = r; q < 6; q++) H[r * 6 + q] = H[r * 6 + q]! + w * (J0[r]! * J0[q]! + J1[r]! * J1[q]!);
        }
        used++;
      }
      if (used < 6) break;
      for (let r = 0; r < 6; r++) for (let q = 0; q < r; q++) H[r * 6 + q] = H[q * 6 + r]!;
      for (let r = 0; r < 6; r++) H[r * 6 + r] = H[r * 6 + r]! * (1 + 1e-6);
      const d = new Float64Array(6);
      for (let r = 0; r < 6; r++) d[r] = -g[r]!;
      if (!choleskySolve(H, d, 6)) break;
      const dR = expSO3([d[0]!, d[1]!, d[2]!]);
      pose = { R: mul3(dR, pose.R), t: vadd(apply3(dR, pose.t), [d[3]!, d[4]!, d[5]!]) };
      if (Math.hypot(d[0]!, d[1]!, d[2]!) < 1e-10 && Math.hypot(d[3]!, d[4]!, d[5]!) < 1e-10 * Math.max(1, vlen(pose.t))) break;
    }
    // Drop what disagrees, then refine on the rest.
    const next = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const c = toCamera(pose, [X[3 * i]!, X[3 * i + 1]!, X[3 * i + 2]!]);
      if (c[2] <= 1e-9) continue;
      if (Math.hypot(c[0] / c[2] - xy[2 * i]!, c[1] / c[2] - xy[2 * i + 1]!) < threshold * (round < rounds - 1 ? 3 : 1)) next[i] = 1;
    }
    use = next;
  }
  let count = 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    if (!use[i]) continue;
    const c = toCamera(pose, [X[3 * i]!, X[3 * i + 1]!, X[3 * i + 2]!]);
    sq += (c[0] / c[2] - xy[2 * i]!) ** 2 + (c[1] / c[2] - xy[2 * i + 1]!) ** 2;
    count++;
  }
  return { pose, inliers: use, count, rms: count ? Math.sqrt(sq / count) : Infinity };
}

/** Rotation-only: the rotation best mapping directions `a` onto `b` (Kabsch, unit weights). */
export function rotationBetween(a: V3[], b: V3[]): M3 {
  const Hm: M3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < a.length; i++)
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) Hm[r * 3 + c] = Hm[r * 3 + c]! + b[i]![r]! * a[i]![c]!;
  const { U, V } = svd3(Hm);
  let R = mul3(U, transpose3(V));
  if (det3(R) < 0) {
    const U2 = U.map((v, i) => (i % 3 === 2 ? -v : v));
    R = mul3(U2, transpose3(V));
  }
  return R;
}

