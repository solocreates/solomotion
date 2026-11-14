"use client";

import * as React from "react";
import type { MarkRef } from "@solomotion/core";
import { createPortal } from "react-dom";
import { useSession, type DragPreview, type DragSurface, type LibraryDrag } from "../state/session";
import { releaseDragSnapshot } from "../state/snapshot-drag";
import { capturePointer } from "../input/capture-pointer";
import { cn } from "@/lib/utils";
import { beginHeldDrag } from "../input/hold-to-drag";
import { createEdgeAutoScroll, scrollerAt } from "../timeline/edge-autoscroll";

/**
 * THE drag-out gesture: pull something from a left panel and drop it on the
 * editor. One controller, because there was never more than one gesture — only
 * two copies of it (`use-library-drag`, `use-media-drag`) that had each
 * re-derived the threshold, the ghost, the session publish, the routing and the
 * teardown, and had each drifted.
 *
 * What the copies disagreed about, and why every difference was a bug:
 *
 *  • **Teardown.** Both listened for `pointerup` only. Touch fires
 *    `pointercancel` INSTEAD — the moment the browser claims the gesture as a
 *    scroll — so on a tablet the drag left a ghost pinned to the screen, a live
 *    `pointermove` listener for the rest of the session, and `libraryDrag` set
 *    forever, which is precisely the "placeholder flashes then everything goes
 *    weird" report. `docs/responsive-and-gestures.md` names this as the bug
 *    most likely to bite next; it had already bitten twice here.
 *  • **Routing.** Hover asked one resolver which surface it was over; release
 *    walked a DIFFERENT `closest()` ladder in a different order. Two answers to
 *    one question is how a drop lands somewhere the preview never promised.
 *    Now `dropSurfaceAt` is the only answer, used by both.
 *  • **Publish rate.** Position was written to the session store on every
 *    `pointermove`, re-rendering the stage, the timeline and every lane's drop
 *    preview at pointer-event rate (up to 240Hz on a trackpad, and coalesced
 *    moves arrive in bursts). It is now coalesced into one write per frame.
 *
 * `touch-action` is the other half on touch and it belongs on the panel
 * VIEWPORT, not here — see `DRAG_OUT_SURFACE`.
 */

/** The drop surfaces, innermost concept first. */
const SURFACE_ATTR: ReadonlyArray<[NonNullable<DragSurface>, string]> = [
  ["layers", "[data-layers-drop]"],
  ["timeline", "[data-timeline-drop]"],
  ["stage", "[data-stage-drop]"],
];

export interface DropSurfaceHit {
  kind: NonNullable<DragSurface>;
  el: Element;
}

/**
 * Which editor surface a client point lands on — the ONE resolver, used for the
 * live preview AND for the release. The timeline sits directly below the stage
 * and both span the full width, so a bare Y compare ("above the lanes → new top
 * lane") mis-fires all over the canvas; hit-testing the real DOM is
 * unambiguous. Returns null over any other chrome.
 */
export function dropSurfaceAt(x: number, y: number): DropSurfaceHit | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  for (const [kind, selector] of SURFACE_ATTR) {
    const found = el.closest(selector);
    if (found) return { kind, el: found };
  }
  return null;
}

/**
 * The class a panel's SCROLL VIEWPORT wears so a drag out of it can survive on
 * touch.
 *
 * `pan-y` is deliberate, and it is the whole trade: the browser keeps the
 * one-finger VERTICAL gesture, so the list still scrolls with a thumb the way
 * every list does, and it hands us everything else. Dragging out of a left
 * panel is inherently sideways — the stage and timeline are to the right — so
 * the axis the user needs is exactly the axis we get.
 *
 * `touch-action: none` (what the stage and timeline lanes use) would be wrong
 * here: those surfaces give one-finger scrolling back as a two-finger pan, and
 * a browser panel has no such gesture. A library you cannot scroll with one
 * finger is a worse bug than the one being fixed.
 */
export const DRAG_OUT_SURFACE = "touch-pan-y";

