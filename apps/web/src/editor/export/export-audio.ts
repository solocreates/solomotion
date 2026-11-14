"use client";

import {
  audioChainSignature,
  audioEffectsAt,
  buildMixPlan,
  buildSoundCues,
  duckGainAt,
  collectCompMedia,
  hasGainAutomation,
  integratedLoudness,
  measureLoudnessTable,
  sampleGainEnvelope,
  segmentClipLocalMs,
  segmentCrossfadeAt,
  segmentHasCrossfade,
  videoVolumeAt,
  type DuckCurve,
  type MediaAudioSegment,
  type MixPlan,
  type MotionDocument,
} from "@solomotion/core";
import { MixGraph } from "../audio/mix-graph";
import { loudnessSource, measureAll } from "../audio/loudness-cache";
import { playCue } from "../audio/sound-engine";
import { getAssetBlob } from "../assets/asset-store";
import { buildAudioChain } from "../audio/audio-effect-chain";
import { ensureSpecBakeAsync, segmentBakeSpec, specIsHeavy } from "../audio/audio-bake";

function scheduleOrigin(ctx: BaseAudioContext): number {
  return ctx.currentTime + (isOffline(ctx) ? 0 : 0.05);
}

function isOffline(ctx: BaseAudioContext): boolean {
  return typeof OfflineAudioContext !== "undefined" && ctx instanceof OfflineAudioContext;
}

// ── Imported media in the mix ────────────────────────────────────────────────
//
// `collectCompMedia` (core) is the ONE walk — asset-audio + unmuted video,
// recursively through nested comps, each segment resolved to output time and
// carrying a `gainScale` that folds in the clip's own + every ancestor's
// `audioMix` fader. The exporter just decodes and schedules.

/**
 * The level node a segment feeds through: a gain carrying the automation curve
 * (keyframes × fades for audio, keyframed volume for video), scaled by the
 * segment's `gainScale` (audioMix faders), preceded by the 3-band EQ for audio
 * clips. Returns the graph's INPUT node. Because it samples the exact same core
 * envelope the live conductor uses, the file matches the preview by construction.
 */
/** What the mix plan adds to one occurrence in a render. */
interface SegmentMix {
  /** Leveler trim, linear. */
  trim: number;
  /** Clip-rule ducks, or null. */
  duck: DuckCurve | null;
  /** Where the (windowed) segment starts in COMP time — the duck's clock. */
  compAtMs: number;
}

function buildLevelChain(
  ctx: BaseAudioContext,
  dest: AudioNode,
  seg: MediaAudioSegment,
  startTime: number,
  mix: SegmentMix,
): AudioNode {
  const gain = ctx.createGain();
  const durSec = seg.outputDurationMs / 1000;
  const scale = seg.gainScale * mix.trim;
  // A cut crossfade — or a duck — varies across the segment, so it forces the
  // curve path even on a clip with no automation of its own.
  const crossfading = segmentHasCrossfade(seg) || mix.duck !== null;
  // Sample i of n sits at i/(n-1) of the segment's output span, in comp time.
  const duckAt = (i: number, n: number) =>
    duckGainAt(mix.duck, mix.compAtMs + (n > 1 ? (i / (n - 1)) * seg.outputDurationMs : 0));

  if (seg.clip.kind === "audio") {
    const clip = seg.clip;
    if (hasGainAutomation(clip) || crossfading) {
      const curve = sampleGainEnvelope(clip, 20);
      for (let i = 0; i < curve.length; i++) curve[i]! *= scale * segmentCrossfadeAt(seg, i * 20) * duckAt(i, curve.length);
      gain.gain.setValueCurveAtTime(curve, startTime, Math.max(0.001, durSec));
    } else {
      gain.gain.value = clip.gain * scale;
    }
    return connectThroughEffects(ctx, seg, startTime, gain, dest);
  }

  // Video: keyframed volume, sampled to a curve when it moves.
  const vclip = seg.clip;
  const moves = vclip.keyframes.some((t) => t.property === "volume" && t.keys.length > 0);
  if (moves || crossfading) {
    const n = Math.max(2, Math.ceil(seg.outputDurationMs / 20) + 1);
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const local = Math.min(seg.outputDurationMs, i * 20);
      curve[i] = videoVolumeAt(vclip, local) * scale * segmentCrossfadeAt(seg, local) * duckAt(i, n);
    }
    gain.gain.setValueCurveAtTime(curve, startTime, Math.max(0.001, durSec));
  } else {
    gain.gain.value = vclip.volume * scale;
  }
  return connectThroughEffects(ctx, seg, startTime, gain, dest);
}

