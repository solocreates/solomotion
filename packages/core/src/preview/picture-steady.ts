import { isSequenceMime } from "../media/sequence";
import type { MotionDocument, Clip, LayerEffect, Track } from "../schema";
import { clipRenderLocalTime } from "../animation/evaluate";
import { clipSourcePhaseAt } from "../timeline/ops";
import { clipVariesWithTime } from "../animation/clip-properties";
import { layerEffectMoves, layerEffectPath, layerEffectPictureAt, layerEffectReadsBackdrop } from "../animation/layer-effects";
import { clipsUnderGroup } from "../timeline/groups";
import { keySegmentHolds } from "../animation/keyframes";
import { PLACEMENT_PATHS } from "../nodes/resolve-clip";

/**
 * WHICH INSTANTS OF A LAYER ARE THE SAME PICTURE?
 *
 * A layer's pixels are cached per instant, and for a layer that moves that is
 * exactly right. For one that does not, it is waste on a scale that decides
 * whether a range fits at all: a still, graded background under ten seconds of
 * animation is ONE picture, and caching it three hundred times over is three
 * hundred copies of the same buffer — and three hundred renders of the same
 * heavy grade to produce them.
 *
 * So a layer's lifetime divides into SEGMENTS. Inside a steady segment every
 * instant paints the identical picture, and every cache keys that segment as
 * one thing: the layer cache holds one buffer for it, and a comp whose every
 * contributor is steady holds one composite for the whole stretch.
 *
 * ## What makes a layer move
 *
 * Asked of `clipVariesWithTime`, which already enumerates every way a clip
 * animates without a keyframe — drivers, modulators, a motion track, in/out
 * specs, and every effect the registry declares `timeDriven` — so this cannot
 * disagree with the poster model or anything else that asks "is this moving?".
 * On top of that, only its KEYS are refined into windows: a keyed track moves
 * only between two keys whose values differ, so a clip keyed from 2s to 3s is
 * steady before 2s and steady after 3s, as two segments — and a hold between
 * two equal keys is a segment of its own.
 *
 * ## What never qualifies
 *
 * Anything whose picture comes from a SOURCE with its own clock: video, a
 * nested comp, an animated image, a waveform, a caption (its words light up as
 * they are spoken), an adjustment layer (its picture IS what is beneath it),
 * and a layer filled with footage. They answer null, and are cached per
 * instant as before. The list is short and closed on purpose; a kind added
 * tomorrow is null until someone positively says otherwise, because the failure
 * mode of a wrong "steady" is a frozen animation.
 */

/**
 * One stretch of a layer's lifetime that paints one picture. Clip-local ms.
 *
 * A layer whose only motion is STEPPED cards (see "Stepped cards" below) is
 * still here between its steps: `from`/`to` bound the steady stretch and the
 * key carries each card's picture, so it changes at every step inside it.
 */
export interface PictureSegment {
  /** Stable for the clip object: equal keys mean identical pixels. */
  key: string;
  from: number;
  to: number;
}

/** Formats that may carry more than one frame — the renderer decodes these as animations. */
export function isAnimatedImageMime(mime: string, name?: string): boolean {
  // An image SEQUENCE is the same fact — a picture that changes over time —
  // so it answers here and rides every path an animated image already has.
  if (isSequenceMime(mime)) return true;
  return /image\/(gif|apng|webp)/i.test(mime) || /\.(gif|apng|webp)$/i.test(name ?? "");
}

type Paint = { type: string; source?: { type: string; assetId?: string } };

function fillsFootage(doc: MotionDocument, clip: Clip): boolean {
  const fills = (clip as { fills?: readonly Paint[] }).fills;
  if (!fills) return false;
  for (const f of fills) {
    if (f.type !== "media") continue;
    // A media fill without an asset draws the host's own source — which for
    // the kinds that reach here is a still, but "unknown" is not "still".
    if (f.source?.type !== "asset" || !f.source.assetId) return true;
    const asset = doc.assets.find((a) => a.id === f.source!.assetId);
    if (!asset || asset.kind !== "image" || isAnimatedImageMime(asset.mime ?? "", asset.name)) return true;
  }
  return false;
}

