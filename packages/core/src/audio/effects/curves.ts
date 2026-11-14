/**
 * SATURATION CURVES — the transfer functions behind the Saturator card.
 *
 * A waveshaper is just a lookup: input sample in, output sample out. What makes
 * tape, a tube, a diode and a clipper sound like FOUR DEVICES rather than one
 * device at four drive settings is the SHAPE of that lookup — where it bends,
 * how sharply, and whether it treats the two halves of the waveform alike.
 * Symmetric curves generate odd harmonics (hollow, hi-fi); asymmetric ones
 * generate even harmonics too, which is the warmth people mean by "tube".
 *
 * Pure and DOM-free, so the live preview, the offline bake and the exporter
 * shape identically. The curve is also exactly what the card's transfer-function
 * graph draws — the picture is the function, not an illustration of it.
 */

export type SaturatorCharacter = "tape" | "tube" | "diode" | "hard";

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

/** The shape alone, at unit drive — input and output both in −1…1. */
function shape(character: SaturatorCharacter, x: number): number {
  switch (character) {
    // Tape: soft symmetric compression. Rounds peaks without ever hard-edging.
    case "tape":
      return Math.tanh(x);
    // Tube: asymmetric — the negative half compresses harder, which is what
    // puts even harmonics in and is why it reads as "warm" rather than "loud".
    case "tube":
      return x >= 0 ? Math.tanh(x) : Math.tanh(x * 0.72) * 0.86;
    // Diode: a sharper asymmetric knee — gritty, with a bite tape never has.
    case "diode":
      return x >= 0
        ? 1 - Math.exp(-x * 1.6)
        : -(1 - Math.exp(x * 2.6)) * 0.78;
    // Hard clip: blunt digital ceiling. Ugly on purpose, and sometimes right.
    case "hard":
      return clamp(x, -1, 1);
  }
}

/**
 * A WaveShaperNode curve for one character at one drive.
 *
 * Normalised so that full-scale in stays full-scale out: drive changes the
 * TONE, not the volume. Without this the drive knob would double as a fader and
 * every A/B comparison would be confounded by loudness — the oldest way to make
 * a worse setting sound better.
 */
export function saturationCurve(
  character: SaturatorCharacter,
  driveDb: number,
  samples = 2048,
): Float32Array<ArrayBuffer> {
  const drive = Math.pow(10, clamp(driveDb, 0, 48) / 20);
  const peak = Math.abs(shape(character, drive)) || 1;
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = clamp(shape(character, x * drive) / peak, -1, 1);
  }
  return curve;
}

/** Rebuild only when the shape actually changes — curves are 2048 floats. */
export function saturationCurveSignature(character: SaturatorCharacter, driveDb: number): string {
  return `${character}:${Math.round(driveDb * 10) / 10}`;
}

/**
 * A bitcrush curve: `bits` of resolution (2^bits levels across −1..1), after
 * `driveDb` of gain into the crush. Fractional bits move between level counts
 * smoothly, so keying the crush down is a slide, not a staircase of jumps.
 * Played WITHOUT oversampling — the aliasing is the sound.
 */
export function bitcrushCurve(bits: number, driveDb = 0, samples = 4096): Float32Array<ArrayBuffer> {
  const levels = Math.max(1, Math.pow(2, clamp(bits, 1, 16)) / 2);
  const drive = Math.pow(10, clamp(driveDb, 0, 48) / 20);
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = clamp(((i / (samples - 1)) * 2 - 1) * drive, -1, 1);
    curve[i] = clamp(Math.round(x * levels) / levels, -1, 1);
  }
  return curve;
}