/**
 * The payload, EAGER or LAZY — and the choice is not cosmetic.
 *
 * Building a payload can cost a real document edit: dragging a sound you do
 * not own yet adopts it as an asset so the bytes can stream in behind the
 * gesture. That is the right behaviour for a DRAG and the wrong behaviour for
 * a PRESS, and the two are indistinguishable until the pointer moves — so a
 * card that resolved its payload in `onPointerDown` was importing an asset,
 * and pushing an undo step, every time you merely clicked it.
 *
 * A thunk defers that to the moment the drag actually commits, past the
 * threshold. It must carry its own `label`, because the ghost has to be
 * nameable without paying for the payload — which is exactly the cost being
 * avoided. The type enforces that pairing rather than trusting a caller to
 * remember it.
 */
/**
 * A DROP MOVES YOUR ATTENTION WITH IT.
 *
 * Every browser that can drag something out declares `data-capture-keys` — the
 * app's opt-in for "this surface owns raw keystrokes" — because while you are
 * auditioning a sound, Space has to play the SOUND and not the timeline. That
 * is right, and it is exactly what made dropping feel broken: you drag a sound
 * onto a lane, the clip lands, you press Space to hear it in context, and the
 * panel you have stopped looking at eats the key.
 *
 * Dragging something onto a surface is an unambiguous statement that the
 * surface is now the thing you are working on, so focus follows the drop.
 * Doing it HERE is the whole point: one line at the one place every drag, from
 * every browser, to every surface already passes through. A panel added
 * tomorrow gets this without knowing it exists, and no panel can implement it
 * slightly differently.
 *
 * `tabIndex` is set rather than demanded, because a drop surface's job is to
 * receive clips and requiring it to also be focusable would push a DOM detail
 * into three components to serve one of them. `preventScroll`, because a lane
 * that jumps into view on drop would hide the placement you were watching.
 */
function focusDropSurface(el: Element): void {
  if (!(el instanceof HTMLElement)) return;
  if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
  el.focus({ preventScroll: true });
}

export type DragOutPayload =
  | { drag: NonNullable<LibraryDrag>; label?: string }
  | { drag: () => LibraryDrag; label: string };

export type DragOutOptions = DragOutPayload & {
  /** Badge on the ghost for a multi-item drag. */
  count?: number;
  /**
   * What this drag IS, for anything that collects references rather than
   * content — today, dropping onto a collection in a rail.
   *
   * Declared by the row and acted on by `useCollectionDrop`, so a row says
   * what it is once and never learns where it can be dropped.
   */
  collect?: MarkRef;
  /** Below the movement threshold this was a click, not a drag. */
  onClick?: () => void;
  /** Per-frame hover work owned by the caller (the media library's folders). */
  onHover?: (x: number, y: number, surface: DropSurfaceHit | null) => void;
  /**
   * Released somewhere that is not an editor drop surface. Return true to
   * claim it (a media move into a library folder); false routes nowhere.
   */
  onDropElsewhere?: (x: number, y: number) => boolean;
  /** Always runs on release, claimed or not — the caller's own cleanup. */
  onEnd?: () => void;
};

/**
 * Put this on anything `startDragOut` is wired to.
 *
 * An armed LASSO draws over items on purpose — enclosing a clip is the whole
 * gesture — but an item you can drag OUT of a panel is different: the press
 * that starts a lasso and the press that picks a card up are the same press,
 * and there is no hit-target difference for anything to arbitrate on. So the
 * item says which it is, once, here rather than at every card.
 *
 * `data-no-marquee` is the vocabulary `useSweepSelect` already reads for both
 * shapes, so this is a declaration in an existing language, not a new one.
 */
export const DRAG_OUT_PROPS = { "data-no-marquee": "" } as const;

