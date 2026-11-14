"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { claimPointer, subscribePointerEnd } from "@/editor/input/pointer-gestures";
import { capturePointer } from "@/editor/input/capture-pointer";
import { DRAG_SURFACE } from "@/editor/input/use-multi-touch";

/**
 * THE SCROLL AREA — one scroller, and its bar is DERIVED FROM THE DOM, never
 * from React state.
 *
 * ## Why this stopped being a Radix wrapper
 *
 * It was `@radix-ui/react-scroll-area`, and the wrapper around it had grown
 * three separate workarounds for the same underlying fault, which is always the
 * sign that the foundation is wrong rather than unlucky:
 *
 *   · Radix's own `type="auto"` never detected overflow here, so we measured it
 *     ourselves and forced `type="always"`;
 *   · Radix's `hasThumb` stayed false even once it had measured the track and
 *     written `--radix-scroll-area-thumb-height`, so the thumb needed
 *     `forceMount` to appear at all;
 *   · its content wrapper is `display: table`, which shrink-wraps to the
 *     content's intrinsic width, so every panel needed `[&>div]:!block`.
 *
 * All three are the same bug. Radix keeps the bar's geometry — content height,
 * viewport height, track size — in REACT STATE (`sizes`), refreshed by
 * debounced ResizeObservers on the scrollbar and the content wrapper. State
 * that describes live layout is state that can disagree with the layout, and
 * here it did: the thumb was sized and positioned from numbers measured at some
 * earlier render. It read as a bar that lagged behind the content, sat at the
 * wrong place, or simply stopped tracking — worst in the panels that reflow
 * most (Library, the design tabs), which is exactly where stale measurements
 * are most likely.
 *
 * ## The model: React owns PRESENCE, the DOM owns POSITION
 *
 * A scroll position changes sixty times a second. Whether a surface overflows
 * at all changes twice a session. Those are not the same kind of fact and must
 * not travel through the same mechanism.
 *
 * So this component renders ONCE and never again. `sync()` reads the viewport's
 * live `scrollTop`/`scrollHeight`/`clientHeight` and writes the thumb's size,
 * its transform, and a `data-overflow` attribute straight to the DOM. There is
 * no state to go stale because there is no state: the bar cannot disagree with
 * the scroller, because it IS the scroller, read at the moment of asking.
 *
 * It is the same trade `--hit-grip` makes one level down, and the same rule the
 * repo applies to playback: **nothing that changes per frame may go through
 * React.** A scrollbar is a per-frame thing wearing a component's clothes.
 *
 * `sync()` runs on `scroll` (passive), and on a ResizeObserver watching both
 * the viewport and the content — which is every way either number can change.
 */

/** Smallest a thumb may get, however long the content is. Below this it stops
 *  being grabbable and stops reading as a position. */
const MIN_THUMB_PX = 24;

/** Overflow this small is padding, not content — see `geometry`. */
const MIN_OVERFLOW_PX = 8;

/**
 * How long a bar stays up after the last scroll. An OVERLAY scrollbar, which is
 * what every platform has shipped for a decade: it is feedback about a gesture
 * in progress, not a permanent frame around the content.
 *
 * It used to be visible for as long as the surface overflowed, which is
 * defensible down the edge of a tall panel and wrong everywhere else — on the
 * stage's tool options bar it drew a permanent light rule across the feet of
 * the icons, inside a floating capsule over the artwork, saying nothing anyone
 * needed to know while they were not scrolling it.
 */
const HIDE_AFTER_MS = 900;

type Axis = "y" | "x";

/**
 * The bar's whole geometry, from the scroller and nothing else. Pure, so the
 * rule "a thumb is the viewport's share of the content, offset by how far you
 * have scrolled" lives in one place and both axes read it.
 */
