import { add, cross, dot, length3, matPosition, mul4, normalize3, scale3, sub, translate4, type Mat4, type V3 } from "./math";

/**
 * INVERSE KINEMATICS — turn a chain of joints so its tip reaches a target.
 *
 * The chain is world matrices, root first, the TIP last (the tip never turns
 * about its own origin; its ancestors do). Solved on POSITIONS with FABRIK —
 * bone lengths held, reaching from the tip back and the root forward until
 * the tip is on the target — because it folds a chain where coordinate
 * descent cannot (a straight arm aimed along its own line). A straight chain
 * is given a small seed bend first, toward the pole when there is one; a pole
 * then turns the solved chain about the root→target line so the first bend
 * points at it, as an elbow at a pole does in Blender. Out of reach, the
 * chain straightens toward the target.
 *
 * The positions become TURNS: from the root, each joint swings its bone onto
 * the solved direction, carrying everything below it — so the result is
 * rotations, and whatever hangs off a joint can follow the same turn.
 *
 * Pure: matrices in, matrices out.
 */
export function solveIk(
  chain: Mat4[],
  target: V3,
  pole: V3 | null,
  iterations = 32,
  tolerance = 0.01,
  /**
   * The side a STRAIGHT chain folds to when there is no pole (a direction,
   * any length; only its part across the chain counts). Absent = up (Z),
   * which suits a world; a flat comp passes a direction in its own plane so a
   * chain never folds out of it.
   */
  hint?: V3 | null,
): Mat4[] {
  const n = chain.length;
  if (n < 2) return chain.slice();
  const P = chain.map(matPosition);
  const L = P.slice(1).map((p, i) => length3(sub(p, P[i]!)));
  const reach = L.reduce((a, b) => a + b, 0);
  const root = P[0]!;
  const fromRoot = sub(target, root);
  const dist = length3(fromRoot);
  const fold = hint && length3(hint) > 1e-12 ? hint : null;
  const bendHint = (d: V3): V3 => {
    const hint: V3 = pole ? sub(pole, root) : fold ?? (Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0]);
    let perp = sub(hint, scale3(d, dot(hint, d)));
    if (length3(perp) < 1e-9) perp = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
    return normalize3(perp);
  };

  if (dist >= reach - 1e-9 || dist < 1e-9) {
    // Out of reach (or on the root): straight toward the target.
    const d = dist < 1e-9 ? normalize3(sub(P[n - 1]!, root)) : scale3(fromRoot, 1 / dist);
    for (let i = 1; i < n; i++) P[i] = add(P[i - 1]!, scale3(d, L[i - 1]!));
  } else {
    // Seed a bend so the passes have a side to fold to. Two lines can trap
    // FABRIK on a line: the chain's own (a straight arm) and the one to the
    // TARGET — joints lying on root→target are pulled along it forever and
    // the chain straightens past a target well within reach. The middle joints
    // are the ones that must be off both.
    const onLine = (d: V3, len: number) =>
      P.slice(1, -1).every((p) => {
        const w = sub(p, root);
        return length3(sub(w, scale3(d, dot(w, d)))) <= len * 1e-4;
      });
    const line = sub(P[n - 1]!, root);
    const len = length3(line);
    const straight = len > 1e-9 && onLine(scale3(line, 1 / len), len);
    const toTarget = scale3(fromRoot, 1 / dist);
    if (straight || onLine(toTarget, dist)) {
      // Keep the way it already turns when it has one: a tip leaning off the
      // target line means the joints fold to the OTHER side of it. The hint
      // (or the pole) decides otherwise.
      const lean = sub(line, scale3(toTarget, dot(line, toTarget)));
      const perp = !straight && !pole && !fold && length3(lean) > len * 1e-4 ? scale3(normalize3(lean), -1) : bendHint(toTarget);
      const size = Math.max(len, dist) * 0.05;
      for (let i = 1; i < n - 1; i++) P[i] = add(P[i]!, scale3(perp, size));
    }
    for (let it = 0; it < iterations; it++) {
      P[n - 1] = target;
      for (let i = n - 2; i >= 0; i--) P[i] = add(P[i + 1]!, scale3(normalize3(sub(P[i]!, P[i + 1]!)), L[i]!));
      P[0] = root;
      for (let i = 0; i < n - 1; i++) P[i + 1] = add(P[i]!, scale3(normalize3(sub(P[i + 1]!, P[i]!)), L[i]!));
      if (length3(sub(P[n - 1]!, target)) < tolerance) break;
    }
  }

  if (pole && n >= 3 && dist > 1e-9) {
    // Turn the bends about root→target so the first one points at the pole.
    const axis = scale3(fromRoot, 1 / dist);
    const flat = (v: V3) => {
      const w = sub(v, root);
      return sub(w, scale3(axis, dot(w, axis)));
    };
    const bend = flat(P[1]!), toward = flat(pole);
    if (length3(bend) > 1e-6 && length3(toward) > 1e-6) {
      const R = rotationBetween(normalize3(bend), normalize3(toward));
      if (R) for (let i = 1; i < n; i++) P[i] = add(root, rotate(R, sub(P[i]!, root)));
    }
  }

  // Positions → turns, root first: swing each bone onto its solved direction.
  const out = chain.slice();
  for (let i = 0; i < n - 1; i++) {
    const at = matPosition(out[i]!);
    const a = sub(matPosition(out[i + 1]!), at), b = sub(P[i + 1]!, at);
    if (length3(a) < 1e-9 || length3(b) < 1e-9) continue;
    const R = rotationBetween(normalize3(a), normalize3(b));
    if (!R) continue;
    const about = mul4(mul4(translate4(at), R), translate4(scale3(at, -1)));
    for (let k = i; k < n; k++) out[k] = mul4(about, out[k]!);
  }
  return out;
}

function rotate(R: Mat4, v: V3): V3 {
  return [R[0]! * v[0] + R[4]! * v[1] + R[8]! * v[2], R[1]! * v[0] + R[5]! * v[1] + R[9]! * v[2], R[2]! * v[0] + R[6]! * v[1] + R[10]! * v[2]];
}

/** The rotation (4×4, column-major) taking unit vector a onto unit vector b; null when they already agree. */
function rotationBetween(a: V3, b: V3): Mat4 | null {
  const c = Math.max(-1, Math.min(1, dot(a, b)));
  if (c > 1 - 1e-12) return null;
  let axis = cross(a, b);
  if (length3(axis) < 1e-9) axis = Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]);
  const [x, y, z] = normalize3(axis);
  const ang = Math.acos(c);
  const s = Math.sin(ang), co = Math.cos(ang), t = 1 - co;
  return [
    t * x * x + co, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + co, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + co, 0,
    0, 0, 0, 1,
  ];
}
