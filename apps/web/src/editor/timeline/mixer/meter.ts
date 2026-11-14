"use client";

/**
 * Meter math and paint — the part of the mixer that runs sixty times a second,
 * so it is plain functions over a canvas and never React.
 *
 * The scale and colours are the convention every mixing tool shares, on
 * purpose: green where a mix lives, amber past −12 dBFS, RED past −3 — the
 * zone where sound starts to hurt and a file starts to clip — and a clip light
 * that latches when anything touches 0 dBFS so a peak you blinked through is
 * still reported.
 */

export const METER_FLOOR_DB = -60;
export const METER_CEIL_DB = 6;
const WARN_DB = -12;
const HOT_DB = -3;
const COLORS = { ok: "#3ddc84", warn: "#f5c542", hot: "#ff4d4d", track: "rgba(127,127,127,0.16)", ghost: "rgba(255,255,255,0.55)" };

/** dB → 0..1 up the meter (linear in dB, the way a meter is read). */
export function meterY(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / (METER_CEIL_DB - METER_FLOOR_DB)));
}

/** Peak and RMS of one analyser's current window, dBFS. */
export function readLevel(analyser: AnalyserNode, scratch: Float32Array): { peakDb: number; rmsDb: number } {
  analyser.getFloatTimeDomainData(scratch as Float32Array<ArrayBuffer>);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < scratch.length; i++) {
    const v = scratch[i]!;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / scratch.length);
  return { peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity, rmsDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity };
}

/** Ballistics for one bar: instant rise, ~20 dB/s fall, a peak mark that holds 1.5s. */
export interface MeterState {
  shown: number;
  rms: number;
  hold: number;
  holdAt: number;
  clipAt: number;
}

export function newMeter(): MeterState {
  return { shown: -Infinity, rms: -Infinity, hold: -Infinity, holdAt: 0, clipAt: 0 };
}

export function stepMeter(m: MeterState, peakDb: number, rmsDb: number, now: number, dtSec: number): void {
  const fall = 20 * dtSec;
  m.shown = peakDb >= m.shown || !Number.isFinite(m.shown) ? peakDb : Math.max(peakDb, m.shown - fall);
  m.rms = rmsDb >= m.rms || !Number.isFinite(m.rms) ? rmsDb : Math.max(rmsDb, m.rms - fall);
  if (peakDb >= m.hold || now - m.holdAt > 1500) {
    m.hold = peakDb;
    m.holdAt = now;
  }
  if (peakDb >= -0.1) m.clipAt = now;
}

function colorFor(db: number): string {
  return db >= HOT_DB ? COLORS.hot : db >= WARN_DB ? COLORS.warn : COLORS.ok;
}

/**
 * Paint one bar. The fill is split at the warn/hot thresholds so the colour is
 * a property of the HEIGHT, not of the current level — a loud moment turns the
 * top of the bar red, it does not tint the whole column. `ghostDb` is the
 * parked level at the playhead, drawn as a hollow mark.
 */
export function paintBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  w: number,
  h: number,
  m: MeterState,
  ghostDb: number | null,
): void {
  ctx.fillStyle = COLORS.track;
  ctx.fillRect(x, 0, w, h);
  const top = meterY(m.shown);
  if (top > 0) {
    for (const [from, to, db] of [
      [0, meterY(WARN_DB), WARN_DB - 1],
      [meterY(WARN_DB), meterY(HOT_DB), HOT_DB - 1],
      [meterY(HOT_DB), 1, 0],
    ] as const) {
      const a = Math.min(top, from);
      const b = Math.min(top, to);
      if (b <= a) continue;
      ctx.fillStyle = colorFor(db);
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x, h - b * h, w, (b - a) * h);
    }
    ctx.globalAlpha = 1;
  }
  const rms = meterY(m.rms);
  if (rms > 0) {
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(x + w * 0.25, h - rms * h, w * 0.5, rms * h);
  }
  const hold = meterY(m.hold);
  if (hold > 0) {
    ctx.fillStyle = colorFor(m.hold);
    ctx.fillRect(x, h - hold * h - 1, w, 2);
  }
  if (ghostDb !== null && Number.isFinite(ghostDb)) {
    const g = meterY(ghostDb);
    ctx.strokeStyle = COLORS.ghost;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, h - g * h - 1.5, w - 1, 3);
  }
}

/** The clip light's colour right now: red for 2s after anything touched 0 dBFS. */
export function clipLit(m: MeterState, now: number): boolean {
  return now - m.clipAt < 2000;
}
