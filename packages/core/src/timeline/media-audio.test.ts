import { describe, expect, it } from "vitest";
import { createEmptyDocument, createVideoClip } from "../factories";
import { addClipToTrack, locateClip } from "./ops";
import { collectCompMedia } from "../audio/cues";
import {
  canRejoinAudio,
  canSeparateAudio,
  rejoinClipAudio,
  rejoinLoss,
  separateClipAudio,
} from "./media-audio";
import type { MotionDocument, AudioClip, VideoClip } from "../schema";

function docWithVideo(): { doc: MotionDocument; video: VideoClip } {
  const doc = createEmptyDocument();
  const frame = doc.frames[0]!;
  const video = createVideoClip({
    frameId: frame.id,
    assetId: "asset_1",
    name: "Interview",
    startMs: 1000,
    durationMs: 4000,
  });
  addClipToTrack(doc.tracks[0]!, video);
  return { doc, video };
}

/** Every clip in the comp, as [trackIndex, startMs, endMs] — overlap evidence. */
function lanes(doc: MotionDocument): Array<[number, number, number]> {
  return doc.tracks.flatMap((t, i) =>
    t.clips.map((c) => [i, c.startMs, c.startMs + c.durationMs] as [number, number, number]),
  );
}

describe("separateClipAudio", () => {
  it("mutes the video and carries the whole sound contract onto the audio clip", () => {
    const { doc, video } = docWithVideo();
    video.volume = 0.4;
    video.trimInMs = 250;
    video.playback = { speed: 2, loop: "loop", reverse: true, loopLengthMs: null };
    video.keepPitch = false;
    video.pitchSemitones = -3;
    video.audioEffects = [{ id: "afx_1", type: "lowpass", enabled: true, frequency: 800 } as never];

    const audioId = separateClipAudio(doc, video.id);
    expect(audioId).not.toBeNull();
    const audio = locateClip(doc, audioId!)!.clip as AudioClip;

    expect(video.muted).toBe(true);
    expect(audio.startMs).toBe(video.startMs);
    expect(audio.durationMs).toBe(video.durationMs);
    expect(audio.trimInMs).toBe(250);
    expect(audio.playback).toEqual(video.playback);
    expect(audio.gain).toBe(0.4);
    expect(audio.keepPitch).toBe(false);
    expect(audio.pitchSemitones).toBe(-3);
    expect(audio.audioEffects).toHaveLength(1);
    // The chain MOVED — leaving a copy on the muted video would double it the
    // moment the pair is rejoined.
    expect(video.audioEffects).toHaveLength(0);
    expect(audio.linkGroupId).toBe(video.linkGroupId);
    expect(audio.linkGroupId).toBeTruthy();
  });

  it("renames the level keyframes so an animated fader survives the split", () => {
    const { doc, video } = docWithVideo();
    video.keyframes = [
      { property: "volume", keys: [{ id: "k1", timeMs: 0, value: 1, easing: "linear" }] } as never,
      { property: "opacity", keys: [{ id: "k2", timeMs: 0, value: 1, easing: "linear" }] } as never,
    ];
    const audio = locateClip(doc, separateClipAudio(doc, video.id)!)!.clip as AudioClip;
    expect(audio.keyframes.map((t) => t.property)).toEqual(["gain"]);
    // Opacity is picture, so it stays with the picture; volume does not.
    expect(video.keyframes.map((t) => t.property)).toEqual(["opacity"]);
  });

  it("uses an empty lane below the video rather than overwriting a neighbour", () => {
    const { doc, video } = docWithVideo();
    // Track 2 is busy exactly where the audio would land; track 3 is free.
    const blocker = createVideoClip({
      frameId: video.frameId,
      assetId: "asset_2",
      startMs: 0,
      durationMs: 6000,
    });
    addClipToTrack(doc.tracks[1]!, blocker);
    const before = doc.tracks.length;

    const audioId = separateClipAudio(doc, video.id)!;
    expect(doc.tracks.length).toBe(before); // the free lane was reused
    expect(doc.tracks[2]!.clips.map((c) => c.id)).toEqual([audioId]);
    expect(lanes(doc)).toEqual([
      [0, 1000, 5000],
      [1, 0, 6000],
      [2, 1000, 5000],
    ]);
  });

  it("inserts a lane directly below when every lane underneath is busy", () => {
    const { doc, video } = docWithVideo();
    for (const track of doc.tracks.slice(1)) {
      addClipToTrack(
        track,
        createVideoClip({ frameId: video.frameId, assetId: "x", startMs: 0, durationMs: 9000 }),
      );
    }
    const audioId = separateClipAudio(doc, video.id)!;
    expect(doc.tracks).toHaveLength(4);
    expect(doc.tracks[1]!.clips.map((c) => c.id)).toEqual([audioId]);
    // Nothing was displaced: every pre-existing clip still owns its own span.
    expect(doc.tracks[2]!.clips).toHaveLength(1);
    expect(doc.tracks[3]!.clips).toHaveLength(1);
  });

  it("refuses a video that has already been separated", () => {
    const { doc, video } = docWithVideo();
    expect(canSeparateAudio(video)).toBe(true);
    separateClipAudio(doc, video.id);
    expect(canSeparateAudio(video)).toBe(false);
    expect(separateClipAudio(doc, video.id)).toBeNull();
  });

  it("keeps the mix inventory pointing at exactly one source of the sound", () => {
    const { doc, video } = docWithVideo();
    const before = collectCompMedia(doc, video.frameId);
    expect(before).toHaveLength(1);
    expect(before[0]!.clip.kind).toBe("video");

    separateClipAudio(doc, video.id);
    const after = collectCompMedia(doc, video.frameId);
    // Still ONE segment — the muted video drops out as the audio clip appears,
    // so separating can never double the level.
    expect(after).toHaveLength(1);
    expect(after[0]!.clip.kind).toBe("audio");
    expect(after[0]!.atMs).toBe(before[0]!.atMs);
  });
});

