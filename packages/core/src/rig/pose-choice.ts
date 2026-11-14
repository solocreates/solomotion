import { VISEME_IDS, type VisemeId } from "@solomotion/lipsync";
import { FX_TOKEN_PREFIX, type MotionDocument, type GroupClip, type PoseSet } from "../schema";
import { mediaAssetOf } from "../speech/source";
import { clipSourceTimeAt } from "../timeline/ops";
import { readSpeechTrack } from "../speech/reader";
import { withSpeechEdit } from "../speech/feel";
import { keyPose } from "./pose-ops";
import { behaviorsChoiceAt } from "../behaviors/evaluate";
import { behaviorBlockAt, overrideBehavior } from "../behaviors/ops";
import type { PoseEnv } from "./poses";

/**
 * CHOOSING A POSE — what a person (a Face pad click) or an agent means by "show
 * this pose now", decided ONCE for every surface. It used to write a key under
 * a set something else drives, which changed nothing and said nothing.
 *
 *  - keyed set   → a key at the moment: this pose until the next key, with or
 *                  without Record (the channel is already animated — After
 *                  Effects' rule);
 *  - static set  → the resting pose everywhere, or a key with `record`;
 *  - a BEHAVIOR active there (Characters 3.0) → it is overridden for the
 *                  block under the moment: a Lip sync syllable is fixed in the
 *                  recording's own time (it travels with the voice), any other
 *                  block — a blink, a cycle's step — gets an override span in
 *                  the character's time. Regenerating keeps it;
 *  - lip-synced  → (a legacy `lipsync()` expression) a hand FIX of the syllable
 *                  under the moment, in the recording's own time;
 *  - other live  → refused with the source named, so the surface can offer
 *                  Bake to keys (`bakePoseSet`) — never a silent no-op.
 */
export type PoseChoice =
  | { kind: "keyed" }
  | { kind: "fixed"; assetId: string; viseme: VisemeId; startMs: number; endMs: number }
  | { kind: "overridden"; behaviorId: string; fromMs: number; toMs: number }
  | { kind: "live"; source: string }
  | { kind: "refused"; why: string };

/**
 * What drives a set's choice INSTEAD of its keys: the expression's source, or
 * null. An expression that builds on the channel's own value (`#value` — a
 * blink riding on whatever the eyes are keyed to) is not that: keys under it
 * still decide, so a pick keys them like on any other set.
 */
export function poseSetLiveSource(doc: MotionDocument, group: GroupClip, set: PoseSet): string | null {
  const token = group.drivers?.[`pose.${set.id}`];
  if (!token) return null;
  if (!token.startsWith(FX_TOKEN_PREFIX)) return "the node board";
  const source = doc.expressions.find((e) => e.id === token.slice(FX_TOKEN_PREFIX.length))?.source;
  if (source === undefined) return "an expression";
  return composesOverKeys(source) ? null : source;
}

/** Does this expression build on its field's own value (`#value`)? Then the keys under it still choose. */
export function composesOverKeys(source: string): boolean {
  return /#value\b/.test(source);
}

/** The voice a lip-synced set follows by name (`lipsync("Voice")`), else null. */
export function lipSyncVoiceOf(source: string): string | null {
  return /^\s*lipsync\(\s*"((?:[^"\\]|\\.)*)"\s*\)\s*$/.exec(source)?.[1] ?? null;
}

/** Choose `poseRef` on a set at comp time `compMs`. Mutates `doc` (call inside one undo step). */
export function choosePose(
  doc: MotionDocument,
  group: GroupClip,
  set: PoseSet,
  poseRef: string,
  compMs: number,
  opts: { record?: boolean; env?: PoseEnv } = {},
): PoseChoice {
  const pose = set.poses.find((p) => p.id === poseRef) ?? set.poses.find((p) => p.name.toLowerCase() === poseRef.trim().toLowerCase());
  if (!pose) return { kind: "refused", why: `${set.name} has no pose "${poseRef}".` };
  // A behavior speaking here: override its block (a syllable: fix it on the voice).
  const active = behaviorsChoiceAt(doc, group, set, compMs, opts.env ?? {});
  if (active) {
    if (active.behavior.type === "lipSync" && !active.overridden) {
      const fixed = fixSyllable(doc, group, pose.name, compMs, typeof active.behavior.voice === "string" ? active.behavior.voice : "");
      if (fixed) return fixed;
    }
    const block = behaviorBlockAt(doc, group, set, active.behavior.id, compMs, opts.env ?? {});
    const span = block ?? { fromMs: compMs - group.startMs, toMs: compMs - group.startMs + 120, pose: pose.name };
    overrideBehavior(doc, group.id, active.behavior.id, { fromMs: span.fromMs, toMs: span.toMs, pose: pose.name });
    return { kind: "overridden", behaviorId: active.behavior.id, fromMs: span.fromMs, toMs: span.toMs };
  }
  const live = poseSetLiveSource(doc, group, set);
  if (!live) {
    keyPose(doc, group.id, set.id, pose.id, compMs - group.startMs, { key: opts.record });
    return { kind: "keyed" };
  }
  const voiceName = lipSyncVoiceOf(live);
  if (voiceName === null) return { kind: "live", source: live };
  const viseme = VISEME_IDS.find((v) => v.toLowerCase() === pose.name.trim().toLowerCase());
  if (!viseme) return { kind: "refused", why: `"${pose.name}" is not a mouth shape lip sync knows.` };
  return fixSyllable(doc, group, pose.name, compMs, voiceName) ?? { kind: "refused", why: `No voice called "${voiceName}" plays here — move the playhead onto the voice to fix a mouth shape.` };
}

/**
 * A hand fix of the syllable under comp time `compMs`, on the recording in
 * its own time: the voice named (or, "", the one playing in the character's
 * comp). Null when the pose is no mouth shape or no voice plays there.
 */
function fixSyllable(doc: MotionDocument, group: GroupClip, poseName: string, compMs: number, voiceName: string): PoseChoice | null {
  const viseme = VISEME_IDS.find((v) => v.toLowerCase() === poseName.trim().toLowerCase());
  if (!viseme) return null;
  const clips = doc.tracks.flatMap((t) => t.clips);
  const plays = (c: (typeof clips)[number]) => !!mediaAssetOf(c) && compMs >= c.startMs && compMs < c.startMs + c.durationMs;
  const clip = voiceName
    ? (clips.find((c) => c.frameId === group.frameId && c.name === voiceName) ?? clips.find((c) => c.name === voiceName))
    : clips.find((c) => c.frameId === group.frameId && plays(c));
  const assetId = clip ? mediaAssetOf(clip) : null;
  if (!clip || !assetId) return null;
  const local = compMs - clip.startMs;
  if (local < 0 || local >= clip.durationMs) return null;
  const sourceMs = clipSourceTimeAt(doc, clip, local);
  const cue = readSpeechTrack(assetId)?.cues.find((c) => sourceMs >= c.startMs && sourceMs < c.endMs);
  const startMs = Math.max(0, cue ? cue.startMs : sourceMs - 40);
  const endMs = cue ? cue.endMs : sourceMs + 80;
  const asset = doc.assets.find((a) => a.id === assetId);
  if (asset) asset.speech = { engine: "auto", ...asset.speech, edits: withSpeechEdit(asset.speech?.edits, { startMs, endMs, viseme }) };
  return { kind: "fixed", assetId, viseme, startMs, endMs };
}
