/**
 * The TEMPORAL brain — the one place that answers "what random state is this
 * effect in, right now?".
 *
 * Every effect before this was a pure function of its fields: feed it the same
 * numbers and it paints the same pixels forever. That is correct for a shadow
 * and wrong for anything that is supposed to feel ALIVE — film grain, dust,
 * scratches, flicker, static, a rolling scanline. Those need a value that
 * changes over time *and* is the same every time you ask for that instant.
 *
 * Both halves matter, and the second is the one that used to be broken: the old
 * film-grain effect built one `Math.random()` tile at module load and reused it
 * for the life of the tab. So the grain never moved, and the grain you exported
 * was never the grain you approved — a fresh tile per session, invisible until
 * you re-exported and got a different file. A seeded clock kills both bugs at
 * once: `(seed, time) → state` is deterministic, so preview, scrub, export and
 * re-export are the same pixels by construction.
 *
 * The model is a FILM GATE, because that is the physical thing being emulated.
 * Real 24fps footage does not re-roll its grain 60 times a second just because
 * you are watching it on a 60Hz screen — it holds each frame's texture for
 * 1/24s and then jumps. So the clock quantizes time into STEPS, and everything
 * random is a function of the step index rather than of the raw time:
 *
 *   rate     how many times a second the texture re-rolls (24 = film gate)
 *   jitter   how irregular those boundaries are — randomness of TIME itself
 *   stutter  how often a step reuses the previous one (a sticky frame)
 *   seed     which particular universe of randomness you are in
 *
 * `phase` (0..1 through the current step) is the other half of the contract: it
 * is what lets a value MOVE smoothly between two random states instead of only
 * snapping — the difference between gate weave that glides and gate weave that
 * strobes, from the same clock.
 *
 * Pure math, no DOM, no pixels: the canvas renderer, the exporter, a future
 * WebGL/WebGPU backend and any native adapter all derive their randomness here,
 * so they cannot disagree about what frame 137 looks like.
 */

/** The four knobs every time-varying effect shares. */
export interface TemporalClock {
  /** Which universe of randomness. Change it to re-roll a look you don't like. */
  seed: number;
  /** Steps per second — how often the texture re-rolls. 24 = a film gate. */
  rate: number;
  /** 0..1 — how irregular the step boundaries are (randomness of time itself). */
  jitter: number;
  /** 0..1 — chance a step reuses the previous state (a sticky/held frame). */
  stutter: number;
}

/** Where the clock is at one instant. */
export interface TemporalStep {
  /**
   * The integer that NAMES the random state. Two instants inside one gate open
   * share an index (and therefore share every random value derived from it);
   * `stutter` makes a step deliberately borrow an earlier index.
   */
  index: number;
  /** 0..1 progress through the current step — drives smooth inter-step motion. */
  phase: number;
  /** `hash(seed, index)` — the seed to hand any per-state generator. */
  seed: number;
  /** Seconds the current step lasts (jitter makes this vary). */
  durationSec: number;
}

// ── Hashing ──────────────────────────────────────────────────────────────────
// A 32-bit integer hash (the murmur3 finalizer) over a variable number of
// inputs. Everything random in the analog effects funnels through this, so a
// state is addressable by coordinates — hash(seed, step, particleIndex, field)
// — with no arrays, no state and no allocation. That is what lets a pass
// regenerate exactly the 40 dust specks of frame 137 without storing them.

