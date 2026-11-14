"use client";

import * as React from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useIsCompact } from "../state/use-shell-density";
import { beginEditorDrag, useDraggingEditor, useListPreview } from "../workspace/drag";
import { RegionMenuItems } from "../workspace/RegionMenu";
import { editorMeta, type EditorId } from "../workspace/editor-registry";
import { useFlip } from "../workspace/use-flip";
import { editorIcon } from "./panel-registry";

/**
 * THE RAIL — one component behind all three edges of the workspace.
 *
 * Left, right and bottom had grown three separate implementations of the same
 * object, and they disagreed about everything that matters: whether the
 * container's collapse control was an icon square or a labelled button, whether
 * a surface showed its name, what "armed" looked like, and whether the rail
 * survived collapsing the thing it controlled. Three near-misses of one idea is
 * the bug; this is the deletion of two of them.
 *
 * The grammar every edge now shares:
 *
 *   [ surface ] [ surface ] …
 *
 * There is no separate collapse toggle. Clicking the surface you are already on
 * closes the panel; clicking another switches to it and opens the panel if it
 * was closed. One control, two jobs — a toggle sitting beside the surfaces was
 * a second way to say the same thing, and it had to invent its own armed
 * polarity to look different from them.
 *
 * The rail still lives OUTSIDE its panel: a control that hides a panel cannot
 * be inside the panel it hides, or collapsing it takes away the only way back.
 *
 * Horizontal rails put the label beside the icon. Vertical rails STACK it
 * underneath — icon, then word, both reading left to right. Rotated text was
 * the previous answer and it is not one: you cannot scan a column of sideways
 * words, and every glance costs a head tilt. Widening the rail enough to hold a
 * short word is the cheaper trade.
 *
 * A rail SCROLLS its items and pins its header and footer. It used to be one
 * flex column with a `flex-1` spacer, which is sized by subtraction — so in a
 * short window (a phone in landscape, a half-height desktop window) the items
 * and the footer squeezed each other until both were unreadable and neither
 * could be reached. Header and footer are fixed ends; the middle is the part
 * that gives.
 *
 * A DOCK RAIL (`dock`) is also a drop list — the vertical presentation of the
 * same ordered editor list a region's tab strip draws horizontally. Drag any
 * editor onto it and it appears HERE, as a live armed badge at the slot the
 * solver picked, with the other items parting around it (FLIP); drop and the
 * badge simply stays. Sorting a rail is the same gesture on its own items.
 */

export type RailSide = "left" | "right" | "bottom";

export interface RailItem {
  key: string;
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Tooltip line — what the surface IS, not what the button does. */
  hint?: string;
  active: boolean;
  onClick: () => void;
  /** Right-click → "Open in window". Optional: not every surface can float. */
  onPopOut?: () => void;
  /**
   * The EDITOR this item shows. Present → the item can be dragged to any
   * dock target (hold-to-lift on touch, so a finger still scrolls the rail)
   * and its right-click is the full region menu.
   */
  editor?: EditorId;
  /** The region that holds `editor` — what a drop beside this item joins. */
  region?: string;
}

