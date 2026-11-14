"use client";

import * as React from "react";
import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SCROLL_SURFACE } from "../input/use-multi-touch";
import { CHROME_CAPSULE, useChromeAxis, useChromeFlyoutSide } from "./StageChrome";

/**
 * THE TOOL BAR KIT — every shape an option in the stage's top bar is made of.
 *
 * One grammar, and it is the same one for a brush, a star, a pen and a
 * paragraph of type. Before this, each tool's options had been designed on a
 * different afternoon: the paint tools had pods and hand-emitted dividers, the
 * pen had a second floating capsule of its own, and the shape and text tools
 * had no bar at all — their settings lived in the RIGHT panel, which is the
 * room that belongs to the thing you have selected.
 *
 * ── THE ONE LAW ──
 *
 * **The top bar is the TOOL's. The right panel is the SUBJECT's.**
 *
 * What the next object you draw will look like, and what the armed tool can do
 * to what is under your hand — that is the bar. What an existing layer IS —
 * that is the inspector. A tool is a thing you hold, so its settings belong
 * under the hand that is holding it, not on the far side of the screen behind
 * whatever happens to be selected.
 *
 * That split also settles the question the old arrangement could never answer:
 * editing the bar NEVER touches your selection. It writes tool defaults, every
 * time, whatever is selected — so there is no state in which changing a colour
 * might restyle a layer you had forgotten was picked.
 *
 * ── THE FOUR ZONES ──
 *
 * Every section lays out left to right in the same order, so a tool you have
 * never armed is still readable at a glance:
 *
 *   IDENTITY   which sub-tool of this family am I holding
 *   PAINT      colour, weight — what the mark is made of
 *   SHAPE      the geometry or type this tool's object has
 *   MODES      the switches you arm once, then the verbs for what is selected
 *   ⋯          everything real but rare, behind one door
 *
 * ── SEPARATORS ARE NOT RENDERED ──
 *
 * Wrap each zone in `<G>` and nothing else. The hairline between two zones is
 * drawn by CSS, from the fact that both have content — see the separator law in
 * `globals.css`. No section may emit a divider; the doubled and orphaned lines
 * that produced were never a styling bug.
 */

/**
 * ONE ZONE of a tool bar.
 *
 * Renders a bare flex row and NOTHING else — no label, no wrapper, no padding
 * — because the separator law reads `:empty`, and a single stray text node
 * would make a group that shows no controls look occupied to the group after
 * it. Labels belong to `Opt`, one level in.
 */
export function G({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <div className={cn("tool-group", className)}>{children}</div>;
}

/** The row every section is rendered into. Wears the separator law. */
export function ToolRow({
  children,
  className,
  ...rest
}: { children?: React.ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("tool-row", className)} {...rest}>
      {children}
    </div>
  );
}

/** A labelled cell — the label is part of the control, never part of the zone. */
export function Opt({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      {label && <span className="shrink-0 text-2xs text-muted-foreground">{label}</span>}
      {children}
    </div>
  );
}

/**
 * One icon button in a bar.
 *
 * ARMED is the app's single armed state — a raised pane of the same glass with
 * the accent on the ICON. Never a filled slab: this bar floats over artwork.
 */
export function pod(active?: boolean): string {
  return cn(
    "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors [&_svg]:size-3.5",
    active ? "material-glass-raised text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
  );
}

/**
 * THE CAPSULE GRAMMAR for every pick-one row on a stage bar (D8, D12): a quiet
 * track with no border, and the armed option as a raised pane of glass with the
 * accent on its content — the same armed state as a pod, so a bar reads as one
 * object instead of boxes inside a box.
 */
const SEG_TRACK = "flex h-7 shrink-0 items-stretch gap-0.5 rounded-md bg-foreground/[0.04] p-0.5";
const segItem = (armed: boolean): string =>
  cn(
    "rounded-[5px] transition-colors",
    armed ? "material-glass-raised text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
  );

/**
 * A MODE control: icon + short label per option, the modifier that reaches it
 * momentarily in the tooltip. For the few rows where the words are the point
 * (the vector-edit modes); everything else stays an `IconSeg`.
 */
