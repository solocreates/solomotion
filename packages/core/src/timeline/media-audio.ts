import { createAssetAudioClip, createCarrierTrack } from "../factories";
import type { MotionDocument, AudioClip, Clip, Track, VideoClip } from "../schema";
import { addClipToTrack, fitsInTrack, locateClip, removeClipFromTrack } from "./ops";
import { linkClips, unlinkClips } from "./links";

/**
 * SEPARATE AND REJOIN A VIDEO'S SOUND.
 *
 * An imported video arrives as ONE clip carrying its own soundtrack — the
 * modern convention (Final Cut, CapCut, Premiere's linked clip), and the right
 * default, because most footage is cut picture-first and a second lane you did
 * not ask for is two things to keep in sync by hand.
 *
 * The moment you want to treat the sound as sound — duck it under a voiceover,
 * fade it, EQ it, keep it while the picture is replaced — you separate it, and
 * it becomes a real audio clip on its own lane with the full audio pipeline
 * behind it. Separate and Rejoin are exact inverses, so there is a way in and a
 * way out, and nothing is destroyed by taking either.
 *
 * Both live here, headless, because the timeline menu, a shortcut, a plugin and
 * a future drop-modifier must all get the same answer.
 */

/**
 * WHERE THE DETACHED AUDIO LANDS — the rule that stops a separation from
 * eating a neighbour.
 *
 * Search DOWNWARD from the video's own lane for the first unlocked track with
 * room at this time; if none has room, insert a fresh lane directly BELOW the
 * video. Downward because audio lives under picture in every editor there has
 * ever been, and "first with room" because a project that already has an empty
 * A1 should use it rather than growing a new lane per clip.
 *
 * It never overwrites, and it never has to: an insert is always available.
 */
function laneForDetachedAudio(doc: MotionDocument, videoTrackIndex: number, clip: Clip): Track {
  for (let i = videoTrackIndex + 1; i < doc.tracks.length; i++) {
    const track = doc.tracks[i]!;
    if (track.locked) continue;
    if (fitsInTrack(track, null, clip.startMs, clip.durationMs, clip.frameId)) return track;
  }
  const carrier = createCarrierTrack(undefined, clip.frameId);
  doc.tracks.splice(videoTrackIndex + 1, 0, carrier);
  return carrier;
}

/** Can this clip's sound be separated? A video that still owns its own audio. */
export function canSeparateAudio(clip: Clip): clip is VideoClip {
  return clip.kind === "video" && !clip.muted;
}

/**
 * The audio clip that was separated FROM this video — the same asset, linked,
 * in the same comp. Drives the "Rejoin" verb, and is the reason rejoining can
 * be exact rather than a guess.
 */
function separatedAudioOf(doc: MotionDocument, clip: Clip): AudioClip | null {
  if (clip.kind !== "video" || !clip.muted || !clip.linkGroupId) return null;
  for (const track of doc.tracks) {
    for (const other of track.clips) {
      if (other.kind !== "audio" || other.linkGroupId !== clip.linkGroupId) continue;
      if (other.source.type !== "asset" || other.source.assetId !== clip.assetId) continue;
      if (other.frameId !== clip.frameId) continue;
      return other;
    }
  }
  return null;
}

/**
 * Split a video's sound onto its own audio clip. The video keeps the picture
 * and goes muted; the audio clip inherits everything that describes how the
 * sound plays — trim, speed/loop/reverse, pitch handling, level, and the whole
 * effect chain — so the mix is identical the instant after the split as it was
 * the instant before. The two are LINKED, so they still move, trim and delete
 * as one unless you unlink them.
 *
 * `volume` becomes `gain`, and any keyframes on `volume` become keyframes on
 * `gain`: they are the same fader wearing the two names the two clip kinds
 * give it, and re-baselining them here is what makes an animated level survive
 * the separation instead of snapping to a constant.
 *
 * Returns the new audio clip's id, or null when there was nothing to separate.
 */
