import { describe, expect, it } from "vitest";
import { seededRandom } from "../engine";
import { cameraCentre, type Pose } from "./geometry";
import { apply3, expSO3, mul3, rotationAngleDeg, svd3, transpose3, vadd, vlen, vscale, vsub, det3, type M3, type V3 } from "./linalg";
import { focalFromFov, solveCamera, type FeatureTrack, type TrackSet } from "./solve";

/**
 * GROUND TRUTH for the camera solve: a known camera path over a known 3D
 * scene, projected through a known lens. The solve sees only the 2D tracks
 * (with noise, gaps and outliers); the tests measure how close it lands —
 * reprojection error, the camera path after a similarity alignment (a solve's
 * origin, orientation and scale are arbitrary), and the focal length.
 */

const W = 960;
const H = 540;

interface Truth {
  poses: Pose[];
  f: number;
  set: TrackSet;
}

/** World → camera pose for a camera at `c` turned by yaw/pitch (degrees), CV axes (z forward, y down). */
function poseAt(c: V3, yawDeg: number, pitchDeg = 0, rollDeg = 0): Pose {
  const Ry = expSO3([0, (yawDeg * Math.PI) / 180, 0]);
  const Rx = expSO3([(pitchDeg * Math.PI) / 180, 0, 0]);
  const Rz = expSO3([0, 0, (rollDeg * Math.PI) / 180]);
  const camToWorld = mul3(Ry, mul3(Rx, Rz));
  const R = transpose3(camToWorld);
  return { R, t: vscale(apply3(R, c), -1) };
}

function synth(opts: {
  frames: number;
  path: (u: number) => { c: V3; yaw: number; pitch?: number; roll?: number };
  points: (rand: () => number) => V3;
  count: number;
  fovDeg: number;
  noisePx: number;
  outliers: number;
  /** Drop a track for good with this chance per frame (features coming and going). */
  dropout: number;
  seed?: number;
}): Truth {
  const rand = seededRandom(opts.seed ?? 3);
  const f = focalFromFov(opts.fovDeg, W);
  const poses = Array.from({ length: opts.frames }, (_, i) => {
    const p = opts.path(opts.frames === 1 ? 0 : i / (opts.frames - 1));
    return poseAt(p.c, p.yaw, p.pitch ?? 0, p.roll ?? 0);
  });
  const gauss = () => {
    const u = Math.max(1e-12, rand());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  const tracks: FeatureTrack[] = [];
  for (let n = 0; n < opts.count; n++) {
    const X = opts.points(rand);
    let run: number[] = [];
    let start = -1;
    const flush = () => {
      if (run.length >= 6) tracks.push({ start, uv: Float32Array.from(run), luma: 128 });
      run = [];
      start = -1;
    };
    for (let i = 0; i < opts.frames; i++) {
      const pose = poses[i]!;
      const c = vadd(apply3(pose.R, X), pose.t);
      const u = (f * c[0]) / c[2] + W / 2;
      const v = (f * c[1]) / c[2] + H / 2;
      const inside = c[2] > 0.1 && u > 8 && v > 8 && u < W - 8 && v < H - 8;
      if (!inside || (run.length && rand() < opts.dropout)) {
        flush();
        if (!inside) continue;
      }
      if (start < 0) start = i;
      run.push(u + gauss() * opts.noisePx, v + gauss() * opts.noisePx);
    }
    flush();
  }
  // Outliers: features on things that move by themselves (a random walk across the frame).
  const nOut = Math.round(tracks.length * opts.outliers);
  for (let n = 0; n < nOut; n++) {
    const start = Math.floor(rand() * (opts.frames - 12));
    const len = 12 + Math.floor(rand() * (opts.frames - start - 12));
    let u = 40 + rand() * (W - 80);
    let v = 40 + rand() * (H - 80);
    const du = (rand() - 0.5) * 12;
    const dv = (rand() - 0.5) * 12;
    const uv: number[] = [];
    for (let k = 0; k < len; k++) {
      uv.push(u, v);
      u += du + gauss() * 2;
      v += dv + gauss() * 2;
    }
    tracks.push({ start, uv: Float32Array.from(uv), luma: 128 });
  }
  return { poses, f, set: { width: W, height: H, frames: opts.frames, tracks } };
}

/** Umeyama: the similarity (s, R, t) best carrying points `a` onto `b`. */
function similarity(a: V3[], b: V3[]): { s: number; R: M3; t: V3 } {
  const n = a.length;
  const ma = vscale(a.reduce(vadd, [0, 0, 0]), 1 / n);
  const mb = vscale(b.reduce(vadd, [0, 0, 0]), 1 / n);
  const S: M3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  let va = 0;
  for (let i = 0; i < n; i++) {
    const x = vsub(a[i]!, ma);
    const y = vsub(b[i]!, mb);
    va += x[0] * x[0] + x[1] * x[1] + x[2] * x[2];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r * 3 + c] = S[r * 3 + c]! + y[r]! * x[c]!;
  }
  const { U, s: sv, V } = svd3(S);
  const d = det3(mul3(U, transpose3(V))) < 0 ? -1 : 1;
  const D: M3 = [1, 0, 0, 0, 1, 0, 0, 0, d];
  const R = mul3(mul3(U, D), transpose3(V));
  const s = (sv[0] + sv[1] + d * sv[2]) / (va || 1);
  const t = vsub(mb, vscale(apply3(R, ma), s));
  return { s, R, t };
}

