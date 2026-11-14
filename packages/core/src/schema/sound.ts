import { z } from "zod";

export const soundPackIdSchema = z.enum([
  "mechanical",
  "soft",
  "vintage",
  "thock",
  "digital",
  "pop",
  // Tuned voices (v103): pitched at C, so a scale of notes is in key.
  "marimba",
  "kalimba",
  "glass",
  "pluck",
  "wood",
]);
export type SoundPackId = z.infer<typeof soundPackIdSchema>;

/**
 * A user-imported hit sound: an audio asset plus the moment INSIDE the file
 * where the action lands (the transient/peak). Cues align that moment to the
 * event's instant, so the file's attack leads in naturally.
 */
export const customSoundRefSchema = z.object({
  assetId: z.string(),
  /** The "hit point" — ms into the file where the sound strikes. */
  hitMs: z.number().min(0).default(0),
});
export type CustomSoundRef = z.infer<typeof customSoundRefSchema>;

/**
 * One recorded TAKE in a kit (v105): an imported asset, where in it the sound
 * strikes, the note it sounds, and which hits it answers. A real instrument is
 * never the same twice; a kit is several takes of it, so a stream of hits
 * moves between recordings instead of repeating one file.
 */
export const soundTakeSchema = z.object({
  assetId: z.string(),
  hitMs: z.number().min(0).default(0),
  /**
   * The note the recording sounds, in semitones from C (a D handpan note = 2,
   * the A below middle C = -3). A voice with notes retunes the take from here
   * to the scale note it plays, so a recorded instrument plays the scale.
   */
  root: z.number().min(-48).max(48).default(0),
  /** Which hits it plays: soft ones, hard ones, or any (velocity layers). */
  layer: z.enum(["any", "soft", "hard"]).default("any"),
});
export type SoundTake = z.infer<typeof soundTakeSchema>;

export const soundKitSchema = z.object({
  takes: z.array(soundTakeSchema).min(1).max(64),
});
export type SoundKit = z.infer<typeof soundKitSchema>;

/**
 * What the climax dial moves (v105). `pitch`: the notes climb (an octave at
 * full) — the v103 behaviour. `weight`: the register stays put and the build
 * is felt instead — notes damp shorter so a dense roll stays clear, a low
 * weight joins under the hits, the field widens. Real instruments want
 * `weight`: a handpan pushed two octaves up is a test tone.
 */
export const soundClimbSchema = z.enum(["pitch", "weight"]);
export type SoundClimb = z.infer<typeof soundClimbSchema>;

/**
 * The scales a sound can walk, as the semitones of one octave — the ONE table
 * (see `audio/sound-sets.ts`, which reads it by name).
 */
export const SOUND_SCALES = {
  pentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  wholeTone: [0, 2, 4, 6, 8, 10],
  fifths: [0, 7],
} as const satisfies Record<string, readonly number[]>;
export type SoundScale = keyof typeof SOUND_SCALES;
export const soundScaleSchema = z.enum(Object.keys(SOUND_SCALES) as [SoundScale, ...SoundScale[]]);

/**
 * How each firing picks its note.
 *
 * `rise` and `bounce` walk the scale in the order things fire — across EVERY
 * body that shares the sound, so a ring of balls plays one melody rather than
 * each ball muttering its own. `body` gives each body (each letter) its own
 * fixed note — the per-ball scale of the satisfying-video trick. `strength`
 * plays harder hits higher; `random` is seeded, so the take repeats.
 */
export const soundNoteOrderSchema = z.enum(["rise", "bounce", "random", "body", "strength"]);
export type SoundNoteOrder = z.infer<typeof soundNoteOrderSchema>;

/**
 * A voice played as NOTES (v103): its pitch moves along a scale, firing by
 * firing, instead of repeating one tone. `span` is how many scale steps the
 * notes cover (a pentatonic span of 5 is one octave). Null on a voice = one
 * tone, which is every voice before v103.
 */
export const soundNotesSchema = z.object({
  scale: soundScaleSchema,
  order: soundNoteOrderSchema,
  span: z.number().int().min(1).max(24),
});
export type SoundNotes = z.infer<typeof soundNotesSchema>;

/**
 * The VOICE half of a sound: what it sounds like, with no opinion about when
 * it fires. Split out from the layer so a range override can patch the timbre
 * of a hit without restating which event that hit rides.
 */
