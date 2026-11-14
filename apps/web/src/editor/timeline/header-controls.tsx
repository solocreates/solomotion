"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCombo } from "../state/shortcut-registry";
import { useHoldMenu } from "../state/use-hold-menu";
import { ArrowLeftRight, Repeat, RotateCw } from "lucide-react";
import type { LoopMode } from "@solomotion/core";

/**
 * THE TIMELINE HEADER'S CONTROL KIT.
 *
 * The header had grown four different button shapes: a 28px icon toggle, a
 * 32px shadcn `size="sm"` button, a segmented pair at 10px type in a `rounded-lg`
 * bordered box, and bare icon buttons with no container at all. Half of them
 * were wrapped in a bordered pill and half were not, so the row read as a pile
 * of controls rather than a toolbar — a different height and a different border
 * every few pixels.
 *
 * The cause was that each control decided its own chrome. Here they do not.
 * Everything in the header is built from these four pieces, all resolving to
 * `--control-h`, so alignment is structural rather than a number that three
 * files happen to agree on today.
 *
 *   HeaderToggle   an on/off tool, optionally with a settings popover
 *   HeaderSegment  one segment of a mutually-exclusive pair (Keys | Curves)
 *   HeaderGroup    the ONE container for controls that belong together
 *   HeaderDivider  a hairline between two groups
 *
 * On the ACTIVE state: an armed toggle is tinted with the accent, but the tint
 * is a wash, not a slab. Several toggles are on at once in normal use (snap,
 * linked selection, markers) and at 15% fill they became a row of solid violet
 * blocks that read as errors. The mark is now carried mostly by the ICON.
 */

/** Shared geometry: one height, one radius, one icon size, for every control. */
const CONTROL =
  "inline-flex h-(--control-h) shrink-0 items-center justify-center rounded-md " +
  "text-xs font-medium transition-colors outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 " +
  "[&_svg]:size-3.5 [&_svg]:shrink-0";

/** Off / hover / on. `on` is a wash plus a coloured icon, never a filled slab. */
const STATE = {
  off: "text-muted-foreground hover:bg-accent hover:text-foreground",
  on: "bg-primary/10 text-primary hover:bg-primary/15",
} as const;

export function HeaderDivider() {
  return <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />;
}

/**
 * The one container for controls that act as a unit. It is a recessed tray, not
 * an outlined box — a border around a group of borderless buttons was most of
 * what made the old header look boxy.
 */
export function HeaderGroup({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-(--control-h) shrink-0 items-center gap-px rounded-lg bg-muted p-px", className)}>
      {children}
    </div>
  );
}

/**
 * One segment of a mutually-exclusive group. Sits INSIDE a HeaderGroup and
 * fills its height, so a segmented pair is exactly as tall as the icon toggle
 * beside it — the specific thing that made Keys/Curves look bolted on.
 */
