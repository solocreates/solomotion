import type {
  AudioClip,
  AudioMix,
  Clip,
  CustomSoundRef,
  LoopMode,
  NestedClip,
  SoundPackId,
  SoundPhase,
  TextClip,
  Easing,
  SoundLayer,
  SoundTriggerKind,
  SoundVoice,
  VisualClip,
  LayerAnimationSpec,
  Track,
  MotionDocument,
  VideoClip,
  SoundKit,
} from "../schema";
import { isSettledDocument } from "../timeline/settled";
import { rangeAt } from "../text/ranges";
import { frameClipEntries } from "../timeline/frame-index";
import { textUnitEvents } from "../animation/evaluate";
import { sampleKeyframes, sampleNumber } from "../animation/keyframes";
import { isVisualClip } from "../clip-registry";
import { audioGainAt } from "./envelope";
import { crossfadeFactorAt, transitionAtHead, transitionAtTail, transitionSpan } from "../timeline/transitions";
import { easingPeak } from "../easing";
import { isVisualClip as isVisual } from "../clip-registry";
import { flatHits } from "../physics/flat";
import { CLIMAX_WINDOW_MS, limitVoices, rateIntensity, voiceNote, VOICES_PER_SLOT, type NoteContext, type NoteVoicing } from "./sound-sets";
import { soundIntensitySampler } from "./sound-fields";

/**
 * THE headless audio inventory — the ONE walk over "what a composition sounds
 * like", so detection, live playback and export can never disagree.
 *
 * Every sound source a comp holds resolves here, recursively through nested
 * comps, into two flat lists in absolute OUTPUT time:
 *   • {@link SoundCue}s          — synth/imported hit sounds (text typing, pack
 *                                  audio clips), and
 *   • {@link MediaAudioSegment}s — continuous media (imported audio clips and
 *                                  unmuted video).
 *
 * A single linear time+gain transform (`AudioCtx`) folds nesting in: a nested
 * clip's source-comp timeline maps into the parent through its start / trim-in /
 * speed, and the universal `audioMix` fader on every clip multiplies down the
 * chain. Add a new sound-bearing clip kind = one case in `emitClip`; every
 * surface (the "include sound" toggle, the mixer, the exporter) picks it up for
 * free.
 */

/** A scheduled sound event, in absolute document time. Pure data — the web
 * app synthesizes it with WebAudio; native adapters can bounce it to a file. */
export interface SoundCue {
  timeMs: number;
  pack: SoundPackId;
  /** When set, this imported sound plays instead of the synth pack — its
   * `hitMs` moment is aligned to `timeMs` (the file's attack leads in). */
  custom?: CustomSoundRef | null;
  volume: number;
  /** 0..1 randomness amount — the player derives deterministic per-cue variation from `seed`. */
  randomness: number;
  pitch: number;
  /** 0..1 tone colour — the tuned voices open up with it (hit force, the climax); older packs ignore it. */
  bright: number;
  /** 0..1 — a low impact layered under the hit as a climax peaks (0 = none). */
  weight: number;
  /** 0..1 — how much shorter a recorded hit rings (a `weight` climax); absent = as recorded. */
  damp?: number;
  /** -1..1 — where it sits left to right (a body hit's place in the frame); absent = centre. */
  pan?: number;
  /** A voice played as notes: humanisation detunes it by cents, never by the ±17% a click can take. */
  tuned?: boolean;
  /** The kit it is a take of — its takes are judged by the leveler as ONE sound. */
  kit?: string;
  seed: number;
  /** The clip that fires it — ducking matches on it. */
  clipId: string;
  /**
   * The stream the leveler judges it in: its clip, or — for collisions — the
   * comp's bodies sharing its sound, because 256 balls each ringing twice a
   * second are heard as ONE stream of 500 hits, not 256 calm one-shots.
   */
  stream: string;
  /** The category it routes into (a `doc.soundBuses` id), or null = straight to master. */
  bus: string | null;
  /** Nested clips it sits inside, outermost first — a clip-targeted duck matches any of them. */
  path: readonly string[];
}

/**
 * One hit's deterministic humanisation — THE variation both the live engine
 * and the exporter apply, so a keystroke is exactly as loud and as pitched in
 * the file as it was in preview. Derived from the cue's seed, never
 * `Math.random`: the same take every time you play.
 */
export function cueVariation(cue: Pick<SoundCue, "seed" | "randomness" | "volume" | "pitch" | "tuned">): { volume: number; pitch: number } {
  const r1 = cue.seed;
  const r2 = (cue.seed * 7919) % 1;
  // A note keeps its note: up to ±12 cents and −1.5 dB, a player's touch — not a different pitch.
  return cue.tuned
    ? { volume: cue.volume * (1 - cue.randomness * 0.16 * r1), pitch: cue.pitch * 2 ** ((cue.randomness * 0.24 * (r2 - 0.5)) / 12) }
    : { volume: cue.volume * (1 - cue.randomness * 0.65 * r1), pitch: cue.pitch * (1 + cue.randomness * 0.35 * (r2 - 0.5)) };
}

/**
 * Continuous media audible in a comp, resolved to OUTPUT time. Asset-audio
 * clips and unmuted video both reduce to this — the app decodes the asset and
 * schedules a buffer source; `clip` is carried so the exact same envelope the
 * live conductor uses is sampled, and `gainScale` folds in ancestor `audioMix`
 * faders (nested-comp volume).
 */
export interface MediaAudioSegment {
  assetId: string;
  /** Absolute output time the clip starts at. */
  atMs: number;
  trimInMs: number;
  /** Wall time the clip occupies in the output. */
  outputDurationMs: number;
  speed: number;
  loop: LoopMode;
  /** The source clip — carried so export samples the SAME envelope preview plays. */
  clip: AudioClip | VideoClip;
  /** Cumulative multiplier from this clip's + ancestors' `audioMix` volume. */
  gainScale: number;
  /** The category it routes into (a `doc.soundBuses` id), or null = straight to master. */
  bus: string | null;
  /** Nested clips it sits inside, outermost first. */
  path: readonly string[];
  /**
   * The lane the clip rides, carried so consumers can read the CUT TRANSITIONS
   * on it. A crossfade is a property of the seam, not of either clip, so it
   * cannot be folded into `gainScale` (which is a constant) — it varies across
   * the segment and is sampled per instant via `segmentCrossfadeAt`.
   */
  track: Track;
}