/**
 * Route a segment's gain node to the destination THROUGH its audio effect
 * chain. The chain rides `clipBase`, so a video's dialogue gets the same
 * treatment as a music bed — one call, both kinds, no branch.
 *
 * The chain is built at the segment's first instant and then its whole
 * automation is SCHEDULED: every 20 ms of the segment, the values core
 * resolves at that clip instant (keyframes, modulators, drivers — the same
 * `audioEffectsAt` the live conductor plays) become timed AudioParam events.
 * So a filter sweep, a keyed dry/wet or a modulated cutoff lands in the file
 * exactly as it was auditioned. One-off mutations (a crush curve, a filter's
 * type, a room) cannot be timed on an offline graph, so they keep their opening
 * state — `paramsOnly`.
 */
const AUTOMATION_STEP_MS = 20;

function connectThroughEffects(
  ctx: BaseAudioContext,
  seg: MediaAudioSegment,
  startTime: number,
  gain: GainNode,
  dest: AudioNode,
): GainNode {
  const clip = seg.clip;
  const at = (localOutMs: number) =>
    audioEffectsAt(clip.audioEffects, clip.keyframes, segmentClipLocalMs(seg, localOutMs), { modulators: clip.modulators });
  const first = at(0);
  const chain = buildAudioChain(ctx, first);
  if (!chain) {
    gain.connect(dest);
    return gain;
  }
  gain.connect(chain.input);
  chain.output.connect(dest);
  const signature = audioChainSignature(first);
  if (effectsMove(clip)) {
    for (let t = AUTOMATION_STEP_MS; t < seg.outputDurationMs; t += AUTOMATION_STEP_MS) {
      const now = at(t);
      // A structural change mid-clip (a card switched off by a key) cannot be
      // rebuilt on an offline graph; the values keep moving on the graph built.
      if (audioChainSignature(now) !== signature) continue;
      chain.update(now, startTime + t / 1000, true);
    }
  }
  return gain;
}

/** Does anything in this clip's chain change over time — a keyed field or a modulator? */
function effectsMove(clip: MediaAudioSegment["clip"]): boolean {
  if ((clip.modulators?.length ?? 0) > 0) return true;
  return clip.keyframes.some((t) => t.property.startsWith("afx.") && t.keys.length > 1);
}

/**
 * Asset ids whose sound could not be decoded during the LAST bounce.
 *
 * A file the engine cannot decode used to drop out of the mix in silence,
 * which is indistinguishable from a file with no sound in it — and it is the
 * likeliest reason a video's dialogue is missing from an export while it plays
 * fine on the timeline (the timeline plays the element; the mix decodes the
 * bytes, and not every engine can decode audio out of every video container).
 * Recording it lets the export say so instead of shipping a mystery.
 */
let lastUndecodable: string[] = [];

/** Assets the last bounce could not decode — read straight after awaiting it. */
export function undecodableAssetsFromLastBounce(): string[] {
  return lastUndecodable;
}

