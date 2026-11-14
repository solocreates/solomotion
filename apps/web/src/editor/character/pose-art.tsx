"use client";

import * as React from "react";
import {
  clipPictureRevision,
  framedOnFocus,
  locateClip,
  poseSetWorldFocus,
  poseSetSubjects,
  resolvedDocAt,
  type MotionDocument,
  type Clip,
  type GroupClip,
  type Pose,
  type PoseSet,
  type VisualClip,
  drivesSet,
  layersBoxAt,
} from "@solomotion/core";
import { cn } from "@/lib/utils";
import { posterAt, releasePosterDemand } from "../preview/poster-cache";
import { usePosterPaint } from "../preview/use-poster";
import { clipObjectBounds } from "../stage/render/draw-frame";

/**
 * POSE PICTURES — the one picture of a character in each of its poses, shared
 * by every surface that shows one: the Face pad's tiles and the timeline's
 * pose blocks (docs/adr/characters/timeline-and-sidebar.md: "one picture
 * cache, two places"). Pictures come from the poster store; this module only
 * decides WHAT they are of and how they are framed.
 */

/**
 * THE CHARACTER AT REST, for its pose pictures: UNPLACED in a flat comp (no
 * x/y, no turn — a picture shows the pose, not where the character stands),
 * every bone at rest, every set at its own base (channel keys and drivers set
 * aside, so a blink or a voice cannot change a picture). Its revision is what
 * every picture of this character keys on, so posing, moving or scrubbing the
 * character re-renders none. In a WORLD the placement stays: the camera
 * frames the character where it stands.
 */
export interface CharacterArt {
  doc: MotionDocument;
  rev: string;
  world: boolean;
}

/** Where the character stands — not part of what a pose looks like. */
const PLACEMENT = new Set(["x", "y", "rotation"]);

function characterArtOf(doc: MotionDocument, groupId: string): CharacterArt {
  const group = locateClip(doc, groupId)?.clip;
  const world = !!(group && doc.frames.find((f) => f.id === group.frameId)?.world);
  const tracks = doc.tracks.map((t) => {
    if (!t.clips.some((c) => c.id === groupId)) return t;
    return {
      ...t,
      clips: t.clips.map((c): Clip => {
        if (c.id !== groupId || c.kind !== "group") return c;
        const rests = (k: string) => k.startsWith("pose.") || k.startsWith("bone.") || (!world && PLACEMENT.has(k));
        const drivers = c.drivers ? Object.fromEntries(Object.entries(c.drivers).filter(([k]) => !rests(k))) : undefined;
        return {
          ...c,
          transform: world ? c.transform : { ...c.transform, x: 0, y: 0, rotation: 0 },
          rig: c.rig ? { ...c.rig, bones: c.rig.bones.map((b) => (b.pose ? { ...b, pose: undefined } : b)) } : c.rig,
          modulators: c.modulators?.filter((m) => !rests(m.target)),
          keyframes: c.keyframes.filter((k) => !rests(k.property)),
          drivers: drivers && Object.keys(drivers).length ? drivers : undefined,
        };
      }),
    };
  });
  const rest = { ...doc, tracks };
  return { doc: rest, rev: clipPictureRevision(rest, groupId), world };
}

const artByDoc = new WeakMap<MotionDocument, Map<string, CharacterArt>>();
/** The last art per character — handed back while its revision holds, so memoised pictures survive edits elsewhere. */
const stableArt = new Map<string, CharacterArt>();

/** The character's rest art — computed once per document, the SAME object while its revision holds. */
export function characterArt(doc: MotionDocument, groupId: string): CharacterArt {
  let per = artByDoc.get(doc);
  if (!per) artByDoc.set(doc, (per = new Map()));
  const hit = per.get(groupId);
  if (hit) return hit;
  const next = characterArtOf(doc, groupId);
  const prev = stableArt.get(groupId);
  const art = prev && prev.rev === next.rev && prev.world === next.world ? prev : next;
  stableArt.set(groupId, art);
  per.set(groupId, art);
  return art;
}