// ── The recursive walk ───────────────────────────────────────────────────────

/**
 * A linear map from a comp's LOCAL timeline to absolute OUTPUT time, plus the
 * accumulated gain and the visible local-time window. `out = a + b·local`, only
 * valid for `local ∈ [winFrom, winTo]`. At the top comp it's the identity.
 */
interface AudioCtx {
  a: number;
  b: number;
  winFrom: number;
  winTo: number;
  /** Cumulative ancestor `audioMix` volume (nested faders). */
  gain: number;
  /** Cumulative ancestor nested speed (tape-style playbackRate for media). */
  speedScale: number;
  /** The nearest ancestor's category tag — what an untagged clip inside inherits. */
  bus: string | null;
  /** Nested clip ids walked through to get here, outermost first. */
  path: readonly string[];
}

const TOP: AudioCtx = { a: 0, b: 1, winFrom: -Infinity, winTo: Infinity, gain: 1, speedScale: 1, bus: null, path: [] };

/**
 * THE ROUTE — which category a sound lands in. The most specific TAG wins: the
 * clip's own, else the nearest nested ancestor's. Only then the kind's default,
 * which is not a tag and so never overrides one: a fired cue (a keystroke, a
 * pop) is an effect; continuous media has no default and goes straight to the
 * master until someone says what it is.
 */
function routeOf(clip: Clip, ctx: AudioCtx, source: "cue" | "media"): string | null {
  return clip.soundBus ?? ctx.bus ?? (source === "cue" ? "sfx" : null);
}

/** A clip's own master multiplier at its base value (0 when muted). Used for
 * ancestor/nested faders where a single number folds the whole sub-mix. */
function mixGain(clip: Clip): number {
  const m = clip.audioMix;
  return m.muted ? 0 : m.volume;
}

/** A clip's own master multiplier sampled at a LOCAL time — so keyframing the
 * fader (fade a text's typing sound, duck a clip) actually takes effect. */
function mixGainAt(clip: Clip, localMs: number): number {
  if (clip.audioMix.muted) return 0;
  const keyed = sampleNumber(sampleKeyframes(clip.keyframes, localMs), "audioMix.volume");
  return keyed ?? clip.audioMix.volume;
}

/** The universal sound trim for a clip (mute + master volume). */
export function clipAudioMix(clip: Clip): AudioMix {
  return clip.audioMix;
}

interface AudioSink {
  cues?: SoundCue[];
  media?: MediaAudioSegment[];
  /** Output-time window cues are clipped to (media are collected whole). */
  fromMs: number;
  toMs: number;
  /** Each comp's hit score, once per walk — see {@link hitScore}. */
  scores?: Map<string, HitScore>;
}

/** The child context for a nested clip — folds its start/trim/speed + mix in. */
function descend(parent: AudioCtx, n: NestedClip): AudioCtx {
  const speed = n.playback.speed || 1;
  const d = 1 / speed; // parent-local p = c + d·(child-local s)
  const c = n.startMs - n.trimInMs * d;
  const nSpanFrom = n.trimInMs;
  const nSpanTo = n.trimInMs + n.durationMs * speed;
  // Parent window expressed in child-local coordinates (b, d > 0 → monotonic).
  const pWinA = (parent.winFrom - c) / d;
  const pWinB = (parent.winTo - c) / d;
  return {
    a: parent.a + parent.b * c,
    b: parent.b * d,
    winFrom: Math.max(nSpanFrom, Math.min(pWinA, pWinB)),
    winTo: Math.min(nSpanTo, Math.max(pWinA, pWinB)),
    gain: parent.gain * mixGain(n),
    speedScale: parent.speedScale * speed,
    bus: n.soundBus ?? parent.bus,
    path: [...parent.path, n.id],
  };
}

/**
 * The audio side of the v32 TRACK-LOOP seam. A looping lane repeats its
 * content span — for sound, each repetition is the SAME clips heard through a
 * context shifted by one cycle (`local' = local − k·len`), which the affine
 * `AudioCtx` expresses exactly. Ping-pong's mirrored cycles play the visuals
 * backwards; reversed audio isn't something we fake, so those cycles are
 * deliberately silent (forward cycles still sound). Returns the child-local
 * time offsets whose cycles intersect the audible window — [0] when the lane
 * doesn't loop.
 */
function trackLoopOffsets(
  track: { loop: LoopMode; clips: Clip[] },
  frameId: string,
  ctx: AudioCtx,
): number[] {
  if (track.loop === "none") return [0];
  let start = Infinity;
  let end = 0;
  for (const clip of track.clips) {
    if (clip.frameId !== frameId) continue;
    start = Math.min(start, clip.startMs);
    end = Math.max(end, clip.startMs + clip.durationMs);
  }
  const len = end - start;
  if (end <= 0 || len <= 0 || !Number.isFinite(ctx.winTo)) return [0];
  const offsets: number[] = [];
  const kMax = Math.min(512, Math.ceil((ctx.winTo - start) / len));
  for (let k = 0; k <= kMax; k++) {
    if (track.loop === "pingpong" && k % 2 === 1) continue; // mirrored → silent
    const cycleFrom = start + k * len;
    if (cycleFrom >= ctx.winTo || cycleFrom + len <= ctx.winFrom) continue;
    offsets.push(k * len);
  }
  return offsets.length > 0 ? offsets : [0];
}

/** `ctx` with its child-local origin shifted by `off` (a loop repetition). */
function shiftCtx(ctx: AudioCtx, off: number): AudioCtx {
  if (off === 0) return ctx;
  return { ...ctx, a: ctx.a + ctx.b * off, winFrom: ctx.winFrom - off, winTo: ctx.winTo - off };
}

