import { createId } from "../ids";
import type { KeyframeValue } from "../schema";
import type { Modulator, ModulatorShape } from "../schema/modulators";
import { MODULATOR_SHAPES } from "../schema/modulators";
import type { EffectFieldDef, EffectFieldGroupDef } from "./effect-base";
import { resolveTemporalStep, randSigned, type TemporalClock } from "./temporal";
import { switchedOn, ENABLED_FIELD } from "./activeness";

/**
 * The MODULATOR brain — one function turns a modulator record and an instant
 * into a number, and one function applies a clip's whole modulator list to a
 * value. Everything downstream (the effect field resolver, the transform
 * evaluator, the inspector's live readout, the exporter) calls these and
 * therefore cannot disagree about what a shaking layer looks like on frame 137.
 *
 * The signal maths deliberately reuses `temporal.ts` rather than growing a
 * second oscillator: `rate`, `jitter` and `stutter` mean exactly what they mean
 * on a grain card, and `phase` from `resolveTemporalStep` is what lets `smooth`
 * take every shape from stepped to continuous without a second code path.
 */

/** Pull the clock out of a modulator (identical fields, by design). */
function clockOf(m: Modulator, v: (k: keyof Modulator, base: number) => number): TemporalClock {
  return {
    seed: Math.round(v("seed", m.seed)),
    rate: Math.max(0.01, v("rate", m.rate)),
    jitter: v("jitter", m.jitter),
    stutter: v("stutter", m.stutter),
  };
}

/** Smoothstep — used everywhere a hold has to become a glide. */
function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * The raw signal in roughly −1..1, before `amount`, `offset` and `compose`.
 *
 * `smooth` is applied ONCE, here, by interpolating between the current beat's
 * value and the next one's — so it works identically for a random hold, a sine
 * and a pulse. Handling it per shape is how these things end up with four
 * subtly different definitions of "smoothness".
 */
function signalAt(shape: ModulatorShape, clock: TemporalClock, timeSec: number, opts: {
  phaseDeg: number;
  smooth: number;
  octaves: number;
  roughness: number;
  duty: number;
}): number {
  const step = resolveTemporalStep(clock, timeSec);
  const phase = opts.phaseDeg / 360;
  const smooth = Math.max(0, Math.min(1, opts.smooth));

  // Continuous shapes are functions of the beat's own position, so they read
  // raw progress; stepped shapes read the beat index. `smooth` crossfades
  // between "this beat's value" and "glide toward the next".
  const cyclePos = (step.index + step.phase + phase) % 1;

  if (shape === "wave") {
    const continuous = Math.sin((step.index + step.phase + phase) * Math.PI * 2);
    const held = Math.sin((step.index + phase) * Math.PI * 2);
    return held + (continuous - held) * smooth;
  }
  if (shape === "ramp") {
    const continuous = ((step.phase + phase) % 1) * 2 - 1;
    const held = ((phase % 1) + 1) % 1 * 2 - 1;
    return held + (continuous - held) * smooth;
  }
  if (shape === "pulse") {
    const t = ((cyclePos % 1) + 1) % 1;
    const high = t < opts.duty ? 1 : -1;
    if (smooth <= 0.001) return high;
    // Smoothing a square rounds its corners: ramp across a window that grows
    // with `smooth`, so 1 is a near-triangle and 0 is a hard gate.
    const edge = Math.max(0.001, smooth * 0.5);
    const rise = Math.min(1, t / edge);
    const fall = Math.min(1, Math.abs(t - opts.duty) / edge);
    return t < opts.duty ? -1 + 2 * ease(Math.min(rise, fall)) : 1 - 2 * ease(Math.min(fall, Math.min(1, (1 - t) / edge)));
  }

  // `wiggle` and `random` are the same generator; wiggle glides and stacks
  // octaves, random is the single-octave hard hold. Keeping them one function
  // is why switching between them never changes the character of the motion,
  // only its smoothness.
  const octaves = shape === "wiggle" ? Math.max(1, Math.min(6, Math.round(opts.octaves))) : 1;
  const gain = Math.max(0.05, Math.min(0.95, opts.roughness));
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    // Each octave runs at 2^o the rate — the classic fBm-over-time wiggle.
    const oct = o === 0 ? step : resolveTemporalStep({ ...clock, rate: clock.rate * 2 ** o, seed: clock.seed + o * 7919 }, timeSec);
    const now = randSigned(oct.seed, 101 + o);
    const next = randSigned(oct.seed + 1, 101 + o);
    sum += (now + (next - now) * ease(oct.phase) * smooth) * amp;
    norm += amp;
    amp *= gain;
  }
  return sum / norm;
}

