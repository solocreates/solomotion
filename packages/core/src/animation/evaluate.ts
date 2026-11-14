import { evaluateEasing } from "../easing";
import { sampledScaleY } from "./uniform-scale";
import { FREEZE_EPSILON, curveRateAt, retimedSourceMs, wallTimeForSourceMs, type SpeedCurve } from "./retime";
import type { AnchorPoint, AnimationSpec, AnimationUnit, CaptionCue, Clip, ClipPlayback, KeyframeValue, TextClip, Track } from "../schema";
import { rangeAt } from "../text/ranges";
import { digitArrivals, formatNumber, mapSpanThroughCount, numberAlignedView, spanProgress, type DigitArrival } from "../text/count-up";
import { segmentTextCached, unitCountOf, unitIndexOf, unitTextOf, type TextSegmentation } from "../text/segment";
export { segmentTextCached } from "../text/segment";
import { cueBlendAt, cueEnteredAt } from "../captions";
import {
  animationSpanMs,
  buildTextTimeline,
  cohortIndex,
  epochAt,
  hash01,
  unitSeed,
  unitStartMs,
  type TextContentKey,
  type TextEpoch,
  type TextTimeline,
} from "../text/schedule";
import { GLYPH_IDENTITY, getPreset, type GlyphVisual } from "./presets";
import {
  sampleKeyframes,
  sampleKeyframeTrack,
  sampleNumber,
  sampleRangeStyles,
  type RangeStyleSample,
} from "./keyframes";

/**
 * Content timelines, memoised per clip object against a CONTENT signature.
 *
 * Identity alone would be wrong: the store hands out fresh clips on edit
 * (immer), but core itself edits clips in place — `setKeyframe`, template
 * application — and a stale schedule would then describe text that is no longer
 * there. The signature is the clip's string, its span and its content keys,
 * which is exactly the input the schedule is built from and nothing more, so it
 * cannot go stale and cannot rebuild for an unrelated change (a moved layer, a
 * recoloured word). Content-key tracks hold a handful of keys, so folding them
 * per frame costs far less than the segmentation it saves.
 */
interface TimelineCacheEntry {
  sig: string;
  timeline: TextTimeline;
}
const timelineCache = new WeakMap<TextClip, TimelineCacheEntry>();

/**
 * THE content schedule of a text clip: which string is on screen when, and the
 * lifespan of every glyph inside it. Everything about keyframed text content —
 * the string to lay out, which glyphs are arriving vs leaving, when the clicks
 * fire — derives from this one build. See `text/schedule.ts`.
 */
export function textTimelineOf(clip: TextClip): TextTimeline {
  const track = clip.keyframes.find((t) => !t.range && t.property === "text");
  const keys: TextContentKey[] = [];
  // The signature covers everything the timeline reads — easings and number
  // settings too, since a count rides the key's curve.
  let sig = `${clip.durationMs}\u0000${clip.text}\u0000${JSON.stringify(clip.countUps ?? [])}`;
  for (const k of track?.keys ?? []) {
    if (typeof k.value !== "string") continue;
    keys.push({ timeMs: k.timeMs, text: k.value, easing: k.easing });
    sig += `\u0000${k.timeMs}\u0000${k.value}\u0000${JSON.stringify(k.easing)}`;
  }
  const hit = timelineCache.get(clip);
  if (hit && hit.sig === sig) return hit.timeline;
  const timeline = buildTextTimeline(clip.text, keys, clip.durationMs, clip.countUps);
  timelineCache.set(clip, { sig, timeline });
  return timeline;
}

/**
 * The epoch every content read goes through: the counted view while a number
 * counts — except for the clip being EDITED, which reads its keyed epoch
 * everywhere (text, ranges, glyph schedule, caret), so what you type, what the
 * box shows and what the canvas draws are one string.
 */
function contentEpoch(clip: TextClip, localMs: number): TextEpoch {
  const e = epochAt(textTimelineOf(clip), localMs);
  if (!e.view) return e;
  const raw = textTimelineOf(clip).epochs[e.index]!;
  if (keyedEditing.has(clip.id)) return raw;
  return withDigitArrivals(clip, raw, e, localMs);
}

/**
 * A COUNTING NUMBER PLAYS THE TEXT'S IN-ANIMATION AS IT CHANGES — the layer's,
 * or the range's covering the number, whichever the digit reads.
 *
 * Letter-grained, each digit re-arrives when it changes (the ones every tick,
 * the tens when they roll over); word- or line-grained, the whole number
 * re-arrives each time its value changes. A change only re-plays when the
 * value before it was on screen at least as long as the animation lasts —
 * otherwise a fast count would restart a fade every frame and the number would
 * never be visible. So a quick count snaps, and as the curve slows toward its
 * key the last values animate in.
 */
function withDigitArrivals(clip: TextClip, raw: TextEpoch, view: TextEpoch, localMs: number): TextEpoch {
  const count = raw.count;
  const counted = view.view;
  if (!count || !counted) return view;
  const sorted = [...count.spans].sort((a, b) => a.from.start - b.from.start);
  let enterAtMs: number[] | null = null;
  counted.slots.forEach((slot, k) => {
    const span = sorted[k];
    if (!span) return;
    const spec = inSpecForGrapheme(clip, slot.srcStart);
    if (!spec || spec.durationMs <= 0) return;
    const arrivals = digitArrivals(span, count.fromMs, count.toMs, localMs, evaluateEasing);
    const settled = (a: DigitArrival) => a.changedAtMs !== null && a.heldMs >= spec.durationMs;
    enterAtMs ??= view.enterAtMs.slice();
    if (spec.unit === "letter") {
      arrivals.forEach((a, j) => {
        if (settled(a)) enterAtMs![slot.start + j] = Math.max(enterAtMs![slot.start + j]!, a.changedAtMs!);
      });
    } else {
      // The number changed when its smallest place did — its last character.
      const last = arrivals[arrivals.length - 1];
      if (last && settled(last)) for (let j = slot.start; j < slot.end; j++) enterAtMs[j] = Math.max(enterAtMs[j]!, last.changedAtMs!);
    }
  });
  if (!enterAtMs) return view;
  const key = (enterAtMs as number[]).join(",");
  const cached = arrivalCache.get(view);
  if (cached && cached.key === key) return cached.epoch;
  const epoch: TextEpoch = { ...view, enterAtMs, cohorts: new Map() };
  arrivalCache.set(view, { key, epoch });
  return epoch;
}

