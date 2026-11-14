import { current, isDraft } from "immer";
import { createId } from "./ids";
import { createNestedClip } from "./factories";
import { internalPageId, isInternalPage } from "./pages";
import { remapClipRefsAfterCopy } from "./timeline/links";
import {
  compOwnerNested,
  frameContentDurationMs,
  frameDurationMs,
  isClipLocked,
  locateClip,
  nestClips,
  reissueClipIds,
  sortTrackClips,
} from "./timeline/ops";
import type { Clip, Frame, NestedClip, MotionDocument, Track } from "./schema";
import { remapTransitions } from "./timeline/transitions";

/**
 * The COMPONENT system — Figma's model, built on the nested-comp foundation.
 *
 * A component is just a FRAME flagged as a definition (`frame.component != null`).
 * A nested clip whose `sourceFrameId` points at a component frame is an
 * INSTANCE. Nested clips SHARE their source comp by default — duplicating,
 * pasting or ⌥-dragging one references the SAME frame (no frame duplication, no
 * proliferation), so editing the content stays in sync. Divergence is always an
 * EXPLICIT choice, never a side effect of copying:
 *
 *  - `makeComponent` promotes a selection into a reusable shared definition;
 *  - `detachInstance` clones a component's frame into a fresh PRIVATE one, so
 *    that one clip's content + animation can go its own way.
 *
 * `cloneFrameContent` is the deep-clone primitive both build on.
 */

function frameById(doc: MotionDocument, id: string): Frame | undefined {
  return doc.frames.find((f) => f.id === id);
}

/** A frame flagged as a reusable component definition. */
export function isComponentFrame(frame: Frame): boolean {
  return frame.component != null;
}

/** Every component definition frame in the document (all variants of every set). */
export function componentFrames(doc: MotionDocument): Frame[] {
  return doc.frames.filter(isComponentFrame);
}

/**
 * The id of the component SET a variant frame belongs to. `setId ?? frame.id`
 * so legacy/standalone components (no explicit set) are their own set with no
 * migration — the one seam every set/variant query reads.
 */
export function componentSetId(frame: Frame): string | null {
  if (!frame.component) return null;
  return frame.component.setId ?? frame.id;
}

/** Every variant frame in a component set (a set = the dashed box in the view). */
export function componentSet(doc: MotionDocument, setId: string): Frame[] {
  return doc.frames.filter((f) => isComponentFrame(f) && componentSetId(f) === setId);
}

/** Sibling variants of a component frame (including itself), or [] if not a component. */
export function variantsOf(doc: MotionDocument, frame: Frame): Frame[] {
  const setId = componentSetId(frame);
  return setId ? componentSet(doc, setId) : [];
}

/** The main/default variant of a set: the frame whose id IS the setId, else the first. */
export function mainVariant(doc: MotionDocument, setId: string): Frame | null {
  const members = componentSet(doc, setId);
  return members.find((f) => f.id === setId) ?? members[0] ?? null;
}

/** The component frame this clip is an INSTANCE of, or null (plain nested / not nested). */
export function componentFrameOfClip(doc: MotionDocument, clip: Clip): Frame | null {
  if (clip.kind !== "nested") return null;
  const f = frameById(doc, clip.sourceFrameId);
  return f && isComponentFrame(f) ? f : null;
}

export function isInstanceClip(doc: MotionDocument, clip: Clip): boolean {
  return componentFrameOfClip(doc, clip) != null;
}

/** How a clip participates in the component system — drives its icon/badge. */
export type ComponentRole = "instance" | "nested";

export function clipComponentRole(doc: MotionDocument, clip: Clip): ComponentRole | null {
  if (clip.kind !== "nested") return null;
  return componentFrameOfClip(doc, clip) ? "instance" : "nested";
}

/**
 * Deep-clone a frame and everything that renders into it into a NEW private
 * frame (never a component — a clone is always independent). Recurses into
 * PRIVATE nested children so the whole sub-tree is independent; nested children
 * that are component instances keep their shared reference. Returns the new
 * frame id, or null if the source is missing. Mutates — call inside an update.
 */
export function cloneFrameContent(
  doc: MotionDocument,
  sourceFrameId: string,
  opts: { pageId?: string | null } = {},
): string | null {
  return cloneFrameInto(doc, sourceFrameId, "pageId" in opts ? opts.pageId ?? null : undefined, new Map(), new Set());
}

