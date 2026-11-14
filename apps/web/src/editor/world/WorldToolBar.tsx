"use client";

import * as React from "react";
import {
  ArrowUpFromLine,
  Combine,
  GitCommitHorizontal,
  MoreHorizontal,
  Trash2,
  Triangle,
  Box,
  Brush,
  Circle,
  CircleDot,
  Cone,
  Cylinder,
  Donut,
  Eraser,
  Expand,
  Gauge,
  Globe,
  Globe2,
  Grab,
  Grid2x2,
  Grid3x3,
  Hexagon,
  Home,
  Infinity as InfinityIcon,
  Layers,
  LocateFixed,
  Minus,
  Move,
  PaintBucket,
  Paintbrush2,
  Pill,
  Plus,
  Pyramid,
  RectangleHorizontal,
  RectangleVertical,
  ScanEye,
  Shrink,
  Slash,
  Spline,
  Square,
  Waves,
  X,
} from "lucide-react";
import { locateClip, DRAW_PLACEMENTS, FALLOFFS, NODE_VERBS, PRIMITIVES, SCULPT_BRUSHES, type DrawPlacement, type Falloff, type NodeVerbId, type SculptBrush } from "@solomotion/core";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useDoc, useDocSelector } from "../state/document-context";
import { useEditedKind } from "./use-edited";
import { editTargetKindOf } from "./edit-targets";
import { Range } from "@/components/ui/range";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { BarCapsule, G, IconSeg, Opt, PodPicker, pod, type PickerOption } from "../stage/tool-bar-kit";
import { FillColorTools, PixelPaintTools, VectorDrawTools } from "../stage/ToolOptionsBar";
import { TextSection } from "../stage/vector-sections";
import { useToolDefaults } from "../state/tool-defaults";
import { useWorldUi } from "./state";
import { useSession } from "../state/session";
import type { WorldMode, WorldTool } from "./tools";
import { FalloffIcon } from "./viewport-icons";
import type { Actions } from "./WorldStage";

/**
 * THE 3D TOOL BAR — the armed tool's own options, the row under the header.
 *
 * The flat stage's law (`tool-bar-kit`): the bar is the TOOL's, the inspector
 * is the SUBJECT's. Editing it never touches the selection; it writes what
 * the next mark, shape, stroke or dab will be. Same capsule, same zones, same
 * scrolling strip — a finger swipes it sideways where it is longer than the
 * stage is wide.
 *
 * Before this the world had no such row: the brush's bar was pushed into the
 * bottom-centre slot where the tool hint lives, the shape a click places was
 * a flyout behind the rail, and the text tool ignored the font you had chosen
 * on the canvas. A tool with no entry here gets no bar at all.
 */

export const PRIM_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  cube: Box,
  plane: Square,
  grid: Grid3x3,
  circle: Circle,
  uvSphere: Globe,
  icoSphere: Hexagon,
  cylinder: Cylinder,
  cone: Cone,
  pyramid: Pyramid,
  torus: Donut,
  capsule: Pill,
  tube: CircleDot,
  torusKnot: InfinityIcon,
};

export const SCULPT_ICON: Record<SculptBrush, React.ComponentType<{ className?: string }>> = {
  draw: Brush,
  clay: Layers,
  inflate: Expand,
  crease: Slash,
  smooth: Waves,
  flatten: Minus,
  pinch: Shrink,
  grab: Grab,
};

const PLACEMENT: Record<DrawPlacement, { label: string; icon: React.ComponentType<{ className?: string }>; detail: string }> = {
  view: { label: "Facing you", icon: ScanEye, detail: "A page held up to the view, through the 3D cursor" },
  surface: { label: "On surfaces", icon: Globe2, detail: "Wraps the objects under the pen" },
  front: { label: "Front", icon: RectangleHorizontal, detail: "The X–Z plane through the 3D cursor" },
  side: { label: "Side", icon: RectangleVertical, detail: "The Y–Z plane through the 3D cursor" },
  top: { label: "Top", icon: Grid2x2, detail: "The X–Y plane through the 3D cursor" },
};
const PLACEMENT_OPTIONS: ReadonlyArray<PickerOption<DrawPlacement>> = DRAW_PLACEMENTS.map((v) => ({ value: v, ...PLACEMENT[v] }));

const FALLOFF_LABEL: Record<Falloff, string> = { smooth: "Smooth", sphere: "Sphere", root: "Root", linear: "Linear", sharp: "Sharp", constant: "Constant" };
const FALLOFF_OPTIONS: ReadonlyArray<PickerOption<Falloff>> = FALLOFFS.map((f) => ({
  value: f,
  label: FALLOFF_LABEL[f],
  icon: ({ className }: { className?: string }) => <FalloffIcon kind={f} className={className} />,
}));

