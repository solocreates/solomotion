import { clipByIdIn, isVisualClip, linkForChain, shearPoint, textLinkAt, unshearPoint, type MotionDocument, type Clip, type Link, type LinkHit } from "@solomotion/core";
import type { ClipHitRect, LinkRun } from "./render/draw-frame";

/**
 * WHICH LINK IS UNDER A POINT — over the renderer's own hit rects, so the
 * stage's click, its ⌘-hover outline and the PDF exporter's link areas are one
 * geometry (ADR-links). Text-run areas ride the rect (`linkRuns`, fractions of
 * its local box), so rotation, skew, scale and nesting come from the code that
 * already does them for selection.
 *
 * The policy over the stack is core's `linkForChain`: the topmost painted
 * layer is the target, and its link bubbles out through its groups and the
 * nested comps hosting it — HTML's rule.
 */

type Pt = { x: number; y: number };

/** World point → the rect's local box, as fractions (−0.5…0.5 across it). */
function toLocalUnit(h: ClipHitRect, p: Pt): Pt {
  const rad = (-h.rotation * Math.PI) / 180;
  const dx = p.x - h.cx;
  const dy = p.y - h.cy;
  const l = unshearPoint(dx * Math.cos(rad) - dy * Math.sin(rad), dx * Math.sin(rad) + dy * Math.cos(rad), h.skewX, h.skewY);
  return { x: l.x / (h.width || 1), y: l.y / (h.height || 1) };
}

/** The rect's local unit point → world (the inverse of `toLocalUnit`, T·R·K·S). */
export function fromLocalUnit(h: ClipHitRect, u: number, v: number): Pt {
  const rad = (h.rotation * Math.PI) / 180;
  const s = shearPoint(u * h.width, v * h.height, h.skewX, h.skewY);
  return { x: h.cx + s.x * Math.cos(rad) - s.y * Math.sin(rad), y: h.cy + s.x * Math.sin(rad) + s.y * Math.cos(rad) };
}

function inside(h: ClipHitRect, p: Pt): boolean {
  const l = toLocalUnit(h, p);
  return Math.abs(l.x) <= 0.5 && Math.abs(l.y) <= 0.5;
}

function runAt(h: ClipHitRect, p: Pt): LinkRun | null {
  if (!h.linkRuns?.length) return null;
  const l = toLocalUnit(h, p);
  return h.linkRuns.find((r) => l.x >= r.u0 && l.x <= r.u1 && l.y >= r.v0 && l.y <= r.v1) ?? null;
}

/** A world-space quad (4 corners) — what the outline and the PDF area are drawn from. */
export type Quad = [Pt, Pt, Pt, Pt];

function quadOf(h: ClipHitRect, u0 = -0.5, v0 = -0.5, u1 = 0.5, v1 = 0.5): Quad {
  return [fromLocalUnit(h, u0, v0), fromLocalUnit(h, u1, v0), fromLocalUnit(h, u1, v1), fromLocalUnit(h, u0, v1)];
}

export interface LinkUnderPoint extends LinkHit {
  /** Where the link is, in world space: its run's line boxes, or its layer's box. */
  areas: Quad[];
}

/** Every area a link carried by `carrier` covers — a run's lines, or the layer's box. */
export function linkAreas(hits: readonly ClipHitRect[], carrier: string, span: { start: number; end: number } | null): Quad[] {
  const out: Quad[] = [];
  for (const h of hits) {
    if (h.clipId !== carrier) continue;
    if (!span) out.push(quadOf(h));
    else for (const r of h.linkRuns ?? []) if (r.start < span.end && r.end > span.start) out.push(quadOf(h, r.u0, r.v0, r.u1, r.v1));
  }
  return out;
}

/**
 * The link a press at `world` means, or null. Groups are boxes, not targets
 * (their members are — a linked group is reached by bubbling from them).
 */
export function linkAtPoint(doc: MotionDocument, hits: readonly ClipHitRect[], world: Pt, clipOf: (id: string) => Clip | null): LinkUnderPoint | null {
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i]!;
    if (!inside(h, world)) continue;
    const clip = clipOf(h.clipId);
    if (!clip || (clip.kind === "group" && !clip.layout)) continue;
    // The target, then the nested comps hosting it, outward.
    const chain = [h.clipId];
    let frameId = h.frameId;
    for (let d = h.depth - 1, j = i - 1; d >= 0 && j >= 0; j--) {
      const k = hits[j]!;
      if (k.depth !== d) continue;
      const host = clipOf(k.clipId);
      if (host?.kind === "nested" && host.sourceFrameId === frameId && inside(k, world)) {
        chain.push(host.id);
        frameId = host.frameId;
        d--;
      }
    }
    const run = runAt(h, world);
    const hit = linkForChain(doc, chain, run ? run.start : null, clipOf);
    if (!hit) return null;
    return { ...hit, areas: linkAreas(hits, hit.clipId, hit.span) };
  }
  return null;
}

/** One clickable area: a link, the layer carrying it, and its quad in world space. */
export interface LinkArea {
  link: Link;
  carrier: string;
  /** The text run it belongs to; null for a layer's own link. */
  span: { start: number; end: number } | null;
  quad: Quad;
  /** Paint order: a layer's own links (outermost first), then text runs over them. */
  order: number;
}

/**
 * EVERY link area in a pass — what the PDF annotates, what an SVG wraps in
 * `<a>`, and where the stage pins its link markers. One list, so a link the
 * export carries is exactly a link the canvas shows.
 */
export function linkAreasIn(doc: MotionDocument, hits: readonly ClipHitRect[]): LinkArea[] {
  const out: LinkArea[] = [];
  for (const h of hits) {
    const clip = clipByIdIn(doc, h.clipId);
    if (!clip || !isVisualClip(clip)) continue;
    if (clip.link) out.push({ link: clip.link, carrier: clip.id, span: null, quad: quadOf(h), order: h.depth });
    if (clip.kind !== "text") continue;
    for (const r of h.linkRuns ?? []) {
      const span = textLinkAt(clip, r.start);
      if (span) out.push({ link: span.link, carrier: clip.id, span: { start: span.start, end: span.end }, quad: quadOf(h, r.u0, r.v0, r.u1, r.v1), order: 1000 + h.depth });
    }
  }
  return out.sort((a, b) => a.order - b.order);
}

/** A link's marker: where it is pinned (world), and the link it follows. */
export interface LinkMarker extends LinkUnderPoint {
  at: Pt;
}

/**
 * One marker per link, pinned where a reader looks for it: the end of a text
 * run's last line, or a linked layer's top-right corner. `at` is that corner
 * of the last area; the stage decides the offset.
 */
export function linkMarkers(areas: readonly LinkArea[]): LinkMarker[] {
  const byLink = new Map<string, LinkArea[]>();
  for (const a of areas) {
    const key = `${a.carrier}|${a.span?.start ?? "layer"}`;
    const list = byLink.get(key);
    if (list) list.push(a);
    else byLink.set(key, [a]);
  }
  return [...byLink.values()].map((list) => {
    const last = list[list.length - 1]!;
    return { link: last.link, clipId: last.carrier, span: last.span, areas: list.map((a) => a.quad), at: last.quad[1] };
  });
}
