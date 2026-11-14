"use client";

import { identity } from "@/editor/identity";
import {
  docLinks,
  frameTarget,
  PDF_POINTS_PER_PX,
  pdfLinkAction,
  pdfOutline,
  targetCapabilities,
  type MotionDocument,
  type ExportPage,
  type PdfOutlineItem,
} from "@solomotion/core";
import type { ClipHitRect } from "../stage/render/draw-frame";
import { hitAABB } from "../stage/stage-geometry";
import { linkAreasIn } from "../stage/link-hit";
import { frameHitRects } from "./export-links";
import { renderStill } from "./export-media";
import { buildSvg } from "./export-vector";
import { safeFileName, saveExport, type SaveSink } from "./save";
import { ENGINE } from "@/editor/names";

/**
 * PDF — one page per planned instant (see core `planExportPages`), each page
 * the frame's own size (1px = 1pt, so a 595×842 frame is an A4 page).
 *
 * Reliability is the design constraint, so every page takes the path that
 * cannot misdraw it:
 *
 *  - VECTOR, when asked and when the page is made only of what the SVG
 *    serializer states exactly — shapes, paths, text as outlines. Sharp at any
 *    zoom, tiny, and printed as geometry.
 *  - IMAGE otherwise: the page is rendered by the same `renderStill` the PNG
 *    export and the agent's eyes use, so effects, blends, video, paint, glass —
 *    anything the canvas can draw — lands exactly as on screen. A PDF reader
 *    never has to understand a blur it has no primitive for.
 *
 * The choice is per PAGE, not per document: a deck with one photo slide keeps
 * every other slide vector. jsPDF and svg2pdf load only when a PDF is made.
 *
 * LINKS AND BOOKMARKS ride on top of either kind of page (ADR-links): every
 * link becomes a real annotation — a URI, or a GoTo another page of this PDF —
 * measured by the renderer's own hit-rect pass, the geometry the stage clicks
 * through; every exported frame becomes a bookmark. What each link BECOMES is
 * core's (`pdfLinkAction`); this file only measures and writes.
 */

export type PdfRender = "vector" | "image";
export type PdfImageFormat = "jpeg" | "png";

export interface PdfExportOptions {
  render: PdfRender;
  /** Raster scale for image pages (1 = one pixel per point). */
  scale: number;
  imageFormat: PdfImageFormat;
  fileName: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Where the file goes — default the browser's downloads (see ./save). */
  save?: SaveSink;
}

export interface PdfExportResult {
  vectorPages: number;
  imagePages: number;
  /** Link annotations written. */
  links: number;
}

export interface PdfExportContext {
  /** The open project's id — a link to a place NOT in this PDF falls back to its web deep link. */
  projectId: string | null;
}

