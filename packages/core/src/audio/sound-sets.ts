import { SOUND_SCALES, type SoundKit, type SoundNoteOrder, type SoundNotes, type SoundPackId, type SoundScale, type SoundTake, type SoundVoice } from "../schema";

/**
 * SOUND SETS — a voice played as notes, and the climax that moves it.
 *
 * Before v103 a voice was one tone: a ring of 256 balls was one sample fired
 * hundreds of times at one pitch, and making it musical meant hand-keying a
 * pitch per ball. Here the variation is DERIVED, per firing, from three facts
 * the inventory already knows — the order things fire in, which body fired,
 * how hard — plus one dial, `intensity`, that an agent can key ("climax at
 * 16 s") or let the scene drive (the hit rate). Live playback and the export
 * both read it through `buildSoundCues`, so the melody in the file is the one
 * you previewed.
 *
 * Pure: no WebAudio. The engine only receives the result as numbers on a cue
 * (`pitch`, `volume`, `bright`, `weight`).
 */

/** Which firing this is, as far as note choice cares. */
export interface NoteContext {
  /** Its place in the sequence of firings that share the sound (0 = first). */
  n: number;
  /** Which source fired it — a body's place among those sharing the sound, a letter's unit index. */
  member: number;
  /** 0..1, how hard (a hit's speed over its threshold; 0.5 when there is no force). */
  strength: number;
  /** The cue's own 0..1 seed. */
  seed: number;
}

/** What one firing plays, before humanisation (`cueVariation`). */
export interface NoteVoicing {
  pitch: number;
  volume: number;
  /** 0..1 — tone colour; tuned voices open up with it, the older packs ignore it. */
  bright: number;
  /** 0..1 — level of the low impact layered under the hit. */
  weight: number;
  /** 0..1 — how much shorter a recorded take rings (a `weight` climax damps a dense roll so it stays clear). */
  damp: number;
  /** The kit take this firing plays, when the voice is a kit. Its retune is already in `pitch`. */
  take?: SoundTake;
}

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/** Semitones above the root of scale step `step` (any integer; octaves wrap). */
export function scaleSemitones(scale: SoundScale, step: number): number {
  const degrees = SOUND_SCALES[scale];
  const len = degrees.length;
  const octave = Math.floor(step / len);
  return 12 * octave + degrees[step - octave * len]!;
}

/** The scale step (0..span-1) a firing plays, before the climax lifts it. */
export function noteStep(notes: Pick<SoundNotes, "order" | "span">, at: NoteContext): number {
  const span = Math.max(1, Math.round(notes.span));
  switch (notes.order) {
    case "rise":
      return at.n % span;
    case "bounce": {
      if (span === 1) return 0;
      const period = 2 * (span - 1);
      const k = at.n % period;
      return k < span ? k : period - k;
    }
    case "random":
      // Decorrelated from the seed's own use (volume/pitch humanisation).
      return Math.min(span - 1, Math.floor(((at.seed * 9301 + 0.4973) % 1) * span));
    case "body":
      return at.member % span;
    case "strength":
      return Math.min(span - 1, Math.floor(clamp01(at.strength) * span));
  }
}

/** A lone tone (no notes) rises this many semitones at full intensity — a fifth. */
const LONE_RISE_SEMITONES = 7;

/**
 * THE voicing — what one firing of `voice` plays at `intensity`. At 0 it is
 * the voice exactly as tuned (an old document sounds as it did); at 1 the
 * notes sit an octave up, the hit is 30% louder and fully bright, and the low
 * impact under it is at full weight. The weight starts at halfway, so a build
 * gains its floor only once it is clearly building.
 */
export function voiceNote(
  voice: Pick<SoundVoice, "volume" | "pitch" | "notes"> & Partial<Pick<SoundVoice, "kit" | "climb">>,
  intensity: number,
  at: NoteContext,
): NoteVoicing {
  const i = clamp01(intensity);
  // A `weight` climax never moves the register: the build is level, weight and damping.
  const climbs = voice.climb !== "weight";
  let semis: number;
  if (voice.notes) {
    const lift = climbs ? Math.round(i * SOUND_SCALES[voice.notes.scale].length) : 0;
    semis = scaleSemitones(voice.notes.scale, noteStep(voice.notes, at) + lift);
  } else {
    semis = climbs ? LONE_RISE_SEMITONES * i : 0;
  }
  const take = voice.kit ? kitTake(voice.kit, at) : undefined;
  // A recorded take sounds its own note; played as notes, it is retuned from there to the scale's.
  const retune = take && voice.notes ? -take.root : 0;
  return {
    pitch: voice.pitch * 2 ** ((semis + retune) / 12),
    volume: voice.volume * (1 + 0.3 * i),
    bright: clamp01(0.2 + 0.35 * clamp01(at.strength) + (climbs ? 0.6 * i : 0)),
    weight: i <= 0.5 ? 0 : (i - 0.5) * 2,
    damp: climbs ? 0 : i,
    ...(take && { take }),
  };
}

