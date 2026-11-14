import type { DuckRule } from "../schema";
import { dbToGain } from "./envelope";

/**
 * DUCKING — one sound gets out of the way of another, computed, not sensed.
 *
 * A DAW ducks with a sidechain compressor listening live. That is the wrong
 * shape here: the timeline already KNOWS when every trigger plays, the
 * exporter must produce exactly what playback did, and a scrub has no "live"
 * to listen to. So a duck is a deterministic gain curve over the comp, built
 * from the triggers' audible spans — the same curve the live engine samples
 * per tick and the exporter hands to `setValueCurveAtTime`, and one the
 * timeline could draw.
 *
 * It LOOKS AHEAD: the ramp down starts `attackMs` before the trigger, so the
 * music is already out of the way when the first word lands — the thing a
 * sidechain cannot do, and the reason editors hand-draw ducks instead.
 */

export interface DuckSpan {
  from: number;
  to: number;
}

export interface DuckCurve {
  /** Grid spacing, ms. */
  stepMs: number;
  /** Linear gain per grid step, from output time 0. */
  gains: Float32Array;
}

/** Grid resolution of every duck curve — fine enough that a 50ms attack is a ramp. */
export const DUCK_STEP_MS = 10;

/**
 * Build one rule's curve over `durationMs` of output from its triggers' spans.
 * The duck AMOUNT runs 0 → 1 linearly (so the gain moves linearly in dB, the
 * way a fader does), rising over `attackMs` ahead of each span and falling over
 * `releaseMs` after it.
 */
export function duckCurve(spans: readonly DuckSpan[], rule: Pick<DuckRule, "depthDb" | "attackMs" | "releaseMs">, durationMs: number): DuckCurve {
  const steps = Math.max(1, Math.ceil(durationMs / DUCK_STEP_MS) + 1);
  const want = new Uint8Array(steps);
  const lead = Math.max(0, rule.attackMs);
  for (const s of spans) {
    const a = Math.max(0, Math.floor((s.from - lead) / DUCK_STEP_MS));
    const b = Math.min(steps - 1, Math.ceil(s.to / DUCK_STEP_MS));
    for (let i = a; i <= b; i++) want[i] = 1;
  }
  const up = rule.attackMs > 0 ? DUCK_STEP_MS / rule.attackMs : 1;
  const down = rule.releaseMs > 0 ? DUCK_STEP_MS / rule.releaseMs : 1;
  const gains = new Float32Array(steps);
  let amount = 0;
  for (let i = 0; i < steps; i++) {
    amount = want[i] ? Math.min(1, amount + up) : Math.max(0, amount - down);
    gains[i] = dbToGain(-rule.depthDb * amount);
  }
  return { stepMs: DUCK_STEP_MS, gains };
}

/** A curve's gain at an output instant (linear between grid points; 1 outside). */
export function duckGainAt(curve: DuckCurve | null, ms: number): number {
  if (!curve || ms < 0) return 1;
  const x = ms / curve.stepMs;
  const i = Math.floor(x);
  const g = curve.gains;
  if (i >= g.length - 1) return g[g.length - 1] ?? 1;
  const f = x - i;
  return g[i]! * (1 - f) + g[i + 1]! * f;
}

/** Several rules on one target stack: each takes its own bite. Null when none. */
export function multiplyDucks(curves: readonly DuckCurve[]): DuckCurve | null {
  if (curves.length === 0) return null;
  if (curves.length === 1) return curves[0]!;
  const n = Math.max(...curves.map((c) => c.gains.length));
  const gains = new Float32Array(n).fill(1);
  for (const c of curves) for (let i = 0; i < n; i++) gains[i]! *= c.gains[Math.min(i, c.gains.length - 1)]!;
  return { stepMs: DUCK_STEP_MS, gains };
}

/** A slice of a curve as a value curve for `setValueCurveAtTime` (export, windowed renders). */
export function duckValueCurve(curve: DuckCurve, fromMs: number, durationMs: number, stepMs = DUCK_STEP_MS): Float32Array {
  const n = Math.max(2, Math.ceil(durationMs / stepMs) + 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = duckGainAt(curve, fromMs + i * stepMs);
  return out;
}