export async function exportPdf(
  doc: MotionDocument,
  pages: readonly ExportPage[],
  options: PdfExportOptions,
  context: PdfExportContext = { projectId: null },
): Promise<PdfExportResult> {
  if (pages.length === 0) throw new Error("Nothing to export — no pages.");
  const { jsPDF } = await import("jspdf");
  const svg2pdf = options.render === "vector" ? (await import("svg2pdf.js")).svg2pdf : null;

  let pdf: InstanceType<typeof jsPDF> | null = null;
  let vectorPages = 0;
  let imagePages = 0;
  const vectorSafe = new Map<string, boolean>();
  // Only a document with links pays for the geometry pass.
  const measureLinks = docLinks(doc).length > 0;
  const pageHits: ClipHitRect[][] = [];

  for (let i = 0; i < pages.length; i++) {
    if (options.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
    const page = pages[i]!;
    const frame = doc.frames.find((f) => f.id === page.frameId);
    if (!frame) continue;
    const w = frame.width * PDF_POINTS_PER_PX;
    const h = frame.height * PDF_POINTS_PER_PX;
    const orientation = w > h ? "landscape" : "portrait";
    if (!pdf) pdf = new jsPDF({ unit: "pt", format: [w, h], orientation, compress: true });
    else pdf.addPage([w, h], orientation);

    const target = frameTarget(doc, frame.id);
    let safe = vectorSafe.get(frame.id);
    if (safe === undefined) {
      safe = targetCapabilities(doc, target).svg !== "mixed";
      vectorSafe.set(frame.id, safe);
    }

    if (svg2pdf && safe) {
      const { svg } = await buildSvg(doc, target, page.timeMs, { includeBackground: true });
      await drawSvgPage(svg2pdf, pdf, svg, w, h);
      vectorPages++;
    } else {
      // The frame paints its own background; a see-through one stays see-through.
      const canvas = await renderStill(doc, frame, page.timeMs, { scale: options.scale });
      const bytes = await pageImageBytes(canvas, options.imageFormat);
      pdf.addImage(bytes, options.imageFormat === "png" ? "PNG" : "JPEG", 0, 0, w, h, undefined, "FAST");
      imagePages++;
    }
    pageHits[i] = measureLinks ? frameHitRects(doc, page.frameId, page.timeMs) : [];
    options.onProgress?.((i + 1) / pages.length);
    // Yield between pages so a long document keeps the UI (and Cancel) alive.
    await new Promise((r) => setTimeout(r, 0));
  }

  if (!pdf) throw new Error("Nothing to export — no pages.");
  const links = measureLinks ? writeLinks(pdf, doc, pages, pageHits, context) : 0;
  writeOutline(pdf, pdfOutline(doc, pages));
  pdf.setProperties({ title: options.fileName, creator: identity.name });
  (options.save ?? saveExport)(pdf.output("blob"), `${safeFileName(options.fileName)}.pdf`);
  return { vectorPages, imagePages, links };
}

// ── Links ───────────────────────────────────────────────────────────────────

/** An axis-aligned PDF rect (top-left origin, pt) around a quad of frame px. */
function pdfRect(pts: Array<{ x: number; y: number }>): { x: number; y: number; w: number; h: number } {
  const xs = pts.map((p) => p.x * PDF_POINTS_PER_PX);
  const ys = pts.map((p) => p.y * PDF_POINTS_PER_PX);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function writeLinks(
  pdf: import("jspdf").jsPDF,
  doc: MotionDocument,
  pages: readonly ExportPage[],
  pageHits: readonly ClipHitRect[][],
  context: PdfExportContext,
): number {
  // Where a layer starts, for a GoTo that scrolls to it: its first page's box.
  const tops = new Map<string, number>();
  for (const hits of pageHits) for (const h of hits) if (!tops.has(h.clipId)) tops.set(h.clipId, hitAABB(h).minY);
  const ctx = { pages, projectId: context.projectId, webOrigin: ENGINE.webOrigin, layerTop: (id: string) => tops.get(id) ?? null, pointsPerPx: PDF_POINTS_PER_PX };
  let count = 0;
  pageHits.forEach((hits, i) => {
    const links = linkAreasIn(doc, hits);
    if (links.length === 0) return;
    pdf.setPage(i + 1);
    for (const { link, quad } of links) {
      const rect = pdfRect(quad);
      if (rect.w < 1 || rect.h < 1) continue;
      const action = pdfLinkAction(doc, link, ctx);
      if (!action) continue;
      if (action.kind === "uri") pdf.link(rect.x, rect.y, rect.w, rect.h, { url: action.uri });
      else if (action.top <= 0) pdf.link(rect.x, rect.y, rect.w, rect.h, { pageNumber: action.page, magFactor: "Fit" });
      else {
        // jsPDF flips `top` with the height of the page the LINK is on, not the
        // page it goes to; pre-flip so the destination lands on the layer.
        const here = pdf.internal.pageSize.getHeight();
        const there = pageHeightPt(doc, pages[action.page - 1]);
        pdf.link(rect.x, rect.y, rect.w, rect.h, { pageNumber: action.page, magFactor: "XYZ", top: here - (there - action.top) });
      }
      count++;
    }
  });
  return count;
}

function pageHeightPt(doc: MotionDocument, page: ExportPage | undefined): number {
  const frame = page ? doc.frames.find((f) => f.id === page.frameId) : undefined;
  return (frame?.height ?? 0) * PDF_POINTS_PER_PX;
}

/** The bookmarks — jsPDF's outline tree, from core's. */
function writeOutline(pdf: import("jspdf").jsPDF, items: readonly PdfOutlineItem[]): void {
  if (items.length < 2 && !items.some((i) => i.children.length)) return;
  const add = (parent: import("jspdf").OutlineItem | null, item: PdfOutlineItem) => {
    const node = pdf.outline.add(parent, item.title, { pageNumber: item.page });
    for (const c of item.children) add(node, c);
  };
  for (const item of items) add(null, item);
}

type Svg2Pdf = (element: Element, pdf: import("jspdf").jsPDF, options: { x: number; y: number; width: number; height: number }) => Promise<unknown>;

/**
 * svg2pdf reads computed styles, so the SVG is mounted — off screen, never
 * painted — for the length of the conversion and removed after, whatever
 * happens.
 */
async function drawSvgPage(svg2pdf: Svg2Pdf, pdf: import("jspdf").jsPDF, svg: string, w: number, h: number): Promise<void> {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;width:0;height:0;overflow:hidden;pointer-events:none";
  host.innerHTML = svg;
  document.body.appendChild(host);
  try {
    const el = host.querySelector("svg");
    if (!el) throw new Error("The page's SVG did not parse.");
    await svg2pdf(el, pdf, { x: 0, y: 0, width: w, height: h });
  } finally {
    host.remove();
  }
}

/**
 * The page picture as bytes. JPEG has no alpha, so a frame with a see-through
 * background is laid on white first — the paper it will be printed on — rather
 * than on the black an encoder would invent.
 */
async function pageImageBytes(canvas: HTMLCanvasElement, format: PdfImageFormat): Promise<Uint8Array> {
  let source = canvas;
  if (format === "jpeg") {
    const flat = document.createElement("canvas");
    flat.width = canvas.width;
    flat.height = canvas.height;
    const g = flat.getContext("2d");
    if (g) {
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, flat.width, flat.height);
      g.drawImage(canvas, 0, 0);
      source = flat;
    }
  }
  const blob = await new Promise<Blob | null>((r) =>
    source.toBlob(r, format === "png" ? "image/png" : "image/jpeg", 0.92),
  );
  if (!blob) throw new Error("Page image encode failed");
  return new Uint8Array(await blob.arrayBuffer());
}
