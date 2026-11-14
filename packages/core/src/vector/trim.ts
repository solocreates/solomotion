import type { PathCommand } from "./geometry";

/**
 * Trim paths — After Effects' "Trim Paths" for strokes. `start`/`end` are
 * fractions of the TOTAL arc length across every subpath; `offset` rotates the
 * window around the path (in turns), wrapping across the seam, so a dash of
 * light can chase around a closed shape. Cubics are measured by adaptive
 * sampling and cut with de Casteljau, so the trimmed geometry is exact Bézier,
 * not a polyline approximation.
 */

interface Pt {
  x: number;
  y: number;
}

interface Seg {
  kind: "L" | "C";
  p0: Pt;
  c1: Pt; // cubic controls (unused for lines)
  c2: Pt;
  p1: Pt;
  len: number;
  /** Cumulative arc length at uniform t samples (cubics) — inverts length→t. */
  table: number[] | null;
}

const CUBIC_SAMPLES = 24;

function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function cubicAt(s: Seg, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * s.p0.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.p1.x,
    y: u * u * u * s.p0.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.p1.y,
  };
}

function measure(seg: Seg): void {
  if (seg.kind === "L") {
    seg.len = dist(seg.p0, seg.p1);
    return;
  }
  const table: number[] = [0];
  let prev = seg.p0;
  let acc = 0;
  for (let i = 1; i <= CUBIC_SAMPLES; i++) {
    const p = cubicAt(seg, i / CUBIC_SAMPLES);
    acc += dist(prev, p);
    table.push(acc);
    prev = p;
  }
  seg.len = acc;
  seg.table = table;
}