/** Resolve one modulator's contribution at an instant, in the target's units. */
export function evaluateModulator(
  m: Modulator,
  timeSec: number,
  sampled: Record<string, KeyframeValue> = {},
): number {
  // A modulator's OWN fields are keyframable (`mod.<id>.amount`) — that is what
  // makes a shake ramp in and settle rather than running flat forever.
  const v = (k: keyof Modulator, base: number): number => {
    const keyed = sampled[modulatorPath(m.id, String(k))];
    return typeof keyed === "number" ? keyed : base;
  };
  const clock = clockOf(m, v);
  const raw = signalAt(m.shape, clock, timeSec, {
    phaseDeg: v("phase", m.phase),
    smooth: v("smooth", m.smooth),
    octaves: v("octaves", m.octaves),
    roughness: v("roughness", m.roughness),
    duty: v("duty", m.duty),
  });
  return raw * v("amount", m.amount) + v("offset", m.offset);
}

/**
 * Apply every modulator targeting `path` to a resolved value. Multiple
 * modulators on one path compose in list order, so a slow drift plus a fast
 * jitter is two records rather than a special "compound" shape.
 *
 * Returns `value` untouched when nothing targets the path — which is the case
 * for the overwhelming majority of calls, so this is a cheap guard on a hot
 * path rather than a reason to keep modulation out of the resolver.
 */
export function applyModulators(
  modulators: readonly Modulator[] | undefined,
  path: string,
  value: number,
  timeSec: number,
  sampled: Record<string, KeyframeValue> = {},
): number {
  if (!modulators || modulators.length === 0) return value;
  let out = value;
  let touched = false;
  // A modulator's own switch is keyframable like every other field of it, so
  // "the shake starts at 00:02 and stops at 00:05" is two keys rather than two
  // duplicate modulators with amplitude ramps. `switchedOn` falls back to the
  // stored flag, so an unkeyed modulator costs one map lookup.
  const on = (m: Modulator) => switchedOn(m.enabled, modulatorPath(m.id, ENABLED_FIELD), sampled);
  for (const m of modulators) {
    if (!on(m) || m.target !== path) continue;
    touched = true;
    const signal = evaluateModulator(m, timeSec, sampled);
    if (m.compose === "add") out += signal;
    else if (m.compose === "multiply") out *= signal;
    else out = signal;
  }
  if (!touched) return value;
  // Clamping is per-modulator data but conceptually belongs to the RESULT, so
  // it lands once at the end — otherwise two stacked modulators would clamp
  // each other's intermediate values and the second one's range would be a lie.
  for (const m of modulators) {
    if (!on(m) || m.target !== path) continue;
    if (m.clampMin !== null) out = Math.max(m.clampMin, out);
    if (m.clampMax !== null) out = Math.min(m.clampMax, out);
  }
  return Number.isFinite(out) ? out : value;
}

/** Is anything modulating this path right now? (Drives the field row's badge.) */
export function modulatorsFor(modulators: readonly Modulator[] | undefined, path: string): Modulator[] {
  return (modulators ?? []).filter((m) => m.target === path);
}

/** Keyframe path for a modulator's own field — mirrors `layerEffectPath`. */
export function modulatorPath(modulatorId: string, field: string): string {
  return `mod.${modulatorId}.${field}`;
}

/**
 * A fresh modulator for a target, with an amplitude guessed from the property's
 * own range. A wiggle of ±1 is invisible on a position in px and catastrophic
 * on an opacity — so the default is derived from the field metadata instead of
 * being a constant that is wrong for most fields.
 */
export function createModulator(target: string, field?: Pick<EffectFieldDef, "min" | "max">): Modulator {
  const span =
    field?.min !== undefined && field?.max !== undefined ? Math.abs(field.max - field.min) : 100;
  return {
    id: createId("mod"),
    enabled: true,
    target,
    shape: "wiggle",
    compose: "add",
    // A tenth of the field's travel: visible immediately, never destructive.
    amount: Number((span * 0.1).toPrecision(2)),
    offset: 0,
    seed: 1,
    rate: 2,
    jitter: 0,
    stutter: 0,
    phase: 0,
    smooth: 1,
    octaves: 1,
    roughness: 0.5,
    duty: 0.5,
    clampMin: field?.min ?? null,
    clampMax: field?.max ?? null,
  };
}