function walkComp(
  doc: MotionDocument,
  frameId: string,
  ctx: AudioCtx,
  guard: Set<string>,
  sink: AudioSink,
): void {
  if (ctx.gain <= 0 || guard.has(frameId)) return;
  // A still is a picture: it holds one instant, and an instant makes no sound.
  if (isStill(doc, frameId)) return;
  guard.add(frameId);
  // Only THIS comp's clips (core's per-document index), in document order —
  // never a scan of every clip in the project per nested level, which made the
  // inventory of a film quadratic and was most of each playback tick.
  let track: Track | null = null;
  let offsets: number[] = [];
  for (const entry of frameClipEntries(doc, frameId)) {
    if (entry.track.muted) continue;
    if (entry.track !== track) {
      track = entry.track;
      offsets = trackLoopOffsets(track, frameId, ctx);
    }
    for (const off of offsets) {
      emitClip(doc, entry.clip, shiftCtx(ctx, off), guard, sink, track);
    }
  }
  guard.delete(frameId); // sibling instances of the same source comp stay independent
}

function emitClip(
  doc: MotionDocument,
  clip: Clip,
  ctx: AudioCtx,
  guard: Set<string>,
  sink: AudioSink,
  track: Track,
): void {
  // The sound stack is universal — every clip kind can carry one, so it is
  // dispatched before (and independently of) whatever the kind itself emits.
  // A text clip with a layer whoosh AND per-letter clicks is two entries here,
  // not a special case anywhere.
  emitStack(doc, clip, ctx, sink, track);
  switch (clip.kind) {
    case "audio":
      if (clip.source.type === "pack") emitPackCues(clip, clip.source.pack, ctx, sink);
      else emitMediaSegment(clip, clip.source.assetId, ctx, sink, track);
      return;
    case "video":
      if (!clip.muted && clip.volume > 0.001) emitMediaSegment(clip, clip.assetId, ctx, sink, track);
      return;
    case "nested":
      walkComp(doc, clip.sourceFrameId, descend(ctx, clip), guard, sink);
      return;
    default:
      return;
  }
}

/**
 * The voice one stack entry speaks with over a given grapheme — the entry's own
 * voice, patched by any range override that names it. One resolution, so the
 * inspector's "range sound" and the audio engine agree by construction.
 */
export function soundVoiceFor(clip: TextClip, layer: SoundLayer, graphemeIndex: number): SoundVoice {
  const override = rangeAt(clip.ranges, graphemeIndex)?.sounds?.[layer.id];
  return override ? { ...layer, ...override } : layer;
}

/** Is this entry silenced over this grapheme? (A range can mute one layer.) */
function layerEnabledAt(clip: TextClip, layer: SoundLayer, graphemeIndex: number): boolean {
  return rangeAt(clip.ranges, graphemeIndex)?.sounds?.[layer.id]?.enabled ?? layer.enabled;
}

// ── The ONE timing arithmetic ────────────────────────────────────────────────

/**
 * WHEN a stack entry fires, given the span of the event it rides.
 *
 * Every trigger routes through here, which is the point: a whoosh anchored to
 * `peak` with a −80 ms lead lands identically whether it is riding a letter, a
 * layer entrance or a cut, because there is exactly one place that arithmetic
 * exists. Three emitters resolving "the right moment" independently is how the
 * text cues and the animation schedule drifted apart before — the bug the
 * `textUnitEvents` unification already fixed once, not repeated here.
 *
 * Returns clip-LOCAL ms; the ancestor transform is applied by the caller.
 */
function cueTimeFor(
  layer: SoundLayer,
  spanStartMs: number,
  durationMs: number,
  easing: Easing,
): number {
  const f =
    layer.anchor === "start" ? 0 : layer.anchor === "end" ? 1 : easingPeak(easing);
  return spanStartMs + durationMs * f + layer.offsetMs;
}

/** Push one cue, clipped to the ancestor window and the requested range. */
function pushCue(
  sink: AudioSink,
  ctx: AudioCtx,
  clip: Clip,
  voice: SoundVoice,
  played: NoteVoicing,
  localMs: number,
  clipLocalMs: number,
  seed: number,
  stream: string = clip.id,
  pan?: number,
): void {
  if (!sink.cues) return;
  if (localMs < ctx.winFrom || localMs > ctx.winTo) return;
  const t = ctx.a + ctx.b * localMs;
  if (t < sink.fromMs || t >= sink.toMs) return;
  sink.cues.push({
    timeMs: t,
    pack: voice.pack,
    custom: played.take ? { assetId: played.take.assetId, hitMs: played.take.hitMs } : (voice.custom ?? null),
    volume: played.volume * ctx.gain * mixGainAt(clip, clipLocalMs),
    randomness: voice.randomness,
    pitch: played.pitch,
    bright: played.bright,
    weight: played.weight,
    ...(played.damp > 0 && { damp: played.damp }),
    ...(pan !== undefined && pan !== 0 && { pan }),
    ...(voice.notes && { tuned: true }),
    ...(voice.kit && { kit: kitKey(voice.kit) }),
    seed,
    clipId: clip.id,
    stream,
    bus: routeOf(clip, ctx, "cue"),
    path: ctx.path,
  });
}

// ── The emitters ───────────────────────────────────────────────────────

/**
 * Per-unit text hits, read straight off the clip's animation schedule.
 *
 * This function used to re-derive the schedule itself — over `clip.text` (not
 * the text actually on screen) with its own copy of the stagger arithmetic.
 * The moment a clip's content was keyframed the two derivations described
 * different text at different times, and the clicks stopped landing on the
 * letters. Now every cue is one `TextUnitEvent`, so "when does this letter
 * move" has exactly one answer and the sound is on it.
 *
 * The GRAIN (letter vs word) is not read here at all — it is baked into which
 * events `textUnitEvents` produces, which is itself driven by the clip's
 * animate tab. That is why a stack entry has no `unit` field: switching the
 * animation from letters to words re-voices its sound for free.
 */