const arrivalCache = new WeakMap<TextEpoch, { key: string; epoch: TextEpoch }>();

/**
 * Clips being EDITED right now (the inline editor registers while open).
 */
const keyedEditing = new Set<string>();
export function setKeyedEditing(clipId: string | null): void {
  keyedEditing.clear();
  if (clipId) keyedEditing.add(clipId);
}

/**
 * The text a clip shows at a clip-relative time. When the `text` property is
 * keyframed, content is held between keys (discrete — text doesn't tween);
 * otherwise it's the clip's base string. Layout, glyph animation, hit-testing
 * and export all read this, so keyframed content is frame-accurate everywhere.
 *
 * Derived from the same epoch timeline the glyph animator and the audio cue
 * walker read, so "what is on screen" and "what is animating/clicking" cannot
 * disagree — which is precisely how keyframed text used to go silent.
 */
export function effectiveText(clip: TextClip, localMs: number): string {
  return contentEpoch(clip, localMs).text;
}

/**
 * The content AS KEYED at an instant — the held key's own string, never a
 * number mid-count. What an editor edits: typing writes the key, so the box
 * must show the key. Showing the counted string instead made the caret index
 * into a string that is not stored anywhere, and "20" typed as "02".
 */
export function keyedText(clip: TextClip, localMs: number): string {
  const e = epochAt(textTimelineOf(clip), localMs);
  return e.view ? textTimelineOf(clip).epochs[e.index]!.text : e.text;
}

/**
 * Half-open end tolerance for clipLocalTime: gapless-clip `startMs` values
 * accumulate float noise across edits (e.g. rippled/repacked flipbook rows),
 * so a boundary that SHOULD be exact can land a fraction of a millisecond
 * off. 1e-6ms is many orders below anything a real edit could produce
 * (frame steps run 16-42ms) but comfortably above float64 noise at these
 * magnitudes — so it absorbs drift already baked into existing documents,
 * not just future edits.
 */
const CLIP_END_EPS = 1e-6;

/**
 * Clip-relative time, or null when the playhead is outside the clip. Half-open
 * at the end ([start, start+duration)) — same convention as `rowCellAt` — so
 * two gapless, adjacent clips (e.g. flipbook cells on one row) never both
 * claim the exact boundary instant between them.
 */
export function clipLocalTime(clip: Clip, timeMs: number): number | null {
  const local = timeMs - clip.startMs;
  if (local < 0 || local >= clip.durationMs - CLIP_END_EPS) return null;
  return local;
}

/** Sub-frame tolerance for "this instant IS that edge" (times are stored to 3dp). */
const EDGE_EPS_MS = 0.001;

function endsAt(clip: Clip, t: number): boolean {
  return Math.abs(t - (clip.startMs + clip.durationMs)) <= EDGE_EPS_MS;
}

/**
 * A LAYER'S OWN FRAME RATE, applied: the instant its picture is showing at
 * clip-local `local`. With `clip.fps` set, time advances in whole frames of
 * that rate counted from the clip's start, and each picture HOLDS until the
 * next — so any rate works (7.5, 0.5, 1/3): there is never an instant with no
 * picture, only the last one that started. Null follows the comp, untouched.
 *
 * Applied where a clip is RENDERED and its media CONDUCTED
 * (`clipRenderLocalTime`) — never where it is selected or hit-tested, which
 * stay continuous: stepping is how a layer looks, not where it is.
 */
export function clipFrameTime(clip: Clip, local: number): number {
  const fps = clip.kind === "audio" ? null : clip.fps;
  if (!fps) return local;
  const step = 1000 / fps;
  return Math.floor(local / step + 1e-6) * step;
}

/**
 * The nearest instant at which the clip actually EXISTS — `timeMs` when it is
 * already inside the clip's span, otherwise the closest edge that is.
 *
 * `clipLocalTime` answers "is this clip live?" and correctly returns null when
 * it isn't. But a surface whose whole job is to SHOW one clip — the effect
 * editor's preview, a library thumbnail, a poster frame — has no use for null:
 * the honest answer renders an empty transparent frame, which is technically
 * right and completely useless. Those callers want "show it at a moment where
 * there is something to show", and that is one definition, here, rather than a
 * clamp re-derived (slightly differently) in each of them.
 *
 * Held one `fps` frame inside the out point because the span is half-open, so
 * the result always satisfies `clipLocalTime(clip, t) !== null`.
 */
export function clipRepresentativeTime(clip: Clip, timeMs: number, fps: number): number {
  const frameMs = 1000 / Math.max(1, fps);
  const start = clip.startMs;
  const lastFrame = Math.max(start, start + clip.durationMs - frameMs);
  return Math.min(Math.max(timeMs, start), lastFrame);
}

/** Clip kinds that HOLD a frame across timeline gaps — footage a montage should
 * never flash to nothing between shots. Overlays (text/shape/path/image/…) keep
 * honest transparency in gaps, so a layer meant to disappear still does. */
function fillsGaps(clip: Clip): boolean {
  return clip.kind === "video";
}

export interface ClipRenderTime {
  /** Clip-local time to render / conduct media at. */
  local: number;
  /** True when this is a HELD gap-fill frame (a still), not a live clip instant.
   * Media conducts a held frame as PAUSED (exact seek + freeze), never rolling. */
  held: boolean;
}