/** Can this clip's own picture hold still at all? Keys aside. */
function stillCapable(doc: MotionDocument, clip: Clip, depth = 0): boolean {
  if (depth > 32) return false;
  switch (clip.kind) {
    case "shape":
    case "path":
    case "raster":
      break;
    case "text":
      if ((clip as { caption?: unknown }).caption) return false;
      break;
    case "image": {
      const asset = doc.assets.find((a) => a.id === clip.assetId);
      if (!asset || isAnimatedImageMime(asset.mime ?? "", asset.name)) return false;
      break;
    }
    case "group": {
      // A group is its members' picture, so every member has to be a kind that
      // CAN hold still. WHEN they move is not asked here — that is the group's
      // moving windows, built from theirs (`groupWindows`). Which members are
      // showing is already part of the layer key (`groupShowingKey`).
      for (const id of clipsUnderGroup(doc, clip.id)) {
        const member = findClip(doc, id);
        if (!member) return false;
        if (member.kind === "group") continue; // its own members are in this list
        if (!stillCapable(doc, member, depth + 1)) return false;
      }
      break;
    }
    default:
      return false;
  }
  return !fillsFootage(doc, clip);
}

function findClip(doc: MotionDocument, id: string): Clip | null {
  for (const t of doc.tracks) for (const c of t.clips) if (c.id === id) return c;
  return null;
}

type Windows = Array<readonly [number, number]>;

/**
 * STEPPED CARDS — the live effects that change only at their clock's steps.
 *
 * Grain, glitch, roughened edges and Line boil are time-driven, but each is a
 * pure function of its temporal STEP (`LayerEffectTypeDef.picture`), not of
 * time within a step. Counting them as "moving" made a layer carrying one a
 * new picture every frame: a boil at 12 fps on a 30 fps comp rendered 30 times
 * a second for 12 pictures — and a 3-drawing boil loops the SAME three for the
 * whole timeline. So they leave the "is it moving?" question and join the key
 * instead: equal step pictures, equal pixels, one buffer.
 *
 * A card with a KEYED field stays moving: outside its keys it holds the key
 * values, not the fields the picture is read from. Drivers and modulators
 * already make the whole layer move (`clipVariesWithTime`).
 */
const stepped = new WeakMap<Clip, readonly LayerEffect[]>();
function steppedCards(clip: Clip): readonly LayerEffect[] {
  let out = stepped.get(clip);
  if (out) return out;
  const effects = (clip as { effects?: readonly LayerEffect[] }).effects ?? [];
  out = effects.filter((fx) => {
    if (!fx.enabled || layerEffectPictureAt(fx, 0) === null) return false;
    const prefix = layerEffectPath(fx.id, "");
    return !clip.keyframes.some((t) => t.property.startsWith(prefix));
  });
  stepped.set(clip, out);
  return out;
}

/** The segment with the stepped cards' pictures at the EFFECT clock folded into its key. */
function withSteps(seg: PictureSegment | null, clip: Clip, effectMs: number): PictureSegment | null {
  if (!seg) return null;
  const cards = steppedCards(clip);
  if (cards.length === 0) return seg;
  const t = effectMs / 1000;
  return { ...seg, key: `${seg.key}|${cards.map((fx) => `${fx.id}:${layerEffectPictureAt(fx, t)}`).join(",")}` };
}

/**
 * Where does the layer ITSELF move? Its keyed stretches and its in/out zones —
 * or null when something else moves it (a driver, a wiggle, a moving effect),
 * which means everywhere.
 */
