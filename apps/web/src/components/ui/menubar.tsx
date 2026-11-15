"use client";

import * as React from "react";
import * as MenubarPrimitive from "@radix-ui/react-menubar";
import { Check, ChevronRight, Circle } from "lucide-react";
import { cn } from "@/lib/utils";
import { MENU_SEPARATOR, MENU_SURFACE } from "@/components/ui/menu-kit";
import { Kbd } from "@/components/ui/kbd";

const MenubarMenu = MenubarPrimitive.Menu;
const MenubarGroup = MenubarPrimitive.Group;
const MenubarPortal = MenubarPrimitive.Portal;
const MenubarSub = MenubarPrimitive.Sub;
const MenubarRadioGroup = MenubarPrimitive.RadioGroup;

function Menubar({ className, ...props }: React.ComponentProps<typeof MenubarPrimitive.Root>) {
  return (
    <MenubarPrimitive.Root
      className={cn("flex items-center gap-0.5", className)}
      {...props}
    />
  );
}

function MenubarTrigger({ className, ...props }: React.ComponentProps<typeof MenubarPrimitive.Trigger>) {
  return (
    <MenubarPrimitive.Trigger
      className={cn(
        "flex select-none items-center rounded px-2 py-1 text-xs font-medium text-foreground/80 outline-none transition-colors hover:bg-muted focus:bg-muted data-[state=open]:bg-muted data-[state=open]:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function MenubarSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.SubTrigger> & { inset?: boolean }) {
  return (
    <MenubarPrimitive.SubTrigger
      data-part="menu-item"
      className={cn(
        "group/mi flex cursor-default select-none items-center gap-2 min-h-(--control-h) px-2 py-1 text-body outline-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        inset && "pl-8",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto" />
    </MenubarPrimitive.SubTrigger>
  );
}

function MenubarSubContent({ className, ...props }: React.ComponentProps<typeof MenubarPrimitive.SubContent>) {
  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.SubContent
        data-part="menu"
        className={cn(
          MENU_SURFACE, "min-w-[8rem] p-1",
          className,
        )}
        {...props}
      />
    </MenubarPrimitive.Portal>
  );
}

function MenubarContent({
  className,
  align = "start",
  alignOffset = -4,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Content>) {
  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.Content
        align={align}
        alignOffset={alignOffset}
        sideOffset={sideOffset}
        data-part="menu"
        className={cn(
          MENU_SURFACE, "min-w-[12rem] p-1",
          className,
        )}
        {...props}
      />
    </MenubarPrimitive.Portal>
  );
}

function MenubarItem({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Item> & { inset?: boolean }) {
  return (
    <MenubarPrimitive.Item
      data-part="menu-item"
      className={cn(
        "group/mi relative flex cursor-default select-none items-center gap-2 min-h-(--control-h) px-2 py-1 text-body outline-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        inset && "pl-8",
        className,
      )}
      {...props}
    />
  );
}

function MenubarCheckboxItem({
  className,
  children,
  checked,
  icon,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.CheckboxItem> & {
  /** Leading glyph shown in the check gutter while UNCHECKED, so a menu can
   *  give every row an icon and still read as one column. */
  icon?: React.ReactNode;
}) {
  return (
    <MenubarPrimitive.CheckboxItem
      data-part="menu-item"
      className={cn(
        "group/mi relative flex cursor-default select-none items-center min-h-(--control-h) py-1 pl-8 pr-2 text-body outline-none",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center [&_svg]:size-4 [&_svg]:shrink-0">
        <MenubarPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </MenubarPrimitive.ItemIndicator>
        {!checked && icon}
      </span>
      {children}
    </MenubarPrimitive.CheckboxItem>
  );
}

function MenubarRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.RadioItem>) {
  return (
    <MenubarPrimitive.RadioItem
      data-part="menu-item"
      className={cn(
        "group/mi relative flex cursor-default select-none items-center min-h-(--control-h) py-1 pl-8 pr-2 text-body outline-none",
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <MenubarPrimitive.ItemIndicator>
          <Circle className="h-2 w-2 fill-current" />
        </MenubarPrimitive.ItemIndicator>
      </span>
      {children}
    </MenubarPrimitive.RadioItem>
  );
}

function MenubarLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Label> & { inset?: boolean }) {
  return (
    <MenubarPrimitive.Label
      className={cn("px-2 pb-1 pt-2 text-meta font-medium text-fg-muted", inset && "pl-8", className)}
      {...props}
    />
  );
}

function MenubarSeparator({ className, ...props }: React.ComponentProps<typeof MenubarPrimitive.Separator>) {
  return <MenubarPrimitive.Separator data-part="menu-separator" className={cn(MENU_SEPARATOR, className)} {...props} />;
}

function MenubarShortcut(props: React.ComponentProps<"span">) {
  // One visual for every key hint in the app — see components/ui/kbd.
  return <Kbd {...props} />;
}

export {
  Menubar,
  MenubarMenu,
  MenubarGroup,
  MenubarPortal,
  MenubarSub,
  MenubarRadioGroup,
  MenubarTrigger,
  MenubarContent,
  MenubarItem,
  MenubarCheckboxItem,
  MenubarRadioItem,
  MenubarLabel,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSubTrigger,
  MenubarSubContent,
};
