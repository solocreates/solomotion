"use client";

import { standaloneLinkHref, type MotionDocument } from "@solomotion/core";
import { drawFrameContent, type ClipHitRect } from "../stage/render/draw-frame";
import { linkAreasIn } from "../stage/link-hit";
import { ENGINE } from "@/editor/names";

/**
 * LINKS LEAVING THE APP — the measuring half every exporter shares. Where the
 * links are comes from the stage's own hit-rect pass, drawn into a 2×2
 * scratch: the same geometry the canvas clicks through (ADR-links).
 */

let scratch: CanvasRenderingContext2D | null = null;

/** A frame's hit rects at one instant, in FRAME px. */
export function frameHitRects(doc: MotionDocument, frameId: string, timeMs: number): ClipHitRect[] {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame) return [];
  if (!scratch) {
    const c = document.createElement("canvas");
    c.width = c.height = 2;
    scratch = c.getContext("2d");
  }
  if (!scratch) return [];
  const hits: ClipHitRect[] = [];
  scratch.save();
  drawFrameContent(scratch, doc, frame, timeMs, { hitRects: hits, transparent: true });
  scratch.restore();
  return hits;
}

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * An SVG's links: one `<a>` per area, an invisible polygon that follows the
 * area exactly (rotation and skew included — SVG, unlike a PDF `/Rect`, can).
 * In-app targets become their web deep links. `keep` limits it to the layers
 * being exported. Coordinates are frame px, which is the serializer's viewBox.
 */
export function svgLinkAnchors(doc: MotionDocument, frameId: string, timeMs: number, projectId: string | null, keep?: (clipId: string) => boolean): string {
  let out = "";
  for (const a of linkAreasIn(doc, frameHitRects(doc, frameId, timeMs))) {
    if (keep && !keep(a.carrier)) continue;
    const href = standaloneLinkHref(doc, a.link, projectId, ENGINE.webOrigin);
    if (!href) continue;
    const points = a.quad.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
    out += `<a href="${attr(href)}" target="_blank" rel="noopener"><polygon points="${points}" fill="#000" fill-opacity="0"/></a>`;
  }
  return out;
}
