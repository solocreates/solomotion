import type { MotionDocument, Clip, KeyframeTrack, Track } from "../schema";
import { SPEED_PROPERTY } from "../animation/retime";
import { documentHasPoses } from "../rig/poses";

/**
 * WHERE DID THE PICTURE CHANGE — the one answer every cache invalidates from.
 *
 * An edit replaces a clip object (the store is immer). That tells a cache THAT
 * something changed; it says nothing about WHEN. Treating every changed clip as
 * changed at every instant is what made the caches feel like they were
 * fighting you: nudge one keyframe at 4s and the whole clip's cached range
 * went dark, move a clip by a second and every frame it had ever touched was
 * rebuilt.
 *
 * So an edit is analysed ONCE, here, into two windows, because there are two
 * different questions and they have different answers:
 *
 *   LOCAL  the clip's OWN instants whose pixels differ — what the LAYER cache
 *          drops. Everything outside it is the same picture as before and is
 *          re-attached to the new clip object instead of re-rendered.
 *   COMP   the instants of the clip's COMP whose composite differs — what the
 *          FRAME cache drops, and what a group or a glass pane above the clip
 *          drops for its own pixels.
 *
 * They disagree more often than they agree, which is the point of keeping both:
 *
 *   - Move a clip from 2–4s to 3–5s. LOCAL is empty: the layer's pixels at its
 *     own second 1 are exactly what they were — it just sits later. COMP is
 *     2–5s: the old footprint lost it, the new one gained it. Nothing else.
 *   - Edit the key at 3s of a track keyed at 1, 2, 3, 4, 5s. LOCAL is 1–5s (see
 *     below for why two neighbours each side), COMP is that shifted by the
 *     clip's start. Frames before 1s and after 5s are untouched.
 *   - Rename or lock it. Both empty. Nothing is rebuilt — locking a heavy layer
 *     is what a person does to go FASTER.
 *
 * ## The keyframe window, and why it is two keys wide
 *
 * A segment's value depends on the key that opens it and the key that closes
 * it — so editing key k changes the segments on either side: key k−1 to k+1.
 * Smooth (auto-tangent) easing reaches one further: a key's tangent is built
 * from its neighbours, so moving k re-slopes k−1 and k+1, which bends the
 * segments that START and END at them. Two neighbours each side is the exact
 * reach of the widest interpolation this engine has; a key with fewer than two
 * neighbours on a side opens the window to infinity on that side, because
 * before the first key and after the last the value HOLDS, and a changed first
 * or last key changes every held instant.
 *
 * ## Edges, conservatively
 *
 * Every finite edge is padded by `EDGE_PAD_MS`. A motion-blurred frame samples
 * the layer across its shutter, a little before and after its own instant, so
 * a frame just outside a window can still have drawn an instant inside it. The
 * pad is deliberately generous: a window that is a few frames too wide costs a
 * few re-renders; one that is a frame too narrow shows a stale picture at the
 * exact boundary a person is looking at when they make the edit.
 *
 * ## What is always the whole clip
 *
 * Anything this does not positively understand. A static property, an effect's
 * parameters, text content, a text animator, a driver — every field other than
 * the few below changes the picture everywhere the clip is, and the default for
 * a field added tomorrow is the same. The only safe direction for a cache to be
 * wrong in is too wide.
 *
 *   - SPEED keys remap time for everything after them, so they are whole.
 *   - A move of a VIDEO is the whole comp: footage holds its edge frames across
 *     adjacent gaps (`clipRenderLocalTime`), so moving one changes what fills
 *     gaps it is nowhere near.
 *   - A clip on a LOOPING lane is the whole comp: the lane repeats its content,
 *     so one instant of the clip is many instants of the comp.
 *   - A change that moves a GROUP's contents (a member added, removed, moved or
 *     restyled) reaches the group's whole span — its box and pivot are a
 *     function of its members, and they transform every instant of it.
 */

