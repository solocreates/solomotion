import { createId } from "./ids";
import type { Frame, Page, MotionDocument } from "./schema";

/**
 * Page helpers — pages are Figma-style workspaces; the canvas shows one at a
 * time. A frame's `pageId: null` means the document's FIRST page, so legacy
 * documents and bare `createFrame` calls land on page 1 without ceremony.
 */

/** Legacy name of the page precomposed source comps used to be parked on. */
export const NESTED_PAGE_NAME = "Nested";

/**
 * The INTERNAL shelf: where a comp that exists only as somebody's INSIDE is
 * stored. It is a sentinel page id with no `Page` record behind it, so:
 *
 *   • the pages panel cannot list it (it iterates `doc.pages`);
 *   • `framesOnPage` never returns its frames for any real page;
 *   • the canvas never paints them as free-standing artboards.
 *
 * The point is that a nested comp / component master is NOT a separate document
 * object the user has to file somewhere. You made it inside something; it lives
 * inside that thing; you reach it by entering, never by hunting for it on a
 * "Nested" page next to forty auto-named siblings. Storage is an implementation
 * detail, and this constant is where that detail is confined.
 */
export const INTERNAL_PAGE_ID = "__internal__";

/** Is this frame on the internal shelf (reachable only by entering something)? */
export function isInternalPage(pageId: string | null | undefined): boolean {
  return pageId === INTERNAL_PAGE_ID;
}

/** Display label for the virtual Components view. */
export const COMPONENTS_PAGE_NAME = "Components";

/**
 * The VIRTUAL "Components" view id — an aggregating page that lists every
 * component frame WHEREVER it actually lives, without moving or duplicating it.
 * It is NOT a real `Page` in `doc.pages`: the pages panel synthesizes the row
 * and the canvas resolves it to `componentFrames(doc)`. So a frame you promote
 * stays put (edit it in place, on its own page) yet also shows up here — one
 * frame, two views, zero storage duplication.
 */
export const COMPONENTS_VIEW_ID = "__components_view__";

/** Whether a page id points at the virtual Components view (vs. a real page). */
export function isComponentsView(pageId: string | null | undefined): boolean {
  return pageId === COMPONENTS_VIEW_ID;
}

export function createPage(name: string): Page {
  return { id: createId("page"), name, guides: [] };
}

/**
 * The page a frame belongs to. Internal frames keep their sentinel id (they
 * belong to no page); everything else falls back to page 1 so legacy documents
 * and bare `createFrame` calls need no migration.
 */
export function pageOfFrame(doc: MotionDocument, frame: Frame): string {
  if (isInternalPage(frame.pageId)) return INTERNAL_PAGE_ID;
  return frame.pageId ?? doc.pages[0]!.id;
}

export function framesOnPage(doc: MotionDocument, pageId: string): Frame[] {
  return doc.frames.filter((f) => pageOfFrame(doc, f) === pageId);
}

/**
 * WHERE A DOCUMENT OPENS: the top-left comp of its first page — what the canvas
 * shows on open, so the timeline is of the comp in front of you. Every open
 * (a project, a template, an import, a URL) used to take `frames[0]`, which is
 * only the comp made first: the Playground's cover is built LAST (its wall
 * nests the others), so it opened on Swiss Grid's timeline beside the cover.
 * Null for a document with no comps; `frames[0]` when page 1 is empty.
 */
export function landingFrameId(doc: MotionDocument): string | null {
  for (const page of doc.pages) {
    const on = framesOnPage(doc, page.id);
    if (on.length === 0) continue;
    let best = on[0]!;
    for (const f of on) if (f.y < best.y || (f.y === best.y && f.x < best.x)) best = f;
    return best.id;
  }
  return doc.frames[0]?.id ?? null;
}

/** The gap between artboards laid side by side on a page. */
const FRAME_GAP = 120;

/**
 * Where a frame joining a page lands: to the right of everything already on
 * it, so it never lands on top of another artboard. Null on an empty page —
 * there is nothing to clear, and the frame can keep its own position.
 */
export function slotBesidePage(doc: MotionDocument, pageId: string, except?: string): number | null {
  const others = framesOnPage(doc, pageId).filter((f) => f.id !== except);
  if (others.length === 0) return null;
  return Math.max(...others.map((f) => f.x + f.width)) + FRAME_GAP;
}

/**
 * Move a frame onto another page, beside the artboards already there. False
 * when the page does not exist, or when the frame lives on the internal shelf
 * (a nested comp's inside is reached by entering its layer, never filed on a
 * page). Mutates — call inside a document update.
 */
export function moveFrameToPage(doc: MotionDocument, frameId: string, pageId: string): boolean {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame || isInternalPage(frame.pageId) || !doc.pages.some((p) => p.id === pageId)) return false;
  if (pageOfFrame(doc, frame) === pageId) return true;
  const x = slotBesidePage(doc, pageId, frame.id);
  if (x !== null) frame.x = x;
  frame.pageId = pageId;
  return true;
}

/**
 * Where a newly created source comp goes: the internal shelf. Kept as a
 * function (not a bare constant at every call site) so the storage policy stays
 * ONE decision — e.g. a future "keep sources beside their parent's page" option
 * changes this body and nothing else.
 */
export function internalPageId(_doc?: MotionDocument): string {
  return INTERNAL_PAGE_ID;
}

/**
 * Sweep a legacy document onto the internal shelf: every frame parked on the
 * old auto-managed "Nested" page moves off-page, and the page itself is
 * removed once empty. Idempotent. Mutates — call inside an update / on load.
 */
export function adoptInternalFrames(doc: MotionDocument): void {
  const legacy = doc.pages.filter((p) => p.name === NESTED_PAGE_NAME).map((p) => p.id);
  if (legacy.length === 0) return;
  for (const frame of doc.frames) {
    if (frame.pageId && legacy.includes(frame.pageId)) frame.pageId = INTERNAL_PAGE_ID;
  }
  doc.pages = doc.pages.filter((p) => !legacy.includes(p.id));
  if (doc.pages.length === 0) doc.pages.push(createPage("Page 1"));
}