export function separateClipAudio(doc: MotionDocument, clipId: string): string | null {
  const loc = locateClip(doc, clipId);
  if (!loc || !canSeparateAudio(loc.clip)) return null;
  const video = loc.clip;

  const audio = createAssetAudioClip({
    frameId: video.frameId,
    assetId: video.assetId,
    name: `${video.name} · audio`,
    startMs: video.startMs,
    durationMs: video.durationMs,
  });
  audio.trimInMs = video.trimInMs;
  audio.playback = { ...video.playback };
  audio.gain = video.volume;
  audio.keepPitch = video.keepPitch;
  audio.pitchSemitones = video.pitchSemitones;
  audio.fillDuration = video.fillDuration;
  audio.audioMix = { ...video.audioMix };
  audio.audioEffects = video.audioEffects.map((e) => structuredClone(e));
  audio.keyframes = video.keyframes
    .filter((track) => track.property === "volume")
    .map((track) => structuredClone({ ...track, property: "gain" }));

  // The video keeps the picture only. Its own sound settings stay on it (so a
  // rejoin restores them), but nothing reads them while it is muted.
  video.muted = true;
  video.audioEffects = [];
  video.keyframes = video.keyframes.filter((track) => track.property !== "volume");

  addClipToTrack(laneForDetachedAudio(doc, loc.trackIndex, audio), audio);
  linkClips(doc, [video.id, audio.id]);
  return audio.id;
}

/**
 * The inverse: fold a separated audio clip back into its video. The video's
 * fader takes the audio clip's level back (including its keyframes), the audio
 * clip is removed, and the pair is unlinked because there is no longer a pair.
 *
 * Called with EITHER half — a menu built on a selection should not have to know
 * which one the user right-clicked.
 *
 * What cannot survive is stated rather than hidden: fades and audio effects
 * belong to the audio clip's richer model and are dropped, so `rejoinLoss`
 * lets a surface say so before it happens.
 */
export function rejoinClipAudio(doc: MotionDocument, clipId: string): boolean {
  const pair = locateSeparatedPair(doc, clipId);
  if (!pair) return false;
  const { video, audio } = pair;

  video.muted = false;
  video.volume = Math.min(1, Math.max(0, audio.gain));
  video.keepPitch = audio.keepPitch;
  video.pitchSemitones = audio.pitchSemitones;
  video.keyframes = [
    ...video.keyframes.filter((track) => track.property !== "volume"),
    ...audio.keyframes
      .filter((track) => track.property === "gain")
      .map((track) => structuredClone({ ...track, property: "volume" })),
  ];

  const loc = locateClip(doc, audio.id);
  if (loc) removeClipFromTrack(loc.track, loc.clipIndex);
  unlinkClips(doc, [video.id]);
  return true;
}

/**
 * Is this clip — EITHER half — one of a separated pair? The predicate the
 * "Rejoin audio" verb is offered on, so the menu and the op can never disagree
 * about whether there is anything to rejoin.
 */
export function canRejoinAudio(doc: MotionDocument, clipId: string): boolean {
  return locateSeparatedPair(doc, clipId) !== null;
}

/**
 * What a rejoin would discard. A video's fader is one number and a keyframe
 * track; an audio clip is that plus fades, an effect chain and a role. Naming
 * the difference is cheaper than surprising someone with it.
 */
export function rejoinLoss(doc: MotionDocument, clipId: string): string[] {
  const pair = locateSeparatedPair(doc, clipId);
  if (!pair) return [];
  const lost: string[] = [];
  if (pair.audio.fadeIn.durationMs > 0 || pair.audio.fadeOut.durationMs > 0) lost.push("fades");
  if (pair.audio.audioEffects.length > 0) lost.push("audio effects");
  return lost;
}

/** Resolve either half of a separated pair to both halves. */
function locateSeparatedPair(
  doc: MotionDocument,
  clipId: string,
): { video: VideoClip; audio: AudioClip } | null {
  const clip = locateClip(doc, clipId)?.clip;
  if (!clip) return null;
  if (clip.kind === "video") {
    const audio = separatedAudioOf(doc, clip);
    return audio ? { video: clip, audio } : null;
  }
  if (clip.kind !== "audio" || !clip.linkGroupId || clip.source.type !== "asset") return null;
  for (const track of doc.tracks) {
    for (const other of track.clips) {
      if (other.kind !== "video" || other.linkGroupId !== clip.linkGroupId) continue;
      if (other.assetId !== clip.source.assetId || other.frameId !== clip.frameId) continue;
      return { video: other, audio: clip };
    }
  }
  return null;
}