export function HeaderSegment({
  active,
  icon,
  label,
  onClick,
  title,
}: {
  active: boolean;
  icon?: React.ReactNode;
  label: string;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        CONTROL,
        "h-full gap-1.5 px-2",
        active ? "bg-background text-foreground shadow-elevation-1" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * An icon toggle, optionally owning a settings popover on hold / right-click —
 * the one shape behind every timeline tool with per-tool options (snapping,
 * markers). Click always flips the toggle; hold or right-click opens `popover`
 * instead of following through, so a tool with settings never fights a tool
 * without them for the same gesture.
 */
export function HeaderToggle({
  icon,
  pressed,
  onToggle,
  ariaLabel,
  tooltip,
  combo,
  popover,
  popoverWidth = "w-56",
}: {
  icon: React.ReactNode;
  pressed: boolean;
  onToggle: () => void;
  ariaLabel: string;
  tooltip: string;
  combo?: string;
  popover?: React.ReactNode;
  popoverWidth?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const hold = useHoldMenu(() => popover && setOpen(true));

  const button = (
    <button
      type="button"
      aria-label={popover ? `${ariaLabel} — hold or right-click for settings` : ariaLabel}
      aria-pressed={pressed}
      {...(popover ? hold.bind : {})}
      onClick={(e) => {
        e.preventDefault();
        if (popover && hold.guard()) return; // a hold opened settings — skip the toggle
        onToggle();
      }}
      className={cn(CONTROL, "w-(--control-h)", pressed ? STATE.on : STATE.off)}
    >
      {icon}
    </button>
  );

  const tip = (
    <TooltipContent className="flex items-center gap-1.5">
      {tooltip}
      {combo && <span className="font-mono text-2xs opacity-70">{formatCombo(combo)}</span>}
      {popover && <span className="text-muted-foreground/70">· right-click for settings</span>}
    </TooltipContent>
  );

  if (!popover) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        {tip}
      </Tooltip>
    );
  }

  // Anchor the settings popover to the BUTTON itself. Wrapping a Tooltip Root
  // (not a DOM node) in PopoverTrigger left the popover with no real anchor, so
  // right-click "opened" it into nowhere — chaining the asChild slots straight
  // onto the button is what makes the settings appear in place.
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <PopoverAnchor asChild>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
        </PopoverAnchor>
        {tip}
      </Tooltip>
      <PopoverContent className={cn(popoverWidth, "space-y-2 p-3")} align="start" sideOffset={6}>
        {popover}
      </PopoverContent>
    </Popover>
  );
}

/** A plain icon ACTION (no on/off state) at the header's one height. */
export function HeaderAction({
  icon,
  onClick,
  ariaLabel,
  tooltip,
  combo,
  disabled,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  ariaLabel: string;
  tooltip: string;
  combo?: string;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          disabled={disabled}
          onClick={onClick}
          className={cn(CONTROL, "w-(--control-h)", STATE.off)}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-1.5">
        {tooltip}
        {combo && <span className="font-mono text-2xs opacity-70">{formatCombo(combo)}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/** Play once → loop → ping-pong, in that order. */
const LOOP_ORDER: LoopMode[] = ["none", "loop", "pingpong"];
export const LOOP_LABEL: Record<LoopMode, string> = {
  none: "Play once",
  loop: "Loop",
  pingpong: "Ping-pong",
};
const LOOP_ICON: Record<LoopMode, typeof Repeat> = {
  none: RotateCw,
  loop: Repeat,
  pingpong: ArrowLeftRight,
};

/**
 * LOOP MODE — one control, wherever a thing loops.
 *
 * There were three: the timeline's frame loop, the flipbook's sheet loop and
 * the flipbook row's, each with its own icon set, its own armed styling and its
 * own click-to-cycle. They disagreed on the most basic thing — what "play once"
 * looks like — so the same concept read as three different features. Only the
 * WRITER differs between them, and that is the one thing a prop can carry.
 *
 * Armed state is the app's one armed state: the accent on the glyph, never a
 * filled slab.
 */
export function LoopToggle({
  mode,
  onChange,
  label = "Loop",
  className,
}: {
  mode: LoopMode;
  onChange: (next: LoopMode) => void;
  /** What loops — "Flipbook", "Row", "Frame". Shown in the tooltip. */
  label?: string;
  className?: string;
}) {
  const next = LOOP_ORDER[(LOOP_ORDER.indexOf(mode) + 1) % LOOP_ORDER.length]!;
  const Icon = LOOP_ICON[mode];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${label} loop: ${LOOP_LABEL[mode]}`}
          onClick={() => onChange(next)}
          className={cn(
            "flex size-(--control-h) shrink-0 items-center justify-center rounded-md transition-colors [&_svg]:size-3.5",
            mode === "none"
              ? "text-muted-foreground hover:bg-accent hover:text-foreground"
              : "material-glass-raised text-primary",
            className,
          )}
        >
          <Icon />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {label}: {LOOP_LABEL[mode]} — click for {LOOP_LABEL[next]}
      </TooltipContent>
    </Tooltip>
  );
}
