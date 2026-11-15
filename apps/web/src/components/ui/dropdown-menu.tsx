"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { withFloatingLayerEvents } from "@/lib/portal-events";
import { Kbd } from "@/components/ui/kbd";
import { MENU_EDGE_PADDING, MENU_SEPARATOR, MENU_SURFACE, MenuScroll } from "@/components/ui/menu-kit";

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuSub = DropdownMenuPrimitive.Sub;

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & { inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-part="menu-item"
      className={cn(
        "group/mi flex cursor-default select-none items-center gap-2 min-h-(--control-h) px-2 py-1 text-body outline-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        inset && "pl-8",
        className,
      )}
      {...props}
    >
      {/* The label gets its own flex slot, so a right-aligned hint inside it
          (a shortcut, a current value) sits against the chevron instead of
          splitting the free space with it. */}
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      <ChevronRight className="ml-1" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  children,
  style,
  collisionPadding = MENU_EDGE_PADDING,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    // PORTALLED, like the top-level content beside it. Rendered in place, a
    // submenu is a DOM child of a content box that has `overflow-hidden` — so
    // instead of opening beside its trigger it was clipped to the parent menu
    // and appeared to open on top of it. Every other menu primitive in this
    // folder already portals both levels; this one only portalled the first.
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        collisionPadding={collisionPadding}
        style={{ maxHeight: "var(--radix-dropdown-menu-content-available-height)", ...style }}
        data-part="menu"
        className={cn(MENU_SURFACE, "min-w-[8rem]", className)}
        {...props}
      >
        <MenuScroll>{children}</MenuScroll>
      </DropdownMenuPrimitive.SubContent>
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuContent({
  className,
  children,
  style,
  sideOffset = 4,
  collisionPadding = MENU_EDGE_PADDING,
  onPointerDown,
  onContextMenu,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        style={{ maxHeight: "var(--radix-dropdown-menu-content-available-height)", ...style }}
        data-part="menu"
        className={cn(MENU_SURFACE, "min-w-[10rem]", className)}
        {...props}
        // Same React-portal bubbling gotcha as every other floating surface:
        // portalled to document.body, still bubbling through the REACT tree.
        {...withFloatingLayerEvents({ onPointerDown, onContextMenu })}
      >
        <MenuScroll>{children}</MenuScroll>
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  onPointerDown,
  onPointerUp,
  onClick,
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & { inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.Item
      data-part="menu-item"
      className={cn(
        "group/mi relative flex cursor-default select-none items-center gap-2 min-h-(--control-h) px-2 py-1 text-body outline-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        inset && "pl-8",
        className,
      )}
      {...props}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onClick={onClick}
    />
  );
}

function DropdownMenuCheckboxItem({
  onPointerDown,
  onPointerUp,
  onClick,
  className,
  children,
  checked,
  icon,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem> & {
  /** Leading glyph shown in the check gutter while UNCHECKED, so a menu can
   *  give every row an icon and still read as one column. */
  icon?: React.ReactNode;
}) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-part="menu-item"
      className={cn(
        "group/mi relative flex cursor-default select-none items-center min-h-(--control-h) py-1 pl-8 pr-2 text-body outline-none",
        className,
      )}
      checked={checked}
      {...props}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onClick={onClick}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center [&_svg]:size-4 [&_svg]:shrink-0">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </DropdownMenuPrimitive.ItemIndicator>
        {!checked && icon}
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

/**
 * A PICK-ONE group inside a menu. The checkbox item existed and the radio one
 * did not, so every "one of these" menu in the app either faked it with two
 * checkboxes (wrong semantics — a screen reader is told both can be on) or
 * hand-rolled its own list of buttons in a popover. Radix ships it; the gap
 * was ours.
 */
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

function DropdownMenuRadioItem({
  onPointerDown,
  onPointerUp,
  onClick,
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-part="menu-item"
      className={cn(
        "group/mi relative flex cursor-default select-none items-center min-h-(--control-h) py-1 pl-8 pr-2 text-body outline-none",
        className,
      )}
      {...props}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onClick={onClick}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & { inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn("px-2 pb-1 pt-2 text-meta font-medium text-fg-muted", inset && "pl-8", className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator data-part="menu-separator" className={cn(MENU_SEPARATOR, className)} {...props} />;
}

function DropdownMenuShortcut(props: React.ComponentProps<"span">) {
  // One visual for every key hint in the app — see components/ui/kbd.
  return <Kbd {...props} />;
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
};
