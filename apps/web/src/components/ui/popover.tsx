"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { withFloatingLayerEvents } from "@/lib/portal-events";

/**
 * The app's popover primitive — and the ONE place edge behaviour is solved.
 *
 * Two bugs used to be re-invented at every call site:
 *  • a panel taller than the space below the trigger made Radix FLIP sides, so
 *    switching a tab inside an open popover (a taller tab) teleported it from
 *    under the trigger to above it;
 *  • a panel taller than the viewport just overflowed off-screen with no way
 *    to reach the bottom of it.
 * Both have the same root cause: the content was free to grow past the space it
 * had. So `PopoverContent` now CLAMPS itself to Radix's measured available
 * height (`--radix-popover-content-available-height`, minus collision padding)
 * and lays out as a flex column. A panel that can never outgrow its space never
 * needs to flip, and `PopoverBody` scrolls whatever doesn't fit.
 *
 * `updatePositionStrategy="always"` keeps the anchor tracked with rAF instead of
 * measuring once on open — that's what fixes panels landing far from their
 * trigger after a browser zoom / layout shift while they were mounted.
 *
 * Compose the three slots when a panel has chrome that must stay put:
 *   <PopoverContent className="w-80 p-0">
 *     <PopoverHeader>…</PopoverHeader>
 *     <PopoverBody>…</PopoverBody>
 *     <PopoverFooter>…</PopoverFooter>
 *   </PopoverContent>
 * A simple popover can ignore them and just pass children (it still clamps).
 */

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

/** Breathing room kept between a popover and every viewport edge. */
const COLLISION_PADDING = 10;

const isPickUi = (t: EventTarget | null) => t instanceof Element && !!t.closest("[data-pick-ui]");

function PopoverContent({
  className,
  align = "center",
  side,
  sideOffset = 4,
  collisionPadding = COLLISION_PADDING,
  onPointerDown,
  onContextMenu,
  onFocusOutside,
  onInteractOutside,
  style,
  ref,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {

  // SIDE LOCKING. Radix re-runs collision detection on every resize, so a panel
  // that grows (a taller tab, a longer list) can flip from below its trigger to
  // above it mid-interaction — the single most disorienting thing a popover can
  // do. So: let Radix choose freely on open, then PIN that choice as the
  // preferred side. Collision detection stays on, so it still flips if the
  // panel genuinely stops fitting — but only then, never merely because it
  // could. Content is unmounted while closed, so this resets on every open.
  const [lockedSide, setLockedSide] = React.useState<typeof side>(undefined);
  const node = React.useRef<HTMLDivElement | null>(null);
  const attach = React.useCallback(
    (el: HTMLDivElement | null) => {
      node.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
      if (!el) return;
      const chosen = el.getAttribute("data-side");
      if (chosen === "top" || chosen === "bottom" || chosen === "left" || chosen === "right") {
        setLockedSide(chosen);
      }
    },
    [ref],
  );

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={attach}
        align={align}
        side={lockedSide ?? side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        // Re-measure on every frame the popover is open: a zoom change, a
        // scrolled ancestor or a resized panel would otherwise leave it pinned
        // to where the trigger USED to be.
        updatePositionStrategy="always"
        // Keep it glued to the trigger's axis while that trigger scrolls, and
        // drop it entirely once the trigger leaves the viewport.
        sticky="partial"
        hideWhenDetached
        // Radix portals this content to document.body, but React still bubbles
        // the synthetic event through the REACT tree — so a pointerdown or a
        // right-click inside an open popover reaches bubble-phase handlers on
        // whatever ancestor it is rendered under (the timeline ruler's scrub,
        // the stage's context menu) and misfires as if it landed there. Stopped
        // here, once, for every popover in the app — see lib/portal-events.
        {...withFloatingLayerEvents({ onPointerDown, onContextMenu })}
        // PICK MODE's own UI (its chip, the value menu it opens) is app chrome
        // ABOVE every popover, never "outside" one: a field in a popover arms
        // the mode, the mode's menu takes focus, and the popover holding the
        // field must still be there to receive the pick.
        onFocusOutside={(e) => (isPickUi(e.target) ? e.preventDefault() : onFocusOutside?.(e))}
        onInteractOutside={(e) => (isPickUi(e.target) ? e.preventDefault() : onInteractOutside?.(e))}
        style={{
          // The height the panel is allowed to occupy. Radix measures this per
          // side; subtracting nothing here is deliberate — collisionPadding is
          // already baked into the value it reports.
          maxHeight: "var(--radix-popover-content-available-height)",
          maxWidth: "var(--radix-popover-content-available-width)",
          ...style,
        }}
        className={cn(
          "z-50 flex w-72 flex-col overflow-hidden material-popover outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          // Default padding stays for the many simple popovers; panels that
          // manage their own chrome pass `p-0`.
          "p-3",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

/** Fixed chrome pinned above the scrolling body. */
function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("shrink-0 border-b border-line", className)} {...props} />;
}

/** The scrolling region — takes whatever height is left after header/footer. */
function PopoverBody({ className, children, ...props }: React.ComponentProps<typeof ScrollArea>) {
  return (
    <ScrollArea className={cn("min-h-0 flex-1", className)} {...props}>
      {children}
    </ScrollArea>
  );
}

/** Fixed chrome pinned below the scrolling body. */
function PopoverFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("shrink-0 border-t border-line", className)} {...props} />;
}

export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
  PopoverHeader,
  PopoverBody,
  PopoverFooter,
};
