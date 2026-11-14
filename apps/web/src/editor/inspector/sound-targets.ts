import { collectContainedAudioClips, type AudioClip, type Clip, type MotionDocument } from "@solomotion/core";

/**
 * ONE headless resolver for "what real audio clips does this selection control?"
 * A directly-selected audio clip is its own leaf; a nested/component clip
 * contributes every audio clip buried inside it (recursively, via the core
 * `collectContainedAudioClips`). The unified Sound panel binds its per-voice
 * controls to these REAL leaf clips, so editing them edits the actual sound —
 * no copy, no second UI, whether the voice sits on the timeline or three comps
 * deep.
 */
export interface SoundLeaf {
  clip: AudioClip;
  /** e.g. "Scene 2 › Dialogue" — the frames walked to reach a buried voice; "" if direct. */
  path: string;
}

export function collectSoundLeaves(doc: MotionDocument, clips: Clip[]): SoundLeaf[] {
  const leaves: SoundLeaf[] = [];
  const seen = new Set<string>();
  const add = (clip: AudioClip, path: string) => {
    if (seen.has(clip.id)) return;
    seen.add(clip.id);
    leaves.push({ clip, path });
  };
  for (const c of clips) {
    if (c.kind === "audio") add(c, "");
    else if (c.kind === "nested") {
      for (const { clip, framePath } of collectContainedAudioClips(doc, c)) add(clip, framePath.join(" › "));
    }
  }
  return leaves;
}