export function Rail({
  side,
  variant = "labeled",
  items,
  header,
  footer,
  className,
  dock = false,
}: {
  side: RailSide;
  /**
   * This rail is the window edge's DROP LIST (`rail:<side>`). The side rails
   * are their own band; the bottom bar wraps its rail in a wider band.
   */
  dock?: boolean;
  /**
   * `labeled` stacks the word under the icon and needs a wider rail — right for
   * the left rail, whose surfaces (Library, Media, Layers) are nouns you pick
   * between.
   *
   * `compact` ROTATES the label alongside the icon, Blender-style. The right
   * rail sits against the property panel, so every pixel of width it takes is
   * one the panel loses — rotating buys a readable label for ~10px instead of
   * the ~56px a horizontal word costs. Icons alone were tried and are worse:
   * they make you learn a pictogram per surface.
   */
  variant?: "labeled" | "compact";
  /** Pinned to the rail's start — the mark on the left, Export on the right. */
  header?: React.ReactNode;
  /** Pinned to the rail's end — settings. Separated from `items` by the flex
   *  spacer so it sits at the bottom of a full-height rail. */
  footer?: React.ReactNode;
  /** What the toggle collapses — "Panels", "Properties", "Timeline". */
  items: Array<RailItem | "separator">;
  className?: string;
}) {
  const horizontal = side === "bottom";
  const compactShell = useIsCompact();
  // A narrow window forces the rotated label on BOTH side rails: 64 + 44px of
  // rail out of a 375px window is a third of the app spent on chrome. The
  // decision belongs here rather than at each call site, so neither rail can
  // forget it — and so `variant` keeps meaning "how much room does this rail
  // deserve", not "what size is the window".
  const rotated = !horizontal && (variant === "compact" || compactShell);

  const listId = dock ? `rail:${side}` : undefined;
  const preview = useListPreview(listId);
  const dragging = useDraggingEditor();
  const scroller = React.useRef<HTMLDivElement>(null);
  useFlip(scroller);

  // THE LIVE BADGE. Items in the list AS IT WILL BE: the dragged editor's own
  // items collapse (the badge IS it), and the badge sits before block `slot`
  // — a block being one editor's run of items (Properties contributes its tabs).
  const shown: Array<RailItem | "separator" | "badge"> = [];
  let block = -1;
  let prevEditor: EditorId | undefined;
  for (const item of items) {
    if (item !== "separator" && preview && item.editor === preview.editor) continue;
    if (item !== "separator" && item.editor && item.editor !== prevEditor) {
      block++;
      prevEditor = item.editor;
      if (preview && block === preview.slot) shown.push("badge");
    }
    shown.push(item);
  }
  if (preview && block < preview.slot) shown.push("badge");

  return (
    <div
      role="tablist"
      data-rail={side}
      {...(dock && side !== "bottom" ? { "data-dock-band": listId, "data-dock-kind": "rail", "data-dock-edge": side } : {})}
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      className={cn(
        // No surface of its own: a rail stands on the app's ground, so
        // collapsing a panel doesn't just swap one filled band for another.
        "flex items-center gap-1 bg-background",
        // A vertical rail runs the FULL height of the window. Stopping it short
        // left a dark L in every corner of the app — the top bar owned the top
        // strip, the status bar the bottom, and the rail only the middle.
        horizontal
          // `min-w-0` so the items region's scroller can actually engage: a
          // flex child refuses to shrink below its content by default, so
          // without it a rail wider than the window pushes the bar's own
          // layout out instead of scrolling inside itself.
          ? "h-9 min-w-0 max-w-full flex-row px-1.5"
          : rotated
            // 44px, compact shell or not. A narrow window is the LAST place to
            // spend width on chrome: two rails already cost 88 of 375, and the
            // rotated button is ~56px TALL, which is the dimension a thumb
            // actually needs here. Growing the rail for "touch targets" made
            // the app smaller everywhere it mattered to buy nothing.
            ? "w-11 shrink-0 flex-col py-1"
            : "w-16 shrink-0 flex-col py-1.5",
        className,
      )}
    >
      {header}
      {header && (
        <span
          aria-hidden
          className={cn("shrink-0 bg-border", horizontal ? "mx-0.5 h-4 w-px" : "my-1.5 h-px w-5")}
        />
      )}

      {/*
        THE SCROLLING MIDDLE. Header and footer are fixed ends and the items
        give — the opposite of the `flex-1` spacer this replaced, which sized
        the ends by subtraction and so let a short window squeeze the settings
        button and the surface list into each other until neither was usable.
        A rail with more surfaces than height must scroll, not shrink.

        No visible scrollbar: this is chrome a few pixels wide, and a track down
        the middle of it reads as damage. `RAIL_SCROLL` hides it in both
        engines.
      */}
      <div
        ref={scroller}
        data-dock-list={listId}
        data-dock-axis={horizontal ? "x" : "y"}
        className={cn(
          "flex min-h-0 min-w-0 items-center gap-1",
          // `flex-1` on BOTH axes: the middle is the part that gives, so the
          // pinned ends land on the rail's ends. Content-sized, a horizontal
          // rail's footer sat wherever the item list happened to stop.
          horizontal ? "max-w-full flex-1 flex-row overflow-x-auto" : "flex-1 flex-col overflow-y-auto",
          RAIL_SCROLL,
        )}
      >
        {shown.map((item, i) =>
          item === "badge" ? (
            <RailButton
              key="badge"
              badge
              horizontal={horizontal}
              compact={rotated}
              touch={compactShell}
              icon={editorIcon(preview!.editor)}
              name={editorMeta(preview!.editor)?.name ?? ""}
              hint=""
              side={side}
              active
              onClick={() => {}}
            />
          ) : item === "separator" ? (
            <span
              key={`sep-${i}`}
              aria-hidden
              className={cn("shrink-0 bg-border", horizontal ? "mx-1 h-4 w-px" : "my-1 h-px w-5")}
            />
          ) : (
            <RailButton
              key={item.key}
              region={item.region}
              lifted={!!dragging && dragging === item.editor}
              horizontal={horizontal}
              compact={rotated}
              touch={compactShell}
              icon={item.icon}
              name={item.name}
              hint={item.hint ?? item.name}
              side={side}
              active={item.active}
              onClick={item.onClick}
              onPopOut={item.onPopOut}
              editor={item.editor}
            />
          ),
        )}
      </div>

      {footer}
    </div>
  );
}

/** Scroll without a scrollbar — Firefox, then WebKit/Blink. */
const RAIL_SCROLL = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

