/**
 * 3D MATH — DOM-free, allocation-light, deterministic. The world's version of
 * `navigation/matrix.ts`: core runs in tests, workers and the exporter, so it
 * cannot lean on three.js or `DOMMatrix`.
 *
 * Conventions (ADR-3d): right-handed, Z up. Matrices are 4×4 COLUMN-MAJOR
 * number arrays — the layout WebGL and three.js use, so a matrix crosses to
 * the renderer without a transpose. Angles in the document are DEGREES;
 * Euler order is Blender's XYZ, i.e. R = Rz · Ry · Rx.
 */

export type V3 = [number, number, number];
export type Mat4 = number[];

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// ── Vectors ──────────────────────────────────────────────────────────────────

export const v3 = (x = 0, y = 0, z = 0): V3 => [x, y, z];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length3 = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const lerp3 = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export function normalize3(a: V3): V3 {
  const l = length3(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
export const dist3 = (a: V3, b: V3): number => length3(sub(a, b));

// ── Matrices ─────────────────────────────────────────────────────────────────

export function identity4(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function isIdentity4(m: Mat4): boolean {
  const I = identity4();
  for (let i = 0; i < 16; i++) if (Math.abs(m[i]! - I[i]!) > 1e-12) return false;
  return true;
}

/** a · b (apply b first). */
export function mul4(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
    }
  }
  return o;
}

export function translate4(t: V3): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
}

export function scale4(s: V3): Mat4 {
  return [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1];
}

/** Rotation from Blender XYZ Euler degrees: R = Rz · Ry · Rx. */
export function rotation4(rx: number, ry: number, rz: number): Mat4 {
  const a = rx * D2R;
  const b = ry * D2R;
  const c = rz * D2R;
  const ca = Math.cos(a), sa = Math.sin(a);
  const cb = Math.cos(b), sb = Math.sin(b);
  const cc = Math.cos(c), sc = Math.sin(c);
  // Row-major r_ij of Rz·Ry·Rx, written into column-major slots.
  const r00 = cc * cb, r01 = cc * sb * sa - sc * ca, r02 = cc * sb * ca + sc * sa;
  const r10 = sc * cb, r11 = sc * sb * sa + cc * ca, r12 = sc * sb * ca - cc * sa;
  const r20 = -sb, r21 = cb * sa, r22 = cb * ca;
  return [r00, r10, r20, 0, r01, r11, r21, 0, r02, r12, r22, 0, 0, 0, 0, 1];
}

/** Blender XYZ Euler (degrees) from a pure rotation matrix. */
export function eulerFromRotation(m: Mat4): V3 {
  const r20 = m[2]!;
  const r21 = m[6]!;
  const r22 = m[10]!;
  const r10 = m[1]!;
  const r00 = m[0]!;
  const b = Math.asin(Math.max(-1, Math.min(1, -r20)));
  let a: number;
  let c: number;
  if (Math.abs(r20) < 0.9999999) {
    a = Math.atan2(r21, r22);
    c = Math.atan2(r10, r00);
  } else {
    // Gimbal lock: X and Z share an axis; put all of it on Z.
    a = 0;
    c = Math.atan2(-m[4]!, m[5]!);
  }
  return [clean(a * R2D), clean(b * R2D), clean(c * R2D)];
}

/** Snap float noise (1e-13) to the number a person typed. */
function clean(v: number): number {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

export interface Trs {
  position: V3;
  /** Degrees, Blender XYZ. */
  rotation: V3;
  scale: V3;
}

/** T · R · S. */
export function composeTrs(trs: Trs): Mat4 {
  return mul4(mul4(translate4(trs.position), rotation4(...trs.rotation)), scale4(trs.scale));
}

/** Split an affine matrix (no shear) back into T, R, S. Negative determinant flips X. */
export function decomposeTrs(m: Mat4): Trs {
  let sx = Math.hypot(m[0]!, m[1]!, m[2]!);
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  if (det3(m) < 0) sx = -sx;
  const r = [
    m[0]! / sx, m[1]! / sx, m[2]! / sx, 0,
    m[4]! / sy, m[5]! / sy, m[6]! / sy, 0,
    m[8]! / sz, m[9]! / sz, m[10]! / sz, 0,
    0, 0, 0, 1,
  ];
  return { position: [m[12]!, m[13]!, m[14]!], rotation: eulerFromRotation(r), scale: [sx, sy, sz] };
}

function det3(m: Mat4): number {
  return (
    m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) -
    m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) +
    m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!)
  );
}

