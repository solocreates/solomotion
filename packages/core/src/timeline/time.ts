/** Format ms as `m:ss.t` (tenths) — the compact form used across the UI. */
export function formatTime(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSeconds = clamped / 1000;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  const tenths = Math.floor((totalSeconds * 10) % 10);
  return `${m}:${String(s).padStart(2, "0")}.${tenths}`;
}

/** Format ms as SMPTE-ish `m:ss:ff` for a given fps. */
export function formatTimecode(ms: number, fps: number): string {
  const clamped = Math.max(0, ms);
  const totalSeconds = clamped / 1000;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  const f = Math.floor((totalSeconds - Math.floor(totalSeconds)) * fps);
  return `${m}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}

/** Pick a "nice" tick interval (ms) for a ruler at a given zoom. */
export function niceTickIntervalMs(pxPerSecond: number, minPxPerTick = 72): number {
  const steps = [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000];
  for (const step of steps) {
    if ((step / 1000) * pxPerSecond >= minPxPerTick) return step;
  }
  return 60000;
}

/** Snap a time to the closest of the candidate times within a threshold. */
export function snapTime(timeMs: number, candidates: number[], thresholdMs: number): number {
  let best = timeMs;
  let bestDist = thresholdMs;
  for (const c of candidates) {
    const d = Math.abs(c - timeMs);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}