function cloneFrameInto(
  doc: MotionDocument,
  sourceFrameId: string,
  pageId: string | null | undefined,
  frameMap: Map<string, string>,
  stack: Set<string>,
): string | null {
  const cached = frameMap.get(sourceFrameId);
  if (cached) return cached;
  const src = frameById(doc, sourceFrameId);
  if (!src || stack.has(sourceFrameId)) return null; // missing or cyclic
  stack.add(sourceFrameId);

  const clone: Frame = {
    ...(isDraft(src) ? (current(src) as Frame) : src),
    id: createId("frame"),
    component: null, // a private clone is never itself a component
    pageId: pageId === undefined ? src.pageId : pageId,
  };
  doc.frames.push(clone);
  frameMap.set(sourceFrameId, clone.id);

  const clones = cloneCompRows(doc, sourceFrameId, clone.id);


  // Private nested children get their own clone (kept in sync via frameMap so
  // two children sharing one private source share one clone); instances stay
  // shared with their component.
  for (const c of clones) {
    if (c.kind !== "nested") continue;
    const childSrc = frameById(doc, c.sourceFrameId);
    if (!childSrc || isComponentFrame(childSrc)) continue;
    const childClone = cloneFrameInto(doc, c.sourceFrameId, childSrc.pageId, frameMap, stack);
    if (childClone) c.sourceFrameId = childClone;
  }

  stack.delete(sourceFrameId);
  return clone.id;
}

/**
 * Copy every row of a comp into a new comp, ROW FOR ROW — the one place a
 * comp's layers are cloned, under Duplicate and every component clone alike.
 *
 * Two passes, because a row's GROUP is a clip that may sit on any other row:
 * every clip is re-issued first, so the old → new id map is complete before a
 * single reference is rewritten. The duplicate used to map ids one row at a
 * time and seat every copy on a row with `groupId: null`, so a duplicated comp
 * kept its group clip — empty, holding the keys — and dropped its members to
 * the comp's origin, still and silent.
 *
 * Each copied row is a NEW row placed right above its original, never the
 * original shared: a row carries visibility, lock and mute, and hiding a layer
 * in the copy must not hide it in the source. The row's membership names the
 * copied group, its transitions name the copied clips, and links and waveform
 * targets stay inside the copy (`remapClipRefsAfterCopy`).
 */
export function cloneCompRows(
  doc: MotionDocument,
  fromFrameId: string,
  toFrameId: string,
  /**
   * Called once per copy, before any row is placed — what a caller owns about
   * a copied clip beyond the comp (a drawing cell's lineage and raster pixels,
   * its nested comps). Rows and references are this function's, never the hook's.
   */
  each?: (original: Clip, copy: Clip) => void,
): Clip[] {
  const rows: Array<{ track: Track; clones: Clip[] }> = [];
  const idMap = new Map<string, string>();
  for (const track of [...doc.tracks]) {
    const originals = track.clips.filter((c) => c.frameId === fromFrameId);
    if (originals.length === 0) continue;
    const clones = originals.map((orig) => {
      const c = reissueClipIds(orig);
      c.frameId = toFrameId;
      idMap.set(orig.id, c.id);
      each?.(orig, c);
      return c;
    });
    rows.push({ track, clones });
  }
  for (const { track, clones } of rows) {
    const row: Track = {
      id: createId("track"),
      name: track.name,
      clips: clones,
      // Membership is comp-scoped: a group of this comp came along and is mapped.
      groupId: track.groupId ? idMap.get(track.groupId) ?? null : null,
      muted: track.muted,
      locked: false,
      hidden: track.hidden,
      color: track.color,
      heightPx: track.heightPx,
      homeCompId: null,
      auto: track.auto,
      loop: track.loop,
      transitions: remapTransitions(track.transitions, idMap, fromFrameId, toFrameId),
    };
    sortTrackClips(row);
    doc.tracks.splice(doc.tracks.indexOf(track), 0, row);
  }
  const clones = rows.flatMap((r) => r.clones);
  remapClipRefsAfterCopy(doc, clones, idMap);
  return clones;
}

