/**
 * SMALL DENSE LINEAR ALGEBRA for the camera solve — what multiple-view
 * geometry needs and nothing more: symmetric eigen (Jacobi), a 3×3 SVD built
 * on it, dense Cholesky, rotations as axis-angle and quaternions.
 *
 * Matrices are ROW-MAJOR `number[]` / `Float64Array` (the CV literature's
 * layout — this is solver-internal; the world's column-major `Mat4` is only
 * met at the reader, `read-camera.ts`). Deterministic and allocation-light:
 * a solve calls these tens of thousands of times.
 */

export type M3 = number[]; // 9, row-major
export type V3 = [number, number, number];

// ── 3-vectors and 3×3 ────────────────────────────────────────────────────────

export const vsub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vadd = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vscale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vlen = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export function vnorm(a: V3): V3 {
  const l = vlen(a);
  return l > 1e-300 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

export const I3 = (): M3 => [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul3(a: M3, b: M3): M3 {
  const o = new Array<number>(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return o;
}

export function transpose3(a: M3): M3 {
  return [a[0]!, a[3]!, a[6]!, a[1]!, a[4]!, a[7]!, a[2]!, a[5]!, a[8]!];
}

export function apply3(m: M3, v: V3): V3 {
  return [m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2]];
}

export function det3(m: M3): number {
  return m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) + m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
}

export function skew(v: V3): M3 {
  return [0, -v[2], v[1], v[2], 0, -v[0], -v[1], v[0], 0];
}

// ── Symmetric eigen (cyclic Jacobi) ─────────────────────────────────────────

/**
 * Eigen-decomposition of a symmetric n×n matrix (row-major, not modified).
 * Values ASCENDING; `vectors` holds the matching eigenvectors as COLUMNS.
 * Jacobi is slow for big n and exact for the small ones we have (≤ 12): the
 * null vector of an 8-point system is its first column.
 */
export function symEig(A: ArrayLike<number>, n: number): { values: number[]; vectors: Float64Array } {
  const a = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) a[i] = A[i]!;
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  let scale = 0;
  for (let i = 0; i < n * n; i++) scale += a[i]! * a[i]!;
  // Converged when the off-diagonal is negligible RELATIVE to the matrix — an
  // absolute floor made large-valued matrices run every sweep.
  const tol = scale * 1e-28;
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q]! * a[p * n + q]!;
    if (off <= tol) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q]!;
        if (apq * apq <= tol * 1e-4) continue;
        const app = a[p * n + p]!;
        const aqq = a[q * n + q]!;
        const theta = (aqq - app) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p]!;
          const akq = a[k * n + q]!;
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k]!;
          const aqk = a[q * n + k]!;
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p]!;
          const vkq = v[k * n + q]!;
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i * n + i]! - a[j * n + j]!);
  const values = order.map((i) => a[i * n + i]!);
  const vectors = new Float64Array(n * n);
  for (let c = 0; c < n; c++) for (let r = 0; r < n; r++) vectors[r * n + c] = v[r * n + order[c]!]!;
  return { values, vectors };
}