function geometry(vp: HTMLElement, axis: Axis, track: number) {
  const content = axis === "y" ? vp.scrollHeight : vp.scrollWidth;
  const view = axis === "y" ? vp.clientHeight : vp.clientWidth;
  const pos = axis === "y" ? vp.scrollTop : vp.scrollLeft;
  // A few px of SLACK. Sub-pixel rounding reports a permanent 1px overflow on
  // surfaces that fit exactly — and a list that is taller than its box by only
  // its own bottom padding (a 433px tab in a 429px viewport) is not a list you
  // scroll: it drew a full-height bar that moved 4px per wheel tick, which
  // reads as a FROZEN scroller. Below this there is nothing to reveal but
  // padding, so there is no bar; the few pixels still scroll natively.
  const scrollable = content - view;
  if (scrollable <= MIN_OVERFLOW_PX || track <= 0) return null;
  const size = Math.max(MIN_THUMB_PX, Math.round((view / content) * track));
  const travel = track - size;
  const offset = travel <= 0 ? 0 : Math.round((pos / scrollable) * travel);
  return { size, offset, scrollable, travel };
}

/**
 * One bar. Mounted ALWAYS — presence is a `data-overflow` attribute, not a
 * mount — because mounting and unmounting a bar as content changes is a React
 * render in the middle of a scroll, and re-measuring from scratch each time is
 * how a bar ends up briefly wrong every time a list filters.
 */
