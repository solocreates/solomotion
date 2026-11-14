import { HERE, type DepthReach } from "../navigation/selection";
import type { MotionDocument, Clip, ClipKind } from "../schema";
import { clipLocalTime } from "../animation/evaluate";
import { isClipHidden, isClipLocked } from "../timeline/ops";
import { groupOfClip, isGroupWithin } from "../timeline/groups";

/**
 * PAINT SCOPE — the one answer to "where may this mark go, and what does it go
 * around".
 *
 * Four questions used to be four features, each half-built in a different tool:
 * the bucket had a tolerance and a "gap" number, the brush had nothing, the
 * eraser had a layer scope, and "paint inside" did not exist at all. They are
 * the same question asked at different moments:
 *
 *   REFERENCE   what artwork defines the shape of the world  (`refs`)
 *   CONFINE     may the mark leave the region it started in  (`confine`)
 *   DEPTH       does it land over or under what is there     (`depth`)
 *   MERGE       does new geometry join what it touches       (`merge`)
 *
 * So it is ONE value carried by every paint tool. The paint bucket is not a
 * separate feature: it is a confined mark with a flood instead of a brush, and
 * it reads the same region resolver (`resolveRegion`) the brush's stencil does.
 * That is why gap closing, feather, expand and tolerance are written once here
 * and appear identically under the brush, the eraser and the bucket.
 *
 * Nothing in this file touches the DOM, a canvas or React — resolving a
 * reference to clip ids and to a time span is document arithmetic, and the
 * exporter, a worker and a test all need the same answer as the stage.
 */

/**
 * What the artwork "around" a mark IS.
 *
 * A list, not a single layer, and a union of kinds rather than an id plus a
 * flag. A track is already many clips, so the moment tracks are referenceable
 * "one reference" is a fiction; and a fixed `referenceClipId?: string` would
 * have to grow a second field the first time anyone wanted two. Stable ids in
 * a list cost nothing and never need a migration.
 *
 * ── ANYTHING can be a reference, and what that means ────────────────────────
 *
 * A reference is rasterized through the ordinary renderer, so a photo, a video
 * frame, a GIF, a nested comp, an adjustment layer and a fully-effected stack
 * are all referenceable with no code of their own — and what you fill against
 * is exactly what you SEE, effects included. If a blur softens an outline, the
 * fill respects the softened outline, because that is the picture.
 *
 * A NESTED COMP IS PIXELS, deliberately, even when it is full of vector paths.
 * Not a limitation — a decision, and it has two halves:
 *
 *  - Reaching inside would mean writing a fill onto a contour of a clip in
 *    another comp, at another time base, in another coordinate space. That
 *    source is SHARED by every instance of the comp, so "fill this shape here"
 *    would silently restyle it everywhere else it appears. Painting through a
 *    window into someone else's room.
 *  - The escape hatch already exists and is better: double-click in. Inside the
 *    comp those paths are ordinary layers and the exact vector fill applies
 *    with everything else the app can do to them.
 *
 * So: editable geometry where it is genuinely addressable, faithful pixels
 * where it is not. `vector` below is that question and only that question.
 *
 * EMPTY MEANS EVERYTHING VISIBLE. That is the useful default — "fill the hole I
 * can see" is a question about the picture, not about a layer — and it removes
 * the "sample all layers" switch every other app carries, because it is the
 * same fact said once.
 */
export interface PaintReference {
  /** A registered source kind (see `registerReferenceSource`). */
  kind: string;
  /** The id of the thing, in that kind's own namespace. */
  id: string;
}

/**
 * A KIND of thing that can be a reference — the registry, not a switch.
 *
 * "Anything can be a reference" is only true if adding the next anything costs
 * one `register()`. A `switch (ref.kind)` inside the resolver would mean every
 * new source touches the resolver, the menu (for its noun) and the badge, and
 * the third one would be added to two of the three.
 *
 * A source is a PREDICATE rather than a function that returns clip ids, which
 * is what keeps this cheap: the resolver already walks the comp's clips exactly
 * once, and each clip asks the handful of registered sources "are you mine?".
 * A source that walked the document itself would turn one pass into one pass
 * per reference.
 */
export interface ReferenceSourceKind {
  kind: string;
  /** The noun a menu uses: "Use LAYER as reference". */
  noun: string;
  /**
   * Does this clip belong to this source? `track` is the clip's carrier, so a
   * source can key on either without re-locating anything.
   */
  matches: (ctx: {
    doc: MotionDocument;
    clip: Clip;
    track: { id: string };
    id: string;
  }) => boolean;
}

const REFERENCE_SOURCES = new Map<string, ReferenceSourceKind>();