/**
 * The clip-local time to RENDER (and conduct media for) a clip at track time
 * `t`, INCLUDING a held frame when a footage clip should fill an adjacent gap so
 * a montage never flashes transparent between shots. Null when the clip shows
 * nothing.
 *
 *  - Inside the clip → its real local time (`held: false`).
 *  - In an INTERNAL GAP on this track — one with footage on BOTH sides and no
 *    clip active — the next clip shows its FIRST frame across it, so a montage
 *    never flashes transparent between shots. Everything else is transparent.
 *
 * A GAP IS BOUNDED. That is the whole rule, and getting it wrong is what made
 * "my video won't turn off" a bug: the last footage clip on a lane used to hold
 * its final frame past its own end, forever, to the end of the comp. But past
 * the last clip there is no gap — there is nothing, and a clip that has ended
 * has ended. Trimming a clip's tail meant nothing, `loop: "once"` meant nothing,
 * and the only way to make footage stop was to hide the layer. The region before
 * the FIRST clip was already transparent for exactly this reason; the tail is
 * the same fact at the other end.
 *
 * Render + conduct ONLY: selection, hit-testing and the timeline keep using
 * `clipLocalTime`, so a held gap frame is shown but never selectable or "active".
 */
export function clipRenderLocalTime(
  track: Track,
  clip: Clip,
  t: number,
  /**
   * THE CUT BELONGS TO THE SELECTION — preview only, never export. A clip's
   * window is [start, end), so on the exact instant one clip ends and the next
   * begins the stage shows the incoming one. But a keyframe can sit ON a
   * clip's last instant, and editing it while the stage paints the neighbour
   * is editing blind. Clips named here own their end instant: they hold their
   * final pose on it, and a clip on the same track that starts there yields.
   */
  ownsEnd?: ReadonlySet<string> | null,
): ClipRenderTime | null {
  if (ownsEnd && ownsEnd.size > 0) {
    if (ownsEnd.has(clip.id) && endsAt(clip, t)) return { local: clipFrameTime(clip, clip.durationMs), held: false };
    if (Math.abs(t - clip.startMs) <= EDGE_EPS_MS) {
      for (const c of track.clips) if (c !== clip && ownsEnd.has(c.id) && !c.hidden && endsAt(c, t)) return null;
    }
  }
  const active = clipLocalTime(clip, t);
  if (active !== null) return { local: clipFrameTime(clip, active), held: false };
  if (!fillsGaps(clip)) return null;
  // Not the gap-filler if any clip on THIS track is actually playing right now.
  for (const c of track.clips) {
    if (!c.hidden && clipLocalTime(c, t) !== null) return null;
  }
  // Only a gap BEFORE this clip can be filled, and only by its first frame.
  // Past a clip's end there is no gap to fill — see the header.
  if (t >= clip.startMs) return null;
  // Fill only an INTERNAL gap (a footage clip ends at or before t) and only
  // with the NEXT clip (no footage clip starts between t and this one).
  let hasPrev = false;
  let isNext = true;
  for (const c of track.clips) {
    if (c === clip || c.hidden || !fillsGaps(c)) continue;
    if (c.startMs + c.durationMs <= t) hasPrev = true;
    if (c.startMs > t && c.startMs < clip.startMs) isNext = false;
  }
  return hasPrev && isNext ? { local: 0, held: true } : null;
}

/**
 * WHERE a source-backed clip is in its source, and WHICH PASS it is on.
 *
 * `sourceTimeAt` (below) answers only the first half, and for a long time that
 * was all anything asked. But "which pass" is the other half of the same fact
 * — a looping clip on its third repeat, a ping-pong clip running backwards, a
 * play-once clip that has run out and is holding its last frame — and every
 * surface that wants to SHOW playback rather than merely sample it needs it:
 * the timeline's cycle ticks, the poster strip's repeat boundaries, the
 * "frozen tail" shading. Deriving it a second time from `playback` in each of
 * those places is how they would disagree about where a cycle ends, so the
 * wrap arithmetic is written once, here, and `sourceTimeAt` is a projection of
 * it.
 */
export interface SourcePhase {
  /** Time into the source (before trim-in is added back by the clip layer). */
  sourceMs: number;
  /**
   * How many complete passes over the source came before this instant. A
   * ping-pong pass counts each traversal, so 0 is forwards, 1 is the way back.
   * Always 0 when the clip does not repeat.
   */
  cycleIndex: number;
  /**
   * The source is NOT ADVANCING at this instant — the picture here is the same
   * one as a moment ago and will be a moment from now.
   *
   * Defined as "not advancing" rather than "ran out" on purpose. Today the
   * first cause was a play-once clip past the end of its source, and that is
   * exactly the state a user needs to see marked, because nothing else on the
   * clip says "this half isn't moving". The FREEZE shipped as predicted and
   * needed no new branch: a rate of 0 stops the integral, so the source stops
   * advancing and this goes true through the same test. Anything else that
   * holds a frame should arrive the same way.
   */
  held: boolean;
}

export function sourcePhaseAt(
  localMs: number,
  sourceDurationMs: number,
  playback: ClipPlayback,
  /**
   * The clip's integrated SPEED CURVE, when its speed is animated. Optional so
   * the primitive stays callable from places that hold a playback and no clip
   * (the waveform painter's inner loop, a preset preview); `clipSourcePhaseAt`
   * is the clip-aware door and passes it for every surface in the app.
   */
  curve?: SpeedCurve | null,
): SourcePhase {
  // Constant speed is `t × rate`; an animated speed is the area under the rate
  // curve up to `t`. The first is the second's special case, which is why a
  // clip with no speed keys takes the identical path it always did.
  const scaled = curve
    ? Math.max(0, retimedSourceMs(curve, Math.max(0, localMs)))
    : Math.max(0, localMs) * (playback.speed > 0 ? playback.speed : 1);
  /*
   * IS THE SOURCE ADVANCING RIGHT NOW?
   *
   * `held` used to have one cause (a play-once clip past its media) and it was
   * enough, because that was the only way to stop. A rate of zero is the other
   * way, and it must answer the same question — not as decoration but because
   * the TRANSPORT reads this: a held element is parked on the frame it is
   * already showing rather than rolled at a crawling playbackRate. That is the
   * difference between a real freeze frame and a very slow one, and it is also
   * what makes resuming free (the element is already on the right frame, so
   * there is nothing to seek).
   */
  const stalled = !!curve && Math.abs(curveRateAt(curve, Math.max(0, localMs))) < FREEZE_EPSILON;
  // No known duration (asset metadata still loading) — nothing to wrap around,
  // so the source runs unbounded and there are no passes to count.
  if (sourceDurationMs <= 0) return { sourceMs: scaled, cycleIndex: 0, held: stalled };
  let t: number;
  let cycleIndex = 0;
  let held = false;
  switch (playback.loop) {
    case "loop":
      cycleIndex = Math.floor(scaled / sourceDurationMs);
      t = scaled % sourceDurationMs;
      break;
    case "pingpong": {
      const period = sourceDurationMs * 2;
      const p = scaled % period;
      cycleIndex = Math.floor(scaled / sourceDurationMs);
      t = p <= sourceDurationMs ? p : period - p;
      break;
    }
    default:
      held = scaled > sourceDurationMs;
      t = Math.min(scaled, sourceDurationMs);
  }
  // Reverse mirrors the mapped source time about the source span — for
  // pingpong (already symmetric) the mirror is just a phase shift, still valid.
  return { sourceMs: playback.reverse ? sourceDurationMs - t : t, cycleIndex, held: held || stalled };
}

