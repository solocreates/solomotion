"use client";

import * as React from "react";
import {
  Circle,
  Ellipsis,
  Eraser,
  Frame,
  Hand,
  Hexagon,
  Lasso,
  MousePointer2,
  PaintBucket,
  Paintbrush2,
  PenTool,
  Scissors,
  Spline,
  Square,
  Star,
  Triangle,
  Type,
  Wand2,
} from "lucide-react";
import type { BrushEngine } from "@solomotion/core";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatCombo, useCombo } from "../state/shortcut-registry";
import { isShapeTool, useSession, type Tool } from "../state/session";
import { useHoldMenu } from "../state/use-hold-menu";
import { useDrawing } from "../drawing/drawing-store";
import { useChromeFlyoutSide } from "./StageChrome";
import { RailCapsule, RailDivider, ToolTip, railButton } from "./tool-bar-kit";
import { CHROME_EDGES, type ChromeEdge } from "./chrome-layout";
import { TOOL_SLOTS, armTool, isArmed, toolKey, type ToolMeta } from "./tool-registry";

/**
 * The tool rail.
 *
 * Two things were wrong with the old one and both were structural.
 *
 * It showed TWELVE tools at once, flat, including a magic wand nobody reaches
 * for on a vector canvas. So the rail is now a list of SLOTS (below), each slot
 * holding a family of interchangeable tools — the first is the default, the
 * rest live in a hold/right-click flyout, exactly like Figma's shape group.
 * Lasso and the wand moved where they belong: inside Select, because they *are*
 * selection.
 *
 * The bucket used to be hidden outside a paint workspace, on the grounds that a
 * paint bucket "does nothing outside a drawing". That stopped being true: it
 * fills a real vector shape's own contour, traces an enclosure made by
 * overlapping outlines, and floods pixels — on any canvas, against any
 * reference. A tool that works everywhere and appears in one place is a tool
 * nobody finds, so the workspace gate is gone with the `when` rule that existed
 * only to express it.
 *
 * And it was draggable to any of 8 compass anchors, which needed a pixel
 * collision solver, a grip handle that squatted on the first tool, and still
 * managed to park itself on the timeline. Placement is now left rail or bottom
 * bar, from the rail's own right-click menu. That is the entire feature, and it
 * cannot land on anything (see `StageChrome`).
 *
 * Adding a tool is ONE entry in `TOOL_SLOTS`. There is no second list to keep
 * in sync — this registry is also what right-click siblings read.
 */

/**
 * On-canvas feedback colour per tool, by FAMILY rather than per tool: the
 * rail's own active state is the theme accent (one colour, so "this is armed"
 * always looks the same), and these tint only the marks a tool makes while you
 * draw — where telling vector work from paint work at a glance actually helps.
 */
const FAMILY = {
  select: "#7c5cff",
  neutral: "#b9b5ac",
  text: "#4cc3e0",
  structure: "#b18cff",
  vector: "#7bd88f",
  paint: "#ffb86c",
} as const;

export const TOOL_ACCENT: Record<Tool, string> = {
  select: FAMILY.select,
  lasso: FAMILY.select,
  wand: FAMILY.select,
  hand: FAMILY.neutral,
  text: FAMILY.text,
  frame: FAMILY.structure,
  rect: FAMILY.vector,
  ellipse: FAMILY.vector,
  triangle: FAMILY.vector,
  polygon: FAMILY.vector,
  star: FAMILY.vector,
  pen: FAMILY.vector,
  cut: FAMILY.vector,
  bone: FAMILY.structure,
  brush: FAMILY.paint,
  eraser: FAMILY.paint,
  fill: FAMILY.paint,
};

type FlyoutOption = { key: string; label: string; icon: React.ReactNode; shortcutId?: string };

function FlyoutRow({ opt, active, onSelect }: { opt: FlyoutOption; active: boolean; onSelect: () => void }) {
  const shortcut = useCombo(opt.shortcutId ?? "");
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors [&_svg]:size-3.5",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      style={{ height: "var(--control-h)" }}
    >
      {opt.icon}
      <span className="flex-1 whitespace-nowrap">{opt.label}</span>
      {shortcut && (
        <kbd className="rounded bg-secondary px-1 font-mono text-2xs text-muted-foreground">{formatCombo(shortcut)}</kbd>
      )}
    </button>
  );
}

function ToolButton({
  meta,
  active,
  side,
  options,
  activeOptionKey,
  onClick,
  onPick,
}: {
  meta: ToolMeta;
  active: boolean;
  side: "top" | "right" | "bottom" | "left";
  options: FlyoutOption[];
  activeOptionKey: string;
  onClick: () => void;
  onPick: (key: string) => void;
}) {
  const shortcut = useCombo(meta.shortcutId);
  const [open, setOpen] = React.useState(false);
  const hold = useHoldMenu(() => options.length > 1 && setOpen(true));

  const button = (
    <button
      type="button"
      data-tool={meta.tool}
      aria-label={meta.label}
      aria-pressed={active}
      {...(options.length > 1 ? hold.bind : {})}
      onClick={() => {
        if (options.length > 1 && hold.guard()) return; // a hold opened the flyout
        onClick();
      }}
      // ARMED = a raised pane of the rail's own glass with the accent on the
      // ICON — never an accent-filled slab, which fought the artwork behind
      // the canvas and read as a sticker. See `railButton`.
      className={railButton(active)}
    >
      {meta.icon}
      {/* Sub-tool marker — a corner fold, so it reads the same in a row or a
          column (a chevron would have to reflow). Presence says "hold or
          right-click for more"; the tooltip spells it out. */}
      {options.length > 1 && (
        <span
          aria-hidden
          className={cn("pointer-events-none absolute bottom-1 right-1 size-1 bg-current", active ? "opacity-70" : "opacity-40")}
          style={{ clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }}
        />
      )}
    </button>
  );

  return (
    <Tooltip>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
        </PopoverAnchor>
        {options.length > 1 && (
          <PopoverContent
            side={side}
            align="center"
            sideOffset={10}
            className="w-auto min-w-36 space-y-0.5 p-1"
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            {options.map((o) => (
              <FlyoutRow key={o.key} opt={o} active={o.key === activeOptionKey} onSelect={() => { onPick(o.key); setOpen(false); }} />
            ))}
          </PopoverContent>
        )}
      </Popover>
      <ToolTip side={side} label={meta.label} keys={shortcut ? formatCombo(shortcut) : null} detail={meta.detail} />
    </Tooltip>
  );
}

