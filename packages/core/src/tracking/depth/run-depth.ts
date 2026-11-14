import type { DepthTracker, TrackSpan } from "../../schema/tracking";
import { FrameThrottle, throwIfAborted, type AnalysisFrame, type FrameProvider } from "../engine";
import type { RunControl } from "../run";

/**
 * A DEPTH RUN — every frame of the footage through a depth model, into maps of
 * NEARNESS that agree with each other across the whole shot.
 *
 * The model is a PORT (`DepthEngine`): the host runs the network (onnxruntime
 * in the analysis worker); everything here is the part that has to be right
 * and testable without one —
 *
 *   VIDEO (Video Depth Anything): a temporal head sees `window` frames at a
 *   time. Windows step by `window − overlap`, and each one is AFFINE-ALIGNED
 *   to the last on the frames they share (a least-squares scale and shift —
 *   the model's depth is relative, so two windows can disagree by exactly
 *   that), then cross-faded across the overlap. No seam, no pump.
 *   STILL (Depth Anything V3): one picture at a time. On FOOTAGE without the
 *   temporal head (a device whose GPU cannot hold it — an 8 GB laptop), the
 *   still model runs per frame and is STEADIED here: each frame affine-aligned
 *   to the one before, then blended toward it where nothing moved, so the
 *   model's per-frame drift does not pump through fog or a matte.
 *
 * The shot's range is measured at the end (a histogram, robust percentiles),
 * and every map re-quantised to it, so 0 is the far end of THIS shot and 1 its
 * nearest — what the effects' near/far mean.
 */

/** Which way a model's raw output points. */
export type DepthSense = "disparity" | "depth";

export interface VideoDepthPort {
  /** The model's fixed input size and window. */
  width: number;
  height: number;
  window: number;
  sense: DepthSense;
  /** Encode a frame (CHW, normalised) into window slot `slot`. */
  encode(rgb: Float32Array, slot: number): Promise<void>;
  /** The head over the whole window: `window` maps of width × height, raw. */
  head(): Promise<Float32Array[]>;
  /** Move slots [from, from + count) to [0, count) — the overlap carried into the next window. */
  carry(from: number, count: number): void;
}

export interface StillDepthPort {
  sense: DepthSense;
  /** The input size it wants for a source of this aspect (multiples of its patch). */
  sizeFor(width: number, height: number): { width: number; height: number };
  estimate(rgb: Float32Array, width: number, height: number): Promise<Float32Array>;
}

export interface DepthEngine {
  video?: VideoDepthPort;
  still?: StillDepthPort;
}

export interface DepthRunResult {
  /** `video`: maps that agree across the shot (temporal head, or steadied frames); `still`: one picture. */
  model: "video" | "still";
  /** Which network made them. */
  network: "vda-small" | "da3-small";
  width: number;
  height: number;
  times: number[];
  /** Nearness × 65535 per frame, row-major. */
  maps: Uint16Array[];
  solved: TrackSpan[];
  stats: { frames: number; ms: number; windows: number };
}

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

/** RGBA at any size → CHW float, ImageNet-normalised, resampled (bilinear) to `w × h`. */
export function toTensor(frame: AnalysisFrame, w: number, h: number): Float32Array {
  const src = frame.rgba;
  const out = new Float32Array(3 * w * h);
  const sw = frame.width;
  const sh = frame.height;
  const plane = w * h;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1.001, Math.max(0, ((y + 0.5) * sh) / h - 0.5));
    const y0 = sy | 0;
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1.001, Math.max(0, ((x + 0.5) * sw) / w - 0.5));
      const x0 = sx | 0;
      const fx = sx - x0;
      const o = y * w + x;
      for (let c = 0; c < 3; c++) {
        let v: number;
        if (src) {
          const i = (y0 * sw + x0) * 4 + c;
          const a = src[i]!, b = src[i + 4]!, cc = src[i + sw * 4]!, d = src[i + sw * 4 + 4]!;
          v = a + (b - a) * fx + (cc - a) * fy + (a - b - cc + d) * fx * fy;
        } else {
          const i = y0 * sw + x0;
          const L = frame.luma;
          const a = L[i]!, b = L[i + 1]!, cc = L[i + sw]!, d = L[i + sw + 1]!;
          v = a + (b - a) * fx + (cc - a) * fy + (a - b - cc + d) * fx * fy;
        }
        out[c * plane + o] = (v / 255 - IMAGENET_MEAN[c]!) / IMAGENET_STD[c]!;
      }
    }
  }
  return out;
}

