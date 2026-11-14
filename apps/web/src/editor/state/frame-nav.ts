"use client";

import { componentFrames, framesOnPage, isComponentsView, isInternalPage, pageOfFrame, type MotionDocument } from "@solomotion/core";
import { useSession, useStageView } from "./session";
import { revealAsNavigation } from "./selection-reveal";
import { revealStageBounds } from "../stage/stage-focus";

type StageCamera = { scale: number; tx: number; ty: number };

/**
 * Open a frame's DEFINITION — "show me the thing itself", as opposed to
 * entering one of its instances in place.
 *
 * This is the panel/library gesture ("go to main component"), not the canvas
 * one. Entering an instance is `session.enterClip`, which keeps the camera
 * where it is; this deliberately does the opposite, because you asked to look
 * at the definition rather than to edit it where it happens to be used.
 *
 * A component master normally lives on the internal shelf now, so there is no
 * page to switch to and nothing to fly the camera at — in that case we open its
 * timeline (the virtual Components view is where it's browsable) and leave the
 * canvas alone. Returns false if the frame is gone.
 */
export function goToFrameDefinition(doc: MotionDocument, frameId: string): boolean {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame) return false;
  const session = useSession.getState();
  const pageId = pageOfFrame(doc, frame);
  session.openTimeline(frameId);
  if (isInternalPage(pageId)) return true;
  switchPage(doc, pageId, { frameId: frame.id });
  session.selectFrame(frame.id);
  revealAsNavigation();
  return true;
}

/**
 * WHERE YOU WERE ON EACH PAGE — the comp you were in and the camera you were
 * looking through. Session-only, like Figma's: going back to a page returns
 * you to the same view, not a re-framed one.
 */
const lastFrameOnPage = new Map<string, string>();
const lastCameraOnPage = new Map<string, StageCamera>();

/**
 * SWITCH PAGES — the one way the active page changes. Every surface that
 * shows another page (the pages list, a page row held under a drag, a link, a
 * selection on another page, a comp tab, the stage following its active comp)
 * comes through here, so the page you leave is always remembered and the page
 * you arrive at always gets its view back.
 *
 * `frameId` names the comp the caller is going to (a link, a tab): that comp
 * is what the page remembers, and it is panned into view if the page's own
 * camera does not show it. Selecting it is the caller's business.
 */
export function switchPage(doc: MotionDocument, pageId: string, opts: { frameId?: string } = {}): void {
  const session = useSession.getState();
  const currentId = session.activePageId ?? doc.pages[0]!.id;
  if (pageId === currentId) return;
  const active = session.activeFrameId ? doc.frames.find((f) => f.id === session.activeFrameId) : undefined;
  if (active && pageOfFrame(doc, active) === currentId) lastFrameOnPage.set(currentId, active.id);
  const view = useStageView.getState();
  lastCameraOnPage.set(currentId, { scale: view.scale, tx: view.tx, ty: view.ty });
  session.setActivePage(pageId);
  if (opts.frameId) lastFrameOnPage.set(pageId, opts.frameId);
  const camera = lastCameraOnPage.get(pageId);
  if (!camera) return;
  view.set(camera);
  const target = opts.frameId ? doc.frames.find((f) => f.id === opts.frameId) : undefined;
  if (target) revealStageBounds({ minX: target.x, minY: target.y, maxX: target.x + target.width, maxY: target.y + target.height });
}

/**
 * GO TO A PAGE — the pages list, a link to a page, anything that names a page
 * and nothing in it.
 *
 * A page remembers where you were on it (Figma's rule); a first visit lands on
 * its first flat comp, never a world, whose viewport would take over. The comp
 * you land on becomes the one you are working in — the comp of the page you
 * left stops being live the moment you leave. Its camera comes back as you left
 * it; a first visit FRAMES the comp, since the canvas would otherwise be left
 * at whatever coordinates the last page happened to use.
 */
export function goToPage(doc: MotionDocument, pageId: string): void {
  const firstVisit = !lastCameraOnPage.has(pageId);
  switchPage(doc, pageId);
  const frames = isComponentsView(pageId) ? componentFrames(doc) : framesOnPage(doc, pageId);
  const target = frames.find((f) => f.id === lastFrameOnPage.get(pageId)) ?? frames.find((f) => !f.world);
  if (!target) return;
  useSession.getState().selectFrame(target.id);
  if (firstVisit) revealAsNavigation();
}
