import type { Asset } from "../schema";

/**
 * Speech tracks are the lipsync package's `SpeechTrack` (re-exported here):
 * cues in SOURCE ms — from the start of the asset, before any clip's trim,
 * speed, loop or reverse. That is what makes one track serve every clip of a
 * recording, and what makes moving or retiming a clip re-sync with no
 * re-analysis: the clip's own time map does the rest (`speech/source.ts`).
 */
export type { SpeechTrack, VisemeCue as SpeechCue } from "@solomotion/lipsync";

/** The resting mouth — what every read answers while nothing is being said. */
export const REST_VISEME = "X";

/**
 * Where a media layer is in its recording at one instant, from the ONE
 * source-time map. `asset` is the record it plays (engine choice, hand fixes).
 */
export interface MediaPosition {
  assetId: string;
  sourceMs: number;
  asset?: Asset;
}