/** A raw model map → `mw × mh` floats, area-averaged, turned into "bigger is nearer". */
export function resampleMap(raw: Float32Array, rw: number, rh: number, mw: number, mh: number, sense: DepthSense): Float32Array {
  const out = new Float32Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    const y0 = Math.floor((y * rh) / mh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * rh) / mh));
    for (let x = 0; x < mw; x++) {
      const x0 = Math.floor((x * rw) / mw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * rw) / mw));
      let s = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) (s += raw[yy * rw + xx]!), n++;
      const v = s / n;
      out[y * mw + x] = sense === "disparity" ? v : 1 / Math.max(1e-6, v);
    }
  }
  return out;
}

/** The scale and shift carrying `cur` onto `ref` in least squares, over a sparse grid of pixels. */
export function affineFit(cur: Float32Array[], ref: Float32Array[]): { a: number; b: number } {
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (let k = 0; k < cur.length; k++) {
    const c = cur[k]!;
    const r = ref[k]!;
    const step = Math.max(1, Math.floor(c.length / 4096));
    for (let i = 0; i < c.length; i += step) {
      const x = c[i]!;
      const y = r[i]!;
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
      n++;
    }
  }
  const den = n * sxx - sx * sx;
  if (!(Math.abs(den) > 1e-12)) return { a: 1, b: 0 };
  const a = (n * sxy - sx * sy) / den;
  return { a, b: (sy - a * sx) / n };
}

/**
 * STEADY a per-frame map against the frame before it, in place: the scale and
 * shift that carry it onto `prev` (fitted twice, the second time on the pixels
 * the first agreed on — what moved is left out of the fit), then a blend
 * toward `prev` wherever the two agree closely, so what holds still holds
 * still and what moves keeps moving.
 */
export function steady(map: Float32Array, prev: Float32Array): void {
  let { a, b } = affineFit([map], [prev]);
  // Second fit on the pixels that agreed (residual under a fraction of the frame's spread).
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < prev.length; i++) (lo = Math.min(lo, prev[i]!)), (hi = Math.max(hi, prev[i]!));
  const tol = Math.max(1e-6, (hi - lo) * 0.04);
  const keepM: number[] = [];
  const keepP: number[] = [];
  const step = Math.max(1, Math.floor(map.length / 4096));
  for (let i = 0; i < map.length; i += step) if (Math.abs(a * map[i]! + b - prev[i]!) < tol) (keepM.push(map[i]!), keepP.push(prev[i]!));
  if (keepM.length > 64) ({ a, b } = affineFit([Float32Array.from(keepM)], [Float32Array.from(keepP)]));
  for (let i = 0; i < map.length; i++) {
    const v = a * map[i]! + b;
    const d = Math.abs(v - prev[i]!);
    // Agreement → lean on the past (60%); a real change → take the new frame.
    const w = d < tol ? 0.6 * (1 - d / tol) : 0;
    map[i] = v * (1 - w) + prev[i]! * w;
  }
}

/** The map size for a source: `edge` on the long side, the source's aspect. */
export function mapSize(sourceWidth: number, sourceHeight: number, edge: number): { width: number; height: number } {
  const k = edge / Math.max(sourceWidth, sourceHeight);
  return { width: Math.max(8, Math.round(sourceWidth * k)), height: Math.max(8, Math.round(sourceHeight * k)) };
}

/** Which model a tracker runs on this source. */
export function depthModelFor(tracker: DepthTracker, still: boolean): "video" | "still" {
  const m = tracker.solve.model;
  return m === "auto" ? (still ? "still" : "video") : m;
}

/** Overlap between video windows, frames. */
const OVERLAP = 8;