function ScrollBar({
  axis,
  viewport,
}: {
  axis: Axis;
  viewport: React.RefObject<HTMLDivElement | null>;
}) {
  const barRef = React.useRef<HTMLDivElement>(null);
  const thumbRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const vp = viewport.current;
    const bar = barRef.current;
    const thumb = thumbRef.current;
    if (!vp || !bar || !thumb) return;

    const vertical = axis === "y";

    /** Read the scroller, write the bar. The only thing this component does. */
    const sync = () => {
      const track = vertical ? bar.clientHeight : bar.clientWidth;
      const g = geometry(vp, axis, track);
      bar.dataset.overflow = g ? "1" : "0";
      if (!g) return;
      // A bar that cannot scroll is not "shown but idle", it is gone — so a
      // surface that stops overflowing takes its bar with it immediately
      // rather than leaving one behind for the rest of the hide delay.
      if (vertical) {
        thumb.style.height = `${g.size}px`;
        thumb.style.transform = `translate3d(0,${g.offset}px,0)`;
      } else {
        thumb.style.width = `${g.size}px`;
        thumb.style.transform = `translate3d(${g.offset}px,0,0)`;
      }
    };

    // ── When the bar is VISIBLE ─────────────────────────────────────────────
    // Presence is `data-overflow` (can this scroll at all); visibility is
    // `data-show` (is it worth looking at right now). Two facts, two
    // attributes, both written straight to the DOM for the same reason the
    // geometry is — a scrollbar's visibility changes mid-gesture, and nothing
    // that changes mid-gesture belongs in React state.
    let hovering = false;
    let hideAt = 0;
    /** The in-flight thumb/track drag, if any — declared here because the hide
     *  timer has to know not to fade a bar out from under the pointer. */
    let grab: { pointer: number; from: number; scroll: number } | null = null;
    const show = (on: boolean) => {
      bar.dataset.show = on ? "1" : "0";
    };
    const idle = () => {
      window.clearTimeout(hideAt);
      hideAt = window.setTimeout(() => show(hovering || grab != null), HIDE_AFTER_MS);
    };
    /** Something happened that the bar is the feedback for. */
    const poke = () => {
      show(true);
      idle();
    };
    const onEnter = () => {
      hovering = true;
      show(true);
      window.clearTimeout(hideAt);
    };
    const onLeave = () => {
      hovering = false;
      idle();
    };
    // The ROOT, not the viewport: the bar is the viewport's sibling, so hovering
    // the bar itself would otherwise read as having left the area it belongs to.
    const root = vp.parentElement;

    sync();
    vp.addEventListener("scroll", poke, { passive: true });
    root?.addEventListener("pointerenter", onEnter);
    root?.addEventListener("pointerleave", onLeave);
    vp.addEventListener("scroll", sync, { passive: true });
    // BOTH, and neither is redundant. The viewport's box changes when a panel
    // is resized; the content's changes when rows are added, filtered or the
    // panel's zoom reflows the grid. Watching only one leaves the bar stale for
    // whichever half you did not watch — which is the fault this replaces.
    const ro = new ResizeObserver(sync);
    ro.observe(vp);
    if (vp.firstElementChild) ro.observe(vp.firstElementChild);
    ro.observe(bar);

    // ── Dragging the thumb ──────────────────────────────────────────────────
    // A scrollbar drag is STATIONARY FIRST: you put the pointer on the thumb
    // and then push. So it claims `"hold"` on press, which is the app's
    // declaration that this press is already spoken for — the long press stands
    // down instead of opening a context menu on top of the drag, and the
    // arbiter refuses the browser's scroll for the rest of the gesture.

    const scrollTo = (v: number) => {
      if (vertical) vp.scrollTop = v;
      else vp.scrollLeft = v;
    };

    const onThumbDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const track = vertical ? bar.clientHeight : bar.clientWidth;
      const g = geometry(vp, axis, track);
      if (!g) return;
      e.preventDefault();
      e.stopPropagation();
      claimPointer(e.pointerId, "hold");
      capturePointer(thumb, e.pointerId);
      grab = {
        pointer: e.pointerId,
        from: vertical ? e.clientY : e.clientX,
        scroll: vertical ? vp.scrollTop : vp.scrollLeft,
      };
      poke();
    };

    const onMove = (e: PointerEvent) => {
      if (!grab || e.pointerId !== grab.pointer) return;
      const track = vertical ? bar.clientHeight : bar.clientWidth;
      const g = geometry(vp, axis, track);
      if (!g || g.travel <= 0) return;
      const moved = (vertical ? e.clientY : e.clientX) - grab.from;
      // The thumb travels `travel` px while the content travels `scrollable`.
      scrollTo(grab.scroll + (moved / g.travel) * g.scrollable);
    };

    /*
     * A click on the TRACK jumps the thumb to the pointer and then keeps
     * dragging — the macOS "jump to the spot that's clicked" behaviour, and the
     * one every design tool uses. Paging by a screen is the Windows default and
     * is strictly worse on a long list.
     */
    const onTrackDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.target === thumb) return;
      const track = vertical ? bar.clientHeight : bar.clientWidth;
      const g = geometry(vp, axis, track);
      if (!g) return;
      e.preventDefault();
      claimPointer(e.pointerId, "hold");
      capturePointer(thumb, e.pointerId);
      const rect = bar.getBoundingClientRect();
      const at = (vertical ? e.clientY - rect.top : e.clientX - rect.left) - g.size / 2;
      const next = g.travel <= 0 ? 0 : (at / g.travel) * g.scrollable;
      scrollTo(Math.max(0, Math.min(g.scrollable, next)));
      grab = {
        pointer: e.pointerId,
        from: vertical ? e.clientY : e.clientX,
        scroll: vertical ? vp.scrollTop : vp.scrollLeft,
      };
    };

    // The wheel over a bar scrolls the thing the bar belongs to. Without this
    // the pointer sits on a sibling of the viewport and the wheel does nothing,
    // which reads as the panel being frozen.
    const onWheel = (e: WheelEvent) => {
      vp.scrollBy({ top: e.deltaY, left: e.deltaX });
      e.preventDefault();
    };

    thumb.addEventListener("pointerdown", onThumbDown);
    bar.addEventListener("pointerdown", onTrackDown);
    bar.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("pointermove", onMove);
    // A lost pointer ABORTS. `subscribePointerEnd` covers the release, the
    // cancel, AND the window blurring or a layer opening over the press — the
    // trio a hand-rolled drag forgets a third of. See the input doc.
    const unsubscribe = subscribePointerEnd((id) => {
      if (!grab || grab.pointer !== id) return;
      grab = null;
      idle();
    });

    return () => {
      window.clearTimeout(hideAt);
      vp.removeEventListener("scroll", sync);
      vp.removeEventListener("scroll", poke);
      root?.removeEventListener("pointerenter", onEnter);
      root?.removeEventListener("pointerleave", onLeave);
      ro.disconnect();
      thumb.removeEventListener("pointerdown", onThumbDown);
      bar.removeEventListener("pointerdown", onTrackDown);
      bar.removeEventListener("wheel", onWheel);
      window.removeEventListener("pointermove", onMove);
      unsubscribe();
    };
  }, [axis, viewport]);

  return (
    <div
      ref={barRef}
      data-overflow="0"
      data-show="0"
      aria-hidden
      className={cn(
        DRAG_SURFACE,
        // NO PADDING on the track. `bar.clientHeight` includes it, so a padded
        // bar makes the measured track larger than the space the thumb can
        // actually occupy — the thumb ends up a couple of pixels too long and
        // overshoots the end of its own groove. The visual inset comes from the
        // thumb being narrower instead, which costs the geometry nothing.
        "absolute z-10 opacity-0 transition-opacity duration-200",
        // BOTH have to be true: there is something to scroll, and the reader is
        // either doing it or is over the surface. `data-overflow` alone still
        // governs the hit target, so the track stays grabbable through the fade.
        //
        // VISIBLE needs `overflow=1` too, not just `show=1`. Hover sets `show`
        // on any scroll area, and a bar that could not scroll used to fade in
        // anyway — wearing the thumb left over from the last content that DID
        // overflow (a settings tab you came from), so a short tab showed a
        // handle that went nowhere.
        "data-[show=1]:data-[overflow=1]:opacity-100 data-[overflow=0]:pointer-events-none",
        axis === "y" ? "top-0 right-0 bottom-0 w-2" : "right-0 bottom-0 left-0 h-2",
      )}
    >
      {/* `bg-border` is a HAIRLINE value (7% white) — correct for structure,
          invisible for a control. A thumb has to be findable on glass, so it
          gets its own weight and answers the pointer. */}
      <div
        ref={thumbRef}
        className={cn(
          "rounded-full bg-foreground/25 transition-colors hover:bg-foreground/40 active:bg-foreground/50",
          axis === "y" ? "mx-auto w-1.5" : "my-auto h-1.5",
        )}
      />
    </div>
  );
}