function emitTextCues(clip: TextClip, layer: SoundLayer, ctx: AudioCtx, sink: AudioSink): void {
  const intensity = soundIntensitySampler(clip, layer);
  for (const ev of textUnitEvents(clip)) {
    if (ev.phase !== layer.phase) continue;
    if (!layerEnabledAt(clip, layer, ev.graphemeIndex)) continue;
    const voice = soundVoiceFor(clip, layer, ev.graphemeIndex);
    const spec = clip.animations[ev.phase];
    const at = cueTimeFor(layer, ev.atMs, ev.durationMs, spec?.easing ?? LINEAR_EASING);
    if (at < 0 || at > clip.durationMs) continue;
    // The SAME per-unit seed the renderer humanised this glyph with, so a hit's
    // volume/pitch variation belongs to the letter it lands on. A voice played
    // as notes walks the scale letter by letter — a typed melody.
    const note = { n: ev.unitIndex, member: ev.unitIndex, strength: 0.5, seed: ev.seed };
    pushCue(sink, ctx, clip, voice, voiceNote(voice, intensity(at), note), clip.startMs + at, at, ev.seed);
  }
}

/**
 * ONE hit on the layer's own in/out animation — the whole-shape counterpart to
 * a per-letter click, and what makes sound work for shapes, images, video and
 * nested comps rather than text alone.
 *
 * No animation on that edge = no event to ride = silence. That is deliberate:
 * an "in" sound on a layer that does not animate in has nothing to be timed
 * against, and inventing a moment for it (the clip's first frame, say) would
 * be a second, worse definition of when a layer arrives.
 */
function emitLayerCues(clip: Clip, layer: SoundLayer, ctx: AudioCtx, sink: AudioSink): void {
  if (!isVisual(clip)) return;
  const spec: LayerAnimationSpec | null =
    layer.phase === "in" ? (clip as VisualClip).animIn : (clip as VisualClip).animOut;
  if (!spec) return;
  // An `out` runs against the clip's TAIL; an `in` against its head.
  const spanStart = layer.phase === "in" ? 0 : clip.durationMs - spec.durationMs;
  const at = cueTimeFor(layer, spanStart, spec.durationMs, spec.easing);
  if (at < 0 || at > clip.durationMs) return;
  const seed = hashSeed(clip.id, Math.round(at));
  pushCue(sink, ctx, clip, layer, oneShot(clip, layer, at, seed), clip.startMs + at, at, seed);
}

/** A once-only firing's voicing: the root note, at the entry's intensity then. */
function oneShot(clip: Clip, layer: SoundLayer, clipLocalMs: number, seed: number): NoteVoicing {
  return voiceNote(layer, soundIntensitySampler(clip, layer)(clipLocalMs), { n: 0, member: 0, strength: 0.5, seed });
}

/**
 * ONE hit on the cut transition at this clip's head (`in`) or tail (`out`).
 *
 * The sound is stored on the CLIP, not on the `Transition` record, even though
 * the transition is what it rides. A transition is shared by two clips, so
 * storing the sound there would make "whose sound is this" ambiguous and would
 * need the same orphan-reconciliation pass the transition itself already
 * carries. Storing it on the clip that authored it means deleting that clip
 * deletes its sound, with no sweep and no dangling record — and the seam is
 * still the single source of TIMING, read live below.
 */
function emitTransitionCues(
  clip: Clip,
  layer: SoundLayer,
  ctx: AudioCtx,
  sink: AudioSink,
  track: Track,
): void {
  const tr = layer.phase === "in" ? transitionAtHead(track, clip.id) : transitionAtTail(track, clip.id);
  if (!tr) return;
  const span = transitionSpan(track, tr);
  if (!span) return; // orphaned — the timeline reconciles it away
  const at = cueTimeFor(layer, span.startMs, span.endMs - span.startMs, tr.easing);
  const seed = hashSeed(tr.id, Math.round(at));
  pushCue(sink, ctx, clip, layer, oneShot(clip, layer, at - clip.startMs, seed), at, at - clip.startMs, seed);
}

/**
 * One hit each time this BODY starts touching something — the ball on the
 * ring, the domino on the floor — read off the simulation's stored run, so it
 * lands on the frame they touch. Louder the harder it hits; under `minSpeed`
 * it is resting or rolling, and silent. The anchor has nothing to pick (a
 * contact is an instant); the offset still nudges.
 *
 * The comp's whole {@link hitScore} decides each firing — which survive the
 * voice limit, which note, how built-up — so this only places this entry's
 * share of it in output time.
 */
function emitHitCues(doc: MotionDocument, clip: Clip, layer: SoundLayer, ctx: AudioCtx, sink: AudioSink): void {
  const scores = sink.scores ?? (sink.scores = new Map());
  let score = scores.get(clip.frameId);
  if (!score) scores.set(clip.frameId, (score = hitScore(doc, clip.frameId)));
  for (const h of score.get(hitKey(clip.id, layer.id)) ?? []) {
    pushCue(sink, ctx, clip, layer, h.voicing, h.ms, h.ms - clip.startMs, h.seed, h.stream, h.pan);
  }
}

/** One firing of one entry in a comp's hit score, at comp ms (offset applied). */
interface ScoredHit {
  ms: number;
  seed: number;
  voicing: NoteVoicing;
  /** Its group in this comp — what the leveler judges it with. */
  stream: string;
  /** -1..1, where in the frame it struck (a `weight` climax only; else centre). */
  pan?: number;
}

/** A comp's hit score: each hit entry's firings, keyed `clipId|entryId`. */
type HitScore = ReadonlyMap<string, readonly ScoredHit[]>;

const hitKey = (clipId: string, entryId: string) => `${clipId}|${entryId}`;

/** A kit's identity — what its bodies share as one ensemble and one leveled stream. */
const kitKey = (kit: SoundKit) => `kit:${kit.takes.map((t) => t.assetId).join("+")}`;

/** Firings a whole comp ever plays, per settled document. */
const scoreMemo = new WeakMap<MotionDocument, Map<string, HitScore>>();