/** Map a length fraction (0–1 of the segment) to a curve parameter t. */
function tAtFraction(seg: Seg, frac: number): number {
  if (seg.kind === "L" || !seg.table || seg.len === 0) return frac;
  const target = frac * seg.len;
  const table = seg.table;
  let lo = 0;
  let hi = table.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (table[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const l0 = table[i - 1]!;
  const l1 = table[i]!;
  const within = l1 === l0 ? 0 : (target - l0) / (l1 - l0);
  return (i - 1 + within) / CUBIC_SAMPLES;
}

function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** The sub-cubic of `seg` between parameters t0 ≤ t1 (de Casteljau twice). */
function cubicSlice(seg: Seg, t0: number, t1: number): Seg {
  // Split at t0, keep the right side.
  const right = splitCubic(seg.p0, seg.c1, seg.c2, seg.p1, t0)[1];
  // Split the right side at the re-mapped t1, keep the left.
  const t = t0 >= 1 ? 0 : (t1 - t0) / (1 - t0);
  const [left] = splitCubic(right[0], right[1], right[2], right[3], t);
  return { kind: "C", p0: left[0], c1: left[1], c2: left[2], p1: left[3], len: 0, table: null };
}

type CubicPts = [Pt, Pt, Pt, Pt];

function splitCubic(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): [CubicPts, CubicPts] {
  const a = lerp(p0, c1, t);
  const b = lerp(c1, c2, t);
  const c = lerp(c2, p1, t);
  const d = lerp(a, b, t);
  const e = lerp(b, c, t);
  const f = lerp(d, e, t);
  return [
    [p0, a, d, f],
    [f, e, c, p1],
  ];
}

function segSlice(seg: Seg, f0: number, f1: number): Seg {
  if (seg.kind === "L") {
    return {
      kind: "L",
      p0: lerp(seg.p0, seg.p1, f0),
      c1: seg.c1,
      c2: seg.c2,
      p1: lerp(seg.p0, seg.p1, f1),
      len: 0,
      table: null,
    };
  }
  return cubicSlice(seg, tAtFraction(seg, f0), tAtFraction(seg, f1));
}

/** Flatten commands into measured segments (Z becomes an explicit closing line). */
function toSegments(cmds: PathCommand[]): Seg[] {
  const segs: Seg[] = [];
  let cur: Pt = { x: 0, y: 0 };
  let subStart: Pt = cur;
  const push = (seg: Seg) => {
    measure(seg);
    if (seg.len > 1e-6) segs.push(seg);
  };
  for (const c of cmds) {
    if (c.type === "M") {
      cur = { x: c.x, y: c.y };
      subStart = cur;
    } else if (c.type === "L") {
      const p1 = { x: c.x, y: c.y };
      push({ kind: "L", p0: cur, c1: cur, c2: p1, p1, len: 0, table: null });
      cur = p1;
    } else if (c.type === "C") {
      const p1 = { x: c.x, y: c.y };
      push({ kind: "C", p0: cur, c1: { x: c.x1, y: c.y1 }, c2: { x: c.x2, y: c.y2 }, p1, len: 0, table: null });
      cur = p1;
    } else {
      if (dist(cur, subStart) > 1e-6) {
        push({ kind: "L", p0: cur, c1: cur, c2: subStart, p1: subStart, len: 0, table: null });
      }
      cur = subStart;
    }
  }
  return segs;
}

function emit(runs: Seg[][], out: PathCommand[]): void {
  for (const run of runs) {
    if (run.length === 0) continue;
    out.push({ type: "M", x: run[0]!.p0.x, y: run[0]!.p0.y });
    for (const seg of run) {
      if (seg.kind === "L") out.push({ type: "L", x: seg.p1.x, y: seg.p1.y });
      else out.push({ type: "C", x1: seg.c1.x, y1: seg.c1.y, x2: seg.c2.x, y2: seg.c2.y, x: seg.p1.x, y: seg.p1.y });
    }
  }
}

/** Extract the segments covering the absolute length window [a, b]. */
function extract(segs: Seg[], a: number, b: number): Seg[][] {
  const runs: Seg[][] = [];
  let run: Seg[] = [];
  let pos = 0;
  let prevEnd: Pt | null = null;
  for (const seg of segs) {
    const s0 = pos;
    const s1 = pos + seg.len;
    pos = s1;
    if (s1 <= a || s0 >= b) {
      continue;
    }
    const f0 = Math.max(0, (a - s0) / seg.len);
    const f1 = Math.min(1, (b - s0) / seg.len);
    const piece = f0 <= 0 && f1 >= 1 ? seg : segSlice(seg, f0, f1);
    // Segments across an M-gap (or after a skipped stretch) start a new run.
    if (prevEnd && dist(prevEnd, piece.p0) > 1e-4) {
      if (run.length) runs.push(run);
      run = [];
    }
    run.push(piece);
    prevEnd = piece.p1;
  }
  if (run.length) runs.push(run);
  return runs;
}

/**
 * Trim a command list to the arc-length window [start, end] (fractions of the
 * total), rotated by `offset` turns. Identity (0, 1, 0) returns the input
 * unchanged; a wrapped window emits both visible pieces.
 */
export function trimCommands(
  cmds: PathCommand[],
  start: number,
  end: number,
  offset = 0,
): PathCommand[] {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const span = hi - lo;
  if (span <= 0) return [];
  if (span >= 1 && offset % 1 === 0) return cmds;

  const segs = toSegments(cmds);
  const total = segs.reduce((sum, s) => sum + s.len, 0);
  if (total <= 0) return [];
  if (span >= 1) return cmds;

  // Rotate the window and wrap it onto [0, 1).
  let s0 = (((lo + offset) % 1) + 1) % 1;
  const e0 = s0 + span;

  const out: PathCommand[] = [];
  if (e0 <= 1) {
    emit(extract(segs, s0 * total, e0 * total), out);
  } else {
    // Wrapped: the tail piece then the head piece.
    emit(extract(segs, s0 * total, total), out);
    emit(extract(segs, 0, (e0 - 1) * total), out);
  }
  return out;
}

/** Split a command list into its subpaths (each run begins at its `M`). */
export function splitSubpaths(cmds: readonly PathCommand[]): PathCommand[][] {
  const runs: PathCommand[][] = [];
  let run: PathCommand[] | null = null;
  for (const c of cmds) {
    if (c.type === "M") {
      run = [c];
      runs.push(run);
    } else if (run) {
      run.push(c);
    }
  }
  return runs;
}

/** Arc length of every subpath, in order (zero for a degenerate one). */
export function measureCommands(cmds: readonly PathCommand[]): number[] {
  return splitSubpaths(cmds).map((run) => toSegments(run).reduce((sum, s) => sum + s.len, 0));
}

/**
 * Trim EACH subpath to its own window — the per-strand cut a draw-on needs,
 * where `trimCommands` cuts one window across the total length. A window of
 * [0, 1] leaves that subpath untouched; an empty one drops it. Windows past the
 * end of the list leave the remaining subpaths whole.
 */
export function trimSubpaths(
  cmds: readonly PathCommand[],
  windows: ReadonlyArray<readonly [number, number, number?]>,
): PathCommand[] {
  const out: PathCommand[] = [];
  splitSubpaths(cmds).forEach((run, i) => {
    const w = windows[i];
    if (!w) {
      out.push(...run);
      return;
    }
    const [a, b, offset = 0] = w;
    if (b - a >= 1) out.push(...run);
    else if (b > a) out.push(...trimCommands(run, a, b, offset));
  });
  return out;
}
