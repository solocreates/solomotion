import { countedSpans } from "../animation/evaluate";
import { evaluateEasing } from "../easing";
import { createId } from "../ids";
import { lerpKeyframeValue } from "../animation/keyframes";
import { getClipProperty } from "../animation/paths";
import { formatHexColor, parseHexColor } from "../animation/properties";
import { BASE_SCOPE, type ScopeAddress } from "../scope";
import { emptyOverlay } from "../schema/scope";
import { segmentText, segmentTextCached } from "../text/segment";
import { remapRangesAfterSplice, remapSpanAfterSplice } from "../text/ranges";
import { CAPTION_STATES } from "../schema/clips";
import type {
  CaptionCue,
  CaptionSpec,
  CaptionState,
  CaptionStateStyle,
  KeyframeValue,
  ScopeOverlay,
  StyleRange,
  TextClip,
} from "../schema";

/**
 * CUE ALGEBRA — the whole caption brain.
 *
 * A caption is a text clip plus a list of `CaptionCue`s, and a cue is a span of
 * that clip's own text (grapheme indices) with a start and an end time. Every
 * caption gesture in the product is one of the functions below, and each one
 * maintains the same invariant so nothing downstream has to check it:
 *
 *   cues are sorted, non-overlapping, at least MIN_CUE_MS long, and their
 *   spans lie inside the text.
 *
 * There is no `Word` type here on purpose. Splitting on spaces is one seeding
 * strategy (`buildCues`); a transcript importer, a hand-split phrase and a
 * per-letter karaoke line all produce the same shape.
 */

/** A cue can never be dragged shorter than this. */
export const MIN_CUE_MS = 40;

/** How `buildCues` cuts a string into cues. */
export type CueGrain = "word" | "line" | "letter";

// ── Birth ────────────────────────────────────────────────────────────────────

/**
 * THE look a caption is born with — faded ahead, near-black on an amber pill
 * while spoken, full strength once said — so a fresh caption reads as a
 * caption the moment cues exist, and all three states are visibly *there* to
 * be edited rather than being a tab you have to find to discover it exists.
 *
 * One definition: the "+ Caption" clip, the Captions switch on an existing text
 * layer and the factory's caption input all hand out this object, so the three
 * doors into captioning cannot open onto three different-looking rooms.
 */
export function defaultCaptionStates(): CaptionSpec["states"] {
  return {
    // The words still to come sit back. This is the half of the karaoke look
    // that had nowhere to live before v78 — and it is why the states are worth
    // a schema: "faded until spoken" is a property of the TEXT, not something
    // you can fake with a keyframe on a layer whose words all arrive at once.
    unread: { overlay: { ...emptyOverlay(), props: { opacity: 0.45 } }, animation: null, scale: 1 },
    focus: {
      overlay: {
        ...emptyOverlay(),
        props: {
          color: "#0F0E0C",
          opacity: 1,
          "highlight.color": "#F5B843",
          "highlight.radius": 10,
          "highlight.paddingX": 10,
          "highlight.paddingY": 4,
        },
      },
      animation: null,
      scale: 1.08,
    },
    // Spoken words come back to the layer's own look — full strength, no pill.
    // An empty overlay would inherit the layer, which is nearly right; saying
    // `opacity: 1` explicitly is what makes the read→unread difference legible
    // the moment captions are switched on.
    read: { overlay: { ...emptyOverlay(), props: { opacity: 1 } }, animation: null, scale: 1 },
  };
}

/** The motion a fresh caption crosses states with — a short, settled ramp. */
export function defaultCaptionMotion(): CaptionSpec["motion"] {
  return { durationMs: 160, easing: { kind: "preset", name: "ease-out" }, travel: false };
}