/**
 * THE HIT SCORE — every collision firing in a comp, decided ONCE for the comp
 * and not per playback window, because three of its answers depend on what
 * came before: a note in a melody is the n-th of its sequence, a climax that
 * follows the scene needs the hit rate up to now, and a voice limit keeps the
 * loudest of a slot. Asked per one-second playback bucket, any of those
 * computed inside the window would restart at every bucket edge.
 *
 * Firings are grouped by the SOUND they share (an asset or pack, and its
 * scale) — the ensemble. A ring of balls all wearing the same set is one
 * ensemble, so it plays one melody, builds as one scene, and is thinned as one
 * instrument: at most {@link VOICES_PER_SLOT} firings start per 45 ms, the
 * hardest, which keeps 256 bodies a roll rather than mush and the audio graph
 * at a few dozen voices. A layer's particles ring it as their own group, one
 * firing per slot (rain, not four hundred clicks a second); a body never rings
 * for a particle that hits it — the emitter's own sound is the one that does.
 */
function hitScore(doc: MotionDocument, frameId: string): HitScore {
  const frozen = isSettledDocument(doc);
  const memo = frozen ? scoreMemo.get(doc)?.get(frameId) : undefined;
  if (memo) return memo;
  const score = scoreComp(doc, frameId);
  if (frozen) {
    let map = scoreMemo.get(doc);
    if (!map) scoreMemo.set(doc, (map = new Map()));
    map.set(frameId, score);
  }
  return score;
}

interface HitEntry {
  clip: VisualClip;
  layer: SoundLayer & { trigger: { kind: "hit" } };
  /** This body's place among the bodies sharing its sound — its note under `order: "body"`. */
  member: number;
  ensemble: string;
  intensity: (clipLocalMs: number) => number;
}

interface Firing {
  entry: HitEntry;
  ms: number;
  speed: number;
  /** Where it struck across the comp, comp units from the centre (body hits). */
  x?: number;
  /** What the limiter ranks by: the entry's level × how hard. */
  loud: number;
}

function scoreComp(doc: MotionDocument, frameId: string): HitScore {
  const byClip = new Map<string, HitEntry[]>();
  const members = new Map<string, Map<string, number>>();
  let end = 0;
  for (const { clip, track } of frameClipEntries(doc, frameId)) {
    if (track.muted || clip.audioMix.muted || !isVisual(clip)) continue;
    const v = clip as VisualClip;
    if (!v.physics && !clip.emitters?.length) continue;
    for (const layer of clip.sounds) {
      if (!layer.enabled || layer.trigger.kind !== "hit") continue;
      const ensemble = `${layer.kit ? kitKey(layer.kit) : (layer.custom?.assetId ?? layer.pack)}|${layer.notes?.scale ?? ""}`;
      const seen = members.get(ensemble) ?? members.set(ensemble, new Map()).get(ensemble)!;
      if (!seen.has(clip.id)) seen.set(clip.id, seen.size);
      const list = byClip.get(clip.id) ?? byClip.set(clip.id, []).get(clip.id)!;
      list.push({ clip: v, layer: layer as HitEntry["layer"], member: seen.get(clip.id)!, ensemble, intensity: soundIntensitySampler(clip, layer) });
      end = Math.max(end, clip.startMs + clip.durationMs);
    }
  }
  const out = new Map<string, ScoredHit[]>();
  if (byClip.size === 0) return out;

  // Raw firings, per group: an ensemble of bodies, or one entry's particles.
  const groups = new Map<string, Firing[]>();
  const fire = (group: string, entry: HitEntry, ms: number, speed: number, x?: number) => {
    const { clip, layer } = entry;
    if (speed < layer.trigger.minSpeed) return;
    const at = ms + layer.offsetMs;
    if (at < clip.startMs || at > clip.startMs + clip.durationMs) return;
    (groups.get(group) ?? groups.set(group, []).get(group)!).push({ entry, ms: at, speed, x, loud: layer.volume * hardness(speed, layer.trigger.minSpeed) });
  };
  const halfWidth = Math.max(1, (doc.frames.find((f) => f.id === frameId)?.width ?? 1920) / 2);
  for (const h of flatHits(doc, frameId, end)) {
    if (h.particle !== undefined) {
      for (const e of byClip.get(h.a) ?? []) if (e.clip.emitters?.length) fire(`p|${hitKey(e.clip.id, e.layer.id)}`, e, h.ms, h.speed);
      continue;
    }
    for (const id of h.b ? [h.a, h.b] : [h.a]) {
      for (const e of byClip.get(id) ?? []) if (e.clip.physics) fire(e.ensemble, e, h.ms, h.speed, h.x);
    }
  }

  for (const [group, raw] of groups) {
    raw.sort((a, b) => a.ms - b.ms);
    const particles = group.startsWith("p|");
    // The scene's busyness at each raw firing (trailing window), and its peak.
    const rate = new Float64Array(raw.length);
    let peak = 0;
    for (let i = 0, j = 0; i < raw.length; i++) {
      while (raw[i]!.ms - raw[j]!.ms >= CLIMAX_WINDOW_MS) j++;
      rate[i] = ((i - j + 1) * 1000) / CLIMAX_WINDOW_MS;
      peak = Math.max(peak, rate[i]!);
    }
    const rated = raw.map((f, i) => ({ ...f, rate: rate[i]! }));
    const kept = limitVoices(rated, particles ? 1 : VOICES_PER_SLOT);
    kept.forEach((f, n) => {
      const { clip, layer } = f.entry;
      const local = f.ms - clip.startMs;
      const auto = layer.trigger.rise === "hits" ? rateIntensity(f.rate, peak) : 0;
      const seed = hashSeed(clip.id, Math.round(f.ms * 8));
      const strength = Math.min(1, Math.max(0, (f.speed - layer.trigger.minSpeed) / Math.max(1, 2000 - layer.trigger.minSpeed)));
      const note: NoteContext = { n, member: particles ? 0 : f.entry.member, strength, seed };
      const i = Math.max(f.entry.intensity(local), auto);
      const v = voiceNote(layer, i, note);
      const key = hitKey(clip.id, layer.id);
      // A `weight` climax places each hit where it struck, the field opening as the scene fills.
      const pan = layer.climb === "weight" && f.x !== undefined ? Math.max(-1, Math.min(1, f.x / halfWidth)) * (0.35 + 0.45 * i) : undefined;
      (out.get(key) ?? out.set(key, []).get(key)!).push({ ms: f.ms, seed, stream: `${frameId}|${group}`, pan, voicing: { ...v, volume: v.volume * hardness(f.speed, layer.trigger.minSpeed) } });
    });
  }
  return out;
}

