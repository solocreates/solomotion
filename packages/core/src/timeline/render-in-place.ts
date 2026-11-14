import type { MotionDocument, Clip, RenderInPlaceMeta, Track } from "../schema";
import { isVisualClip } from "../clip-registry";
import { isComponentFrame, isInstanceClip } from "../components";
import { createId } from "../ids";
import { hashString } from "../hash";
import { isLayoutMember } from "../relations/layout";
import { cloneClip, locateClip, nestClips } from "./ops";
import { expandToDescendants } from "./groups";

/**
 * RENDER IN PLACE (headless) — the DaVinci contract: a layer becomes MEDIA in
 * its own slot, and the original is kept whole so it can come back exactly.
 *
 * The rendered clip is ordinary footage — an image sequence or a video — with
 * the original's id, slot, span, link, lock and visibility, so selection,
 * links and keyframe references survive. `doc.renderedClips[id]` keeps what it
 * replaced: the clip itself, a group's member rows (lifted out whole), and a
 * nested clip's comp (still in the document; the ledger counts as a reference
 * to it). A picture with sound gets its sound baked beside it, linked.
 *
 * The render is made in the SLOT's space: the layer alone, without the groups
 * above it, so putting the render back in the slot gives each group's look
 * exactly once. The encode itself is web-side; this is only the document
 * surgery, pure and testable.
 */

export function isRenderedInPlace(doc: MotionDocument, clipId: string): boolean {
  return clipId in doc.renderedClips;
}

export function renderInPlaceMeta(doc: MotionDocument, clipId: string): RenderInPlaceMeta | undefined {
  return doc.renderedClips[clipId] as RenderInPlaceMeta | undefined;
}

/**
 * Can this layer be rendered in place? Sound: imported audio (the audio swap).
 * Pictures: every visual layer except those whose picture is not theirs to
 * bake — an adjustment grades what is beneath it, a component instance draws
 * through overrides, and an auto-layout member is placed by its row.
 */
export function canRenderClipInPlace(doc: MotionDocument, clip: Clip): boolean {
  if (clip.kind === "audio") return clip.source.type === "asset";
  if (!isVisualClip(clip) || clip.kind === "adjustment") return false;
  if (isLayoutMember(doc, clip.id) !== null) return false;
  if (clip.kind === "nested") {
    const source = doc.frames.find((f) => f.id === clip.sourceFrameId);
    if (!source || isComponentFrame(source) || isInstanceClip(doc, clip)) return false;
  }
  return true;
}

/** A group's interior rows, at every depth — what rides with it. */
export function subtreeRows(doc: MotionDocument, clip: Clip): Track[] {
  if (clip.kind !== "group") return [];
  const groups = new Set([clip.id]);
  for (const id of expandToDescendants(doc, [clip.id])) {
    if (locateClip(doc, id)?.clip.kind === "group") groups.add(id);
  }
  return doc.tracks.filter((t) => t.groupId !== null && groups.has(t.groupId));
}

/**
 * Swap the clip at `clipId`'s slot for `replacement`, preserving slot-level
 * identity (id, start, comp, link group, lock/hide, mask role) so the timeline
 * sees the same clip in the same place — only its content changed.
 */
export function replaceClipInSlot(doc: MotionDocument, clipId: string, replacement: Clip): boolean {
  const loc = locateClip(doc, clipId);
  if (!loc) return false;
  const old = loc.clip;
  replacement.id = old.id;
  replacement.startMs = old.startMs;
  replacement.frameId = old.frameId;
  replacement.linkGroupId = old.linkGroupId;
  replacement.locked = old.locked;
  replacement.hidden = old.hidden;
  replacement.mirrorId = old.mirrorId;
  if (replacement.kind !== "audio" && old.kind !== "audio") replacement.isStencil = old.isStencil;
  loc.track.clips[loc.clipIndex] = replacement;
  return true;
}

/**
 * The parts of a rendered clip a person can change — everything but its
 * identity. Compared against the committed baseline to tell "untouched" from
 * "edited since it was rendered".
 */
function containerOf(clip: Clip): string {
  const rest: Record<string, unknown> = { ...clip };
  // Identity, slot, and which media it plays — a re-render swaps the media and
  // may change its format, and neither is an edit to the layer.
  for (const key of IDENTITY_KEYS) delete rest[key];
  return JSON.stringify(rest);
}

const IDENTITY_KEYS = [
  "id", "name", "kind", "locked", "hidden", "linkGroupId", "mirrorId", "startMs", "frameId",
  "assetId", "volume", "muted", "keepPitch", "pitchSemitones",
] as const;

/**
 * The container of `from` (everything a person edits on a layer) poured onto
 * `into` — how a re-render in a new format keeps what was done to the old one.
 */
export function carryContainer(from: Clip, into: Clip): void {
  const carried: Record<string, unknown> = { ...from };
  for (const key of IDENTITY_KEYS) delete carried[key];
  Object.assign(into, carried);
}

