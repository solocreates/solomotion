"use client";

import { cursors } from "@solomotion/ui/cursors";
import * as React from "react";
import { createPortal } from "react-dom";
import { Minus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAfterPaint } from "@/components/ui/use-after-paint";
import { withFloatingLayerEvents } from "@/lib/portal-events";
import { ScrollArea } from "./scroll-area";
import { useWindowManager, windowZIndex } from "./window-manager";
import { capturePointer } from "../../editor/input/capture-pointer";
import { claimPointer } from "../../editor/input/pointer-gestures";
import { DRAG_SURFACE } from "../../editor/input/use-multi-touch";

export { createWindowSizes, useHasRememberedSize } from "./window-sizes";
export type { WindowSize, WindowSizeHint, WindowSizes } from "./window-sizes";

/**
 * The shared floating-window chrome (Figma-style): a title bar you drag to move,
 * edge/corner handles to resize, minimize-to-bar and close, raise-on-interact.
 * Purely presentational and headless about WHERE bounds live — the caller owns
 * `bounds` and gets patch callbacks — so the plugin dock, the variables window
 * and anything else float with identical behavior and none reimplement it.
 */

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  /**
   * A pixel height, or `"auto"` — the window HUGS its content, capped at the
   * viewport, and scrolls only once it runs out of screen.
   *
   * Auto is the honest default for a tool window: a fixed height is a promise
   * that the body will fill it, and when it doesn't the leftover grey reads as
   * something that failed to load. Dragging the bottom edge converts auto into
   * the pixel height you dragged it to (so the gesture is continuous, never a
   * jump); double-clicking that edge hands it back to auto.
   */
  height: number | "auto";
  minimized: boolean;
}

/**
 * Drop an `"auto"` height from a bounds patch.
 *
 * For windows whose BODY FILLS THE FRAME — the panel dock, the plugin dock —
 * hugging the content is not a meaningful state: the content is already sized
 * to the window. They store a plain `number`, so the fit-height gesture is
 * simply a no-op for them rather than something each one has to cast away.
 */
export function pixelBounds(
  patch: Partial<Pick<WindowBounds, "x" | "y" | "width" | "height">>,
): Partial<{ x: number; y: number; width: number; height: number }> {
  const { height, ...rest } = patch;
  return typeof height === "number" ? { ...rest, height } : rest;
}

export interface FloatingWindowProps {
  title: string;
  icon?: React.ReactNode;
  bounds: WindowBounds;
  /** Move/resize deltas arrive as a position/size patch (minimize is separate). */
  onBoundsChange: (patch: Partial<Pick<WindowBounds, "x" | "y" | "width" | "height">>) => void;
  onClose: () => void;
  onToggleMinimize: () => void;
  /** Raised when the window is interacted with (for stacking). */
  onFocus?: () => void;
  /**
   * A unique id in the shared window manager — when set, stacking is FULLY
   * automatic (register on mount, raise on interaction, z from focus order) and
   * `zIndex` is ignored. This is how every window competes in ONE global order.
   */
  windowId?: string;
  /** Fallback CSS z-index when there's no `windowId` (legacy callers). */
  zIndex?: number;
  /** Move-gesture lifecycle — lets a caller preview a snap/dock while dragging
   *  the title bar and commit it on release (position patches still stream
   *  through `onBoundsChange` throughout). */
  onMoveStart?: () => void;
  onMoveEnd?: () => void;
  minWidth?: number;
  minHeight?: number;
  /** Extra controls in the title bar, left of minimize/close. */
  titleActions?: React.ReactNode;
  /**
   * WHO SCROLLS. The window does, or the content does — and one of them must,
   * which is the whole reason this is a prop rather than a convention.
   *
   *  • `"scroll"` (default) — the body IS a `ScrollArea` sized to the window.
   *    Hand it any content of any height and it scrolls correctly, in both the
   *    auto-height and dragged-height cases, with the app's styled bar. This is
   *    what a plugin author gets without knowing anything about layout.
   *  • `"fill"` — the body is a bounded flex box that never scrolls, for content
   *    that fills the frame (a pan surface, a plugin iframe) or that has a fixed
   *    header over its OWN `ScrollArea` (the effect editor, the console).
   *
   * The body used to be a raw `overflow-y-auto` div, and that is the bug this
   * replaces. Every window whose content had a sticky header put a `ScrollArea`
   * inside it — so there were two scrollers, nested, and the inner one's
   * `flex-1 min-h-0` meant nothing because its parent was a plain block rather
   * than a flex column. Its `h-full` then resolved against content height, so
   * the ScrollArea grew to fit its own content, never scrolled, and the native
   * scroller outside it did the work with an unstyled bar. Dragging the window
   * taller changed which slice you saw and nothing about the layout, which is
   * exactly the "resizing does nothing" it felt like.
   */
  body?: "scroll" | "fill";
  children: React.ReactNode;
  eager?: boolean;
  className?: string;
}

