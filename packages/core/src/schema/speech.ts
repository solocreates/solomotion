import { z } from "zod";

/**
 * One HAND FIX to a recording's mouth: "from here to here it is this shape"
 * (`X` = rest), in the asset's SOURCE time. Presence is the override, absence
 * is the computed mouth — the ScopeOverlay rule.
 */
export const speechEditSchema = z.object({
  startMs: z.number().min(0),
  endMs: z.number().min(0),
  viseme: z.string().min(1),
});
export type SpeechEdit = z.infer<typeof speechEditSchema>;

/**
 * HOW A RECORDING IS HEARD FOR LIP SYNC — per ASSET, because the analysis is
 * of the sound, not of a clip: every clip of one take shares one track, one
 * set of fixes and therefore one mouth. Only DECISIONS live here; the cues are
 * derived (core `speech/`, cached app-side) and never stored.
 *
 *  - `engine`: "auto" (the host picks: a known synthesis > an alignment > the
 *    spectral listener) or an engine id.
 *  - `text`: what the recording says, when the user knows it — a script turns
 *    analysis into alignment.
 *  - `feel` / `energy`: how the mouth acts it (the only two style knobs).
 *  - `edits`: hand fixes in SOURCE time, applied after the engine's cues are
 *    cleaned. On the asset rather than a clip because a fix belongs to a
 *    syllable of the recording: it survives moving, trimming, retiming,
 *    splitting and duplicating the clip, and re-analysis with another engine.
 */
export const assetSpeechSchema = z.object({
  engine: z.string().default("auto"),
  text: z.string().max(20_000).optional(),
  /** Feel preset: natural · snappy · relaxed · mumble · shout (the kind's defaults shift). */
  feel: z.string().optional(),
  /** How wide it opens, 1 = as heard (whisper low, shout high). */
  energy: z.number().min(0).max(3).optional(),
  edits: z.array(speechEditSchema).optional(),
  /**
   * The recording's own word timings, when something already KNOWS them: a
   * TTS that timed its words (ElevenLabs), a transcript with times. Ground
   * truth the align engine starts from instead of listening. Stored on the
   * asset (not only in the browser's cache) so a template or a `.motion`
   * bundle carries an exact mouth with it. Source time, ms.
   */
  words: z
    .array(z.object({ text: z.string(), startMs: z.number().min(0), endMs: z.number().min(0) }))
    .max(20_000)
    .optional(),
});
export type AssetSpeech = z.infer<typeof assetSpeechSchema>;