function movingWindows(clip: Clip): Windows | null {
  const c = clip as Clip & {
    animIn?: { durationMs: number } | null;
    animOut?: { durationMs: number } | null;
  };
  // Everything `clipVariesWithTime` knows about except keys and in/out specs
  // is "always moving"; ask it with those taken out so they can be refined.
  // Stepped cards are asked out too: they key the picture, they don't move it.
  const cards = steppedCards(clip);
  const effects = cards.length ? (clip as { effects?: readonly LayerEffect[] }).effects?.filter((fx) => !cards.includes(fx)) : undefined;
  if (clipVariesWithTime({ ...clip, keyframes: [], animIn: null, animOut: null, ...(effects ? { effects } : {}) } as Clip)) return null;
  const out: Windows = [];
  if (c.animIn) out.push([0, c.animIn.durationMs]);
  if (c.animOut) out.push([clip.durationMs - c.animOut.durationMs, clip.durationMs]);
  for (const track of clip.keyframes) {
    // Only the segments whose ends DIFFER move (`keySegmentHolds`): one key is
    // a constant, and a hold between two equal keys is as still as no key at
    // all. A state timeline — hold, ease, hold — is steady for every hold, not
    // moving from its first key to its last; that was a Line boil on a
    // blinking eye re-warping every frame of a 40 s film.
    const keys = track.keys;
    for (let i = 0; i < keys.length - 1; i++) {
      if (keySegmentHolds(clip.keyframes, track, i)) continue;
      // A zero-length segment is a JUMP: still a window (an instant wide), so
      // the pictures either side of it are two segments, never one key.
      const a = keys[i]!.timeMs;
      const b = keys[i + 1]!.timeMs;
      out.push([Math.min(a, b), Math.max(a, b)]);
    }
  }
  return out;
}

/**
 * The steady segment `localMs` sits in, or null when the layer is moving there
 * (or cannot be proven still). Instants on a window's edge count as moving —
 * the conservative side of the boundary.
 */
export function layerPictureSegment(
  doc: MotionDocument,
  clip: Clip,
  localMs: number,
  /** The effect clock's lead over document time (`DrawOptions.effectTimeOffsetMs`). */
  effectOffsetMs = 0,
): PictureSegment | null {
  if (!Number.isFinite(localMs) || !capableMemo(doc, clip)) return null;
  const moving = clip.kind === "group" ? groupWindowsMemo(doc, clip) : windowsMemo(clip);
  return withSteps(segmentIn(moving, localMs), clip, localMs + effectOffsetMs);
}

/**
 * THE BUFFER'S SEGMENT — `layerPictureSegment` for the layer BEFORE it is
 * placed: its x/y keys, drivers and modulators taken out (`PLACEMENT_PATHS`).
 *
 * A layer is rendered into a buffer bounded by its own silhouette, its effects
 * anchored to that buffer, and the buffer is composited at its rect. A pure
 * translation moves the rect and nothing inside it, so a sliding title with a
 * glow, or a hill scrolled by expression under a 3-drawing Line boil, is one
 * buffer per picture — not one render per frame. That is the After Effects
 * layer cache (pre-transform) and the only honest place to draw the line:
 * rotation and scale resample the artwork, so they stay picture changes.
 *
 * Pass the clip the buffer is keyed to (`placedSourceOf` for a bake). The
 * frame cache keeps asking `layerPictureSegment`: a moved layer IS a new frame.
 */
export function layerBufferSegment(
  doc: MotionDocument,
  clip: Clip,
  localMs: number,
  effectOffsetMs = 0,
): PictureSegment | null {
  return layerPictureSegment(doc, unplaced(clip), localMs, effectOffsetMs);
}

const unplacedClips = new WeakMap<Clip, Clip>();
function unplaced(clip: Clip): Clip {
  let out = unplacedClips.get(clip);
  if (out) return out;
  const c = clip as Clip & { drivers?: Record<string, string>; modulators?: Array<{ target: string }> };
  const places = (path: string) => PLACEMENT_PATHS.has(path);
  const moves =
    clip.keyframes.some((t) => places(t.property)) ||
    Object.keys(c.drivers ?? {}).some(places) ||
    (c.modulators ?? []).some((m) => places(m.target));
  if (!moves) out = clip;
  else {
    const drivers = c.drivers ? Object.fromEntries(Object.entries(c.drivers).filter(([path]) => !places(path))) : undefined;
    out = {
      ...clip,
      keyframes: clip.keyframes.filter((t) => !places(t.property)),
      ...(drivers ? { drivers } : {}),
      ...(c.modulators ? { modulators: c.modulators.filter((m) => !places(m.target)) } : {}),
    } as Clip;
  }
  unplacedClips.set(clip, out);
  return out;
}

/** The steady stretch of the clip's OWN animation — its source aside. */
function animationSegment(clip: Clip, localMs: number): PictureSegment | null {
  return withSteps(segmentIn(windowsMemo(clip), localMs), clip, localMs);
}