/** A caption module seeded over `text`: one cue per word, the default states. */
export function seedCaption(
  text: string,
  durationMs: number,
  grain: CueGrain = "word",
  states?: Partial<CaptionSpec["states"]>,
): CaptionSpec {
  return {
    cues: buildCues(text, durationMs, grain),
    states: { ...defaultCaptionStates(), ...states },
    motion: defaultCaptionMotion(),
  };
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** The graphemes a cue covers, as a string. */
export function cueTextOf(text: string, cue: { start: number; end: number }): string {
  const g = segmentText(text).graphemes;
  return g.slice(cue.start, cue.end).map((x) => x.char).join("");
}

/**
 * Index of the cue in focus at a clip-local time, or -1 in a gap.
 *
 * Scans backwards so that if two cues ever touch at an instant, the later one
 * — the one just starting — wins, which is what a boundary drag looks like.
 */
export function activeCueIndexAt(caption: CaptionSpec, localMs: number): number {
  for (let i = caption.cues.length - 1; i >= 0; i--) {
    const c = caption.cues[i]!;
    if (localMs >= c.startMs && localMs < c.endMs) return i;
  }
  return -1;
}

/** The cue in focus at a clip-local time, or null. */
export function activeCueAt(caption: CaptionSpec, localMs: number): CaptionCue | null {
  const i = activeCueIndexAt(caption, localMs);
  return i < 0 ? null : caption.cues[i]!;
}

// ── The one projection: a cue's STATE is a style range ──────────────────────

/**
 * A range as the renderer receives it: the document's own, or one a caption
 * state had a hand in. `scope` is absent on the document's ranges (so
 * `clip.ranges` passes through untouched and unallocated) and carries the
 * STATE on every span the projection produced.
 *
 * It exists because a painter needs to know how DEEP a style is, not just what
 * it says. Two highlight pills that meet in the gap between words overlap by
 * their padding, and the one from the more specific scope has to win — base
 * under backdrop under range under focus, the same order the overlays merge
 * in. Without this the spoken word's pill was drawn in glyph order, so the next
 * word's pill painted over its right edge and the left edge stayed clean: a bug
 * you could see from across the room and could not name from the code.
 */
export interface EffectiveRange extends StyleRange {
  readonly scope?: CaptionState;
}

/**
 * WHICH STATE a cue is in at an instant — read from TIME, not from the active
 * cue index.
 *
 * The index would be wrong in a gap: with no cue playing there is no "active"
 * one, and everything before the gap would read as unread again, so a caption
 * with breathing room between lines un-spoke itself every time it breathed.
 * Each cue answers for itself from its own two boundaries, which is also why
 * this is O(1) and safe to call per cue per frame.
 */
export function cueStateAt(cue: CaptionCue, localMs: number): CaptionState {
  if (localMs < cue.startMs) return "unread";
  if (localMs >= cue.endMs) return "read";
  return "focus";
}

/**
 * The instant a cue ENTERED its current state — the anchor both the crossing
 * and a state's own animation are measured from. `unread` has no entry: a cue
 * is unread from the first frame, which is precisely why `unread` carries no
 * animation slot (the layer's in-animation already is it).
 */
export function cueEnteredAt(cue: CaptionCue, state: CaptionState): number | null {
  return state === "focus" ? cue.startMs : state === "read" ? cue.endMs : null;
}

/** The state a cue was in immediately before this one. */
const PREVIOUS_STATE: Record<CaptionState, CaptionState | null> = {
  unread: null,
  focus: "unread",
  read: "focus",
};

/**
 * WHERE a cue is in its crossing: the state it is heading to, the one it is
 * coming from, and how far along (already eased, 0→1).
 *
 * `from` is null once the crossing is over, which is the fast path — at any
 * instant at most two cues are mid-flight and every other cue resolves to a
 * shared, cached overlay object.
 */
export interface CueBlend {
  state: CaptionState;
  from: CaptionState | null;
  /** Eased progress of the crossing; 1 when there is nothing left to cross. */
  t: number;
}

export function cueBlendAt(caption: CaptionSpec, cue: CaptionCue, localMs: number): CueBlend {
  const state = cueStateAt(cue, localMs);
  const d = caption.motion.durationMs;
  const from = PREVIOUS_STATE[state];
  if (d <= 0 || !from) return { state, from: null, t: 1 };
  const enteredAt = cueEnteredAt(cue, state);
  if (enteredAt === null) return { state, from: null, t: 1 };
  const raw = (localMs - enteredAt) / d;
  if (raw >= 1) return { state, from: null, t: 1 };
  return { state, from, t: evaluateEasing(caption.motion.easing, Math.max(0, raw)) };
}

/**
 * BLEND two state overlays — the whole of "properties ease between states".
 *
 * Props interpolate through `lerpKeyframeValue`, which is the same brain a
 * keyframe segment uses: numbers lerp, hex colours blend, everything else
 * holds until the crossing completes. So a state override animates by the
 * exact rule its keyframed twin would, and there is no second interpolator to
 * disagree with the first.
 *
 * A prop only ONE side declares is the interesting case, because the other
 * side means "inherit" — the value the LAYER has there. `base` answers that
 * (the caller knows the clip and the range under the word); the undeclared
 * side stands in with it, so focus {colour: cream} → read {} eases the ink
 * from cream to the layer's own white and lands on it. Before `base`, the ink
 * faded toward transparent and snapped back to white at the end of the
 * crossing — a visible dip on every word leaving focus.
 *
 * With NO base (the layer has nothing there — a pill only the state added):
 *
 *   A COLOUR fades, against its own transparent self. That is what makes the
 *   highlight pill work: `focus` puts a pill on the spoken word and `read`
 *   says nothing about pills, so without this the pill stayed fully opaque for
 *   the whole crossing and then vanished in one frame.
 *
 *   ANYTHING ELSE holds. There is no neutral value to fade a font size toward;
 *   zero is not "no size", it is a size, and easing toward it would collapse
 *   the word instead of releasing it.
 *
 * Structure (`added` / `removed`) does NOT blend. A list cannot be half
 * itself, so it switches at the halfway point of the same curve.
 */
export function blendOverlays(from: ScopeOverlay, to: ScopeOverlay, t: number, base?: (path: string) => KeyframeValue | undefined): ScopeOverlay {
  if (t >= 1) return to;
  if (t <= 0) return from;
  const props: ScopeOverlay["props"] = {};
  for (const path of new Set([...Object.keys(from.props), ...Object.keys(to.props)])) {
    const a = from.props[path];
    const b = to.props[path];
    const inherited = a === undefined || b === undefined ? (base?.(path) ?? undefined) : undefined;
    if (a === undefined) props[path] = lerpKeyframeValue(path, inherited ?? transparentLike(b!), b!, t);
    else if (b === undefined) props[path] = lerpKeyframeValue(path, a, inherited ?? transparentLike(a), t);
    else props[path] = lerpKeyframeValue(path, a, b, t);
  }
  const structural = t < 0.5 ? from : to;
  return { props, removed: structural.removed, added: structural.added };
}

/**
 * The value an UNDECLARED side of a crossing stands in with: the same colour at
 * zero alpha, or the value itself (a hold) when it is not a colour. See
 * `blendOverlays` for why the two cases differ.
 */
function transparentLike(value: KeyframeValue): KeyframeValue {
  if (typeof value !== "string") return value;
  const rgba = parseHexColor(value);
  return rgba ? formatHexColor({ ...rgba, a: 0 }) : value;
}

/** The overlay a cue actually wears right now — its state's, or a crossing of two. */
export function cueOverlayAt(caption: CaptionSpec, cue: CaptionCue, localMs: number): ScopeOverlay {
  const blend = cueBlendAt(caption, cue, localMs);
  const to = caption.states[blend.state].overlay;
  if (!blend.from) return to;
  return blendOverlays(caption.states[blend.from].overlay, to, blend.t);
}

/**
 * FOCUS IS SPECIFIC; THE OTHER TWO ARE A BACKDROP.
 *
 * A hand-made range beats "all the words you haven't said yet" — you selected
 * those characters and said what they should look like. It does not beat the
 * word being spoken, which is the thing the eye is on and the reason the layer
 * is a caption at all. So the merge order flips with the state, and the depth
 * the renderer sorts pills by flips with it too.
 */
function stateWinsOverRange(state: CaptionState): boolean {
  return state === "focus";
}

/**
 * THE seam. A caption state is not a rendering mode — it is one extra
 * `StyleRange` over each cue, merged with the layer's own ranges at this
 * instant.
 *
 * Everything that makes a caption look like a caption falls out of this:
 * layout, per-glyph colour, pills, effects, the inline editor's live preview
 * and both exporters read `StyleRange[]` already, so none of them contains the
 * word "caption". A plain text clip returns `clip.ranges` untouched and pays
 * nothing.
 *
 * Memoised per (clip identity, phase): immer hands us a new clip object on
 * every edit, so the cache turns over exactly when the answer changes, and the
 * array identity stays stable across frames for the layout cache downstream.
 */
export function effectiveRanges(clip: TextClip, localMs: number): EffectiveRange[] {
  // Mid-count, ranges ride the number objects (`countedSpans`) — a range on a
  // counting number styles the whole number at every value it passes through.
  return countedSpans(clip, localMs, rangesAt(clip, localMs));
}

function rangesAt(clip: TextClip, localMs: number): EffectiveRange[] {
  const caption = clip.caption;
  if (!caption || caption.cues.length === 0) return clip.ranges;

  let byPhase = phaseCache.get(clip);
  if (!byPhase) phaseCache.set(clip, (byPhase = new Map()));
  const key = captionPhaseKey(caption, localMs);
  let merged = byPhase.get(key);
  if (!merged) {
    // A crossing keys on TIME, so the map would grow for as long as playback
    // runs. It is a view of one instant, not a record — drop it wholesale
    // rather than carry a second structure to evict from.
    if (byPhase.size > 64) byPhase.clear();
    byPhase.set(key, (merged = projectCues(clip, localMs)));
  }
  return merged;
}

const phaseCache = new WeakMap<TextClip, Map<number, EffectiveRange[]>>();

/**
 * A key that changes exactly when the projection does.
 *
 * Still: the number of cue boundaries behind the playhead — one entry per
 * state change, which is the cheap and overwhelmingly common case. Mid-
 * crossing: the millisecond itself (negated so it can never collide with a
 * boundary count), because the answer genuinely differs every frame while
 * something is easing.
 */
function captionPhaseKey(caption: CaptionSpec, localMs: number): number {
  const d = caption.motion.durationMs;
  let passed = 0;
  for (const c of caption.cues) {
    if (localMs >= c.startMs) passed++;
    if (localMs >= c.endMs) passed++;
    if (d > 0 && ((localMs >= c.startMs && localMs < c.startMs + d) || (localMs >= c.endMs && localMs < c.endMs + d))) {
      return -1 - Math.round(localMs);
    }
  }
  return passed;
}

/**
 * Split the clip's ranges at every cue edge and merge each cue's state over
 * the parts it covers. Ids are DERIVED from what they cover (never minted),
 * because this runs per frame — a fresh id per frame would defeat every cache
 * that keys on it and allocate for nothing.
 *
 * Text a cue does not cover is silence, and silence is the layer: those spans
 * pass through as the clip's own ranges.
 */
function projectCues(clip: TextClip, localMs: number): EffectiveRange[] {
  const caption = clip.caption!;
  const out: EffectiveRange[] = [];
  // Cue overlays are resolved ONCE per state per frame, so the cues sitting at
  // a pure state all share one object — which is what keeps a hundred-word
  // caption from allocating a hundred overlays sixty times a second.
  const pure = new Map<CaptionState, ScopeOverlay>();
  for (const st of CAPTION_STATES) pure.set(st, caption.states[st].overlay);

  const cues = caption.cues;
  let ci = 0;
  const emitPlain = (r: StyleRange, start: number, end: number) => {
    if (end <= start) return;
    out.push(start === r.start && end === r.end ? r : { ...r, id: `${r.id}|${start}`, start, end });
  };

  // Walk the clip's ranges and the cues together; both lists are sorted and
  // non-overlapping, so one pass covers every intersection.
  const emitCovered = (cue: CaptionCue, r: StyleRange | null, start: number, end: number) => {
    if (end <= start) return;
    const blend = cueBlendAt(caption, cue, localMs);
    // An undeclared side of a crossing inherits what the layer has HERE: the
    // range over these graphemes if it says, else the clip's own value.
    const base = (path: string): KeyframeValue | undefined => r?.overlay.props[path] ?? getClipProperty(clip, path) ?? undefined;
    const stateOv = blend.from
      ? blendOverlays(caption.states[blend.from].overlay, caption.states[blend.state].overlay, blend.t, base)
      : pure.get(blend.state)!;
    out.push({
      id: r ? `${r.id}@${start}` : `cue:${cue.id}:${start}`,
      scope: blend.state,
      start,
      end,
      overlay: r ? mergeOverlays(r.overlay, stateOv, stateWinsOverRange(blend.state)) : stateOv,
      // A state's animation replaces the range's while it is in flight; a range
      // with its own animation keeps it once the state has none to offer.
      animation: caption.states[blend.state].animation ?? r?.animation ?? null,
      sounds: r?.sounds ?? {},
    });
  };

  const ranges = clip.ranges;
  let ri = 0;
  let cursor = 0;
  const textEnd = Math.max(
    ranges.length ? ranges[ranges.length - 1]!.end : 0,
    cues.length ? cues[cues.length - 1]!.end : 0,
  );

  while (cursor < textEnd) {
    while (ri < ranges.length && ranges[ri]!.end <= cursor) ri++;
    while (ci < cues.length && cues[ci]!.end <= cursor) ci++;
    const r = ri < ranges.length ? ranges[ri]! : null;
    const c = ci < cues.length ? cues[ci]! : null;
    // The next boundary of interest: where either span starts or ends.
    const nextStart = Math.min(r && r.start > cursor ? r.start : Infinity, c && c.start > cursor ? c.start : Infinity);
    if (nextStart !== Infinity && nextStart > cursor) {
      cursor = nextStart;
      continue;
    }
    const inR = r && r.start <= cursor;
    const inC = c && c.start <= cursor;
    const end = Math.min(inR ? r.end : Infinity, inC ? c.end : Infinity, nextStart);
    if (!Number.isFinite(end)) break;
    if (inC) emitCovered(c, inR ? r : null, cursor, end);
    else if (inR) emitPlain(r, cursor, end);
    cursor = end;
  }
  return out;
}

/**
 * THE TRAVELLING PILL — which two cues the highlight is between, and how far.
 *
 * Headless on purpose: this is pure timing, and the geometry it drives lives
 * wherever the text has been laid out (the canvas renderer, the inline editor,
 * an exporter). Each of those can lerp two rects; none of them should have to
 * re-derive which two words to lerp between.
 *
 * `from` is the cue the pill is leaving — null on the first cue, in a gap, and
 * once the crossing is done, all of which mean "just draw it where it is". The
 * caller cuts rather than slides when the two cues sit on different lines:
 * a pill flying diagonally across a paragraph is the thing nobody wants, and
 * the caller is the only one that knows where the lines are.
 */
export interface CaptionTravel {
  from: CaptionCue | null;
  to: CaptionCue;
  /** Eased progress from `from` to `to`; 1 when there is nothing to cross. */
  t: number;
}

export function captionTravelAt(caption: CaptionSpec, localMs: number): CaptionTravel | null {
  const index = activeCueIndexAt(caption, localMs);
  if (index < 0) return null;
  const to = caption.cues[index]!;
  const d = caption.motion.durationMs;
  if (d <= 0 || index === 0) return { from: null, to, t: 1 };
  const raw = (localMs - to.startMs) / d;
  if (raw >= 1) return { from: null, to, t: 1 };
  return {
    from: caption.cues[index - 1]!,
    to,
    t: evaluateEasing(caption.motion.easing, Math.max(0, raw)),
  };
}

/**
 * Stack two overlays — the whole parent/child algebra at range grain. Props of
 * the winner land last; structural lists concatenate least-specific first, so
 * the deeper scope's effects paint over the shallower one's.
 */
function mergeOverlays(range: ScopeOverlay, state: ScopeOverlay, stateWins: boolean): ScopeOverlay {
  const [under, over] = stateWins ? [range, state] : [state, range];
  return {
    props: { ...under.props, ...over.props },
    removed: [...new Set([...under.removed, ...over.removed])],
    added: {
      effects: [...under.added.effects, ...over.added.effects],
      fills: [...under.added.fills, ...over.added.fills],
      strokes: [...under.added.strokes, ...over.added.strokes],
      textEffects: [...under.added.textEffects, ...over.added.textEffects],
    },
  };
}

// ── The invariant ────────────────────────────────────────────────────────────

/**
 * Sort, clamp into the clip and the text, drop the degenerate, and pull apart
 * overlaps by moving the LATER cue's start. Every writer below ends here, which
 * is why no reader has to defend itself.
 */
export function normalizeCues(
  cues: CaptionCue[],
  graphemeCount: number,
  clipDurationMs: number,
): CaptionCue[] {
  const sorted = cues
    .map((c) => ({
      ...c,
      start: clamp(Math.round(c.start), 0, graphemeCount),
      end: clamp(Math.round(c.end), 0, graphemeCount),
      startMs: clamp(c.startMs, 0, clipDurationMs),
      endMs: clamp(c.endMs, 0, clipDurationMs),
    }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.startMs - b.startMs || a.start - b.start);

  const out: CaptionCue[] = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && c.startMs < prev.endMs) c.startMs = prev.endMs;
    c.endMs = Math.max(c.startMs + MIN_CUE_MS, c.endMs);
    if (c.startMs >= clipDurationMs) continue;
    c.endMs = Math.min(c.endMs, clipDurationMs);
    if (c.endMs - c.startMs < 1) continue;
    out.push(c);
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ── Seeding ──────────────────────────────────────────────────────────────────

/**
 * Cut a string into evenly-timed cues at the requested grain. The manual-mode
 * seed AND the shape a transcript importer produces — whitespace between cues
 * is deliberately left uncovered, so a gap in the spans is a gap you can see.
 */
export function buildCues(text: string, durationMs: number, grain: CueGrain = "word"): CaptionCue[] {
  const spans = cutSpans(text, grain);
  if (spans.length === 0) return [];
  const per = durationMs / spans.length;
  return spans.map(([start, end], i) => ({
    id: createId("cue"),
    start,
    end,
    startMs: Math.round(i * per),
    endMs: Math.round((i + 1) * per),
  }));
}

/** Grapheme spans of each unit at a grain, skipping the whitespace between. */
function cutSpans(text: string, grain: CueGrain): Array<[number, number]> {
  const graphemes = segmentText(text).graphemes;
  const spans: Array<[number, number]> = [];
  let run = -1;
  for (let i = 0; i < graphemes.length; i++) {
    const ch = graphemes[i]!.char;
    const breaks = grain === "line" ? ch === "\n" : /^\s+$/.test(ch);
    if (breaks) {
      if (run >= 0) spans.push([run, i]);
      run = -1;
      continue;
    }
    if (grain === "letter") {
      spans.push([i, i + 1]);
      continue;
    }
    if (run < 0) run = i;
  }
  if (run >= 0) spans.push([run, graphemes.length]);
  return spans;
}

/** Spread every cue evenly across the clip, keeping their spans and order. */
export function distributeCues(cues: CaptionCue[], durationMs: number): CaptionCue[] {
  if (cues.length === 0) return cues;
  const per = durationMs / cues.length;
  return cues.map((c, i) => ({
    ...c,
    startMs: Math.round(i * per),
    endMs: Math.round((i + 1) * per),
  }));
}

// ── Editing TIME ─────────────────────────────────────────────────────────────

/** Which end of a cue a time gesture is moving. */
export type CueEdge = "start" | "end";

/**
 * Move one time boundary. Adjacent cues that were TOUCHING stay touching — the
 * neighbour's matching edge follows — so dragging a split in a karaoke line
 * never opens a hole, while a cue with real silence beside it keeps it.
 *
 * Mutates in place (immer-friendly) and reports whether anything moved.
 */
export function setCueTime(
  cues: CaptionCue[],
  cueId: string,
  edge: CueEdge,
  ms: number,
  clipDurationMs: number,
): boolean {
  const i = cues.findIndex((c) => c.id === cueId);
  if (i === -1) return false;
  const cue = cues[i]!;
  const prev = cues[i - 1];
  const next = cues[i + 1];

  if (edge === "start") {
    const joined = prev && prev.endMs === cue.startMs;
    const lo = prev ? (joined ? prev.startMs + MIN_CUE_MS : prev.endMs) : 0;
    const t = Math.round(clamp(ms, lo, cue.endMs - MIN_CUE_MS));
    if (t === cue.startMs) return false;
    cue.startMs = t;
    if (joined) prev.endMs = t;
    return true;
  }

  const joined = next && next.startMs === cue.endMs;
  const hi = next ? (joined ? next.endMs - MIN_CUE_MS : next.startMs) : clipDurationMs;
  const t = Math.round(clamp(ms, cue.startMs + MIN_CUE_MS, hi));
  if (t === cue.endMs) return false;
  cue.endMs = t;
  if (joined) next.startMs = t;
  return true;
}

/** Set a cue's LENGTH by moving its end — what a duration field edits. */
export function setCueDuration(
  cues: CaptionCue[],
  cueId: string,
  durationMs: number,
  clipDurationMs: number,
): boolean {
  const cue = cues.find((c) => c.id === cueId);
  if (!cue) return false;
  return setCueTime(cues, cueId, "end", cue.startMs + durationMs, clipDurationMs);
}

// ── The EDITING gesture: roll into a neighbour, then ripple past it ──────────
//
// `setCueTime` above is the ALGEBRA — it maintains the invariant and refuses to
// cross a neighbour, which is exactly right for the internal writers that call
// it (splice, tap-sync, split). It is the wrong verb for a person holding a
// boundary, and that mismatch was a real wall: the last cue's end had nowhere
// to go but `clipDurationMs`, the first cue's start nowhere but 0, and every
// middle edge stopped dead at its neighbour. Cues seeded for a 2s clip that
// later grew to 12s could not be pulled out to cover it at all.
//
// So the gesture is its own verb, and it says one thing:
//
//   an edge moves freely to its neighbour; pushing further PUSHES the
//   neighbours along, and everything past them, stopping only at the clip.
//
// That is the same rule the clips on the timeline above already follow when
// one is shoved into another, and it means no edge is ever stuck. Cues keep
// their own lengths while they are being pushed and only compress once they
// run out of room — so a shove never silently destroys timing it can preserve.

/** The room an edge has before it starts pushing — what a field's max means. */
export function cueEdgeBounds(
  cues: readonly CaptionCue[],
  cueId: string,
  edge: CueEdge,
  clipDurationMs: number,
): { lo: number; hi: number } | null {
  const i = cues.findIndex((c) => c.id === cueId);
  if (i === -1) return null;
  const cue = cues[i]!;
  // Past the neighbours, every cue on that side still needs its minimum — the
  // true floor/ceiling of the whole gesture, and it is always reachable.
  const floor = i * MIN_CUE_MS;
  const ceil = clipDurationMs - (cues.length - 1 - i) * MIN_CUE_MS;
  return edge === "start"
    ? { lo: floor, hi: Math.min(cue.endMs - MIN_CUE_MS, ceil - MIN_CUE_MS) }
    : { lo: Math.max(cue.startMs + MIN_CUE_MS, floor + MIN_CUE_MS), hi: ceil };
}

/** Everything after `i` gets out of the way, keeping its length while it can. */
function pushForward(cues: CaptionCue[], i: number, clipDurationMs: number): void {
  for (let j = i + 1; j < cues.length; j++) {
    const cur = cues[j]!;
    const prevEnd = cues[j - 1]!.endMs;
    const shift = prevEnd - cur.startMs;
    if (shift > 0) {
      cur.startMs += shift;
      cur.endMs += shift;
    }
    // The edge FACING the push is the one that gives way, so a cue whose start
    // was just shoved grows rather than swallowing its own start again.
    if (cur.endMs < cur.startMs + MIN_CUE_MS) cur.endMs = cur.startMs + MIN_CUE_MS;
    // Out of room: compress against the wall, never below the minimum.
    const wall = clipDurationMs - (cues.length - 1 - j) * MIN_CUE_MS;
    if (cur.endMs > wall) {
      cur.endMs = wall;
      cur.startMs = Math.min(cur.startMs, wall - MIN_CUE_MS);
    }
  }
}

/** The mirror, for a start edge dragged left. */
function pushBackward(cues: CaptionCue[], i: number): void {
  for (let j = i - 1; j >= 0; j--) {
    const cur = cues[j]!;
    const nextStart = cues[j + 1]!.startMs;
    const shift = cur.endMs - nextStart;
    if (shift > 0) {
      cur.startMs -= shift;
      cur.endMs -= shift;
    }
    if (cur.startMs > cur.endMs - MIN_CUE_MS) cur.startMs = cur.endMs - MIN_CUE_MS;
    const wall = j * MIN_CUE_MS;
    if (cur.startMs < wall) {
      cur.startMs = wall;
      cur.endMs = Math.max(cur.endMs, wall + MIN_CUE_MS);
    }
  }
}

/**
 * Drag one edge of one cue. THE verb behind the ribbon's grips, the cue list's
 * start/end/length fields and the keyboard nudge — so all three can only ever
 * behave identically. Mutates in place; reports whether anything moved.
 */
export function dragCueEdge(
  cues: CaptionCue[],
  cueId: string,
  edge: CueEdge,
  ms: number,
  clipDurationMs: number,
): boolean {
  const i = cues.findIndex((c) => c.id === cueId);
  if (i === -1) return false;
  const cue = cues[i]!;
  const bounds = cueEdgeBounds(cues, cueId, edge, clipDurationMs)!;
  const t = Math.round(clamp(ms, bounds.lo, bounds.hi));

  if (edge === "start") {
    if (t === cue.startMs) return false;
    const prev = cues[i - 1];
    const joined = !!prev && prev.endMs === cue.startMs;
    cue.startMs = t;
    if (joined) prev.endMs = t; // a gapless line stays gapless
    pushBackward(cues, i);
    return true;
  }

  if (t === cue.endMs) return false;
  const next = cues[i + 1];
  const joined = !!next && next.startMs === cue.endMs;
  cue.endMs = t;
  if (joined) next.startMs = t;
  pushForward(cues, i, clipDurationMs);
  return true;
}

/** Slip a cue in time without changing how long it holds — a body drag. */
export function slipCue(
  cues: CaptionCue[],
  cueId: string,
  startMs: number,
  clipDurationMs: number,
): boolean {
  const i = cues.findIndex((c) => c.id === cueId);
  if (i === -1) return false;
  const cue = cues[i]!;
  const length = cue.endMs - cue.startMs;
  const lo = i * MIN_CUE_MS;
  const hi = clipDurationMs - (cues.length - 1 - i) * MIN_CUE_MS - length;
  const t = Math.round(clamp(startMs, lo, Math.max(lo, hi)));
  if (t === cue.startMs) return false;
  cue.startMs = t;
  cue.endMs = t + length;
  pushForward(cues, i, clipDurationMs);
  pushBackward(cues, i);
  return true;
}

/**
 * Stretch the cue list so it ends where the clip ends, keeping the rhythm.
 *
 * The everyday case this exists for: a caption is seeded over a 2-second clip
 * and the clip is then trimmed out to twelve. Trimming deliberately does NOT
 * rescale cues (revealing more of a clip must not re-time its words), so the
 * caption ends up crushed into the first sixth of its own layer with no single
 * gesture that fixes it. "Even" throws the timing away; this keeps it — every
 * cue holds the same SHARE of the line it held before.
 */
export function fitCuesToClip(cues: CaptionCue[], clipDurationMs: number): CaptionCue[] {
  if (cues.length === 0) return cues;
  const span = cues[cues.length - 1]!.endMs;
  if (span <= 0) return distributeCues(cues, clipDurationMs);
  const factor = clipDurationMs / span;
  if (Math.abs(factor - 1) < 0.001) return cues;
  return cues.map((c) => ({
    ...c,
    startMs: Math.round(c.startMs * factor),
    endMs: Math.round(c.endMs * factor),
  }));
}

/**
 * Do the cues and the clip disagree about how long the line is?
 *
 * BOTH directions, because trimming is non-destructive in both: a clip trimmed
 * OUT leaves the caption stranded in its head, and a clip trimmed IN leaves
 * cues hanging past its end where they can never be spoken. Neither is fixed by
 * clamping on trim — that would throw away timing the moment you dragged an
 * edge, and trimming back out could not restore it — so the times survive and
 * this is what offers to reconcile them, at the moment someone looks.
 */
export function cuesMisfitClip(cues: readonly CaptionCue[], clipDurationMs: number): boolean {
  const last = cues[cues.length - 1];
  if (!last) return false;
  return Math.abs(clipDurationMs - last.endMs) > Math.max(250, clipDurationMs * 0.1);
}

/** The list runs PAST the clip — those cues exist but can never be spoken. */
export function cuesOverflowClip(cues: readonly CaptionCue[], clipDurationMs: number): boolean {
  const last = cues[cues.length - 1];
  return !!last && last.endMs > clipDurationMs + 1;
}


/**
 * Tap-sync: stamp a cue's start at "now", pushing every LATER cue that would
 * end up behind it (they haven't been tapped yet) and closing the gap behind.
 * The primitive behind tapping along to audio.
 */
export function stampCueStart(
  cues: CaptionCue[],
  index: number,
  startMs: number,
  clipDurationMs: number,
): void {
  const cue = cues[index];
  if (!cue) return;
  const prev = cues[index - 1];
  cue.startMs = Math.round(clamp(startMs, prev ? prev.startMs + MIN_CUE_MS : 0, clipDurationMs - MIN_CUE_MS));
  if (prev) prev.endMs = cue.startMs;
  for (let j = index; j < cues.length; j++) {
    const c = cues[j]!;
    const n = cues[j + 1];
    if (n && n.startMs < c.startMs + MIN_CUE_MS) n.startMs = c.startMs + MIN_CUE_MS;
    c.endMs = Math.max(c.startMs + MIN_CUE_MS, Math.min(n ? n.startMs : clipDurationMs, clipDurationMs));
  }
}

/** Scale every cue's timings (a clip stretch). */
export function scaleCueTimes(cues: CaptionCue[], factor: number): void {
  for (const c of cues) {
    c.startMs = Math.round(c.startMs * factor);
    c.endMs = Math.round(c.endMs * factor);
  }
}

/** Shift every cue's timings (a left-edge trim re-bases clip-local time). */
export function shiftCueTimes(cues: CaptionCue[], deltaMs: number): void {
  for (const c of cues) {
    c.startMs += deltaMs;
    c.endMs += deltaMs;
  }
}

// ── Editing SPANS (which words are on which row) ─────────────────────────────

/**
 * Move `deltaWords` words across the split between cue `index` and the next —
 * "make this row one word longer", and the whole list re-flows.
 *
 * The cascade is the point, and it is why this works in WORD-index space rather
 * than grapheme space: every later split moves by the same amount, so each
 * following row keeps exactly the word count its author gave it and the text
 * pours through them all. A word never breaks in half, no row is silently
 * emptied, and — because cues index a shared string — not one character moves.
 * Timing is untouched: how long a row is on screen is a separate decision from
 * which words are on it.
 *
 * Word grain, deliberately: a caption row is made of words, and that is the
 * unit the gesture reads in. A letter-grain caption re-splits to the words it
 * overlaps, which is the only sane reading of "one more word" there.
 */
export function shiftCueSplit(
  cues: CaptionCue[],
  index: number,
  deltaWords: number,
  text: string,
): CaptionCue[] {
  if (deltaWords === 0 || index < 0 || index >= cues.length - 1) return cues;
  const words = cutSpans(text, "word");
  if (words.length < cues.length + 1) return cues;

  // The partition as word-index boundaries: b[i] is the first word of cue i,
  // and b[length] is the end of the text.
  const b = cues.map((c) => firstWordAtOrAfter(words, c.start));
  b.push(words.length);

  // Every later boundary moves by the SAME amount, so the only two constraints
  // are at the ends: this row keeps a word, and so does the last one. Whatever
  // lies between is carried along and stays exactly as wide as it was.
  const minShift = b[index]! + 1 - b[index + 1]!;
  const maxShift = words.length - 1 - b[cues.length - 1]!;
  if (minShift > maxShift) return cues;
  const shift = clamp(deltaWords, minShift, maxShift);
  if (shift === 0) return cues;

  const next = b.slice();
  for (let i = index + 1; i < cues.length; i++) next[i] = next[i]! + shift;

  return cues.map((c, i) => ({
    ...c,
    start: words[next[i]!]![0],
    end: words[(next[i + 1] ?? words.length) - 1]![1],
  }));
}

/** Index of the first word starting at or after a grapheme index. */
function firstWordAtOrAfter(words: Array<[number, number]>, grapheme: number): number {
  for (let i = 0; i < words.length; i++) if (words[i]![1] > grapheme) return i;
  return Math.max(0, words.length - 1);
}

/** Split one cue in two at a grapheme index; the time splits proportionally. */
export function splitCue(cues: CaptionCue[], index: number, graphemeIndex: number): CaptionCue[] {
  const cue = cues[index];
  if (!cue || graphemeIndex <= cue.start || graphemeIndex >= cue.end) return cues;
  const ratio = (graphemeIndex - cue.start) / (cue.end - cue.start);
  const atMs = Math.round(cue.startMs + (cue.endMs - cue.startMs) * ratio);
  const left: CaptionCue = { ...cue, end: graphemeIndex, endMs: Math.max(cue.startMs + MIN_CUE_MS, atMs) };
  const right: CaptionCue = {
    id: createId("cue"),
    start: graphemeIndex,
    end: cue.end,
    startMs: left.endMs,
    endMs: Math.max(left.endMs + MIN_CUE_MS, cue.endMs),
  };
  return [...cues.slice(0, index), left, right, ...cues.slice(index + 1)];
}

/** Merge a cue with the one after it — spans and time both join. */
export function mergeCueWithNext(cues: CaptionCue[], index: number): CaptionCue[] {
  const cue = cues[index];
  const next = cues[index + 1];
  if (!cue || !next) return cues;
  const merged: CaptionCue = {
    ...cue,
    end: Math.max(cue.end, next.end),
    endMs: Math.max(cue.endMs, next.endMs),
  };
  return [...cues.slice(0, index), merged, ...cues.slice(index + 2)];
}

/**
 * Remap cue spans after the clip's text was spliced — the fix for the oldest
 * caption bug in the app. Editing a caption used to rebuild the word list and
 * spread it evenly, so adding one word at the end silently re-timed every word
 * before it. Cues survive an edit for the same reason style ranges do: they
 * describe positions in a string, and a splice is a known transformation of
 * positions. Cues the edit erased entirely are dropped.
 */
export function remapCuesAfterSplice(
  cues: CaptionCue[],
  at: number,
  removed: number,
  inserted: number,
): CaptionCue[] {
  const out: CaptionCue[] = [];
  for (const c of cues) {
    const span = remapSpanAfterSplice(c, at, removed, inserted);
    if (span.end > span.start) out.push({ ...c, ...span });
  }
  return out;
}

/**
 * Every cue is exactly one whitespace-delimited word — the shape `buildCues`
 * makes by default and the one nearly every caption keeps. DERIVED, never
 * stored: a hand-split phrase or a per-letter karaoke line simply isn't, and
 * gets the plain positional remap below instead of being re-cut into words
 * it was never meant to be.
 */
export function cuesAreWordGrained(text: string, cues: readonly CaptionCue[]): boolean {
  if (cues.length === 0) return false;
  const words = new Set(cutSpans(text, "word").map(([s, e]) => `${s}:${e}`));
  return cues.every((c) => words.has(`${c.start}:${c.end}`));
}

/**
 * Snap word-grained cues back onto the words after a text edit.
 *
 * A positional remap is exact about POSITIONS and knows nothing about words:
 * letters typed at the front of a word land outside its cue, a word typed
 * right after a cue extends that cue over two words, deleting the space
 * between two words leaves two cues on one. Each of those is then a highlight
 * that no longer lands on a word. So, once per edit, every cue is re-read
 * against the words:
 *
 *   a cue over several words   SPLITS, its time shared by word length
 *   several cues on one word   MERGE into that word's cue (the union)
 *   a cue over part of a word  SNAPS to the whole word
 *   a word the edit created    gets time carved from its neighbour
 *
 * Only words the splice touched can be given time; a word that was already
 * uncovered before the edit was left that way on purpose and stays so.
 */
export function alignCuesToWords(
  text: string,
  cues: readonly CaptionCue[],
  clipDurationMs: number,
  touched: { start: number; end: number },
): CaptionCue[] {
  const words = cutSpans(text, "word");
  if (words.length === 0) return [];
  interface Slot {
    start: number;
    end: number;
    startMs: number;
    endMs: number;
    id: string | null;
  }
  const slots: Slot[] = words.map(([start, end]) => ({ start, end, startMs: Infinity, endMs: -Infinity, id: null }));
  const len = (s: Slot) => s.end - s.start;

  for (const c of [...cues].sort((a, b) => a.start - b.start)) {
    const over = slots.filter((s) => c.end > s.start && c.start < s.end);
    if (over.length === 0) continue;
    const total = over.reduce((n, s) => n + len(s), 0);
    let t = c.startMs;
    over.forEach((s, i) => {
      const share = i === over.length - 1 ? c.endMs : t + ((c.endMs - c.startMs) * len(s)) / total;
      s.startMs = Math.min(s.startMs, t);
      s.endMs = Math.max(s.endMs, share);
      // The first word keeps the cue's identity; the rest are new cues.
      if (s.id === null) s.id = i === 0 ? c.id : createId("cue");
      t = share;
    });
  }

  // Words the edit created: carve time from the nearest timed word — the one
  // before, else the one after — splitting its interval by word length among
  // itself and the run of new words beside it.
  const timed = (s: Slot) => s.id !== null;
  const isNew = (s: Slot) => !timed(s) && s.end > touched.start && s.start < touched.end;
  for (let i = 0; i < slots.length; i++) {
    if (!isNew(slots[i]!)) continue;
    let j = i;
    while (j + 1 < slots.length && isNew(slots[j + 1]!)) j++;
    const run = slots.slice(i, j + 1);
    const before = slots.slice(0, i).reverse().find(timed);
    const after = before ? undefined : slots.slice(j + 1).find(timed);
    const donor = before ?? after;
    if (!donor) break;
    const group = before ? [donor, ...run] : [...run, donor];
    const total = group.reduce((n, s) => n + len(s), 0);
    const dur = donor.endMs - donor.startMs;
    let t = donor.startMs;
    group.forEach((s, k) => {
      const e = k === group.length - 1 ? donor.endMs : t + (dur * len(s)) / total;
      s.startMs = t;
      s.endMs = e;
      if (s.id === null) s.id = createId("cue");
      t = e;
    });
    i = j;
  }

  const out: CaptionCue[] = slots
    .filter(timed)
    .map((s) => ({ id: s.id!, start: s.start, end: s.end, startMs: Math.round(s.startMs), endMs: Math.round(s.endMs) }));
  return normalizeCues(out, segmentText(text).graphemes.length, clipDurationMs);
}

/**
 * THE text-splice writer for a text clip: the new string, with its ranges
 * and — on a caption — its cues carried across the edit. One function so the
 * inline editor and the cue list cannot disagree about what surviving an edit
 * means; the inline editor used to remap only the ranges, and every cue after
 * the caret drifted by the length of what was typed. Word-grained captions
 * are re-read against their words afterwards (`alignCuesToWords`). Mutates —
 * call inside a document update.
 */
export function spliceClipText(
  clip: TextClip,
  next: string,
  splice: { at: number; removed: number; inserted: number },
): void {
  const wordGrained = clip.caption ? cuesAreWordGrained(clip.text, clip.caption.cues) : false;
  clip.text = next;
  clip.ranges = remapRangesAfterSplice(clip.ranges, splice.at, splice.removed, splice.inserted);
  if (!clip.caption) return;
  const cues = remapCuesAfterSplice(clip.caption.cues, splice.at, splice.removed, splice.inserted);
  clip.caption.cues = wordGrained
    ? alignCuesToWords(next, cues, clip.durationMs, { start: splice.at, end: splice.at + splice.inserted })
    : cues;
}

/**
 * The scope a live text selection points at — THE rule, so the sidebar, the
 * scope bar and the caret cannot disagree about it.
 *
 *   nothing, or everything      the layer — editing all of the text is editing
 *                               the text, and an override covering every glyph
 *                               would be the layer's style stored twice
 *   whole cues, all one state   that STATE — you are pointing at something on
 *                               screen (the highlight, the words still ahead)
 *                               and the edit should follow it to every cue
 *                               rather than stay on this span
 *   anything else               a range
 *
 * The middle rule is a GUESS, and it is only ever a starting point: the chips
 * offer every scope regardless, so insisting on "these exact characters" is
 * always one click away and the guess is never a trap.
 */
export function selectionScope(
  clip: TextClip,
  sel: { start: number; end: number } | null,
  localMs: number,
): ScopeAddress {
  if (!sel || sel.end <= sel.start) return BASE_SCOPE;
  const length = segmentTextCached(clip.text).graphemes.length;
  if (sel.start <= 0 && sel.end >= length) return BASE_SCOPE;
  const state = clip.caption ? selectedCueState(clip.caption, sel, localMs) : null;
  return state ? { kind: "caption", state } : { kind: "range", start: sel.start, end: sel.end };
}

/**
 * The STATE a selection is really pointing at, or null for "these characters".
 *
 * You selected the word being spoken — you are pointing at the highlight on
 * screen, and the edit should follow the highlight to every cue rather than
 * stay on this span. The same is true one word later: select the next two
 * words and you are pointing at what unread words look like. So the rule
 * generalises to "an exact run of whole cues that are all in one state", and
 * the boundaries are what make it safe — half a cue, or a run straddling the
 * spoken word, is genuinely about those characters and stays a range.
 */
function selectedCueState(
  caption: CaptionSpec,
  sel: { start: number; end: number },
  localMs: number,
): CaptionState | null {
  const covered = caption.cues.filter((c) => c.end > sel.start && c.start < sel.end);
  if (covered.length === 0) return null;
  // Every edge must line up, or this is a span the cues merely overlap.
  if (covered[0]!.start !== sel.start || covered[covered.length - 1]!.end !== sel.end) return null;
  const state = cueStateAt(covered[0]!, localMs);
  return covered.every((c) => cueStateAt(c, localMs) === state) ? state : null;
}

/**
 * Rewrite ONE cue's text inside the clip's string, returning the new text and
 * the splice that produced it. Editing a row in the cue list goes through here,
 * so the layer's ranges and every other cue re-index against the same splice —
 * the caller applies `remapRangesAfterSplice` / `remapCuesAfterSplice` with it.
 */
export function replaceCueText(
  text: string,
  cue: { start: number; end: number },
  next: string,
): { text: string; at: number; removed: number; inserted: number } {
  const graphemes = segmentText(text).graphemes;
  const head = graphemes.slice(0, cue.start).map((g) => g.char).join("");
  const tail = graphemes.slice(cue.end).map((g) => g.char).join("");
  return {
    text: head + next + tail,
    at: cue.start,
    removed: cue.end - cue.start,
    inserted: segmentText(next).graphemes.length,
  };
}