// ── Kits: recorded takes in turn ─────────────────────────────────────────────

/** Hits under this strength play `soft` takes, over HARD_AT `hard` ones. */
const SOFT_BELOW = 0.35;
const HARD_AT = 0.7;

/** A deterministic 0..1 from two integers. */
function mix01(a: number, b: number): number {
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/**
 * Position `n` of a ROUND ROBIN over `len` takes: every cycle of `len`
 * firings plays each take once, in a seeded shuffled order, and a cycle never
 * opens on the take the last one closed on — so no take sounds twice in a
 * row, and none is starved. Stateless (a function of `n`), so a window of the
 * comp picks exactly what the whole comp does.
 */
export function roundRobin(len: number, n: number, salt = 0): number {
  if (len <= 1) return 0;
  // Two takes can only alternate: any shuffle would sometimes play one twice across a cycle's edge.
  if (len === 2) return (n + salt) % 2;
  const order = (cycle: number) => {
    const idx = Array.from({ length: len }, (_, k) => k);
    for (let k = len - 1; k > 0; k--) {
      const j = Math.floor(mix01(cycle * 131 + k, salt) * (k + 1));
      [idx[k], idx[j]] = [idx[j]!, idx[k]!];
    }
    return idx;
  };
  const cycle = Math.floor(n / len);
  const cur = order(cycle);
  // (Swapping the first two never moves a cycle's LAST, so the cycle before is compared as drawn.)
  if (cycle > 0 && cur[0] === order(cycle - 1)[len - 1]) [cur[0], cur[1]] = [cur[1]!, cur[0]!];
  return cur[n - cycle * len]!;
}

/**
 * The take a firing plays: from the velocity layer its strength falls in (soft
 * hits from `soft` takes, hard from `hard`, `any` in both; a missing layer
 * falls back to every take), in round-robin order of the firings.
 */
export function kitTake(kit: SoundKit, at: Pick<NoteContext, "n" | "strength">): SoundTake {
  const layer = at.strength < SOFT_BELOW ? "soft" : at.strength >= HARD_AT ? "hard" : null;
  const fits = layer ? kit.takes.filter((t) => t.layer === layer || t.layer === "any") : kit.takes.filter((t) => t.layer === "any");
  const pool = fits.length ? fits : kit.takes;
  return pool[roundRobin(pool.length, at.n, pool.length)]!;
}

// ── The climax, driven by the scene ──────────────────────────────────────────

/** The trailing window a hit rate is counted over. */
export const CLIMAX_WINDOW_MS = 1000;
/** Hits per second that count as calm — nothing has built yet. */
const CALM_RATE = 2;

/**
 * How built-up a scene is at a hit rate, given the busiest rate it reaches.
 * Logarithmic, because doubling the balls should step the climax by the same
 * amount at 4 as at 128; relative to the comp's own peak, so the busiest
 * moment IS the climax with no number to tune. A scene that never gets past
 * a few hits a second never builds.
 */
export function rateIntensity(rate: number, peakRate: number): number {
  if (peakRate <= CALM_RATE * 2 || rate <= CALM_RATE) return 0;
  return clamp01(Math.log(rate / CALM_RATE) / Math.log(peakRate / CALM_RATE));
}

// ── Voice limiting ───────────────────────────────────────────────────────────

/** Firings are counted in slots this long — under the ear's ~50 ms fusion window. */
export const VOICE_SLOT_MS = 45;
/** How many firings of one sound may start per slot. 2 per 45 ms is a roll (~44/s), not mush. */
export const VOICES_PER_SLOT = 2;

/**
 * Keep the `voices` loudest firings in each `VOICE_SLOT_MS` slot, in time
 * order. Slots are absolute time, so a window of the comp thins exactly as
 * the whole comp does. The ONE limiter — a particle downpour (1 voice per
 * emitter) and a ring of 256 balls (2 per shared sound) both pass through it.
 */
export function limitVoices<T extends { ms: number; loud: number }>(items: readonly T[], voices: number): T[] {
  const out: T[] = [];
  let slot = Number.NaN;
  let held: T[] = [];
  const flush = () => {
    if (held.length > voices) held = held.sort((a, b) => b.loud - a.loud).slice(0, voices).sort((a, b) => a.ms - b.ms);
    out.push(...held);
    held = [];
  };
  for (const it of items) {
    const k = Math.floor(it.ms / VOICE_SLOT_MS);
    if (k !== slot) {
      flush();
      slot = k;
    }
    held.push(it);
  }
  flush();
  return out;
}

// ── The built-in sets ────────────────────────────────────────────────────────

/**
 * A ready-made voice-as-notes: what the Sound tab's set picker and
 * `catalog_list sound-sets` offer. Projected into the preset library as kind
 * {@link SOUND_SET_PRESET_KIND}, so a set someone tunes saves beside these.
 */
export interface SoundSet {
  id: string;
  name: string;
  group: "Melodic" | "Impacts";
  /** The voice fields it sets — timbre and notes, never level. */
  voice: { pack: SoundPackId; custom: null; notes: SoundNotes };
  /** The picker's swatch. */
  chip: [string, string];
  tags: string[];
}

const set = (id: string, name: string, group: SoundSet["group"], chip: [string, string], pack: SoundPackId, notes: SoundNotes, tags: string[]): SoundSet => ({
  id,
  name,
  group,
  voice: { pack, custom: null, notes },
  chip,
  tags,
});

const notes = (scale: SoundScale, order: SoundNoteOrder, span: number): SoundNotes => ({ scale, order, span });

/** The preset-library kind of a sound set. */
export const SOUND_SET_PRESET_KIND = "sound-set";

/** Synthesized — nothing to download, nothing in the bundle. */
export const SOUND_SETS: SoundSet[] = [
  set("marimba-climb", "Marimba climb", "Melodic", ["#f4c27a", "#b5651d"], "marimba", notes("pentatonic", "rise", 10), ["melody", "satisfying", "balls", "ring", "bounce"]),
  set("marimba-balls", "Marimba, a note per ball", "Melodic", ["#f7d9a8", "#c47a2c"], "marimba", notes("pentatonic", "body", 10), ["per ball", "satisfying", "scale"]),
  set("kalimba-drops", "Kalimba drops", "Melodic", ["#d8f0e4", "#4f9a7a"], "kalimba", notes("major", "random", 8), ["gentle", "rain", "music box"]),
  set("glass-bells", "Glass bells", "Melodic", ["#eef6ff", "#7aa6d8"], "glass", notes("wholeTone", "bounce", 8), ["dreamy", "chime", "sparkle"]),
  set("pluck-run", "Pluck run", "Melodic", ["#f3d1f0", "#9a4f94"], "pluck", notes("minorPentatonic", "rise", 10), ["guitar", "harp", "tense"]),
  set("bubble-pops", "Bubble pops", "Melodic", ["#d6f3ff", "#3aa0d8"], "pop", notes("major", "strength", 7), ["pop", "bubbles", "playful"]),
  set("wood-knocks", "Wood knocks", "Impacts", ["#e8cfa8", "#7a5230"], "wood", notes("pentatonic", "strength", 5), ["knock", "block", "domino", "soft to hard"]),
  set("thock-impacts", "Thock impacts", "Impacts", ["#c9c9d1", "#45454f"], "thock", notes("fifths", "strength", 3), ["thud", "heavy", "soft to hard"]),
];

/**
 * A short phrase that shows what a voice does — the Sound tab's preview. Eight
 * firings a fifth of a second apart, as many bodies in turn, with the climax
 * at `intensity` (or rising across the phrase when `intensity` is "build").
 */
export function auditionPhrase(voice: Pick<SoundVoice, "volume" | "pitch" | "notes"> & Partial<Pick<SoundVoice, "kit" | "climb">>, intensity: number | "build"): Array<{ atMs: number } & NoteVoicing> {
  const count = 8;
  return Array.from({ length: count }, (_, n) => ({
    atMs: n * 190,
    ...voiceNote(voice, intensity === "build" ? n / (count - 1) : intensity, { n, member: n, strength: 0.4 + 0.6 * (((n * 37) % 11) / 10), seed: ((n + 1) * 0.618) % 1 }),
  }));
}
