import type { ForceSpec } from "../schema";
import type { V3 } from "../world/math";

/**
 * FORCE FIELDS — what a field does to a body at a point, as an acceleration
 * in comp units/s². Pure and dimension-free: a flat comp's bodies ignore the
 * depth part (they move in the plane), a world's take all three.
 *
 * Written for the rigid-body solver and, later, particles (Simulation 2.0):
 * anything with a position and a velocity can ask a field what it feels.
 */

/** A field placed at one instant: its numbers then, its origin and axes in the simulation's space. */
export interface FieldAt {
  spec: ForceSpec;
  origin: V3;
  /** Unit vector: where a wind blows (the layer's +X). */
  axisX: V3;
  /** Unit vector: what a vortex swirls about (the layer's Z — the line of sight in a flat comp). */
  axisZ: V3;
}

/** How much of the field reaches distance `d` (0..1). */
export function fieldReach(spec: ForceSpec, d: number): number {
  if (spec.radius <= 0) return 1;
  if (d >= spec.radius) return 0;
  const t = d / spec.radius;
  if (spec.falloff === "none") return 1;
  if (spec.falloff === "linear") return 1 - t;
  return 1 - t * t * (3 - 2 * t);
}

/** The acceleration a field gives a body at `p` moving at `v`, at `time` seconds into the simulation. */
export function fieldAcceleration(f: FieldAt, p: V3, v: V3, time: number): V3 {
  const s = f.spec;
  if (!s.enabled || (s.type === "gravity" ? s.mass === 0 : s.strength === 0)) return [0, 0, 0];
  const r: V3 = [p[0] - f.origin[0], p[1] - f.origin[1], p[2] - f.origin[2]];
  const w = fieldReach(s, Math.hypot(r[0], r[1], r[2]));
  if (w <= 0) return [0, 0, 0];
  if (s.type === "gravity") return wellAcceleration(f, r, v, w);
  const k = s.strength * w;
  switch (s.type) {
    case "wind":
      return [f.axisX[0] * k, f.axisX[1] * k, f.axisX[2] * k];
    case "point": {
      const d = Math.hypot(r[0], r[1], r[2]);
      if (d < 1e-6) return [0, 0, 0];
      return [(-r[0] / d) * k, (-r[1] / d) * k, (-r[2] / d) * k];
    }
    case "vortex": {
      // Around the axis: Z × r, flattened onto the plane the vortex turns in.
      const z = f.axisZ;
      const along = r[0] * z[0] + r[1] * z[1] + r[2] * z[2];
      const q: V3 = [r[0] - z[0] * along, r[1] - z[1] * along, r[2] - z[2] * along];
      const t: V3 = [z[1] * q[2] - z[2] * q[1], z[2] * q[0] - z[0] * q[2], z[0] * q[1] - z[1] * q[0]];
      const d = Math.hypot(t[0], t[1], t[2]);
      return d < 1e-6 ? [0, 0, 0] : [(t[0] / d) * k, (t[1] / d) * k, (t[2] / d) * k];
    }
    case "turbulence": {
      const sc = Math.max(1e-3, s.scale);
      const x = p[0] / sc, y = p[1] / sc, z = p[2] / sc, tt = time * 0.6;
      return [noise3(x, y, z + tt, s.seed) * k, noise3(x + 31.7, y - 12.3, z + tt, s.seed + 1) * k, noise3(x - 8.1, y + 45.2, z + tt, s.seed + 2) * k];
    }
    case "drag":
      // A fraction of the speed per second, so its reach softens it like the others.
      return [-v[0] * k * 0.01, -v[1] * k * 0.01, -v[2] * k * 0.01];
    default:
      return [0, 0, 0];
  }
}

// ── Gravity wells ───────────────────────────────────────────────────────────

/** GM in units³/s² for a well whose `mass` is its pull 100 units out. */
export function wellGM(spec: Pick<ForceSpec, "mass">): number {
  return Math.max(0, spec.mass) * 1e4;
}

/** The speed that holds a circle of radius `r` about a well (its core ignored past a few cores): √(GM / r). */
export function circularSpeed(spec: Pick<ForceSpec, "mass" | "core">, r: number): number {
  const d = Math.max(1e-6, r);
  // Softened: a = GM·r/(r²+ε²)^{3/2} = v²/r.
  return Math.sqrt((wellGM(spec) * d * d) / Math.pow(d * d + spec.core * spec.core, 1.5));
}

/** The most a frame-dragging grip may correct per second — under half a 120 Hz step, so it never overshoots. */
const MAX_GRIP = 60;

/**
 * A GRAVITY WELL's pull at offset `r` from it, moving at `v`. Plummer-softened
 * inverse square toward the centre, plus FRAME DRAGGING: space turns about the
 * well's Z at a speed that falls as 1/r² from the horizon (where it is `spin`
 * × the circular speed there), and a body is pulled toward turning with it by
 * a grip that falls as 1/r³ — a relaxation, never a free push, so it can only
 * bring an orbit to the frame's turn: a fast orbit loses its way and spirals
 * in, a counter-rotating one is turned round near the hole.
 */
function wellAcceleration(f: FieldAt, r: V3, v: V3, w: number): V3 {
  const s = f.spec;
  const GM = wellGM(s);
  const d2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
  const inv = (GM / Math.pow(d2 + s.core * s.core, 1.5)) * w;
  const a: V3 = [-r[0] * inv, -r[1] * inv, -r[2] * inv];
  if (s.spin === 0) return a;
  // The way space turns here: Z × r, in the plane the well spins in.
  const z = f.axisZ;
  const along = r[0] * z[0] + r[1] * z[1] + r[2] * z[2];
  const q: V3 = [r[0] - z[0] * along, r[1] - z[1] * along, r[2] - z[2] * along];
  const t: V3 = [z[1] * q[2] - z[2] * q[1], z[2] * q[0] - z[0] * q[2], z[0] * q[1] - z[1] * q[0]];
  const d = Math.hypot(t[0], t[1], t[2]);
  if (d < 1e-6) return a;
  t[0] /= d, t[1] /= d, t[2] /= d;
  const rh = Math.max(s.horizon, s.core, 1);
  const vh = circularSpeed(s, rh);
  const x = Math.min(1, rh / d);
  const frame = s.spin * vh * x * x;
  const grip = Math.min(MAX_GRIP, Math.abs(s.spin) * (vh / rh) * x * x * x) * w;
  const k = grip * (frame - (v[0] * t[0] + v[1] * t[1] + v[2] * t[2]));
  return [a[0] + t[0] * k, a[1] + t[1] * k, a[2] + t[2] * k];
}

/** Where a field swallows what crosses it: a well's centre and horizon (null when it has none). */
export function fieldHorizon(f: FieldAt): { x: number; y: number; z: number; r2: number } | null {
  const s = f.spec;
  if (s.type !== "gravity" || !s.enabled || s.horizon <= 0) return null;
  return { x: f.origin[0], y: f.origin[1], z: f.origin[2], r2: s.horizon * s.horizon };
}

// ── Smooth value noise, −1..1 ───────────────────────────────────────────────

function hash(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177 + seed * 2654435761) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

function noise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = smooth(x - xi), v = smooth(y - yi), w = smooth(z - zi);
  const c = (dx: number, dy: number, dz: number) => hash(xi + dx, yi + dy, zi + dz, seed);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v), l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w);
}
