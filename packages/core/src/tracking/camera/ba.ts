import { apply3, choleskySolve, expSO3, invSym3, mul3, vadd, type V3 } from "./linalg";
import type { Pose } from "./geometry";

/**
 * BUNDLE ADJUSTMENT — every camera, every point and (optionally) the lens,
 * moved together until what they predict matches what was seen, measured in
 * PIXELS.
 *
 * Sparse Levenberg–Marquardt with the Schur complement: points are
 * eliminated per point (each is a 3×3 block), leaving a dense "reduced
 * camera system" of 6 numbers per camera plus one for a shared focal length.
 * Keyframes keep that system small (a few hundred unknowns), which is what
 * makes a global adjustment take milliseconds instead of seconds.
 *
 * Robust by construction: residuals are Huber-weighted (a feature on a
 * passer-by costs linearly, not quadratically), and the caller drops the
 * observations still beyond its threshold and adjusts again.
 *
 * Tripod mode (`rotationOnly`) is the same machinery with 3 numbers per
 * camera and translation held at zero; points are then DIRECTIONS (kept unit
 * length), because a camera that only turns cannot see depth.
 *
 * Gauge: cameras in `fixed` do not move (the solve holds its first camera),
 * and the remaining scale freedom is held by the damping.
 */

export interface BundleProblem {
  poses: Pose[];
  fixed: boolean[];
  /** World points, flat xyz. */
  points: Float64Array;
  /** Observation k: camera `cam[k]` saw point `pt[k]` at pixel `uv[2k], uv[2k+1]`. */
  cam: Int32Array;
  pt: Int32Array;
  uv: Float64Array;
  f: number;
  cx: number;
  cy: number;
  solveFocal: boolean;
  rotationOnly: boolean;
  /** Huber knee, px. */
  huberPx: number;
}

export interface BundleResult {
  iterations: number;
  /** RMS reprojection error over all observations, px. */
  rms: number;
  /** Per-observation error, px. */
  errors: Float64Array;
}

/** Project world point `p` through `pose` with focal `f` — pixel, or null behind the camera. */
export function projectPx(pose: Pose, X: V3, f: number, cx: number, cy: number): [number, number] | null {
  const c = vadd(apply3(pose.R, X), pose.t);
  if (c[2] <= 1e-9) return null;
  return [(f * c[0]) / c[2] + cx, (f * c[1]) / c[2] + cy];
}

function observationErrors(p: BundleProblem, out: Float64Array): number {
  let cost = 0;
  const h = p.huberPx;
  for (let k = 0; k < p.cam.length; k++) {
    const j = p.pt[k]!;
    const q = projectPx(p.poses[p.cam[k]!]!, [p.points[3 * j]!, p.points[3 * j + 1]!, p.points[3 * j + 2]!], p.f, p.cx, p.cy);
    const e = q ? Math.hypot(q[0] - p.uv[2 * k]!, q[1] - p.uv[2 * k + 1]!) : 1e6;
    out[k] = e;
    cost += e <= h ? e * e : 2 * h * e - h * h;
  }
  return cost;
}