async function decodeAssetBuffers(
  ctx: BaseAudioContext,
  segments: Array<{ assetId: string }>,
): Promise<Map<string, AudioBuffer>> {
  const buffers = new Map<string, AudioBuffer>();
  for (const id of new Set(segments.map((s) => s.assetId))) {
    try {
      const blob = await getAssetBlob(id);
      if (!blob) throw new Error("asset bytes missing");
      buffers.set(id, await ctx.decodeAudioData(await blob.arrayBuffer()));
    } catch {
      // Undecodable media exports silent rather than failing the whole render —
      // but it is NAMED, so the silence is reported rather than discovered.
      if (!lastUndecodable.includes(id)) lastUndecodable.push(id);
    }
  }
  return buffers;
}

/** One windowed occurrence, with what the mix does to it and where it lands. */
interface ScheduledSegment {
  seg: MediaAudioSegment;
  mix: SegmentMix;
  dest: AudioNode;
}

/**
 * A few milliseconds of fade at every edge. A segment cut by its comp's window
 * (a whoosh whose tail runs past its scene) otherwise stops mid-waveform, which
 * is a click; a DAW puts the same micro-fade on every region edge.
 */
const DECLICK_IN_SEC = 0.004;
const DECLICK_OUT_SEC = 0.008;

function declick(ctx: BaseAudioContext, when: number, durSec: number): GainNode {
  const g = ctx.createGain();
  const end = when + durSec;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(1, when + Math.min(DECLICK_IN_SEC, durSec / 4));
  g.gain.setValueAtTime(1, Math.max(when, end - Math.min(DECLICK_OUT_SEC, durSec / 4)));
  g.gain.linearRampToValueAtTime(0, end);
  return g;
}

function scheduleSegmentsInto(
  ctx: BaseAudioContext,
  t0: number,
  entries: ScheduledSegment[],
  buffers: Map<string, AudioBuffer>,
  baked: Map<string, AudioBuffer>,
): void {
  for (const { seg, mix, dest } of entries) {
    // Heavy audio clips (reverse / pitch / keep-pitch under speed) play their
    // PRE-BAKED buffer at rate 1.0 — the bake already encodes the retiming and
    // pitch, so the file matches preview and keep-pitch survives the offline
    // render (no `preservesPitch` flag in an OfflineAudioContext).
    const bake = seg.clip.kind === "audio" ? baked.get(segKey(seg)) : undefined;
    const when = t0 + seg.atMs / 1000;
    const durSec = seg.outputDurationMs / 1000;
    const level = buildLevelChain(ctx, dest, seg, when, mix);
    const edge = declick(ctx, when, durSec);
    edge.connect(level);
    if (bake) {
      // The spec bake IS this occurrence's full output at rate 1.0 (cumulative
      // speed + reverse + pitch already applied), so play it straight through.
      const source = ctx.createBufferSource();
      source.buffer = bake;
      source.playbackRate.value = 1;
      source.connect(edge);
      source.start(when, 0);
      source.stop(when + durSec);
      continue;
    }
    const buffer = buffers.get(seg.assetId);
    if (!buffer) continue;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = seg.speed;
    source.connect(edge);
    if (seg.loop !== "none") {
      // Ping-pong has no native audio equivalent — a straight loop is the
      // closest audible read.
      source.loop = true;
      source.loopStart = Math.min(seg.trimInMs / 1000, buffer.duration);
      source.loopEnd = buffer.duration;
      source.start(when, source.loopStart);
    } else {
      source.start(when, Math.min(seg.trimInMs / 1000, buffer.duration));
    }
    source.stop(when + durSec);
  }
}

/** How a render mixes. Omitted = the comp's own mix, exactly as it plays (see `withMixOverride`). */
export interface AudioRenderMix {
  /** A clip's own sound with no mix at all — render-in-place bakes the clip, not the bus. */
  raw?: boolean;
}

/**
 * The mix plan a render uses — with every sound it levels MEASURED first. A
 * file is never written half-levelled: playback may fill the leveler in as
 * measurements land, a render waits for them.
 */
export async function renderPlan(doc: MotionDocument, frameId: string): Promise<MixPlan> {
  const probe = buildMixPlan(doc, frameId, loudnessSource);
  if (probe.pending === 0) return probe;
  await measureAll(probe.missingAssets, probe.missingPacks);
  return buildMixPlan(doc, frameId, loudnessSource);
}