export function ModeSeg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ v: T; icon: React.ComponentType<{ className?: string }>; label: string; tip: string; kbd?: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className={SEG_TRACK} role="radiogroup">
      {options.map(({ v, icon: Icon, label, tip, kbd }) => (
        <Tooltip key={v}>
          <TooltipTrigger asChild>
            <button
              type="button"
              role="radio"
              aria-checked={value === v}
              onClick={() => onChange(v)}
              className={cn("flex items-center gap-1 px-2 text-2xs font-medium [&_svg]:size-3.5", segItem(value === v))}
            >
              <Icon />
              {label}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {tip}
            {kbd && <kbd className="ml-1.5 rounded bg-secondary px-1 font-mono text-[10px]">{kbd}</kbd>}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * A compact icon segmented control — the shared chrome for any small "pick
 * one" row: a sub-tool, a combine mode, a paint depth, a text alignment.
 */
export function IconSeg<T extends string>({
  value,
  options,
  onChange,
  disabled,
  disabledHint,
}: {
  value: T;
  options: Array<{ v: T; icon: React.ComponentType<{ className?: string }>; label: string }>;
  onChange: (v: T) => void;
  /** The whole control is inert — the choice does not apply right now. */
  disabled?: boolean;
  /** Why it is inert. Shown instead of the per-option tooltip. */
  disabledHint?: string;
}) {
  return (
    <div className={cn(SEG_TRACK, disabled && "opacity-40")}>
      {options.map(({ v, icon: Icon, label }) => (
        <Tooltip key={v}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-pressed={value === v}
              disabled={disabled}
              onClick={() => onChange(v)}
              className={cn("flex items-center justify-center px-1.5", segItem(value === v), disabled && "cursor-not-allowed")}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{disabled ? (disabledHint ?? label) : label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/** A text segmented control — same object as `IconSeg` where words read better. */
export function TextSeg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  /** `disabled` with a `why`: the option shows, greyed, and says what it needs — never a button that silently does nothing. */
  options: Array<{ v: T; label: string; disabled?: boolean; why?: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className={SEG_TRACK}>
      {options.map(({ v, label, disabled, why }) => {
        const button = (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            aria-disabled={disabled || undefined}
            onClick={() => !disabled && onChange(v)}
            className={cn("px-2 text-2xs", segItem(value === v), disabled && "cursor-not-allowed opacity-40 hover:text-muted-foreground")}
          >
            {label}
          </button>
        );
        return disabled && why ? (
          <Tooltip key={v}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent side="bottom">{why}</TooltipContent>
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );
}

/**
 * THE ONE OVERFLOW DOOR — "everything else this tool can do".
 *
 * Every tool gets the same door in the same place at the end of its bar, so
 * "where are the rest of the settings" has one answer in the whole app. The
 * bar holds what you reach for mid-gesture; this holds what is real but rare,
 * and the split is per tool rather than per screen width — a control that is
 * rare on a 27" display is not less rare on a laptop.
 *
 * It SCROLLS, with a ceiling. The stage settings popover shipped without one
 * and simply ran off the bottom of a short window with its last rows
 * unreachable; a popover holding an open-ended list of rows needs the cap and
 * the scroller together, or it is a list you can only read the top of.
 */
export function ToolMore({
  title,
  icon: Icon = SlidersHorizontal,
  label = "More options",
  width = "w-64",
  children,
}: {
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  label?: string;
  width?: string;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button type="button" aria-label={label} className={pod()}>
              <Icon />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="end" sideOffset={8} className={cn(width, "p-0")}>
        <div className="label-section border-b px-3 py-2">{title}</div>
        <ScrollArea className="max-h-[min(22rem,60vh)]">
          <div className="space-y-2 p-2">{children}</div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

/** One labelled row inside a `ToolMore` popover — label left, control right. */
export function MoreRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-2 px-1">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/**
 * A DISCLOSURE pod — a button that is both a toggle and a door, which is the
 * gesture every pod in the paint bar already used but each spelled itself.
 *
 * Click toggles. The caret opens the settings. Two targets in one chip rather
 * than a hold gesture, because a hold is invisible: the paint pods hid their
 * whole settings sheet behind one and nobody found it without being told.
 */
export function PodMenu({
  icon,
  label,
  detail,
  armed,
  onToggle,
  width = "w-64",
  children,
}: {
  icon: React.ReactNode;
  label: string;
  /** The current state, in a few words — shown in the tooltip after the label. */
  detail?: string;
  armed?: boolean;
  onToggle?: () => void;
  width?: string;
  children?: React.ReactNode;
}) {
  const body = (
    <div
      className={cn(
        "flex h-7 shrink-0 items-center rounded-md transition-colors",
        armed ? "material-glass-raised text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-pressed={armed}
            onClick={onToggle}
            disabled={!onToggle}
            className="flex size-7 items-center justify-center rounded-l-md [&_svg]:size-3.5"
          >
            {icon}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{detail ? `${label} · ${detail}` : label}</TooltipContent>
      </Tooltip>
      {children && (
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${label} settings`}
            className="flex h-7 w-4 items-center justify-center rounded-r-md opacity-60 transition-opacity hover:opacity-100 [&_svg]:size-2.5"
          >
            <ChevronDown />
          </button>
        </PopoverTrigger>
      )}
    </div>
  );

  if (!children) return body;
  return (
    <Popover>
      {body}
      <PopoverContent side="bottom" align="start" sideOffset={8} className={cn(width, "p-0")}>
        <div className="label-section border-b px-3 py-2">{label}</div>
        <ScrollArea className="max-h-[min(22rem,60vh)]">
          <div className="space-y-2 p-2">{children}</div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

// ── Capsules ─────────────────────────────────────────────────────────────────

/**
 * THE BAR CAPSULE — a horizontal strip of zones on the stage (a tool's
 * options, a 3D view's header). THE CAPSULE NEVER SCROLLS — THE STRIP INSIDE
 * IT DOES: a cell that scrolls clips its children, which cost the capsule its
 * rounded corners and shadow and drew a native scrollbar inside its radius.
 * The scrollbar is an overlay, up only while you scroll or hover, and
 * `rounded-lg` (the capsule's radius less its padding) keeps the scroller's
 * square corner from poking over the capsule's round one.
 */
export function BarCapsule({ children, measure }: { children: React.ReactNode; /** Mark the row the band measures for fit (see `useRoomBeside`). */ measure?: boolean }) {
  return (
    <div data-wheel-scroll className={cn(CHROME_CAPSULE, "min-w-0 max-w-full")}>
      <ScrollArea orientation="horizontal" className="min-w-0 max-w-full rounded-lg" viewportClassName={SCROLL_SURFACE}>
        <ToolRow data-chrome-measure={measure || undefined} className="px-1">
          {children}
        </ToolRow>
      </ScrollArea>
    </div>
  );
}

// ── Rails ────────────────────────────────────────────────────────────────────

/**
 * THE RAIL CAPSULE — a column of tools (or a row, docked to a horizontal edge)
 * that SCROLLS INSIDE ITS OWN RADIUS. Every tool rail on every stage is this
 * object: the flat canvas's and a 3D world's alike, so neither can be the one
 * that runs off a short window with its last tools unreachable.
 *
 * The scroll box is the inner element, never the capsule (a clipped capsule
 * loses its rounded corners and shadow) and never the chrome cell (which
 * clipped every capsule on the stage). It is a native scroller that a finger
 * swipes (`SCROLL_SURFACE`) and the wheel drives (`data-wheel-scroll`).
 */
export const RailCapsule = React.forwardRef<HTMLDivElement, { children: React.ReactNode; className?: string } & Omit<React.HTMLAttributes<HTMLDivElement>, "children">>(
  function RailCapsule({ children, className, ...rest }, scrollerRef) {
    const vertical = useChromeAxis() === "vertical";
    return (
      <div data-toolbar data-wheel-scroll className={cn(CHROME_CAPSULE, vertical ? "flex-col" : "flex-row", className)} {...rest}>
        <div
          ref={scrollerRef}
          className={cn(
            // `items-center` is load-bearing: a divider is narrower than a
            // button, and stretch would park it against the rail's edge.
            "flex min-h-0 min-w-0 items-center gap-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden *:shrink-0",
            vertical ? "max-h-full flex-col overflow-y-auto overflow-x-hidden" : "max-w-full flex-row overflow-x-auto overflow-y-hidden",
            SCROLL_SURFACE,
          )}
        >
          {children}
        </div>
      </div>
    );
  },
);

/** A hairline between two groups of a rail, across its run. */
export function RailDivider() {
  const vertical = useChromeAxis() === "vertical";
  return <span aria-hidden className={cn("shrink-0 bg-border", vertical ? "my-0.5 h-px w-5" : "mx-0.5 h-5 w-px")} />;
}

/** One tool on a rail. ARMED is the app's one armed state, accent on the icon. */
export function railButton(active?: boolean): string {
  return cn(
    "relative flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors [&_svg]:size-4",
    active ? "material-glass-raised text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
  );
}

/**
 * A rail tool with its tooltip — label and shortcut, opening toward the canvas.
 * `menu` turns it into a door (a flyout of choices) while it still arms on click.
 */
export function RailTool({
  label,
  shortcut,
  active,
  onClick,
  children,
  more,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  /** A flyout (rows, a grid) opened by the corner fold — or by right-click. */
  more?: React.ReactNode;
}) {
  const side = useChromeFlyoutSide();
  const [open, setOpen] = React.useState(false);
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick ?? (more ? () => setOpen(true) : undefined)}
      onContextMenu={
        more
          ? (e) => {
              e.preventDefault();
              setOpen(true);
            }
          : undefined
      }
      className={railButton(active)}
    >
      {children}
      {more && (
        <span
          aria-hidden
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          className={cn("absolute bottom-0.5 right-0.5 size-2 bg-current", active ? "opacity-70" : "opacity-40")}
          style={{ clipPath: "polygon(100% 25%, 100% 100%, 25% 100%)" }}
        />
      )}
    </button>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <PopoverTrigger asChild>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
        </PopoverTrigger>
        <TooltipContent side={side} sideOffset={10} className="flex items-center gap-1.5">
          {label}
          {shortcut && <kbd className="rounded bg-secondary px-1 font-mono text-2xs">{shortcut}</kbd>}
        </TooltipContent>
      </Tooltip>
      {more && (
        <PopoverContent side={side} align="start" sideOffset={10} className="w-auto p-1" onOpenAutoFocus={(e) => e.preventDefault()} onClick={() => setOpen(false)}>
          {more}
        </PopoverContent>
      )}
    </Popover>
  );
}

// ── Pickers ──────────────────────────────────────────────────────────────────

export interface PickerOption<T extends string> {
  value: T;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  shortcut?: string;
  /** One line under the label — what choosing it DOES. */
  detail?: string;
}

/**
 * A CHOICE IN A BAR — the current option's icon on a pod, the options in a
 * titled popover with their icons, what each does and a check on the live one.
 * Blender's header dropdowns (orientation, pivot, falloff) as one object in
 * the app's own material, instead of a native `<select>` that ignores the
 * theme and cannot show an icon.
 */
export function PodPicker<T extends string>({
  title,
  value,
  options,
  onChange,
  showLabel,
  width = "w-60",
}: {
  title: string;
  value: T;
  options: ReadonlyArray<PickerOption<T>>;
  onChange: (value: T) => void;
  /** Show the current option's name beside its icon (when the icon alone is ambiguous). */
  showLabel?: boolean;
  width?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const side = useChromeFlyoutSide();
  const current = options.find((o) => o.value === value) ?? options[0]!;
  const Icon = current.icon;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`${title}: ${current.label}`}
              className={cn(
                "flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs transition-colors [&_svg]:size-3.5",
                open ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon />
              {showLabel && <span className="whitespace-nowrap">{current.label}</span>}
              <ChevronDown className="!size-2.5 opacity-60" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side={side}>
          {title} · {current.label}
        </TooltipContent>
      </Tooltip>
      <PopoverContent side={side} align="end" sideOffset={8} className={cn(width, "p-1")}>
        <div className="label-section px-2 pb-1 pt-1.5">{title}</div>
        {options.map((o) => {
          const OptIcon = o.icon;
          const on = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={on}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors [&_svg]:size-4",
                on ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <OptIcon />
              <span className="min-w-0 flex-1">
                <span className="block text-foreground">{o.label}</span>
                {o.detail && <span className="block text-2xs text-muted-foreground">{o.detail}</span>}
              </span>
              {o.shortcut && <kbd className="rounded bg-secondary px-1 font-mono text-2xs text-muted-foreground">{o.shortcut}</kbd>}
              <Check className={cn("!size-3.5 text-primary", !on && "invisible")} />
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