/** Teach the paint tools about a new kind of referenceable thing. */
export function registerReferenceSource(def: ReferenceSourceKind): void {
  REFERENCE_SOURCES.set(def.kind, def);
}

/** The registered kinds, for menus and pickers. */
export function referenceSource(kind: string): ReferenceSourceKind | undefined {
  return REFERENCE_SOURCES.get(kind);
}

/** What to call this reference in a sentence. Unknown kinds read as "layer". */
export function referenceNoun(kind: string): string {
  return REFERENCE_SOURCES.get(kind)?.noun ?? "layer";
}

registerReferenceSource({
  kind: "clip",
  noun: "layer",
  matches: ({ clip, id }) => clip.id === id,
});

registerReferenceSource({
  kind: "track",
  noun: "track",
  matches: ({ track, id }) => track.id === id,
});

registerReferenceSource({
  kind: "group",
  noun: "group",
  // Groups nest, so membership is the CHAIN — referencing an outer group has to
  // pick up the layers inside its inner ones, or "use this group" would quietly
  // mean "use the layers that happen to sit directly in it".
  //
  // Asked through `isGroupWithin` rather than by walking the rows here: how
  // groups nest is one question with one owner (`timeline/groups`), and a
  // second walk in this file would be a second answer to it — one that would
  // have to be found and rewritten every time the group model moves.
  matches: ({ doc, clip, id }) => {
    if (clip.kind === "audio") return false;
    const groupId = groupOfClip(doc, clip.id);
    if (!groupId) return false;
    return groupId === id || isGroupWithin(doc, groupId, id);
  },
});

registerReferenceSource({
  kind: "frame",
  noun: "comp",
  // A comp referenced from OUTSIDE is the nested clips that show it — which is
  // the honest reading: from here it is a picture on the timeline, and there
  // may be several of them.
  matches: ({ clip, id }) => clip.kind === "nested" && clip.sourceFrameId === id,
});

/** Whether a mark may leave the region it started in. */
export type PaintConfine = "off" | "inside" | "outside";

/**
 * HOW a mark is held inside its region — and this is the decision that matters
 * most, because one of the two answers is permanent.
 *
 *  `cut`      the mark ENDS at the boundary. A vector stroke is split into the
 *             runs that were inside; pixels are stencilled as they are laid
 *             down. Simple, structureless, exports anywhere — and destructive:
 *             the geometry outside is gone, so shading painted inside a shape
 *             can never afterwards be nudged, scaled or animated without its
 *             cut edges showing. Movement-unsafe, in one word.
 *
 *  `contain`  the mark KEEPS its whole geometry and the region becomes a live
 *             MASK over it — the app's existing composite group in `mask` mode,
 *             with a stencil traced from the region. Move the shading, animate
 *             it, scale it: it stays inside, because the clipping is happening
 *             at render time rather than having already happened. It is a real,
 *             inspectable group in the layers panel, and every tool that
 *             already understands mask groups understands this one.
 *
 *  `track`    the REFERENCE ITSELF is the mask — a copy of the referenced
 *             layers, keyframes and all, marked as the stencil. So the clip
 *             follows whatever the reference does: paint inside a typewriter
 *             text and the paint types on with it; paint inside a shape that
 *             morphs and the paint morphs with it. Animation-safe, which
 *             neither of the others is — `contain`'s stencil is traced at one
 *             instant and stays there.
 *
 * They form a ladder, and it is worth knowing which rung you are on:
 *
 *              the MARK can move    the REFERENCE can move/animate
 *   cut              no                        no
 *   contain          yes                       no
 *   track            yes                       yes
 *
 * `contain` is the default: it costs one small traced shape and covers most
 * drawing. `track` needs an explicit reference to copy, so it falls back to
 * `contain` when the reference is "everything visible" — there is no single
 * thing to follow. `cut` stays for the times you genuinely want the ink trimmed
 * and no structure left behind.
 */
export type ConfineMode = "cut" | "contain" | "track";

/** Where a mark lands relative to the artwork already there. */
export type PaintDepth = "over" | "under";

/**
 * What a fresh vector stroke does to the geometry it overlaps.
 *
 *  `off`      a stroke is its own contour. Its depth is its own.
 *  `self`     it unions with the contours of the layer it lands on. Still its
 *             own layer, so depth still means something.
 *  `overlap`  it unions into whatever path it actually crosses, in any layer.
 *             A merged stroke has no order of its own — it BECOMES its host —
 *             so `depth` is inert whenever the merge finds one. When nothing
 *             overlaps there is no host and the stroke falls back to `off`,
 *             depth included.
 */
export type VectorMerge = "off" | "self" | "overlap";