function segmentIn(moving: Windows | null, localMs: number): PictureSegment | null {
  if (!moving) return null;
  let from = -Infinity;
  let to = Infinity;
  for (const [a, b] of moving) {
    if (localMs >= a && localMs <= b) return null;
    if (b < localMs) from = Math.max(from, b);
    if (a > localMs) to = Math.min(to, a);
  }
  return { key: `s${from}`, from, to };
}

// Asked for every layer of every frame, so both halves are memoised on the
// objects they are functions of — immer replaces them when they change.
const capable = new WeakMap<MotionDocument, WeakMap<Clip, boolean>>();
function capableMemo(doc: MotionDocument, clip: Clip): boolean {
  let byClip = capable.get(doc);
  if (!byClip) capable.set(doc, (byClip = new WeakMap()));
  let v = byClip.get(clip);
  if (v === undefined) byClip.set(clip, (v = stillCapable(doc, clip)));
  return v;
}

const windows = new WeakMap<Clip, Windows | null>();
function windowsMemo(clip: Clip): Windows | null {
  if (windows.has(clip)) return windows.get(clip)!;
  const w = movingWindows(clip);
  windows.set(clip, w);
  return w;
}

/**
 * A GROUP moves where it moves itself AND wherever any member moves — each
 * member's windows carried up into the group's own clock (member local →
 * comp → group local). This is the stack's rule applied to time: the deepest
 * change decides, and its reach travels upward. A group whose one member
 * slides from 4.3s to 5.5s is one picture before that, a new picture per
 * instant during it, and one picture after — not a buffer per frame for its
 * whole life.
 */
const groupWindows = new WeakMap<MotionDocument, WeakMap<Clip, Windows | null>>();
function groupWindowsMemo(doc: MotionDocument, group: Clip): Windows | null {
  let byClip = groupWindows.get(doc);
  if (!byClip) groupWindows.set(doc, (byClip = new WeakMap()));
  if (byClip.has(group)) return byClip.get(group)!;
  let out: Windows | null = windowsMemo(group);
  if (out) {
    out = [...out];
    for (const id of clipsUnderGroup(doc, group.id)) {
      const member = findClip(doc, id);
      // A member's stepped cards run on ITS clock, which a group instant does
      // not name exactly (speed, loops) — so it counts as moving here, and
      // keeps its own per-step buffer as a layer.
      const own = member && steppedCards(member).length === 0 ? windowsMemo(member) : null;
      if (!member || !own) {
        out = null;
        break;
      }
      const shift = member.startMs - group.startMs;
      for (const [a, b] of own) out.push([a + shift, b + shift]);
    }
  }
  byClip.set(group, out);
  return out;
}


// ── Whole frames ────────────────────────────────────────────────────────────

interface Placed {
  clip: Clip;
  track: Track;
  loops: boolean;
  cuts: boolean;
}
const placementIndex = new WeakMap<MotionDocument, Map<string, Placed>>();
function placementsOf(doc: MotionDocument): Map<string, Placed> {
  let index = placementIndex.get(doc);
  if (!index) {
    index = new Map();
    for (const t of doc.tracks) {
      const loops = t.loop !== "none";
      const cuts = t.transitions.length > 0;
      for (const c of t.clips) index.set(c.id, { clip: c, track: t, loops, cuts });
    }
    placementIndex.set(doc, index);
  }
  return index;
}

/**
 * THE SIGNATURE OF A STEADY COMPOSITE — equal signatures, identical frames.
 *
 * A comp frame is a pure function of which layers painted into it and what
 * each of them painted. When every one of them is holding still (each in its
 * own steady segment), two instants with the same contributors in the same
 * segments are the same picture, pixel for pixel — so the frame cache keeps
 * ONE copy for the whole stretch. A title card held for four seconds is one
 * frame of memory, not a hundred and twenty.
 *
 * FOOTAGE THAT IS HOLDING counts as still. A video frozen on one frame — past
 * the end of a play-once clip, on a freeze, or filling a gap with its edge
 * frame — is that source frame for as long as it holds, so a held stretch is
 * one picture like any other. Without this, the tail of every montage was
 * cached once per frame as copies of the same frozen image.
 *
 * Null whenever that cannot be proven: a contributor from another comp (a
 * nested comp runs on its own clock), a looping lane (one instant of the clip
 * is many of the comp), a lane carrying a cut transition (the cut animates both
 * sides), or any layer that is moving.
 */