/** A closed window `[from, to]`. Either end may be infinite. */
export type TimeSpan = readonly [from: number, to: number];

/** `"all"` = every instant; an empty array = none. */
export type TimeSpans = readonly TimeSpan[] | "all";

export interface ClipPictureChange {
  /** The clip's own instants (clip-local ms) whose pixels differ. */
  local: TimeSpans;
  /** The clip's comp instants (comp ms, in `frameId`'s time) whose composite differs. */
  comp: TimeSpans;
  /**
   * True when every instant in `comp` is one where the clip painted — before
   * or after the edit. Then a frame that did NOT list the clip as a
   * contributor genuinely cannot have changed, which is what lets a comp that
   * NESTS this one keep everything the clip never appeared in. False for moves,
   * adds and removes, which change what paints at instants the clip was never
   * part of.
   */
  withinPaint: boolean;
}

/** Nothing about the picture moved. */
export const NO_PICTURE_CHANGE: ClipPictureChange = { local: [], comp: [], withinPaint: true };

/** Widest motion-blur shutter this engine draws, and then some. */
export const EDGE_PAD_MS = 100;

/** Fields that describe a clip without being part of its picture. */
const INERT_FIELDS: ReadonlySet<string> = new Set(["name", "locked", "linkGroupId", "cachePolicy"]);

/** Fields a LOCAL window can be computed for; anything else is the whole clip. */
const WINDOWED_FIELDS: ReadonlySet<string> = new Set(["keyframes", "animIn", "animOut", "startMs"]);

// ── TimeSpan algebra ────────────────────────────────────────────────────────────

export function inSpans(spans: TimeSpans, t: number): boolean {
  if (spans === "all") return true;
  for (const [a, b] of spans) if (t >= a && t <= b) return true;
  return false;
}

export function spansEmpty(spans: TimeSpans): boolean {
  return spans !== "all" && spans.length === 0;
}

function union(a: TimeSpans, b: TimeSpans): TimeSpans {
  if (a === "all" || b === "all") return "all";
  return a.length === 0 ? b : b.length === 0 ? a : [...a, ...b];
}

function shift(spans: TimeSpans, by: number): TimeSpans {
  if (spans === "all") return "all";
  return spans.map(([a, b]) => [a + by, b + by] as const);
}

function pad(spans: TimeSpans): TimeSpans {
  if (spans === "all") return "all";
  return spans.map(([a, b]) => [a - EDGE_PAD_MS, b + EDGE_PAD_MS] as const);
}

/** Where a clip sits in its comp. */
export function footprint(clip: Clip): TimeSpan {
  return [clip.startMs, clip.startMs + clip.durationMs];
}

// ── The local window ────────────────────────────────────────────────────────

/**
 * The window a change to one keyframe track reaches. See the header for the
 * two-neighbour rule.
 */
function keyTrackWindow(prev: KeyframeTrack, next: KeyframeTrack): TimeSpans {
  if (prev.property !== next.property) return "all";
  if (prev.property === SPEED_PROPERTY) return "all";
  if ((prev.range?.start ?? -1) !== (next.range?.start ?? -1) || (prev.range?.end ?? -1) !== (next.range?.end ?? -1)) {
    return "all";
  }
  const before = [...prev.keys].sort((a, b) => a.timeMs - b.timeMs);
  const after = [...next.keys].sort((a, b) => a.timeMs - b.timeMs);
  const beforeById = new Map(before.map((k) => [k.id, k]));
  const afterById = new Map(after.map((k) => [k.id, k]));
  const out: TimeSpan[] = [];
  const reach = (keys: typeof before, i: number): TimeSpan => [
    i - 2 >= 0 ? keys[i - 2]!.timeMs : -Infinity,
    i + 2 < keys.length ? keys[i + 2]!.timeMs : Infinity,
  ];
  // A key that changed, vanished or appeared, measured in whichever list holds
  // it — both, for one that changed, since its old AND new place are affected.
  before.forEach((k, i) => {
    if (afterById.get(k.id) !== k) out.push(reach(before, i));
  });
  after.forEach((k, i) => {
    if (beforeById.get(k.id) !== k) out.push(reach(after, i));
  });
  return out;
}