/**
 * Schedule EVERYTHING a comp sounds like (synth cues + imported media) onto a
 * context — offline or the WebM realtime path — through the SAME mix graph and
 * plan playback uses. Async because media must decode (and be measured) first.
 */
export async function scheduleCompAudioInto(
  ctx: BaseAudioContext,
  dest: AudioNode,
  doc: MotionDocument,
  frameId: string,
  durationMs: number,
  startMs = 0,
  mix: AudioRenderMix = {},
): Promise<void> {
  const plan = mix.raw ? null : await renderPlan(doc, frameId);
  const t0 = scheduleOrigin(ctx);
  const graph = plan ? new MixGraph(ctx, dest, { meters: false }) : null;
  if (graph && plan) graph.scheduleRender(plan, t0, startMs, durationMs);
  const inputOf = (bus: string | null): AudioNode => (graph && plan ? graph.input(plan.route(bus)) : dest);

  // `startMs` shifts the whole mix so the export window's start becomes t=0 —
  // a working-range export bounces just that span. Cues are windowed by
  // buildSoundCues; media segments are shifted (and mid-clip segments already
  // playing at the window start begin part-way into the file).
  const cues = buildSoundCues(doc, startMs, startMs + durationMs, frameId);
  const customIds = new Set(cues.flatMap((c) => (c.custom ? [c.custom.assetId] : [])));
  const customBuffers =
    customIds.size > 0 ? await decodeAssetBuffers(ctx, [...customIds].map((assetId) => ({ assetId }))) : undefined;
  for (const cue of cues) {
    const custom = cue.custom ? customBuffers?.get(cue.custom.assetId) ?? null : null;
    playCue(ctx, inputOf(cue.bus), cue, t0 + (cue.timeMs - startMs) / 1000, plan ? plan.cueGain(cue) : 1, custom);
  }

  // The plan is keyed on each occurrence as the COMP places it, so its trim
  // and ducks are read before the segment is shifted into the render window.
  const entries: ScheduledSegment[] = [];
  for (const whole of collectCompMedia(doc, frameId)) {
    const seg = shiftSegmentIntoWindow(whole, startMs);
    if (!seg) continue;
    entries.push({
      seg,
      mix: { trim: plan?.segmentTrim(whole) ?? 1, duck: plan?.segmentDuck(whole) ?? null, compAtMs: startMs + seg.atMs },
      dest: inputOf(whole.bus),
    });
  }
  if (entries.length === 0) return;
  // Bake heavy audio OCCURRENCES up front (reverse / pitch / keep-pitch under
  // the CUMULATIVE speed) — keyed per occurrence, via the same spec bake the
  // live engine uses, so a voice nested inside a sped-up comp renders right.
  const baked = new Map<string, AudioBuffer>();
  for (const { seg } of entries) {
    if (seg.clip.kind !== "audio") continue;
    const spec = segmentBakeSpec(seg);
    if (!specIsHeavy(spec)) continue;
    const buf = await ensureSpecBakeAsync(spec);
    if (buf) baked.set(segKey(seg), buf);
  }
  scheduleSegmentsInto(ctx, t0, entries, await decodeAssetBuffers(ctx, entries.map((e) => e.seg)), baked);
}

/** Per-occurrence bake key (a comp can be instanced at several output times). */
function segKey(seg: MediaAudioSegment): string {
  return `${seg.clip.id}:${Math.round(seg.atMs)}`;
}

/**
 * Re-base one media segment onto a window that starts at `startMs`. A segment
 * that already started before the window begins part-way into the source (its
 * trim-in advanced by the elapsed wall time × speed); one that ended before the
 * window is dropped. Loop wrap before the window is approximated (rare).
 */
