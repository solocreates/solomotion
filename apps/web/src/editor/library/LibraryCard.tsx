"use client";

import * as React from "react";
import { downloadBytes, isHeavyItem, type LibraryItem } from "@solomotion/core";
import { Check, Gauge, Loader2, Play, Plus, Star } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { FrameEdge } from "../panels/BrowserControls";
import { LibraryArt } from "./LibraryArt";
import { useSoundShape } from "./item-peaks";
import { DRAG_OUT_PROPS } from "../panels/drag-out";

/**
 * THE library card — one component for every shelf, in grid and in list.
 *
 * Six card designs became one because the item model made them one: a card
 * needs a preview, a name, a provenance and a primary action, and the model
 * answers all four for a text look and a downloadable sound alike. That is what
 * "unified" has to mean to be worth anything — not a shared wrapper around six
 * bodies, but six things that turned out to be the same shape.
 *
 * Everything expensive is gated on hover: previews do not animate, sounds do
 * not decode and videos are not even mounted until the pointer is over the
 * card. An idle library of a thousand cards costs nothing, which is the only
 * performance budget that matters at library size.
 */

export interface LibraryCardProps {
  item: LibraryItem;
  view: "grid" | "list";
  /** False for an online item that has nothing local to drop yet. */
  draggable: boolean;
  starred: boolean;
  /**
   * This preset is on the current selection right now.
   *
   * The one question a preset browser has to answer and could not: *which of
   * these am I using?* Derived per render from the clips themselves
   * (`libraryFocus`), never stored, so it cannot drift from the document.
   */
  active: boolean;
  /** True while bytes are on their way. */
  busy: boolean;
  onUse: () => void;
  /** Sounds only: audition it — which is also how you come to own it. */
  onPlay: () => void;
  onToggleStar: () => void;
  /** `press` is a short click on a card whose press the drag owns. */
  onDragStart: (e: React.PointerEvent, press: () => void) => void;
  onDelete?: () => void;
  onRename?: () => void;
  /**
   * How the card draws (the layout's call, `ProductIdentity.browsers`).
   * `plate`: a card with a footer rule. `frame`: the preview is a small stage —
   * a hairline frame on the theme's backdrop — with the name under it and the
   * metadata in the code face. Same gestures either way.
   */
  tile?: "plate" | "frame";
}

const bytesLabel = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * The line under the name: MEASUREMENTS, and nothing else.
 *
 * It used to fall back to the item's blurb, which meant a line of prose under
 * every one of four hundred cards — "Serif flips up line by line", "Focus pull
 * into place" — restating a name over a preview that was already showing you
 * the motion. Twenty of those is a wall nobody reads, and because the blurbs
 * are different lengths it made every row a different height, so nothing
 * aligned either.
 *
 * What survives is what DIFFERS between two cards side by side and cannot be
 * seen: how long a sound is, what an un-owned item will cost to fetch, whose
 * pack it came from. When there is no such fact the line is simply absent —
 * the card is shorter, and it has lost nothing. The blurb still exists, as the
 * card's `title`, which is where a sentence belongs.
 */
function meta(item: LibraryItem): string {
  const parts: string[] = [];
  if (item.preview.type === "peaks") parts.push(`${Math.round(item.preview.durationMs)} ms`);
  const bytes = downloadBytes(item);
  if (bytes) parts.push(bytesLabel(bytes));
  else if (item.publisher && (item.source === "online" || item.source === "downloaded")) {
    parts.push(item.publisher.name);
  }
  return parts.join(" · ");
}

