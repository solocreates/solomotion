"use client";

import {
  clipBox,
  groupChainMatrix,
  groupDeltaMatrix,
  isLayoutMember,
  layoutMembersOf,
  locateClip,
  memberFootprint,
  multiply,
  resolveFrameContext,
  type MotionDocument,
  type GroupClip,
  type LayoutSpec,
  type Vec2,
} from "@solomotion/core";
import { clipLocalClamped } from "../inspector/animatable";
import { useSession } from "../state/session";
import { editSpaceOf, type EditSpace } from "./edit-space";
import { stageDoc } from "./text-path-chrome";

/**
 * AUTO LAYOUT — the stage's chrome, headless: where a container's box and
 * slots are, where the gap and padding handles sit, and which slot a dragged
 * member is being carried to. Read from the RESOLVED document, so the slots
 * are where the members were actually painted this instant.
 *
 * Everything is in the container's INTERIOR space — comp coordinates with the
 * group's own delta applied, the space its members are painted in — mapped
 * to the screen through one `EditSpace`.
 */

export interface LayoutSlotView {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutGeometry {
  group: GroupClip;
  spec: LayoutSpec;
  space: EditSpace;
  /** The container box, interior space, top-left + size. */
  box: { x: number; y: number; width: number; height: number };
  /** Members in layout order, with their footprints as painted. */
  slots: LayoutSlotView[];
}

/** The interior space of a group: the comp's chain, then the group's own delta. */
function interiorSpace(doc: MotionDocument, group: GroupClip): EditSpace | null {
  const session = useSession.getState();
  if (!session.nav.path.rootFrameId) return null;
  const ctx = resolveFrameContext(doc, session.nav.path, session.playheadMs, group.frameId);
  if (!ctx) return null;
  const at = (c: { startMs: number; durationMs: number }) => clipLocalClamped(c as GroupClip, session.playheadMs);
  const chain = groupChainMatrix(doc, group.id, at);
  const delta = groupDeltaMatrix(doc, group, at(group));
  return editSpaceOf(ctx, delta ? multiply(chain, delta) : chain);
}

export function layoutGeometry(groupId: string, doc: MotionDocument | null = stageDoc()): LayoutGeometry | null {
  if (!doc) return null;
  const group = locateClip(doc, groupId)?.clip;
  if (!group || group.kind !== "group" || !group.layout) return null;
  const space = interiorSpace(doc, group);
  if (!space) return null;
  const b = clipBox(doc, group);
  const slots: LayoutSlotView[] = [];
  for (const m of layoutMembersOf(doc, group)) {
    if (m.layoutItem.absolute || (m.kind === "text" && m.path)) continue;
    const mb = clipBox(doc, m);
    const fp = memberFootprint(m, mb);
    slots.push({ id: m.id, x: m.transform.x + fp.minX, y: m.transform.y + fp.minY, width: fp.width, height: fp.height });
  }
  return {
    group,
    spec: group.layout,
    space,
    box: { x: b.cx - b.width / 2, y: b.cy - b.height / 2, width: b.width, height: b.height },
    slots,
  };
}

/** A rectangle in the container's interior space. */
export interface InteriorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One gap or padding handle. Drawn as a short LINE across the band it sizes
 * (Figma's), and grabbed anywhere in that band — the whole gap is the target,
 * so the handle never has to be found at a single point another handle might
 * be sitting on.
 */
export interface LayoutHandle {
  /** Stable across a drag (the line moves as its value changes): `gap:2`, `padding:left`. */
  key: string;
  kind: "gap" | "lineGap" | "padding";
  side?: "top" | "right" | "bottom" | "left";
  /** Interior-space centre of the line. */
  at: Vec2;
  /** The band this handle sizes — lit on hover, and a grab target itself. */
  band: InteriorRect;
  /** Which way a drag reads: the axis the value grows along, and its sign. */
  axis: "x" | "y";
  sign: 1 | -1;
  /** The line runs vertically (it sizes a horizontal distance). */
  vertical: boolean;
}

/** Where the gap and padding handles sit for this container right now. */
export function layoutHandles(geo: LayoutGeometry): LayoutHandle[] {
  const { spec, box, slots } = geo;
  const out: LayoutHandle[] = [];
  const row = spec.flow !== "column";
  // Gaps: between neighbours on the FIRST line (wrap/grid: the first row).
  const firstLine = slots.filter((s, i) => {
    if (spec.flow === "row" || spec.flow === "column") return true;
    if (spec.flow === "grid") return i < Math.max(1, spec.columns);
    return Math.abs(s.y - slots[0]!.y) < 1e-3;
  });
  for (let i = 1; i < firstLine.length; i++) {
    const a = firstLine[i - 1]!;
    const b = firstLine[i]!;
    if (row) {
      const x0 = a.x + a.width;
      const y0 = Math.min(a.y, b.y);
      const y1 = Math.max(a.y + a.height, b.y + b.height);
      const band = { x: x0, y: y0, width: Math.max(0, b.x - x0), height: y1 - y0 };
      out.push({ key: `gap:${i}`, kind: "gap", at: { x: x0 + band.width / 2, y: y0 + band.height / 2 }, band, axis: "x", sign: 1, vertical: true });
    } else {
      const y0 = a.y + a.height;
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x + a.width, b.x + b.width);
      const band = { x: x0, y: y0, width: x1 - x0, height: Math.max(0, b.y - y0) };
      out.push({ key: `gap:${i}`, kind: "gap", at: { x: x0 + band.width / 2, y: y0 + band.height / 2 }, band, axis: "y", sign: 1, vertical: false });
    }
  }
  // Line gap: between the first two lines of a wrap / grid, across the box.
  if ((spec.flow === "wrap" || spec.flow === "grid") && slots.length > firstLine.length) {
    const y0 = Math.max(...firstLine.map((s) => s.y + s.height));
    const next = slots[firstLine.length]!;
    const x0 = box.x + spec.padding.left;
    const band = { x: x0, y: y0, width: box.width - spec.padding.left - spec.padding.right, height: Math.max(0, next.y - y0) };
    out.push({ key: "lineGap", kind: "lineGap", at: { x: x0 + band.width / 2, y: y0 + band.height / 2 }, band, axis: "y", sign: 1, vertical: false });
  }
  // Padding: the band along each side. A zero padding keeps its line a few
  // screen px inside the edge, where the box's own resize handle is not.
  const p = spec.padding;
  const inset = 10 * geo.space.pxToLocal;
  const midX = box.x + box.width / 2;
  const midY = box.y + box.height / 2;
  out.push(
    { key: "padding:left", kind: "padding", side: "left", at: { x: box.x + Math.max(inset, p.left / 2), y: midY }, band: { x: box.x, y: box.y, width: p.left, height: box.height }, axis: "x", sign: 1, vertical: true },
    { key: "padding:right", kind: "padding", side: "right", at: { x: box.x + box.width - Math.max(inset, p.right / 2), y: midY }, band: { x: box.x + box.width - p.right, y: box.y, width: p.right, height: box.height }, axis: "x", sign: -1, vertical: true },
    { key: "padding:top", kind: "padding", side: "top", at: { x: midX, y: box.y + Math.max(inset, p.top / 2) }, band: { x: box.x, y: box.y, width: box.width, height: p.top }, axis: "y", sign: 1, vertical: false },
    { key: "padding:bottom", kind: "padding", side: "bottom", at: { x: midX, y: box.y + box.height - Math.max(inset, p.bottom / 2) }, band: { x: box.x, y: box.y + box.height - p.bottom, width: box.width, height: p.bottom }, axis: "y", sign: -1, vertical: false },
  );
  return out;
}

/** The value a handle edits, for its label. */
export function layoutHandleValue(spec: LayoutSpec, h: LayoutHandle): number {
  return h.kind === "gap" ? spec.gap : h.kind === "lineGap" ? spec.lineGap : spec.padding[h.side!];
}

/** Grab reach around a handle's line, screen px — a finger's, on a coarse pointer. */
export function layoutHandleReachPx(): number {
  return typeof document !== "undefined" && document.documentElement.dataset.pointer === "coarse" ? 16 : 9;
}

/**
 * The handle under a screen point: first the line itself (with a finger-sized
 * reach), then any GAP band the point is inside — a gap is grabbable anywhere
 * across it. Padding bands are not, below the line: their inside is where the
 * members are dragged from.
 */
export function layoutHandleAt(geo: LayoutGeometry, screen: Vec2): LayoutHandle | null {
  const handles = layoutHandles(geo);
  const reach = layoutHandleReachPx();
  for (const h of handles) {
    const s = geo.space.toScreen(h.at);
    if (Math.hypot(screen.x - s.x, screen.y - s.y) <= reach) return h;
  }
  const p = geo.space.fromScreen(screen);
  for (const h of handles) {
    if (h.kind === "padding") continue;
    const b = h.band;
    if (p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height) return h;
  }
  return null;
}

/** The container a clip is arranged by, resolved — or null. */
export function containerOf(clipId: string, doc: MotionDocument | null = stageDoc()): GroupClip | null {
  return doc ? isLayoutMember(doc, clipId) : null;
}
