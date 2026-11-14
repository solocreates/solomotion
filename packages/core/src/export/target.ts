import type { Clip, VisualClip } from "../schema/clips";
import type { Frame, MotionDocument } from "../schema/document";
import { isVisualClip } from "../clip-registry";
import { clipEnd, frameDurationMs } from "../timeline/ops";
import { allGroupClips, clipsInGroup, groupClipById, groupOfClip } from "../timeline/groups";
import { compHasAudio } from "../audio/cues";

/**
 * Export targets — the ONE headless brain behind every export surface.
 *
 * Anything exportable is an ExportTarget: a whole frame (comp), a single
 * layer, a group, or an ad-hoc multi-selection. The dialog, the sidebar
 * Export section and the topbar menu all resolve their subject into a target
 * and ask `targetCapabilities` what it can become — which media (image /
 * video / Lottie) make sense, what the smart default is, whether SVG is true
 * vector or needs outlining/rasterizing, and whether there's sound to carry.
 * No surface re-derives any of this; a new clip kind updates ONE detector.
 */

export type ExportTargetKind = "frame" | "layer" | "group" | "selection" | "frames";

export interface ExportTarget {
  kind: ExportTargetKind;
  /** The frame being exported — for "frames", the first of them. */
  frameId: string;
  /** The clips being exported; empty = the whole frame. */
  clipIds: string[];
  /** Display name — the layer/group/frame name (used for filenames + tabs). */
  name: string;
  /**
   * "frames" only: every frame, IN THE ORDER THEY WERE PICKED — that order is
   * the page order of a PDF and the file order of a batch.
   */
  frameIds?: string[];
}

/** The tab-level media an export target can become. */
/** `model` (v89): a 3D world as a 3D file — glTF, USDZ, OBJ, STL, PLY. */
export type ExportMedium = "image" | "video" | "lottie" | "pdf" | "model";

/**
 * How faithfully this target serializes to SVG:
 *  - "vector":  pure shapes/paths — a true, lossless vector SVG.
 *  - "outline": vector once text is converted to outlines at export time.
 *  - "mixed":   vector layers stay vector; raster layers (image/video/nested/
 *               waveform, composite modes) embed as PNG images inside the SVG.
 */
export type SvgFidelity = "vector" | "outline" | "mixed";

export interface ExportCapabilities {
  media: ExportMedium[];
  /** The tab a fresh export panel opens on (video for anything that moves). */
  defaultMedium: ExportMedium;
  animated: boolean;
  hasAudio: boolean;
  svg: SvgFidelity;
  /** Content window on the frame's timeline (video exports default to it). */
  spanMs: { start: number; end: number };
}

// ── Target constructors ──────────────────────────────────────────────────────

/**
 * Several whole frames exported together, in the given order: one PDF with a
 * page each, or one file each for every other medium. One frame is simply a
 * frame target — never a batch of one.
 */
export function framesTarget(doc: MotionDocument, frameIds: readonly string[]): ExportTarget {
  const ids = [...new Set(frameIds)].filter((id) => doc.frames.some((f) => f.id === id));
  if (ids.length <= 1) return frameTarget(doc, ids[0] ?? doc.frames[0]!.id);
  return { kind: "frames", frameId: ids[0]!, clipIds: [], name: `${ids.length} frames`, frameIds: ids };
}

/** The frames a target covers, in export order. */
export function targetFrameIds(target: ExportTarget): string[] {
  return target.kind === "frames" && target.frameIds?.length ? target.frameIds : [target.frameId];
}

export function frameTarget(doc: MotionDocument, frameId: string): ExportTarget {
  const frame = doc.frames.find((f) => f.id === frameId) ?? doc.frames[0]!;
  return { kind: "frame", frameId: frame.id, clipIds: [], name: frame.name };
}

/**
 * The target for a selection of clip ids: one clip = a layer; exactly one
 * whole group = that group (by name); anything else = a plain selection.
 */