/**
 * THE RAIL'S MORE — the tools most people don't reach for every minute
 * (registry `more: true`), one button away and still on their shortcuts.
 * While one of them is armed, More wears that tool's glyph and is lit, so the
 * rail never hides what you are holding. Opens toward the canvas, and Radix
 * flips it when that side has no room.
 */
function MoreTools({ tools, side }: { tools: readonly ToolMeta[]; side: "top" | "right" | "bottom" | "left" }) {
  const tool = useSession((s) => s.tool);
  const engine = useDrawing((s) => s.brush.engine);
  const [open, setOpen] = React.useState(false);
  const armed = tools.find((t) => isArmed(t, tool, engine));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <PopoverAnchor asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-tool={armed?.tool}
              aria-label={armed ? `${armed.label} (more tools)` : "More tools"}
              aria-pressed={!!armed}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className={railButton(!!armed)}
            >
              {armed ? armed.icon : <Ellipsis />}
            </button>
          </TooltipTrigger>
        </PopoverAnchor>
        {!open && <ToolTip side={side} label={armed ? armed.label : "More tools"} detail={armed ? armed.detail : "Bones, eraser, paint bucket."} />}
      </Tooltip>
      <PopoverContent
        side={side}
        align="center"
        sideOffset={10}
        collisionPadding={8}
        className="w-auto min-w-44 space-y-0.5 p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {tools.map((t) => (
          <FlyoutRow
            key={toolKey(t)}
            opt={{ key: toolKey(t), label: t.label, icon: t.icon, shortcutId: t.shortcutId }}
            active={isArmed(t, tool, engine)}
            onSelect={() => {
              armTool(t);
              setOpen(false);
            }}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

const EDGE_LABEL: Record<ChromeEdge, string> = {
  left: "Left rail",
  right: "Right rail",
  top: "Top bar",
  bottom: "Bottom bar",
};

export function StageToolbar() {
  const tool = useSession((s) => s.tool);
  const placement = useSession((s) => s.toolbarPlacement);
  const brushEngine = useDrawing((s) => s.brush.engine);
  // From the EDGE the chrome layout put us on, never the stored placement read
  // a second time (a rail that renders as a column with its tooltips still
  // opening downward was exactly that second read). `RailCapsule` reads the
  // axis the same way.
  const side = useChromeFlyoutSide();

  // Each slot remembers the last tool picked from it (Figma behaviour), so
  // re-arming the shape slot gives you the ellipse you were using, not a rect.
  const [lastPick, setLastPick] = React.useState<Record<string, string>>({});

  const slots = TOOL_SLOTS.filter((s) => !s.more);
  const moreTools = TOOL_SLOTS.filter((s) => s.more).flatMap((s) => s.tools);

  // Arming a tool by SHORTCUT can select something scrolled out of the rail.
  // Nudge it back into view — `block/inline: nearest` so it never yanks the
  // stage or the page, only the rail's own scroller.
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    // The ARMED button, not the first one wearing this tool's name. Two slots
    // now share `tool: "brush"` and differ by engine, so a plain `[data-tool]`
    // lookup scrolled to the pixel brush every time the vector one was armed.
    // `aria-pressed` is the fact the rail already publishes for exactly this.
    scrollerRef.current
      ?.querySelector<HTMLElement>(`[data-tool="${tool}"][aria-pressed="true"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tool, brushEngine]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <RailCapsule ref={scrollerRef}>
          {slots.map((slot) => {
            const armed = slot.tools.find((t) => isArmed(t, tool, brushEngine));
            const meta = armed ?? slot.tools.find((t) => toolKey(t) === lastPick[slot.id]) ?? slot.tools[0]!;
            const options: FlyoutOption[] = slot.tools.map((t) => ({
              key: toolKey(t),
              label: t.label,
              icon: t.icon,
              shortcutId: t.shortcutId,
            }));
            return (
              <React.Fragment key={slot.id}>
                {slot.groupStart && <RailDivider />}
                <ToolButton
                  meta={meta}
                  active={slot.id === "shape" ? isShapeTool(tool) : !!armed}
                  side={side}
                  options={options}
                  activeOptionKey={toolKey(meta)}
                  onClick={() => armTool(meta)}
                  onPick={(key) => {
                    const picked = slot.tools.find((t) => toolKey(t) === key);
                    if (!picked) return;
                    setLastPick((m) => ({ ...m, [slot.id]: key }));
                    armTool(picked);
                  }}
                />
              </React.Fragment>
            );
          })}
          {moreTools.length > 0 && <MoreTools tools={moreTools} side={side} />}
        </RailCapsule>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>Tool rail</ContextMenuLabel>
        {/* Four edges from ONE list. The rail lays itself out from whichever it
            is given (see `chrome-layout`), so a direction is a value here
            rather than a branch anywhere. */}
        {CHROME_EDGES.map((edge) => (
          <ContextMenuItem key={edge} onClick={() => useSession.getState().setToolbarPlacement(edge)}>
            {EDGE_LABEL[edge]} {placement === edge && "✓"}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
