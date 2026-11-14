import {
  audioChainSignature,
  audioEffectsAt,
  audioGainAt,
  duckGainAt,
  segmentClipLocalMs,
  segmentCrossfadeAt,
  collectCompMedia,
  type MotionDocument,
  type AudioClip,
  type MediaAudioSegment,
} from "@solomotion/core";
import { soundEngine } from "./sound-engine";
import { buildAudioChain, type AudioChain } from "./audio-effect-chain";
import { assetObjectURL } from "../assets/asset-store";
import { ensureSpecBake, segmentBakeSpec, specIsHeavyLive } from "./audio-bake";
import { livePlan } from "./mix-state";

/**
 * THE unified audio playback engine — one path for EVERY audible audio
 * occurrence, top-level or buried any number of comps deep. It's driven by the
 * headless `collectCompMedia` inventory (the same one export uses), which walks
 * nesting recursively and hands back flat segments whose `speed` and `gainScale`
 * ALREADY fold in every ancestor nested clip. So effects compose like a node
 * graph, building on top of each other at any depth:
 *
 *   [ source: element (cheap) | baked buffer (reverse/pitch) ]
 *       → parametric EQ biquads (the clip's own bands)
 *       → gain (envelope × cumulative ancestor faders × the mix plan's trim + ducks)
 *       → its CATEGORY in the mix graph (see mix-graph.ts) → master
 *
 * Keep-pitch under a sped-up ANCESTOR is free (the element's `preservesPitch`
 * runs at the cumulative rate); reverse and pitch-shift bake per occurrence
 * (spec carries the cumulative speed, so a voice pitched inside a 2× comp bakes
 * correctly). One voice per OCCURRENCE (clip id + output start), because one
 * comp can be instanced at several moments.
 */

interface VoiceBase {
  assetId: string;
  gain: GainNode;
  /** Where `gain` feeds — its category's input. Re-routed when the category changes. */
  dest: AudioNode;
  /** The clip's audio effect chain, or null when it has none. */
  chain: AudioChain | null;
  /** Structural signature of that chain — a change here means REBUILD. */
  chainSig: string;
}
interface ElementVoice extends VoiceBase {
  kind: "element";
  el: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
}
interface BakedVoice extends VoiceBase {
  kind: "baked";
  bufSource: AudioBufferSourceNode | null;
  bakeSig: string;
  buffer: AudioBuffer | null;
  start: { ctxTime: number; offsetSec: number } | null;
}
type Voice = ElementVoice | BakedVoice;

const voices = new Map<string, Voice>();
// An element binds to ONE MediaElementAudioSourceNode for life, so both the
// element and its source persist here across element↔baked flips (toggling
// pitch mid-playback) — recreating the source would throw.
const elements = new Map<string, { el: HTMLAudioElement; source: MediaElementAudioSourceNode | null }>();

function disposeVoice(v: Voice): void {
  try {
    if (v.kind === "baked" && v.bufSource) v.bufSource.stop();
  } catch {
    /* already stopped */
  }
  v.chain?.dispose();
  v.gain.disconnect();
  if (v.kind === "element") {
    v.el.pause();
    v.source.disconnect(); // the source node itself lives on in `elements`
  } else if (v.bufSource) {
    v.bufSource.disconnect();
  }
}

/**
 * Point a voice's processing at the chain the document currently describes.
 *
 * Two costs, kept apart. A STRUCTURAL change (a card added, a band retyped, the
 * reverb's room resized) rebuilds nodes; everything else just moves AudioParams.
 * Without that split a keyframed dry/wet would tear down and regenerate a
 * convolver on every animation frame, which is audible as a click and expensive
 * enough to drop frames.
 */
function syncChain(v: Voice, seg: MediaAudioSegment, localOut: number, ctx: AudioContext, head: AudioNode): void {
  const clip = seg.clip;
  const resolved = audioEffectsAt(clip.audioEffects, clip.keyframes, segmentClipLocalMs(seg, localOut), {
    modulators: clip.modulators,
  });
  const sig = audioChainSignature(resolved);
  if (sig !== v.chainSig) {
    head.disconnect();
    v.chain?.dispose();
    v.chain = buildAudioChain(ctx, resolved);
    v.chainSig = sig;
    if (v.chain) {
      head.connect(v.chain.input);
      v.chain.output.connect(v.gain);
    } else {
      head.connect(v.gain);
    }
    return;
  }
  v.chain?.update(resolved, ctx.currentTime);
}