export function selectionTarget(doc: MotionDocument, clipIds: string[]): ExportTarget | null {
  const clips = clipIds
    .map((id) => findClip(doc, id))
    .filter((c): c is Clip => c !== undefined);
  if (clips.length === 0) return null;
  const frameId = clips[0]!.frameId;
  const ids = clips.filter((c) => c.frameId === frameId).map((c) => c.id);

  if (ids.length === 1) {
    const clip = clips[0]!;
    // A lone clip that IS a whole group by itself still reads as a layer.
    return { kind: "layer", frameId, clipIds: ids, name: clip.name };
  }
  // Exactly one group, fully selected → the group itself.
  const groupIds = new Set(clips.map((c) => (isVisualClip(c) ? groupOfClip(doc, c.id) : null)));
  if (groupIds.size === 1) {
    const gid = [...groupIds][0];
    if (gid) {
      const members = clipsInGroup(doc, gid);
      if (members.length === ids.length && members.every((m) => ids.includes(m))) {
        const group = groupClipById(doc, gid);
        if (group) return { kind: "group", frameId, clipIds: ids, name: group.name };
      }
    }
  }
  return { kind: "selection", frameId, clipIds: ids, name: `${ids.length} layers` };
}

// ── Capability detection ─────────────────────────────────────────────────────

function findClip(doc: MotionDocument, clipId: string): Clip | undefined {
  for (const track of doc.tracks) {
    for (const clip of track.clips) if (clip.id === clipId) return clip;
  }
  return undefined;
}

/** The clips a target renders (audio excluded — it can't draw). */
export function targetVisualClips(doc: MotionDocument, target: ExportTarget): VisualClip[] {
  const out: VisualClip[] = [];
  for (const track of doc.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.frameId !== target.frameId || !isVisualClip(clip)) continue;
      if (target.clipIds.length === 0 || target.clipIds.includes(clip.id)) out.push(clip);
    }
  }
  return out;
}

/** All target clips including audio (span + sound detection). */
function targetClips(doc: MotionDocument, target: ExportTarget): Clip[] {
  const out: Clip[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.frameId !== target.frameId) continue;
      if (target.clipIds.length === 0 || target.clipIds.includes(clip.id)) out.push(clip);
    }
  }
  return out;
}

/** Does this one clip move over time? (Keyframes, in/out animations, media.) */
export function clipIsAnimated(doc: MotionDocument, clip: Clip): boolean {
  if (clip.keyframes.some((t) => t.keys.length >= 2)) return true;
  if (isVisualClip(clip) && (clip.animIn || clip.animOut)) return true;
  if (clip.kind === "text") {
    if (clip.animations.in || clip.animations.out) return true;
    if (clip.ranges.some((r) => r.animation)) return true;
    // A caption moves by definition: its focus travels the cues over time.
    if (clip.caption && clip.caption.cues.length > 0) return true;
  }
  if (clip.kind === "video" || clip.kind === "waveform" || clip.kind === "trace") return true;
  if (clip.kind === "nested") {
    // A nested comp is animated when its source comp's content is.
    return frameIsAnimated(doc, clip.sourceFrameId, new Set([clip.frameId]));
  }
  if (clip.kind === "image") {
    const asset = doc.assets.find((a) => a.id === clip.assetId);
    if (asset && /gif|apng|webp/i.test(asset.mime)) return true;
  }
  return false;
}

function frameIsAnimated(doc: MotionDocument, frameId: string, guard: Set<string>): boolean {
  if (guard.has(frameId)) return false;
  guard.add(frameId);
  // A still shows one instant whatever it holds — that is what makes it one.
  if (doc.frames.find((f) => f.id === frameId)?.mode === "static") return false;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.frameId !== frameId) continue;
      if (clip.kind === "audio") continue;
      if (clipIsAnimated(doc, clip)) return true;
    }
  }
  return false;
}

