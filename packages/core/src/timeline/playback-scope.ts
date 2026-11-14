import type { MotionDocument } from "../schema";
import { resolveEditContext, type EditContext, type EditPath } from "../navigation";

/**
 * THE single source of truth for "which frames advance during playback, at what
 * time, and which one drives audio". Both playback pipelines read it — the audio
 * conductor (`use-playback`) and the video renderer (`Stage`) — so the picture
 * and the sound can NEVER disagree about a frame's current time.
 *
 * It is now a thin projection of the navigation context, which already answers
 * every question it needs: which frames are on the path, what time each of them
 * sits at, and which one actually paints the pixels (always the root — you edit
 * where the instance is). Before that context existed this file re-derived all
 * of it with its own rules — and a second copy of the same derivation lived in
 * the stage, which is how "the music plays but the picture is frozen" kept
 * coming back.
 */

export interface PlaybackScope {
  /** The frame whose LOCAL timeline the transport advances (the active comp). */
  authorityFrameId: string;
  /** Every frame that ADVANCES this instant → its live time (frameId → ms). A
   *  frame absent here is frozen at its poster (t = 0). */
  liveTimes: Map<string, number>;
  /** The comp whose media/audio is conducted — the ancestry root, so the whole
   *  visible scene sounds. */
  conductId: string;
  conductTimeMs: number;
  mode: "flat" | "inplace";
}

export interface PlaybackNav {
  path: EditPath;
  playheadMs: number;
}

/** Derive the transport scope from an already-resolved context. */
export function playbackScopeOf(ctx: EditContext): PlaybackScope {
  // The whole chain advances: the target's picture is painted THROUGH its
  // ancestors, so freezing them would freeze the image you are editing while
  // its sound kept running.
  const liveTimes = new Map<string, number>(ctx.frameTimes);
  return {
    authorityFrameId: ctx.target.id,
    liveTimes,
    conductId: ctx.conductFrameId,
    conductTimeMs: ctx.conductTimeMs,
    mode: ctx.depth === 0 ? "flat" : "inplace",
  };
}

export function resolvePlaybackScope(doc: MotionDocument, nav: PlaybackNav): PlaybackScope {
  const ctx = resolveEditContext(doc, nav.path, nav.playheadMs);
  if (ctx) return playbackScopeOf(ctx);
  // No path (or no frames at all): the first frame advances, or nothing does.
  const fallback = doc.frames[0]?.id ?? "";
  return {
    authorityFrameId: fallback,
    liveTimes: new Map([[fallback, nav.playheadMs]]),
    conductId: fallback,
    conductTimeMs: nav.playheadMs,
    mode: "flat",
  };
}