function measure(truth: Truth, sol: ReturnType<typeof solveCamera>) {
  const idx = sol.poses.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  const est = idx.map((i) => cameraCentre(sol.poses[i]!));
  const gt = idx.map((i) => cameraCentre(truth.poses[i]!));
  const sim = similarity(est, gt);
  let pathLen = 0;
  for (let i = 1; i < gt.length; i++) pathLen += vlen(vsub(gt[i]!, gt[i - 1]!));
  let posErr = 0;
  let rotErr = 0;
  idx.forEach((i, k) => {
    const p = vadd(vscale(apply3(sim.R, est[k]!), sim.s), sim.t);
    posErr = Math.max(posErr, vlen(vsub(p, gt[k]!)));
    // Rotations relative to the first placed frame: free of the solve's arbitrary orientation
    // (aligning on camera centres alone cannot fix the roll about a straight dolly).
    const a = idx[0]!;
    const relEst = mul3(sol.poses[i]!.R, transpose3(sol.poses[a]!.R));
    const relGt = mul3(truth.poses[i]!.R, transpose3(truth.poses[a]!.R));
    rotErr = Math.max(rotErr, rotationAngleDeg(relEst, relGt));
  });
  const out = { placed: idx.length / truth.poses.length, posErrRel: pathLen > 0 ? posErr / pathLen : posErr, rotErrDeg: rotErr, focalErr: Math.abs(sol.f - truth.f) / truth.f };
  console.log(`  rms ${sol.rms.toFixed(3)} px · placed ${(out.placed * 100).toFixed(0)}% · path ${(out.posErrRel * 100).toFixed(2)}% · rot ${out.rotErrDeg.toFixed(3)}° · focal ${(out.focalErr * 100).toFixed(2)}% · ${sol.points.length / 3} points · ${sol.keyframes.length} keyframes`);
  return out;
}

/** A room-like scene: a floor, a back wall and boxes, 2–14 units away. */
const roomPoints = (rand: () => number): V3 => {
  const k = rand();
  if (k < 0.35) return [(rand() - 0.5) * 14, 1.6, 2 + rand() * 12]; // floor (y down = +1.6 below eye)
  if (k < 0.7) return [(rand() - 0.5) * 14, 1.6 - rand() * 5, 14]; // back wall
  return [(rand() - 0.5) * 6, 1.6 - rand() * 1.5, 5 + rand() * 5]; // boxes
};