export function FloatingWindow({
  title,
  icon,
  bounds,
  onBoundsChange,
  onClose,
  onToggleMinimize,
  onFocus,
  windowId,
  zIndex,
  onMoveStart,
  onMoveEnd,
  minWidth = 260,
  minHeight = 200,
  titleActions,
  body = "scroll",
  children,
  /** Mount the body in the same frame as the chrome. For a window whose content
   *  is trivial AND whose first paint must be atomic (a live readout that would
   *  visibly pop in). Almost nothing needs this. */
  eager = false,
  className,
}: FloatingWindowProps) {
  // Register in the shared window manager: the frontmost (last-focused) window
  // always wins z, one global order across every floating surface.
  const order = useWindowManager((s) => s.order);
  React.useEffect(() => {
    if (!windowId) return;
    useWindowManager.getState().register(windowId);
    return () => useWindowManager.getState().unregister(windowId);
  }, [windowId]);
  const resolvedZ = windowId ? windowZIndex(order, windowId) : zIndex;

  /*
   * EVERY window is portalled to the body, and that is what makes this
   * primitive genuinely headless: WHERE a window is declared in the React tree
   * stops being able to affect where it paints.
   *
   * It could before, and the symptom was baffling. The Variables window is
   * mounted at the editor root, so it painted above everything. The effect
   * editor is declared inside the effect CARD, three levels down the inspector
   * panel — a `.shell-card` with its own stacking context — so its `z-index:
   * 30` was resolved INSIDE that card and could only ever compete with the
   * card's siblings. The whole inspector then painted below the timeline, and
   * the playhead drew a line straight down through the effect window. Same
   * component, same z, opposite result, decided entirely by which file happened
   * to render it.
   *
   * No caller should have to know that, and now none does: a window declared
   * anywhere lands in the same place in the same order, which is exactly what
   * the shared window manager already promised about stacking.
   */
  const [portalHost, setPortalHost] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => setPortalHost(document.body), []);

  // Minimised windows have no body to build, so the deferral resets with them
  // and re-expanding is a fresh two-frame open rather than a stall.
  const bodyReady = useAfterPaint(!bounds.minimized) || eager;
  // Measured so the first drag on an AUTO window starts from the height that
  // is actually on screen rather than snapping to `minHeight`.
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const raise = () => {
    if (windowId) useWindowManager.getState().raise(windowId);
    onFocus?.();
  };

  // Shared pointer-drag: title bar moves, handles resize (dx/dy appliers over
  // the bounds captured at gesture start). `cursor` paints the whole document
  // (not just the grabbed element) so the hand stays CLOSED for the whole drag.
  const dragGesture = (
    e: React.PointerEvent,
    apply: (dx: number, dy: number, start: WindowBounds) => void,
    opts?: { cursor?: string; onStart?: () => void; onEnd?: () => void },
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    capturePointer(target, e.pointerId);
    /*
     * CLAIM ON PRESS — the ONE seam every window gesture comes through, so the
     * title bar and all four edges get it together.
     *
     * `touch-action: none` tells the BROWSER not to scroll from this element;
     * claiming tells the ARBITER, which then refuses the browser's scroll for
     * the whole gesture from a non-passive `touchmove`. Both are needed on iOS,
     * where a drag beginning near a screen edge is still eligible for a system
     * gesture the CSS alone does not cover — and losing it that way is exactly
     * "it moves a few pixels and disconnects".
     *
     * `"hold"`, because a window drag is meaningful while stationary: no
     * context menu opens on top of it.
     */
    claimPointer(e.pointerId, "hold");
    const startX = e.clientX;
    const startY = e.clientY;
    const start: WindowBounds = {
      ...bounds,
      height: typeof bounds.height === "number" ? bounds.height : (rootRef.current?.offsetHeight ?? minHeight),
    };
    // The pointer is CAPTURED by the title/handle, so its own `cursor` wins over
    // the body — set BOTH (element + body) to keep the closed hand for the whole
    // drag, wherever the pointer roams.
    const prevBody = document.body.style.cursor;
    const prevTarget = target.style.cursor;
    if (opts?.cursor) {
      document.body.style.cursor = opts.cursor;
      target.style.cursor = opts.cursor;
    }
    opts?.onStart?.();
    const onMove = (ev: PointerEvent) => apply(ev.clientX - startX, ev.clientY - startY, start);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = prevBody;
      target.style.cursor = prevTarget;
      opts?.onEnd?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startMove = (e: React.PointerEvent) =>
    dragGesture(
      e,
      (dx, dy, s) =>
        onBoundsChange({
          x: Math.min(Math.max(8 - s.width + 80, s.x + dx), window.innerWidth - 80),
          y: Math.min(Math.max(8, s.y + dy), window.innerHeight - 40),
        }),
      { cursor: cursors.grabbing, onStart: onMoveStart, onEnd: onMoveEnd },
    );

  const startResize = (edge: "e" | "s" | "se") => (e: React.PointerEvent) =>
    dragGesture(e, (dx, dy, s) =>
      onBoundsChange({
        ...(edge !== "s" ? { width: Math.max(minWidth, s.width + dx) } : {}),
        // `s.height` was resolved to real pixels at gesture start, so dragging
        // an auto window is a continuous nudge from where it already was.
        ...(edge !== "e" ? { height: Math.max(minHeight, (s.height as number) + dy) } : {}),
      }),
    );

  /** Double-click the bottom/corner handle → back to hugging the content. */
  const fitHeight = (e: React.MouseEvent) => {
    e.stopPropagation();
    onBoundsChange({ height: "auto" });
  };

  const window_ = (
    <div
      ref={rootRef}
      // A window is a floating layer like any other: its right-clicks and
      // pointerdowns belong to it, never to whatever rendered it. Without this
      // a right-click in the Variables window reached the stage's menu, which
      // then dismissed whatever the window had open (see lib/portal-events).
      {...withFloatingLayerEvents({})}
      className={cn(
        // The same material as every menu and stage capsule, at the WORKBENCH
        // density (see `--glass-tint-strong` in globals.css). A window is not
        // chrome you glance through — it is a surface you read forty numeric
        // fields on, for minutes — and at menu density the panel edges and clip
        // bars behind it survived the blur as ghost lines ruled through the
        // controls, which reads as "the opacity got turned down", not as glass.
        // The tint, the saturation lift, the edge light and the cast shadow all
        // still do their work; what is gone is being able to READ the app
        // through the pane.
        "material-glass-strong fixed flex flex-col overflow-hidden text-popover-foreground",
        className,
      )}
      data-floating-window={title}
      // The window's identity in the DOM. Since the frame is portalled to the
      // body, a local `ref.current.contains(target)` no longer answers "was this
      // click inside my window?" — this is what a dismiss-on-outside-click
      // handler tests instead, and it works from anywhere.
      data-window-id={windowId}
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.minimized || bounds.height === "auto" ? undefined : bounds.height,
        // An auto window still has to fit the screen: it grows to its content
        // and then its body starts scrolling, which is the behaviour you want
        // and the one a fixed height can only approximate.
        maxHeight: bounds.minimized ? undefined : `calc(100vh - ${Math.max(0, bounds.y) + 16}px)`,
        zIndex: resolvedZ,
      }}
      onPointerDownCapture={raise}
    >
      <div
        // A title bar IS a drag handle, so it wears the app's one name for
        // that. `DRAG_SURFACE` is `touch-action: none` (or the browser claims
        // the first pixels of a touch drag as a pan and cancels the move) plus
        // the two iOS lines that stop a held press raising a selection callout,
        // which cancels the touch outright.
        className={cn(
          DRAG_SURFACE,
          "flex h-9 shrink-0 cursor-grab items-center gap-2 border-b border-border/70 bg-muted/40 px-2.5 active:cursor-grabbing",
        )}
        onPointerDown={startMove}
        onDoubleClick={onToggleMinimize}
      >
        {icon && <span className="shrink-0 text-muted-foreground [&_svg]:size-3.5">{icon}</span>}
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{title}</span>
        {/* Title-bar controls opt OUT of the move gesture: without this the bar's
            pointerdown starts a drag and eats the click, so a picker mounted here
            would simply never open. */}
        {titleActions && (
          <div className="flex shrink-0 items-center gap-0.5" onPointerDown={(e) => e.stopPropagation()}>
            {titleActions}
          </div>
        )}
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onToggleMinimize}
          title={bounds.minimized ? "Expand" : "Minimize"}
        >
          <Minus className="size-3" />
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
          title="Close"
        >
          <X className="size-3" />
        </button>
      </div>

      {/* THE window body is a CONTAINER. Every floating surface in the app —
          the effect editor, the plugin dock, the node board, anything a plugin
          author ships tomorrow — can therefore lay itself out against the
          window it is actually in, with `@[560px]:` and friends, instead of
          asking the browser how wide the monitor is. That is the whole reason a
          760px effect window used to arrange itself as if it had 1440px.

          It costs one class here and it is the difference between "this window
          is responsive" and "every window is responsive". */}
      <div
        className={cn(
          // A FLEX COLUMN that never scrolls itself. This is what gives a child
          // a bounded box to be `flex-1 min-h-0` inside — in the auto-height
          // case too, because the root's `maxHeight` bounds the column and flex
          // shrinks the body to fit. It is the one line that makes "the scroll
          // area fills the window" true for every window at once.
          "@container flex min-h-0 flex-1 flex-col overflow-hidden",
          bounds.minimized && "hidden",
        )}
      >
        {/* THE BODY ARRIVES A FRAME LATE, on purpose.

            A window that mounts everything it needs in the commit that opens it
            pays for all of it before anything is on screen, so the app appears
            to freeze and THEN the window appears — the worst possible order,
            and it gets worse with every panel that grows. Painting the chrome
            first reverses it: the window is there immediately and fills in
            against itself.

            This is perceptual, not an optimisation — see `useAfterPaint`. It
            costs one frame, which is invisible for a cheap window and is the
            difference between "opened" and "hung" for an expensive one. Every
            window gets it, so a plugin or an effect editor added later is fast
            to open without its author knowing this exists. */}
        {!bodyReady ? null : body === "scroll" ? (
          <ScrollArea className="min-h-0 flex-1" orientation="both">
            {children}
          </ScrollArea>
        ) : (
          children
        )}
      </div>

      {!bounds.minimized && (
        <>
          <div
            className={cn(DRAG_SURFACE, "absolute top-9 right-0 bottom-2 w-(--hit-grip) cursor-ew-resize")}
            onPointerDown={startResize("e")}
          />
          <div
            className={cn(DRAG_SURFACE, "absolute right-2 bottom-0 left-2 h-(--hit-grip) cursor-ns-resize")}
            title="Drag to set a height · double-click to fit the content"
            onPointerDown={startResize("s")}
            onDoubleClick={fitHeight}
          />
          <div
            className={cn(DRAG_SURFACE, "absolute right-0 bottom-0 size-(--hit-target) cursor-nwse-resize")}
            title="Drag to resize · double-click to fit the height to the content"
            onPointerDown={startResize("se")}
            onDoubleClick={fitHeight}
          />
        </>
      )}
    </div>
  );

  // Before hydration there is no body to portal into; rendering nothing for one
  // tick is correct, since a floating window is never server-rendered content.
  return portalHost ? createPortal(window_, portalHost) : null;
}