/**
 * Level at this instant: the clip's own envelope × the cumulative ancestor
 * faders × any cut crossfade. The crossfade rides the SAME shared seam the
 * waveform and the exporter read, so what you hear, what you see drawn on the
 * clip and what lands in the file are one calculation.
 */
function levelOf(seg: MediaAudioSegment, localOut: number, mix: number): number {
  const local = segmentClipLocalMs(seg, localOut);
  const env = seg.clip.kind === "audio" ? audioGainAt(seg.clip, local) : 1;
  return Math.max(0, env * seg.gainScale * segmentCrossfadeAt(seg, local) * mix);
}

/** Point a voice's output at its category, moving it only when the route changed. */
function route(v: Voice, dest: AudioNode): void {
  if (v.dest === dest) return;
  v.gain.disconnect();
  v.gain.connect(dest);
  v.dest = dest;
}

// ── The per-occurrence drivers ───────────────────────────────────────────────

function driveElement(
  key: string,
  seg: MediaAudioSegment,
  active: boolean,
  localOut: number,
  ctx: AudioContext,
  dest: AudioNode,
  mime: string | undefined,
  mix: number,
): void {
  const clip = seg.clip as AudioClip;
  let v = voices.get(key);
  if (v && v.kind !== "element") {
    disposeVoice(v);
    voices.delete(key);
    v = undefined;
  }
  if (!v) {
    let ent = elements.get(key);
    if (!ent) {
      const el = document.createElement("audio");
      el.preload = "auto";
      ent = { el, source: null };
      elements.set(key, ent);
      void assetObjectURL(seg.assetId, mime).then((url) => {
        if (url) el.src = url;
      });
    }
    // Create the source ONCE per element; reuse it on later flips back.
    ent.source ??= ctx.createMediaElementSource(ent.el);
    const gain = ctx.createGain();
    ent.source.connect(gain).connect(dest);
    v = { kind: "element", assetId: seg.assetId, el: ent.el, source: ent.source, gain, dest, chain: null, chainSig: "" };
    voices.set(key, v);
  }
  const el = v.el;
  // Keep pitch under the CUMULATIVE speed (free — the element does it).
  el.preservesPitch = segmentBakeSpec(seg).keepPitch;
  const speed = Math.max(0.01, seg.speed);
  if (el.playbackRate !== speed) el.playbackRate = speed;
  const targetSec = (seg.trimInMs + Math.max(0, localOut) * seg.speed) / 1000;
  if (!active) {
    if (!el.paused) el.pause();
    return;
  }
  if (el.paused) {
    el.currentTime = targetSec;
    void el.play().catch(() => undefined);
  } else if (Math.abs(el.currentTime - targetSec) > 0.15 && !el.seeking) {
    el.currentTime = targetSec;
  }
  el.volume = 1;
  route(v, dest);
  applyLevelAndEffects(v, seg, localOut, ctx, v.source, mix);
}

function driveBaked(
  key: string,
  seg: MediaAudioSegment,
  active: boolean,
  localOut: number,
  ctx: AudioContext,
  dest: AudioNode,
  mix: number,
): void {
  const clip = seg.clip as AudioClip;
  let v = voices.get(key);
  if (v && v.kind !== "baked") {
    disposeVoice(v);
    voices.delete(key);
    v = undefined;
  }
  if (!v) {
    const gain = ctx.createGain();
    gain.connect(dest);
    v = { kind: "baked", assetId: seg.assetId, bufSource: null, bakeSig: "", buffer: null, start: null, gain, dest, chain: null, chainSig: "" };
    voices.set(key, v);
  }
  const spec = segmentBakeSpec(seg);
  const sig = `${spec.assetId}|${spec.trimInMs}|${spec.outputDurationMs}|${spec.speed}|${spec.reverse}|${spec.pitchSemitones}`;
  if (!active) {
    stopBaked(v);
    return;
  }
  const buffer = ensureSpecBake(spec);
  if (!buffer) {
    stopBaked(v);
    return; // baking — briefly silent
  }
  const wantOffset = Math.max(0, localOut / 1000);
  if (wantOffset >= buffer.duration - 0.005) {
    stopBaked(v);
    return;
  }
  const expected = v.start ? v.start.offsetSec + (ctx.currentTime - v.start.ctxTime) : -1;
  const drift = v.start ? Math.abs(wantOffset - expected) : Infinity;
  if (!v.bufSource || v.bakeSig !== sig || v.buffer !== buffer || drift > 0.2) {
    stopBaked(v);
    const bufSource = ctx.createBufferSource();
    bufSource.buffer = buffer;
    bufSource.playbackRate.value = 1;
    // A fresh buffer source is a new head, so the chain must be re-attached to
    // it — force that by clearing the signature.
    v.chainSig = "";
    const offset = Math.min(wantOffset, buffer.duration);
    bufSource.start(ctx.currentTime, offset);
    v.bufSource = bufSource;
    v.bakeSig = sig;
    v.buffer = buffer;
    v.start = { ctxTime: ctx.currentTime, offsetSec: offset };
  }
  route(v, dest);
  applyLevelAndEffects(v, seg, localOut, ctx, v.bufSource!, mix);
}