export function LibraryCard(props: LibraryCardProps) {
  const { item, view, starred, active, busy, draggable, onUse, onPlay, onToggleStar, onDragStart } = props;
  const frame = props.tile === "frame";
  const [hover, setHover] = React.useState(false);
  const [auditioning, setAuditioning] = React.useState(false);
  const isSound = item.kind === "sound";
  const owned = Boolean(item.action);
  const shape = useSoundShape(item);

  /**
   * PLAYING A SOUND IS HOW YOU GET IT.
   *
   * There is no download button. Auditioning already fetches the bytes to make
   * a noise, so making that the acquisition is not a shortcut — it is removing
   * a step that only ever existed because the two were modelled separately. You
   * hear it, you have it. Dragging one you have not heard fetches it too.
   *
   * Non-audio kinds keep an explicit first use, because a footage clip is a
   * commitment of real bytes and "I clicked play to listen" has no equivalent.
   */
  const primary = () => (isSound ? play() : onUse());

  /**
   * One clock. The card and the waveform used to time the audition separately —
   * the card off the manifest's length, the wave off whatever it had decoded —
   * so a sweep could be cut off and reset halfway through a sound. Both now
   * read the SAME measured audible length, and the card simply outlives the
   * sweep by a hair so the wave settles itself.
   */
  const play = () => {
    onPlay();
    setAuditioning(true);
    window.setTimeout(() => setAuditioning(false), Math.max(260, shape.durationMs) + 80);
  };

  /**
   * A draggable card starts a drag and treats a short press as a click; one
   * that has nothing local to drop yet is a plain button. Routing this here
   * rather than in the browser is what keeps "can I drop this" a property of
   * the item instead of a rule each surface reimplements.
   */
  const press = draggable
    ? // A card you can drag out keeps its press even while the lasso is armed:
      // starting a selection shape and picking a card up are the same gesture,
      // and the item is the only thing that knows which it is.
      //
      // `primary` is handed DOWN to the drag, not left to the browser. A
      // draggable card has no `onClick` of its own — the press belongs to the
      // drag — so whatever the drag calls on a short press IS the card's click,
      // and the browser was quietly answering that with "import it", which is
      // how clicking a sound to hear it put a clip on the timeline.
      { onPointerDown: (e: React.PointerEvent) => onDragStart(e, primary), ...DRAG_OUT_PROPS }
    : { onClick: primary, className: "cursor-pointer" };

  // A heavy item stays a still on hover: looping a black hole or a wall of
  // lit materials inside a library card is the slowdown the badge warns of.
  const heavy = isHeavyItem(item);
  const art = (
    <LibraryArt
      item={item}
      // A sound's art animates while it PLAYS, not while it is hovered — the
      // sweep is a readout, and a sweep that runs on hover would lie about
      // whether you are hearing anything.
      playing={isSound ? auditioning : hover && !heavy}
    />
  );
  const heavyBadge = heavy ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("absolute left-1.5 top-1.5 flex items-center gap-1 rounded bg-background/85 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground backdrop-blur", frame && "font-mono font-normal")}>
          <Gauge className="size-2.5" />
          Heavy
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">May run slowly on some devices.</TooltipContent>
    </Tooltip>
  ) : null;

  const badge = !owned ? (
    <span className={cn("pointer-events-none absolute right-1.5 top-1.5 rounded bg-background/85 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground backdrop-blur", frame && "font-mono font-normal")}>
      {busy ? "…" : bytesLabel(downloadBytes(item))}
    </span>
  ) : item.source === "downloaded" ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="pointer-events-none absolute right-1.5 top-1.5 flex size-4 items-center justify-center rounded-full bg-primary/90 text-primary-foreground">
          <Check className="size-2.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="left">In your library</TooltipContent>
    </Tooltip>
  ) : null;

  const actionButton = (
    <button
      type="button"
      aria-label={isSound ? `Play ${item.name}` : `Add ${item.name}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        primary();
      }}
      disabled={busy}
      className={cn(
        frame
          ? "flex size-6 shrink-0 items-center justify-center rounded-md bg-popover text-fg shadow-sm ring-1 ring-line transition hover:bg-[color-mix(in_srgb,var(--primary)_18%,var(--popover))] hover:text-primary hover:ring-primary/50 disabled:opacity-60"
          : "flex size-6 shrink-0 items-center justify-center rounded-full border bg-background/90 text-foreground shadow-sm backdrop-blur transition hover:border-primary/50 hover:bg-[color-mix(in_srgb,var(--primary)_18%,var(--popover))] hover:text-primary disabled:opacity-60",
        "[&_svg]:size-3",
      )}
    >
      {busy ? <Loader2 className="animate-spin" /> : isSound ? <Play /> : <Plus />}
    </button>
  );

  const star = (
    <button
      type="button"
      aria-label={starred ? "Remove from Starred" : "Add to Starred"}
      aria-pressed={starred}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onToggleStar();
      }}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded transition-opacity [&_svg]:size-3.5",
        starred ? "text-warning" : "text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100",
      )}
    >
      <Star className={cn(starred && "fill-current")} />
    </button>
  );

  const metaClass = frame
    ? "truncate font-mono text-meta text-fg-faint"
    : "truncate text-[9px] text-muted-foreground";

  const body =
    view === "list" ? (
      <div
        role="button"
        tabIndex={0}
        {...press}
        onDoubleClick={primary}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            primary();
          }
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={item.blurb ?? item.name}
        // `material-glass-raised` is the app's ONE armed state — a brighter pane
        // of the same glass, with the accent carried by the label rather than a
        // saturated slab. Same object as the armed tool and the open panel.
        className={
          frame
            ? cn(
                "group flex w-full cursor-grab select-none items-center gap-2 rounded-md px-1 py-1 text-left outline-none transition-colors focus-visible:bg-hover active:cursor-grabbing",
                active ? "bg-primary/8 text-fg" : "hover:bg-hover",
              )
            : cn(
                "group flex w-full cursor-grab select-none items-center gap-2 rounded-md border border-transparent px-1.5 py-1 text-left outline-none transition-colors focus-visible:border-primary active:cursor-grabbing",
                active
                  ? "material-glass-raised border-primary/40 text-primary"
                  : "hover:border-border hover:bg-accent/40",
              )
        }
      >
        {/* A sound IS its waveform, so in a list it gets the whole line: the
            name sits left at a fixed share and the wave takes the rest. Every
            other kind keeps a thumbnail, which is all its preview can say at
            row height. */}
        {isSound ? (
          <>
            <div className="w-[38%] min-w-0 shrink-0 leading-tight">
              <div className="truncate text-[11px] font-medium">{item.name}</div>
              {meta(item) && <div className={metaClass}>{meta(item)}</div>}
            </div>
            <div className="relative h-6 min-w-0 flex-1 overflow-hidden rounded-sm">{art}</div>
          </>
        ) : (
          <>
            <div className={cn("relative h-6 w-11 shrink-0 overflow-hidden rounded-sm", frame ? "stage-backdrop bg-stage" : "bg-stage/60")}>
              {art}
              {frame && <FrameEdge tone={active ? "on" : "rest"} />}
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[11px] font-medium">{item.name}</div>
              {meta(item) && <div className={metaClass}>{meta(item)}</div>}
            </div>
          </>
        )}
        {star}
        {frame ? (
          // Quiet until the row is under the pointer; on touch there is no
          // hover, so it stays. The row itself is the primary action either way.
          <div className="transition-opacity [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
            {actionButton}
          </div>
        ) : (
          actionButton
        )}
      </div>
    ) : (
      <div
        role="button"
        tabIndex={0}
        {...press}
        onDoubleClick={primary}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            primary();
          }
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={item.blurb ?? item.name}
        className={cn(
          "group relative flex cursor-grab select-none flex-col text-left outline-none transition-colors active:cursor-grabbing",
          frame
            ? "gap-1.5"
            : cn(
                "overflow-hidden rounded-lg border focus-visible:border-primary",
                active ? "material-glass-raised border-primary/50" : "bg-card hover:border-primary/50",
              ),
        )}
      >
        <div
          className={cn(
            "relative aspect-4/3 w-full overflow-hidden",
            frame ? "stage-backdrop rounded-md bg-stage" : "bg-stage/60",
          )}
        >
          {art}
          {heavyBadge}
          {badge}
          <div
            className={cn(
              "absolute bottom-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
              frame ? "right-1.5" : "left-1.5",
            )}
          >
            {actionButton}
          </div>
          {frame && <FrameEdge tone={active ? "on" : "rest"} />}
        </div>
        <div className={cn("flex items-center gap-1", frame ? "px-0.5" : "border-t px-1.5 py-1")}>
          <div className="min-w-0 flex-1">
            <div className={cn("truncate", frame ? "text-body leading-snug text-fg" : "text-[11px] font-medium leading-4")}>
              {item.name}
            </div>
            {meta(item) && (
              <div className={frame ? metaClass : "truncate text-[9px] leading-3 text-muted-foreground"}>{meta(item)}</div>
            )}
          </div>
          {star}
        </div>
      </div>
    );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{body}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => onUse()}>
          {item.action?.type === "instance" ? "Open definition" : item.kind === "template" ? "New project from template" : "Add to this project"}
        </ContextMenuItem>
        {isSound && <ContextMenuItem onSelect={play}>Play</ContextMenuItem>}
        <ContextMenuItem onSelect={onToggleStar}>{starred ? "Remove from Starred" : "Star"}</ContextMenuItem>
        {(props.onRename || props.onDelete) && <ContextMenuSeparator />}
        {props.onRename && <ContextMenuItem onSelect={props.onRename}>Rename</ContextMenuItem>}
        {props.onDelete && (
          <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={props.onDelete}>
            Delete
          </ContextMenuItem>
        )}
        {item.publisher && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem disabled>By {item.publisher.name}</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