/** Deep-clone a modulator list with fresh ids — used when cloning a clip. */
export function cloneModulators(modulators: readonly Modulator[]): Modulator[] {
  return modulators.map((m) => ({ ...m, id: createId("mod") }));
}

/**
 * The modulator's OWN editor, declared as effect fields — so the floating
 * effect editor, the keyframe diamonds, the reset-on-double-click and the
 * preset library all work on a modulator with no bespoke UI. A modulator is
 * edited by exactly the machinery that edits an effect, because it IS the same
 * shape of thing: a named record of declared, keyframable fields.
 */
export const MODULATOR_GROUPS: EffectFieldGroupDef[] = [
  { id: "signal", label: "Signal" },
  { id: "time", label: "Time" },
  { id: "range", label: "Range", collapsed: true },
];

export const MODULATOR_FIELDS: EffectFieldDef[] = [
  {
    key: "shape",
    label: "Shape",
    kind: "select",
    group: "signal",
    options: [
      { value: "wiggle", label: "Wiggle", hint: "Organic random drift" },
      { value: "random", label: "Random", hint: "Hard sample-and-hold" },
      { value: "wave", label: "Wave", hint: "Smooth sine" },
      { value: "pulse", label: "Pulse", hint: "Square gate" },
      { value: "ramp", label: "Ramp", hint: "Sawtooth sweep" },
    ],
  },
  {
    key: "compose",
    label: "Apply",
    kind: "select",
    group: "signal",
    options: [
      { value: "add", label: "Add", hint: "Wobble around the value" },
      { value: "multiply", label: "Multiply", hint: "Scale the value" },
      { value: "replace", label: "Replace", hint: "Ignore the value" },
    ],
    hint: "Add rides on top of whatever the field (and its keyframes) already say — that is what lets you animate a value AND shake it.",
  },
  { key: "amount", label: "Amount", kind: "number", min: -1000, max: 1000, step: 0.01, group: "signal", bipolar: true, hint: "Amplitude, in the field's own units." },
  { key: "offset", label: "Offset", kind: "number", min: -1000, max: 1000, step: 0.01, group: "signal", bipolar: true, hint: "Shifts the signal — set it to the amount to turn a ±wobble into a one-sided pulse." },
  { key: "octaves", label: "Detail", kind: "number", min: 1, max: 6, step: 1, group: "signal", hint: "Layers of faster, smaller motion summed in. 1 is a lazy drift; 4 is nervous." },
  { key: "roughness", label: "Roughness", kind: "number", min: 0.05, max: 0.95, step: 0.01, group: "signal" },
  { key: "duty", label: "Duty", kind: "number", min: 0.01, max: 0.99, step: 0.01, group: "signal", hint: "Fraction of each cycle spent high — pulse only." },

  { key: "rate", label: "Rate", kind: "number", min: 0.01, max: 120, step: 0.01, unit: "hz", group: "time", hint: "Cycles per second." },
  { key: "smooth", label: "Smoothness", kind: "number", min: 0, max: 1, step: 0.01, group: "time", hint: "0 snaps from beat to beat; 1 glides. This one dial takes any shape from stepped to continuous." },
  { key: "jitter", label: "Jitter", kind: "number", min: 0, max: 1, step: 0.01, group: "time", hint: "Randomness of the beat itself." },
  { key: "stutter", label: "Stutter", kind: "number", min: 0, max: 1, step: 0.01, group: "time", hint: "Chance a beat holds the previous value." },
  { key: "phase", label: "Phase", kind: "number", min: -3600, max: 3600, step: 1, unit: "°", group: "time", bipolar: true, hint: "Offsets the cycle — give two modulators different phases so they don't lock together." },
  { key: "seed", label: "Seed", kind: "number", min: 0, max: 99999, step: 1, group: "time", hint: "Which universe of randomness." },
];

/** Runtime guard for a persisted shape string (a renamed option must not crash). */
export function isModulatorShape(v: string): v is ModulatorShape {
  return (MODULATOR_SHAPES as readonly string[]).includes(v);
}