export interface PaintScope {
  refs: PaintReference[];
  confine: PaintConfine;
  confineMode: ConfineMode;
  depth: PaintDepth;
  /**
   * Gap closing, px — how wide an opening in the line art may be and still
   * hold paint in. ONE number for three consumers: the bucket's flood barrier,
   * the confine stencil's barrier, and the distance a vector merge will bridge
   * between two loose endpoints. They are the same promise ("treat a hand-drawn
   * outline as if it closed"), so they are the same control.
   */
  closeGapPx: number;
  /** Grow (+) or shrink (−) the resolved region, px — tuck under, or inset. */
  expandPx: number;
  /**
   * How irregular the margin is, 0..1.
   *
   * A machined offset reads as machined — it is the giveaway that a fill was
   * poured rather than painted. Jitter varies the margin along the edge with
   * smooth value noise, so the boundary wanders the way a hand does, and at 0
   * it is exactly the clean offset (no noise is evaluated at all).
   */
  jitter: number;
  /** Soft edge on the region, px. */
  featherPx: number;
  /**
   * Does the OUTLINE itself count as part of the region?
   *
   * "Stroke-safe": with this off, the line art the region stopped at is
   * protected — paint reaches it and no further, which is what you want when
   * the outline is the drawing. With it on the region grows INTO that line (and
   * never past it, into the next enclosure), so a fill tucks underneath instead
   * of leaving a pale halo where the anti-aliased edge was.
   */
  includeEdge: boolean;
  /** Colour sensitivity when a region is read from pixels, 0..1. */
  tolerance: number;
  merge: VectorMerge;
  /**
   * HOW FAR OUT AND IN the tools may reach, in comps (`DepthReach`).
   *
   * The second axis beside "this layer / all layers", and shared here because
   * it is a fact about the GESTURE, not about which nib is on it: an artist who
   * sets the eraser to reach one comp outward means the bucket to read that far
   * too. `{ up: 0, down: 0 }` — this comp only — is the default and is what
   * every tool did before there was a way to ask for more.
   */
  reach: DepthReach;
}

export const DEFAULT_PAINT_SCOPE: PaintScope = {
  refs: [],
  confine: "off",
  confineMode: "contain",
  depth: "over",
  closeGapPx: 4,
  expandPx: 0,
  jitter: 0,
  featherPx: 0,
  includeEdge: true,
  tolerance: 0.12,
  merge: "off",
  reach: { ...HERE },
};

/** Does this scope need a region computed before the mark can be made? */
export function scopeNeedsRegion(scope: PaintScope): boolean {
  return scope.confine !== "off";
}

/**
 * A stable identity for "which artwork is the reference" — the cache key every
 * surface that rasterizes a reference can share. Order-independent, because
 * referencing A then B is the same picture as B then A.
 */
export function referenceKey(refs: readonly PaintReference[]): string {
  if (refs.length === 0) return "*";
  return refs.map((r) => `${r.kind}:${r.id}`).sort().join("|");
}

/** Is this exact source already referenced? (The toggle's read half.) */
export function isReferenced(refs: readonly PaintReference[], ref: PaintReference): boolean {
  return refs.some((r) => r.kind === ref.kind && r.id === ref.id);
}

/** Add or remove a source — the ONE mutation behind every "Use as reference". */
export function toggleReference(
  refs: readonly PaintReference[],
  ref: PaintReference,
): PaintReference[] {
  return isReferenced(refs, ref)
    ? refs.filter((r) => !(r.kind === ref.kind && r.id === ref.id))
    : [...refs, ref];
}

/** Every clip a reference resolves to right now, plus what it spans in time. */
export interface ResolvedReference {
  /**
   * Clip ids in DOCUMENT order, which is TOPMOST FIRST — `doc.tracks[0]` is the
   * top of the stack and paint order is the tree walked in reverse. Stated,
   * because getting it backwards is how "paint under the line art" lands on top
   * of half of it.
   */
  clipIds: string[];
  /** The clips themselves, for identity-keyed caching. */
  clips: Clip[];
  /** The union of the clips' timelines — what a new layer should span. */
  startMs: number;
  endMs: number;
  /**
   * True when at least one referenced clip is EDITABLE vector geometry — a
   * path, a shape or text. This is the narrow question "is there a contour I
   * could put a fill on", not "does this look like line art", which is why a
   * nested comp full of paths does not set it: from out here a nested comp is a
   * picture, and its contours are not addressable without going inside.
   */
  vector: boolean;
  /**
   * True when at least one referenced clip resolves to PIXELS — a raster layer,
   * an image, a video, a nested comp, an adjustment, a waveform. Anything the
   * renderer can draw, which is deliberately everything: the reference raster
   * goes through `drawFrameContent`, so referencing a video frame, a nested
   * comp or a fully-effected layer needs no new code path and never will.
   */
  raster: boolean;
}