/**
 * Duplicate a comp. A COMPONENT frame (or an existing linked instance)
 * duplicates into a LINKED INSTANCE frame — the same source-sharing bond a
 * nested-clip instance has, at the frame level: nothing is cloned, the copy
 * points back at the master via `instanceOf`. Anything else is a full,
 * independent deep clone (`cloneFrameContent`, private nested comps included)
 * placed beside the original. Returns the new frame id. Mutates.
 */
export function duplicateFrame(doc: MotionDocument, frameId: string): string | null {
  const frame = frameById(doc, frameId);
  if (!frame) return null;
  const masterId = frame.component ? frame.id : frame.instanceOf;
  if (masterId) {
    const master = frameById(doc, masterId) ?? frame;
    const copy: Frame = {
      ...(isDraft(frame) ? (current(frame) as Frame) : frame),
      id: createId("frame"),
      name: master.name,
      x: frame.x + frame.width + 120,
      component: null, // an instance is not itself a master/definition
      instanceOf: masterId,
    };
    doc.frames.push(copy);
    return copy.id;
  }
  const id = cloneFrameContent(doc, frameId);
  const copy = id ? frameById(doc, id) : undefined;
  if (!copy) return null;
  copy.name = `${frame.name} copy`;
  copy.x = frame.x + frame.width + 120;
  return copy.id;
}

/**
 * Garbage-collect orphaned private nested source comps: any frame on the
 * INTERNAL shelf that no nested clip references anymore (and that isn't a
 * component definition) is removed along with its clips. Called after deletions
 * so deleting a nested clip cleans up its comp instead of leaving a dangling
 * frame + phantom layers. Component frames are NEVER collected (they're
 * reusable and may legitimately have zero instances). Mutates — call in update.
 */
export function gcOrphanNestedSources(doc: MotionDocument): void {
  const referenced = new Set<string>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "nested") referenced.add(clip.sourceFrameId);
    }
  }
  // An original kept by a render in place still needs its comps — it will be
  // put back. The ledger is a reference like any clip.
  for (const meta of Object.values(doc.renderedClips)) {
    const kept = [meta.originalSnapshot, ...(meta.rows ?? []).flatMap((t: { clips: unknown[] }) => t.clips)] as Array<{ kind?: string; sourceFrameId?: string }>;
    for (const c of kept) if (c?.kind === "nested" && c.sourceFrameId) referenced.add(c.sourceFrameId);
  }
  const orphanIds = new Set(
    doc.frames
      .filter((f) => isInternalPage(f.pageId) && !isComponentFrame(f) && !referenced.has(f.id))
      .map((f) => f.id),
  );
  if (orphanIds.size === 0) return;
  doc.frames = doc.frames.filter((f) => !orphanIds.has(f.id));
  for (const track of doc.tracks) {
    track.clips = track.clips.filter((c) => !orphanIds.has(c.frameId));
  }
}

const GENERIC_NAMES = new Set(["Nested", "Nested clip", "Frame", ""]);

/**
 * Flag an existing FRAME as a reusable component definition IN PLACE — it stays
 * on its own page (edit it naturally, right where it lives) and is never moved
 * or duplicated. The virtual "Components" view (see `COMPONENTS_VIEW_ID`)
 * aggregates every component wherever it sits, so promotion never rips a frame
 * out of its scene. The one seam every "create component" path ends at.
 * `preferredName` (e.g. an instance clip's name) wins over a generic frame name.
 * Mutates — call in update.
 */
function promoteFrameToComponent(frame: Frame, preferredName?: string): void {
  // A freshly-promoted frame is the MAIN variant of its own new set (setId ==
  // its own id); added variants share this setId. See `componentSetId`.
  frame.component = { description: "", setId: frame.id, variantName: "Main" };
  frame.name =
    preferredName && !GENERIC_NAMES.has(preferredName)
      ? preferredName
      : !GENERIC_NAMES.has(frame.name)
        ? frame.name
        : "Component";
}

/**
 * Promote a selection into a reusable COMPONENT (Figma "create component").
 * A linked INSTANCE stays exactly where the content was — edit any copy and
 * every one syncs:
 *  - single plain nested clip → its private source becomes the master; the clip
 *    is the instance.
 *  - single EXISTING instance → detached into a fresh private frame first, then
 *    promoted as a NEW, independent set (never re-links to the origin);
 *  - anything else → precompose the selection (`nestClips` leaves the source
 *    comp + an instance in place), then flag the source a component.
 * Returns the master frame id + the instance clip id. Mutates.
 */
