"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { withFloatingLayerEvents } from "@/lib/portal-events";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-black/55 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { showCloseButton?: boolean }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          // `calc(100% - 1.5rem)` rather than `w-full`: a dialog pinned edge to
          // edge on a phone reads as a broken page rather than a layer over
          // one.
          //
          // The padding is ONE class — `clamp`, not `p-4 sm:p-6`. A responsive
          // pair here is two different tailwind-merge groups, so a caller's
          // `p-0` removes the base and leaves the `sm:` half standing: the New
          // Project dialog asked for no padding, got 24px of it on every screen
          // above 640px, and nothing at its call site could have said otherwise.
          // A default a caller cannot fully override is not a default.
          // `grid-cols-[minmax(0,1fr)]` is load-bearing. A grid item's default
          // `min-width: auto` refuses to shrink below its CONTENT's minimum, so
          // one unshrinkable child — a six-tab strip, a wide table — stretched
          // the column past the dialog's own width and everything inside spilled
          // out the right edge while the panel itself looked correctly sized.
          // The track now says it may go to zero, and the children that scroll
          // get to scroll.
          "fixed left-[50%] top-[50%] z-50 grid grid-cols-[minmax(0,1fr)] w-[calc(100%-1.5rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border border-line bg-popover p-[clamp(1rem,4vw,1.5rem)] text-popover-foreground shadow-elevation-3 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          className,
        )}
        {...props}
        // A dialog is a floating layer: its right-clicks and pointerdowns
        // belong to it, never to whatever rendered it (see lib/portal-events).
        {...withFloatingLayerEvents({ onPointerDown: props.onPointerDown, onContextMenu: props.onContextMenu })}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close className="absolute right-3 top-3 flex size-(--control-h) items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg focus:outline-none disabled:pointer-events-none">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1 text-left", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-heading", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("text-body text-fg-muted", className)} {...props} />;
}

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