/** The unit vector x minimising |A x| for A (rows × n): AᵀA's least eigenvector. */
export function nullVector(rows: ArrayLike<number>, count: number, n: number): number[] {
  const ata = new Float64Array(n * n);
  for (let r = 0; r < count; r++) {
    const o = r * n;
    for (let i = 0; i < n; i++) {
      const ai = rows[o + i]!;
      if (ai === 0) continue;
      for (let j = i; j < n; j++) ata[i * n + j] = ata[i * n + j]! + ai * rows[o + j]!;
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) ata[i * n + j] = ata[j * n + i]!;
  const { vectors } = symEig(ata, n);
  return Array.from({ length: n }, (_, r) => vectors[r * n]!);
}

/** SVD of a 3×3: M = U · diag(s) · Vᵀ, s descending, U and V orthonormal (not forced to det +1). */
export function svd3(m: M3): { U: M3; s: V3; V: M3 } {
  const mtm = mul3(transpose3(m), m);
  const { values, vectors } = symEig(mtm, 3);
  // Descending.
  const idx = [2, 1, 0];
  const V: M3 = new Array(9);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) V[r * 3 + c] = vectors[r * 3 + idx[c]!]!;
  const s: V3 = [Math.sqrt(Math.max(0, values[2]!)), Math.sqrt(Math.max(0, values[1]!)), Math.sqrt(Math.max(0, values[0]!))];
  const col = (M: M3, c: number): V3 => [M[c]!, M[3 + c]!, M[6 + c]!];
  let u1 = apply3(m, col(V, 0));
  u1 = vnorm(u1);
  let u2 = apply3(m, col(V, 1));
  u2 = vnorm(vsub(u2, vscale(u1, vdot(u1, u2))));
  if (vlen(u2) < 0.5) u2 = vnorm(vcross(u1, Math.abs(u1[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  let u3 = apply3(m, col(V, 2));
  u3 = s[2] > 1e-12 * Math.max(1, s[0]) ? vnorm(u3) : vcross(u1, u2);
  // Re-orthogonalise the third against the first two (a near-zero s3 is noise).
  u3 = vnorm(vsub(vsub(u3, vscale(u1, vdot(u1, u3))), vscale(u2, vdot(u2, u3))));
  if (vlen(u3) < 0.5) u3 = vcross(u1, u2);
  const U: M3 = [u1[0], u2[0], u3[0], u1[1], u2[1], u3[1], u1[2], u2[2], u3[2]];
  return { U, s, V };
}

/** The rotation nearest a 3×3 (orthogonal Procrustes). */
export function nearestRotation(m: M3): M3 {
  const { U, V } = svd3(m);
  let R = mul3(U, transpose3(V));
  if (det3(R) < 0) {
    const U2 = U.slice();
    U2[2] = -U2[2]!;
    U2[5] = -U2[5]!;
    U2[8] = -U2[8]!;
    R = mul3(U2, transpose3(V));
  }
  return R;
}

// ── Dense Cholesky ───────────────────────────────────────────────────────────

/**
 * Solve A x = b for symmetric positive-definite A (n×n row-major), in place:
 * A is overwritten by its factor, b by x. False when A is not positive
 * definite (the caller raises the damping and tries again).
 */
export function choleskySolve(A: Float64Array, b: Float64Array, n: number): boolean {
  for (let j = 0; j < n; j++) {
    let d = A[j * n + j]!;
    for (let k = 0; k < j; k++) d -= A[j * n + k]! * A[j * n + k]!;
    if (!(d > 1e-300)) return false;
    const ljj = Math.sqrt(d);
    A[j * n + j] = ljj;
    for (let i = j + 1; i < n; i++) {
      let s = A[i * n + j]!;
      for (let k = 0; k < j; k++) s -= A[i * n + k]! * A[j * n + k]!;
      A[i * n + j] = s / ljj;
    }
  }
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= A[i * n + k]! * b[k]!;
    b[i] = s / A[i * n + i]!;
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i]!;
    for (let k = i + 1; k < n; k++) s -= A[k * n + i]! * b[k]!;
    b[i] = s / A[i * n + i]!;
  }
  return true;
}

/** Inverse of a symmetric positive-definite 3×3 (a point's block in bundle adjustment). Null when singular. */
export function invSym3(a: ArrayLike<number>, out: Float64Array): boolean {
  const a00 = a[0]!, a01 = a[1]!, a02 = a[2]!, a11 = a[4]!, a12 = a[5]!, a22 = a[8]!;
  const c00 = a11 * a22 - a12 * a12;
  const c01 = a02 * a12 - a01 * a22;
  const c02 = a01 * a12 - a02 * a11;
  const det = a00 * c00 + a01 * c01 + a02 * c02;
  if (!(Math.abs(det) > 1e-300)) return false;
  const inv = 1 / det;
  out[0] = c00 * inv;
  out[1] = out[3] = c01 * inv;
  out[2] = out[6] = c02 * inv;
  out[4] = (a00 * a22 - a02 * a02) * inv;
  out[5] = out[7] = (a01 * a02 - a00 * a12) * inv;
  out[8] = (a00 * a11 - a01 * a01) * inv;
  return true;
}

// ── Rotations ────────────────────────────────────────────────────────────────

/** Axis-angle (radians, direction = axis) → rotation matrix (Rodrigues). */
export function expSO3(w: V3): M3 {
  const th = vlen(w);
  if (th < 1e-12) return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
  const k = vscale(w, 1 / th);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const C = 1 - c;
  const [x, y, z] = k;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}

/** Rotation matrix → axis-angle (radians). */
export function logSO3(R: M3): V3 {
  const tr = R[0]! + R[4]! + R[8]!;
  const c = Math.max(-1, Math.min(1, (tr - 1) / 2));
  const th = Math.acos(c);
  const v: V3 = [R[7]! - R[5]!, R[2]! - R[6]!, R[3]! - R[1]!];
  if (th < 1e-9) return vscale(v, 0.5);
  if (Math.PI - th < 1e-6) {
    // Near a half turn the antisymmetric part vanishes; read the axis off the diagonal.
    const x = Math.sqrt(Math.max(0, (R[0]! + 1) / 2));
    const y = Math.sqrt(Math.max(0, (R[4]! + 1) / 2)) * (R[1]! >= 0 ? 1 : -1);
    const z = Math.sqrt(Math.max(0, (R[8]! + 1) / 2)) * (R[2]! >= 0 ? 1 : -1);
    return vscale(vnorm([x, y, z]), th);
  }
  return vscale(v, th / (2 * Math.sin(th)));
}

/** Rotation matrix → unit quaternion [x, y, z, w]. */
export function quatFromMat(R: M3): [number, number, number, number] {
  const tr = R[0]! + R[4]! + R[8]!;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4;
    x = (R[7]! - R[5]!) / s;
    y = (R[2]! - R[6]!) / s;
    z = (R[3]! - R[1]!) / s;
  } else if (R[0]! > R[4]! && R[0]! > R[8]!) {
    const s = Math.sqrt(1 + R[0]! - R[4]! - R[8]!) * 2;
    w = (R[7]! - R[5]!) / s;
    x = s / 4;
    y = (R[1]! + R[3]!) / s;
    z = (R[2]! + R[6]!) / s;
  } else if (R[4]! > R[8]!) {
    const s = Math.sqrt(1 + R[4]! - R[0]! - R[8]!) * 2;
    w = (R[2]! - R[6]!) / s;
    x = (R[1]! + R[3]!) / s;
    y = s / 4;
    z = (R[5]! + R[7]!) / s;
  } else {
    const s = Math.sqrt(1 + R[8]! - R[0]! - R[4]!) * 2;
    w = (R[3]! - R[1]!) / s;
    x = (R[2]! + R[6]!) / s;
    y = (R[5]! + R[7]!) / s;
    z = s / 4;
  }
  const n = Math.hypot(x, y, z, w) || 1;
  return w < 0 ? [-x / n, -y / n, -z / n, -w / n] : [x / n, y / n, z / n, w / n];
}

/** Unit quaternion [x, y, z, w] → rotation matrix. */
export function matFromQuat(q: ArrayLike<number>): M3 {
  const x = q[0]!, y = q[1]!, z = q[2]!, w = q[3]!;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** Spherical interpolation of unit quaternions, shortest way round. */
export function slerp(a: ArrayLike<number>, b: ArrayLike<number>, t: number): [number, number, number, number] {
  let d = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!;
  const s = d < 0 ? -1 : 1;
  d *= s;
  if (d > 0.9995) {
    const q = [0, 1, 2, 3].map((i) => a[i]! + (s * b[i]! - a[i]!) * t);
    const n = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) || 1;
    return [q[0]! / n, q[1]! / n, q[2]! / n, q[3]! / n];
  }
  const th = Math.acos(d);
  const wa = Math.sin((1 - t) * th) / Math.sin(th);
  const wb = (s * Math.sin(t * th)) / Math.sin(th);
  return [wa * a[0]! + wb * b[0]!, wa * a[1]! + wb * b[1]!, wa * a[2]! + wb * b[2]!, wa * a[3]! + wb * b[3]!];
}

/** Angle between two rotations, degrees. */
export function rotationAngleDeg(a: M3, b: M3): number {
  const d = mul3(transpose3(a), b);
  return (vlen(logSO3(d)) * 180) / Math.PI;
}