export function makeComponent(
  doc: MotionDocument,
  clipIds: string[],
): { frameId: string; clipId: string } | null {
  const located = clipIds
    .map((id) => locateClip(doc, id))
    .filter((l): l is NonNullable<typeof l> => l !== null && !isClipLocked(l.track, l.clip));
  if (located.length === 0) return null;

  let componentFrameId: string;
  let instanceClipId: string;

  const only = located.length === 1 ? located[0]!.clip : null;
  if (only && only.kind === "nested") {
    const src = frameById(doc, only.sourceFrameId);
    if (!src) return null;
    if (isComponentFrame(src)) {
      // Already an instance — DETACH it into a fresh private frame, then promote
      // that as a brand-new independent set. This is the reliable "make a
      // separate component out of this copy" path; it never touches the origin.
      if (!detachInstance(doc, only.id)) return null;
      const detached = locateClip(doc, only.id)?.clip;
      if (!detached || detached.kind !== "nested") return null;
      componentFrameId = detached.sourceFrameId;
    } else {
      componentFrameId = src.id;
    }
    instanceClipId = only.id;
  } else {
    const nestedId = nestClips(doc, clipIds);
    if (!nestedId) return null;
    const loc = locateClip(doc, nestedId);
    if (!loc || loc.clip.kind !== "nested") return null;
    componentFrameId = loc.clip.sourceFrameId;
    instanceClipId = nestedId;
  }

  const frame = frameById(doc, componentFrameId);
  const inst = locateClip(doc, instanceClipId)?.clip;
  if (!frame || !inst) return null;
  promoteFrameToComponent(frame, inst.name);
  inst.name = frame.name;

  return { frameId: componentFrameId, clipId: instanceClipId };
}

/**
 * Turn a whole FRAME into a reusable component (Figma "create component" on an
 * artboard) — TRULY, in place: the frame itself becomes the definition. Nothing
 * is moved, cloned or wrapped (no confusing frame-inside-a-frame). It stays
 * exactly where it is and simply starts appearing in the virtual Components view
 * (which lists every component frame wherever it lives). No-op-safe: an already-
 * component frame returns as-is. Returns the frame id, or null. Mutates.
 */
export function makeComponentFromFrame(doc: MotionDocument, frameId: string): string | null {
  const frame = frameById(doc, frameId);
  if (!frame) return null;
  if (isComponentFrame(frame)) return frame.id;
  promoteFrameToComponent(frame);
  return frame.id;
}

export interface CreateInstanceInput {
  frameId: string;
  startMs: number;
  x?: number;
  y?: number;
  durationMs?: number;
}

/**
 * Build a nested clip that INSTANCES a component (shares its definition). Not
 * placed — the caller runs it through `placeClip` so track-fitting is reused,
 * exactly like media/library placement. Returns null if the id isn't a component.
 */
export function createComponentInstanceClip(
  doc: MotionDocument,
  componentFrameId: string,
  input: CreateInstanceInput,
): NestedClip | null {
  const frame = frameById(doc, componentFrameId);
  if (!frame || !isComponentFrame(frame)) return null;
  const durationMs = input.durationMs ?? Math.max(50, frameContentDurationMs(doc, componentFrameId));
  return createNestedClip({
    frameId: input.frameId,
    sourceFrameId: componentFrameId,
    startMs: input.startMs,
    durationMs,
    x: input.x ?? 0,
    y: input.y ?? 0,
    name: frame.name,
    playback: { loop: frame.loop },
  });
}

/**
 * What a nested clip's inside IS to it — the one answer the layer badge, the
 * API and "Make unique" read:
 *
 *  - `embedded`  its OWN comp: on the internal shelf, shown by this clip alone.
 *                It has no home but this layer; you reach it by entering it.
 *  - `linked`    a comp that lives elsewhere — an artboard on a page, or an
 *                inside other clips share. Edits show everywhere it is linked.
 *  - `instance`  a component's instance (linked, with overrides).
 *
 * Derived from where the source is STORED and who else shows it, never stored
 * on the clip, so it cannot disagree with the document. (After Effects: every
 * precomp layer is a link to a project item. Figma: instances link, a pasted
 * frame is a copy. Blender: data is linked until you make it single-user.)
 */