export const soundVoiceSchema = z.object({
  pack: soundPackIdSchema,
  /** When set, this custom sound plays instead of the synth pack. */
  custom: customSoundRefSchema.nullable().default(null),
  /** 0..1 base volume. */
  volume: z.number().min(0).max(1),
  /** 0..1 — how much each hit's volume/pitch is randomized. */
  randomness: z.number().min(0).max(1),
  /** Pitch multiplier, 0.5..2. */
  pitch: z.number().min(0.5).max(2),
  /** Played as notes of a scale (v103), or null for one tone. `pitch` transposes the whole scale. */
  notes: soundNotesSchema.nullable().default(null),
  /** Recorded takes played in turn (v105); wins over `custom` and the pack. */
  kit: soundKitSchema.nullable().default(null),
  /** What the climax moves (v105); absent = `pitch`, as before. */
  climb: soundClimbSchema.default("pitch"),
});
export type SoundVoice = z.infer<typeof soundVoiceSchema>;

export const partialSoundVoiceSchema = soundVoiceSchema.partial();
export type PartialSoundVoice = z.infer<typeof partialSoundVoiceSchema>;

/** The animation phases a clip can sound on — the one list every surface
 *  (the IN/OUT inspector tabs, the cue walker, capability checks) iterates. */
export const SOUND_PHASES = ["in", "out"] as const;
export type SoundPhase = (typeof SOUND_PHASES)[number];
export const soundPhaseSchema = z.enum(SOUND_PHASES);

/**
 * WHERE inside an event's span the hit lands.
 *
 * `start` and `end` are the obvious two. `peak` is the interesting one: it is
 * the instant of MAXIMUM VELOCITY of the event's easing curve, derived from
 * the curve itself (see `easingPeak`) rather than stored. That instant is what
 * an ear reads as "the moment the motion happened" — a thud on a bounce-in
 * belongs where the layer lands, not where it started moving — so `peak` is a
 * default that is usually right instead of a number dialled in per clip.
 */
export const soundAnchorSchema = z.enum(["start", "peak", "end"]);
export type SoundAnchor = z.infer<typeof soundAnchorSchema>;

/**
 * WHAT a sound rides — the discriminant that makes this system extensible.
 *
 * A new sound-bearing event (a mask reveal, a graph-driven signal, a camera
 * move) is ONE arm here plus ONE emitter in `audio/cues.ts`. It is never a new
 * field on the clip, never a new stack, and never a new inspector.
 *
 * Note what is NOT stored: for `text`, the grain (letter vs word) is read from
 * `clip.animations[phase].unit`. Storing it here would be a second copy of a
 * fact the animate tab already owns, and the two would disagree the first time
 * someone switched a clip from letters to words.
 */
export const soundTriggerSchema = z.discriminatedUnion("kind", [
  /** Once per animating text unit (letter/word). Text clips only. */
  z.object({ kind: z.literal("text") }),
  /** Once, on the whole-layer `clip.animIn` / `clip.animOut`. Any visual clip. */
  z.object({ kind: z.literal("layer") }),
  /** Once, on the cut transition attached to this clip's head/tail. */
  z.object({ kind: z.literal("transition") }),
  /**
   * Every time this BODY (`clip.physics`) starts touching something, louder
   * the harder it hits; touches slower than `minSpeed` (units/s) stay silent,
   * so what rests or rolls does not chatter. Flat comps. Phase is ignored.
   *
   * `rise` (v103) is what drives the entry's `intensity`: `keys` = its value
   * and keys alone; `hits` = it also climbs with how busy the scene is — the
   * hit rate of every body sharing this sound, scaled so the busiest moment of
   * the comp is the climax. The keyed value is then a floor, never a cap.
   */
  z.object({
    kind: z.literal("hit"),
    minSpeed: z.number().min(0).default(60),
    rise: z.enum(["keys", "hits"]).default("keys"),
  }),
]);
export type SoundTrigger = z.infer<typeof soundTriggerSchema>;
/** A trigger as written — defaults (`minSpeed`, `rise`) may be left out. */
export type SoundTriggerInput = z.input<typeof soundTriggerSchema>;
export type SoundTriggerKind = SoundTrigger["kind"];

