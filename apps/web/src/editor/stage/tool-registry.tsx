"use client";

import * as React from "react";
import {
  Bone,
  Circle,
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
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useDrawing } from "../drawing/drawing-store";
import { formatCombo, useCombo } from "../state/shortcut-registry";
import { useSession, type Tool } from "../state/session";

/**
 * THE TOOL REGISTRY — every tool, its name, its glyph, its shortcut, and which
 * other tools it is interchangeable with.
 *
 * One list, two readers, and the second reader is why it moved out of
 * `Toolbar.tsx`. The rail renders these as slots with a hold flyout; the stage
 * tool bar renders the armed slot's siblings as a SWITCHER at the head of every
 * tool's options. Those are two views of one fact — "what else could I be
 * holding right now" — and a second copy of it in the bar would go stale the
 * first time a tool joined a family.
 *
 * There is a third list that answers a near-identical question and deliberately
 * is NOT this one: `TOOL_CATEGORIES` in `session.ts`, which drives right-click
 * "switch to a sibling" on the canvas. It is not the same question — the rail's
 * select slot holds Move, Lasso and Wand together because they compete for one
 * button, while the category holds only Lasso and Wand because Move is not
 * something you would right-click a lasso to reach. Worth restating here so the
 * next person does not merge them by eye.
 */

export interface ToolMeta {
  tool: Tool;
  label: string;
  /** One line on what the tool DOES, under the label in a rich tip. */
  detail: string;
  /** The brush's two entries are one tool and an engine: arming sets both,
   *  and the entry is armed only while both match. */
  engine?: BrushEngine;
  shortcutId: string;
  icon: React.ReactNode;
}

export interface ToolSlot {
  id: string;
  /** First entry is the slot's default; the rest are its flyout siblings. */
  tools: ToolMeta[];
  /** Draw a divider before this slot. */
  groupStart?: boolean;
  /** Lives behind the rail's More button: reachable (and by shortcut), but
   *  not a tool most people reach for every minute. */
  more?: boolean;
}

/** A tool entry's identity: the tool, plus the engine for the brush's two. */
export function toolKey(m: ToolMeta): string {
  return m.engine ? `${m.tool}:${m.engine}` : m.tool;
}

/** Is this entry the armed one? */
export function isArmed(m: ToolMeta, tool: Tool, engine: BrushEngine): boolean {
  return m.tool === tool && (!m.engine || m.engine === engine);
}

/** Arm this entry (the brush's engine too). */
export function armTool(m: ToolMeta): void {
  if (m.engine) useDrawing.getState().setBrushOptions({ engine: m.engine });
  useSession.getState().setTool(m.tool);
}

export const TOOL_SLOTS: ToolSlot[] = [
  {
    id: "select",
    tools: [
      { tool: "select", label: "Move", detail: "Select, move and resize. Drag empty space to marquee.", shortcutId: "tool.select", icon: <MousePointer2 /> },
      { tool: "lasso", label: "Lasso", detail: "Draw around pixels to select them.", shortcutId: "tool.lasso", icon: <Lasso /> },
      { tool: "wand", label: "Magic wand", detail: "Select a region of similar colour.", shortcutId: "tool.lasso", icon: <Wand2 /> },
    ],
  },
  {
    id: "hand",
    tools: [{ tool: "hand", label: "Hand", detail: "Pan the view. Hold Space for it anywhere.", shortcutId: "tool.hand", icon: <Hand /> }],
  },
  {
    id: "frame",
    groupStart: true,
    tools: [{ tool: "frame", label: "Frame", detail: "Draw a frame: a scene with its own size and time.", shortcutId: "tool.frame", icon: <Frame /> }],
  },
  {
    id: "text",
    tools: [{ tool: "text", label: "Text", detail: "Click to type; drag to set the box.", shortcutId: "tool.text", icon: <Type /> }],
  },
  {
    id: "shape",
    tools: [
      { tool: "rect", label: "Rectangle", detail: "Drag to draw. Shift keeps it square.", shortcutId: "tool.rect", icon: <Square /> },
      { tool: "ellipse", label: "Ellipse", detail: "Drag to draw. Shift keeps it round.", shortcutId: "tool.ellipse", icon: <Circle /> },
      { tool: "triangle", label: "Triangle", detail: "Drag to draw a triangle.", shortcutId: "tool.triangle", icon: <Triangle /> },
      { tool: "polygon", label: "Polygon", detail: "Drag to draw; the sides are yours to set.", shortcutId: "tool.polygon", icon: <Hexagon /> },
      { tool: "star", label: "Star", detail: "Drag to draw; points and depth are yours to set.", shortcutId: "tool.star", icon: <Star /> },
    ],
  },
  {
    id: "pen",
    tools: [
      { tool: "pen", label: "Pen", detail: "Click for corners, drag for curves.", shortcutId: "tool.pen", icon: <PenTool /> },
      { tool: "cut", label: "Knife", detail: "Slice a path where you drag across it.", shortcutId: "tool.cut", icon: <Scissors /> },
    ],
  },
  {
    id: "bone",
    more: true,
    tools: [{ tool: "bone", label: "Bone", detail: "Draw bones to rig a character.", shortcutId: "tool.bone", icon: <Bone /> }],
  },
  // THE BRUSH IS ONE SLOT, its two engines its flyout (Shayan: the rail was
  // crowded). They used to be two slots because the options bar's badge could
  // not switch engines; it can now (`ToolSwitch`, from this registry), so the
  // vector brush is one hold, one right-click or one pick in the bar away.
  // Both arm `tool: "brush"` and differ by `brush.engine`.
  {
    id: "brush",
    groupStart: true,
    tools: [
      { tool: "brush", engine: "raster", label: "Pixel brush", detail: "Paint pixels on the current drawing.", shortcutId: "tool.brush", icon: <Paintbrush2 /> },
      { tool: "brush", engine: "vector", label: "Vector brush", detail: "Paint strokes that stay editable.", shortcutId: "tool.brushEngine", icon: <Spline /> },
    ],
  },
  {
    id: "eraser",
    more: true,
    tools: [
      { tool: "eraser", label: "Eraser", detail: "Rub out what you painted.", shortcutId: "tool.eraser", icon: <Eraser /> },
    ],
  },
  {
    id: "fill",
    more: true,
    tools: [{ tool: "fill", label: "Paint bucket", detail: "Fill a closed region with colour.", shortcutId: "tool.fill", icon: <PaintBucket /> }],
  },
];