function keyframesWindow(prev: readonly KeyframeTrack[], next: readonly KeyframeTrack[]): TimeSpans {
  const before = new Map(prev.map((t) => [t.id, t]));
  let spans: TimeSpans = [];
  for (const t of next) {
    const was = before.get(t.id);
    before.delete(t.id);
    if (was === t) continue;
    // A track that appeared or vanished changes the value everywhere: before
    // the first key the value holds at it, and without the track it is static.
    if (!was) return "all";
    spans = union(spans, keyTrackWindow(was, t));
    if (spans === "all") return "all";
  }
  return before.size > 0 ? "all" : spans;
}

/** An in/out animation plays over the clip's first / last `durationMs`. */
function animWindow(prev: Clip, next: Clip, side: "animIn" | "animOut"): TimeSpans {
  const a = (prev as { animIn?: unknown; animOut?: unknown })[side] as { durationMs: number } | null | undefined;
  const b = (next as { animIn?: unknown; animOut?: unknown })[side] as { durationMs: number } | null | undefined;
  if (a === b) return [];
  const reach = Math.max(a?.durationMs ?? 0, b?.durationMs ?? 0);
  return side === "animIn" ? [[-Infinity, reach]] : [[next.durationMs - reach, Infinity]];
}

function changedFields(prev: Clip, next: Clip): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    if (INERT_FIELDS.has(k)) continue;
    if ((prev as Record<string, unknown>)[k] !== (next as Record<string, unknown>)[k]) out.push(k);
  }
  return out;
}

/** The clip's own instants whose pixels differ. */
export function localPictureChange(prev: Clip, next: Clip): TimeSpans {
  if (prev === next) return [];
  const fields = changedFields(prev, next);
  if (fields.some((f) => !WINDOWED_FIELDS.has(f))) return "all";
  let spans: TimeSpans = [];
  if (fields.includes("keyframes")) spans = union(spans, keyframesWindow(prev.keyframes, next.keyframes));
  if (fields.includes("animIn")) spans = union(spans, animWindow(prev, next, "animIn"));
  if (fields.includes("animOut")) spans = union(spans, animWindow(prev, next, "animOut"));
  return pad(spans);
}

// ── The comp window ─────────────────────────────────────────────────────────

/** Where a clip is, as the comp-level analysis needs it. */
export interface ClipPlacement {
  clip: Clip;
  track: Track;
  /** TimeSpans of every GROUP this clip sits inside, outermost included. */
  groupSpans: readonly TimeSpan[];
}

const loops = (track: Track): boolean => track.loop != null && track.loop !== "none";

/**
 * The whole analysis for one clip. `prev` null = the clip was added, `next`
 * null = removed; the caller never asks about a clip that did not change.
 */