export function useDragOut() {
  const [ghost, setGhost] = React.useState<{
    x: number;
    y: number;
    label: string;
    count: number;
    preview: DragPreview | null;
  } | null>(null);

  // A drag outlives any single render, so its teardown must be reachable from
  // one — unmounting the panel mid-drag would otherwise leak the same listeners
  // `pointercancel` was leaking.
  const stopRef = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => stopRef.current?.(), []);

  const startDragOut = (e: React.PointerEvent, opts: DragOutOptions) => {
    if (e.button !== 0) return;
    // Kills iOS's long-press → callout/contextmenu synthesis, which otherwise
    // races the drag and wins before it ever starts. Same idiom as every other
    // drag surface in the editor.
    e.preventDefault();
    stopRef.current?.();

    // Read off the synthetic event NOW: every closure below outlives it.
    const target = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    // Keeps the drag alive no matter what is physically under the finger.
    capturePointer(target, pointerId);

    let pending: { x: number; y: number } | null = null;
    const startX = e.clientX;
    const startY = e.clientY;
    const label = opts.label ?? (typeof opts.drag === "function" ? "" : opts.drag.label);
    /*
     * The press becomes a drag under the GESTURE SCOPE inherited at the card —
     * which, since every library and media grid scrolls, means: a quick swipe
     * scrolls the panel, a brief hold then a drag picks the item up. The panel
     * used to lose the drag the moment your finger travelled vertically,
     * because the browser was still free to scroll; arming CLAIMS the pointer
     * and the arbiter then refuses the scroll for the rest of the gesture, so
     * once you have picked something up nothing can take it away.
     */
    const arm = beginHeldDrag(e);
    /*
     * THE RESOLVED PAYLOAD, kept once.
     *
     * `opts.drag` may be a THUNK — the library browser passes one deliberately,
     * so that merely clicking a sound does not adopt it as a document asset and
     * push an undo step. It is resolved exactly once, at the instant a press
     * becomes a drag.
     *
     * The drop then has to dispatch THAT, and it was dispatching `opts.drag`
     * instead: receivers got a FUNCTION, tested `drag.kind`, found `undefined`
     * and silently ignored it. Every library drag — animations, transitions,
     * text looks, sounds — showed a ghost, showed the drop placeholder, and did
     * nothing on release. Media escaped it only because it passes its payload
     * eagerly, which is exactly the kind of split that makes a bug look
     * arbitrary.
     *
     * One resolution, one variable, used by both the preview and the drop.
     */
    let payload: LibraryDrag = null;
    /*
     * Drag to the edge of whatever is under the pointer and it scrolls — the
     * timeline's ends, a long layers list, the sheet. Resolved from the DOM
     * every frame rather than passed in, so it follows the pointer between
     * panels mid-drag and needs nothing added at any drop target.
     */
    const autoScroll = createEdgeAutoScroll({
      getViewport: () => (pending ? scrollerAt(pending.x, pending.y) : null),
    });
    let dragging = false;
    let raf = 0;

    /**
     * ONE hit test, ONE store write and ONE ghost move per FRAME. Pointer moves
     * arrive coalesced and can burst well past 60Hz on a trackpad or a pen;
     * everything downstream of `libraryDragPos` — the stage outline, every
     * lane's drop preview, the layers ring — re-renders off it, so publishing
     * per EVENT made a fast drag re-render the whole editor several times
     * between two paints. That is the "unoptimised, jumpy" half of the report.
     */
    const flush = () => {
      raf = 0;
      if (!pending) return;
      const { x, y } = pending;
      pending = null;
      const surface = dropSurfaceAt(x, y);
      opts.onHover?.(x, y, surface);
      useSession.getState().setLibraryDragPos({ x, y, over: surface?.kind ?? null });
      setGhost({
        x,
        y,
        label,
        count: opts.count ?? 1,
        // Over the stage the drop box carries the picture at its real size;
        // the cursor ghost then steps back to a label so the two do not stack.
        preview: payload?.kind === "snapshot" && surface?.kind !== "stage" ? (payload.preview ?? null) : null,
      });
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!dragging) {
        if (!arm.update(ev.clientX, ev.clientY)) return;
        // The payload is built HERE, not at pointer-down — this is the first
        // instant we know a press was a drag. A lazy payload that resolves to
        // nothing (an online item with no bytes to place) simply never becomes
        // a drag, instead of becoming one that can be dropped nowhere.
        payload = typeof opts.drag === "function" ? opts.drag() : opts.drag;
        if (!payload) {
          stop();
          return;
        }
        dragging = true;
        useSession.getState().setLibraryDrag(payload);
      }
      pending = { x: ev.clientX, y: ev.clientY };
      autoScroll.update(ev.clientX, ev.clientY);
      if (!raf) raf = requestAnimationFrame(flush);
    };

    /** The one teardown. Every ending — release, cancel, blur — comes here. */
    const stop = () => {
      stopRef.current = null;
      arm.end();
      autoScroll.stop();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", stop);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      pending = null;
      setGhost(null);
      // NOTE: `payload` is deliberately NOT cleared here. `onUp` tears down
      // before dispatching (an unmount under the cursor changes what is at the
      // point), so the drop reads it after this has run.

      useSession.getState().setLibraryDrag(null);
      useSession.getState().setLibraryDragPos(null);
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
      opts.onEnd?.();
      // A transient snapshot lives exactly as long as its gesture. Released
      // AFTER the drop has been dispatched (see `onUp`), on the next tick.
      if (payload?.kind === "snapshot") {
        const id = payload.id;
        setTimeout(() => releaseDragSnapshot(id), 0);
      }
    };

    /**
     * Touch fires this INSTEAD of `pointerup` the moment the browser claims the
     * gesture as its own — a scroll, a page zoom, a system edge swipe, an
     * incoming call. Without it the ghost stays pinned to the screen, the
     * pointermove listener outlives the gesture by the whole session, and
     * `libraryDrag` never clears. Found three times before in this codebase.
     */
    const onPointerCancel = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) stop();
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const wasDragging = dragging;
      const x = ev.clientX;
      const y = ev.clientY;
      // Resolve the target BEFORE teardown: clearing `libraryDrag` unmounts the
      // previews, and an unmount under the cursor changes what is at the point.
      const surface = wasDragging ? dropSurfaceAt(x, y) : null;
      stop();
      if (!wasDragging) {
        opts.onClick?.();
        return;
      }
      if (surface && payload) {
        surface.el.dispatchEvent(
          new CustomEvent("tm-library-drop", { detail: { clientX: x, clientY: y, drag: payload } }),
        );
        focusDropSurface(surface.el);
        return;
      }
      opts.onDropElsewhere?.(x, y);
    };

    stopRef.current = stop;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onPointerCancel);
    // Focus leaving the window (a system dialog, ⌘-tab) ends the drag too — no
    // pointer event is coming for it.
    window.addEventListener("blur", stop);
  };

  const ghostNode =
    ghost &&
    createPortal(
      <div
        className="pointer-events-none fixed z-200 -translate-x-1/2 -translate-y-full"
        style={{ left: ghost.x, top: ghost.y - 8 }}
      >
        <div
          className={cn(
            "relative rounded-md border border-primary/60 bg-card/95 text-xs shadow-xl backdrop-blur",
            ghost.preview ? "flex flex-col items-center gap-1 p-1.5" : "px-2 py-1",
          )}
        >
          {ghost.preview && <DragPreviewArt preview={ghost.preview} className="size-12" />}
          <span className="max-w-40 truncate">{ghost.label}</span>
          {ghost.count > 1 && (
            <span className="absolute -right-2 -top-2 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
              {ghost.count}
            </span>
          )}
        </div>
      </div>,
      document.body,
    );

  return { startDragOut, ghostNode };
}

/**
 * A drag's picture, drawn from what it is: inline SVG for artwork that is an
 * SVG, an image otherwise. Shared by the cursor ghost and the stage's drop box
 * so the two cannot show different things.
 */
export function DragPreviewArt({ preview, className }: { preview: DragPreview; className?: string }) {
  if (preview.kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={preview.url} alt="" draggable={false} className={cn("object-contain", className)} />;
  }
  return (
    <div
      className={cn("[&>svg]:size-full [&>svg]:overflow-visible", className)}
      // The markup is ours: built by the panel from a catalogue body, never
      // typed by a user.
      dangerouslySetInnerHTML={{ __html: preview.markup }}
    />
  );
}