/** A tap at the threshold is a third as loud as a slam (2000 units/s and up). */
function hardness(speed: number, minSpeed: number): number {
  return Math.min(1, 0.33 + (0.67 * (speed - minSpeed)) / Math.max(1, 2000 - minSpeed));
}

/** Fallback curve when an event has no easing of its own to peak against. */
const LINEAR_EASING: Easing = { kind: "linear" };

/**
 * Dispatch a clip's whole sound stack. THE seam: a new trigger kind is one arm
 * here and one arm in `soundTriggerSchema`, and every surface that reads cues
 * (live playback, the export bake, the waveform overlay) gets it for free.
 */
function emitStack(doc: MotionDocument, clip: Clip, ctx: AudioCtx, sink: AudioSink, track: Track | null): void {
  if (!sink.cues || clip.audioMix.muted || clip.sounds.length === 0) return;
  for (const layer of clip.sounds) {
    if (!layer.enabled) continue;
    switch (layer.trigger.kind) {
      case "text":
        if (clip.kind === "text") emitTextCues(clip, layer, ctx, sink);
        break;
      case "layer":
        emitLayerCues(clip, layer, ctx, sink);
        break;
      case "transition":
        if (track) emitTransitionCues(clip, layer, ctx, sink, track);
        break;
      case "hit":
        emitHitCues(doc, clip, layer, ctx, sink);
        break;
    }
  }
}

/**
 * Which triggers this clip can actually offer — the ONE capability predicate
 * the Sound tab's "add sound" menu reads.
 *
 * Capability, not current state: `layer` is offered on any visual clip even
 * before it has an in-animation, because the natural order of work is "add the
 * sound, then add the motion". `text` is text-only because there are no units
 * otherwise, and `transition` needs a lane to look for a seam on.
 */
export function availableTriggers(clip: Clip, track?: Track | null): SoundTriggerKind[] {
  const out: SoundTriggerKind[] = [];
  if (clip.kind === "text") out.push("text");
  if (isVisual(clip)) out.push("layer");
  if (track) out.push("transition");
  if (isVisual(clip) && ((clip as VisualClip).physics || clip.emitters?.length)) out.push("hit");
  return out;
}

/**
 * Why a sound on this layer can never fire, or null when it can — what a
 * write of `sounds` and an export say, so a sound that rides nothing is named
 * instead of mixing to silence without a word. Each arm reads the rule its
 * emitter above uses; an off sound is off on purpose and is not reported.
 */
export function soundSilenceReason(clip: Clip, layer: SoundLayer): string | null {
  if (!layer.enabled) return null;
  switch (layer.trigger.kind) {
    case "layer": {
      if (!isVisual(clip)) return "the layer trigger rides a visual layer's in/out animation";
      const spec = layer.phase === "in" ? (clip as VisualClip).animIn : (clip as VisualClip).animOut;
      return spec
        ? null
        : `it rides "${clip.name}"'s ${layer.phase} animation, and the layer has none (keyframes are not an ${layer.phase} animation). Give it one (animIn / animOut), or place the sound itself as an audio layer at the moment you want.`;
    }
    case "text":
      return clip.kind === "text" ? null : "the text trigger fires per character of a text layer, and this is not one";
    case "hit":
      return isVisual(clip) && ((clip as VisualClip).physics || clip.emitters?.length) ? null : "it fires when a body or a particle hits something, and this layer is neither";
    case "transition":
      return null;
  }
}

/** Every sound on these layers that can never fire, with why. */
export function silentSounds(clips: readonly Clip[]): Array<{ layer: string; sound: string; why: string }> {
  const out: Array<{ layer: string; sound: string; why: string }> = [];
  for (const clip of clips) {
    for (const s of clip.sounds) {
      const why = soundSilenceReason(clip, s);
      if (why) out.push({ layer: clip.name, sound: s.custom ? `custom ${s.custom.assetId}` : s.pack, why });
    }
  }
  return out;
}

/** Does this clip fire any sound on this phase? (What the IN/OUT tabs badge.) */
export function clipSoundsOnPhase(clip: Clip, phase: SoundPhase): SoundLayer[] {
  return clip.sounds.filter((s) => s.phase === phase);
}

function emitPackCues(clip: AudioClip, pack: SoundPackId, ctx: AudioCtx, sink: AudioSink): void {
  if (!sink.cues || clip.audioMix.muted) return;
  const interval = clip.repeatEveryMs;
  const times: number[] = [];
  if (interval && interval > 0) {
    for (let t = clip.startMs; t < clip.startMs + clip.durationMs; t += interval) times.push(t);
  } else {
    times.push(clip.startMs);
  }
  for (const local of times) {
    if (local < ctx.winFrom || local > ctx.winTo) continue;
    const t = ctx.a + ctx.b * local;
    if (t < sink.fromMs || t >= sink.toMs) continue;
    // The full envelope at this trigger (keyframes × edge fades), so a repeating
    // pack clip fades in/out and follows its volume automation.
    sink.cues.push({
      timeMs: t,
      pack,
      volume: audioGainAt(clip, local - clip.startMs) * ctx.gain * mixGainAt(clip, local - clip.startMs),
      randomness: 0,
      pitch: 1,
      bright: 0.5,
      weight: 0,
      seed: hashSeed(clip.id, Math.round(local)),
      clipId: clip.id,
      stream: clip.id,
      bus: routeOf(clip, ctx, "cue"),
      path: ctx.path,
    });
  }
}

