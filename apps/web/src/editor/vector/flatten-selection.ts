"use client";

import {
  DEFAULT_LAYOUT_ITEM,
  cloneLayerEffects,
  createId,
  deepestCommonAncestor,
  flattenClipsToPath,
  groupParent,
  pruneGroups,
  moveClipsToScope,
  groupOfClip,
  selectionTopUnits,
  solidPaint,
  translateSubpaths,
  type MotionDocument,
  type DocumentStore,
  type PathClip,
  type Contour,
  type VisualClip,
  CENTER_ANCHOR,
} from "@solomotion/core";
import { NO_CONTENT, NO_CROP, adoptContours } from "@solomotion/core";
import { textToSubpaths } from "../export/text-outline";

/**
 * Flatten-to-path (⌘E) — the ONE app entry that collapses any selection into a
 * single editable path clip. The geometry brain lives headless in core
 * (`flattenClipsToPath`); this layer only does the two things core can't:
 *
 *  - resolve text to real outlines (fonts live in the browser), and
 *  - mutate the timeline: swap the merged path in for the sources and dissolve
 *    the now-empty groups.
 *
 * Works on a lone shape/text, a boolean/combine group, or a deep nest of them —
 * whatever core can reduce to one region.
 */

function visualClips(doc: MotionDocument): VisualClip[] {
  const out: VisualClip[] = [];
  for (const t of doc.tracks) for (const c of t.clips) if (c.kind !== "audio") out.push(c);
  return out;
}

/**
 * @returns the new path clip's id, or null when nothing was flattenable (e.g. a
 * lone raster layer, or a font that couldn't be outlined).
 */
export async function flattenSelectionToPath(
  store: DocumentStore,
  clipIds: string[],
): Promise<string | null> {
  const doc = store.getState();
  const all = new Map(visualClips(doc).map((c) => [c.id, c]));
  const sources = clipIds.map((id) => all.get(id)).filter((c): c is VisualClip => !!c);
  if (sources.length === 0) return null;

  // Pre-outline every text layer in the selection (async font loads) so the
  // sync core reducer can pull each clip's local geometry from a plain map.
  const outlines = new Map<string, Contour[]>();
  let outlineFill: string | null = null;
  for (const clip of sources) {
    if (clip.kind !== "text") continue;
    const outlined = await textToSubpaths(doc, clip);
    if (outlined) {
      outlines.set(clip.id, outlined.subpaths);
      outlineFill ??= outlined.fill;
    }
  }

  const result = flattenClipsToPath(store.getState(), clipIds, {
    outlineOf: (clip) => outlines.get(clip.id) ?? null,
  });
  if (!result) return null;

  const cx = (result.bounds.minX + result.bounds.maxX) / 2;
  const cy = (result.bounds.minY + result.bounds.maxY) / 2;
  // Re-anchor the geometry on its own centre so the path behaves like any other
  // clip (transform.x/y is the anchor; geometry is centred on it).
  const subpaths = result.subpaths.map((s) => ({
    closed: s.closed,
    points: s.points.map((p) => ({ ...p, hIn: p.hIn && { ...p.hIn }, hOut: p.hOut && { ...p.hOut } })),
  }));
  translateSubpaths(subpaths, -cx, -cy);

  const newId = createId("clip");

  store.update("Flatten to path", (d) => {
    const live = new Map(visualClips(d).map((c) => [c.id, c]));
    const liveSources = clipIds.map((id) => live.get(id)).filter((c): c is VisualClip => !!c);
    if (liveSources.length === 0) return;

    // Where the merged path lands: the enclosing container of the whole
    // selection (the top-level units' shared parent), and the slot of the
    // topmost source so z-order is preserved.
    const units = selectionTopUnits(d, clipIds);
    const anchors = [
      ...units.groups.map((g) => groupParent(d, g)),
      ...units.clips.map((id) => groupOfClip(d, id)),
    ];
    const groupId = deepestCommonAncestor(d, anchors.length ? anchors : [null]);

    // The topmost source lane IN THAT CONTAINER — a member's row inside a
    // group being flattened away is not a lane the result can live on.
    let topTrackIdx = Infinity;
    let topClip: VisualClip = liveSources[0]!;
    d.tracks.forEach((track, ti) => {
      if ((track.groupId ?? null) !== groupId) return;
      for (const c of track.clips) {
        if (clipIds.includes(c.id) && ti < topTrackIdx) {
          topTrackIdx = ti;
          topClip = c as VisualClip;
        }
      }
    });
    const topTrack = d.tracks.find((t) => t.clips.some((c) => c.id === topClip.id))!;
    const insertAt = topTrack.clips.findIndex((c) => c.id === topClip.id);

    const fills = result.fills.length
      ? result.fills.map((f) => ({ ...f }))
      : [solidPaint(outlineFill ?? "#000000")];

    const pathClip: PathClip = {
      id: newId,
      kind: "path",
      contourStyles: {},
      layoutItem: { ...DEFAULT_LAYOUT_ITEM },
      name: topClip.name || "Flattened",
      frameId: topClip.frameId,
      trackBinding: null,
    audioEffects: [],
      motionBlur: topClip.motionBlur,
      feather: 0,
      borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
      crop: { ...NO_CROP },
      content: { ...NO_CONTENT },
      startMs: topClip.startMs,
      durationMs: topClip.durationMs,
      keyframes: [],
      linkGroupId: null,
      mirrorId: null,
      // One path out of many: it came from somewhere only if they all came from the same place.
      origin: liveSources.every((c) => c.origin?.id === liveSources[0]?.origin?.id) ? (liveSources[0]?.origin ?? null) : null,
      fillDuration: topClip.fillDuration,
      locked: false,
      hidden: false,
      audioMix: topClip.audioMix,
      transform: { x: cx, y: cy, scale: 1, scaleY: null, rotation: 0, skewX: 0, skewY: 0, anchor: { ...CENTER_ANCHOR } },
      maxWidth: null,
      effects: cloneLayerEffects(topClip.effects),
      opacity: 1,
      blendMode: "normal",
      isStencil: false,
      fps: null,
      animIn: null,
      sounds: [],
      animOut: null,
      subpaths: [],
      fillRule: result.fillRule,
      fills,
      strokes: result.strokes.map((s) => ({ ...s })),
    };

    adoptContours(pathClip, subpaths);

    // Remove every source clip, then drop the merged path into the top slot.
    const sourceIds = new Set(clipIds);
    for (const track of d.tracks) {
      track.clips = track.clips.filter((c) => !sourceIds.has(c.id));
    }
    const target = d.tracks.find((t) => t.id === topTrack.id)!;
    target.clips.splice(Math.min(insertAt, target.clips.length), 0, pathClip);
    if ((target.groupId ?? null) !== groupId) moveClipsToScope(d, [newId], groupId);

    pruneGroups(d);
  });

  return newId;
}