/** The tools a mode's switch offers — its rail, as a dropdown at the head of the bar. */
const DRAW_TOOLS: ReadonlyArray<PickerOption<WorldTool>> = [
  { value: "draw", label: "Vector brush", icon: Spline, detail: "Strokes you can edit, fill and animate" },
  { value: "paint", label: "Pixel brush", icon: Paintbrush2, detail: "Paint onto surfaces and drawing layers" },
  { value: "erase", label: "Eraser", icon: Eraser, detail: "Removes the strokes it passes over" },
  { value: "fill", label: "Fill", icon: PaintBucket, detail: "A closed drawing, or an object's colour" },
];

function DrawSwitch() {
  const tool = useWorldUi((s) => s.tool);
  const set = useWorldUi((s) => s.set);
  return <PodPicker title="Draw" value={tool} options={DRAW_TOOLS} onChange={(t) => set({ tool: t })} showLabel />;
}

function Placement() {
  const placement = useToolDefaults((s) => s.world.placement);
  const offset = useToolDefaults((s) => s.world.surfaceOffset);
  const set = useToolDefaults((s) => s.setPlacement);
  const setOffset = useToolDefaults((s) => s.setSurfaceOffset);
  return (
    <G>
      <PodPicker title="Strokes land" value={placement} options={PLACEMENT_OPTIONS} onChange={set} showLabel width="w-64" />
      {placement === "surface" && (
        <Opt label="Offset">
          <Range className="w-20" value={offset} min={0} max={20} step={0.1} onChange={setOffset} aria-label="Surface offset" />
        </Opt>
      )}
    </G>
  );
}

/**
 * WHERE THE NEXT STROKE GOES. A selected flat drawing is the page — strokes
 * join it, on its own plane, from any angle short of edge-on — so a drawing
 * is a layer you keep adding to, as a grease-pencil object is. Nothing
 * selected, a stroke starts a new drawing. The × lets go of the drawing.
 */
function DrawInto() {
  const ids = useSession((s) => s.selectedClipIds);
  const placement = useToolDefaults((s) => s.world.placement);
  const id = ids.at(-1);
  const clip = useDocSelector((d) => (id && placement === "view" ? locateClip(d, id)?.clip : null));
  const into = clip?.kind === "path" && !clip.subpaths.some((c) => c.points.some((p) => p.z)) ? clip : null;
  if (!into) return <span className="px-1 text-2xs text-muted-foreground">New drawing</span>;
  return (
    <span className="flex h-7 items-center gap-1 rounded-md border pl-2 pr-0.5 text-2xs">
      <span className="text-muted-foreground">Adding to</span>
      <span className="max-w-28 truncate">{into.name}</span>
      <button type="button" aria-label="Start a new drawing" onClick={() => useSession.getState().select([])} className={cn(pod(), "size-6")}>
        <X />
      </button>
    </span>
  );
}

function VectorDraw() {
  return (
    <>
      <G>
        <DrawSwitch />
      </G>
      <Placement />
      <G>
        <DrawInto />
      </G>
      <VectorDrawTools />
    </>
  );
}

function PixelPaint() {
  return (
    <>
      <G>
        <DrawSwitch />
      </G>
      <PixelPaintTools />
    </>
  );
}

function Erase() {
  return (
    <>
      <G>
        <DrawSwitch />
      </G>
      <G>
        <Scope />
      </G>
    </>
  );
}

/**
 * THE BRUSH SCOPE, shown where the brush is: with something selected the
 * brush touches only that, with nothing selected whatever is under it. The
 * chip says which, and its × clears the selection to free the brush.
 */
function Scope() {
  const ids = useSession((s) => s.selectedClipIds);
  const only = ids.length === 1 ? ids[0]! : null;
  const onlyName = useDocSelector((d) => (only ? locateClip(d, only)?.clip.name : undefined));
  if (!ids.length) return <span className="px-1 text-2xs text-muted-foreground">Anything under the brush</span>;
  const name = only ? (onlyName ?? "1 layer") : `${ids.length} layers`;
  return (
    <span className="flex h-7 items-center gap-1 rounded-md border pl-2 pr-0.5 text-2xs">
      <span className="text-muted-foreground">Only</span>
      <span className="max-w-28 truncate">{name}</span>
      <button type="button" aria-label="Let the brush reach everything" onClick={() => useSession.getState().select([])} className={cn(pod(), "size-6")}>
        <X />
      </button>
    </span>
  );
}