/** The rest picture with ONE set showing ONE pose outright — remembered per art, so repaints ask the poster store with the same document. */
const posedDocs = new WeakMap<MotionDocument, Map<string, MotionDocument>>();
export function posedDoc(art: CharacterArt, groupId: string, setId: string, pose: Pose): MotionDocument {
  let byKey = posedDocs.get(art.doc);
  if (!byKey) posedDocs.set(art.doc, (byKey = new Map()));
  const key = `${groupId}/${setId}/${pose.id}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const tracks = art.doc.tracks.map((t) =>
    !t.clips.some((c) => c.id === groupId)
      ? t
      : {
          ...t,
          clips: t.clips.map((c): Clip => {
            if (c.id !== groupId || c.kind !== "group") return c;
            const set = c.poses?.find((x) => x.id === setId);
            // The tile shows THIS pose: its keys, its driver and the behaviors
            // that choose it (a machine waving the hand) stand aside here.
            const drivers = c.drivers ? Object.fromEntries(Object.entries(c.drivers).filter(([path]) => path !== `pose.${setId}`)) : c.drivers;
            return {
              ...c,
              poses: c.poses?.map((x) => (x.id === setId ? { ...x, show: pose.id } : x)),
              keyframes: c.keyframes.filter((k) => k.property !== `pose.${setId}`),
              drivers,
              behaviors: set ? c.behaviors?.filter((b) => !drivesSet(b, set, art.doc)) : c.behaviors,
            };
          }),
        },
  );
  const out = { ...art.doc, tracks };
  byKey.set(key, out);
  return out;
}

/** A focus box, comp px about the frame's centre (the space `drawClipPoster` frames in). */
export type Focus = { minX: number; minY: number; maxX: number; maxY: number };

let measureCtx: CanvasRenderingContext2D | null = null;
const focusMemo = new WeakMap<CharacterArt, WeakMap<PoseSet, Focus | null>>();

/**
 * WHAT A SET'S PICTURES FRAME — one square around everything its poses change,
 * across all of them (`poseSetSubjects`: what a pose writes, and the pieces
 * that move with the bones it turns), so the pictures share one framing and
 * compare at a glance: Open and Closed are two eyes, not a whole character two
 * pixels tall. Never tighter than a third of the character, so a pupil set
 * still reads as a face. Null in a world (its camera frames it) or when the
 * set changes nothing measurable (the character, whole). Remembered per art
 * and set.
 */
export function setFocus(art: CharacterArt, groupId: string, set: PoseSet): Focus | null {
  let per = focusMemo.get(art);
  if (!per) focusMemo.set(art, (per = new WeakMap()));
  if (per.has(set)) return per.get(set)!;
  const focus = measureFocus(art, groupId, set);
  per.set(set, focus);
  return focus;
}

function measureFocus(art: CharacterArt, groupId: string, set: PoseSet): Focus | null {
  if (art.world) return null;
  const subjects = poseSetSubjects(art.doc, groupId, set.id);
  const group = locateClip(art.doc, groupId)?.clip;
  const frame = group && art.doc.frames.find((f) => f.id === group.frameId);
  if (!subjects.length || !group || group.kind === "audio" || !frame) return null;
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return null;
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const pose of set.poses) {
    const resolved = resolvedDocAt(posedDoc(art, groupId, set.id, pose), group.startMs, frame.id);
    const clips = subjects.map((id) => locateClip(resolved, id)?.clip).filter((c): c is VisualClip => !!c && c.kind !== "audio");
    // Where the part IS — placed and carried by its rig (a hand rides its arm),
    // in comp-centre px like the bounds below.
    const posed = layersBoxAt(resolved, clips, group.startMs);
    if (posed) {
      const b = { minX: posed.cx - posed.width / 2, minY: posed.cy - posed.height / 2, maxX: posed.cx + posed.width / 2, maxY: posed.cy + posed.height / 2 };
      box.minX = Math.min(box.minX, b.minX);
      box.minY = Math.min(box.minY, b.minY);
      box.maxX = Math.max(box.maxX, b.maxX);
      box.maxY = Math.max(box.maxY, b.maxY);
      continue;
    }
    for (const c of clips) {
      const b = clipObjectBounds(resolved, measureCtx, frame, c, 0, false, group.startMs);
      if (!Number.isFinite(b.minX) || !(b.maxX > b.minX)) continue;
      box.minX = Math.min(box.minX, b.minX);
      box.minY = Math.min(box.minY, b.minY);
      box.maxX = Math.max(box.maxX, b.maxX);
      box.maxY = Math.max(box.maxY, b.maxY);
    }
  }
  if (!Number.isFinite(box.minX)) return null;
  const whole = clipObjectBounds(art.doc, measureCtx, frame, group as VisualClip, 0, false, group.startMs);
  const wholeSide = Math.max(whole.maxX - whole.minX, whole.maxY - whole.minY);
  const side = Math.min(wholeSide * 1.1, Math.max((box.maxX - box.minX) * 1.3, (box.maxY - box.minY) * 1.3, wholeSide / 3));
  const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
  return { minX: cx - side / 2, minY: cy - side / 2, maxX: cx + side / 2, maxY: cy + side / 2 };
}

const worldFocusMemo = new WeakMap<CharacterArt, WeakMap<PoseSet, ReturnType<typeof poseSetWorldFocus>>>();

/**
 * A WORLD set's focus: the sphere around what its poses move (the lips a mouth
 * morphs, the lids an eye closes — `poseSetWorldFocus`), so each 3D picture is
 * the part, through the world's own camera pulled in on it.
 */
export function setWorldFocus(art: CharacterArt, groupId: string, set: PoseSet) {
  if (!art.world) return null;
  let per = worldFocusMemo.get(art);
  if (!per) worldFocusMemo.set(art, (per = new WeakMap()));
  if (per.has(set)) return per.get(set)!;
  const group = locateClip(art.doc, groupId)?.clip;
  const focus = group ? poseSetWorldFocus(art.doc, groupId, set.id, group.startMs) : null;
  per.set(set, focus);
  return focus;
}

const framedDocs = new WeakMap<MotionDocument, Map<string, MotionDocument>>();
/** The posed world shot through its camera pulled in on the set's part — remembered per posed document. */
function framedWorld(posed: MotionDocument, frameId: string, timeMs: number, focus: NonNullable<ReturnType<typeof poseSetWorldFocus>>): MotionDocument {
  let per = framedDocs.get(posed);
  if (!per) framedDocs.set(posed, (per = new Map()));
  const key = `${frameId}@${timeMs}`;
  const hit = per.get(key);
  if (hit) return hit;
  const out = framedOnFocus(posed, frameId, timeMs, focus) ?? posed;
  per.set(key, out);
  return out;
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** Poster tier the pictures ask for — crisp at tile size on a retina screen. */
const TILE_TIER_PX = 128;

/**
 * One pose picture: the poster store's picture of the posed rest character —
 * framed on the set's focus in 2D, through the world's own camera in 3D. Its
 * key is the art revision, the pose's values and the framing: nothing the
 * character does on the timeline is part of it.
 */
export const PoseThumb = React.memo(function PoseThumb({
  art,
  character,
  set,
  pose,
  className,
  style,
}: {
  art: CharacterArt;
  character: GroupClip;
  set: PoseSet;
  pose: Pose;
  className?: string;
  /** A width narrower than the picture crops it about its middle (the part it frames). */
  style?: React.CSSProperties;
}) {
  const ref = React.useRef<HTMLCanvasElement | null>(null);
  const owner = React.useRef({}).current;
  React.useEffect(() => () => releasePosterDemand(owner), [owner]);
  const focus = setFocus(art, character.id, set);
  const world = setWorldFocus(art, character.id, set);
  const key = React.useMemo(
    () =>
      `pose:${set.id}:${pose.id}:${art.rev}:${hash(JSON.stringify(pose.values))}:${
        focus ? [focus.minX, focus.minY, focus.maxX, focus.maxY].map(Math.round).join(",") : world ? `w${world.center.map(Math.round).join(",")}r${Math.round(world.radius)}` : "whole"
      }`,
    [set.id, pose, art.rev, focus, world],
  );
  usePosterPaint(() => {
    releasePosterDemand(owner);
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const posed = posedDoc(art, character.id, set.id, pose);
    const clip = locateClip(posed, character.id)?.clip;
    if (!clip) return;
    const shot = art.world && world ? framedWorld(posed, clip.frameId, clip.startMs, world) : posed;
    const picture = art.world
      ? posterAt({ doc: shot, source: { kind: "comp", id: clip.frameId, key, mode: "still", stepMs: Infinity, aspect: null }, sourceMs: clip.startMs, heightPx: TILE_TIER_PX }, owner)
      : posterAt({ doc: posed, clip, source: { kind: "layer", id: clip.id, key, mode: "still", stepMs: Infinity, aspect: 1 }, sourceMs: 0, heightPx: TILE_TIER_PX, focus: focus ?? undefined }, owner);
    if (!picture) return;
    if (canvas.width !== picture.width) canvas.width = picture.width;
    if (canvas.height !== picture.height) canvas.height = picture.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(picture, 0, 0);
  }, [art, character.id, set.id, pose, key, focus, world]);
  return <canvas ref={ref} style={style} className={cn("pointer-events-none", art.world ? "aspect-video object-cover" : "aspect-square", style?.width !== undefined ? "object-cover" : "object-contain", className)} aria-hidden />;
});