export type NestedSource = "embedded" | "linked" | "instance";

export function nestedSourceOf(doc: MotionDocument, clip: Clip): NestedSource | null {
  if (clip.kind !== "nested") return null;
  if (componentFrameOfClip(doc, clip)) return "instance";
  return compOwnerNested(doc, clip.sourceFrameId)?.id === clip.id ? "embedded" : "linked";
}

/**
 * MAKE UNIQUE (Blender "make single user", Final Cut "reference new parent
 * clip", Figma "detach instance"): give this clip its own copy of its inside,
 * embedded on the internal shelf, so its content and animation can diverge
 * from the comp it linked to. The original — a scene on its page, a component
 * master, the inside other clips share — is untouched. Returns the new source
 * frame id, or null when the clip is not nested or is already embedded.
 * Mutates — call in update.
 */
export function makeUnique(doc: MotionDocument, clipId: string): string | null {
  const clip = locateClip(doc, clipId)?.clip;
  if (!clip || clip.kind !== "nested" || nestedSourceOf(doc, clip) === "embedded") return null;
  const source = frameById(doc, clip.sourceFrameId);
  if (!source) return null;
  const cycleMs = frameDurationMs(doc, source);
  const privateId = cloneFrameContent(doc, source.id, { pageId: internalPageId(doc) });
  if (!privateId) return null;
  clip.sourceFrameId = privateId;
  // An embedded comp's length IS its clip's, so a looping clip pins the cycle
  // it was playing — a 12 s scene looped in a 9 s tile keeps looping 12 s.
  const pb = clip.playback;
  if (pb.loop !== "none" && pb.loopLengthMs == null) pb.loopLengthMs = cycleMs / (pb.speed > 0 ? pb.speed : 1);
  return privateId;
}

/**
 * Detach an instance from its component (Figma "detach instance") — `makeUnique`
 * for a component's instance. Returns false if the clip isn't an instance.
 */
export function detachInstance(doc: MotionDocument, clipId: string): boolean {
  const clip = locateClip(doc, clipId)?.clip;
  if (!clip || !componentFrameOfClip(doc, clip)) return false;
  return makeUnique(doc, clipId) != null;
}

/**
 * Detach a LINKED INSTANCE FRAME (`instanceOf`) from its master — the frame-level
 * twin of `detachInstance`. Clones the master's content INTO this frame (fresh
 * independent clips) and clears the link, so it becomes an ordinary frame whose
 * content can now diverge. Returns false if the frame isn't a linked instance.
 * Mutates — call inside an update.
 */
export function detachInstanceFrame(doc: MotionDocument, frameId: string): boolean {
  const frame = frameById(doc, frameId);
  if (!frame || !frame.instanceOf) return false;
  // Reuse the deep-clone primitive: clone the master into a scratch frame, then
  // re-home its clips onto THIS frame and drop the scratch (private nested
  // children the clone made keep their own new frames).
  const tempId = cloneFrameContent(doc, frame.instanceOf, { pageId: frame.pageId });
  frame.instanceOf = null;
  if (!tempId) return true;
  for (const track of doc.tracks) {
    for (const c of track.clips) if (c.frameId === tempId) c.frameId = frame.id;
    sortTrackClips(track);
  }
  doc.frames = doc.frames.filter((f) => f.id !== tempId);
  return true;
}

// ── Variants (named alternates) ──────────────────────────────────────────────
//
// A component SET (one `setId`) holds one or more variant frames — each a full
// alternate version with its own content. The MAIN is the frame whose id is the
// setId. An INSTANCE (a linked frame via `instanceOf`, or a nested clip via
// `sourceFrameId`) points at whichever variant it currently shows; switching is
// just repointing that one link, so the instance's own placement/transform is
// preserved. All of this is pure data — one headless brain, every surface renders.

/**
 * Add a VARIANT to a component set by cloning `fromFrameId`'s content into a new
 * sibling component frame (same `setId`, a fresh `variantName`), placed beside
 * it. Returns the new variant frame id, or null if `fromFrameId` isn't a
 * component. Mutates.
 */