function emitMediaSegment(
  clip: AudioClip | VideoClip,
  assetId: string,
  ctx: AudioCtx,
  sink: AudioSink,
  track: Track,
): void {
  if (!sink.media || clip.audioMix.muted) return;
  const speed = clip.playback.speed || 1;
  const localStart = clip.startMs;
  const localEnd = clip.startMs + clip.durationMs;
  // Clip the clip's span to the ancestor-visible window (a nested comp only
  // exposes the slice of its media the parent clip reveals).
  const vFrom = Math.max(localStart, ctx.winFrom);
  const vTo = Math.min(localEnd, ctx.winTo);
  if (vTo <= vFrom) return;
  const outStart = ctx.a + ctx.b * vFrom;
  const outDur = ctx.b * (vTo - vFrom);
  if (outDur <= 0.001) return;
  sink.media.push({
    assetId,
    atMs: outStart,
    // Content skipped at the front (window start past the clip start) advances
    // the in-point by that wall time × the clip's own speed.
    trimInMs: clip.trimInMs + (vFrom - localStart) * speed,
    outputDurationMs: outDur,
    // Tape-style: ancestor nested speed compresses wall time, so the buffer
    // plays faster to fit — cumulative with the clip's own speed.
    speed: speed * ctx.speedScale,
    loop: clip.playback.loop,
    clip,
    gainScale: ctx.gain * mixGainAt(clip, vFrom - clip.startMs),
    bus: routeOf(clip, ctx, "media"),
    path: ctx.path,
    track,
  });
}

// ── Public entry points ──────────────────────────────────────────────────────

/**
 * All sound cues in [fromMs, toMs): text typing sounds (per in-animation unit,
 * with per-range overrides) and pack audio clips (one-shot or repeating).
 * Pass `frameId` to scope + recurse into that composition (nested comps fold
 * in through their time-remap); omit it for a flat sweep of every frame's clips
 * (used by tooling that isn't comp-scoped).
 */
export function buildSoundCues(
  doc: MotionDocument,
  fromMs: number,
  toMs: number,
  frameId?: string,
): SoundCue[] {
  const cues: SoundCue[] = [];
  const sink: AudioSink = { cues, fromMs, toMs };
  if (frameId === undefined) {
    for (const track of doc.tracks) {
      if (track.muted) continue;
      for (const clip of track.clips) {
        emitStack(doc, clip, TOP, sink, track);
        if (clip.kind === "audio" && clip.source.type === "pack") {
          emitPackCues(clip, clip.source.pack, TOP, sink);
        }
      }
    }
  } else {
    walkComp(doc, frameId, TOP, new Set(), sink);
  }
  cues.sort((a, b) => a.timeMs - b.timeMs);
  return cues;
}

/**
 * Every continuous media segment audible in a comp (asset-audio + unmuted
 * video), recursively through nested comps, resolved to output time. The app
 * decodes each `assetId` and schedules a buffer source per segment.
 */
export function collectCompMedia(doc: MotionDocument, frameId: string): readonly MediaAudioSegment[] {
  // A pure function of the document, asked on EVERY playback tick by the
  // conductor — memoised per FROZEN document (the `scopeIndex` rule), so a
  // tick reads a list instead of re-walking the project. Shared: read-only.
  const frozen = isSettledDocument(doc);
  const perDoc = frozen ? mediaMemo.get(doc) : undefined;
  const hit = perDoc?.get(frameId);
  if (hit) return hit;
  const media: MediaAudioSegment[] = [];
  walkComp(doc, frameId, TOP, new Set(), { media, fromMs: -Infinity, toMs: Infinity });
  if (frozen) {
    let map = perDoc;
    if (!map) mediaMemo.set(doc, (map = new Map()));
    map.set(frameId, media);
  }
  return media;
}

const mediaMemo = new WeakMap<MotionDocument, Map<string, MediaAudioSegment[]>>();

/** An audio clip found INSIDE a container (nested/component) clip, with a
 * readable trail of frame names from the container down to it. */
export interface ContainedAudio {
  clip: AudioClip;
  /** e.g. ["Scene 2", "Dialogue"] — the frames walked to reach the clip. */
  framePath: string[];
}

/**
 * Every audio clip reachable INSIDE a container clip (a nested comp OR a
 * component instance — both are `nested` clips), recursively through further
 * nesting. The returned `clip` is the REAL clip object in the doc, so a surface
 * (the inspector) can edit it in place through `useClipUpdater(clip.id)` — the
 * voice controls of a buried clip surface on the container with NO copy and no
 * re-implemented UI. Cycle-guarded. Returns [] for non-container clips.
 */
export function collectContainedAudioClips(
  doc: MotionDocument,
  containerClip: Clip,
): ContainedAudio[] {
  if (containerClip.kind !== "nested") return [];
  const out: ContainedAudio[] = [];
  const guard = new Set<string>();
  const frameName = (id: string) => doc.frames.find((f) => f.id === id)?.name ?? "Comp";
  const walk = (frameId: string, path: string[]) => {
    if (guard.has(frameId)) return;
    guard.add(frameId);
    try {
      for (const track of doc.tracks) {
        for (const clip of track.clips) {
          if (clip.frameId !== frameId) continue;
          if (clip.kind === "audio") out.push({ clip, framePath: path });
          else if (clip.kind === "nested") walk(clip.sourceFrameId, [...path, frameName(clip.sourceFrameId)]);
        }
      }
    } finally {
      guard.delete(frameId);
    }
  };
  walk(containerClip.sourceFrameId, [frameName(containerClip.sourceFrameId)]);
  return out;
}

// ── Detection (the "is there sound?" question every surface asks) ────────────

/**
 * Does this ONE clip contribute sound? Capability, not audibility: any enabled
 * entry in its sound stack, any audio clip, an unmuted video, or a nested comp
 * whose source contains sound. `audioMix.muted` is intentionally NOT considered
 * so the Sound tab / icon still appear (you can un-mute there); export
 * detection layers mute on top via {@link compHasAudio}.
 */
export function clipHasSound(doc: MotionDocument, clip: Clip, guard = new Set<string>()): boolean {
  // One question, asked of the stack, for every kind — including the ranges
  // that can re-enable a layer the clip itself switched off.
  if (clip.sounds.some((s) => s.enabled)) return true;
  if (clip.kind === "text" && clip.ranges.some((r) => Object.values(r.sounds).some((o) => o.enabled))) {
    return true;
  }
  switch (clip.kind) {
    case "audio":
      return true;
    case "video":
      return !clip.muted && clip.volume > 0.001;
    case "nested":
      return frameHasAudio(doc, clip.sourceFrameId, guard);
    default:
      return false;
  }
}

