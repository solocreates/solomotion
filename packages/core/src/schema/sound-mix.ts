import { z } from "zod";
import { audioEffectSchema } from "./audio-effects";

/**
 * THE MIX — categories as buses, and how a comp's whole sound is held in check.
 *
 * A sound's CATEGORY used to be a closed `role` on audio clips (voice / music /
 * sfx / none) that did one thing: lock keep-pitch for voices. Every mixing tool
 * people know treats a category as a BUS instead — Premiere's Essential Sound
 * types, Fairlight's buses, a DAW's group channels: somewhere a whole family of
 * sounds meets, gets one fader, one effect chain, one ducking rule, one meter.
 * So a category is now an instance with a stable id, stored on the project,
 * and any clip routes into one. The four built-ins are ordinary instances that
 * cannot be deleted; a project adds its own ("Foley", "UI clicks", "Narrator 2").
 *
 * The route is resolved by the inventory walk (`audio/cues.ts`): a clip's own
 * `soundBus`, else the nearest nested ancestor's, else its kind's default — so
 * tagging a nested clip "Music" routes everything inside it, and a voice
 * tagged inside that still wins. The most specific tag wins.
 */

/**
 * What a category IS to the ear. The smart leveler aims each character at its
 * own loudness and measures it its own way — speech and music by integrated
 * loudness, effects by their loudest moment — which is the difference between
 * "normalize everything" (a whoosh as loud as the narrator) and a mix.
 */
export const soundCharacterSchema = z.enum(["voice", "music", "sfx", "ambience"]);
export type SoundCharacter = z.infer<typeof soundCharacterSchema>;

/** Something a rule points at: a whole category, or one clip (a nested clip = its whole sub-mix). */
export const soundTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bus"), id: z.string() }),
  z.object({ kind: z.literal("clip"), id: z.string() }),
]);
export type SoundTarget = z.infer<typeof soundTargetSchema>;

/**
 * A DUCKING rule, owned by the thing that gets quieter: "this music ducks
 * under Dialogue by 12 dB". Owned by the ducked side because that is where a
 * person reaches for it (the music is too loud under the voice), and because a
 * category or a clip can then carry any number of them.
 */
export const duckRuleSchema = z.object({
  id: z.string(),
  enabled: z.boolean().default(true),
  under: soundTargetSchema,
  /** How far down while the trigger plays, dB. */
  depthDb: z.number().min(0).max(60).default(12),
  /** How fast it gets out of the way. */
  attackMs: z.number().min(0).max(5000).default(150),
  /** How fast it comes back once the trigger stops. */
  releaseMs: z.number().min(0).max(10000).default(500),
});
export type DuckRule = z.infer<typeof duckRuleSchema>;

export const soundBusSchema = z.object({
  id: z.string(),
  name: z.string(),
  character: soundCharacterSchema,
  color: z.string(),
  /** The category fader, linear (1 = 0 dB, 4 = +12 dB). */
  volume: z.number().min(0).max(4).default(1),
  muted: z.boolean().default(false),
  solo: z.boolean().default(false),
  /** The category's own chain — the SAME effect stack a clip carries. */
  audioEffects: z.array(audioEffectSchema).default([]),
  ducking: z.array(duckRuleSchema).default([]),
  /** Loudness the leveler aims this category at, LUFS. Null = its character's. */
  targetLufs: z.number().min(-40).max(-6).nullable().default(null),
  /** A built-in category: renamable and recolourable, never deleted. */
  builtIn: z.boolean().default(false),
});
export type SoundBus = z.infer<typeof soundBusSchema>;

/**
 * THE SMART LEVELER — a comp's switch for "nothing in here is too loud, and
 * everything sits where its kind should". Measures every sound once (per
 * asset, off the main work), then sets a static trim per occurrence. It never
 * pumps: the only real-time stage is the optional speech leveler on voice
 * categories and the limiter on the master.
 */
export const levelerSchema = z.object({
  enabled: z.boolean().default(true),
  /** One target for everything, or each category to its own. */
  mode: z.enum(["all", "category"]).default("category"),
  /** 0 leaves every sound alone … 1 puts each exactly on target. */
  strength: z.number().min(0).max(1).default(0.8),
  /** Turn down what is louder than its target. */
  tameLoud: z.boolean().default(true),
  /** Turn up what is quieter than its target. Off by default: lifting raises noise too. */
  liftQuiet: z.boolean().default(false),
  /** Even out speech inside a take (a slow dialogue leveler on voice categories). */
  evenSpeech: z.boolean().default(true),
});
export type LevelerSettings = z.infer<typeof levelerSchema>;

export const limiterSchema = z.object({
  enabled: z.boolean().default(true),
  /** The master never goes past this, dBFS. */
  ceilingDb: z.number().min(-12).max(0).default(-1),
});
export type LimiterSettings = z.infer<typeof limiterSchema>;

/**
 * A comp's own mix master. It governs whenever that comp is the one being
 * played or exported — its whole tree, at any depth — the way a comp's motion
 * blur master governs its layers. A nested comp's own settings sleep while it
 * is somebody's child: a sub-mix is levelled once, by whoever plays it.
 */
export const frameSoundMixSchema = z.object({
  /** Master fader, linear. */
  volume: z.number().min(0).max(4).default(1),
  leveler: levelerSchema.default({}),
  limiter: limiterSchema.default({}),
});
export type FrameSoundMix = z.infer<typeof frameSoundMixSchema>;

/**
 * The four categories every project starts with — Premiere's Essential Sound
 * types, named for what a person hears. Ids are the old `role` values, so a
 * v85 audio clip's role becomes its route with no lookup table.
 */
export const BUILT_IN_SOUND_BUSES: readonly SoundBus[] = [
  { id: "voice", name: "Dialogue", character: "voice", color: "#7aa2ff", volume: 1, muted: false, solo: false, audioEffects: [], ducking: [], targetLufs: null, builtIn: true },
  { id: "music", name: "Music", character: "music", color: "#c792ea", volume: 1, muted: false, solo: false, audioEffects: [], ducking: [], targetLufs: null, builtIn: true },
  { id: "sfx", name: "Effects", character: "sfx", color: "#ffb86c", volume: 1, muted: false, solo: false, audioEffects: [], ducking: [], targetLufs: null, builtIn: true },
  { id: "ambience", name: "Ambience", character: "ambience", color: "#5fd3a6", volume: 1, muted: false, solo: false, audioEffects: [], ducking: [], targetLufs: null, builtIn: true },
];