/** Clip kinds whose geometry a fill can address directly (see `vector`). */
const VECTOR_KINDS: ReadonlySet<ClipKind> = new Set<ClipKind>(["path", "shape", "text"]);

/**
 * Clip kinds that contribute PIXELS to a reference.
 *
 * A closed set rather than "not audio", because the honest answer to "can this
 * be referenced" is "can the renderer draw it", and audio is the only thing in
 * the document that cannot. Written as a set so a new visual clip kind is one
 * entry here and inherits the whole feature — reference, fill, paint-inside,
 * preview — rather than being silently invisible to it.
 */
const PIXEL_KINDS: ReadonlySet<ClipKind> = new Set<ClipKind>([
  "raster",
  "image",
  "video",
  "nested",
  "shape",
  "path",
  "text",
  "waveform",
  "trace",
  "adjustment",
]);

/**
 * Resolve references against the document, at one comp.
 *
 * Hidden and locked artwork is skipped for the same reason `resolveStrokeTargets`
 * skips it: a reference is what you can SEE. A time gate is deliberately NOT
 * applied — a reference is the drawing you are working against, and losing it
 * because the playhead sits one frame past the clip is how "paint inside"
 * stops working halfway through a scene for no visible reason. Time enters
 * once, at the span, which is what a new layer is cut to.
 *
 * `refs` empty resolves to every visible clip in the comp: the whole picture.
 */
export function resolveReference(
  doc: MotionDocument,
  frameId: string,
  refs: readonly PaintReference[],
): ResolvedReference {
  const wantAll = refs.length === 0;
  // Resolved once per gesture, not per clip: an unknown kind (a plugin's source
  // that is no longer installed) drops out here rather than being asked about
  // every clip in the comp.
  const live = refs
    .map((r) => ({ ref: r, source: REFERENCE_SOURCES.get(r.kind) }))
    .filter((e): e is { ref: PaintReference; source: ReferenceSourceKind } => !!e.source);

  const out: ResolvedReference = {
    clipIds: [],
    clips: [],
    startMs: Number.POSITIVE_INFINITY,
    endMs: Number.NEGATIVE_INFINITY,
    vector: false,
    raster: false,
  };

  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.frameId !== frameId) continue;
      if (isClipHidden(track, clip) || isClipLocked(track, clip)) continue;
      const wanted =
        wantAll || live.some((e) => e.source.matches({ doc, clip, track, id: e.ref.id }));
      if (!wanted) continue;
      out.clipIds.push(clip.id);
      out.clips.push(clip);
      out.startMs = Math.min(out.startMs, clip.startMs);
      out.endMs = Math.max(out.endMs, clip.startMs + clip.durationMs);
      if (VECTOR_KINDS.has(clip.kind)) out.vector = true;
      if (PIXEL_KINDS.has(clip.kind)) out.raster = true;
    }
  }

  if (out.clips.length === 0) {
    out.startMs = 0;
    out.endMs = 0;
  }
  return out;
}

/**
 * The timing a layer born under a reference should take.
 *
 * "Paint into someone else's outline and the mark lasts exactly as long as the
 * outline does" is the whole of the feature — a new layer that starts at the
 * playhead and runs the default five seconds is a layer you have to retime by
 * hand every single time, which is what made drawing over a reference feel
 * like fighting the timeline.
 *
 * Returns null when there is nothing to inherit (no explicit reference, or an
 * empty one), so the caller keeps its own default and this never has to invent
 * a duration.
 */
export function referenceTiming(
  ref: ResolvedReference,
  refs: readonly PaintReference[],
): { startMs: number; durationMs: number } | null {
  if (refs.length === 0 || ref.clips.length === 0) return null;
  const durationMs = Math.max(1, Math.round(ref.endMs - ref.startMs));
  return { startMs: Math.max(0, Math.round(ref.startMs)), durationMs };
}

/**
 * Which medium a tool with no opinion (the bucket) should produce, given what
 * it is filling against: vector art gets a vector fill, pixels get pixels.
 * Mixed reads as vector — a traced outline can sit over a photo, but a bitmap
 * poured into line art throws away the resolution the line art has.
 */
export function referenceMedium(ref: ResolvedReference): "vector" | "raster" {
  return ref.vector ? "vector" : "raster";
}

/** Clips of a reference that are on screen at `timeMs` (null skips the gate). */
export function referenceLive(ref: ResolvedReference, timeMs: number | null): string[] {
  if (timeMs === null) return ref.clipIds;
  const out: string[] = [];
  for (const clip of ref.clips) {
    if (clip.fillDuration || clipLocalTime(clip, timeMs) !== null) out.push(clip.id);
  }
  return out;
}