export function clipPictureChange(prev: ClipPlacement | null, next: ClipPlacement | null): ClipPictureChange {
  const any = (next ?? prev)!;

  // Added or removed: everything it is (or was) is new — its own pixels and its
  // footprint — and so is every group it sits in.
  if (!prev || !next) {
    if (any.clip.kind === "video" || loops(any.track)) return { local: "all", comp: "all", withinPaint: false };
    return { local: "all", comp: pad(union([footprint(any.clip)], [...any.groupSpans])), withinPaint: false };
  }

  const a = prev.clip;
  const b = next.clip;
  const rowMoved = prev.track.id !== next.track.id;
  if (a.frameId !== b.frameId || loops(prev.track) || loops(next.track)) {
    return { local: localPictureChange(a, b), comp: "all", withinPaint: false };
  }

  const local = localPictureChange(a, b);
  const moved = a.startMs !== b.startMs || a.durationMs !== b.durationMs;
  const grouped = prev.groupSpans.length > 0 || next.groupSpans.length > 0;

  // Z-order, position and membership changes all change what is painted at
  // instants the clip may never have been part of.
  if (moved || rowMoved) {
    if (b.kind === "video") return { local, comp: "all", withinPaint: false };
    let comp: TimeSpans = [footprint(a), footprint(b)];
    if (rowMoved && grouped) comp = union(comp, [...prev.groupSpans, ...next.groupSpans]);
    // Retimed keys move WITH the clip (they are clip-relative), so the local
    // window lands at both the old and the new start.
    comp = union(comp, union(shift(local, a.startMs), shift(local, b.startMs)));
    return { local, comp: pad(comp), withinPaint: false };
  }

  if (spansEmpty(local)) return NO_PICTURE_CHANGE;

  // A member restyled everywhere reshapes its group's box and pivot, which
  // transform every instant of the group — not only the member's own.
  if (local === "all" && grouped) {
    return { local, comp: pad(union([footprint(b)], [...next.groupSpans])), withinPaint: false };
  }
  const comp = local === "all" ? pad([footprint(b)]) : shift(local, b.startMs);
  return { local, comp, withinPaint: true };
}

// ── The document diff ───────────────────────────────────────────────────────

export interface ClipDelta {
  prev: Clip | null;
  next: Clip | null;
  change: ClipPictureChange;
}

/**
 * What a document change means for cached pixels — computed ONCE per edit and
 * handed to every cache, so the frame cache and the layer cache can never
 * disagree about where an edit landed.
 *
 * `total` is the DEFAULT for anything this diff does not understand. A field
 * added to the document tomorrow invalidates everything until someone teaches
 * this otherwise, which is the only safe direction for a cache to be wrong in.
 */
export interface DocumentDelta {
  clips: Map<string, ClipDelta>;
  /** Comps changed structurally — every instant of them is suspect. */
  changedFrames: Set<string>;
  /** Every comp an edit reached at all; what an EMPTY mark is checked against. */
  touchedFrames: Set<string>;
  total: boolean;
}

function placements(doc: MotionDocument): Map<string, ClipPlacement> {
  // A group's rows carry its id; the group CLIP lives on some other row, which
  // may itself belong to a group. Walked upward so a member reaches every
  // enclosing group's span.
  const groupClip = new Map<string, { clip: Clip; track: Track }>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) if (clip.kind === "group") groupClip.set(clip.id, { clip, track });
  }
  const spansOf = (track: Track): TimeSpan[] => {
    const out: TimeSpan[] = [];
    const seen = new Set<string>();
    let gid = track.groupId;
    while (gid && !seen.has(gid)) {
      seen.add(gid);
      const g = groupClip.get(gid);
      if (!g) break;
      out.push(footprint(g.clip));
      gid = g.track.groupId;
    }
    return out;
  };
  const out = new Map<string, ClipPlacement>();
  for (const track of doc.tracks) {
    const groupSpans = track.groupId ? spansOf(track) : [];
    for (const clip of track.clips) out.set(clip.id, { clip, track, groupSpans });
  }
  return out;
}

/** A document where one clip's edit can change another clip's picture (a pose set on a group writes its members). */
function isDriven(doc: MotionDocument): boolean {
  return doc.graphs.length > 0 || doc.expressions.length > 0 || documentHasPoses(doc);
}