describe("rejoinClipAudio", () => {
  it("round-trips: separate then rejoin restores the video's own sound", () => {
    const { doc, video } = docWithVideo();
    video.volume = 0.6;
    video.keyframes = [
      { property: "volume", keys: [{ id: "k1", timeMs: 0, value: 0.2, easing: "linear" }] } as never,
    ];
    const audioId = separateClipAudio(doc, video.id)!;

    expect(rejoinClipAudio(doc, audioId)).toBe(true);
    expect(video.muted).toBe(false);
    expect(video.volume).toBe(0.6);
    expect(video.keyframes.map((t) => t.property)).toEqual(["volume"]);
    expect(video.linkGroupId).toBeNull();
    expect(locateClip(doc, audioId)).toBeNull();
    expect(collectCompMedia(doc, video.frameId)).toHaveLength(1);
  });

  it("works from either half of the pair", () => {
    const { doc, video } = docWithVideo();
    separateClipAudio(doc, video.id);
    expect(rejoinClipAudio(doc, video.id)).toBe(true);
    expect(canRejoinAudio(doc, video.id)).toBe(false);
  });

  it("names what the fold would discard instead of silently dropping it", () => {
    const { doc, video } = docWithVideo();
    const audioId = separateClipAudio(doc, video.id)!;
    const audio = locateClip(doc, audioId)!.clip as AudioClip;
    audio.fadeIn = { ...audio.fadeIn, durationMs: 500 };
    audio.audioEffects = [{ id: "afx_1", type: "lowpass", enabled: true, frequency: 800 } as never];
    expect(rejoinLoss(doc, audioId)).toEqual(["fades", "audio effects"]);
  });

  it("declines a video that was never separated", () => {
    const { doc, video } = docWithVideo();
    expect(rejoinClipAudio(doc, video.id)).toBe(false);
    expect(rejoinLoss(doc, video.id)).toEqual([]);
  });
});