/**
 * Map a clip-local time to a time INTO the clip's source, honoring speed and
 * loop mode — THE reusable primitive for every source-backed clip: nested
 * comps, video, audio and animated images. Given how long since the clip
 * started and the source's intrinsic duration, it returns where to sample/seek
 * the source. A projection of {@link sourcePhaseAt}, so the two can never part.
 */
export function sourceTimeAt(
  localMs: number,
  sourceDurationMs: number,
  playback: ClipPlayback,
  curve?: SpeedCurve | null,
): number {
  return sourcePhaseAt(localMs, sourceDurationMs, playback, curve).sourceMs;
}

/**
 * The SOURCE-space span `sourceTimeAt` should wrap over: the clip's explicit
 * loop-cycle override (wall-clock, converted through speed), or the natural
 * source span when unset. The one seam every clip kind's loop-wrap math
 * shares — video, audio and nested clips (and, once wired, animated images)
 * all compute their own "natural" span (asset duration, frame content
 * duration, …) and funnel it through this before calling `sourceTimeAt`.
 */
export function loopSpanMs(playback: ClipPlayback, naturalSourceSpanMs: number, curve?: SpeedCurve | null): number {
  if (playback.loopLengthMs == null) return naturalSourceSpanMs;
  // THROUGH THE SPEED CURVE: a ramp or a freeze inside the cycle changes how
  // much source that much wall time reads — constant speed restarted the clip
  // at the wrong moment.
  if (curve) return Math.max(1, retimedSourceMs(curve, playback.loopLengthMs));
  return Math.max(1, playback.loopLengthMs * (playback.speed > 0 ? playback.speed : 1));
}

/**
 * The loop-cycle handle's wall-clock position: the explicit override as-is,
 * or the natural source span converted back to wall-clock (the inverse of
 * `loopSpanMs`) so an unset handle still shows where one cycle "naturally"
 * ends.
 */
export function loopCycleWallMs(playback: ClipPlayback, naturalSourceSpanMs: number, curve?: SpeedCurve | null): number {
  if (playback.loopLengthMs != null) return playback.loopLengthMs;
  // Where the footage really runs out: a freeze holds the source still and a
  // ramp changes its rate, so the cycle ends where the integrated source first
  // reaches the natural span — the moment playback actually restarts.
  if (curve) return wallTimeForSourceMs(curve, naturalSourceSpanMs) ?? naturalSourceSpanMs;
  return naturalSourceSpanMs / (playback.speed > 0 ? playback.speed : 1);
}

/**
 * The inverse of `sourceTimeAt` for the first playthrough: given a time INSIDE
 * a source, where does the wrapping clip's parent timeline sit? Loop/pingpong
 * make the true inverse many-valued — the first cycle is the editing-intuitive
 * choice (Parent Preview, drill-in playhead round-trips).
 */
export function parentTimeAt(sourceMs: number, playback: ClipPlayback): number {
  return Math.max(0, sourceMs) / (playback.speed > 0 ? playback.speed : 1);
}

// `animationSpanMs` lives with the rest of the unit-timing arithmetic in
// text/schedule.ts (the renderer and the audio engine share it); re-exported
// here because this module has always been its public address.
export { animationSpanMs } from "../text/schedule";

/**
 * One unit's visual at a clip-local time.
 *
 * `order`/`cohortSize` are the unit's position within ITS OWN cohort, and
 * `anchorMs` that cohort's fixed point (arrival for "in", the deadline it must
 * be gone by for "out") — so a partial content edit staggers its three new
 * words 0,1,2 instead of leaving gaps for words that arrived a second ago.
 * A clip with static content is the degenerate case: one cohort, anchored at 0
 * and at the clip's end, i.e. exactly the old behaviour.
 *
 * EXPORTED because the library's preview cards need the same answer the stage
 * gives, and a card that poses its glyphs from a parallel implementation is a
 * picture guaranteed to disagree with what applying the look actually does.
 * Anything that wants "where is unit N of this spec at time T" calls this.
 */
export function evalSpecAtUnit(
  spec: AnimationSpec,
  order: number,
  cohortSize: number,
  localMs: number,
  phase: "in" | "out",
  anchorMs: number,
  seed: number,
): GlyphVisual {
  const def = getPreset(spec.preset);
  if (!def) return GLYPH_IDENTITY;

  const start = unitStartMs(spec, order, cohortSize, phase, anchorMs, seed);
  const raw =
    spec.durationMs <= 0
      ? localMs >= start
        ? 1
        : 0
      : Math.min(1, Math.max(0, (localMs - start) / spec.durationMs));
  const eased = evaluateEasing(spec.easing, raw);

  const base =
    phase === "in"
      ? def.evalIn(eased, spec.params)
      : def.evalOut
        ? def.evalOut(eased, spec.params)
        : // Default out: play the in-animation backwards.
          def.evalIn(evaluateEasing(spec.easing, 1 - raw), spec.params);

  return applyScatter(base, spec, phase === "in" ? 1 - eased : eased, seed);
}