export function bundleAdjust(p: BundleProblem, maxIterations = 40): BundleResult {
  const nObs = p.cam.length;
  const nPts = p.points.length / 3;
  const dc = p.rotationOnly ? 3 : 6;
  // Free cameras get a slot in the reduced system; the focal (if solved) is last.
  const slot = new Int32Array(p.poses.length).fill(-1);
  let free = 0;
  for (let i = 0; i < p.poses.length; i++) if (!p.fixed[i]) slot[i] = free++;
  const N = free * dc + (p.solveFocal ? 1 : 0);
  const fIdx = N - 1;

  // Observations grouped by point (CSR).
  const start = new Int32Array(nPts + 1);
  for (let k = 0; k < nObs; k++) start[p.pt[k]! + 1] = start[p.pt[k]! + 1]! + 1;
  for (let j = 0; j < nPts; j++) start[j + 1] = start[j + 1]! + start[j]!;
  const order = new Int32Array(nObs);
  const fill = start.slice(0, nPts);
  for (let k = 0; k < nObs; k++) order[fill[p.pt[k]!]!++] = k;

  const errors = new Float64Array(nObs);
  let cost = observationErrors(p, errors);
  let lambda = 1e-3;
  let it = 0;

  // Scratch, reused across iterations.
  const S = new Float64Array(N * N);
  const g = new Float64Array(N);
  const V = new Float64Array(nPts * 9);
  const bp = new Float64Array(nPts * 3);
  const Jc = new Float64Array(nObs * 2 * dc);
  const Jf = new Float64Array(nObs * 2);
  const Jp = new Float64Array(nObs * 6);
  const res = new Float64Array(nObs * 2);
  const wts = new Float64Array(nObs);
  const Vinv = new Float64Array(9);
  const tmp = new Float64Array(9);

  for (; it < maxIterations && N > 0; it++) {
    // ── Linearise ───────────────────────────────────────────────────────────
    S.fill(0);
    g.fill(0);
    V.fill(0);
    bp.fill(0);
    for (let k = 0; k < nObs; k++) {
      const i = p.cam[k]!;
      const j = p.pt[k]!;
      const pose = p.poses[i]!;
      const X: V3 = [p.points[3 * j]!, p.points[3 * j + 1]!, p.points[3 * j + 2]!];
      const c = vadd(apply3(pose.R, X), pose.t);
      wts[k] = 0;
      if (c[2] <= 1e-9) continue;
      const iz = 1 / c[2];
      const x = c[0] * iz, y = c[1] * iz;
      const rx = p.f * x + p.cx - p.uv[2 * k]!;
      const ry = p.f * y + p.cy - p.uv[2 * k + 1]!;
      const e = Math.hypot(rx, ry);
      const w = e <= p.huberPx ? 1 : p.huberPx / e;
      wts[k] = w;
      res[2 * k] = rx;
      res[2 * k + 1] = ry;
      // du/dc = f·[1/z, 0, −x/z], dv/dc = f·[0, 1/z, −y/z]
      const a0 = p.f * iz, a2 = -p.f * x * iz, b1 = p.f * iz, b2 = -p.f * y * iz;
      // Points: dc/dX = R
      const R = pose.R;
      const jp = k * 6;
      for (let q = 0; q < 3; q++) {
        Jp[jp + q] = a0 * R[q]! + a2 * R[6 + q]!;
        Jp[jp + 3 + q] = b1 * R[3 + q]! + b2 * R[6 + q]!;
      }
      // Cameras (left update): dc/dω = −[c]×, dc/dt = I.
      if (slot[i]! >= 0) {
        const jc = k * 2 * dc;
        // −[c]× rows: [0, c2, −c1], [−c2, 0, c0], [c1, −c0, 0]
        Jc[jc + 0] = a0 * 0 + a2 * c[1];
        Jc[jc + 1] = a0 * c[2] + a2 * -c[0];
        Jc[jc + 2] = a0 * -c[1] + a2 * 0;
        Jc[jc + dc + 0] = b1 * -c[2] + b2 * c[1];
        Jc[jc + dc + 1] = b1 * 0 + b2 * -c[0];
        Jc[jc + dc + 2] = b1 * c[0] + b2 * 0;
        if (dc === 6) {
          Jc[jc + 3] = a0;
          Jc[jc + 4] = 0;
          Jc[jc + 5] = a2;
          Jc[jc + dc + 3] = 0;
          Jc[jc + dc + 4] = b1;
          Jc[jc + dc + 5] = b2;
        }
      }
      Jf[2 * k] = x;
      Jf[2 * k + 1] = y;

      // Point block and gradient.
      const vo = j * 9;
      for (let r = 0; r < 3; r++) {
        bp[j * 3 + r] = bp[j * 3 + r]! + w * (Jp[jp + r]! * rx + Jp[jp + 3 + r]! * ry);
        for (let q = 0; q < 3; q++) V[vo + r * 3 + q] = V[vo + r * 3 + q]! + w * (Jp[jp + r]! * Jp[jp + q]! + Jp[jp + 3 + r]! * Jp[jp + 3 + q]!);
      }
      // Camera block, focal terms.
      const s = slot[i]!;
      if (s >= 0) {
        const o = s * dc;
        const jc = k * 2 * dc;
        for (let r = 0; r < dc; r++) {
          const u0 = Jc[jc + r]!, u1 = Jc[jc + dc + r]!;
          g[o + r] = g[o + r]! + w * (u0 * rx + u1 * ry);
          for (let q = r; q < dc; q++) S[(o + r) * N + o + q] = S[(o + r) * N + o + q]! + w * (u0 * Jc[jc + q]! + u1 * Jc[jc + dc + q]!);
          if (p.solveFocal) S[(o + r) * N + fIdx] = S[(o + r) * N + fIdx]! + w * (u0 * x + u1 * y);
        }
      }
      if (p.solveFocal) {
        g[fIdx] = g[fIdx]! + w * (x * rx + y * ry);
        S[fIdx * N + fIdx] = S[fIdx * N + fIdx]! + w * (x * x + y * y);
      }
    }
    // Symmetrise the camera blocks (upper → lower), keeping cross terms in both halves.
    for (let r = 0; r < N; r++) for (let q = r + 1; q < N; q++) S[q * N + r] = S[r * N + q]!;

    // ── Damp, eliminate points, solve ───────────────────────────────────────
    const savedPoses = p.poses.map((ps) => ({ R: ps.R.slice(), t: [...ps.t] as V3 }));
    const savedPoints = p.points.slice();
    let accepted = false;
    for (let tries = 0; tries < 8 && !accepted; tries++) {
      const A = S.slice();
      const rhs = new Float64Array(N);
      for (let r = 0; r < N; r++) {
        A[r * N + r] = A[r * N + r]! * (1 + lambda) + 1e-9;
        rhs[r] = -g[r]!;
      }
      const vinvs = new Float64Array(nPts * 9);
      const okPt = new Uint8Array(nPts);
      for (let j = 0; j < nPts; j++) {
        const vo = j * 9;
        for (let q = 0; q < 9; q++) tmp[q] = V[vo + q]!;
        tmp[0] = tmp[0]! * (1 + lambda) + 1e-9;
        tmp[4] = tmp[4]! * (1 + lambda) + 1e-9;
        tmp[8] = tmp[8]! * (1 + lambda) + 1e-9;
        if (!invSym3(tmp, Vinv)) continue;
        okPt[j] = 1;
        vinvs.set(Vinv, vo);
        // Blocks this point couples: its observing free cameras, and the focal.
        const ks: number[] = [];
        for (let a = start[j]!; a < start[j + 1]!; a++) {
          const k = order[a]!;
          if (wts[k]! > 0) ks.push(k);
        }
        // W rows (camera block r, dims dc×3) for each obs; the focal row is the sum over obs.
        const Wf = [0, 0, 0];
        const Wk = ks.map((k) => {
          const w = wts[k]!;
          const jp = k * 6;
          if (p.solveFocal)
            for (let q = 0; q < 3; q++) Wf[q] = Wf[q]! + w * (Jf[2 * k]! * Jp[jp + q]! + Jf[2 * k + 1]! * Jp[jp + 3 + q]!);
          const s = slot[p.cam[k]!]!;
          if (s < 0) return null;
          const jc = k * 2 * dc;
          const W = new Float64Array(dc * 3);
          for (let r = 0; r < dc; r++) for (let q = 0; q < 3; q++) W[r * 3 + q] = w * (Jc[jc + r]! * Jp[jp + q]! + Jc[jc + dc + r]! * Jp[jp + 3 + q]!);
          return { o: s * dc, rows: dc, W };
        });
        const blocks: Array<{ o: number; rows: number; W: Float64Array }> = Wk.filter((b) => b !== null);
        if (p.solveFocal) blocks.push({ o: fIdx, rows: 1, W: Float64Array.from(Wf) });
        const bj = [bp[j * 3]!, bp[j * 3 + 1]!, bp[j * 3 + 2]!];
        // WV = W · V⁻¹ per block, then S −= WV · Wᵀ and rhs += WV · b (rhs = −g + W V⁻¹ b).
        const WV = blocks.map((b) => {
          const out = new Float64Array(b.rows * 3);
          for (let r = 0; r < b.rows; r++)
            for (let q = 0; q < 3; q++) out[r * 3 + q] = b.W[r * 3]! * Vinv[q]! + b.W[r * 3 + 1]! * Vinv[3 + q]! + b.W[r * 3 + 2]! * Vinv[6 + q]!;
          return out;
        });
        for (let a = 0; a < blocks.length; a++) {
          const A1 = blocks[a]!;
          const M1 = WV[a]!;
          for (let r = 0; r < A1.rows; r++) rhs[A1.o + r] = rhs[A1.o + r]! + M1[r * 3]! * bj[0]! + M1[r * 3 + 1]! * bj[1]! + M1[r * 3 + 2]! * bj[2]!;
          for (let b = 0; b < blocks.length; b++) {
            const B1 = blocks[b]!;
            for (let r = 0; r < A1.rows; r++)
              for (let q = 0; q < B1.rows; q++)
                A[(A1.o + r) * N + B1.o + q] = A[(A1.o + r) * N + B1.o + q]! - (M1[r * 3]! * B1.W[q * 3]! + M1[r * 3 + 1]! * B1.W[q * 3 + 1]! + M1[r * 3 + 2]! * B1.W[q * 3 + 2]!);
          }
        }
      }
      if (!choleskySolve(A, rhs, N)) {
        lambda *= 10;
        continue;
      }
      // Back-substitute the points: δX = V⁻¹ (−b − Σ Wᵀ δc).
      for (let j = 0; j < nPts; j++) {
        if (!okPt[j]) continue;
        const acc = [-bp[j * 3]!, -bp[j * 3 + 1]!, -bp[j * 3 + 2]!];
        for (let a = start[j]!; a < start[j + 1]!; a++) {
          const k = order[a]!;
          const w = wts[k]!;
          if (!(w > 0)) continue;
          const jp = k * 6;
          const s = slot[p.cam[k]!]!;
          if (s >= 0) {
            const jc = k * 2 * dc;
            for (let r = 0; r < dc; r++) {
              const d = rhs[s * dc + r]!;
              for (let q = 0; q < 3; q++) acc[q] = acc[q]! - w * (Jc[jc + r]! * Jp[jp + q]! + Jc[jc + dc + r]! * Jp[jp + 3 + q]!) * d;
            }
          }
          if (p.solveFocal) {
            const d = rhs[fIdx]!;
            for (let q = 0; q < 3; q++) acc[q] = acc[q]! - w * (Jf[2 * k]! * Jp[jp + q]! + Jf[2 * k + 1]! * Jp[jp + 3 + q]!) * d;
          }
        }
        const vo = j * 9;
        for (let q = 0; q < 3; q++) p.points[3 * j + q] = p.points[3 * j + q]! + vinvs[vo + q * 3]! * acc[0]! + vinvs[vo + q * 3 + 1]! * acc[1]! + vinvs[vo + q * 3 + 2]! * acc[2]!;
        if (p.rotationOnly) {
          const l = Math.hypot(p.points[3 * j]!, p.points[3 * j + 1]!, p.points[3 * j + 2]!) || 1;
          for (let q = 0; q < 3; q++) p.points[3 * j + q] = p.points[3 * j + q]! / l;
        }
      }
      for (let i = 0; i < p.poses.length; i++) {
        const s = slot[i]!;
        if (s < 0) continue;
        const o = s * dc;
        const dR = expSO3([rhs[o]!, rhs[o + 1]!, rhs[o + 2]!]);
        const ps = p.poses[i]!;
        const t = p.rotationOnly ? ([0, 0, 0] as V3) : vadd(apply3(dR, ps.t), [rhs[o + 3]!, rhs[o + 4]!, rhs[o + 5]!]);
        p.poses[i] = { R: mul3(dR, ps.R), t };
      }
      const oldF = p.f;
      if (p.solveFocal) p.f = Math.max(1, p.f + rhs[fIdx]!);
      const next = observationErrors(p, errors);
      if (next < cost) {
        const gain = (cost - next) / Math.max(1e-300, cost);
        cost = next;
        lambda = Math.max(1e-9, lambda / 3);
        accepted = true;
        if (gain < 1e-7) it = maxIterations;
      } else {
        // Reject: restore and damp harder.
        for (let i = 0; i < p.poses.length; i++) p.poses[i] = savedPoses[i]!;
        p.points.set(savedPoints);
        p.f = oldF;
        lambda *= 4;
      }
    }
    if (!accepted) break;
  }
  observationErrors(p, errors);
  let sq = 0;
  for (let k = 0; k < nObs; k++) sq += errors[k]! * errors[k]!;
  return { iterations: it, rms: nObs ? Math.sqrt(sq / nObs) : 0, errors };
}
