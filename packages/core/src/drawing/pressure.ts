/**
 * Pen input — the ONE normalized contract between pointing hardware and every
 * drawing tool. The web layer turns PointerEvents (Apple Pencil, Wacom/Huion
 * tablets, touch, mouse — coalesced for full tablet report rates) into
 * `PenSample`s; brushes, erasers, lassos and the Brush Studio playground all
 * consume samples and never touch events. Pressure RESPONSE (how hard maps to
 * how big/opaque) is data (`PressureResponse`), so the pressure popover, brush
 * dynamics and playground preview are literally the same math.
 */

/** One normalized input sample, in the target surface's coordinate space. */
export interface PenSample {
  x: number;
  y: number;
  /** 0..1. Real from pens; synthesized from velocity for mice/touch. */
  pressure: number;
  /** Pen barrel tilt in degrees (0 = perpendicular). 0 when unsupported. */
  tiltX: number;
  tiltY: number;
  /** Monotonic time in ms (event timestamps) — drives velocity dynamics. */
  timeMs: number;
}

/**
 * How a 0..1 pressure maps onto one output channel (size, opacity, …).
 * `amount` is the mix: 0 = pressure ignored (output pinned at 1), 1 = full
 * range. `gamma` shapes the feel (< 1 soft touch, > 1 firm touch), `floor`
 * keeps a barely-touching stroke from vanishing entirely.
 */
export interface PressureResponse {
  amount: number;
  gamma: number;
  floor: number;
}

/** Global pressure preferences — the pressure-popover's data. App-level. */
export interface PressureSettings {
  /**
   * Master switch (the pressure pod's one-click toggle). Off = every sample
   * normalizes to full pressure — brushes go flat and predictable — while all
   * the tuned curves stay saved for the next click back on.
   */
  enabled: boolean;
  size: PressureResponse;
  opacity: PressureResponse;
  /**
   * Devices that report no pressure (mouse, most trackpads, cheap styli):
   * synthesize it from speed — slow deliberate strokes press hard, fast
   * flicks press light — so every brush stays expressive everywhere.
   */
  velocityFallback: boolean;
  /** Speed (surface px/ms) that maps to the LIGHTEST synthetic pressure. */
  velocityRange: number;
}

export const DEFAULT_PRESSURE_SETTINGS: PressureSettings = {
  enabled: true,
  size: { amount: 1, gamma: 1, floor: 0.05 },
  opacity: { amount: 0.6, gamma: 1, floor: 0.1 },
  velocityFallback: true,
  velocityRange: 2.5,
};

/**
 * Resolve a pressure into a 0..1 multiplier for one channel. This is THE
 * pressure curve — the brush engine, the eraser, the studio playground and
 * the popover's preview all call this exact function.
 */
export function pressureResponse(pressure: number, r: PressureResponse): number {
  const p = Math.min(1, Math.max(0, pressure));
  const shaped = Math.pow(p, r.gamma > 0 ? r.gamma : 1);
  const mixed = 1 - r.amount + r.amount * shaped;
  return Math.max(r.floor, Math.min(1, mixed));
}

/**
 * Synthetic pressure from stroke speed (px/ms), for devices reporting none:
 * standing still ≈ full press, `velocityRange` and beyond ≈ light touch.
 * Smoothed by the caller (velocity is jittery at event granularity).
 */
export function velocityPressure(speedPxPerMs: number, settings: PressureSettings): number {
  const range = settings.velocityRange > 0 ? settings.velocityRange : 1;
  const t = Math.min(1, Math.max(0, speedPxPerMs / range));
  // Ease-out so light pressure needs a genuinely fast flick.
  return 1 - t * t * (3 - 2 * t) * 0.85;
}

/**
 * A tiny stateful normalizer the input layer runs each raw sample through:
 * fills in missing pressure (velocity fallback, smoothed), and clamps.
 * One instance per stroke — it carries only the previous sample.
 */
export class PenSampleNormalizer {
  private prev: PenSample | null = null;
  private smoothedPressure = 0.7;

  constructor(
    private readonly settings: PressureSettings,
    /** Whether the device reports real pressure (pointerType === "pen"). */
    private readonly hasPressure: boolean,
  ) {}

  normalize(raw: PenSample): PenSample {
    // The master switch flattens EVERYTHING here — the one seam every tool's
    // input passes through, so no tool can disagree about what "off" means.
    if (!this.settings.enabled) {
      const sample: PenSample = { ...raw, pressure: 1 };
      this.prev = sample;
      return sample;
    }
    let pressure = raw.pressure;
    if (!this.hasPressure && this.settings.velocityFallback) {
      const prev = this.prev;
      if (prev) {
        const dt = Math.max(1, raw.timeMs - prev.timeMs);
        const dist = Math.hypot(raw.x - prev.x, raw.y - prev.y);
        const target = velocityPressure(dist / dt, this.settings);
        // Low-pass so pressure breathes instead of flickering per event.
        this.smoothedPressure += (target - this.smoothedPressure) * 0.2;
      }
      pressure = this.smoothedPressure;
    } else if (!this.hasPressure) {
      pressure = 1;
    }
    const sample: PenSample = { ...raw, pressure: Math.min(1, Math.max(0, pressure)) };
    this.prev = sample;
    return sample;
  }
}