/**
 * Per-unit random displacement, scaled by how far the unit still is from rest
 * (`unsettled`: 1 at the extreme of the animation, 0 once it has landed). The
 * fade is what makes this safe to apply to EVERY preset — the resting layout is
 * still exact to the pixel, so scatter can never leave text crooked on screen.
 */
function applyScatter(
  base: GlyphVisual,
  spec: AnimationSpec,
  unsettled: number,
  seed: number,
): GlyphVisual {
  if (spec.scatterPx <= 0 && spec.scatterDeg <= 0) return base;
  const k = Math.max(0, Math.min(1, unsettled));
  return {
    ...base,
    dx: base.dx + (hash01(seed, 2) * 2 - 1) * spec.scatterPx * k,
    dy: base.dy + (hash01(seed, 3) * 2 - 1) * spec.scatterPx * k,
    rotation: base.rotation + (hash01(seed, 4) * 2 - 1) * spec.scatterDeg * k,
  };
}

function composeVisuals(a: GlyphVisual, b: GlyphVisual): GlyphVisual {
  return {
    opacity: a.opacity * b.opacity,
    dx: a.dx + b.dx,
    dy: a.dy + b.dy,
    scale: a.scale * b.scale,
    rotation: a.rotation + b.rotation,
    blur: a.blur + b.blur,
  };
}

/** The in-animation spec that applies to a grapheme (range override wins). */
export function inSpecForGrapheme(clip: TextClip, graphemeIndex: number): AnimationSpec | null {
  const range = rangeAt(clip.ranges, graphemeIndex);
  if (range?.animation) return range.animation;
  return clip.animations.in;
}

/**
 * The epoch whose content matches `seg`, or null when the caller is rendering
 * text the schedule doesn't know about.
 *
 * A node graph can DRIVE a text clip's content (`drivers.text`), producing a
 * string that exists in no keyframe and therefore in no epoch. Rather than
 * animate that text against someone else's lifespans, we fall back to the
 * whole-clip anchors — the pre-content-keyframe behaviour, which is exactly
 * right for a string that has no edit history.
 */
function epochForSeg(clip: TextClip, seg: TextSegmentation, localMs: number): TextEpoch | null {
  const epoch = contentEpoch(clip, localMs);
  if (epoch.seg.text !== seg.text) return null;
  return epoch;
}

/**
 * Per-glyph visual state of a text clip at a clip-relative time.
 * This is THE function native adapters mirror: everything visible about
 * per-character animation derives from it.
 *
 * Each glyph animates against ITS OWN lifespan, not the clip's: it enters when
 * its cohort arrived (clip start, or the content keyframe that inserted it) and
 * leaves by the deadline its cohort departs (the keyframe that removes it, or
 * the clip's end). Editing "A B C D" into "A E F G" at a keyframe therefore
 * plays the out-animation on "B C D" and the in-animation on "E F G" with "A"
 * untouched, and static text stays the single-cohort case it always was.
 */
export function evaluateTextGlyphs(
  clip: TextClip,
  seg: TextSegmentation,
  localMs: number,
): GlyphVisual[] {
  const out: GlyphVisual[] = [];
  const outSpec = clip.animations.out;
  const epoch = epochForSeg(clip, seg, localMs);

  // Cohort rankings are per (phase, unit); range overrides only ever vary the
  // unit, so this is at most three cached entries per phase.
  const cohortsIn = new Map<string, ReturnType<typeof cohortIndex>>();
  const inCohort = (unit: AnimationSpec["unit"]) => {
    if (!epoch) return null;
    let c = cohortsIn.get(unit);
    if (!c) cohortsIn.set(unit, (c = cohortIndex(epoch, unit, "in")));
    return c;
  };
  const outCohort = outSpec && epoch ? cohortIndex(epoch, outSpec.unit, "out") : null;
  const outUnitCount = outSpec ? unitCountOf(seg, outSpec.unit) : 0;
  const poses = captionPosesOf(clip, seg, localMs);
  const fades = rangeOpacitiesAt(clip, localMs);

  for (let i = 0; i < seg.graphemes.length; i++) {
    let visual = GLYPH_IDENTITY;

    // A range is addressed in the epoch's own text; mid-count, glyph `i` of the
    // counted text stands for `view.source[i]` there (count-up.ts).
    const inSpec = inSpecForGrapheme(clip, epoch?.view ? epoch.view.source[i]! : i);
    if (inSpec) {
      const c = inCohort(inSpec.unit);
      const anchor = epoch ? epoch.enterAtMs[i]! : 0;
      const order = c ? c.order[i]! : unitIndexOf(seg, i, inSpec.unit);
      const size = c ? c.size[i]! : unitCountOf(seg, inSpec.unit);
      const seed = unitSeed(clip.id, "in", anchor, unitIndexOf(seg, i, inSpec.unit));
      visual = composeVisuals(visual, evalSpecAtUnit(inSpec, order, size, localMs, "in", anchor, seed));
    }
    if (outSpec) {
      const anchor = epoch ? epoch.exitAtMs[i]! : clip.durationMs;
      const order = outCohort ? outCohort.order[i]! : unitIndexOf(seg, i, outSpec.unit);
      const size = outCohort ? outCohort.size[i]! : outUnitCount;
      const seed = unitSeed(clip.id, "out", anchor, unitIndexOf(seg, i, outSpec.unit));
      visual = composeVisuals(visual, evalSpecAtUnit(outSpec, order, size, localMs, "out", anchor, seed));
    }
    // The caption STATE pose — the pop a cue wears while it is in a state, and
    // the animation it replays on entering one. It composes onto the glyph the
    // same way in/out do (and after them, so it reads as an accent on whatever
    // the letter was already doing), which is the entire reason captions need
    // no evaluator of their own.
    for (const pose of poses) {
      if (i < pose.cue.start || i >= pose.cue.end) continue;
      if (pose.spec) {
        const local = unitIndexOf(seg, i, pose.spec.unit) - pose.unitBase;
        visual = composeVisuals(visual, evalSpecAtUnit(
          pose.spec, local, pose.unitCount, localMs, "in", pose.anchorMs,
          unitSeed(clip.id, "in", pose.anchorMs, local),
        ));
      }
      if (pose.scale !== 1) visual = { ...visual, scale: visual.scale * pose.scale };
    }
    // A slice's keyed OPACITY fades those glyphs. It was stored and sampled with
    // the other range keys, but those become style overrides (size, colour,
    // weight…) and a text style has no opacity to override, so it never reached
    // a pixel. It is a glyph's visual, like the in/out fade it composes with.
    if (fades.length) {
      const at = epoch?.view ? epoch.view.source[i]! : i;
      for (const f of fades) if (at >= f.start && at < f.end) visual = { ...visual, opacity: visual.opacity * f.opacity };
    }
    out.push(visual);
  }
  return out;
}

