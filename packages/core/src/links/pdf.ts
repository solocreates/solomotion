import type { MotionDocument, Link } from "../schema";
import type { ExportPage } from "../export/pages";
import { INTERNAL_PAGE_ID, pageOfFrame } from "../pages";
import { parseRoute, webUrlOf } from "./address";
import { projectRouteFor, resolveLink } from "./resolve";

/**
 * LINKS IN A PDF — the headless half: what each link BECOMES in a document
 * that has no app around it, and the outline (bookmarks) of the export.
 *
 *   external         → a URI action
 *   a frame / page   → GoTo the first PDF page that shows it
 *   a layer          → GoTo its frame's page, scrolled to the layer's top
 *   not in this PDF  → a URI to the web deep link (the reader can still get
 *                      there; a dead rectangle helps nobody)
 *   another project,
 *   a plugin         → a URI to its web URL
 *   broken / blocked → nothing
 *
 * The exporter (app side) only measures WHERE each link is on the page — the
 * same hit rects the stage clicks through — and writes these actions.
 */

export type PdfLinkAction =
  | { kind: "uri"; uri: string }
  /** `page` is 1-based; `top` is points down from the page's top edge. */
  | { kind: "goto"; page: number; top: number };

export interface PdfLinkContext {
  pages: readonly ExportPage[];
  /** The project's id, for web fallbacks. Null = no fallback (nothing to link to). */
  projectId: string | null;
  /** The app's web origin, where an in-app link points from outside it. */
  webOrigin: string;
  /** A layer's top edge in its frame, px — the GoTo scroll. Absent = the page top. */
  layerTop?: (clipId: string) => number | null;
  /** Points per frame px (`PDF_POINTS_PER_PX`). */
  pointsPerPx?: number;
}

/** The first PDF page (1-based) each exported frame landed on. */
export function firstPdfPages(pages: readonly ExportPage[]): Map<string, number> {
  const first = new Map<string, number>();
  pages.forEach((p, i) => {
    if (!first.has(p.frameId)) first.set(p.frameId, i + 1);
  });
  return first;
}

export function pdfLinkAction(doc: MotionDocument, link: Link, ctx: PdfLinkContext): PdfLinkAction | null {
  const r = resolveLink(doc, link);
  const first = firstPdfPages(ctx.pages);
  const web = (): PdfLinkAction | null =>
    ctx.projectId && r.kind === "node" ? { kind: "uri", uri: webUrlOf(projectRouteFor(doc, ctx.projectId, [r.node.key], r.t), ctx.webOrigin) } : null;
  switch (r.kind) {
    case "external":
      return { kind: "uri", uri: r.href };
    case "route":
      return { kind: "uri", uri: webUrlOf(parseRoute(link.target.kind === "route" ? link.target.path : "/"), ctx.webOrigin) };
    case "broken":
    case "blocked":
      return null;
    case "node": {
      const node = r.node;
      if (node.kind === "page") {
        const i = ctx.pages.findIndex((p) => {
          const f = doc.frames.find((fr) => fr.id === p.frameId);
          return f && pageOfFrame(doc, f) === node.id;
        });
        return i >= 0 ? { kind: "goto", page: i + 1, top: 0 } : web();
      }
      const page = node.frameId ? first.get(node.frameId) : undefined;
      if (page === undefined) return web();
      const top = node.kind === "layer" ? Math.max(0, (ctx.layerTop?.(node.id) ?? 0) * (ctx.pointsPerPx ?? 1)) : 0;
      return { kind: "goto", page, top };
    }
  }
}

/**
 * What a link becomes in a file that holds none of the project's pages (an
 * SVG, a single image's sidecar): always an address — external as itself,
 * everything in-app as its web deep link. Null for broken / blocked links,
 * or a place with no project to point into.
 */
export function standaloneLinkHref(doc: MotionDocument, link: Link, projectId: string | null, webOrigin: string): string | null {
  const action = pdfLinkAction(doc, link, { pages: [], projectId, webOrigin });
  return action?.kind === "uri" ? action.uri : null;
}

export interface PdfOutlineItem {
  title: string;
  /** 1-based PDF page. */
  page: number;
  children: PdfOutlineItem[];
}

/**
 * The export's bookmarks: every exported frame, in export order, under its
 * page when the PDF spans more than one. Frames ARE the anchors —
 * nothing has to be marked for a deck to get a table of contents.
 */
export function pdfOutline(doc: MotionDocument, pages: readonly ExportPage[]): PdfOutlineItem[] {
  const frames: Array<{ title: string; page: number; pageId: string }> = [];
  for (const [frameId, page] of firstPdfPages(pages)) {
    const f = doc.frames.find((fr) => fr.id === frameId);
    if (!f) continue;
    frames.push({ title: f.name || "Untitled", page, pageId: pageOfFrame(doc, f) });
  }
  const pageIds = [...new Set(frames.map((f) => f.pageId))];
  if (pageIds.length <= 1) return frames.map((f) => ({ title: f.title, page: f.page, children: [] }));
  return pageIds.map((pid) => {
    const kids = frames.filter((f) => f.pageId === pid);
    const name = pid === INTERNAL_PAGE_ID ? "Nested" : (doc.pages.find((p) => p.id === pid)?.name ?? "Page");
    return { title: name, page: kids[0]!.page, children: kids.map((f) => ({ title: f.title, page: f.page, children: [] })) };
  });
}