function stopBaked(v: BakedVoice): void {
  if (!v.bufSource) return;
  try {
    v.bufSource.stop();
  } catch {
    /* already stopped */
  }
  v.bufSource.disconnect();
  v.chain?.dispose();
  v.chain = null;
  v.chainSig = "";
  v.bufSource = null;
  v.start = null;
}

/** Shared: the gain envelope × faders, and the effect chain, for this tick. */
function applyLevelAndEffects(v: Voice, seg: MediaAudioSegment, localOut: number, ctx: AudioContext, head: AudioNode, mix: number): void {
  v.gain.gain.setTargetAtTime(levelOf(seg, localOut, mix), ctx.currentTime, 0.03);
  syncChain(v, seg, localOut, ctx, head);
}

/** How far ahead of its start a voice is made, and how long either side it is kept. */
const VOICE_PREROLL_MS = 2000;
const VOICE_KEEP_MS = 4000;

/**
 * Drive EVERY audio occurrence in the comp (top-level + nested, any depth) for
 * one transport tick. Called from the media conductor; video stays on its own
 * path there.
 */
export function conductAllAudio(doc: MotionDocument, compId: string, playheadMs: number, playing: boolean, muted: boolean): void {
  const bus = soundEngine.mixBus();
  const liveKeys = new Set<string>();
  // THE mix, as the plan states it at this instant: category faders, ducks,
  // the limiter — then each voice's own trim and clip ducks below.
  const plan = livePlan(doc, compId);
  if (bus && playing) bus.graph.applyLive(plan, playheadMs);
  for (const seg of collectCompMedia(doc, compId)) {
    if (seg.clip.kind !== "audio" || seg.clip.source.type !== "asset") continue;
    const key = `${seg.clip.id}:${Math.round(seg.atMs)}`;
    const localOut = playheadMs - seg.atMs;
    // A VOICE EXISTS ONLY NEAR THE PLAYHEAD. Every occurrence in a film (every
    // loop cycle of every nested sound) used to get its own element, decoder
    // and node chain on the first tick — hundreds of them loading at once.
    // Made PREROLL ahead so it is loaded when it is due; kept KEEP either side
    // so a loop or a scrub does not churn it.
    const near = localOut >= -VOICE_KEEP_MS && localOut < seg.outputDurationMs + VOICE_KEEP_MS;
    if (!near) continue;
    if (!voices.has(key) && !elements.has(key) && (localOut < -VOICE_PREROLL_MS || localOut >= seg.outputDurationMs)) continue;
    liveKeys.add(key);
    const active = playing && !muted && localOut >= 0 && localOut < seg.outputDurationMs;
    if (!bus) continue; // no audio context yet
    const asset = doc.assets.find((a) => a.id === seg.assetId);
    const dest = bus.graph.input(plan.route(seg.bus));
    const mix = plan.segmentTrim(seg) * duckGainAt(plan.segmentDuck(seg), playheadMs);
    if (specIsHeavyLive(segmentBakeSpec(seg))) driveBaked(key, seg, active, localOut, bus.ctx, dest, mix);
    else driveElement(key, seg, active, localOut, bus.ctx, dest, asset?.mime, mix);
  }
  // Dispose voices whose occurrence is gone (clip deleted / comp switched / edit
  // moved a segment). Elements are kept warm for reuse unless truly stale.
  for (const [k, v] of voices) {
    if (!liveKeys.has(k)) {
      disposeVoice(v);
      voices.delete(k);
    }
  }
  for (const [k, ent] of elements) {
    if (!liveKeys.has(k)) {
      ent.el.pause();
      ent.el.src = "";
      try {
        ent.source?.disconnect();
      } catch {
        /* not connected */
      }
      elements.delete(k);
    }
  }
}

/** Transport stopped — silence every voice. */
export function stopAllAudioVoices(): void {
  for (const v of voices.values()) {
    if (v.kind === "element") v.el.pause();
    else stopBaked(v);
  }
  for (const ent of elements.values()) ent.el.pause();
}