/** Mix an arbitrary tuple of integers into one uint32. */
export function hashU32(...ints: number[]): number {
  let h = 0x9e3779b9;
  for (let i = 0; i < ints.length; i++) {
    // `| 0` first so non-integer inputs (a raw seed field) fold predictably.
    h ^= ints[i]! | 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

/** A deterministic value in [0,1) for a coordinate tuple. */
export function rand01(...ints: number[]): number {
  return hashU32(...ints) / 4294967296;
}

/** A deterministic value in [-1,1) for a coordinate tuple. */
export function randSigned(...ints: number[]): number {
  return rand01(...ints) * 2 - 1;
}

/**
 * A sequential PRNG (mulberry32) for the cases where a stream reads better than
 * coordinates — generating N specks in a loop, filling a noise tile. Seeded, so
 * it is still fully deterministic; it just carries its position for you.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── The clock ────────────────────────────────────────────────────────────────

/** Salts, so two derivations from one (seed, index) can't collide. */
const SALT_BOUNDARY = 0x1b3f;
const SALT_STUTTER = 0x2c7d;
const SALT_STATE = 0x3d91;

/** Longest run of held beats. Caps the walk-back so a stutter of 1 terminates. */
const MAX_STUTTER_RUN = 8;

/**
 * Which STATE a beat shows: walk back while each beat is flagged a repeat, so a
 * run of held frames all resolve to one state — that is what "held" means.
 *
 * The cap needs care, and getting it wrong is a bug a test caught here. Walking
 * back a FIXED number of beats when the run never ends shifts the whole
 * sequence rather than freezing it: beat 10 showing state 2 and beat 11 showing
 * state 3 is a DELAY, which is the opposite of a stuck frame. So a run that
 * hits the cap snaps to a stable anchor instead, and a stutter of 1 genuinely
 * holds for MAX_STUTTER_RUN beats before it is forced to move on.
 *
 * One function, because `resolveTemporalStep` and `previousStateSeed`
 * disagreeing about this would desynchronise every smoothed value from the
 * value it is smoothing toward.
 */
function stateIndexFor(seed: number, slot: number, stutter: number): number {
  if (stutter <= 0) return slot;
  let index = slot;
  let walked = 0;
  while (walked < MAX_STUTTER_RUN && rand01(seed, index, SALT_STUTTER) < stutter) {
    index -= 1;
    walked += 1;
  }
  if (walked < MAX_STUTTER_RUN) return index;
  return slot - (((slot % MAX_STUTTER_RUN) + MAX_STUTTER_RUN) % MAX_STUTTER_RUN);
}

/**
 * Where a jittered step boundary actually falls, in step units. Each boundary
 * is displaced by a value in ±jitter/2, derived from its own index — so the
 * grid is irregular but STABLE (boundary 41 is in the same place every time you
 * ask). Keeping |offset| < 0.5 is what guarantees the sequence stays monotone,
 * which is what lets `resolveTemporalStep` find the right step by probing three
 * candidates instead of searching.
 */
function boundaryAt(seed: number, i: number, jitter: number): number {
  if (jitter <= 0) return i;
  return i + (rand01(seed, i, SALT_BOUNDARY) - 0.5) * Math.min(1, jitter);
}

/**
 * Resolve the clock at `timeSec` (the clip's LOCAL time — so an effect reads
 * the same on a trimmed, retimed or nested clip as it does on the timeline).
 */
export function resolveTemporalStep(clock: TemporalClock, timeSec: number): TemporalStep {
  const rate = Math.max(0.01, clock.rate);
  const jitter = Math.max(0, Math.min(1, clock.jitter));
  const t = timeSec * rate;

  // With |boundary offset| < 0.5 the true step is floor(t) ± 1; probe those.
  const guess = Math.floor(t);
  let slot = guess;
  for (const cand of [guess - 1, guess, guess + 1]) {
    if (t >= boundaryAt(clock.seed, cand, jitter) && t < boundaryAt(clock.seed, cand + 1, jitter)) {
      slot = cand;
      break;
    }
  }

  const start = boundaryAt(clock.seed, slot, jitter);
  const end = boundaryAt(clock.seed, slot + 1, jitter);
  const span = Math.max(1e-6, end - start);
  const phase = Math.min(1, Math.max(0, (t - start) / span));

  const index = stateIndexFor(clock.seed, slot, Math.max(0, Math.min(1, clock.stutter)));

  return {
    index,
    phase,
    seed: hashU32(clock.seed, index, SALT_STATE),
    durationSec: span / rate,
  };
}

/**
 * The state index one step BACK from `step` — the other endpoint when a value
 * glides between random states instead of snapping (gate weave, flicker ramps).
 * Derived here rather than at each call site so "previous state" means the same
 * thing everywhere, stutter included.
 */
export function previousStateSeed(clock: TemporalClock, step: TemporalStep): number {
  const index = stateIndexFor(clock.seed, step.index - 1, Math.max(0, Math.min(1, clock.stutter)));
  return hashU32(clock.seed, index, SALT_STATE);
}

/**
 * A stepped random value in [-1,1] for one named channel (`x`, `y`, `rot`…),
 * optionally EASED from the previous state's value across the step.
 *
 * `smooth` is the whole reason this helper exists: 0 gives you the honest
 * mechanical snap of a projector gate, 1 gives you a continuous drift, and the
 * dial between them is what separates "vintage" from "broken". Both come from
 * the same two random draws — no second code path, no second look to keep in
 * sync.
 */
export function steppedValue(
  clock: TemporalClock,
  step: TemporalStep,
  channel: number,
  smooth: number,
): number {
  const now = randSigned(step.seed, channel);
  if (smooth <= 0) return now;
  const prev = randSigned(previousStateSeed(clock, step), channel);
  // Smoothstep the phase so the glide eases at both ends rather than sliding
  // linearly (linear reads as a mechanical ramp, which is the look `smooth` is
  // supposed to be getting AWAY from).
  const p = step.phase;
  const eased = p * p * (3 - 2 * p);
  const t = smooth * eased + (1 - smooth); // smooth=0 → t=1 → hold the new value
  return prev + (now - prev) * t;
}

// ── Value noise / fBm ────────────────────────────────────────────────────────
// A coherent 2D field, seeded like everything else here. Used by the Noise
// effect for its pattern and by any pass that wants a smooth spatial variation
// (heat-haze displacement, VHS tape wobble) instead of per-pixel hash.

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10); // quintic — C2 continuous
}