export function compSteadyKey(
  doc: MotionDocument,
  compId: string,
  compTimeMs: number,
  clipIds: Iterable<string>,
): string | null {
  const index = placementsOf(doc);
  const parts: string[] = [];
  for (const id of clipIds) {
    const hit = index.get(id);
    if (!hit || hit.loops || hit.cuts || hit.clip.frameId !== compId) return null;
    if (hit.clip.kind === "video") {
      const held = heldFootageKey(doc, hit, compTimeMs);
      if (!held) return null;
      parts.push(`${id}:${held}`);
      continue;
    }
    const seg = layerPictureSegment(doc, hit.clip, compTimeMs - hit.clip.startMs);
    if (!seg) return null;
    parts.push(`${id}:${seg.key}`);
  }
  if (parts.length === 0) return null;
  return parts.sort().join("|");
}

// ── The steady prefix of an effect stack ────────────────────────────────────

/**
 * WHERE A STACK STARTS TO MOVE — so everything before it is computed once.
 *
 * A layer with grain on top of a colour grade is "moving" — the grain re-rolls
 * every frame — so the layer as a whole can never be kept across instants. But
 * the grade underneath is not moving, and neither is the artwork under the
 * grade: recomputing both on every frame to feed the grain the same pixels is
 * the waste. An effect stack runs strictly in order, so it splits cleanly at
 * the first card that moves:
 *
 *     artwork → grade → blur │ grain → dust
 *     ───── steady prefix ───┘ └── per frame ──
 *
 * The prefix is judged exactly like a whole layer (`layerPictureSegment`) with
 * the moving tail taken away — its keys, its modulators and its cards — so a
 * keyed blur is a prefix that holds between its keys, and an in-animation
 * still makes the whole layer move. A card that reads the backdrop ends the
 * prefix too: what is behind the layer is not the layer's to hold still.
 *
 * Null when there is nothing to split: no card moves (the layer is judged
 * whole), the very first card moves (there is no prefix), or the prefix is not
 * steady here.
 */
export interface StackPrefix {
  /** How many leading effect cards are steady. */
  count: number;
  segment: PictureSegment;
}

/**
 * The clip as its first `count` cards see it: those cards, and only the keys
 * and modulators that reach them or the artwork. Memoised per object and count
 * so the WeakMap-keyed memos downstream (`layerPictureSegment`) keep hitting.
 */
const prefixClips = new WeakMap<Clip, Map<number, Clip>>();

function prefixClip(clip: Clip, count: number): Clip {
  let byCount = prefixClips.get(clip);
  if (!byCount) prefixClips.set(clip, (byCount = new Map()));
  let out = byCount.get(count);
  if (out) return out;
  const effects = effectsOf(clip);
  const ofTail = tailAddress(effects, count);
  const c = clip as Clip & { modulators?: Array<{ target: string }> };
  out = {
    ...clip,
    effects: effects.slice(0, count),
    keyframes: clip.keyframes.filter((t) => !ofTail(t.property)),
    modulators: c.modulators?.filter((m) => !ofTail(m.target)),
  } as Clip;
  byCount.set(count, out);
  return out;
}

function effectsOf(clip: Clip): readonly LayerEffect[] {
  return (clip as { effects?: readonly LayerEffect[] }).effects ?? [];
}

/** Does a property path address one of the cards from `count` up? */
function tailAddress(effects: readonly LayerEffect[], count: number): (path: string) => boolean {
  const tail = effects.slice(count).map((fx) => layerEffectPath(fx.id, ""));
  return (path) => tail.some((p) => path.startsWith(p));
}

const naturalSplit = new WeakMap<Clip, number>();
function firstMovingCard(clip: Clip): number {
  let count = naturalSplit.get(clip);
  if (count === undefined) {
    count = effectsOf(clip).findIndex((fx) => fx.enabled && (layerEffectMoves(fx) || layerEffectReadsBackdrop(fx)));
    naturalSplit.set(clip, count);
  }
  return count;
}

