import { makeRng } from "../animation/temporal";

/**
 * THE REVERB ROOM — an impulse response generated from a room you can see.
 *
 * Every parameter of the reverb card is a physical fact about a space, and this
 * file is where those facts become an IR. That is the whole design: dragging a
 * wall in the 3D room editor genuinely re-renders the response, so the picture
 * and the sound are ONE model rather than a diagram sitting next to a filter.
 *
 * Two layers, exactly as a real room has:
 *
 *  1. EARLY REFLECTIONS — discrete, and computed by the image-source method for
 *     a shoebox: mirror the source across each of the six walls and you have the
 *     first bounce off each, with its true delay (distance / speed of sound) and
 *     its true level (spherical spreading × wall absorption). This is the part
 *     the ear reads as SHAPE — a corridor and a hall of equal volume differ here
 *     and nowhere else, which is why the three dimensions are separate controls
 *     rather than one "room size" knob.
 *
 *  2. THE DIFFUSE TAIL — decaying noise, whose density comes from the room's
 *     volume, whose slope is `decaySec`, and whose top end rolls off as it
 *     decays (`damping` — soft furnishings versus tile). This is the part the
 *     ear reads as SIZE.
 *
 * Deterministic: the noise runs off the shared seeded PRNG, so preview, the
 * offline bake and the exported file convolve with bit-identical taps. A reverb
 * that re-randomised per render would make every export a different mix.
 *
 * Pure and DOM-free — it returns Float32Arrays. The web side wraps them in an
 * AudioBuffer for `ConvolverNode`; a native adapter can write them to disk.
 */

/** Metres per second, dry air at 20 °C. */
export const SPEED_OF_SOUND = 343;

/** The room + tail parameters an IR is generated from (the reverb effect's own fields). */
export interface ReverbRoom {
  widthM: number;
  heightM: number;
  lengthM: number;
  preDelayMs: number;
  decaySec: number;
  diffusion: number;
  damping: number;
  modulation: number;
  distance: number;
  erLevel: number;
  tailLevel: number;
}

/**
 * Convolution cost is linear in IR length, and a 20 s tail at 48 kHz is a
 * million taps per channel per voice. Past this the tail is inaudible under
 * anything else in the mix, so we trade the last few dB for real-time preview.
 */
const MAX_IR_SEC = 8;

/** Enclosed volume, m³ — the figure the room editor prints. */
export function roomVolumeM3(r: Pick<ReverbRoom, "widthM" | "heightM" | "lengthM">): number {
  return r.widthM * r.heightM * r.lengthM;
}

/** Total boundary area, m² — drives the Sabine estimate below. */
export function roomSurfaceM2(r: Pick<ReverbRoom, "widthM" | "heightM" | "lengthM">): number {
  const { widthM: w, heightM: h, lengthM: l } = r;
  return 2 * (w * h + w * l + h * l);
}

/**
 * The decay this room would ACTUALLY have, by Sabine's equation, at a given
 * mean absorption. Offered so the UI can propose a physically true decay when
 * the user resizes the room ("this is what a hall this size sounds like")
 * without ever overriding the number they typed — `decaySec` stays the
 * authority, this is only ever a suggestion.
 */
export function sabineDecaySec(
  r: Pick<ReverbRoom, "widthM" | "heightM" | "lengthM">,
  absorption = 0.18,
): number {
  const a = Math.min(0.99, Math.max(0.01, absorption));
  return clamp((0.161 * roomVolumeM3(r)) / (roomSurfaceM2(r) * a), 0.1, 20);
}

/** One discrete early reflection: when it arrives, how loud, and off which wall. */
export interface ReflectionTap {
  /** Arrival time relative to the direct sound, in seconds. */
  timeSec: number;
  /** Linear amplitude, already including spreading loss and absorption. */
  gain: number;
  /** −1 fully left … +1 fully right, from the reflection's arrival direction. */
  pan: number;
  /** Which boundary produced it — the room editor highlights the wall. */
  wall: "left" | "right" | "floor" | "ceiling" | "front" | "back";
}

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const dist = (a: Vec3, b: Vec3): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Where the listener and the source stand. Both sit on the room's centre line;
 * `distance` slides the source away down the length, which is what makes the
 * Distance control trade direct sound for room the way stepping back does.
 */