function shiftSegmentIntoWindow(seg: MediaAudioSegment, startMs: number): MediaAudioSegment | null {
  const rel = seg.atMs - startMs;
  if (rel >= 0) return { ...seg, atMs: rel };
  const skippedWall = -rel;
  if (skippedWall >= seg.outputDurationMs) return null;
  return {
    ...seg,
    atMs: 0,
    trimInMs: seg.trimInMs + skippedWall * seg.speed,
    outputDurationMs: seg.outputDurationMs - skippedWall,
  };
}

/** Bounce a comp's full audio (cues + media) to a stereo buffer (MP4 path). */
export async function renderCompAudioToBuffer(
  doc: MotionDocument,
  frameId: string,
  durationMs: number,
  sampleRate = 48000,
  startMs = 0,
  mix: AudioRenderMix = {},
): Promise<AudioBuffer> {
  lastUndecodable = [];
  const length = Math.max(1, Math.ceil((durationMs / 1000) * sampleRate));
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  const master = ctx.createGain();
  master.connect(ctx.destination);
  await scheduleCompAudioInto(ctx, master, doc, frameId, durationMs, startMs, mix);
  return ctx.startRendering();
}

/**
 * The loudest sample in a bounce.
 *
 * An export mixes through an `OfflineAudioContext` — a renderer that is NOT the
 * one playback uses. When those two disagree, everything downstream still
 * "succeeds": the encoder encodes the silence, the muxer writes it, and the
 * export reports done. Measuring the bounce is what turns that into a fact the
 * exporter can act on, and the only cheap way to tell "this project has no
 * sound in it" apart from "this device rendered the sound as nothing".
 */
/**
 * THE LOUDNESS OF A MIX — integrated LUFS (EBU R128) and sample peak, of the
 * buffer an exporter actually encoded. Silence has no loudness (−∞), so it is
 * said in words rather than as a number JSON would print as null.
 */
export type MixLoudness = { integratedLufs: number; peakDbfs: number } | { silent: true };

export function measureMix(buffer: AudioBuffer): MixLoudness {
  const peak = audioBufferPeak(buffer);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const lufs = integratedLoudness(measureLoudnessTable(channels, buffer.sampleRate), 0, buffer.duration * 1000);
  if (!(peak > 0) || !Number.isFinite(lufs)) return { silent: true };
  return { integratedLufs: Math.round(lufs * 10) / 10, peakDbfs: Math.round(20 * Math.log10(peak) * 10) / 10 };
}

export function audioBufferPeak(buffer: AudioBuffer): number {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    // Every 32nd sample: a mix that is audible anywhere is audible in a
    // thirty-second of its samples, and a full scan of a 3-minute stereo
    // bounce is 17M reads for an answer this coarse.
    for (let i = 0; i < data.length; i += 32) {
      const v = data[i]! < 0 ? -data[i]! : data[i]!;
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/**
 * The mix as interleaved signed 16-bit little-endian PCM — the one conversion
 * from "floats an AudioContext rendered" to "samples a file can hold".
 *
 * WAV and the lossless MOV master both want exactly this, and both used to be
 * entitled to their own rounding of it. Note the asymmetric scale: a float of
 * -1 is 0x8000 and +1 is 0x7FFF, because two's complement has one more step
 * below zero than above it. Scaling both by 0x8000 clips every full-scale
 * positive peak, which is audible as a tick on anything mastered loud.
 */
export function audioBufferToPcm16(buffer: AudioBuffer): {
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
} {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const out = new ArrayBuffer(frames * channels * 2);
  const view = new DataView(out);
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let offset = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c]![i]!));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return { pcm: new Uint8Array(out), sampleRate: buffer.sampleRate, channels };
}

/** Encode a stereo AudioBuffer to a 16-bit PCM WAV blob (audio-only export). */
export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const { pcm, sampleRate, channels: numCh } = audioBufferToPcm16(buffer);
  const blockAlign = numCh * 2;
  const dataSize = pcm.length;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  return new Blob([header, pcm.slice().buffer], { type: "audio/wav" });
}