export function diffDocumentPicture(prev: MotionDocument, next: MotionDocument): DocumentDelta {
  const delta: DocumentDelta = {
    clips: new Map(),
    changedFrames: new Set(),
    touchedFrames: new Set(),
    total: false,
  };
  if (prev === next) return delta;

  const keys = Object.keys(next) as Array<keyof MotionDocument>;
  for (const key of keys) {
    if (key === "frames" || key === "tracks") continue;
    if (prev[key] !== next[key]) {
      delta.total = true;
      return delta;
    }
  }
  if (Object.keys(prev).length !== keys.length) {
    delta.total = true;
    return delta;
  }

  if (prev.frames !== next.frames) {
    const before = new Map(prev.frames.map((f) => [f.id, f]));
    for (const f of next.frames) {
      // An artboard's size, background, rate or role is part of its picture,
      // and a comp that has just appeared has no pixels to keep anyway.
      if (before.get(f.id) !== f) delta.changedFrames.add(f.id);
      before.delete(f.id);
    }
    for (const id of before.keys()) delta.changedFrames.add(id);
  }

  if (prev.tracks !== next.tracks) {
    const beforeTracks = new Map(prev.tracks.map((t, i) => [t.id, { t, i }]));
    // ROW ORDER IS Z-ORDER. Restacking rows changes no object — the same
    // tracks in a different order — so it has to be asked for explicitly, or a
    // reordered comp keeps serving frames painted in the old stacking.
    // Per comp, because rows are document-global: one row can carry clips of
    // several comps, and each of those comps has its own stacking.
    const order = (tracks: readonly Track[]) => {
      const byComp = new Map<string, string>();
      for (const t of tracks) {
        const comps = new Set(t.clips.map((c) => c.frameId));
        for (const comp of comps) byComp.set(comp, `${byComp.get(comp) ?? ""}|${t.id}`);
      }
      return byComp;
    };
    const orderBefore = order(prev.tracks);
    for (const [comp, seq] of order(next.tracks)) if (orderBefore.get(comp) !== seq) delta.changedFrames.add(comp);

    for (const t of next.tracks) {
      const was = beforeTracks.get(t.id)?.t;
      // ROW STATE. Only three fields on a row reach the picture — `hidden`, the
      // lane loop and the transitions on it. The rest (name, colour, lane
      // height, the LOCK) replace the row object under immer without changing
      // a single pixel.
      const rowChanged =
        !was || was.hidden !== t.hidden || was.loop !== t.loop || was.transitions !== t.transitions;
      if (rowChanged) {
        for (const c of t.clips) delta.changedFrames.add(c.frameId);
        if (was) for (const c of was.clips) delta.changedFrames.add(c.frameId);
      }
    }

    const before = placements(prev);
    const after = placements(next);
    for (const [id, p] of after) {
      const q = before.get(id);
      before.delete(id);
      if (q && q.clip === p.clip && q.track.id === p.track.id) continue;
      const change = clipPictureChange(q ?? null, p);
      if (spansEmpty(change.comp) && spansEmpty(change.local)) continue;
      delta.clips.set(id, { prev: q?.clip ?? null, next: p.clip, change });
      delta.touchedFrames.add(p.clip.frameId);
      if (q) delta.touchedFrames.add(q.clip.frameId);
    }
    for (const [id, q] of before) {
      delta.clips.set(id, { prev: q.clip, next: null, change: clipPictureChange(q, null) });
      delta.touchedFrames.add(q.clip.frameId);
    }
  }

  // In a DRIVEN document an expression or a graph on one layer can read
  // another, so an edit's reach is not the edited clip's — it is anybody's.
  if (delta.clips.size > 0 && (isDriven(prev) || isDriven(next))) {
    delta.total = true;
    return delta;
  }

  // In a comp that SIMULATES, one body's edit moves every other body from the
  // physics start on (they collide, a field pushes them all): the reach of an
  // edit there is the whole comp.
  if (delta.clips.size > 0) {
    const simulating = new Set<string>();
    for (const d of [prev, next]) for (const t of d.tracks) for (const c of t.clips) if (c.kind !== "audio" && (c.physics || c.forces?.length || c.emitters?.length)) simulating.add(c.frameId);
    if (simulating.size) for (const [, ch] of delta.clips) for (const c of [ch.prev, ch.next]) if (c && simulating.has(c.frameId)) delta.changedFrames.add(c.frameId);
  }

  for (const id of delta.changedFrames) delta.touchedFrames.add(id);
  return delta;
}
