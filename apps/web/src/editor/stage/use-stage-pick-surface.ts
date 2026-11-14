"use client";

import * as React from "react";
import { clipAncestorGroups, clipsUnderGroup, type MotionDocument } from "@solomotion/core";
import type { ClipHitRect } from "./render/draw-frame";
import { useStageView } from "../state/session";
import { registerPickSurface, type PickBox } from "../pick/pick-mode";

/**
 * THE STAGE AS A PICK SURFACE. A canvas cannot tag its layers in the DOM, so
 * it answers the pick mode's three questions itself — from the SAME hit stack
 * a click runs (`hitStackAt`, silhouettes and hollow shapes included) and the
 * same hit rects the selection box is drawn from, so the box the mode draws is
 * the layer's real on-screen bounds at any zoom, rotation or shear.
 *
 * A press on a part of a group asks the group too: when the filter wants a
 * character (or any group), pointing at its arm picks the character — the
 * nearest enclosing candidate wins, innermost first.
 */
export function useStagePickSurface(opts: {
  containerRef: React.RefObject<HTMLElement | null>;
  /** The stage's own hit test: container-local px → topmost-first stack. */
  hitStack: (local: { x: number; y: number }) => ClipHitRect[];
  hitRects: () => ClipHitRect[];
  doc: () => MotionDocument;
  pan: (dx: number, dy: number) => void;
}): void {
  // Latest-value: the stage rebuilds these closures every render; the surface
  // lives as long as the stage does.
  const latest = React.useRef(opts);
  latest.current = opts;

  React.useEffect(() => {
    const el = opts.containerRef.current;
    if (!el) return;
    const toClient = () => {
      const r = el.getBoundingClientRect();
      const v = useStageView.getState();
      return { ox: r.left + v.tx, oy: r.top + v.ty, s: v.scale };
    };
    const boxOfHit = (h: ClipHitRect): PickBox => {
      const { ox, oy, s } = toClient();
      return { cx: ox + h.cx * s, cy: oy + h.cy * s, w: Math.abs(h.width) * s, h: Math.abs(h.height) * s, rotation: h.rotation, skewX: h.skewX, skewY: h.skewY };
    };
    /** A group's box: the axis-aligned union of its painted members. */
    const boxOfGroup = (groupId: string, hits: ClipHitRect[]): PickBox | null => {
      const members = new Set(clipsUnderGroup(latest.current.doc(), groupId));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const h of hits) {
        if (!members.has(h.clipId)) continue;
        const r = (h.rotation * Math.PI) / 180;
        const ex = (Math.abs(h.width * Math.cos(r)) + Math.abs(h.height * Math.sin(r))) / 2;
        const ey = (Math.abs(h.width * Math.sin(r)) + Math.abs(h.height * Math.cos(r))) / 2;
        x0 = Math.min(x0, h.cx - ex);
        x1 = Math.max(x1, h.cx + ex);
        y0 = Math.min(y0, h.cy - ey);
        y1 = Math.max(y1, h.cy + ey);
      }
      if (!Number.isFinite(x0)) return null;
      const { ox, oy, s } = toClient();
      return { cx: ox + ((x0 + x1) / 2) * s, cy: oy + ((y0 + y1) / 2) * s, w: (x1 - x0) * s, h: (y1 - y0) * s, rotation: 0, skewX: 0, skewY: 0 };
    };
    /** The layer, then every group around it — the keys a press here could mean. */
    const chainOf = (clipId: string): string[] => [clipId, ...clipAncestorGroups(latest.current.doc(), clipId).map((g) => g.id)].map((id) => `clip:${id}`);
    const boxOf = (key: string, hits = latest.current.hitRects()): PickBox | null => {
      const id = key.startsWith("clip:") ? key.slice(5) : null;
      if (!id) return null;
      const own = hits.find((h) => h.clipId === id);
      return own ? boxOfHit(own) : boxOfGroup(id, hits);
    };

    let token: { hits: ClipHitRect[]; tx: number; ty: number; scale: number; left: number; top: number } | null = null;

    return registerPickSurface({
      area: "stage",
      element: el,
      hit: (x, y, accepts) => {
        const r = el.getBoundingClientRect();
        const stack = latest.current.hitStack({ x: x - r.left, y: y - r.top });
        for (const h of stack) {
          for (const key of chainOf(h.clipId)) if (accepts(key)) return { key, box: boxOf(key) ?? boxOfHit(h) };
        }
        return stack.length > 0 ? "blocked" : null;
      },
      boxes: (accepts) => {
        const hits = latest.current.hitRects();
        const out: Array<{ key: string; box: PickBox }> = [];
        const seen = new Set<string>();
        for (const h of hits) {
          for (const key of chainOf(h.clipId)) {
            if (seen.has(key)) continue;
            seen.add(key);
            if (!accepts(key)) continue;
            const box = boxOf(key, hits);
            if (box) out.push({ key, box });
          }
        }
        return out;
      },
      boxOf: (key) => boxOf(key),
      version: () => {
        const hits = latest.current.hitRects();
        const v = useStageView.getState();
        const r = el.getBoundingClientRect();
        if (token && token.hits === hits && token.tx === v.tx && token.ty === v.ty && token.scale === v.scale && token.left === r.left && token.top === r.top) return token;
        return (token = { hits, tx: v.tx, ty: v.ty, scale: v.scale, left: r.left, top: r.top });
      },
      pan: (dx, dy) => latest.current.pan(dx, dy),
    });
  }, [opts.containerRef]);
}
