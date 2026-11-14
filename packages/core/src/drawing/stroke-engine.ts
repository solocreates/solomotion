import type { BrushMod, BrushModTarget, BrushPreset } from "./brush";
import {
  pressureResponse,
  type PenSample,
  type PressureSettings,
} from "./pressure";

/**
 * The stroke engine — (PenSamples, BrushPreset) → dabs. Pure math, no canvas:
 * the web painter rasterizes dabs, the Brush Studio playground previews them,
 * and tests assert on them. One engine feeds every raster brush AND the
 * eraser (an eraser is a brush whose rendering erases); the vector brush uses
 * the same streamlined polyline before curve fitting (see path-fit.ts).
 *
 * Design for smoothness on weak devices:
 *  - Incremental: `feed()` emits only the NEW dabs since the last call — the
 *    painter stamps just those onto the persistent surface. Nothing is ever
 *    re-stamped, so stroke cost is O(new dabs), not O(stroke length).
 *  - Spacing walks residual arc length across samples, so dab density is
 *    stable regardless of event rate (60 Hz mouse vs 240 Hz pencil).
 *  - Streamline is a simple chase filter — no history buffers to grow.
 */

/** One stamp of the brush tip onto the surface. */
export interface Dab {
  x: number;
  y: number;
  /** Final diameter in surface px (all dynamics applied). */
  size: number;
  /** Final dab alpha 0..1 (opacity × flow × dynamics). */
  alpha: number;
  /** Tip rotation in RADIANS (brush angle + stroke direction if following). */
  angle: number;
  /**
   * Per-dab colour shift — hue in degrees, saturation and lightness as −1…1
   * offsets. Zero on nearly every brush; the painter skips its tint path
   * entirely when all three are, so foliage and confetti cost the rest of the
   * library nothing.
   */
  hue: number;
  saturation: number;
  lightness: number;
  /** Tip squash for this dab (roundness after modulation). */
  roundness: number;
  /**
   * WHICH stamp of the tip's source set this dab uses (an index into
   * `shape.sources`; 0 when the tip is procedural or has a single source).
   * A particle brush is nothing more than this number changing per dab.
   */
  variant: number;
}

/**
 * The stroke length `strokeT` normalises against. A stroke's true length is
 * unknowable while it is being drawn, and `strokeT` has to be right on the
 * FIRST dab — so it runs against a nominal 600px, the length of a comfortable
 * arm's-reach gesture. Ribbons and comets fade over that distance whether the
 * stroke ends there or carries on.
 */
const STROKE_T_LENGTH_PX = 600;

/** Deterministic per-stroke rng (mulberry32) — jitter/scatter reproduce in tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


/**
 * WHICH global pressure curve conditions a `pressure` source, by target.
 *
 * The app-wide pressure prefs hold two curves — one for size, one for opacity —
 * because that is how every drawing app's tablet settings work and how this
 * app's pressure pod already reads. A brush's own mods ride ON TOP of them, so
 * this table is the seam where "my tablet feels right" meets "this brush cares
 * about pressure a lot": the artist tunes the curve once, the brush decides how
 * much of it to use.
 */
function pressureChannel(target: BrushModTarget): "size" | "opacity" | null {
  if (target === "size" || target === "roundness" || target === "scatter" || target === "jitter") return "size";
  if (target === "opacity" || target === "flow") return "opacity";
  return null;
}

/** Targets that SCALE the base value. Everything else offsets it. */
const MULTIPLICATIVE = new Set<BrushModTarget>(["size", "opacity", "flow", "roundness", "grain"]);

/** The full-scale swing of each additive target, per unit of `amount`. */
const ADDITIVE_RANGE: Partial<Record<BrushModTarget, number>> = {
  angle: 180,      // degrees
  scatter: 2,      // dab-size fractions
  jitter: 2,
  hue: 180,        // degrees
  saturation: 1,
  lightness: 1,
};

/** The live signals one dab is evaluated against. */
interface ModInputs {
  pressure: number;
  tilt: number;
  /** Speed in px/ms, already smoothed. */
  velocity: number;
  /** Stroke direction in radians. */
  direction: number;
  /** 0 → 1 along the stroke, by the brush's own nominal length. */
  strokeT: number;
  /** Seconds since the stroke began. */
  time: number;
  /** Fresh 0..1 per dab. */
  random: number;
}