/** Flat lookup for any generic "what is this tool called" question. */
const ALL_TOOLS: ToolMeta[] = TOOL_SLOTS.flatMap((s) => s.tools);
export function toolMeta(tool: Tool): ToolMeta | undefined {
  return ALL_TOOLS.find((t) => t.tool === tool);
}

// ── What else could I be holding? ───────────────────────────────────────────

/**
 * ONE alternative to the armed tool, ready to render and to arm.
 *
 * `arm` is a closure rather than a `Tool` because the brush's two variants are
 * not two tools: they are one tool and a `brush.engine`. Returning something
 * the caller has to interpret would put that special case in the switcher —
 * and then in the next surface that wanted the same list.
 */
export interface ToolVariant {
  key: string;
  label: string;
  icon: React.ReactNode;
  shortcutId?: string;
  active: boolean;
  arm: () => void;
}

/**
 * The armed tool's interchangeable siblings — the tools sharing its rail slot,
 * plus the brush's two engines, which are two slots wearing one tool.
 *
 * Empty (never one entry) when there is nothing to switch to: a list of one is
 * a control that cannot do anything, and the bar's zone collapses on `:empty`
 * so an alternative-less tool costs no space and draws no separator.
 */
export function useToolVariants(): ToolVariant[] {
  const tool = useSession((s) => s.tool);
  const engine = useDrawing((s) => s.brush.engine);

  return React.useMemo(() => {
    const slots = TOOL_SLOTS.filter((sl) => sl.tools.some((t) => t.tool === tool));
    const out: ToolVariant[] = [];
    for (const slot of slots) {
      for (const meta of slot.tools) {
        out.push({
          key: toolKey(meta),
          label: meta.label,
          icon: meta.icon,
          shortcutId: meta.shortcutId,
          active: isArmed(meta, tool, engine),
          arm: () => armTool(meta),
        });
      }
    }
    return out.length > 1 ? out : [];
  }, [tool, engine]);
}

/**
 * THE SUB-TOOL SWITCHER — the head of every tool bar, for every tool, without
 * any section asking for it.
 *
 * It began as the brush's private `EngineSwitch`, which was the right idea in
 * the wrong place: the pen had hand-rolled a segmented control for the same job
 * beside it, the shapes — five interchangeable tools, the clearest case in the
 * app — had nothing at all, and each answered "what are my siblings" from its
 * own hard-coded list. So the bar renders this itself, from the registry, and a
 * tool that gains a sibling gains the switcher with no edit here or there.
 *
 * A DROPDOWN rather than a segmented control, and that is a size decision:
 * five shapes side by side is 140px of a strip that already has to hold fill,
 * stroke and geometry. The glyph says what you are holding, the caret says
 * there are others — the same shape the rail's own hold flyout has, so the two
 * ways to change sub-tool look like one feature.
 */
export function ToolSwitch() {
  const variants = useToolVariants();
  const [open, setOpen] = React.useState(false);
  const current = variants.find((v) => v.active) ?? variants[0];
  if (!current) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`${current.label} — switch tool`}
              aria-expanded={open}
              className={cn(
                // Sized like a pod and then some, NOT like a rail button. It
                // shipped once at the rail's 16px glyph inside a 28px strip,
                // where it was visibly the largest thing on the bar and sat
                // hard against its neighbour; every icon in a tool bar is
                // 14px, and the caret is the 10px one every disclosure wears.
                "flex h-7 shrink-0 items-center gap-0.5 rounded-md pl-1.5 pr-1 transition-colors",
                "[&>svg]:size-3.5 [&_svg]:shrink-0",
                open
                  ? "material-glass-raised text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {current.icon}
              <ChevronDown className="size-2.5 opacity-60" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{current.label}</TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="start" sideOffset={8} className="w-auto min-w-40 space-y-0.5 p-1">
        {variants.map((v) => (
          <VariantRow key={v.key} variant={v} onPick={() => setOpen(false)} />
        ))}
      </PopoverContent>
    </Popover>
  );
}

function VariantRow({ variant, onPick }: { variant: ToolVariant; onPick: () => void }) {
  const shortcut = useCombo(variant.shortcutId ?? "");
  return (
    <button
      type="button"
      onClick={() => {
        variant.arm();
        onPick();
      }}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors [&_svg]:size-3.5",
        variant.active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {variant.icon}
      <span className="flex-1 whitespace-nowrap">{variant.label}</span>
      {shortcut && (
        <kbd className="rounded bg-secondary px-1 font-mono text-2xs text-muted-foreground">{formatCombo(shortcut)}</kbd>
      )}
    </button>
  );
}
