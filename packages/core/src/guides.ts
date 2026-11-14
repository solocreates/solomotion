import type { MotionDocument, Frame, FrameGuide } from "./schema";
import type { GuideLine } from "./snapping/viewport-snap";

/**
 * RULER GUIDES, two homes (D17): a FRAME guide rides with its artboard
 * (frame-local `pos`); a PAGE guide lives on the board itself (canvas `pos`)
 * and can be dropped anywhere. Both are the same record; what differs is the
 * owner and so the origin. Every surface goes through `guideOwner`, so moving,
 * styling and deleting a guide never asks which kind it is.
 */
export interface GuideOwner {
  kind: "frame" | "page";
  id: string;
  guides: FrameGuide[];
  /** World origin `pos` is measured from: the frame's corner, or (0, 0). */
  ox: number;
  oy: number;
  /** The extent a guide's line spans for snapping (world); a page guide spans the board. */
  lo: { x: number; y: number };
  hi: { x: number; y: number };
}

/** A page guide's snap extent: far beyond any board a person works on. */
export const PAGE_GUIDE_REACH = 1e7;

/**
 * The owner of `ownerId` — a frame id or a page id. `guides` is the live array:
 * pass `write` inside a store update (a page may not have one yet, and only a
 * draft may be given one); reads never mutate, so a frozen state is safe.
 */
export function guideOwner(doc: MotionDocument, ownerId: string, write = false): GuideOwner | null {
  const f = doc.frames.find((x) => x.id === ownerId);
  if (f) {
    return { kind: "frame", id: f.id, guides: f.guides, ox: f.x, oy: f.y, lo: { x: f.x, y: f.y }, hi: { x: f.x + f.width, y: f.y + f.height } };
  }
  const p = doc.pages.find((x) => x.id === ownerId);
  if (!p) return null;
  if (write) p.guides ??= [];
  const R = PAGE_GUIDE_REACH;
  return { kind: "page", id: p.id, guides: p.guides ?? [], ox: 0, oy: 0, lo: { x: -R, y: -R }, hi: { x: R, y: R } };
}

/** A guide's line in world space, for drawing and for the snap engine. */
export function guideLineWorld(owner: GuideOwner, g: Pick<FrameGuide, "axis" | "pos">): GuideLine {
  return g.axis === "x"
    ? { axis: "x", pos: owner.ox + g.pos, lo: owner.lo.y, hi: owner.hi.y }
    : { axis: "y", pos: owner.oy + g.pos, lo: owner.lo.x, hi: owner.hi.x };
}

/** Every guide line an owner holds, world space. */
export const guideLinesOf = (owner: GuideOwner | null): GuideLine[] => (owner ? owner.guides.map((g) => guideLineWorld(owner, g)) : []);

/**
 * Where a guide dropped at world point `at` belongs (Figma): inside a frame →
 * that frame's guide (topmost frame wins, i.e. the LAST in `frames`), anywhere
 * else → a page guide. `pos` is returned in the owner's space.
 */
export function resolveGuideDrop(
  frames: ReadonlyArray<Pick<Frame, "id" | "x" | "y" | "width" | "height">>,
  pageId: string,
  axis: "x" | "y",
  at: { x: number; y: number },
): { ownerId: string; kind: "frame" | "page"; pos: number } {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i]!;
    if (at.x >= f.x && at.x <= f.x + f.width && at.y >= f.y && at.y <= f.y + f.height) {
      return { ownerId: f.id, kind: "frame", pos: axis === "x" ? at.x - f.x : at.y - f.y };
    }
  }
  return { ownerId: pageId, kind: "page", pos: axis === "x" ? at.x : at.y };
}

/** One guide by owner + id, for reads and draft writes alike. */
export function findGuide(doc: MotionDocument, ownerId: string, guideId: string): FrameGuide | null {
  return guideOwner(doc, ownerId)?.guides.find((g) => g.id === guideId) ?? null;
}

/** Remove a guide from whichever owner holds it. Call on a draft. */
export function removeGuide(doc: MotionDocument, ownerId: string, guideId: string): boolean {
  const f = doc.frames.find((x) => x.id === ownerId);
  const p = f ? null : doc.pages.find((x) => x.id === ownerId);
  const list = f?.guides ?? p?.guides;
  if (!list || !list.some((g) => g.id === guideId)) return false;
  const next = list.filter((g) => g.id !== guideId);
  if (f) f.guides = next;
  else if (p) p.guides = next;
  return true;
}
