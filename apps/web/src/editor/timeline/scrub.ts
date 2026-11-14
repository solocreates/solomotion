"use client";

import { snapTime, type DocumentStore } from "@solomotion/core";
import { useSession } from "../state/session";
import { claimPointer, multiFingerDown, subscribePointerEnd } from "../input/pointer-gestures";
import { activeCompId, collectSnapCandidates, pxToTime } from "./timeline-utils";
import { capturePointer } from "../input/capture-pointer";

/**
 * Begin a playhead scrub from a pointer-down on any element whose left edge
 * sits at content-x 0 (the timeline ruler, the graph panel's scrub band). The
 * element must span the full content width so `clientX - rect.left` maps
 * straight to a content-x, which stays correct as the shared view scrolls.
 *
 * ONE scrub for every surface — same clip-edge / keyframe snapping as clip
 * drags, same snap indicator — so the timeline ruler and the curve panel head
 * scrub identically. Callers wire `onPointerDown={(e) => beginScrub(e, …)}`
 * plus `SCRUB_SURFACE` on the element — the two go together.
 *
 * `anchorEl` overrides the content-origin element: a full-width scrub band uses
 * itself (default), but a draggable head grip (positioned AT the playhead)
 * passes the content container so the mapping stays anchored at content-x 0.
 */
export function beginPlayheadScrub(
  e: React.PointerEvent,
  store: DocumentStore,
  pxPerSec: number,
  anchorEl?: HTMLElement,
): void {
  const el = e.currentTarget as HTMLElement;
  const rect = (anchorEl ?? el).getBoundingClientRect();

  const session = useSession.getState();
  const settings = session.snapSettings;
  const d = store.getState();
  const candidates = collectSnapCandidates(
    d,
    activeCompId(d, session.activeFrameId),
    new Set(),
    session.playheadMs,
    { toClips: settings.toClips, toPlayhead: false, toKeyframes: settings.toKeyframes },
  );
  const threshold = pxToTime(settings.thresholdPx, pxPerSec);

  beginScrubDrag(
    e,
    (clientX) => {
      const raw = Math.max(0, pxToTime(clientX - rect.left, pxPerSec));
      const snapped = useSession.getState().snapping ? snapTime(raw, candidates, threshold) : raw;
      useSession.getState().setPlayhead(snapped);
      useSession.getState().setSnapIndicator(snapped !== raw ? snapped : null);
    },
    () => useSession.getState().setSnapIndicator(null),
  );
}

/**
 * THE SCRUB DRAG — the lifecycle half of a scrub, with no opinion about what
 * the pointer means.
 *
 * Split out because the flipbook sheet had written its own. Its time mapping is
 * genuinely different (frame-quantised, and drill-aware — aiming outside the
 * cell you are inside ascends back to the sheet), so it could not call
 * `beginPlayheadScrub`. But the LIFECYCLE around that mapping is identical, and
 * copying it copied its bug: no `pointercancel`, so the sheet's ruler leaked a
 * `pointermove` listener on every touch scrub exactly the way the timeline's
 * did, and the playhead wandered afterwards for the rest of the session.
 *
 * So the parameterised part is the one line that differs. `seek` says what a
 * clientX means; everything below is the same for every scrubbable surface and
 * exists once.
 */
/**
 * IS A TIME SCRUB IN PROGRESS — as a fact about the pointer, not a guess from
 * the clock.
 *
 * The stage inferred scrubbing from "the playhead moved recently", which is
 * right until someone drags slowly or holds still mid-drag: the window lapses,
 * the transport reads as parked, the preview snaps to full quality, the next
 * move drops it again, and the picture flickers between two resolutions under
 * your hand. A pointer that is DOWN on a scrub surface is not a thing you have
 * to infer, and this is the one seam every scrub — the ruler, the head grip,
 * the curve panel — already passes through.
 */
let scrubDepth = 0;

export function isScrubbingTime(): boolean {
  return scrubDepth > 0;
}