/** Every trigger kind, in the order the inspector offers them. */
export const SOUND_TRIGGER_KINDS = ["text", "layer", "transition", "hit"] as const;

/**
 * ONE ENTRY IN A CLIP'S SOUND STACK — a voice, bound to an event, on a phase.
 *
 * The stack is a LIST OF INSTANCES, exactly like `clip.effects`, and for the
 * same reasons. One voice per phase (what this replaced) could not layer a
 * whoosh under an impact, which is how sound design actually works; it also
 * hard-coded the hit to the start of the animation, with no way to say "land
 * the thud when it settles" or "start the whoosh 80 ms early".
 *
 * Being a list of instances with stable ids is what later buys the node-board
 * projection for free: `syncSoundNodes` can materialise one card per entry the
 * way `syncEffectNodes` already does for effects, with `clip.sounds` remaining
 * the single authority and the graph staying a VIEW of it.
 */
/**
 * Declared as an interface rather than inferred, and the schema annotated with
 * it, so TypeScript writes the NAME `SoundLayer` into the emitted `.d.ts`
 * instead of re-inlining the whole object shape. `clip.sounds` sits on the base
 * clip, which is spread across every clip kind in the union — inlining it ten
 * times pushed `documentSchema`'s inferred type past the compiler's declaration
 * serialization limit (TS7056). Naming the type is the fix; it is also the
 * better public API.
 */
export interface SoundLayer extends SoundVoice {
  id: string;
  enabled: boolean;
  phase: SoundPhase;
  trigger: SoundTrigger;
  anchor: SoundAnchor;
  offsetMs: number;
  intensity: number;
}

export const soundLayerSchema: z.ZodType<SoundLayer, z.ZodTypeDef, unknown> = soundVoiceSchema.extend({
  id: z.string(),
  /** Off keeps the entry (and its tuning) while silencing it — the solo/mute
   *  affordance every stack needs so experimenting is not destructive. */
  enabled: z.boolean().default(true),
  /** Which inspector tab this entry appears under, and which half of the
   *  event it rides: `in` = entrances, `out` = exits. */
  phase: soundPhaseSchema,
  trigger: soundTriggerSchema,
  anchor: soundAnchorSchema.default("start"),
  /** Nudge applied AFTER the anchor. Negative anticipates — which is what a
   *  whoosh needs, since a sound describing a move must lead it. */
  offsetMs: z.number().default(0),
  /**
   * THE CLIMAX DIAL (v103), 0..1 and keyable at `snd.<id>.intensity`. As it
   * climbs the notes move up the scale (one octave at 1; a lone tone rises a
   * fifth), each firing gets louder and brighter, and from halfway a heavier
   * low impact joins under every hit. 0 is the voice exactly as tuned.
   */
  intensity: z.number().min(0).max(1).default(0),
});

/**
 * A range's per-entry voice override: `{ [soundLayerId]: patch }`.
 *
 * Keyed by the entry it patches rather than by phase, because the stack can
 * hold several entries on one phase and a range that wants a different click
 * for its highlighted word must say WHICH click. `enabled` rides along so a
 * range can silence one layer without deleting it.
 */
export interface PartialSoundLayer extends PartialSoundVoice {
  enabled?: boolean;
}

export const partialSoundLayerSchema: z.ZodType<PartialSoundLayer, z.ZodTypeDef, unknown> =
  partialSoundVoiceSchema.extend({ enabled: z.boolean().optional() });

/** Named for the same TS7056 reason as {@link SoundLayer} — this record rides
 *  on every style range, which rides on every text clip. */
export type RangeSoundOverrides = Record<string, PartialSoundLayer>;

export const rangeSoundOverridesSchema: z.ZodType<RangeSoundOverrides, z.ZodTypeDef, unknown> =
  z.record(z.string(), partialSoundLayerSchema);

/**
 * The whole stack as ONE named type. `clip.sounds` rides the base clip, which
 * is spread into every arm of the clip union, so the field's *schema* type is
 * written out once per clip kind in the emitted declarations. Naming it keeps
 * that ten-fold repetition to ten short names — see the note on {@link SoundLayer}.
 */
export type SoundStack = SoundLayer[];

export const soundStackSchema: z.ZodType<SoundStack, z.ZodTypeDef, unknown> = z
  .array(soundLayerSchema)
  .default([]);
