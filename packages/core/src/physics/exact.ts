/**
 * EXACT PHYSICS — an event-driven solver for frictionless, perfectly elastic
 * discs among ANALYTIC walls (a true circle, a line), with no field acting on
 * them between contacts. The first slice of the exact simulation mode
 * (`notes/physics-exact-mode.md`).
 *
 * The general solver (`solver.ts`, cannon-es) steps time at a fixed rate and
 * collides against polygons: a ball in a round room bounces off a 64-gon, and
 * after twenty bounces the angle it lands at is off by whole degrees. That is
 * fine for a pile of crates and fatal for an ideal billiard, where the film's
 * whole claim ("it misses home by 1° after 22 bounces") is a property of the
 * exact path. Here nothing is stepped:
 *
 *  - Between contacts every disc moves in a straight line, so its position at
 *    any instant is `p + v·(t − t₀)` — closed form.
 *  - The next contact of each pair is the root of a quadratic (disc–circle,
 *    disc–disc) or a linear equation (disc–line), solved in closed form. The
 *    earliest one wins; ties go to the lowest pair index, so a run is
 *    DETERMINISTIC: the same scene gives the same events on every machine.
 *  - A contact reflects velocities about the contact normal (elastic, equal
 *    and opposite impulses between discs, by mass). Speed is conserved exactly
 *    up to floating-point rounding, which does not grow with the step count
 *    because there are no steps.
 *  - It is SEEKABLE: the event list is computed once, lazily, as far as asked;
 *    the state at any instant is the last event before it advanced in closed
 *    form — scrubbing back costs a binary search, never a re-run.
 *
 * Coordinates are the caller's (comp px, y down); times in ms; velocities in
 * px per second.
 */

export type ExactVec = { x: number; y: number };

export interface ExactDisc {
  id: string;
  /** Centre at t = 0. */
  p: ExactVec;
  /** Velocity, px/s. */
  v: ExactVec;
  r: number;
  /** For disc–disc contacts; equal masses swap their normal velocities. */
  mass?: number;
}

export type ExactWall =
  /** The INSIDE of a circle: discs stay within `radius` of `centre`. */
  | { id: string; kind: "circle"; centre: ExactVec; radius: number }
  /** A line: discs stay on the side `normal` points to (unit length is not required). */
  | { id: string; kind: "line"; point: ExactVec; normal: ExactVec };

export interface ExactContact {
  /** When, ms. */
  t: number;
  /** The disc that hit, and what it hit: a wall id or another disc's id. */
  disc: string;
  other: string;
  /** Where the disc's CENTRE was at the contact. */
  at: ExactVec;
}

export interface ExactRun {
  /** Every disc at instant `t` (ms ≥ 0): centre and velocity. */
  at(t: number): Array<{ id: string; p: ExactVec; v: ExactVec }>;
  /** The contacts in [0, t], oldest first. */
  contactsUntil(t: number): ExactContact[];
}

/** Below this a root is the contact just resolved, not a new one (ms). */
const SAME_INSTANT_MS = 1e-9;
/** Never compute more than this many contacts in one run (a guard, far past any film). */
const MAX_CONTACTS = 1_000_000;

interface State {
  t: number;
  p: ExactVec[];
  v: ExactVec[];
}

export function exactRun(discs: readonly ExactDisc[], walls: readonly ExactWall[]): ExactRun {
  const n = discs.length;
  const states: State[] = [{ t: 0, p: discs.map((d) => ({ ...d.p })), v: discs.map((d) => ({ ...d.v })) }];
  const contacts: ExactContact[] = [];
  // The contact just resolved (pair key): its own root is at "now" and must not fire again.
  let last: string | null = null;

  /** Compute contacts until the run reaches `until` ms (or nothing will ever touch again). */
  const extend = (until: number): void => {
    let s = states[states.length - 1]!;
    while (s.t < until && contacts.length < MAX_CONTACTS) {
      let best = Infinity;
      let hit: { i: number; j: number; wall: ExactWall | null; key: string } | null = null;
      for (let i = 0; i < n; i++) {
        const di = discs[i]!;
        for (const w of walls) {
          const key = `${i}|${w.id}`;
          const dt = wallTime(s.p[i]!, s.v[i]!, di.r, w);
          if (dt === null || (key === last && dt * 1000 <= SAME_INSTANT_MS)) continue;
          if (dt < best) {
            best = dt;
            hit = { i, j: -1, wall: w, key };
          }
        }
        for (let j = i + 1; j < n; j++) {
          const key = `${i}|${j}`;
          const dt = discTime(s.p[i]!, s.v[i]!, di.r, s.p[j]!, s.v[j]!, discs[j]!.r);
          if (dt === null || (key === last && dt * 1000 <= SAME_INSTANT_MS)) continue;
          if (dt < best) {
            best = dt;
            hit = { i, j, wall: null, key };
          }
        }
      }
      if (!hit || !Number.isFinite(best)) return; // free flight forever
      const tNext = s.t + best * 1000;
      const p = s.p.map((q, k) => ({ x: q.x + s.v[k]!.x * best, y: q.y + s.v[k]!.y * best }));
      const v = s.v.map((q) => ({ ...q }));
      if (hit.wall) {
        v[hit.i] = reflect(v[hit.i]!, wallNormal(p[hit.i]!, hit.wall));
        contacts.push({ t: tNext, disc: discs[hit.i]!.id, other: hit.wall.id, at: { ...p[hit.i]! } });
      } else {
        const [a, b] = elastic(p[hit.i]!, v[hit.i]!, discs[hit.i]!.mass ?? 1, p[hit.j]!, v[hit.j]!, discs[hit.j]!.mass ?? 1);
        v[hit.i] = a;
        v[hit.j] = b;
        contacts.push({ t: tNext, disc: discs[hit.i]!.id, other: discs[hit.j]!.id, at: { ...p[hit.i]! } });
      }
      last = hit.key;
      s = { t: tNext, p, v };
      states.push(s);
    }
  };

  /** The last state at or before `t` (states are in time order). */
  const stateBefore = (t: number): State => {
    let lo = 0;
    let hi = states.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (states[mid]!.t <= t) lo = mid;
      else hi = mid - 1;
    }
    return states[lo]!;
  };

  return {
    at(t) {
      const time = Math.max(0, t);
      extend(time);
      const s = stateBefore(time);
      const dt = (time - s.t) / 1000;
      return discs.map((d, k) => ({ id: d.id, p: { x: s.p[k]!.x + s.v[k]!.x * dt, y: s.p[k]!.y + s.v[k]!.y * dt }, v: { ...s.v[k]! } }));
    },
    contactsUntil(t) {
      extend(t);
      return contacts.filter((c) => c.t <= t);
    },
  };
}