export function beginScrubDrag(
  e: React.PointerEvent,
  /**
   * What a pointer position MEANS on this surface. `clientY` is passed for the
   * few drags whose value axis is vertical — the retime band's speed handles
   * read a rate off it — and ignored by everything that scrubs time, which is
   * why it is a second argument rather than a second kit.
   */
  seek: (clientX: number, clientY: number) => void,
  onEnd?: () => void,
): void {
  const el = e.currentTarget as HTMLElement;
  /*
   * A SCRUB IS A ONE-FINGER GESTURE. If a second finger is already down this is
   * a pinch, and seeking the playhead to wherever the anchoring finger happens
   * to be resting is not something anyone asked for. The curve panel's scrub
   * band and the timeline ruler both sit inside surfaces you zoom constantly.
   */
  if (multiFingerDown()) return;
  // A scrub is stationary before it is a drag — see `usePointerDrag`. Claiming
  // on the press is what keeps a held playhead or a held trim edge from also
  // opening the long-press context menu, and what tells the browser this
  // gesture is not a scroll.
  claimPointer(e.pointerId, "hold");
  // A scrub seeks on the PRESS, so it owns the hold. Surfaces that host one
  // carry `SCRUB_SURFACE`, which declares `data-no-longpress`.
  
  // Capture can be refused when the pointer is already gone by the time React
  // delivers the event. Losing the capture is survivable — the window
  // listeners below still track the drag — but an uncaught NotFoundError here
  // aborts the handler, and the scrub silently never starts.
  capturePointer(el, e.pointerId);

  scrubDepth++;
  seek(e.clientX, e.clientY);

  const onMove = (ev: PointerEvent) => {
    // Only the pointer that started the scrub. A second finger landing on the
    // surface must not yank the playhead to wherever it is — and with the
    // two-finger navigation gesture, a second finger is a normal thing to do.
    if (ev.pointerId !== e.pointerId) return;
    seek(ev.clientX, ev.clientY);
  };

  let done = false;
  const stop = () => {
    // Both the arbiter's publication and the window listener below can reach
    // here on the same release; whichever is first is the only one that acts.
    if (done) return;
    done = true;
    scrubDepth = Math.max(0, scrubDepth - 1);
    onEnd?.();
    off();
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", stop);
  };

  /*
   * ONE SUBSCRIPTION INSTEAD OF THE TRIO — and it hears one thing the trio
   * cannot: `"superseded"`, published the moment a second finger lands. Without
   * it a pinch on the timeline or the curve panel kept dragging the playhead
   * with the still finger for the whole gesture.
   */
  const off = subscribePointerEnd((id) => {
    if (id === e.pointerId) stop();
  });

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", stop);
  /*
   * POINTERCANCEL IS NOT OPTIONAL, and leaving it out is why scrubbing was
   * broken on touch and pen.
   *
   * A mouse essentially never cancels, so for a long time `pointerup` alone
   * looked like a complete teardown. Touch cancels constantly — the moment the
   * browser decides a gesture belongs to it (a scroll, a page zoom, a system
   * edge swipe) it takes the pointer and fires `pointercancel` INSTEAD of
   * `pointerup`. The scrub then never tore down: its `pointermove` listener
   * stayed on the window for the rest of the session, so every later pointer
   * move anywhere in the app dragged the playhead. That is what "it randomly
   * starts playing" was — not playback at all, but the playhead being seeked
   * by a listener nobody could see, from a gesture that had ended minutes ago.
   *
   * The other half of the fix is `DRAG_SURFACE`, so the browser has no reason
   * to claim the gesture in the first place. Both are needed: the CSS prevents
   * the common cancel, this handles the ones it cannot (an incoming call, a
   * system gesture, the tab losing focus mid-drag).
   */
  window.addEventListener("pointercancel", stop);
  window.addEventListener("blur", stop);
}

/**
 * A scrub band is a drag surface like any other — same class, same reason. It
 * is re-exported here only so a caller wiring `beginPlayheadScrub` finds the
 * CSS it needs in the same import, because forgetting it is what made the
 * ruler pan the timeline instead of moving the playhead.
 */
export { DRAG_SURFACE as SCRUB_SURFACE } from "../input/use-multi-touch";