describe("camera solve — ground truth", () => {
  it("recovers a dolly with a pan, known lens, to sub-pixel and under 1% of the path", () => {
    const truth = synth({
      frames: 90,
      path: (u) => ({ c: [-1.5 + 3 * u, 0.1 * Math.sin(u * 3), 0.8 * u], yaw: -6 + 14 * u, pitch: 2 * Math.sin(u * 2) }),
      points: roomPoints,
      count: 700,
      fovDeg: 55,
      noisePx: 0.35,
      outliers: 0,
      dropout: 0.01,
    });
    const sol = solveCamera(truth.set, { mode: "free", focalPx: truth.f });
    const m = measure(truth, sol);
    expect(sol.mode).toBe("free");
    expect(m.placed).toBe(1);
    expect(sol.rms).toBeLessThan(0.6);
    expect(m.posErrRel).toBeLessThan(0.01);
    expect(m.rotErrDeg).toBeLessThan(0.25);
  });

  it("finds the lens when it is unknown", () => {
    const truth = synth({
      frames: 80,
      path: (u) => ({ c: [-2 + 4 * u, -0.3 * u, 1.2 * u], yaw: 10 - 18 * u, pitch: -3 + 4 * u, roll: 1.5 * u }),
      points: roomPoints,
      count: 700,
      fovDeg: 42,
      noisePx: 0.35,
      outliers: 0,
      dropout: 0.01,
      seed: 11,
    });
    const sol = solveCamera(truth.set, { mode: "auto", focalPx: null });
    const m = measure(truth, sol);
    expect(sol.mode).toBe("free");
    expect(m.focalErr).toBeLessThan(0.03);
    expect(sol.rms).toBeLessThan(0.6);
    expect(m.posErrRel).toBeLessThan(0.02);
    expect(m.rotErrDeg).toBeLessThan(0.25);
  });

  it("votes out features on things that move by themselves", () => {
    const truth = synth({
      frames: 70,
      path: (u) => ({ c: [-1.5 + 3 * u, 0, 0.5 * u], yaw: 4 - 8 * u }),
      points: roomPoints,
      count: 600,
      fovDeg: 60,
      noisePx: 0.4,
      outliers: 0.2,
      dropout: 0.01,
      seed: 5,
    });
    const sol = solveCamera(truth.set, { mode: "free", focalPx: truth.f });
    const m = measure(truth, sol);
    expect(m.placed).toBe(1);
    expect(sol.rms).toBeLessThan(0.8);
    expect(m.posErrRel).toBeLessThan(0.015);
    expect(m.rotErrDeg).toBeLessThan(0.3);
  });

  it("solves a pan as a tripod shot, lens included, when nothing has parallax", () => {
    const truth = synth({
      frames: 90,
      path: (u) => ({ c: [0, 0, 0], yaw: -20 + 45 * u, pitch: 5 * Math.sin(u * 3) }),
      points: (rand) => {
        // Directions all round the front, far away.
        const az = (rand() - 0.5) * 2.2;
        const el = (rand() - 0.5) * 1.0;
        return vscale([Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)], 40);
      },
      count: 900,
      fovDeg: 48,
      noisePx: 0.3,
      outliers: 0.05,
      dropout: 0.01,
      seed: 9,
    });
    const sol = solveCamera(truth.set, { mode: "auto", focalPx: null });
    console.log(`  tripod rms ${sol.rms.toFixed(3)} px · focal ${((Math.abs(sol.f - truth.f) / truth.f) * 100).toFixed(2)}% · ${sol.keyframes.length} keyframes`);
    expect(sol.mode).toBe("tripod");
    expect(sol.poses.every(Boolean)).toBe(true);
    expect(Math.abs(sol.f - truth.f) / truth.f).toBeLessThan(0.03);
    expect(sol.rms).toBeLessThan(0.6);
    // Rotations relative to the first frame match.
    let worst = 0;
    for (let i = 0; i < truth.poses.length; i++) {
      const relEst = mul3(sol.poses[i]!.R, transpose3(sol.poses[0]!.R));
      const relGt = mul3(truth.poses[i]!.R, transpose3(truth.poses[0]!.R));
      worst = Math.max(worst, rotationAngleDeg(relEst, relGt));
    }
    expect(worst).toBeLessThan(0.2);
  });
});

// ── End to end: rendered frames → feature tracks → solve ─────────────────────

import { followFeatures } from "./features";
import type { AnalysisFrame, FrameProvider } from "../engine";