/**
 * What a render of this layer is made FROM, fingerprinted when a render starts
 * and again before it commits — a render runs in the background while you keep
 * working, and must not commit a picture of what the layer USED to be. For a
 * layer already rendered it is the kept original, not the render.
 */
export function renderInputSignature(doc: MotionDocument, clipId: string): string | null {
  const meta = renderInPlaceMeta(doc, clipId);
  const clip = meta?.originalSnapshot ?? locateClip(doc, clipId)?.clip;
  if (!clip) return null;
  const rows = meta ? meta.rows : subtreeRows(doc, clip);
  const parts: unknown[] = [doc.variables, doc.graphs, clip, rows];
  const seen = new Set<string>();
  const visit = (c: Clip) => {
    if (c.kind !== "nested" || seen.has(c.sourceFrameId)) return;
    seen.add(c.sourceFrameId);
    for (const t of doc.tracks) {
      const inside = t.clips.filter((x) => x.frameId === c.sourceFrameId);
      if (inside.length === 0) continue;
      parts.push(t.id, t.hidden, t.groupId, inside);
      inside.forEach(visit);
    }
  };
  [clip, ...rows.flatMap((t) => t.clips)].forEach(visit);
  return hashString(JSON.stringify(parts));
}

export interface RenderCommit {
  /** The rendered media clip, already pointing at its asset. */
  rendered: Clip;
  assetId: string;
  /** Baked sound for a picture that had any; laid beside it, linked. */
  sound: Clip | null;
  signature: string;
}

/**
 * Commit a render: the original (and a group's rows) is lifted into the
 * ledger and the rendered media takes its slot. On a RE-render the true
 * original is kept — snapshots never chain — and the previous sound clip goes.
 * Returns the ids of assets the commit released, for collection.
 */
export function applyRenderInPlace(doc: MotionDocument, clipId: string, commit: RenderCommit): string[] {
  const loc = locateClip(doc, clipId);
  if (!loc) return [];
  const released: string[] = [];
  const existing = renderInPlaceMeta(doc, clipId);
  let originalSnapshot: Clip;
  let rows: Track[];
  if (existing) {
    originalSnapshot = existing.originalSnapshot;
    rows = existing.rows;
    released.push(existing.assetId);
    if (existing.soundClipId) released.push(...removeClip(doc, existing.soundClipId));
  } else {
    originalSnapshot = cloneClip(loc.clip);
    rows = subtreeRows(doc, loc.clip);
    doc.tracks = doc.tracks.filter((t) => !rows.includes(t));
  }
  if (!replaceClipInSlot(doc, clipId, commit.rendered)) return released;

  let soundClipId: string | null = null;
  if (commit.sound) {
    const slot = locateClip(doc, clipId)!;
    const link = slot.clip.linkGroupId ?? createId("link");
    slot.clip.linkGroupId = link;
    commit.sound.linkGroupId = link;
    commit.sound.startMs = slot.clip.startMs;
    commit.sound.frameId = slot.clip.frameId;
    const lane: Track = {
      ...slot.track,
      id: createId("track"),
      name: "Sound",
      clips: [commit.sound],
      transitions: [],
    };
    doc.tracks.splice(slot.trackIndex + 1, 0, lane);
    soundClipId = commit.sound.id;
  }

  doc.renderedClips[clipId] = {
    originalSnapshot,
    rows,
    assetId: commit.assetId,
    soundClipId,
    // A re-render keeps the FIRST baseline: edits made to the render before it
    // was redone are still edits, and must still come back on the original.
    baseline: existing ? existing.baseline : containerOf(locateClip(doc, clipId)!.clip),
    signature: commit.signature,
    renderedAt: Date.now(),
  };
  return released;
}

export interface RevertResult {
  /** Assets the render used, for collection. */
  released: string[];
  /** The render was edited, so the original came back wrapped in a nested
   *  clip carrying those edits. */
  wrapped: boolean;
}

/**
 * Put the original back.
 *
 * UNTOUCHED — the original returns exactly as it was, its group rows with it.
 * Moved in time only — the same, shifted by the move (members too).
 * EDITED any other way (transformed, faded, given effects, keyframed, sped,
 * trimmed) — those edits were made to a picture of the WHOLE layer, and the
 * one lossless way to keep them is to apply them to the whole layer: the
 * original comes back inside a full-frame nested clip that carries the
 * render's container verbatim. Full-frame means the wrapper is the render's
 * geometry exactly, so nothing needs converting and nothing moves.
 */