/** Does this composition draw anything visible (recursively)? A nested child is
 * transparent about its OWN contents (we recurse into it), so a comp of only
 * audio + audio-only sub-comps reports false. Hidden clips don't count. */
export function frameHasVisual(
  doc: MotionDocument,
  frameId: string,
  guard = new Set<string>(),
): boolean {
  if (guard.has(frameId)) return false;
  guard.add(frameId);
  try {
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if (clip.frameId !== frameId || clip.hidden) continue;
        if (clip.kind === "nested") {
          if (frameHasVisual(doc, clip.sourceFrameId, guard)) return true;
        } else if (isVisualClip(clip)) return true;
      }
    }
    return false;
  } finally {
    guard.delete(frameId);
  }
}

/**
 * A nested clip whose comp makes sound but draws NOTHING visible — so every
 * surface can treat it AS audio (audio-styled clip + waves on the timeline, the
 * unified Sound panel in the sidebar) with no second clip kind. THE one headless
 * predicate; video-nested and audio-nested are the same `nested` kind, told
 * apart only by capability.
 */
export function nestedIsAudioOnly(doc: MotionDocument, clip: Clip): boolean {
  return (
    clip.kind === "nested" &&
    frameHasAudio(doc, clip.sourceFrameId) &&
    !frameHasVisual(doc, clip.sourceFrameId)
  );
}

/** Does any clip in this composition make sound (recursively)? */
function isStill(doc: MotionDocument, frameId: string): boolean {
  return doc.frames.find((f) => f.id === frameId)?.mode === "static";
}

export function frameHasAudio(
  doc: MotionDocument,
  frameId: string,
  guard = new Set<string>(),
): boolean {
  if (isStill(doc, frameId)) return false;
  if (guard.has(frameId)) return false;
  guard.add(frameId);
  try {
    for (const track of doc.tracks) {
      if (track.muted) continue;
      for (const clip of track.clips) {
        if (clip.frameId !== frameId) continue;
        if (clipHasSound(doc, clip, guard)) return true;
      }
    }
    return false;
  } finally {
    guard.delete(frameId);
  }
}

/** Does any of these clips carry sound (mute-aware — for the "include sound" gate)? */
export function compHasAudio(doc: MotionDocument, clips: Clip[]): boolean {
  for (const clip of clips) {
    if (clip.audioMix.muted) continue;
    if (clipHasSound(doc, clip)) return true;
  }
  return false;
}

// ── Unified sound control descriptor (the one the Sound inspector binds to) ──

export interface ClipSoundControl {
  /** Keyframe path for the volume knob (kind-specific: native where it exists). */
  volumePath: string;
  /** Current base volume. */
  volume: number;
  /** Full-scale value for the knob (1 for video, 4 for the master fader). */
  maxVolume: number;
  /** Whether the clip is currently silenced, and where that flag lives. */
  muted: boolean;
  muteField: "muted" | "audioMix.muted";
}

/**
 * The ONE headless descriptor the universal Sound inspector reads: which volume
 * path to bind a keyframable knob to, and where mute lives. Video edits its
 * native `volume`; everything else (nested comps, future kinds) uses the
 * universal `audioMix`. Returns null when the clip can't carry sound.
 */
export function clipSoundControl(doc: MotionDocument, clip: Clip): ClipSoundControl | null {
  if (!clipHasSound(doc, clip)) return null;
  if (clip.kind === "video") {
    return { volumePath: "volume", volume: clip.volume, maxVolume: 1, muted: clip.muted, muteField: "muted" };
  }
  if (clip.kind === "audio") {
    return { volumePath: "gain", volume: clip.gain, maxVolume: 4, muted: clip.audioMix.muted, muteField: "audioMix.muted" };
  }
  return {
    volumePath: "audioMix.volume",
    volume: clip.audioMix.volume,
    maxVolume: 4,
    muted: clip.audioMix.muted,
    muteField: "audioMix.muted",
  };
}

/** Small deterministic hash so randomized volumes replay identically. */
function hashSeed(id: string, n: number): number {
  let h = 2166136261 ^ n;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}


/**
 * The CROSSFADE factor a segment carries at a clip-local time — 1 when no cut
 * transition touches it. Kept as its own multiplier (never folded into the
 * envelope or `gainScale`) for the same reason the fade handles are: it
 * composes with the clip's gain automation instead of overwriting it, so a
 * crossfade can be added and removed without touching a single keyframe.
 *
 * The one function the live conductor, the waveform overlay and the exporter
 * all read, so a crossfade sounds identical in all three by construction.
 */
/**
 * The clip-local instant `localOutMs` into a segment's output plays — through
 * the segment's cumulative speed and the clip's own trim and speed. What the
 * live conductor and the exporter both sample a clip's envelope and effects
 * at, so the two cannot drift.
 */
export function segmentClipLocalMs(seg: MediaAudioSegment, localOutMs: number): number {
  const clipSpeed = (seg.clip.kind === "audio" ? seg.clip.playback.speed : 1) || 1;
  const sourceMs = seg.trimInMs + Math.max(0, localOutMs) * seg.speed;
  const clipTrim = seg.clip.kind === "audio" ? seg.clip.trimInMs : 0;
  return (sourceMs - clipTrim) / clipSpeed;
}

export function segmentCrossfadeAt(seg: MediaAudioSegment, clipLocalMs: number): number {
  if (!seg.track.transitions.length) return 1;
  return crossfadeFactorAt(seg.track, seg.clip, seg.clip.startMs + clipLocalMs);
}

/** Does any cut transition touch this segment at all? (Skips curve building.) */
export function segmentHasCrossfade(seg: MediaAudioSegment): boolean {
  return seg.track.transitions.some((t) => t.aClipId === seg.clip.id || t.bClipId === seg.clip.id);
}