/** Seconds until a disc at `p` moving `v` touches `w`, or null if it never will. */
function wallTime(p: ExactVec, v: ExactVec, r: number, w: ExactWall): number | null {
  if (w.kind === "circle") {
    // |p + v·t − c| = R − r, from the inside: the larger root of a·t² + b·t + c₀.
    const R = w.radius - r;
    const dx = p.x - w.centre.x;
    const dy = p.y - w.centre.y;
    const a = v.x * v.x + v.y * v.y;
    if (a === 0) return null;
    const b = 2 * (dx * v.x + dy * v.y);
    const c0 = dx * dx + dy * dy - R * R;
    const disc = b * b - 4 * a * c0;
    if (disc < 0) return null;
    // The stable form of the larger root (no cancellation when c₀ ≈ 0, i.e. right after a bounce).
    const q = -0.5 * (b + Math.sign(b || 1) * Math.sqrt(disc));
    // q has b's sign flipped: for b ≥ 0 the positive root is c₀/q, for b < 0 it is q/a.
    const t = b >= 0 ? c0 / q : q / a;
    return t > 0 ? t : null;
  }
  const nl = Math.hypot(w.normal.x, w.normal.y);
  const nx = w.normal.x / nl;
  const ny = w.normal.y / nl;
  const gap = (p.x - w.point.x) * nx + (p.y - w.point.y) * ny - r;
  const vn = v.x * nx + v.y * ny;
  if (vn >= 0) return null; // moving away from it, or along it
  const t = -gap / vn;
  return t >= 0 ? t : null;
}

/** Seconds until two discs touch while approaching, or null. */
function discTime(p1: ExactVec, v1: ExactVec, r1: number, p2: ExactVec, v2: ExactVec, r2: number): number | null {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const vx = v2.x - v1.x;
  const vy = v2.y - v1.y;
  const b = dx * vx + dy * vy;
  if (b >= 0) return null; // not approaching
  const a = vx * vx + vy * vy;
  const R = r1 + r2;
  const c0 = dx * dx + dy * dy - R * R;
  const disc = b * b - a * c0;
  if (disc < 0) return null;
  // The smaller root of a·t² + 2b·t + c₀, in its stable form.
  const t = c0 / (-b + Math.sqrt(disc));
  return t >= 0 ? t : null;
}

function wallNormal(p: ExactVec, w: ExactWall): ExactVec {
  if (w.kind === "circle") {
    const dx = p.x - w.centre.x;
    const dy = p.y - w.centre.y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: dx / l, y: dy / l };
  }
  const l = Math.hypot(w.normal.x, w.normal.y) || 1;
  return { x: w.normal.x / l, y: w.normal.y / l };
}

/** `v` mirrored about the plane with unit normal `n`. */
function reflect(v: ExactVec, n: ExactVec): ExactVec {
  const d = v.x * n.x + v.y * n.y;
  return { x: v.x - 2 * d * n.x, y: v.y - 2 * d * n.y };
}

/** Two discs touching at `p1`, `p2`: an elastic exchange along the line of centres. */
function elastic(p1: ExactVec, v1: ExactVec, m1: number, p2: ExactVec, v2: ExactVec, m2: number): [ExactVec, ExactVec] {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const l = Math.hypot(dx, dy) || 1;
  const nx = dx / l;
  const ny = dy / l;
  const u1 = v1.x * nx + v1.y * ny;
  const u2 = v2.x * nx + v2.y * ny;
  const w1 = ((m1 - m2) * u1 + 2 * m2 * u2) / (m1 + m2);
  const w2 = ((m2 - m1) * u2 + 2 * m1 * u1) / (m1 + m2);
  return [
    { x: v1.x + (w1 - u1) * nx, y: v1.y + (w1 - u1) * ny },
    { x: v2.x + (w2 - u2) * nx, y: v2.y + (w2 - u2) * ny },
  ];
}
