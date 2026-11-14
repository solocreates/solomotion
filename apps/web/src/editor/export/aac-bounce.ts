"use client";

import { parseFragmentedMp4Audio } from "@solomotion/core";
import { soundEngine } from "../audio/sound-engine";

/**
 * RECORD THE MIX THROUGH THE LIVE AUDIO GRAPH, AND READ ITS AAC BACK OUT.
 *
 * Two different failures land here, and they have one answer.
 *
 * **No WebCodecs audio encoder.** Safari shipped the WebCodecs *video*
 * interfaces in 16.4 and left `AudioEncoder` undefined until Safari 26, so on
 * every iPhone and iPad running anything older the MP4 exporter reached its
 * audio step, found no encoder, and wrote a silent file.
 *
 * **An offline bounce that renders silence.** The exporter mixes into an
 * `OfflineAudioContext` — a renderer that is *not* the one playback uses. On a
 * device where playback is audible and the export is not, that difference is
 * the whole bug, and no amount of work on the encoder downstream can fix a
 * silent buffer upstream of it.
 *
 * So this records the LIVE graph: the same context, the same scheduling, the
 * same nodes you can hear when you press play. If the app makes sound on this
 * device, this records sound on this device — there is no second renderer left
 * to disagree. `MediaRecorder` has encoded AAC on iOS since 14.3; the frames
 * come back out of its little MP4 via `parseFragmentedMp4Audio` (core) and go
 * to the same muxer the WebCodecs path feeds. The video track stays
 * frame-accurate; only the audio takes the scenic route.
 *
 * It costs one wall-clock pass, because a MediaRecorder records in real time
 * and there is no offline equivalent. For an export that already draws every
 * frame by hand, that is cheap — and it is the difference between a file with
 * sound and a file without.
 */

export interface RecordedAac {
  /** AudioSpecificConfig for the muxer's `esds`, when the encoder gave one. */
  description: Uint8Array | null;
  sampleRate: number;
  numberOfChannels: number;
  samples: Array<{ data: Uint8Array; timestampUs: number; durationUs: number }>;
}

/**
 * Why a recording did not happen — carried back so the export can SAY it. On a
 * phone or a tablet there is no console to read, so a reason that only reaches
 * `console.warn` is a reason nobody will ever see.
 */
export type RecordFailure =
  | "no-recorder"
  | "no-audio-context"
  | "context-suspended"
  | "no-data"
  | "unreadable"
  | "cancelled";

export type RecordResult = { ok: true; track: RecordedAac } | { ok: false; reason: RecordFailure };

/** The `audio/mp4` recording types worth asking for, best first. */
const AAC_MIME_TYPES = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4"] as const;

function pickAacMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return AAC_MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

/** Whether this platform can produce AAC frames this way at all. */
export function aacBounceSupported(): boolean {
  return pickAacMimeType() !== null;
}

/**
 * Schedule a mix onto a live context and record it as AAC.
 *
 * `schedule` receives the context and the node to feed, and must schedule
 * relative to `ctx.currentTime` exactly as live playback does — it IS the live
 * scheduler, called with a destination that leads to a recorder instead of to
 * the speakers.
 *
 * The context is the sound engine's on purpose, twice over: iOS only lets an
 * `AudioContext` make sound after a gesture has unlocked it, and the engine's
 * has been unlocked since the first sound the app played; and using the same
 * context as playback is what makes "if you can hear it, it records" true by
 * construction rather than by hope. It is borrowed, never closed.
 */
export async function recordMixAsAac(
  schedule: (ctx: BaseAudioContext, dest: AudioNode) => Promise<void>,
  durationMs: number,
  bitrate: number,
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void,
): Promise<RecordResult> {
  const mimeType = pickAacMimeType();
  if (!mimeType) return { ok: false, reason: "no-recorder" };
  const bus = soundEngine.mixBus();
  if (!bus) return { ok: false, reason: "no-audio-context" };
  const ctx = bus.ctx;
  if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
  if (ctx.state !== "running") return { ok: false, reason: "context-suspended" };

  // The mix goes to the RECORDER only — never to `ctx.destination`. An export
  // that plays itself out loud while it renders is a bug the user hears.
  const dest = ctx.createMediaStreamDestination();
  const master = ctx.createGain();
  master.connect(dest);

  const recorder = new MediaRecorder(dest.stream, { mimeType, audioBitsPerSecond: bitrate });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  let progressTimer: ReturnType<typeof setInterval> | undefined;
  try {
    // Scheduling BEFORE `start()` would put the mix's own lead-in ahead of the
    // first recorded sample. Start the recorder, then schedule onto the clock
    // it is already listening to.
    recorder.start(250);
    await schedule(ctx, master);
    const startedAt = performance.now();
    if (onProgress) {
      progressTimer = setInterval(
        () => onProgress(Math.min(1, (performance.now() - startedAt) / Math.max(1, durationMs))),
        100,
      );
    }
    await new Promise<void>((resolve, reject) => {
      // Wall time is the only clock a realtime recording has. The lead-in the
      // live scheduler adds is inside the window, so the tail covers it.
      const timer = setTimeout(resolve, durationMs + 350);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("Export cancelled", "AbortError"));
        },
        { once: true },
      );
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      if (recorder.state !== "inactive") recorder.stop();
      master.disconnect();
      return { ok: false, reason: "cancelled" };
    }
    throw err;
  } finally {
    if (progressTimer !== undefined) clearInterval(progressTimer);
    if (recorder.state !== "inactive") recorder.stop();
  }

  await stopped;
  master.disconnect();
  for (const track of dest.stream.getAudioTracks()) track.stop();
  if (chunks.length === 0) return { ok: false, reason: "no-data" };

  const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
  const track = parseFragmentedMp4Audio(bytes);
  if (!track || track.samples.length === 0) return { ok: false, reason: "unreadable" };
  return { ok: true, track };
}