export function steadyStackPrefix(doc: MotionDocument, clip: Clip, localMs: number): StackPrefix | null {
  const count = firstMovingCard(clip);
  if (count <= 0) return null;
  const segment = layerPictureSegment(doc, prefixClip(clip, count), localMs);
  return segment ? { count, segment } : null;
}

/**
 * THE STACK SPLIT AT A CARD SOMEONE IS WORKING ON.
 *
 * `steadyStackPrefix` splits where the stack starts to MOVE, which is the
 * right cut for playback. Editing wants a different one: whatever card you are
 * tuning, every card beneath it is a constant for as long as you tune — so it
 * is computed once and only your card and those above it run per change. That
 * holds whether or not the cards beneath move, because an edit happens at a
 * PARKED instant: a moving prefix is simply kept for that instant.
 *
 * Null when there is nothing beneath the card, or when a card beneath it reads
 * the backdrop — what is behind the layer is not the layer's to hold still.
 */
export function stackPrefixAt(doc: MotionDocument, clip: Clip, localMs: number, count: number): StackPrefix | null {
  const effects = effectsOf(clip);
  if (count <= 0 || count > effects.length) return null;
  for (let i = 0; i < count; i++) if (effects[i]!.enabled && layerEffectReadsBackdrop(effects[i]!)) return null;
  const head = prefixClip(clip, count);
  const segment = layerPictureSegment(doc, head, localMs) ?? { from: localMs, to: localMs, key: `t${localMs}` };
  return { count, segment };
}

/**
 * IS THE PICTURE UNDER CARD `count` THE SAME IN BOTH OBJECTS?
 *
 * A kept prefix used to be keyed on the clip object, so ANY edit to the layer
 * threw it away — including the one edit that cannot possibly reach it: a
 * slider on a card above it. Which is precisely what the prefix exists for.
 *
 * Immer keeps every untouched card, key track and modulator as the object it
 * was, so the question is exact: every field of the clip except the three
 * lists is the same object, the first `count` cards are the same objects, and
 * every key track and modulator that is NOT addressed to a card above the cut
 * is the same object. Conservative everywhere else — a rename drops it, which
 * costs one re-render and never a wrong picture.
 */
export function stackPrefixUnchanged(prev: Clip, next: Clip, count: number): boolean {
  if (prev === next) return true;
  if (prev.id !== next.id || prev.kind !== next.kind) return false;
  const a = prev as unknown as Record<string, unknown>;
  const b = next as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (k === "effects" || k === "keyframes" || k === "modulators") continue;
    if (a[k] !== b[k]) return false;
  }
  const ea = effectsOf(prev);
  const eb = effectsOf(next);
  if (ea.length < count || eb.length < count) return false;
  for (let i = 0; i < count; i++) if (ea[i] !== eb[i]) return false;
  const tailA = tailAddress(ea, count);
  const tailB = tailAddress(eb, count);
  const reaches = (path: string) => !tailA(path) && !tailB(path);
  if (!sameMembers(prev.keyframes.filter((t) => reaches(t.property)), next.keyframes.filter((t) => reaches(t.property)))) return false;
  const ma = (a.modulators as Array<{ target: string }> | undefined) ?? [];
  const mb = (b.modulators as Array<{ target: string }> | undefined) ?? [];
  return sameMembers(ma.filter((m) => reaches(m.target)), mb.filter((m) => reaches(m.target)));
}

function sameMembers(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A video at a comp instant, when its SOURCE is not advancing: the source frame
 * it holds plus the steady segment of its own animation. Null while it plays,
 * or while anything on the layer itself moves.
 */
function heldFootageKey(doc: MotionDocument, placed: Placed, compTimeMs: number): string | null {
  const rl = clipRenderLocalTime(placed.track, placed.clip, compTimeMs);
  if (!rl) return null;
  const phase = clipSourcePhaseAt(doc, placed.clip, rl.local);
  if (!rl.held && !phase.held) return null;
  // The layer's own look must hold too — a held frame under a keyed fade is
  // still a different picture every instant. Filled footage is its own clock.
  const own = animationSegment(placed.clip, rl.local);
  if (!own || fillsFootage(doc, placed.clip)) return null;
  return `v${Math.round(phase.sourceMs)}|${own.key}`;
}