/** A hashed lattice of grey cells, blurred by bilinear blending — plenty of corners at every distance. */
function texel(u: number, v: number): number {
  const s = 3.2;
  const x = u * s;
  const y = v * s;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const h = (a: number, b: number) => {
    let n = (a * 374761393 + b * 668265263) | 0;
    n = (n ^ (n >>> 13)) * 1274126177;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const fx = x - xi;
  const fy = y - yi;
  const sm = (t: number) => t * t * (3 - 2 * t);
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  const big = a + (b - a) * sm(fx) + (c - a) * sm(fy) + (a - b - c + d) * sm(fx) * sm(fy);
  const fine = h(Math.floor(x * 4), Math.floor(y * 4));
  return 30 + 160 * big + 60 * fine;
}

/** Ray-cast a room (floor, back wall, side wall, a box) through `pose` at focal `f`. */
function renderRoom(pose: Pose, f: number, w: number, h: number): AnalysisFrame {
  const luma = new Uint8Array(w * h);
  const Rt = transpose3(pose.R);
  const o = cameraCentre(pose);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = apply3(Rt, [(x + 0.5 - w / 2) / f, (y + 0.5 - h / 2) / f, 1]);
      let best = Infinity;
      let val = 0;
      const plane = (axis: 0 | 1 | 2, at: number, ua: 0 | 1 | 2, va: 0 | 1 | 2) => {
        if (Math.abs(d[axis]) < 1e-9) return;
        const t = (at - o[axis]) / d[axis];
        if (t > 0.05 && t < best) {
          best = t;
          val = texel(o[ua] + d[ua] * t, o[va] + d[va] * t);
        }
      };
      plane(1, 1.6, 0, 2); // floor
      plane(2, 14, 0, 1); // back wall
      plane(0, -7, 2, 1); // left wall
      plane(0, 7, 2, 1); // right wall
      // A box: x ∈ [−1.2, 0.6], y ∈ [0.4, 1.6], z ∈ [6, 7.5].
      const lo: V3 = [-1.2, 0.4, 6];
      const hi: V3 = [0.6, 1.6, 7.5];
      let t0 = -Infinity;
      let t1 = Infinity;
      let face = -1;
      for (let a = 0; a < 3; a++) {
        if (Math.abs(d[a]!) < 1e-12) continue;
        let ta = (lo[a]! - o[a]!) / d[a]!;
        let tb = (hi[a]! - o[a]!) / d[a]!;
        if (ta > tb) [ta, tb] = [tb, ta];
        if (ta > t0) {
          t0 = ta;
          face = a;
        }
        t1 = Math.min(t1, tb);
      }
      if (t0 < t1 && t0 > 0.05 && t0 < best) {
        best = t0;
        const p = vadd(o, vscale(d, t0));
        val = face === 0 ? texel(p[2] + 40, p[1]) : face === 1 ? texel(p[0] + 40, p[2]) : texel(p[0] + 40, p[1]);
      }
      luma[y * w + x] = Math.max(0, Math.min(255, Math.round(val)));
    }
  return { width: w, height: h, luma };
}

describe("camera solve — rendered footage", () => {
  it("follows features through a rendered dolly and recovers camera and lens", async () => {
    const w = 480;
    const h = 270;
    const frames = 48;
    const f = focalFromFov(58, w);
    const poses = Array.from({ length: frames }, (_, i) => {
      const u = i / (frames - 1);
      return poseAt([-1.2 + 2.4 * u, 0.05 * Math.sin(u * 4), 0.6 * u], 6 - 12 * u, 3 - 2 * u);
    });
    const cache = new Map<number, AnalysisFrame>();
    const times = poses.map((_, i) => Math.round((i * 1000) / 30));
    const provider: FrameProvider = {
      sourceWidth: w,
      sourceHeight: h,
      scale: 1,
      times,
      still: false,
      async getFrame(ms) {
        const i = times.indexOf(ms);
        let fr = cache.get(i);
        if (!fr) cache.set(i, (fr = renderRoom(poses[i]!, f, w, h)));
        return fr;
      },
    };
    const t0 = Date.now();
    const set = await followFeatures(provider, times, { target: 300, fbPx: 0.8 }, { signal: new AbortController().signal });
    const tTracks = Date.now() - t0;
    const lens = set.tracks.map((t) => t.uv.length / 2);
    const aliveAt = (fr: number) => set.tracks.filter((t) => fr >= t.start && fr < t.start + t.uv.length / 2).length;
    console.log(`  track length mean ${(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1)}, alive f0 ${aliveAt(0)} f24 ${aliveAt(24)} f47 ${aliveAt(47)}`);
    const sol = solveCamera(set, { mode: "auto", focalPx: null });
    const m = measure({ poses, f, set }, sol);
    console.log(`  rendered: ${set.tracks.length} tracks in ${tTracks} ms, solve ${Date.now() - t0 - tTracks} ms`);
    expect(sol.mode).toBe("free");
    expect(m.placed).toBe(1);
    expect(sol.rms).toBeLessThan(0.5);
    expect(m.focalErr).toBeLessThan(0.04);
    expect(m.posErrRel).toBeLessThan(0.03);
    expect(m.rotErrDeg).toBeLessThan(0.3);
  }, 60_000);
});
