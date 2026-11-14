"use client";

import {
  convertShapeClipToPath,
  deleteClip,
  editPathGeometry,
  locateClip,
  type MotionDocument,
  type DocumentStore,
  type PathClip,
  type RasterClip,
  type Subpath,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import { useSession } from "../state/session";
import { applyInverseLayerBasis, drawFrameContent } from "../stage/render/draw-frame";
import { beginStroke, commitStroke, extendDirty, surfaceForClip, touchSurfaces } from "./raster-store";

/**
 * Layer merging — the Procreate gesture with this document's rules:
 *
 *   vector + vector           → ONE vector layer (subpaths combined into the
 *                               bottom layer's space; its paint wins)
 *   anything touching a pixel → ONE pixel layer (everything renders — with
 *                               its effects, blends, opacity — into the
 *                               bottom-most pixel layer's surface)
 *
 * One undo step. Rasterization goes through drawFrameContent with
 * `only:{...}` — the exact stage renderer — so merged pixels are identical
 * to what was on screen. Merged-away raster clips leave the document but
 * their surfaces stay in the store: undo restores the clips, and their
 * pixels must still be there to greet them.
 */
export function mergeSelectedLayers(store: DocumentStore): void {
  const session = useSession.getState();
  const doc = store.getState();
  const located = session.selectedClipIds
    .map((id) => locateClip(doc, id))
    .filter((l): l is NonNullable<typeof l> => l !== null && l.clip.kind !== "audio");
  if (located.length < 2) {
    toast("Select two or more layers to merge");
    return;
  }
  const frameId = located[0]!.clip.frameId;
  if (located.some((l) => l.clip.frameId !== frameId || l.clip.locked)) {
    toast("Merge needs unlocked layers of one comp");
    return;
  }
  // Bottom→top = reverse z (higher trackIndex paints first).
  const bottomFirst = [...located].sort((a, b) => b.trackIndex - a.trackIndex);
  const allVector = bottomFirst.every((l) => l.clip.kind === "path" || l.clip.kind === "shape");

  if (allVector) mergeVector(store, bottomFirst.map((l) => l.clip.id));
  else mergeRaster(store, frameId, bottomFirst.map((l) => l.clip.id));
}

/** Combine vector layers into the bottom one (its paint wins). */
function mergeVector(store: DocumentStore, bottomFirstIds: string[]): void {
  const targetId = bottomFirstIds[0]!;
  store.update("Merge layers", (d) => {
    // Shapes become paths first (same ids, so the id list stays valid).
    for (const id of bottomFirstIds) {
      const loc = locateClip(d, id);
      if (loc?.clip.kind === "shape") convertShapeClipToPath(d, id);
    }
    const target = locateClip(d, targetId)?.clip;
    if (target?.kind !== "path") return;
    for (const id of bottomFirstIds.slice(1)) {
      const loc = locateClip(d, id);
      if (loc?.clip.kind !== "path") continue;
      // Absorbing another layer's outline grows the target's box, so the write
      // goes through core's pivot-holding seam — the merged art must not shift.
      const absorbed = subpathsInto(loc.clip, target);
      editPathGeometry(target, (subs) => subs.push(...absorbed));
      deleteClip(d, id);
    }
  });
  useSession.getState().select([targetId]);
  toast("Merged into one vector layer");
}

/** `source`'s subpaths re-expressed in `target`'s local space. */
function subpathsInto(source: PathClip, target: PathClip): Subpath[] {
  const st = source.transform;
  const tt = target.transform;
  const sScale = st.scale;
  const sScaleY = st.scaleY ?? st.scale;
  const sRot = (st.rotation * Math.PI) / 180;
  const tScale = Math.max(0.0001, tt.scale);
  const tScaleY = Math.max(0.0001, tt.scaleY ?? tt.scale);
  const tRot = (tt.rotation * Math.PI) / 180;
  const map = (p: { x: number; y: number }): { x: number; y: number } => {
    // source local → frame …
    const x = p.x * sScale;
    const y = p.y * sScaleY;
    const fx = st.x + x * Math.cos(sRot) - y * Math.sin(sRot);
    const fy = st.y + x * Math.sin(sRot) + y * Math.cos(sRot);
    // … → target local.
    const dx = fx - tt.x;
    const dy = fy - tt.y;
    const rx = dx * Math.cos(-tRot) - dy * Math.sin(-tRot);
    const ry = dx * Math.sin(-tRot) + dy * Math.cos(-tRot);
    return { x: rx / tScale, y: ry / tScaleY };
  };
  return source.subpaths.map((sp) => ({
    ...sp,
    closed: sp.closed,
    points: sp.points.map((pt) => ({
      ...map(pt),
      hIn: pt.hIn ? map(pt.hIn) : null,
      hOut: pt.hOut ? map(pt.hOut) : null,
    })),
  }));
}

/** Rasterize the whole selection into the bottom-most pixel layer. */
function mergeRaster(store: DocumentStore, frameId: string, bottomFirstIds: string[]): void {
  const doc = store.getState();
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame) return;
  // The receiving surface: the bottom-most RASTER layer in the selection.
  const targetLoc = bottomFirstIds
    .map((id) => locateClip(doc, id))
    .find((l) => l?.clip.kind === "raster");
  const target = targetLoc?.clip as RasterClip | undefined;
  if (!target) {
    toast("Merging mixed layers needs a pixel layer in the selection");
    return;
  }

  const surface = surfaceForClip(target);
  const tx = beginStroke(target);
  const t = target.transform;
  const scale = Math.max(0.0001, t.scale);

  surface.ctx.save();
  // Surface space ← frame space: THE inverse layer map (not a hand-rolled
  // rotate-then-scale, which drops the shear, assumes a central pivot, and
  // undoes non-uniform scale in the wrong order), then render every selected
  // layer — target included, since its pixels are already there, so it's
  // excluded from the pass — exactly as the stage draws it.
  surface.ctx.translate(target.width / 2, target.height / 2);
  applyInverseLayerBasis(surface.ctx, {
    scale,
    scaleY: Math.max(0.0001, t.scaleY ?? t.scale),
    rotation: t.rotation,
    skewX: t.skewX,
    skewY: t.skewY,
    anchor: t.anchor,
    size: { width: target.width, height: target.height, cx: 0, cy: 0 },
  });
  surface.ctx.translate(-t.x - frame.width / 2, -t.y - frame.height / 2);
  const others = bottomFirstIds.filter((id) => id !== target.id);
  drawFrameContent(surface.ctx, doc, frame, useSession.getState().playheadMs, {
    only: new Set(others),
    transparent: true,
  });
  surface.ctx.restore();

  extendDirty(tx, 0, 0, target.width, target.height);
  const nextRev = target.rev + 1;
  if (!commitStroke(tx, nextRev)) return;
  store.update("Merge layers", (d) => {
    const live = locateClip(d, target.id);
    if (live?.clip.kind === "raster") live.clip.rev = nextRev;
    // Merged-away layers leave the doc; their surfaces stay for undo.
    for (const id of others) deleteClip(d, id);
  });
  touchSurfaces();
  useSession.getState().select([target.id]);
  toast("Merged into one pixel layer");
}

/** Every selected clip can merge (2+, one comp, unlocked, non-audio). */
export function canMergeSelection(doc: MotionDocument, selectedClipIds: string[]): boolean {
  const located = selectedClipIds
    .map((id) => locateClip(doc, id))
    .filter((l): l is NonNullable<typeof l> => l !== null);
  if (located.length < 2) return false;
  const frameId = located[0]!.clip.frameId;
  return located.every(
    (l) => l.clip.kind !== "audio" && l.clip.frameId === frameId && !l.clip.locked,
  );
}

/** Narrow helper the panel uses for labels ("→ vector" vs "→ pixel"). */
export function mergeResultKind(doc: MotionDocument, selectedClipIds: string[]): "vector" | "raster" {
  const kinds = selectedClipIds.map((id) => locateClip(doc, id)?.clip.kind);
  return kinds.every((k) => k === "path" || k === "shape") ? "vector" : "raster";
}
