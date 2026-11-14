"use client";

import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useTypeToFocus } from "@/editor/input/use-type-to-focus";
import { ScrollArea } from "@/components/ui/scroll-area";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md text-popover-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** ⌘K-style overlay: a Command inside a chrome-less dialog. */
function CommandDialog({
  title = "Command palette",
  children,
  commandProps,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  /** Passed to the inner Command — `shouldFilter: false` for a dialog that ranks its own results. */
  commandProps?: Omit<React.ComponentProps<typeof Command>, "children" | "className">;
}) {
  return (
    <Dialog {...props}>
      <DialogContent className="overflow-hidden p-0" showCloseButton={false}>
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <Command {...commandProps} className="[&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-1.5 [&_[cmdk-input]]:h-11 [&_[cmdk-input]]:text-title [&_[cmdk-item]]:min-h-(--control-h-lg)">
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
  autoFocus = true,
  ref,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  /*
   * EVERY PICKER IN THE APP IS A COMMAND INPUT, so the keyboard policy belongs
   * here and not at seventeen call sites.
   *
   * `autoFocus` used to be handed to the field, which is right on a desktop
   * and wrong on a tablet: opening the effect menu, the node menu or a preset
   * picker raised the on-screen keyboard over the list you had opened it to
   * look at. `useTypeToFocus` keeps the desktop behaviour exactly and, where a
   * soft keyboard would appear, focuses on the first printable keystroke
   * instead — so typing still searches from its first letter and the list is
   * visible until you actually want to.
   *
   * A picker that genuinely wants the caret up front passes `autoFocus={false}`
   * and focuses the field itself; nothing does today.
   */
  const inner = React.useRef<HTMLInputElement>(null);
  useTypeToFocus(inner, autoFocus);
  return (
    <div className="flex items-center border-b border-line px-3" cmdk-input-wrapper="">
      <Search className="mr-2 size-4 shrink-0 text-fg-faint" />
      <CommandPrimitive.Input
        ref={(el) => {
          inner.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        className={cn(
          "flex h-(--control-h-lg) w-full bg-transparent text-body outline-none placeholder:text-fg-faint disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    // The ScrollArea owns the height, so a caller's `max-h-*` lands on the
    // element that scrolls. `tm-scroll` was the wrong exception here — it is
    // for canvas-backed and virtualised scrollers, and a command list is
    // neither; it just meant every picker in the app had a native bar.
    <ScrollArea className={cn("max-h-80", className)}>
      <CommandPrimitive.List className="overflow-x-hidden" {...props} />
    </ScrollArea>
  );
}

function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className="py-6 text-center text-body text-fg-muted" {...props} />;
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        "overflow-hidden p-1 text-fg [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-meta [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-muted",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator data-part="menu-separator" className={cn("-mx-1 h-px", className)} {...props} />;
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-part="menu-item"
      className={cn(
        "group/mi relative flex min-h-(--control-h) cursor-default select-none items-center gap-2 px-2 py-1 text-body outline-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("ml-auto shrink-0 pl-6 text-meta tabular-nums text-fg-faint", className)}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