export function revertRenderInPlace(
  doc: MotionDocument,
  clipId: string,
  /** `carryEdits: false` — the bare original, as a re-render needs to bake it. */
  opts: { carryEdits?: boolean } = {},
): RevertResult | null {
  const meta = renderInPlaceMeta(doc, clipId);
  const loc = locateClip(doc, clipId);
  if (!meta || !loc) return null;
  const rendered = cloneClip(loc.clip);
  const released = [meta.assetId];
  if (meta.soundClipId) released.push(...removeClip(doc, meta.soundClipId));

  const original = cloneClip(meta.originalSnapshot);
  const shift = rendered.startMs - original.startMs;
  const edited = containerOf(rendered) !== meta.baseline;
  replaceClipInSlot(doc, clipId, original);
  const slot = locateClip(doc, clipId)!;
  // The rendered clip was always one item; a link it gained after commit (the
  // sound) belongs to the render, not the original.
  slot.clip.linkGroupId = meta.originalSnapshot.linkGroupId;
  const rows = meta.rows.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...cloneClip(c), startMs: c.startMs + shift })) }));
  doc.tracks.splice(slot.trackIndex + 1, 0, ...rows);
  delete doc.renderedClips[clipId];

  if (!edited || opts.carryEdits === false) return { released, wrapped: false };

  const wrapperId = nestClips(doc, [clipId], rendered.name, { fullFrame: true });
  const wrapper = wrapperId ? locateClip(doc, wrapperId)?.clip : undefined;
  if (!wrapper || wrapper.kind !== "nested" || rendered.kind === "audio") return { released, wrapped: false };
  // The link was the original's; it belongs on the clip in the slot.
  const inner = locateClip(doc, clipId)?.clip;
  if (inner) inner.linkGroupId = null;
  carryContainer(rendered, wrapper);
  Object.assign(wrapper, {
    startMs: rendered.startMs,
    linkGroupId: meta.originalSnapshot.linkGroupId,
    playback: rendered.kind === "image" || rendered.kind === "video" ? (rendered.playback ?? wrapper.playback) : wrapper.playback,
    trimInMs: "trimInMs" in rendered ? rendered.trimInMs : 0,
  });
  return { released, wrapped: true };
}

/** Keep the render, forget the original — the space-saving end of the dialog. */
export function forgetRenderInPlace(doc: MotionDocument, clipId: string): string[] {
  const meta = renderInPlaceMeta(doc, clipId);
  if (!meta) return [];
  delete doc.renderedClips[clipId];
  return [...originalAssets(doc, meta)];
}

/**
 * Every asset an original reads — the clip, its rows, and the comps it nests,
 * at any depth. What "don't keep the original" can free, and what the dialog
 * weighs.
 */
export function originalAssets(doc: MotionDocument, meta: Pick<RenderInPlaceMeta, "originalSnapshot" | "rows">): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const visit = (c: Clip) => {
    if (c.kind === "image" || c.kind === "video") out.add(c.assetId);
    else if (c.kind === "audio" && c.source.type === "asset") out.add(c.source.assetId);
    else if (c.kind === "nested" && !seen.has(c.sourceFrameId)) {
      seen.add(c.sourceFrameId);
      for (const t of doc.tracks) for (const inner of t.clips) if (inner.frameId === c.sourceFrameId) visit(inner);
    }
  };
  visit(meta.originalSnapshot);
  for (const t of meta.rows) for (const c of t.clips) visit(c);
  return out;
}

/** Comps an original still needs — the ledger's claim on nested sources. */
export function framesHeldByRenders(doc: MotionDocument): Set<string> {
  const held = new Set<string>();
  for (const meta of Object.values(doc.renderedClips) as RenderInPlaceMeta[]) {
    const all = [meta.originalSnapshot, ...meta.rows.flatMap((t) => t.clips)];
    for (const c of all) if (c.kind === "nested") held.add(c.sourceFrameId);
  }
  return held;
}

function removeClip(doc: MotionDocument, clipId: string): string[] {
  const loc = locateClip(doc, clipId);
  if (!loc) return [];
  loc.track.clips.splice(loc.clipIndex, 1);
  if (loc.track.clips.length === 0) doc.tracks.splice(loc.trackIndex, 1);
  return loc.clip.kind === "audio" && loc.clip.source.type === "asset" ? [loc.clip.source.assetId] : [];
}

/**
 * Does rendering this — a frame (and every comp it nests), or just these layers
 * and what they hold — draw any layer rendered in place? The export offers
 * "use renders / re-render originals" only when the answer is yes.
 */
export function rendersWithin(doc: MotionDocument, frameId: string, clipIds: readonly string[] = []): boolean {
  const rendered = new Set(Object.keys(doc.renderedClips));
  if (rendered.size === 0) return false;
  const frames = new Set<string>();
  const visitFrame = (id: string) => {
    if (frames.has(id)) return;
    frames.add(id);
    for (const t of doc.tracks) for (const c of t.clips) if (c.frameId === id && c.kind === "nested") visitFrame(c.sourceFrameId);
  };
  if (clipIds.length === 0) {
    visitFrame(frameId);
    return doc.tracks.some((t) => t.clips.some((c) => frames.has(c.frameId) && rendered.has(c.id)));
  }
  for (const id of expandToDescendants(doc, [...clipIds])) {
    if (rendered.has(id)) return true;
    const c = locateClip(doc, id)?.clip;
    if (c?.kind === "nested") visitFrame(c.sourceFrameId);
  }
  return doc.tracks.some((t) => t.clips.some((c) => frames.has(c.frameId) && rendered.has(c.id)));
}