export async function runDepth(
  provider: FrameProvider,
  tracker: DepthTracker,
  engine: DepthEngine,
  control: RunControl,
  onProgress?: (p: { done: number; total: number; note: string }) => void,
): Promise<DepthRunResult> {
  const t0 = Date.now();
  const model = depthModelFor(tracker, provider.still);
  const times = provider.still ? provider.times.slice(0, 1) : provider.times;
  const { width: mw, height: mh } = mapSize(provider.sourceWidth, provider.sourceHeight, tracker.solve.mapEdge);
  const throttle = new FrameThrottle();
  const aligned: Float32Array[] = [];
  let windows = 0;

  const steadied = model === "video" && !engine.video;
  if (model === "still" || steadied) {
    const port = engine.still;
    if (!port) throw Object.assign(new Error("The still depth model is not available."), { name: "SolveError" });
    for (let i = 0; i < times.length; i++) {
      await control.gate?.();
      throwIfAborted(control.signal);
      await throttle.tick();
      const frame = await provider.getFrame(times[i]!);
      const size = port.sizeFor(frame.width, frame.height);
      const raw = await port.estimate(toTensor(frame, size.width, size.height), size.width, size.height);
      const map = resampleMap(raw, size.width, size.height, mw, mh, port.sense);
      if (steadied && i > 0) steady(map, aligned[i - 1]!);
      // A still run per frame (`still` on footage) has no shot to agree with: each map is normalised on its own below.
      aligned.push(map);
      onProgress?.({ done: i + 1, total: times.length, note: `Depth — frame ${i + 1} of ${times.length}` });
    }
  } else {
    const port = engine.video;
    if (!port) throw Object.assign(new Error("The video depth model is not available."), { name: "SolveError" });
    const W = port.window;
    const S = Math.max(1, W - OVERLAP);
    const n = times.length;
    let start = 0;
    let carried = 0;
    let prevTail: Float32Array[] | null = null;
    while (start < n) {
      // Encode the window's new frames (the overlap is carried from the last one); pad past the end by holding the last frame.
      for (let k = carried; k < W; k++) {
        await control.gate?.();
        throwIfAborted(control.signal);
        await throttle.tick();
        const frame = await provider.getFrame(times[Math.min(n - 1, start + k)]!);
        await port.encode(toTensor(frame, port.width, port.height), k);
        onProgress?.({ done: Math.min(n, start + k + 1), total: n, note: `Depth — frame ${Math.min(n, start + k + 1)} of ${n}` });
      }
      const raw = await port.head();
      windows++;
      const maps = raw.map((m) => resampleMap(m, port.width, port.height, mw, mh, port.sense));
      if (prevTail) {
        // Align this window to the last on the frames they share, then cross-fade across them.
        const { a, b } = affineFit(maps.slice(0, prevTail.length), prevTail);
        for (const m of maps) for (let i = 0; i < m.length; i++) m[i] = a * m[i]! + b;
        for (let k = 0; k < prevTail.length; k++) {
          const w = (k + 1) / (prevTail.length + 1);
          const into = aligned[start + k]!;
          const m = maps[k]!;
          for (let i = 0; i < into.length; i++) into[i] = into[i]! * (1 - w) + m[i]! * w;
        }
      }
      const fresh = prevTail ? prevTail.length : 0;
      for (let k = fresh; k < W && start + k < n; k++) aligned[start + k] = maps[k]!;
      if (start + W >= n) break;
      prevTail = maps.slice(S, W);
      port.carry(S, W - S);
      carried = W - S;
      start += S;
    }
  }

  // The shot's range: robust percentiles of everything (a sparse sample is plenty).
  const sample: number[] = [];
  for (const m of aligned) {
    const step = Math.max(1, Math.floor(m.length / 2048));
    for (let i = 0; i < m.length; i += step) if (Number.isFinite(m[i]!)) sample.push(m[i]!);
  }
  sample.sort((x, y) => x - y);
  const lo = sample[Math.floor(sample.length * 0.005)] ?? 0;
  const hi = sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.995))] ?? 1;
  const span = hi - lo > 1e-9 ? hi - lo : 1;
  const maps = aligned.map((m) => {
    const out = new Uint16Array(m.length);
    // A still model's frames are each their own picture: normalised on their own.
    let flo = lo;
    let fspan = span;
    if (model === "still" && !steadied && times.length > 1) {
      const s = Array.from(m).filter(Number.isFinite).sort((x, y) => x - y);
      flo = s[Math.floor(s.length * 0.005)] ?? lo;
      fspan = Math.max(1e-9, (s[Math.floor(s.length * 0.995)] ?? hi) - flo);
    }
    for (let i = 0; i < m.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, (m[i]! - flo) / fspan)) * 65535);
    return out;
  });
  return {
    model,
    network: model === "video" && !steadied ? "vda-small" : "da3-small",
    width: mw,
    height: mh,
    times: times.slice(0, maps.length),
    maps,
    solved: [[times[0]!, times[Math.max(0, maps.length - 1)]!]],
    stats: { frames: maps.length, ms: Date.now() - t0, windows },
  };
}
