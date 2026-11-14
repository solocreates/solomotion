"use client";

import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { withFloatingLayerEvents } from "@/lib/portal-events";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";

const ContextMenu = ContextMenuPrimitive.Root;

/*
 * The trigger is the primitive's plus ONE rule: the NEAREST menu wins.
 *
 * Context menus nest in this app — a keyframe diamond inside a section that
 * offers Copy/Paste properties, a clip inside the timeline's lanes menu, an
 * effect card inside a stack. Radix binds its handler to the trigger's own
 * element, so without this a `contextmenu` on the inner trigger opened the
 * inner menu and then bubbled to every ancestor trigger, and the outermost one
 * — mounted last, positioned last — is what you actually saw. Right-clicking
 * the ◆ beside any property therefore offered "Copy transform / Paste
 * transform" and there was no way anywhere in the app to reach the keyframe
 * verbs from the control they belong to.
 *
 * Stopping propagation is the same arbitration CSS uses and that this app's
 * gesture layer already uses for `data-gesture` and `touch-action`: the
 * declaration closest to the event decides. Radix's own handler still runs —
 * it is on the same element, and Slot composes the child's handler FIRST — so
 * the inner menu opens exactly as before; only the ancestors stand down.
 *
 * Capture-phase listeners are deliberately unaffected. The timeline chooses
 * which CONTENT its one lanes menu shows from `onContextMenuCapture`, which
 * runs before any of this.
 *
 * The app's ONE long-press recognizer produces a real `contextmenu`, which this
 * listens for already, and it silences the primitive's private touch timer
 * itself — see `cancelNativeLongPress`. An earlier version wrapped this to
 * `preventDefault` on touch pointerdown, which switched the private timer off
 * and took the browser's compatibility mouse burst with it, so tapping empty
 * space stopped deselecting. Do not reach for that again.
 */
function ContextMenuTrigger({
  onContextMenu,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return (
    <ContextMenuPrimitive.Trigger
      onContextMenu={(event) => {
        onContextMenu?.(event);
        event.stopPropagation();
      }}
      {...props}
    />
  );
}

const ContextMenuGroup = ContextMenuPrimitive.Group;
const ContextMenuSub = ContextMenuPrimitive.Sub;

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & { inset?: boolean }) {
  return (
    <ContextMenuPrimitive.SubTrigger
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
    </ContextMenuPrimitive.SubTrigger>
  );
}

/*
 * EDGES. A menu is never taller than the screen: it clamps to the height Radix
 * measured it has (`--radix-context-menu-content-available-height`, collision
 * padding already taken off) and scrolls inside the app's own ScrollArea. It
 * used to grow past the bottom of the window with its last items — Lock,
 * Hide, Delete, the ones you reach for most — out of reach entirely.
 *
 * Items keep keyboard reach: focusing one scrolls the viewport to it, because
 * the viewport is an ordinary overflow box.
 */
const MENU_EDGE_PADDING = 8;
const MENU_SURFACE =
  "group/menu [&:has([role=menuitemcheckbox])_[role=menuitem]:not(:has(>svg:first-child))]:pl-8 [&:has([role=menuitemradio])_[role=menuitem]:not(:has(>svg:first-child))]:pl-8 z-50 flex flex-col overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95";
const MENU_MAX_HEIGHT = { maxHeight: "var(--radix-context-menu-content-available-height)" } as const;

function MenuScroll({ children }: { children: React.ReactNode }) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="p-1">{children}</div>
    </ScrollArea>
  );
}

