import { FrameThrottle, throwIfAborted, type AnalysisFrame, type FrameProvider } from "../engine";
import { detectCorners, trackPoints, type LkOptions } from "../cpu/klt";
import type { FeatureTrack, TrackSet } from "./solve";

/**
 * LONG FEATURE TRACKS — the camera solve's input: hundreds of corners
 * followed through the whole plate, each for as long as it stays itself.
 *
 * The region tracker's KLT (`cpu/klt.ts`) over the WHOLE frame: Shi–Tomasi
 * corners spread across the picture (an occupancy grid keeps them apart, so
 * a busy corner of the frame cannot take every feature), pyramidal
 * Lucas–Kanade frame to frame with a constant-velocity guess, and a
 * forward–backward check on every step — a feature whose round trip does not
 * come home has slid along an edge or been covered, and ends there. New
 * corners are seeded wherever the crowd has thinned.
 *
 * Tracks are continuous by construction (a lost feature never resumes), so a
 * track is a start frame and a run of positions. Positions are returned in
 * SOURCE pixels.
 */

export interface FeatureOptions {
  /** Features followed at once. */
  target: number;
  /** Forward–backward limit, analysis px. */
  fbPx: number;
}

export const DEFAULT_FEATURES: FeatureOptions = { target: 400, fbPx: 0.8 };

const LK: LkOptions = { half: 6, levels: 3, iterations: 12, epsilon: 0.02 };
/** Mean absolute residual over the window past which a step is not the same patch. */
const MAX_LK_ERROR = 18;

interface Live {
  track: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export async function followFeatures(
  provider: FrameProvider,
  times: readonly number[],
  opts: FeatureOptions,
  control: { signal: AbortSignal; gate?: () => Promise<void> },
  onProgress?: (done: number, total: number) => void,
): Promise<TrackSet> {
  const s = provider.scale;
  const tracks: { start: number; uv: number[]; luma: number }[] = [];
  const throttle = new FrameThrottle();
  let live: Live[] = [];
  let prev: AnalysisFrame | null = null;

  for (let f = 0; f < times.length; f++) {
    await control.gate?.();
    throwIfAborted(control.signal);
    await throttle.tick();
    const frame = await provider.getFrame(times[f]!);
    const w = frame.width;
    const h = frame.height;
    const spacing = Math.max(6, Math.sqrt((w * h) / opts.target) * 0.7);

    if (prev && live.length) {
      const from = live.map((p) => ({ x: p.x, y: p.y }));
      const guess = live.map((p) => ({ x: p.vx, y: p.vy }));
      const fwd = trackPoints(prev, frame, from, guess, LK);
      const back = trackPoints(frame, prev, fwd.points, guess.map((g) => ({ x: -g.x, y: -g.y })), LK);
      const next: Live[] = [];
      for (let k = 0; k < live.length; k++) {
        const p = fwd.points[k]!;
        const b = back.points[k]!;
        const ok =
          fwd.ok[k] &&
          back.ok[k] &&
          fwd.error[k]! < MAX_LK_ERROR &&
          Math.hypot(b.x - from[k]!.x, b.y - from[k]!.y) < opts.fbPx &&
          p.x > 2 && p.y > 2 && p.x < w - 3 && p.y < h - 3;
        if (!ok) continue;
        const l = live[k]!;
        tracks[l.track]!.uv.push(p.x / s, p.y / s);
        next.push({ track: l.track, x: p.x, y: p.y, vx: p.x - l.x, vy: p.y - l.y });
      }
      live = next;
    }

    // Replenish where the crowd has thinned.
    if (live.length < opts.target * 0.8) {
      const cell = spacing;
      const gw = Math.ceil(w / cell);
      const gh = Math.ceil(h / cell);
      const taken = new Uint8Array(gw * gh);
      for (const p of live) {
        const gx = Math.floor(p.x / cell);
        const gy = Math.floor(p.y / cell);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = gx + dx;
            const y = gy + dy;
            if (x >= 0 && y >= 0 && x < gw && y < gh) taken[y * gw + x] = 1;
          }
      }
      const fresh = detectCorners(frame, { x0: 4, y0: 4, x1: w - 5, y1: h - 5 }, (x, y) => !taken[Math.floor(y / cell) * gw + Math.floor(x / cell)], {
        max: opts.target - live.length,
        minDistance: spacing,
        quality: 0.02,
        half: 2,
      });
      for (const c of fresh) {
        const id = tracks.length;
        tracks.push({ start: f, uv: [c.x / s, c.y / s], luma: frame.luma[Math.round(c.y) * w + Math.round(c.x)] ?? 128 });
        live.push({ track: id, x: c.x, y: c.y, vx: 0, vy: 0 });
      }
    }
    prev = frame;
    onProgress?.(f + 1, times.length);
  }

  const out: FeatureTrack[] = [];
  for (const t of tracks) if (t.uv.length >= 8) out.push({ start: t.start, uv: Float32Array.from(t.uv), luma: t.luma });
  return { width: provider.sourceWidth, height: provider.sourceHeight, frames: times.length, tracks: out };
}