function placement(r: ReverbRoom): { listener: Vec3; source: Vec3 } {
  const listener: Vec3 = { x: r.widthM / 2, y: r.heightM * 0.4, z: r.lengthM * 0.15 };
  const near = 1;
  const far = Math.max(near + 0.5, r.lengthM * 0.7);
  const source: Vec3 = {
    x: r.widthM / 2,
    y: r.heightM * 0.45,
    z: listener.z + near + clamp(r.distance, 0, 1) * (far - near),
  };
  return { listener, source };
}

/**
 * First-order image sources: the six single-bounce reflections. Returned as
 * data (not baked straight into the buffer) because the room editor draws these
 * exact taps as the reflection rays and as the spikes on the decay graph — the
 * picture is generated from the same numbers the ear gets.
 */
export function earlyReflections(r: ReverbRoom): ReflectionTap[] {
  const { listener, source } = placement(r);
  const direct = Math.max(0.25, dist(listener, source));
  // Absorption raises with `damping`; the coefficient is per-bounce pressure.
  const reflect = Math.sqrt(1 - clamp(0.06 + r.damping * 0.55, 0.02, 0.95));

  const mirrors: Array<{ p: Vec3; wall: ReflectionTap["wall"]; pan: number }> = [
    { p: { ...source, x: -source.x }, wall: "left", pan: -0.8 },
    { p: { ...source, x: 2 * r.widthM - source.x }, wall: "right", pan: 0.8 },
    { p: { ...source, y: -source.y }, wall: "floor", pan: 0 },
    { p: { ...source, y: 2 * r.heightM - source.y }, wall: "ceiling", pan: 0 },
    { p: { ...source, z: -source.z }, wall: "back", pan: 0 },
    { p: { ...source, z: 2 * r.lengthM - source.z }, wall: "front", pan: 0 },
  ];

  const taps: ReflectionTap[] = [];
  for (const m of mirrors) {
    const d = dist(listener, m.p);
    // Spherical spreading, normalised against the direct path so the ER level
    // is relative to the sound you actually hear rather than to an absolute.
    const gain = (direct / d) * reflect * r.erLevel;
    taps.push({
      timeSec: (d - direct) / SPEED_OF_SOUND,
      gain: clamp(gain, 0, 4),
      pan: m.pan,
      wall: m.wall,
    });
  }
  return taps.sort((a, b) => a.timeSec - b.timeSec);
}

/** A stereo impulse response, ready to load into a convolver. */
export interface ReverbIr {
  // Pinned to `ArrayBuffer` (not the wider `ArrayBufferLike`) because that is
  // what `new Float32Array(n)` actually produces and what the Web Audio
  // `copyToChannel` signature requires. Being precise here keeps the web side
  // free of casts.
  left: Float32Array<ArrayBuffer>;
  right: Float32Array<ArrayBuffer>;
  sampleRate: number;
}

/**
 * A signature of everything the IR depends on. The audio engine regenerates the
 * response only when this changes — otherwise a keyframed dry/wet would rebuild
 * a 400 000-tap buffer on every animation frame.
 */
export function reverbIrSignature(r: ReverbRoom, sampleRate: number): string {
  return [
    r.widthM, r.heightM, r.lengthM, r.preDelayMs, r.decaySec, r.diffusion,
    r.damping, r.modulation, r.distance, r.erLevel, r.tailLevel, sampleRate,
  ]
    .map((n) => Math.round(n * 1000) / 1000)
    .join(",");
}

/**
 * Generate the room's stereo impulse response.
 *
 * The tail is VELVET NOISE at low diffusion and dense gaussian noise at high:
 * sparse signed impulses read as distinct slapback off hard parallel walls,
 * a dense carpet reads as a smooth wash, and `diffusion` crossfades between
 * them. Density also rises with room volume, because a big hall has more modes
 * — which is why a large room at low diffusion still sounds like a room and not
 * like a delay line.
 */