export function invert4(m: Mat4): Mat4 {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m as [
    number, number, number, number, number, number, number, number,
    number, number, number, number, number, number, number, number,
  ];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-18) return identity4();
  det = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * det,
    (a02 * b10 - a01 * b11 - a03 * b09) * det,
    (a31 * b05 - a32 * b04 + a33 * b03) * det,
    (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det,
    (a00 * b11 - a02 * b08 + a03 * b07) * det,
    (a32 * b02 - a30 * b05 - a33 * b01) * det,
    (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det,
    (a01 * b08 - a00 * b10 - a03 * b06) * det,
    (a30 * b04 - a31 * b02 + a33 * b00) * det,
    (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det,
    (a00 * b09 - a01 * b07 + a02 * b06) * det,
    (a31 * b01 - a30 * b03 - a32 * b00) * det,
    (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ];
}

export function transformPoint(m: Mat4, p: V3): V3 {
  const x = p[0], y = p[1], z = p[2];
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  const iw = w !== 0 ? 1 / w : 1;
  return [
    (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) * iw,
    (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) * iw,
    (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) * iw,
  ];
}

/** Rotate/scale a direction (no translation). */
export function transformDir(m: Mat4, d: V3): V3 {
  return [
    m[0]! * d[0] + m[4]! * d[1] + m[8]! * d[2],
    m[1]! * d[0] + m[5]! * d[1] + m[9]! * d[2],
    m[2]! * d[0] + m[6]! * d[1] + m[10]! * d[2],
  ];
}

export const matPosition = (m: Mat4): V3 => [m[12]!, m[13]!, m[14]!];

/** The matrix's axis columns (unnormalized). */
export const matAxis = (m: Mat4, axis: 0 | 1 | 2): V3 => [m[axis * 4]!, m[axis * 4 + 1]!, m[axis * 4 + 2]!];

/**
 * A rotation whose local `forward` axis points along `dir`, with local +Y as
 * close to `up` as the direction allows — Track To. `forward` is the local
 * axis that should aim: −Z for cameras and lights, −Y for picture planes.
 */
export function aimRotation(dir: V3, forward: "-z" | "-y", up: V3 = [0, 0, 1]): Mat4 {
  const f = normalize3(dir);
  if (length3(f) < 1e-9) return identity4();
  let u = up;
  if (Math.abs(dot(f, normalize3(u))) > 0.9999) u = [0, 1, 0];
  if (forward === "-z") {
    // Camera basis: local Z = −f, local X = up × Z, local Y = Z × X.
    const zAxis = scale3(f, -1);
    const xAxis = normalize3(cross(u, zAxis));
    const yAxis = cross(zAxis, xAxis);
    return basis4(xAxis, yAxis, zAxis);
  }
  // Plane basis: local −Y = f, local Z ≈ up, local X = Y × Z.
  const yAxis = scale3(f, -1);
  const xAxis = normalize3(cross(yAxis, u));
  const zAxis = cross(xAxis, yAxis);
  return basis4(xAxis, yAxis, zAxis);
}

export function basis4(x: V3, y: V3, z: V3): Mat4 {
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1];
}

/** Perspective projection (WebGL clip space), vertical FOV in degrees. */
export function perspective4(fovYDeg: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan((fovYDeg * D2R) / 2);
  const nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

/** Orthographic projection from half extents. */
export function ortho4(halfW: number, halfH: number, near: number, far: number): Mat4 {
  const nf = 1 / (near - far);
  return [1 / halfW, 0, 0, 0, 0, 1 / halfH, 0, 0, 0, 0, 2 * nf, 0, 0, 0, (far + near) * nf, 1];
}

export { D2R, R2D };