export function addVariant(doc: MotionDocument, fromFrameId: string, name?: string): string | null {
  const from = frameById(doc, fromFrameId);
  if (!from || !from.component) return null;
  const setId = componentSetId(from)!;
  const count = componentSet(doc, setId).length; // variants BEFORE this one
  const newId = cloneFrameContent(doc, fromFrameId, { pageId: from.pageId });
  if (!newId) return null;
  const nf = frameById(doc, newId)!;
  nf.instanceOf = null;
  nf.component = { description: "", setId, variantName: name?.trim() || `Variant ${count}` };
  nf.name = from.name; // the set shares one name; `variantName` distinguishes members
  nf.x = from.x + from.width + 80;
  nf.y = from.y;
  return newId;
}

/** Rename a variant within its set. Returns false if the frame isn't a component. */
export function renameVariant(doc: MotionDocument, frameId: string, name: string): boolean {
  const frame = frameById(doc, frameId);
  if (!frame || !frame.component) return false;
  frame.component.variantName = name.trim() || frame.component.variantName;
  return true;
}

/**
 * Point an INSTANCE at a different variant of its set — works for a linked
 * instance FRAME (`instanceOf`) or a nested-clip instance (`sourceFrameId`). The
 * instance's own transform/placement is untouched; only which variant it renders
 * changes. Returns false if `id` isn't an instance or `variantFrameId` isn't a
 * component. Mutates.
 */
export function switchInstanceVariant(doc: MotionDocument, id: string, variantFrameId: string): boolean {
  const variant = frameById(doc, variantFrameId);
  if (!variant || !variant.component) return false;
  const frame = frameById(doc, id);
  if (frame && frame.instanceOf) {
    frame.instanceOf = variantFrameId;
    return true;
  }
  const loc = locateClip(doc, id);
  if (loc && loc.clip.kind === "nested") {
    loc.clip.sourceFrameId = variantFrameId;
    return true;
  }
  return false;
}

/**
 * Delete a variant from its set. Instances pointing at it fall back to the set's
 * main (or another surviving variant), so nothing breaks. Refuses to delete the
 * last variant. Returns false if it isn't a component / is the only one. Mutates.
 */
export function deleteVariant(doc: MotionDocument, frameId: string): boolean {
  const frame = frameById(doc, frameId);
  if (!frame || !frame.component) return false;
  const setId = componentSetId(frame)!;
  const members = componentSet(doc, setId);
  if (members.length <= 1) return false;
  const fallback =
    (mainVariant(doc, setId)?.id !== frameId ? mainVariant(doc, setId) : null) ??
    members.find((m) => m.id !== frameId)!;
  for (const f of doc.frames) if (f.instanceOf === frameId) f.instanceOf = fallback.id;
  for (const t of doc.tracks) {
    for (const c of t.clips) if (c.kind === "nested" && c.sourceFrameId === frameId) c.sourceFrameId = fallback.id;
  }
  doc.frames = doc.frames.filter((f) => f.id !== frameId);
  for (const t of doc.tracks) t.clips = t.clips.filter((c) => c.frameId !== frameId);
  return true;
}

/**
 * The component set a frame OR clip participates in, plus which variant it shows —
 * the one query every component-aware surface (inspector, right-click, Components
 * view) reads. Returns null when the target isn't part of a set.
 */
export interface ComponentContext {
  setId: string;
  variants: Frame[];
  main: Frame | null;
  /** The variant this instance currently renders (or the frame itself if it's a variant). */
  current: Frame | null;
  /** True when the target is an INSTANCE (linked frame / nested clip), not the definition. */
  isInstance: boolean;
}

export function componentContextOfFrame(doc: MotionDocument, frame: Frame): ComponentContext | null {
  const def = frame.instanceOf ? frameById(doc, frame.instanceOf) : frame.component ? frame : null;
  if (!def || !def.component) return null;
  const setId = componentSetId(def)!;
  return {
    setId,
    variants: componentSet(doc, setId),
    main: mainVariant(doc, setId),
    current: def,
    isInstance: frame.instanceOf != null,
  };
}

export function componentContextOfClip(doc: MotionDocument, clip: Clip): ComponentContext | null {
  const def = componentFrameOfClip(doc, clip);
  if (!def) return null;
  const setId = componentSetId(def)!;
  return { setId, variants: componentSet(doc, setId), main: mainVariant(doc, setId), current: def, isInstance: true };
}
