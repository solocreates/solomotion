"use client";

import { videoStarting } from "../stage/render/media-cache";
import * as React from "react";
import {
  anchorLiveClock,
  buildSoundCues,
  compFps,
  cueLookaheadMs,
  liveClockAt,
  exactClockAdvance,
  exactClockShown,
  exactClockVerdict,
  frameStepMs,
  quantizeMsToFrame,
  resolvePlaybackScope,
  startExactClock,
  type ExactClock,
  type LiveClock,
  type SoundCue,
} from "@solomotion/core";
import type { MotionDocument, DocumentStore } from "@solomotion/core";
import { conductMedia, stopAllMedia } from "../assets/media-conductor";
import { livePlan } from "../audio/mix-state";
import { soundEngine } from "../audio/sound-engine";
import { timelineEndMs } from "../timeline/timeline-utils";
import { effectiveWorkRange } from "../timeline/work-range";
import { useSession } from "./session";
import { playbackRegime } from "../cache/cache-status";
import { lastPresented } from "../stage/render/stage-dirty";
import { activeBuild, buildAdvanced } from "../preview/prerender";
import { notePlaybackEvent } from "../cache/playback-log";

const LOOKAHEAD_MS = 160;
/**
 * Sound cues are walked per BUCKET of conduct time, once, and read from there
 * on every tick. A cue walk is a pass over the comp's whole sound tree; doing
 * it per animation frame was a third of a heavy film's playback cost. Buckets
 * partition time exactly (`buildSoundCues` is [from, to)), so a window read
 * from buckets is the same cues the walk would emit.
 */
const CUE_BUCKET_MS = 1000;

/** The master clock the live transport slaves to — see core `live-clock.ts`. */
function masterNowSec(source: LiveClock["source"]): number {
  return source === "audio" ? soundEngine.currentTime : performance.now() / 1000;
}
/** Longest one instant may take to be shown exactly before exact playback moves on. */
const EXACT_STALL_MS = 2000;

/**
 * A PAUSE LANDS ON THE LAST INSTANT SHOWN.
 *
 * Playing, the playhead runs ahead of the picture: live, it moved on during
 * the frame the stage last drew; exact, it may already hold the next instant,
 * not yet shown. Stopping there parked on a frame nobody saw — the picture
 * changed on pause, and the media held a live frame the playhead did not name.
 * The playhead goes back to the instant of the last presentation; the parked
 * render then shows that instant exactly (in exact playback, the very frame
 * that was on screen). A stop that came with a JUMP — go to start, a click on
 * the ruler — is further than a frame away and keeps its jump.
 */
function landOnShownInstant(session: ReturnType<typeof useSession.getState>, doc: MotionDocument): void {
  const p = lastPresented();
  if (!Number.isFinite(p.playheadMs)) return;
  const fps = compFps(doc, session.activeFrameId);
  const step = frameStepMs(fps);
  if (Math.abs(session.playheadMs - p.playheadMs) > step * 2) return;
  const instant = quantizeMsToFrame(p.playheadMs, fps);
  if (instant !== session.playheadMs) session.setPlayhead(instant);
}

/**
 * The playback loop. The rAF only runs while `playing` is true — a paused
 * editor schedules zero animation frames (cool CPU is a feature).
 * Sound cues are scheduled slightly ahead on the AudioContext clock so audio
 * stays sample-accurate regardless of frame jitter. Loops at the doc duration.
 */