function RailButton({
  horizontal,
  compact,
  touch,
  icon: Icon,
  name,
  hint,
  side,
  active,
  onClick,
  onPopOut,
  editor,
  region,
  lifted,
  badge,
}: {
  horizontal: boolean;
  region?: string;
  /** Its editor is being dragged elsewhere: shown, but quiet. */
  lifted?: boolean;
  /** The drop badge: drawn like an armed item, inert, no tooltip or menu. */
  badge?: boolean;
  compact?: boolean;
  /**
   * Narrow shell → a little more finger room, WITHIN the rail's width. The
   * vertical buttons are already ~56px tall, so the target has the area a
   * thumb needs; only the horizontal bottom rail is genuinely short, and that
   * bar has the height to spare.
   */
  touch?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  name: string;
  hint: string;
  side: RailSide;
  active: boolean;
  onClick: () => void;
  onPopOut?: () => void;
  editor?: EditorId;
}) {
  // THE ACTIVE ITEM STAYS IN VIEW. A rail that scrolls can hide the surface
  // you are on; arming one from a shortcut or the palette scrolls it in.
  const ref = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    // By hand, not `scrollIntoView`: that scrolls EVERY ancestor, including
    // the overflow-hidden shell, and would nudge the whole app.
    const el = ref.current;
    const sc = el?.parentElement;
    if (!active || !el || !sc) return;
    const a = el.getBoundingClientRect();
    const b = sc.getBoundingClientRect();
    if (a.top < b.top) sc.scrollTop -= b.top - a.top;
    else if (a.bottom > b.bottom) sc.scrollTop += a.bottom - b.bottom;
    if (a.left < b.left) sc.scrollLeft -= b.left - a.left;
    else if (a.right > b.right) sc.scrollLeft += a.right - b.right;
  }, [active]);
  const hasMenu = !!onPopOut || !!editor;
  const btn = (
        <button
          type="button"
          role="tab"
          aria-selected={active}
          aria-label={name}
          aria-hidden={badge || undefined}
          tabIndex={badge ? -1 : undefined}
          ref={ref}
          onClick={onClick}
          onPointerDown={editor ? (e) => beginEditorDrag(e, editor) : undefined}
          data-flip={badge ? `badge` : editor ? `${editor}:${name}` : name}
          data-dock-item={badge ? undefined : editor}
          data-dock-region={badge ? undefined : region}
          className={cn(
            badge && "pointer-events-none",
            lifted && "opacity-40",
            "flex shrink-0 items-center justify-center rounded-md transition-colors [&_svg]:size-3.5",
            horizontal
              ? cn("gap-1.5 px-2.5 text-xs", touch ? "h-9" : "h-7")
              : compact
                ? cn("flex-col gap-1.5 px-1 py-2 text-xs", touch ? "w-8" : "w-7")
                : "w-14 flex-col gap-1 px-1 py-1.5 text-3xs leading-none",
            // `touch-manipulation` kills the 300ms double-tap-zoom delay iOS
            // still applies to buttons — without it every rail tap on a phone
            // feels a third of a second behind the finger.
            touch && "touch-manipulation",
            // The app's ONE armed state, shared with the stage's armed tool and
            // the selected shadcn tab: a raised pane of glass, accent on the
            // label. Follows the theme's glass switch for free.
            active
              ? "material-glass-raised text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <Icon />
          {/* THE DOCK NAMES ONLY WHERE YOU ARE. Twelve labelled surfaces is
              nine hundred pixels of scroller inside a 375px window, so eleven
              of the twelve words are off screen anyway — they cost the width
              and buy nothing. Naming the armed one keeps the sentence the bar
              is actually saying ("you are in Layers") and lets the rest fit as
              icons, which is the tab bar every phone already taught. A word
              only ever appears for the surface you are on, so nothing shifts
              except the two buttons either side of the one you just tapped.

              Compact vertical = rotated, reading downward so the word starts
              directly under its icon. Labeled = a normal word under it. */}
          {(!horizontal || !touch || active) && (
            <span
              className={cn(
                !horizontal && compact && "[writing-mode:vertical-rl]",
                !horizontal && !compact && "max-w-full truncate",
              )}
            >
              {name}
            </span>
          )}
        </button>
  );
  /*
   * ORDER MATTERS: Tooltip › TooltipTrigger › ContextMenuTrigger › button.
   * The context-menu trigger used to wrap the TOOLTIP ROOT, which renders no
   * element and drops the props a trigger passes down — so right-click on a
   * rail item silently did nothing, and "Open in window" was unreachable.
   */
  if (badge) return btn;
  const withTooltip = (
    <Tooltip>
      <TooltipTrigger asChild>{hasMenu ? <ContextMenuTrigger asChild>{btn}</ContextMenuTrigger> : btn}</TooltipTrigger>
      <TooltipContent side={side === "bottom" ? "top" : side === "left" ? "right" : "left"}>
        {hint}
      </TooltipContent>
    </Tooltip>
  );
  if (!hasMenu) return withTooltip;
  return (
    <ContextMenu>
      {withTooltip}
      <ContextMenuContent>
        {editor ? <RegionMenuItems editor={editor} /> : <ContextMenuItem onClick={onPopOut}>Open in window</ContextMenuItem>}
      </ContextMenuContent>
    </ContextMenu>
  );
}