function ScrollArea({
  className,
  children,
  viewportRef,
  viewportClassName,
  contentClassName,
  orientation = "vertical",
  viewportProps,
  fill = false,
  bars = true,
  ...props
}: React.ComponentProps<"div"> & {
  /**
   * Which bars this area can show. It only ever rendered a vertical one, so
   * every horizontally-scrolling row in the app kept a raw `overflow-x-auto`
   * (and the native scrollbar that comes with it) — there was no way to ask
   * for the styled one. "both" is for surfaces that pan in two axes.
   */
  orientation?: "vertical" | "horizontal" | "both";
  /**
   * The scrolling element itself. Panels that virtualise their rows, sync two
   * scrollers, or restore a scroll position need the VIEWPORT, not the root —
   * and without a way to reach it they all kept a raw `overflow-y-auto` div
   * instead, which is why half the app never got the styled scrollbar.
   */
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportClassName?: string;
  /**
   * Classes for the CONTENT wrapper — the one box your children actually sit
   * in. Spacing between children (`space-y-*`, `gap-*`) belongs HERE: on the
   * viewport it spaces the single wrapper and nothing else, which is how the
   * export dialog's stacked controls came to touch.
   */
  contentClassName?: string;
  /**
   * Props for the VIEWPORT element. `scroll` does not bubble, so an `onScroll`
   * on the root never fires — which is why every scroller that syncs a second
   * pane (the timeline and its track headers, the graph and its lane list) or
   * accepts a drop had to stay a raw `overflow-auto` div. They are the app's
   * biggest scrollers and had the app's only unstyled bars.
   */
  viewportProps?: Omit<React.ComponentProps<"div">, "ref" | "className" | "children">;
  /**
   * Stretch the content to the full height of the viewport, even when there is
   * less of it than that.
   *
   * Set this on any scroller whose content is a DRAG SURFACE — a marquee, a
   * drop target, a click-to-deselect background. Without it the surface ends
   * where the last row does, and the empty space beneath it belongs to nobody:
   * the classic "rubber-band select only works where there are already items".
   */
  fill?: boolean;
  /** False when the panel drives this axis with its own `ZoomBar`: no second bar. */
  bars?: boolean;
}) {
  const viewport = React.useRef<HTMLDivElement>(null);

  const attachViewport = React.useCallback(
    (el: HTMLDivElement | null) => {
      viewport.current = el;
      if (typeof viewportRef === "function") viewportRef(el);
      else if (viewportRef) (viewportRef as React.RefObject<HTMLDivElement | null>).current = el;
    },
    [viewportRef],
  );

  return (
    // A FLEX COLUMN with the viewport as its one flexible child — see below.
    <div className={cn("relative flex flex-col overflow-hidden", className)} {...props}>
      {/*
          `flex-1 min-h-0`, NOT `h-full` — and this is the fix for "the panel
          just gets cut off instead of scrolling".

          The viewport used to size itself with `height: 100%`. A percentage
          height only resolves against a containing block with a DEFINITE
          height, and the most common way a ScrollArea is used in this app is
          `flex-1 min-h-0` inside a flex column — a box whose height comes from
          flex layout, where the computed `height` is still `auto`. The
          percentage had nothing to resolve against, so it fell back to the
          content height: the viewport grew past its root, the root's
          `overflow-hidden` clipped the difference, and there was no overflow to
          find. A window that "does nothing when you resize it" and a sound card
          whose knobs are cut off at the bottom were both this.

          A flex column removes percentages from the problem entirely, and
          covers BOTH ways a ScrollArea gets its size with one mechanism: a
          definite root hands the viewport exactly that box, and a root sized by
          `max-h-*` grows with its content until the cap and then shrinks the
          viewport against it. */}
      <div
        ref={attachViewport}
        className={cn(
          "tm-no-native-scrollbar min-h-0 w-full flex-1 rounded-[inherit]",
          orientation === "vertical" && "overflow-x-hidden overflow-y-auto",
          orientation === "horizontal" && "overflow-x-auto overflow-y-hidden",
          orientation === "both" && "overflow-auto",
          viewportClassName,
        )}
        {...viewportProps}
      >
        {/* The content wrapper is what the ResizeObserver watches, and what
            `fill` makes a column so its child can grow inside it. `min-h-full`
            on the child alone cannot do this — a percentage height against an
            auto-height parent resolves to nothing, silently. */}
        <div
          className={cn(
            // A HORIZONTAL scroller's content is `w-max`: `w-full` pins the
            // wrapper to the viewport, so the ResizeObserver watches a box that
            // can never change and the bar goes stale the moment the row's
            // contents do. `min-w-full` keeps a short row filling the track.
            orientation === "horizontal" ? "min-w-full w-max" : "w-full",
            fill && "flex min-h-full flex-col [&>*]:flex-1",
            contentClassName,
          )}
        >
          {children}
        </div>
      </div>
      {bars && orientation !== "horizontal" && <ScrollBar axis="y" viewport={viewport} />}
      {bars && orientation !== "vertical" && <ScrollBar axis="x" viewport={viewport} />}
    </div>
  );
}

export { ScrollArea, ScrollBar };