function ContextMenuSubContent({
  className,
  children,
  style,
  collisionPadding = MENU_EDGE_PADDING,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        collisionPadding={collisionPadding}
        style={{ ...MENU_MAX_HEIGHT, ...style }}
        data-part="menu"
        className={cn(MENU_SURFACE, "min-w-[8rem]", className)}
        {...props}
      >
        <MenuScroll>{children}</MenuScroll>
      </ContextMenuPrimitive.SubContent>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuContent({
  className,
  children,
  style,
  collisionPadding = MENU_EDGE_PADDING,
  onPointerDown,
  onContextMenu,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        collisionPadding={collisionPadding}
        style={{ ...MENU_MAX_HEIGHT, ...style }}
        data-part="menu"
        className={cn(MENU_SURFACE, "min-w-[11rem]", className)}
        {...props}
        // Same React-portal bubbling gotcha as every other floating surface:
        // portalled to document.body, still bubbling through the REACT tree.
        {...withFloatingLayerEvents({ onPointerDown, onContextMenu })}
      >
        <MenuScroll>{children}</MenuScroll>
      </ContextMenuPrimitive.Content>
    </ContextMenuPrimitive.Portal>
  );
}

/** How long the pointer rests on a split item before its extras open — long
 *  enough that reaching for the click never flashes the submenu at you. */
const SPLIT_HOLD_MS = 320;

/**
 * A SPLIT ITEM — one row that is both a verb and a submenu. CLICK does the
 * common thing (Copy copies the layer); RESTING on it, or → / Enter from the
 * keyboard, opens the less common variants (Copy properties…). It is how a
 * menu keeps "Properties ▸" from being a row of its own without hiding it.
 *
 * Radix has no such item, so this is a controlled `Sub` whose trigger runs the
 * action on click and then closes the menu the one way Radix exposes to the
 * outside — an Escape, which every menu level answers by closing the whole
 * tree. The Escape stops at its own target so it never reaches the app's
 * shortcut layer (where Escape means "deselect").
 */
function ContextMenuSplitItem({
  onAction,
  label,
  children,
  disabled,
}: {
  /** The click — the common case. */
  onAction: () => void;
  /** The row: icon, words, shortcut hint. */
  label: React.ReactNode;
  /** The variants, as ordinary menu items. */
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const hovering = React.useRef(false);
  const timer = React.useRef<number | null>(null);
  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  React.useEffect(() => cancel, []);
  const onOpenChange = (next: boolean) => {
    if (!next) {
      cancel();
      setOpen(false);
      return;
    }
    // Keyboard asks once and means it; the pointer asks on every move, so only
    // the first ask starts the hold.
    if (!hovering.current) return setOpen(true);
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setOpen(true);
    }, SPLIT_HOLD_MS);
  };
  return (
    <ContextMenuSub open={open} onOpenChange={onOpenChange}>
      <ContextMenuSubTrigger
        disabled={disabled}
        onPointerEnter={() => (hovering.current = true)}
        onPointerLeave={() => {
          hovering.current = false;
          cancel();
        }}
        onClick={(e) => {
          e.preventDefault();
          cancel();
          onAction();
          closeMenuFrom(e.currentTarget);
        }}
      >
        {label}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>{children}</ContextMenuSubContent>
    </ContextMenuSub>
  );
}

function closeMenuFrom(el: HTMLElement): void {
  el.addEventListener("keydown", (e) => e.stopPropagation(), { once: true });
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

function ContextMenuItem({
  onPointerDown,
  onPointerUp,
  onClick,
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & { inset?: boolean }) {
  return (
    <ContextMenuPrimitive.Item
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

function ContextMenuCheckboxItem({
  onPointerDown,
  onPointerUp,
  onClick,
  className,
  children,
  checked,
  icon,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem> & {
  /** Leading glyph shown in the check gutter while UNCHECKED, so a menu can
   *  give every row an icon and still read as one column. */
  icon?: React.ReactNode;
}) {
  return (
    <ContextMenuPrimitive.CheckboxItem
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
        <ContextMenuPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </ContextMenuPrimitive.ItemIndicator>
        {!checked && icon}
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  );
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & { inset?: boolean }) {
  return (
    <ContextMenuPrimitive.Label
      className={cn("px-2 pb-1 pt-2 text-meta font-medium text-fg-muted", inset && "pl-8", className)}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return <ContextMenuPrimitive.Separator data-part="menu-separator" className={cn("-mx-1 my-1 h-px", className)} {...props} />;
}

function ContextMenuShortcut(props: React.ComponentProps<"span">) {
  // One visual for every key hint in the app — see components/ui/kbd.
  return <Kbd {...props} />;
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuSplitItem,
};