export function usePlayback(store: DocumentStore): void {
  React.useEffect(() => {
    let raf = 0;
    let running = false;
    let lastTs: number | null = null;
    /** Conduct-time up to which cues are already scheduled (in the domain of the
     *  comp currently being conducted — the drilled comp itself, or, under parent
     *  preview, its ancestry root). */
    let scheduledUntil = 0;
    /** The comp cues were last scheduled against — a switch (drill in/out, toggling
     *  parent preview) flips the time domain, so cue scheduling resets. */
    let lastConductId: string | null = null;
    /** EXACT playback's clock (real-time playback off, or a build); null while live. */
    let exact: ExactClock | null = null;
    /** The instant the exact clock holds, and the presentation serial it was set at. */
    let exactInstant = 0;
    let exactSerial = 0;
    /** One display frame, measured — the exact clock's tick granularity. */
    let tickMs = 1000 / 60;
    /** Pingpong travel direction (+1 forward, -1 back); reset on each play. */
    let dir: 1 | -1 = 1;
    /** LIVE playback's anchor on the master clock; null = re-anchor next tick. */
    let live: LiveClock | null = null;
    /** The playhead this loop last wrote — anything else is an outside jump. */
    let lastWritten = NaN;
    /** Recent worst gap between ticks (ms), decaying — sizes the cue lookahead. */
    let tickGapMs = 0;
    let lastTickWall = 0;
    /** Cue buckets for one (document, comp) — see `CUE_BUCKET_MS`. */
    let cueDoc: MotionDocument | null = null;
    let cueComp = "";
    const cueBuckets = new Map<number, SoundCue[]>();
    const cuesIn = (doc: MotionDocument, compId: string, from: number, to: number): SoundCue[] => {
      if (doc !== cueDoc || compId !== cueComp) {
        cueDoc = doc;
        cueComp = compId;
        cueBuckets.clear();
      }
      const out: SoundCue[] = [];
      const last = Math.floor((to - 1e-6) / CUE_BUCKET_MS);
      for (let k = Math.floor(from / CUE_BUCKET_MS); k <= last; k++) {
        let bucket = cueBuckets.get(k);
        if (!bucket) {
          bucket = buildSoundCues(doc, k * CUE_BUCKET_MS, (k + 1) * CUE_BUCKET_MS, compId);
          cueBuckets.set(k, bucket);
        }
        for (const cue of bucket) if (cue.timeMs >= from && cue.timeMs < to) out.push(cue);
      }
      return out;
    };

    const tick = (ts: number) => {
      const session = useSession.getState();
      if (!session.playing) {
        running = false;
        lastTs = null;
        landOnShownInstant(session, store.getState());
        stopAllMedia();
        return; // stop scheduling frames entirely
      }
      raf = requestAnimationFrame(tick);

      const dt = lastTs === null ? 0 : ts - lastTs;
      lastTs = ts;
      if (dt > 0 && dt < 50) tickMs = tickMs * 0.9 + dt * 0.1;
      const wall = performance.now();
      if (lastTickWall > 0) tickGapMs = Math.max(wall - lastTickWall, tickGapMs * 0.95);
      lastTickWall = wall;
      const regime = playbackRegime();
      if (regime === "live") exact = null;
      else live = null;
      // PRE-ROLL: the clock waits for footage to start presenting (bounded),
      // so picture, clock and sound begin together — see `videoStarting`.
      // Live only: exact playback never plays footage free. Holding = no anchor.
      if (regime === "live" && videoStarting()) {
        live = null;
        return;
      }

      const doc = store.getState();
      // Playback bounds, in priority order:
      //  1. An active working range ([ / ] in-out points) → loop inside it.
      //  2. Otherwise the END BAR is the hard stop: the explicit per-frame
      //     duration (or, for a privately-owned nested comp, its owner clip's
      //     duration). Playback stops THERE even when a clip overflows past it
      //     — dragging the end in front of a long clip really trims playback.
      //  3. With no explicit end, stop at the content end (the last clip).
      // The timeline itself stays open/dynamic (the ruler keeps trailing room).
      const frame = doc.frames.find((f) => f.id === session.activeFrameId) ?? doc.frames[0];
      if (!frame) return;
      let loopStart = 0;
      let loopEnd = timelineEndMs(doc, frame.id);
      // A work range ([ / ]) always LOOPS inside itself. Otherwise a FLIPBOOK
      // obeys its whole-sheet loop mode at the end bar — play once (stop), loop
      // (wrap) or pingpong (bounce) — the same field kept in step with its
      // parent clip's playback loop. Ordinary comps keep looping as before
      // (their loop field isn't surfaced in the transport yet, so honouring its
      // "none" default would silently turn preview into play-once).
      const range = effectiveWorkRange(frame.id);
      const mode = range ? "loop" : frame.mode === "flipbook" ? frame.loop : "loop";
      if (range) {
        loopStart = range.startMs;
        loopEnd = range.endMs;
      }
      // ── THE CLOCK ─────────────────────────────────────────────────────────
      // LIVE: the wall clock. EXACT: one comp frame at a time, each advanced
      // only once the stage has SHOWN it exactly (see core's `exact-clock.ts`
      // — the stage says what it presented, for which playhead, and whether
      // every picture in it was the frame of its instant).
      const build = activeBuild();
      let next: number;
      /** Someone else moved the playhead while it ran (a ruler click). */
      let outsideJump = false;
      if (regime === "exact") {
        const fps = compFps(doc, frame.id);
        const step = frameStepMs(fps);
        const timing = { stepMs: step, paced: build === null, tickMs, stallMs: EXACT_STALL_MS };
        if (!exact) {
          exact = startExactClock(ts);
          exactInstant = quantizeMsToFrame(session.playheadMs, fps);
          exactSerial = lastPresented().serial;
          notePlaybackEvent("exact-start", exactInstant);
          session.setPlayhead(exactInstant);
          return;
        }
        const p = lastPresented();
        if (p.serial > exactSerial && p.faithful && Math.abs(p.playheadMs - exactInstant) < 0.5) {
          exact = exactClockShown(exact, ts);
        }
        const verdict = exactClockVerdict(exact, ts, timing);
        if (verdict === "wait") return;
        if (verdict === "stalled") notePlaybackEvent("exact-stall", exactInstant);
        exact = exactClockAdvance(exact, ts, timing);
        next = exactInstant + dir * step;
      } else {
        // THE MASTER CLOCK, read NOW — not this frame's rAF timestamp, which
        // is stale by however long the callbacks before this one ran.
        const source = soundEngine.clockRunning ? "audio" : "wall";
        outsideJump = Number.isFinite(lastWritten) && session.playheadMs !== lastWritten;
        if (!live || live.source !== source || live.dir !== dir || outsideJump) {
          live = anchorLiveClock(session.playheadMs, masterNowSec(source), source, dir);
        }
        next = liveClockAt(live, masterNowSec(live.source));
      }
      // A wrap / reflect jumps the playhead, so cue scheduling must resync.
      let jumped = false;
      if (mode === "pingpong") {
        if (next >= loopEnd) {
          next = Math.max(loopStart, 2 * loopEnd - next); // reflect off the end
          dir = -1;
        } else if (next <= loopStart) {
          next = Math.min(loopEnd, 2 * loopStart - next); // reflect off the start
          dir = 1;
          jumped = true;
        }
      } else if (next >= loopEnd) {
        if (mode === "none") {
          // Play once: park on the last frame and stop the transport.
          session.setPlayhead(Math.max(loopStart, loopEnd - 1));
          session.setPlaying(false);
          return;
        }
        next = loopStart; // loop: wrap to the top
        jumped = true;
      }
      if (regime === "exact") {
        next = quantizeMsToFrame(next, compFps(doc, frame.id));
        // A build ends past its range's end — or wraps back to the top, which
        // is the same thing — and hands over to paced playback from the top.
        if (build && buildAdvanced(next, jumped) === "done") {
          exact = null;
          return;
        }
        exactInstant = next;
        exactSerial = lastPresented().serial;
      }
      session.setPlayhead(next);
      lastWritten = useSession.getState().playheadMs;
      // A wrap or a reflect is a new anchor at the new place.
      if (jumped || (live && live.dir !== dir)) live = null;
      if (live === null && regime === "live") {
        const source = soundEngine.clockRunning ? "audio" : "wall";
        live = anchorLiveClock(lastWritten, masterNowSec(source), source, dir);
      }

      // ONE playback scope drives BOTH pipelines — this audio conductor and the
      // video renderer read `resolvePlaybackScope`, so sound and picture can
      // never disagree about which comp is authoritative or at what time. For an
      // in-place component edit it conducts the ancestry ROOT (the whole visible
      // scene sounds and moves together); otherwise it conducts the active comp
      // directly. The media inventory and cue walker recurse DOWN from the
      // conduct id, so one conduct covers every descendant's sound too.
      const scope = resolvePlaybackScope(doc, { path: session.nav.path, playheadMs: next });
      const conductId = scope.conductId;
      const conductMs = scope.conductTimeMs;

      // Switching the conducted comp flips the cue time domain — resync scheduling.
      if (conductId !== lastConductId) {
        jumped = true;
        lastConductId = conductId;
      }
      if (jumped || outsideJump) {
        // Cues queued ahead belong to where the playhead WAS.
        if (scheduledUntil > conductMs || outsideJump) soundEngine.cancelScheduledCues();
        scheduledUntil = conductMs;
      }

      // Imported audio/video follows the transport (asset-backed elements).
      conductMedia(doc, conductId, conductMs, true, session.muted);

      // Schedule audio cues in [scheduledUntil, conductMs + lookahead), scoped to
      // the comp being conducted (root under parent preview).
      if (!session.muted) {
        const from = Math.max(scheduledUntil, conductMs);
        // Far enough ahead that a slow frame finds its cues already queued.
        // …but never past the loop's end: the transport wraps there, and cues
        // beyond it would sound after the picture has gone back to the top.
        const ahead = cueLookaheadMs(LOOKAHEAD_MS, tickGapMs);
        const toEnd = dir > 0 ? loopEnd - next : ahead;
        const to = conductMs + Math.max(0, Math.min(ahead, toEnd));
        if (to > from) {
          const cues = cuesIn(doc, conductId, from, to);
          const ctxNow = soundEngine.currentTime;
          const plan = livePlan(doc, conductId);
          for (const cue of cues) {
            soundEngine.scheduleCue(cue, ctxNow + (cue.timeMs - conductMs) / 1000, {
              gain: plan.cueGain(cue),
              bus: plan.route(cue.bus),
            });
          }
          scheduledUntil = to;
        }
      } else {
        scheduledUntil = conductMs;
      }
    };

    // Start/stop the loop on play state changes.
    const unsubscribe = useSession.subscribe((state) => {
      if (state.playing && !running) {
        running = true;
        lastTs = null;
        dir = 1;
        scheduledUntil = state.playheadMs;
        lastConductId = null; // first tick resyncs cues to the conduct domain
        exact = null; // a new run starts its own clock
        live = null;
        lastTickWall = 0;
        tickGapMs = 0;
        raf = requestAnimationFrame(tick);

      }
    });

    if (useSession.getState().playing) {
      running = true;
      dir = 1;
      raf = requestAnimationFrame(tick);
    }

    return () => {
      unsubscribe();
      cancelAnimationFrame(raf);
    };
  }, [store]);
}