interface EnginePoint {
  x: number;
  y: number;
  pressure: number;
  tilt: number;
  /** Speed in px/ms at this point (smoothed). */
  speed: number;
}

export class StrokeEngine {
  /** Total arc length consumed so far (drives taper + spacing). */
  private lengthPx = 0;
  /** Distance still to travel before the next dab. */
  private residual = 0;
  /** The streamlined (chased) position — what dabs actually follow. */
  private smooth: EnginePoint | null = null;
  private lastRaw: PenSample | null = null;
  private smoothedSpeed = 0;
  /** Ms since the stroke's first sample — the `time` modulation source. */
  private elapsedMs = 0;
  private startMs: number | null = null;
  private readonly rng: () => number;
  /** The streamlined polyline, kept for end-taper + vector fitting. */
  readonly polyline: EnginePoint[] = [];
  private emitted: Dab[] = [];

  constructor(
    private readonly brush: BrushPreset,
    private readonly settings: PressureSettings,
    /**
     * Live size/opacity from the tool options bar — the brush's own base
     * values already applied by the caller (options override the preset).
     */
    private readonly sizePx: number,
    private readonly opacity: number,
    seed = 1,
  ) {
    this.rng = mulberry32(seed);
  }

  /** Feed one normalized sample; returns only the dabs it produced. */
  feed(sample: PenSample): Dab[] {
    const out: Dab[] = [];
    const tilt = Math.hypot(sample.tiltX, sample.tiltY) / 90;
    if (this.startMs === null) this.startMs = sample.timeMs;
    this.elapsedMs = sample.timeMs - this.startMs;

    if (this.lastRaw) {
      const dt = Math.max(1, sample.timeMs - this.lastRaw.timeMs);
      const d = Math.hypot(sample.x - this.lastRaw.x, sample.y - this.lastRaw.y);
      this.smoothedSpeed += (d / dt - this.smoothedSpeed) * 0.3;
    }
    this.lastRaw = sample;

    if (!this.smooth) {
      this.smooth = { x: sample.x, y: sample.y, pressure: sample.pressure, tilt, speed: 0 };
      this.polyline.push({ ...this.smooth });
      out.push(...this.dabAt(this.smooth, 0));
      return this.track(out);
    }

    // Streamline: the working point CHASES the raw input. Higher streamline =
    // slower chase = calmer line. Sub-stepped over the segment so heavy
    // smoothing doesn't lag into visible corner-cutting at slow event rates.
    const chase = 1 - 0.92 * this.brush.strokePath.streamline;
    const from = this.smooth;
    const targetX = sample.x;
    const targetY = sample.y;
    const steps = Math.max(1, Math.min(8, Math.ceil(Math.hypot(targetX - from.x, targetY - from.y) / 4)));
    for (let i = 0; i < steps; i++) {
      const prev = this.smooth!;
      const nx = prev.x + (targetX - prev.x) * chase;
      const ny = prev.y + (targetY - prev.y) * chase;
      const seg = Math.hypot(nx - prev.x, ny - prev.y);
      if (seg < 0.01) break;
      const next: EnginePoint = {
        x: nx,
        y: ny,
        pressure: sample.pressure,
        tilt,
        speed: this.smoothedSpeed,
      };
      out.push(...this.walkSegment(prev, next, seg));
      this.smooth = next;
      this.polyline.push({ ...next });
    }
    return this.track(out);
  }

  /**
   * End the stroke: emit the final dab at the resting point (so taps mark)
   * and return the full dab list for anyone who wants the whole stroke.
   */
  finish(): Dab[] {
    const out: Dab[] = [];
    if (this.smooth && this.lengthPx < this.dabSpacing(this.smooth)) {
      // A tap: one dab is already down; nothing more needed.
    }
    return this.track(out);
  }

  /** All dabs emitted so far (the committed stroke). */
  get dabs(): readonly Dab[] {
    return this.emitted;
  }

  private track(dabs: Dab[]): Dab[] {
    if (dabs.length > 0) this.emitted.push(...dabs);
    return dabs;
  }

