"use client";

import { clipLocalTime, collectCompMedia, duckGainAt, videoVolumeAt, type MotionDocument, type MediaAudioSegment } from "@solomotion/core";
import { soundEngine } from "../audio/sound-engine";
import { livePlan } from "../audio/mix-state";
import { getVideoForClip, pauseAllVideoElements, pruneVideoElements } from "../stage/render/media-cache";
import { conductAllAudio, stopAllAudioVoices } from "../audio/audio-voices";

/**
 * The media conductor — makes imported media FOLLOW the transport each tick.
 *
 * ALL audio (top-level AND buried in nested comps, at ANY depth) goes through
 * the ONE unified segment engine (`conductAllAudio`), driven by the headless
 * `collectCompMedia` inventory — so every clip's EQ / pitch / keep-pitch /
 * reverse composes on top of its ancestors like a node graph. Video is the only
 * thing handled here directly: its frames are the render path's job, so the
 * conductor just rules audibility and pauses elements whose clips left the
 * playhead (a video's OWN soundtrack rides its element; the audio pipeline owns
 * everything else).
 */
export function conductMedia(
  doc: MotionDocument,
  compId: string,
  playheadMs: number,
  playing: boolean,
  muted: boolean,
): void {
  const liveClipIds = new Set<string>();
  const mix = soundEngine.mixBus();
  const plan = mix ? livePlan(doc, compId) : null;
  const segs = new Map<string, MediaAudioSegment>();
  if (plan) for (const seg of collectCompMedia(doc, compId)) if (seg.clip.kind === "video" && seg.path.length === 0) segs.set(seg.clip.id, seg);
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      liveClipIds.add(clip.id);
      if (clip.kind !== "video") continue;
      const local = clipLocalTime(clip, playheadMs);
      const inComp = clip.frameId === compId;
      const active = playing && inComp && local !== null && !track.muted && !muted;
      const el = getVideoForClip(clip.id, clip.assetId);
      if (!el) continue;
      const audible = active && !clip.muted;
      el.muted = !audible;
      el.preservesPitch = clip.keepPitch;
      const level = videoVolumeAt(clip, local ?? 0);
      const seg = segs.get(clip.id);
      if (mix && plan && seg) {
        // Through the MIX like every other sound: its category, the leveler's
        // trim, its ducks — and so onto the meters.
        const voice = videoVoice(el, mix.ctx);
        if (voice) {
          el.volume = 1;
          const dest = mix.graph.input(plan.route(seg.bus));
          if (voice.dest !== dest) {
            voice.gain.disconnect();
            voice.gain.connect(dest);
            voice.dest = dest;
          }
          const g = level * seg.gainScale * plan.segmentTrim(seg) * duckGainAt(plan.segmentDuck(seg), playheadMs);
          voice.gain.gain.setTargetAtTime(Math.max(0, g), mix.ctx.currentTime, 0.03);
          continue;
        }
      }
      el.volume = level;
      // Bound to the mix earlier but out of the plan now (volume taken to 0):
      // its only way out is that gain, so close it.
      const bound = videoVoices.get(el);
      if (bound && mix) bound.gain.gain.setTargetAtTime(0, mix.ctx.currentTime, 0.03);
      // NB: the conductor rules AUDIBILITY only. Element play/pause/seek is owned
      // SOLELY by the video pipeline (`syncVideoFrames`/`conductEntry`), which is
      // nested-aware. This conductor's view is FLAT (`inComp`/root-playhead
      // `local`), so pausing here paused every NESTED video's element each tick —
      // fighting the pipeline's play() → AbortError → nested videos never rolled.
      // Off-screen elements are parked by the pipeline (`pauseUnconductedElements`).
    }
  }
  pruneVideoElements(liveClipIds);
  conductAllAudio(doc, compId, playheadMs, playing, muted);
}

/**
 * A video element's route into the mix. An element binds to ONE
 * MediaElementAudioSourceNode for life (a second throws), so it is made once
 * and kept beside the element; after that the element's sound only reaches
 * the speakers through this gain.
 */
const videoVoices = new WeakMap<HTMLVideoElement, { gain: GainNode; dest: AudioNode | null }>();
function videoVoice(el: HTMLVideoElement, ctx: AudioContext): { gain: GainNode; dest: AudioNode | null } | null {
  let v = videoVoices.get(el);
  if (v) return v;
  try {
    const source = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    source.connect(gain);
    v = { gain, dest: null };
    videoVoices.set(el, v);
    return v;
  } catch {
    return null; // already bound elsewhere, or not routable — it plays direct
  }
}

/** Transport stopped — everything goes quiet. */
export function stopAllMedia(): void {
  soundEngine.cancelScheduledCues();
  stopAllAudioVoices();
  pauseAllVideoElements();
}