export function generateReverbIr(r: ReverbRoom, sampleRate: number, seed = 1): ReverbIr {
  const decay = clamp(r.decaySec, 0.05, MAX_IR_SEC);
  const preDelaySec = clamp(r.preDelayMs, 0, 500) / 1000;
  const lengthSec = Math.min(MAX_IR_SEC, preDelaySec + decay + 0.05);
  const n = Math.max(2, Math.ceil(lengthSec * sampleRate));

  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const preDelay = Math.floor(preDelaySec * sampleRate);

  // ── 1. Early reflections ───────────────────────────────────────────────────
  for (const tap of earlyReflections(r)) {
    const i = preDelay + Math.round(tap.timeSec * sampleRate);
    if (i < 0 || i >= n) continue;
    // Equal-power pan, so moving a reflection across the image never changes
    // how loud the room is overall.
    const theta = ((clamp(tap.pan, -1, 1) + 1) / 2) * (Math.PI / 2);
    left[i] = left[i]! + tap.gain * Math.cos(theta);
    right[i] = right[i]! + tap.gain * Math.sin(theta);
  }

  // ── 2. The diffuse tail ────────────────────────────────────────────────────
  // Density: modes per second, from the room's volume. A cupboard is sparse and
  // metallic; a cathedral is a continuous wash.
  const volume = roomVolumeM3(r);
  const density = clamp(0.06 + 0.9 * clamp(r.diffusion, 0, 1) + volume / 6000, 0.02, 1);
  // The tail does not start at full density — it builds as reflections multiply.
  const buildSec = clamp(0.008 + volume / 40000, 0.005, 0.12);
  // 60 dB of fall over `decay` seconds.
  const decayRate = 6.907755 / decay;

  const rngL = makeRng(seed >>> 0);
  const rngR = makeRng((seed ^ 0x9e3779b9) >>> 0);
  // One-pole lowpass state — damping darkens the tail progressively, which is
  // what a real room does and what distinguishes a hall from a plate.
  let lpL = 0;
  let lpR = 0;
  const damp = clamp(r.damping, 0, 1);
  // Modulation slowly detunes the tail so long decays never ring metallically.
  const modDepth = clamp(r.modulation, 0, 1) * 0.35;

  const tailStart = preDelay;
  for (let i = tailStart; i < n; i++) {
    const t = (i - tailStart) / sampleRate;
    const env = Math.exp(-decayRate * t) * (1 - Math.exp(-t / buildSec));
    if (env < 1e-5) continue;

    // Velvet ↔ dense: below `density` a tap fires, so low diffusion leaves
    // audible gaps between reflections and high diffusion fills them in.
    const uL = rngL();
    const uR = rngR();
    const modJitter = 1 + modDepth * Math.sin((2 * Math.PI * 0.7 * t) + i * 1e-4);
    let sL = uL < density ? (rngL() * 2 - 1) * modJitter : 0;
    let sR = uR < density ? (rngR() * 2 - 1) * modJitter : 0;

    // Progressive damping: the filter closes as the tail decays.
    const a = clamp(1 - damp * (0.25 + 0.7 * (1 - Math.exp(-t / Math.max(0.05, decay)))), 0.05, 1);
    lpL += a * (sL - lpL);
    lpR += a * (sR - lpR);
    sL = lpL;
    sR = lpR;

    const g = env * r.tailLevel;
    left[i] = left[i]! + sL * g;
    right[i] = right[i]! + sR * g;
  }

  normalizeStereo(left, right);
  return { left, right, sampleRate };
}

/**
 * Scale to a fixed RMS so the dry/wet control means the same thing in every
 * room. Without this, enlarging the room would also make it louder, and the
 * mix knob would stop being a mix.
 */
function normalizeStereo(left: Float32Array<ArrayBuffer>, right: Float32Array<ArrayBuffer>): void {
  let sum = 0;
  for (let i = 0; i < left.length; i++) sum += left[i]! * left[i]! + right[i]! * right[i]!;
  const rms = Math.sqrt(sum / (left.length * 2));
  if (rms < 1e-9) return;
  const g = 0.12 / rms;
  for (let i = 0; i < left.length; i++) {
    left[i] = left[i]! * g;
    right[i] = right[i]! * g;
  }
}