  /** March dabs along one streamlined segment, honoring residual spacing. */
  private walkSegment(a: EnginePoint, b: EnginePoint, seg: number): Dab[] {
    const out: Dab[] = [];
    let travelled = this.residual;
    while (travelled <= seg) {
      const t = seg === 0 ? 0 : travelled / seg;
      const p: EnginePoint = {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        pressure: a.pressure + (b.pressure - a.pressure) * t,
        tilt: a.tilt + (b.tilt - a.tilt) * t,
        speed: a.speed + (b.speed - a.speed) * t,
      };
      const dir = Math.atan2(b.y - a.y, b.x - a.x);
      out.push(...this.dabAt(p, dir));
      travelled += this.dabSpacing(p);
    }
    this.residual = travelled - seg;
    this.lengthPx += seg;
    return out;
  }

  private dabSpacing(p: EnginePoint): number {
    return Math.max(0.5, this.dabSize(p) * this.brush.strokePath.spacing);
  }

  // ── Modulation ────────────────────────────────────────────────────────────

  /**
   * Resolve every mod aimed at `target` into ONE number: a multiplier for the
   * multiplicative targets, an offset for the additive ones.
   *
   * Multiplicative mods COMPOSE (a size driven by both pressure and randomness
   * scales by both), which is the only combination rule that stays sane as mods
   * are added — summing them would let two half-strength mods cancel, and
   * taking the max would make the second one free.
   */
  private modulate(target: BrushModTarget, inputs: ModInputs): number {
    const additive = !MULTIPLICATIVE.has(target);
    let acc = additive ? 0 : 1;
    for (const mod of this.brush.dynamics.mods) {
      if (mod.target !== target) continue;
      const raw = this.signal(mod, target, inputs);
      if (additive) {
        // Additive signals are CENTRED: a random hue must swing both ways, or
        // "jitter" becomes a one-directional drift.
        const centred = mod.source === "random" ? raw * 2 - 1 : raw;
        acc += mod.amount * centred * (ADDITIVE_RANGE[target] ?? 1);
      } else {
        // A negative amount inverts the signal rather than subtracting it, so
        // "thinner when fast" is the same control as "thicker when fast".
        const shaped = mod.amount < 0 ? 1 - raw : raw;
        const depth = Math.abs(mod.amount);
        acc *= Math.max(mod.floor, 1 - depth + depth * shaped);
      }
    }
    return acc;
  }

  /** One mod's 0..1 signal, conditioned and gamma-shaped. */
  private signal(mod: BrushMod, target: BrushModTarget, inputs: ModInputs): number {
    let v: number;
    switch (mod.source) {
      case "pressure": {
        const channel = pressureChannel(target);
        v = channel ? pressureResponse(inputs.pressure, this.settings[channel]) : inputs.pressure;
        break;
      }
      case "tilt":
        v = Math.min(1, inputs.tilt);
        break;
      case "velocity":
        // 3 px/ms is a brisk stroke; past that the signal is simply saturated.
        v = Math.min(1, inputs.velocity / 3);
        break;
      case "direction":
        v = (inputs.direction / (Math.PI * 2) + 1) % 1;
        break;
      case "strokeT":
        v = inputs.strokeT;
        break;
      case "time":
        v = inputs.time;
        break;
      case "random":
      default:
        v = inputs.random;
        break;
    }
    v = Math.min(1, Math.max(0, v));
    return mod.gamma === 1 ? v : Math.pow(v, mod.gamma);
  }

  /**
   * Deal one stamp from the tip's weighted source set.
   *
   * Weighted rather than uniform because a scatter of six shapes is rarely six
   * EQUAL shapes — one big leaf among five small ones is the natural authoring
   * request, and expressing it by adding the big leaf five times would be a
   * list the artist then has to maintain.
   */
  private pickVariant(random: number): number {
    const sources = this.brush.shape.sources;
    if (sources.length < 2) return 0;
    const total = sources.reduce((sum, s) => sum + Math.max(0, s.weight), 0);
    if (total <= 0) return 0;
    let roll = random * total;
    for (let i = 0; i < sources.length; i++) {
      roll -= Math.max(0, sources[i]!.weight);
      if (roll <= 0) return i;
    }
    return sources.length - 1;
  }

