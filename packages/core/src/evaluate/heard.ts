import { speechGeneration } from "../speech/reader";
import { soundGeneration } from "../sound-analysis/reader";
import { depthGeneration } from "../tracking/depth/generation";

/**
 * THE GENERATION OF EVERYTHING HEARD — and seen. Speech tracks, sound
 * analyses and depth maps are derived app-side and land late; any bake that
 * read one is stale the moment it lands. One term for every derived media
 * fact, so a memo cannot key on lip sync and miss the music or the depth.
 */
export function heardGeneration(): string {
  return `${speechGeneration()}.${soundGeneration()}.${depthGeneration()}`;
}