/** Every range-keyed `opacity` track on a text layer, sampled once, clamped to 0…1. */
function rangeOpacitiesAt(clip: TextClip, localMs: number): Array<{ start: number; end: number; opacity: number }> {
  const out: Array<{ start: number; end: number; opacity: number }> = [];
  for (const t of clip.keyframes) {
    if (!t.range || t.property !== "opacity") continue;
    const v = sampleKeyframeTrack(t, localMs);
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out.push({ start: t.range.start, end: t.range.end, opacity: Math.max(0, Math.min(1, v)) });
  }
  return out;
}

/**
 * Every cue's pose contribution, resolved once per evaluation.
 *
 * Only cues that actually contribute are listed: a cue sitting in a state with
 * no animation and no pop is not in the array, so a hundred-word caption with
 * a plain unread state costs one pass over the cues and nothing per glyph.
 *
 * The POP eases across the state crossing (`cueBlendAt`) rather than cutting,
 * so the pill, the colour and the size all arrive on the same curve — one
 * setting, one motion, which is what `CaptionMotion` exists to guarantee.
 */
interface CaptionPose {
  cue: CaptionCue;
  spec: AnimationSpec | null;
  /** Clip-local ms the state was entered — the animation's anchor. */
  anchorMs: number;
  scale: number;
  unitBase: number;
  unitCount: number;
}

function captionPosesOf(clip: TextClip, seg: TextSegmentation, localMs: number): CaptionPose[] {
  const caption = clip.caption;
  if (!caption) return EMPTY_POSES;
  const out: CaptionPose[] = [];
  for (const cue of caption.cues) {
    const blend = cueBlendAt(caption, cue, localMs);
    const state = caption.states[blend.state];
    // The scale a cue wears mid-crossing is between the two states' — the pop
    // grows into the word rather than snapping onto it.
    const scale = blend.from
      ? caption.states[blend.from].scale + (state.scale - caption.states[blend.from].scale) * blend.t
      : state.scale;
    const anchorMs = cueEnteredAt(cue, blend.state);
    // `unread` has no entry instant, so it has no animation to anchor — the
    // layer's in-animation already is the unread words' animation.
    const spec = anchorMs === null ? null : state.animation;
    if (!spec && scale === 1) continue;
    const unitBase = spec ? unitIndexOf(seg, cue.start, spec.unit) : 0;
    // Stagger runs across the CUE's own units, not the layer's: the third word
    // of a line should lead its own letters, not wait for the whole paragraph.
    const unitCount = spec
      ? Math.max(1, unitIndexOf(seg, Math.max(cue.start, cue.end - 1), spec.unit) - unitBase + 1)
      : 1;
    out.push({ cue, spec, anchorMs: anchorMs ?? 0, scale, unitBase, unitCount });
  }
  return out;
}

const EMPTY_POSES: CaptionPose[] = [];

/**
 * ONE unit animating once — the atom BOTH the renderer and the audio engine
 * work from. The renderer reads the schedule per glyph (above); the cue walker
 * reads this flat list. They call the same `unitStartMs`, so a keystroke sound
 * lands on the frame its letter starts moving, jitter included, forever.
 */
export interface TextUnitEvent {
  phase: "in" | "out";
  /** Clip-local ms the unit's animation begins. */
  atMs: number;
  /** How long it runs — carried because a range override can change it. */
  durationMs: number;
  /** The unit's first non-whitespace grapheme — its identity for range lookups. */
  graphemeIndex: number;
  unitIndex: number;
  /** The grain this unit was cut at, so a view can draw letters and words
   *  differently without re-deriving which is which. */
  unit: AnimationUnit;
  /** The unit's own text — what a rhythm view labels its tick with. */
  label: string;
  /** Line the unit sits on, so a view can lay events out the way the text reads. */
  lineIndex: number;
  /** Which content epoch emitted it (see `textTimelineOf`). */
  epochIndex: number;
  /** The 0..1 seed the renderer humanised this same unit with. */
  seed: number;
}

/**
 * Every unit animation event of a text clip, over its whole content history.
 *
 * Whitespace never fires: a space is not a keystroke you hear, and for word/line
 * units the first non-space grapheme stands for the unit. Cohorts are honoured,
 * so an edit that replaces three words emits three exit events at the cut and
 * three entrance events after it — the audible half of the same story the
 * picture is telling.
 */