  /**
   * The signals for one dab. `random` is drawn ONCE here and shared by every
   * mod on this dab, so a leaf that rotates and recolours randomly stays one
   * leaf rather than a rotation of one leaf and a colour of another.
   */
  private inputsAt(p: EnginePoint, dir: number): ModInputs {
    return {
      pressure: p.pressure,
      tilt: p.tilt,
      velocity: p.speed,
      direction: dir,
      // A stroke has no known length until it ends, so `strokeT` runs against a
      // nominal one. That is the honest trade for a signal that has to be
      // correct on the FIRST dab, while the stroke is still being drawn.
      strokeT: Math.min(1, this.lengthPx / STROKE_T_LENGTH_PX),
      time: Math.min(1, this.elapsedMs / 2000),
      random: this.rng(),
    };
  }

  private dabSize(p: EnginePoint): number {
    // Spacing asks for a size before there is a direction; the mods that care
    // about direction do not drive size, so 0 is a safe stand-in.
    return Math.max(0.5, this.sizePx * this.modulate("size", this.inputsAt(p, 0)));
  }

  /** Taper multiplier from stroke-start distance (end taper is painter-side). */
  private taperIn(): number {
    const t = this.brush.strokePath.taperStartPx;
    if (t <= 0) return 1;
    return Math.min(1, this.lengthPx / t);
  }

  private dabAt(p: EnginePoint, dir: number): Dab[] {
    const sp = this.brush.strokePath;
    const shape = this.brush.shape;
    const inputs = this.inputsAt(p, dir);
    const taper = this.taperIn();

    const size = Math.max(0.5, this.sizePx * this.modulate("size", inputs)) * (0.25 + 0.75 * taper);
    const alpha =
      Math.min(1, this.opacity * this.modulate("opacity", inputs) * this.brush.dynamics.flow * this.modulate("flow", inputs)) *
      (0.4 + 0.6 * taper);

    const baseAngle =
      ((shape.angle + this.modulate("angle", inputs)) * Math.PI) / 180 + (shape.followStroke ? dir : 0);
    const roundness = Math.min(1, Math.max(0.05, shape.roundness * this.modulate("roundness", inputs)));

    let x = p.x;
    let y = p.y;
    const jitter = Math.max(0, sp.jitter + this.modulate("jitter", inputs));
    if (jitter > 0) {
      const r = jitter * size * this.rng();
      const a = this.rng() * Math.PI * 2;
      x += Math.cos(a) * r;
      y += Math.sin(a) * r;
    }
    const scatter = Math.max(0, sp.scatter + this.modulate("scatter", inputs));
    if (scatter > 0) {
      const off = (this.rng() * 2 - 1) * scatter * size;
      x += Math.cos(dir + Math.PI / 2) * off;
      y += Math.sin(dir + Math.PI / 2) * off;
    }
    return [{
      x,
      y,
      size,
      alpha,
      angle: baseAngle,
      roundness,
      // Drawn from the SAME shared random as the colour and rotation mods, so
      // one dab is one particle: the leaf that got picked is the leaf that got
      // rotated and tinted, rather than three independent decisions.
      variant: this.pickVariant(inputs.random),
      hue: this.modulate("hue", inputs),
      saturation: this.modulate("saturation", inputs),
      lightness: this.modulate("lightness", inputs),
    }];
  }
}

/**
 * Apply the END taper to a finished stroke's dabs (we only know where the
 * stroke ends once it has). Returns the indices whose size/alpha changed so
 * a painter that already stamped can re-stamp just the tail — in practice
 * painters buffer the last `taperEndPx` of dabs and stamp them on finish.
 */
export function applyEndTaper(dabs: Dab[], brush: BrushPreset): void {
  const taper = brush.strokePath.taperEndPx;
  if (taper <= 0 || dabs.length === 0) return;
  // Walk backwards accumulating distance; ease size/alpha down toward the tip.
  let acc = 0;
  for (let i = dabs.length - 1; i > 0; i--) {
    const a = dabs[i]!;
    const b = dabs[i - 1]!;
    const t = Math.min(1, acc / taper);
    const ease = t * t * (3 - 2 * t);
    a.size *= 0.15 + 0.85 * ease;
    a.alpha *= 0.3 + 0.7 * ease;
    acc += Math.hypot(a.x - b.x, a.y - b.y);
    if (acc >= taper) break;
  }
}