function Fill() {
  return (
    <>
      <G>
        <DrawSwitch />
      </G>
      <FillColorTools />
    </>
  );
}

// ── Sculpt ───────────────────────────────────────────────────────────────────

const BRUSH_OPTIONS: ReadonlyArray<PickerOption<SculptBrush>> = SCULPT_BRUSHES.map((b) => ({ value: b.id, label: b.label, icon: SCULPT_ICON[b.id], detail: b.detail }));

/** A switch pod in the bar — a toggle with its name in the tooltip. */
function Toggle({ label, on, onClick, children }: { label: string; on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} aria-pressed={on} onClick={onClick} className={pod(on)}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function AxisToggle({ axis, on, onClick }: { axis: "X" | "Y" | "Z"; on: boolean; onClick: () => void }) {
  return (
    <Toggle label={`Mirror across ${axis}`} on={on} onClick={onClick}>
      <span className="font-mono text-2xs font-semibold">{axis}</span>
    </Toggle>
  );
}

/**
 * THE SCULPT BRUSH — which brush, how big, how hard, which way; then the
 * switches you arm once (falloff, mirror, front faces, what the pen's
 * pressure drives); then the one verb a shape needs before it can be
 * sculpted at all (detail).
 */
function Sculpt({ act }: { act: Actions }) {
  const s = useToolDefaults((t) => t.world.sculpt);
  const set = useToolDefaults((t) => t.setSculpt);
  const sym = (i: 0 | 1 | 2) => set({ symmetry: s.symmetry.map((v, k) => (k === i ? !v : v)) as [boolean, boolean, boolean] });
  return (
    <>
      <G>
        <PodPicker title="Brush" value={s.brush} options={BRUSH_OPTIONS} onChange={(brush) => set({ brush })} showLabel width="w-64" />
        <Scope />
      </G>
      <G>
        <Opt label="Radius">
          <Range className="w-28" value={s.radiusPx} min={2} max={600} step={1} onChange={(radiusPx) => set({ radiusPx })} aria-label="Radius" />
        </Opt>
        <Opt label="Strength">
          <Range className="w-24" value={s.strength} min={0} max={1} step={0.01} onChange={(strength) => set({ strength })} aria-label="Strength" />
        </Opt>
        {s.brush !== "smooth" && s.brush !== "grab" && (
          <IconSeg
            value={s.direction === 1 ? "add" : "sub"}
            onChange={(v) => set({ direction: v === "add" ? 1 : -1 })}
            options={[
              { v: "add", icon: Plus, label: "Add — ⌘ or Ctrl held subtracts" },
              { v: "sub", icon: Minus, label: "Subtract — ⌘ or Ctrl held adds" },
            ]}
          />
        )}
      </G>
      <G>
        <PodPicker title="Falloff" value={s.falloff} options={FALLOFF_OPTIONS} onChange={(falloff) => set({ falloff })} />
        <AxisToggle axis="X" on={s.symmetry[0]} onClick={() => sym(0)} />
        <AxisToggle axis="Y" on={s.symmetry[1]} onClick={() => sym(1)} />
        <AxisToggle axis="Z" on={s.symmetry[2]} onClick={() => sym(2)} />
        <Toggle label={s.frontOnly ? "Front faces only" : "Reaches through the shape"} on={s.frontOnly} onClick={() => set({ frontOnly: !s.frontOnly })}>
          <ScanEye />
        </Toggle>
        <Toggle label={`Pressure sets strength · ${s.pressureStrength ? "on" : "off"}`} on={s.pressureStrength} onClick={() => set({ pressureStrength: !s.pressureStrength })}>
          <Gauge />
        </Toggle>
        <Toggle label={`Pressure sets size · ${s.pressureRadius ? "on" : "off"}`} on={s.pressureRadius} onClick={() => set({ pressureRadius: !s.pressureRadius })}>
          <CircleDot />
        </Toggle>
      </G>
      <G>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={() => act.sculptDetail()} className={cn(pod(), "w-auto gap-1 px-2 text-xs")}>
              <Grid3x3 />
              Subdivide
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Smooth it into four times the points (⌘D)</TooltipContent>
        </Tooltip>
      </G>
    </>
  );
}

// ── Object tools ─────────────────────────────────────────────────────────────

const SHAPE_OPTIONS: ReadonlyArray<PickerOption<string>> = PRIMITIVES.map((p) => ({ value: p.id, label: p.label, icon: PRIM_ICON[p.id] ?? Box }));

function Shape() {
  const shape = useWorldUi((s) => s.shape);
  const set = useWorldUi((s) => s.set);
  return (
    <G>
      <PodPicker title="Shape" value={shape} options={SHAPE_OPTIONS} onChange={(v) => set({ shape: v })} showLabel />
    </G>
  );
}

function Verb({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} onClick={onClick} className={pod()}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function Cursor({ act }: { act: Actions }) {
  const set = useWorldUi((s) => s.set);
  return (
    <G>
      <Verb label="Cursor to the selection" onClick={act.cursorToSelected}>
        <LocateFixed />
      </Verb>
      <Verb label="Cursor to the world's origin" onClick={() => set({ cursor: [0, 0, 0] })}>
        <Home />
      </Verb>
      <Verb label="Selection to the cursor" onClick={act.selectionToCursor}>
        <Move />
      </Verb>
    </G>
  );
}

// ── Edit mode on a path ──────────────────────────────────────────────────────

/**
 * THE POINT BAR — editing a path in a world, the bar is the flat pen's: what
 * the nodes under your hand are and the verbs for them (core `node-verbs`),
 * whatever transform tool is armed. The common verbs are pods; the rest, the
 * ones this selection can use, are behind More.
 */
function PathPoints({ act }: { act: Actions }) {
  useWorldUi((s) => s.elementSel);
  useDoc();
  const sel = act.pointSelection();
  if (!sel) return null;
  const n = sel.nodeCount;
  const run = (id: NodeVerbId) => () => void act.pointVerbAt(id);
  const more: NodeVerbId[] = (["mirrorHandles", "break", "join", "toCurve", "toLine", "duplicateSeg", "deleteSeg", "close", "open", "selectRun", "reverse", "simplify"] as const).filter(
    (id) => NODE_VERBS[id].applies(sel) && (n > 0 || NODE_VERBS[id].wholePath),
  );
  return (
    <>
      <G>
        <span className="px-1 text-2xs text-muted-foreground tabular-nums">{n === 0 ? "Click or box points · ⌥ drag pulls handles" : n === 1 ? "1 point" : `${n} points`}</span>
      </G>
      {n > 0 && (
        <G>
          <IconSeg
            value={sel.type === "smooth" ? "smooth" : sel.type === "corner" ? "corner" : ""}
            onChange={(v) => void act.pointVerbAt(v as "smooth" | "corner")}
            options={[
              { v: "smooth", icon: Spline, label: "Smooth — double-click a point toggles (V)" },
              { v: "corner", icon: Triangle, label: "Corner" },
            ]}
          />
          <Verb label="Extrude — a new point from each (E)" onClick={() => void act.pathOps.extrude()}>
            <ArrowUpFromLine />
          </Verb>
          {n >= 2 && (
            <Verb label="Add points between (subdivide)" onClick={run("subdivide")}>
              <GitCommitHorizontal />
            </Verb>
          )}
          {n >= 2 && (
            <Verb label="Merge into one (M)" onClick={run("merge")}>
              <Combine />
            </Verb>
          )}
          <Verb label={n > 1 ? `Delete ${n} points (X)` : "Delete point (X)"} onClick={run("delete")}>
            <Trash2 />
          </Verb>
        </G>
      )}
      {more.length > 0 && (
        <G>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="More point actions" className={pod()}>
                <MoreHorizontal />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              {more.map((id) => (
                <DropdownMenuItem key={id} onClick={run(id)}>
                  {NODE_VERBS[id].label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </G>
      )}
    </>
  );
}

/** Tool → its options. One registry, one bar; a tool with no entry has no bar. */
const WORLD_TOOL_SECTIONS: Partial<Record<WorldTool, React.ComponentType<{ act: Actions }>>> = {
  cursor: Cursor,
  shape: Shape,
  text: TextSection,
  draw: VectorDraw,
  paint: PixelPaint,
  erase: Erase,
  fill: Fill,
  sculpt: Sculpt,
};

export function WorldToolBar({ act }: { act: Actions }) {
  const tool = useWorldUi((s) => s.tool);
  const kind = useEditedKind();
  // Editing a path, the bar is its points', whatever transform tool is armed.
  const Section = kind && editTargetKindOf(kind) === "path" && !WORLD_TOOL_SECTIONS[tool] ? PathPoints : WORLD_TOOL_SECTIONS[tool];
  if (!Section) return null;
  return (
    <BarCapsule measure>
      <Section act={act} />
    </BarCapsule>
  );
}

export type { WorldMode };