export function textUnitEvents(clip: TextClip): TextUnitEvent[] {
  const events: TextUnitEvent[] = [];
  const outSpec = clip.animations.out;
  const epochs = textTimelineOf(clip).epochs;
  for (let epochIndex = 0; epochIndex < epochs.length; epochIndex++) {
    const epoch = epochs[epochIndex]!;
    const seg = epoch.seg;
    const seen = new Set<string>();
    for (let i = 0; i < seg.graphemes.length; i++) {
      if (/^\s+$/.test(seg.graphemes[i]!.char)) continue;
      const specs: Array<[("in" | "out"), AnimationSpec | null]> = [
        ["in", inSpecForGrapheme(clip, i)],
        ["out", outSpec],
      ];
      for (const [phase, spec] of specs) {
        if (!spec) continue;
        const anchor = phase === "in" ? epoch.enterAtMs[i]! : epoch.exitAtMs[i]!;
        // EPOCH OWNERSHIP. A glyph that survives a cut appears in several
        // epochs, but it arrives once and leaves once — and only the epoch
        // where that actually happens ranks it against the right cohort. The
        // epoch that owns an arrival is the one it starts in (`enterAtMs ===
        // fromMs`); the epoch that owns a departure is the one it ends in
        // (`exitAtMs === toMs`). Without this the same letter would click twice
        // — and the second click would be timed against strangers.
        if (phase === "in" ? anchor !== epoch.fromMs : anchor !== epoch.toMs) continue;
        const unitIndex = unitIndexOf(seg, i, spec.unit);
        const key = `${phase}:${spec.unit}:${unitIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const c = cohortIndex(epoch, spec.unit, phase);
        const seed = unitSeed(clip.id, phase, anchor, unitIndex);
        events.push({
          phase,
          atMs: unitStartMs(spec, c.order[i]!, c.size[i]!, phase, anchor, seed),
          durationMs: spec.durationMs,
          graphemeIndex: i,
          unitIndex,
          unit: spec.unit,
          label: unitTextOf(seg, i, spec.unit),
          lineIndex: seg.lineIndex[i] ?? 0,
          epochIndex,
          seed,
        });
      }
    }
  }
  events.push(...countTicks(clip, epochs));
  events.sort((a, b) => a.atMs - b.atMs);
  return events;
}

/** The closest two number ticks may sound — faster reads as noise, not a count. */
const TICK_MIN_GAP_MS = 50;

/**
 * A COUNTING NUMBER TICKS — one in-phase event each time its displayed value
 * changes, voiced by whatever in-sound governs it (the layer's, or a range's
 * over the number). Sampled at 60fps across the count and thinned to one tick
 * per `TICK_MIN_GAP_MS`, so 0 → 1,000,000 costs as many events as the count has
 * frames, and a fast count clicks at a readable pace while an easing-out
 * count's last values tick one by one.
 */
function countTicks(clip: TextClip, epochs: readonly TextEpoch[]): TextUnitEvent[] {
  const out: TextUnitEvent[] = [];
  for (const epoch of epochs) {
    const count = epoch.count;
    if (!count) continue;
    for (const span of count.spans) {
      const spec = inSpecForGrapheme(clip, span.from.start);
      if (!spec) continue;
      const unitIndex = unitIndexOf(epoch.seg, span.from.start, spec.unit);
      let last = formatNumber(span.from.value, span.format).join("");
      let lastAt = -Infinity;
      for (let t = count.fromMs; t <= count.toMs; t += 1000 / 60) {
        const u = spanProgress(span, (t - count.fromMs) / (count.toMs - count.fromMs), evaluateEasing);
        const shown = formatNumber(span.from.value + (span.to.value - span.from.value) * u, span.format).join("");
        if (shown === last || t - lastAt < TICK_MIN_GAP_MS) continue;
        last = shown;
        lastAt = t;
        out.push({
          phase: "in",
          atMs: t,
          durationMs: spec.durationMs,
          graphemeIndex: span.from.start,
          unitIndex,
          unit: spec.unit,
          label: shown,
          lineIndex: epoch.seg.lineIndex[span.from.start] ?? 0,
          epochIndex: epoch.index,
          seed: unitSeed(clip.id, "in", t, unitIndex),
        });
      }
    }
  }
  return out;
}

export interface ClipPose {
  x: number;
  y: number;
  scale: number;
  /** Resolved vertical scale (equals `scale` when the layer keeps aspect). */
  scaleY: number;
  rotation: number;
  /** Pseudo-3D shear (deg) — the K in T·R·K·S. See `transformSchema`. */
  skewX: number;
  skewY: number;
  /** Sampled PIVOT (normalized to the layer's box) — see `anchorSchema`. */
  anchor: AnchorPoint;
  opacity: number;
  /** Keyframed typography overrides (absolute replacements when present). */
  fontSizeOverride?: number;
  letterSpacingOverride?: number;
  lineHeightOverride?: number;
  colorOverride?: string;
  /** Keyframed text-BOX size (null-on-the-clip means auto; a key pins the axis). */
  maxWidthOverride?: number;
  maxHeightOverride?: number;
  fontWeightOverride?: number;
  fauxBoldOverride?: number;
  italicOverride?: boolean;
  /** Caption: keyframed focus-pop override (`focusScale`). */
  focusScaleOverride?: number;
  /** Raw sampled values (all whole-clip keyframed properties at this time). */
  sampled: Record<string, KeyframeValue>;
  /** Range-scoped typography keyframes sampled at this time (per text slice). */
  rangeStyles: RangeStyleSample[];
}

/**
 * Clip-level pose at a local time. Keyframed properties are absolute: once a
 * property has keys, the sampled value replaces the base transform (AE
 * semantics); without keys the base value applies untouched.
 *
 * Drivers do not appear here, and that is the point: a driven property is baked
 * into the clip's own slot before anything reads it (`resolveClipDrivers`), so
 * by the time a pose is built there is no such thing as a driver — only values.
 * This function used to take a resolver hook, which meant a driven layer moved
 * for whoever passed one and stayed put for everyone else.
 */
export function evaluateClipPose(clip: TextClip, localMs: number): ClipPose {
  const kf = sampleKeyframes(clip.keyframes, localMs);
  const color = kf.color;
  const fontWeight = kf.fontWeight;
  const italic = kf.italic;
  const scale = sampleNumber(kf, "scale") ?? clip.transform.scale;
  return {
    x: sampleNumber(kf, "x") ?? clip.transform.x,
    y: sampleNumber(kf, "y") ?? clip.transform.y,
    scale,
    scaleY: sampledScaleY(kf, clip.transform.scaleY) ?? scale,
    rotation: sampleNumber(kf, "rotation") ?? clip.transform.rotation,
    skewX: sampleNumber(kf, "skewX") ?? clip.transform.skewX,
    skewY: sampleNumber(kf, "skewY") ?? clip.transform.skewY,
    // Pivot (normalized) — sampled like any other transform channel, so an
    // animated pivot moves the point rotation/scale happen about, per frame.
    anchor: {
      x: sampleNumber(kf, "anchor.x") ?? clip.transform.anchor.x,
      y: sampleNumber(kf, "anchor.y") ?? clip.transform.anchor.y,
    },
    // Layer opacity (base or keyframed) — text/caption bake it into glyph alpha
    // here, so the render seam leaves their opacity to this (no double-apply).
    opacity: sampleNumber(kf, "opacity") ?? clip.opacity,
    fontSizeOverride: sampleNumber(kf, "fontSize"),
    letterSpacingOverride: sampleNumber(kf, "letterSpacing"),
    maxWidthOverride: sampleNumber(kf, "maxWidth"),
    maxHeightOverride: sampleNumber(kf, "maxHeight"),
    lineHeightOverride: sampleNumber(kf, "lineHeight"),
    colorOverride: typeof color === "string" ? color : undefined,
    fontWeightOverride: typeof fontWeight === "number" ? fontWeight : undefined,
    fauxBoldOverride: sampleNumber(kf, "fauxBold"),
    italicOverride: typeof italic === "boolean" ? italic : undefined,
    focusScaleOverride: sampleNumber(kf, "focusScale"),
    sampled: kf,
    rangeStyles: countedSpans(clip, localMs, sampleRangeStyles(clip.keyframes, localMs)),
  };
}

/**
 * Map grapheme spans authored against a clip's content through the number
 * objects counting at `localMs` — THE seam that makes a range belong to a
 * number rather than to a run of letters. A range around "9" covers "10" and
 * every value between; a range after the number moves with its length. Used
 * for style ranges (`effectiveRanges`) and range keyframes alike, so a colour,
 * a shadow, an animation or a sound given to that range follows the number.
 * Returns `spans` itself when nothing is counting.
 */
export function countedSpans<T extends { start: number; end: number }>(clip: TextClip, localMs: number, spans: T[]): T[] {
  if (spans.length === 0 || !clip.keyframes.some((t) => t.property === "text" && !t.range)) return spans;
  const epoch = contentEpoch(clip, localMs);
  // Ranges are written against the base text. First onto THIS epoch's text
  // when only its numbers differ ("0+" → "40+" at rest on a key), then through
  // the live count when one is running.
  const settled = epoch.text !== clip.text ? numberAlignedView(clip.text, epoch.text) : null;
  if (!settled && !epoch.view) return spans;
  return spans.map((s) => {
    const a = settled ? mapSpanThroughCount(settled, s.start, s.end) : s;
    return { ...s, ...(epoch.view ? mapSpanThroughCount(epoch.view, a.start, a.end) : { start: a.start, end: a.end }) };
  });
}






// ── The typing caret (derived, never stored) ─────────────────────────────────

/**
 * Where a text clip's caret sits and whether it is lit, at a clip-local time.
 *
 * Nothing about this is stored: the position is "after the last unit that has
 * started entering", read from the same schedule the glyphs animate on, and the
 * blink is a pure function of clip-local time. That is what makes a caret
 * survive scrubbing backwards, exporting, and re-exporting — a stored or
 * wall-clock-blinked cursor is a cursor that lies in at least one of those
 * three. It also means the caret automatically follows a content keyframe: the
 * head jumps to the new cohort because the schedule did.
 *
 * Returns null when the layer has no caret, or when typing has finished and the
 * caret is not set to persist.
 */
export interface CaretPlacement {
  /** Grapheme index the caret sits BEFORE; `seg.graphemes.length` = past the end. */
  graphemeIndex: number;
  /** True while the blink is in its lit half (always true when `blinkMs` is 0). */
  lit: boolean;
  /** The content this placement indexes into — the caller's layout must match. */
  text: string;
}

export function caretAt(clip: TextClip, localMs: number): CaretPlacement | null {
  const caret = clip.caret;
  if (!caret.enabled) return null;
  const epoch = contentEpoch(clip, localMs);
  const seg = epoch.seg;
  if (seg.graphemes.length === 0) return null;

  // Deliberately NOT built on `textUnitEvents`: that list drops whitespace,
  // because a space is not a keystroke you hear. A space very much IS a
  // position the cursor passes through, so the head is read straight off the
  // per-grapheme schedule — the same cohort ranking and `unitStartMs` the
  // glyphs animate on, just without the audible-units filter.
  let head = 0;
  let headAtMs = 0;
  let startedAll = true;
  const cohorts = new Map<AnimationUnit, ReturnType<typeof cohortIndex>>();
  for (let i = 0; i < seg.graphemes.length; i++) {
    const spec = inSpecForGrapheme(clip, epoch.view ? epoch.view.source[i]! : i);
    if (!spec) {
      head = i + 1; // no entrance → already on screen
      continue;
    }
    let c = cohorts.get(spec.unit);
    if (!c) cohorts.set(spec.unit, (c = cohortIndex(epoch, spec.unit, "in")));
    const anchor = epoch.enterAtMs[i]!;
    const seed = unitSeed(clip.id, "in", anchor, unitIndexOf(seg, i, spec.unit));
    const start = unitStartMs(spec, c.order[i]!, c.size[i]!, "in", anchor, seed);
    if (start <= localMs) {
      head = i + 1;
      headAtMs = Math.max(headAtMs, start);
    } else startedAll = false;
  }
  if (startedAll && !caret.persist) return null;

  // The blink phase is measured from the LAST KEYSTROKE, not from the clip
  // start. A cursor that blinks on a fixed grid while text is arriving flickers
  // over its own typing and reads as a stray glyph; every terminal and text
  // editor holds it solid as you type and only blinks once you stop. Still a
  // pure function of clip-local time, so preview and export stay identical.
  const lit =
    caret.blinkMs <= 0 ? true : Math.floor((localMs - headAtMs) / caret.blinkMs) % 2 === 0;
  return { graphemeIndex: head, lit, text: seg.text };
}