/** Lattice value noise in [-1,1] at (x, y) for `seed`. */
export function valueNoise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = fade(x - xi);
  const yf = fade(y - yi);
  const v00 = randSigned(seed, xi, yi);
  const v10 = randSigned(seed, xi + 1, yi);
  const v01 = randSigned(seed, xi, yi + 1);
  const v11 = randSigned(seed, xi + 1, yi + 1);
  const a = v00 + (v10 - v00) * xf;
  const b = v01 + (v11 - v01) * xf;
  return a + (b - a) * yf;
}

/** How octaves are folded together — the three classic noise characters. */
export type NoiseShape = "value" | "fractal" | "turbulence" | "ridged";

export interface FbmOptions {
  octaves: number;
  /** Amplitude falloff per octave (a.k.a. persistence). Higher = rougher. */
  gain: number;
  /** Frequency growth per octave. 2 = classic. */
  lacunarity: number;
  shape: NoiseShape;
  /**
   * How far the field has travelled "through itself". Each octave is offset by
   * a DIFFERENT irrational multiple of this, so raising it slides the octaves
   * past one another and the field BOILS. Offsetting them all equally would
   * just translate the picture, which is what a drift/scroll control is for —
   * conflating the two is why so many noise effects can only ever slide.
   */
  evolve?: number;
}

/** Per-octave evolution offsets — mutually irrational so octaves never re-align. */
const EVOLVE_X = [0, 1.7548, 3.1129, 5.9713, 7.3877, 11.201, 13.617, 17.093];
const EVOLVE_Y = [0, 2.3313, 4.7791, 6.2237, 9.4409, 10.773, 14.881, 19.317];

/**
 * Fractal Brownian motion over `valueNoise2`, returning roughly [-1,1].
 * `turbulence` folds each octave through |v| (billowy smoke); `ridged` inverts
 * that (sharp crests — veins, lightning, cracked film emulsion); `value` is a
 * single octave, which is the cheap "soft blobs" case worth keeping separate.
 */
export function fbm2(x: number, y: number, seed: number, opts: FbmOptions): number {
  const ev = opts.evolve ?? 0;
  if (opts.shape === "value") return valueNoise2(x + ev * EVOLVE_X[1]!, y + ev * EVOLVE_Y[1]!, seed);
  const octaves = Math.max(1, Math.min(8, Math.round(opts.octaves)));
  const gain = Math.max(0.05, Math.min(0.95, opts.gain));
  const lac = Math.max(1.05, Math.min(4, opts.lacunarity));
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let o = 0; o < octaves; o++) {
    const v = valueNoise2(fx + ev * EVOLVE_X[o]!, fy + ev * EVOLVE_Y[o]!, seed + o * 7919);
    if (opts.shape === "turbulence") sum += Math.abs(v) * amp;
    else if (opts.shape === "ridged") sum += (1 - Math.abs(v)) * amp;
    else sum += v * amp;
    norm += amp;
    amp *= gain;
    fx *= lac;
    fy *= lac;
  }
  const avg = sum / norm;
  // turbulence/ridged live in [0,1]; remap so every shape returns the same range.
  return opts.shape === "fractal" ? avg : avg * 2 - 1;
}