/** SVG fidelity for a set of visual clips (see SvgFidelity). */
function detectSvg(doc: MotionDocument, clips: VisualClip[]): SvgFidelity {
  let needsOutline = false;
  const compositeGroups = new Set(
    allGroupClips(doc).filter((g) => g.mode !== "pass" && g.mode !== "union").map((g) => g.id),
  );
  for (const clip of clips) {
    const gid = groupOfClip(doc, clip.id);
    if (gid && compositeGroups.has(gid)) return "mixed";
    if (clip.effects.length > 0) return "mixed";
    if (clip.kind === "shape" || clip.kind === "path") continue;
    if (clip.kind === "text") {
      needsOutline = true;
      continue;
    }
    return "mixed"; // image / video / nested / waveform → embedded raster
  }
  return needsOutline ? "outline" : "vector";
}

/**
 * Everything an export surface needs to know about a target, in one call.
 * Pure and cheap — safe to run on every render of the panel.
 */
export function targetCapabilities(doc: MotionDocument, target: ExportTarget): ExportCapabilities {
  if (target.kind === "frames") return batchCapabilities(doc, targetFrameIds(target));
  const frame = doc.frames.find((f) => f.id === target.frameId) ?? doc.frames[0]!;
  const clips = targetClips(doc, target);
  const visuals = clips.filter(isVisualClip);
  const frameDur = frameDurationMs(doc, frame);

  // A still is one silent picture, whatever layers it holds.
  const still = frame.mode === "static";
  const animated =
    !still &&
    (target.clipIds.length === 0
      ? frameIsAnimated(doc, frame.id, new Set()) || clips.some((c) => c.kind === "audio")
      : clips.some((c) => clipIsAnimated(doc, c)));

  // The ONE headless detector — text typing sounds, audio/video clips AND
  // nested comps that contain any of these, all through the same inventory the
  // exporter schedules from. (The old detector missed text sound entirely,
  // which is why the "include sound" toggle vanished for text-voice comps.)
  const hasAudio = !still && compHasAudio(doc, clips);

  // Layer exports default to the layer's own span; frames render start→end.
  let start = 0;
  let end = frameDur;
  if (target.clipIds.length > 0 && clips.length > 0) {
    start = Math.min(...clips.map((c) => c.startMs));
    end = Math.min(Math.max(...clips.map((c) => clipEnd(c))), frameDur);
    if (end <= start) {
      start = 0;
      end = frameDur;
    }
  }

  // Audio-only targets (an audio layer) can only become sound.
  const media: ExportMedium[] =
    visuals.length === 0 && hasAudio ? ["video"] : ["image", "video"];
  // A world is a picture through its camera — and, whole, a 3D model. Lottie
  // and PDF pages describe flat vectors and cannot hold one.
  if (frame.world) {
    if (target.clipIds.length === 0) media.push("model");
  } else {
    if (animated && visuals.length > 0) media.push("lottie");
    // A whole frame is a page.
    if (target.clipIds.length === 0 && visuals.length > 0) media.push("pdf");
  }

  return {
    media,
    defaultMedium: animated || hasAudio ? "video" : "image",
    animated,
    hasAudio,
    svg: detectSvg(doc, visuals),
    spanMs: { start, end },
  };
}

const SVG_RANK: Record<SvgFidelity, number> = { vector: 0, outline: 1, mixed: 2 };

/**
 * Several frames together: the union of what each can become, the weakest
 * vector fidelity among them, and PDF first when nothing moves — a stack of
 * stills is a document.
 */
function batchCapabilities(doc: MotionDocument, frameIds: string[]): ExportCapabilities {
  const each = frameIds.map((id) => targetCapabilities(doc, frameTarget(doc, id)));
  const animated = each.some((c) => c.animated);
  const hasAudio = each.some((c) => c.hasAudio);
  const media: ExportMedium[] = ["pdf", "image", "video"];
  if (each.some((c) => c.media.includes("lottie"))) media.push("lottie");
  const svg = each.reduce<SvgFidelity>((w, c) => (SVG_RANK[c.svg] > SVG_RANK[w] ? c.svg : w), "vector");
  return {
    media,
    defaultMedium: animated || hasAudio ? "video" : "pdf",
    animated,
    hasAudio,
    svg,
    spanMs: { start: 0, end: Math.max(0, ...each.map((c) => c.spanMs.end)) },
  };
}
