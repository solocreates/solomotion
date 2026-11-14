"use client";

import * as React from "react";
import {
  ArrowUpFromLine,
  Combine,
  Axis3d,
  Box,
  Camera,
  PenTool,
  Cloud,
  Crop as CropIcon,
  Crosshair,
  GitCommitHorizontal,
  Lasso,
  Trash2,
  Eye,
  EyeOff,
  Flashlight,
  Globe,
  Grid3x3,
  Hand,
  Lightbulb,
  Magnet,
  MousePointer2,
  Move,
  Move3d,
  Bone,
  Plus,
  RectangleHorizontal,
  Rotate3d,
  Scaling,
  Slice,
  Spline,
  Split,
  SquareDashed,
  Brush,
  Eraser,
  PaintBucket,
  Waypoints,
  Sun,
  Type,
  Upload,
  ZoomIn,
} from "lucide-react";
import { FALLOFFS, PRIMITIVES, SCULPT_BRUSHES, locateClip, type Clip, type ElementMode, type LightType, type SculptBrush, type ShadingMode } from "@solomotion/core";
import { Range } from "@/components/ui/range";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useSession } from "../state/session";
import { useMods } from "../input/modifiers";
import { useEditedKind } from "./use-edited";
import { PRIM_ICON, SCULPT_ICON, WorldToolBar } from "./WorldToolBar";
import { WORLD_MODES } from "./tools";
import { useToolDefaults } from "../state/tool-defaults";
import { StageBrushHandle } from "../drawing/StageBrushHandle";
import { StageContextBar } from "../stage/StageContextBar";
import { useChromeFlyoutSide, type ChromeItem } from "../stage/StageChrome";
import { BarCapsule, G, IconSeg, MoreRow, PodMenu, PodPicker, RailCapsule, RailDivider, RailTool, ModeSeg, pod, type PickerOption } from "../stage/tool-bar-kit";
import { useWorldUi, type PivotMode, type WorldTool } from "./state";
import type { ViewportInfo, WorldViewport } from "./viewport/viewport";
import { editElementsOf, editTargetKindOf } from "./edit-targets";
import { useDocStore } from "../state/document-context";
import { ActivePivotIcon, CursorPivotIcon, EdgeIcon, FaceIcon, FalloffIcon, LockViewIcon, MaterialPreviewIcon, MedianPivotIcon, RenderedIcon, SolidIcon, VertexIcon, WireIcon } from "./viewport-icons";
import type { Actions } from "./WorldStage";
import { formatCombo, useCombo, type WorldCommandId } from "../state/shortcut-registry";

/**
 * THE 3D VIEWPORT'S CHROME — the flat stage's own grammar, holding Blender's
 * verbs.
 *
 * Every capsule here is a piece of the stage kit (`StageChrome` placements,
 * `BarCapsule`, `RailCapsule`, `PodPicker`, `PodMenu`), so a world reads as
 * part of the app rather than an embedded app: the same glass, the same armed
 * state (accent on the icon), the same corners, the same scroll behaviour when
 * the stage is short, in every theme. What is Blender's is the vocabulary —
 * object/edit, vertex/edge/face, orientation, pivot, snap, proportional,
 * shading, the navigation gizmo — and its keys.
 *
 *   top         Blender's header, in its three areas: the MODE on the left
 *               (back · Object/Edit · elements · Add), the TRANSFORM settings
 *               centred (orientation · pivot · snap · proportional), the VIEW
 *               on the right (overlays · grid · X-ray · shading)
 *   left        the tool rail
 *   right       the navigation gizmo, its round buttons hugging the edge
 *   bottom      where you are · what the armed tool or operator is doing
 */
export function worldChromeItems(p: {
  act: Actions;
  vpRef: React.RefObject<WorldViewport | null>;
  navRef: React.RefObject<HTMLCanvasElement | null>;
  info: ViewportInfo | null;
  nested: boolean;
}): ChromeItem[] {
  return [
    { id: "mode", edge: "top", align: "start", node: <ModeBar act={p.act} /> },
    { id: "transform", edge: "top", align: "center", node: <TransformBar /> },
    { id: "view", edge: "top", align: "end", node: <ViewBar act={p.act} /> },
    // The armed tool's own options, the line under the header — the flat
    // stage's tool bar, in a world (`WorldToolBar`). Absent for a tool with none.
    { id: "tool", edge: "top", align: "start", secondLine: true, node: <WorldToolBar act={p.act} /> },
    { id: "rail", edge: "left", align: "start", node: <WorldRail act={p.act} /> },
    { id: "nav", edge: "right", align: "start", node: <NavColumn act={p.act} vpRef={p.vpRef} navRef={p.navRef} /> },
    { id: "where", edge: "bottom", align: "start", node: p.nested ? <StageContextBar /> : <ViewInfo info={p.info} /> },
    { id: "hint", edge: "bottom", align: "center", node: <ToolHint /> },
    // The bottom of the right edge, not its middle: a centre occupant splits the
    // band into thirds, which left the navigation column a third of the stage
    // and scrolled its buttons half out of sight with no brush anywhere. It
    // renders itself away unless a brush (vector, pixel, eraser) is armed.
    { id: "brush", edge: "right", align: "end", node: <StageBrushHandle /> },
    { id: "stats", edge: "bottom", align: "end", node: p.nested ? <ViewInfo info={p.info} /> : <EditStats info={p.info} /> },
  ];
}

// ── Mode bar ─────────────────────────────────────────────────────────────────

const ELEMENTS: Array<{ v: ElementMode; icon: React.ComponentType<{ className?: string }>; label: string }> = [
  { v: "vertex", icon: VertexIcon, label: "Vertex select · 1" },
  { v: "edge", icon: EdgeIcon, label: "Edge select · 2" },
  { v: "face", icon: FaceIcon, label: "Face select · 3" },
];

/** Can the active layer be edited (has editable elements, and is not an imported model kept as its file)? */
function useEditable(): boolean {
  const store = useDocStore();
  const id = useSession((s) => s.selectedClipIds.at(-1) ?? null);
  const read = React.useCallback(() => {
    const clip = id ? locateClip(store.getState(), id)?.clip : null;
    if (!clip || editElementsOf(clip.kind).length === 0) return false;
    return !(clip.kind === "mesh" && clip.geometry.type === "asset");
  }, [store, id]);
  return React.useSyncExternalStore(store.subscribe, read, read);
}

/** The four modes as icon + word (D18). Edit borrows the vertex glyph: what you edit. */
const MODE_ICON: Record<(typeof WORLD_MODES)[number]["id"], React.ComponentType<{ className?: string }>> = {
  object: Box,
  edit: VertexIcon,
  sculpt: Hand,
  draw: PenTool,
};
const MODE_TIP: Record<(typeof WORLD_MODES)[number]["id"], string> = {
  object: "Move, rotate and scale whole objects",
  edit: "Edit points, edges and faces",
  sculpt: "Push and pull the surface",
  draw: "Draw strokes in space",
};

function ModeBar({ act }: { act: Actions }) {
  const mode = useWorldUi((s) => s.mode);
  const editable = useEditable();
  const elementMode = useWorldUi((s) => s.elementMode);
  const kind = useEditedKind();
  const elements = kind ? editElementsOf(kind) : [];
  const tabKey = useWorldKey("world.toggleEdit");
  const sculptKey = useWorldKey("world.modeSculpt");
  // D18: no back chevron (the breadcrumb navigates); the mode switch leads the
  // bar; a mode that cannot apply to the selection is HIDDEN, not greyed.
  const modes = WORLD_MODES.filter((m) => m.id !== "edit" || mode === "edit" || editable);
  return (
    <BarCapsule>
      <G>
        <ModeSeg
          value={mode}
          onChange={(m) => m !== mode && act.enterMode(m)}
          options={modes.map((m) => ({
            v: m.id,
            icon: MODE_ICON[m.id],
            label: m.label,
            tip: MODE_TIP[m.id],
            kbd: m.id === "object" || m.id === "edit" ? tabKey : m.id === "sculpt" ? sculptKey : undefined,
          }))}
        />
      </G>
      {mode === "edit" ? (
        // Only the element modes this thing has: a path is points, nothing else.
        elements.length > 1 && (
          <G>
            <IconSeg value={elementMode} onChange={act.setElementMode} options={ELEMENTS.filter((e) => elements.includes(e.v))} />
          </G>
        )
      ) : mode === "object" ? (
        <G>
          <AddMenu act={act} />
        </G>
      ) : null}
    </BarCapsule>
  );
}

function AddMenu({ act }: { act: Actions }) {
  const side = useChromeFlyoutSide();
  const addKey = useWorldKey("world.add");
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button type="button" className={cn(pod(), "w-auto gap-1 px-2 text-xs")}>
              <Plus />
              Add
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side={side}>
          Add an object <kbd className="ml-1 rounded bg-secondary px-1 font-mono text-2xs">{addKey}</kbd>
        </TooltipContent>
      </Tooltip>
      {/* No focus return: an added text opens its own field, and handing focus
          back to this button would close it. */}
      <DropdownMenuContent side={side} align="start" className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
        <AddItems act={act} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const LIGHTS: Array<{ type: LightType; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { type: "point", label: "Point", icon: Lightbulb },
  { type: "sun", label: "Sun", icon: Sun },
  { type: "spot", label: "Spot", icon: Flashlight },
  { type: "area", label: "Area", icon: RectangleHorizontal },
  { type: "hemisphere", label: "Sky light", icon: Cloud },
  { type: "environment", label: "Studio", icon: Globe },
];

/** The ⇧A list — the header's Add, the menu at the pointer and right-click share it. */
export function AddItems({ act }: { act: Actions }) {
  return (
    <>
      <DropdownMenuLabel className="label-section">Mesh</DropdownMenuLabel>
      {PRIMITIVES.map((p) => {
        const Icon = PRIM_ICON[p.id] ?? Box;
        return (
          <DropdownMenuItem key={p.id} onSelect={() => act.add.primitive(p.id)}>
            <Icon className="size-3.5" /> {p.label}
          </DropdownMenuItem>
        );
      })}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={act.add.text}>
        <Type className="size-3.5" /> Text
      </DropdownMenuItem>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Lightbulb className="size-3.5" /> Light
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {LIGHTS.map((l) => (
            <DropdownMenuItem key={l.type} onSelect={() => act.add.light(l.type)}>
              <l.icon className="size-3.5" /> {l.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuItem onSelect={act.add.camera}>
        <Camera className="size-3.5" /> Camera
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={act.add.controller}>
        <Move3d className="size-3.5" /> Controller
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={act.add.importModel}>
        <Upload className="size-3.5" /> Import model…
      </DropdownMenuItem>
    </>
  );
}

// ── View bar ─────────────────────────────────────────────────────────────────

const ORIENTATIONS: ReadonlyArray<PickerOption<"global" | "local">> = [
  { value: "global", label: "Global", icon: Globe, detail: "Along the world's own axes" },
  { value: "local", label: "Local", icon: Axis3d, detail: "Along the object's own axes" },
];

const PIVOTS: ReadonlyArray<PickerOption<Exclude<PivotMode, "origins">>> = [
  { value: "median", label: "Median point", icon: MedianPivotIcon, detail: "The middle of the selection" },
  { value: "cursor", label: "3D cursor", icon: CursorPivotIcon, detail: "Where the cursor is (⇧ right-click places it)" },
  { value: "active", label: "Active object", icon: ActivePivotIcon, detail: "The one selected last" },
];

const FALLOFF_LABEL: Record<(typeof FALLOFFS)[number], string> = {
  smooth: "Smooth",
  sphere: "Sphere",
  root: "Root",
  linear: "Linear",
  sharp: "Sharp",
  constant: "Constant",
};

const SHADING: Array<{ v: ShadingMode; icon: React.ComponentType<{ className?: string }>; label: string }> = [
  { v: "wireframe", icon: WireIcon, label: "Wireframe · Z" },
  { v: "solid", icon: SolidIcon, label: "Solid · Z" },
  { v: "material", icon: MaterialPreviewIcon, label: "Material preview · Z" },
  { v: "rendered", icon: RenderedIcon, label: "Rendered · Z" },
];

/** How a move, turn or scale is aimed — Blender's centred header group. */
function TransformBar() {
  const ui = useWorldUi();
  const mods = useMods();
  const pivot = ui.pivot === "origins" ? "median" : ui.pivot;
  // Moving, turning and scaling are Object and Edit mode's; a brush has its own row.
  if (ui.mode !== "object" && ui.mode !== "edit") return null;
  return (
    <BarCapsule>
      <G>
        <PodPicker title="Orientation" value={ui.orientation} options={ORIENTATIONS} onChange={(v) => ui.set({ orientation: v })} />
        <PodPicker title="Pivot point" value={pivot} options={PIVOTS} onChange={(v) => ui.set({ pivot: v })} />
        {/* Holding Ctrl inverts snapping while you drag — so the pod shows the
            EFFECTIVE state, live, not only the stored one. */}
        <PodMenu icon={<Magnet />} label="Snap to grid" detail={ui.snap ? "on · hold Ctrl to bypass" : "off · hold Ctrl to snap"} armed={ui.snap !== mods.meta} onToggle={() => ui.set({ snap: !ui.snap })}>
          <MoreRow label="Grid">
            <span className="text-xs tabular-nums text-muted-foreground">
              {ui.gridSize / ui.gridDivisions} u steps
            </span>
          </MoreRow>
        </PodMenu>
        {ui.mode === "edit" && (
          <PodMenu
            icon={<FalloffIcon kind={ui.propFalloff} />}
            label="Proportional editing"
            detail={ui.proportional ? `${FALLOFF_LABEL[ui.propFalloff]} · O` : "off · O"}
            armed={ui.proportional}
            onToggle={() => ui.set({ proportional: !ui.proportional })}
            width="w-64"
          >
            <div className="grid grid-cols-3 gap-1">
              {FALLOFFS.map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={ui.propFalloff === f}
                  onClick={() => ui.set({ propFalloff: f, proportional: true })}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-md py-1.5 text-2xs transition-colors [&_svg]:size-5",
                    ui.propFalloff === f ? "material-glass-raised text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <FalloffIcon kind={f} />
                  {FALLOFF_LABEL[f]}
                </button>
              ))}
            </div>
            <MoreRow label="Reach">
              <Range className="w-32" value={ui.propRadius} min={10} max={2000} step={5} onChange={(v) => ui.set({ propRadius: v })} aria-label="Reach" />
            </MoreRow>
          </PodMenu>
        )}
      </G>
    </BarCapsule>
  );
}

/** What the view shows and how it is shaded — Blender's right-hand header group. */
function ViewBar({ act }: { act: Actions }) {
  const ui = useWorldUi();
  const side = useChromeFlyoutSide();
  const toggle = (label: string, on: boolean, flip: () => void, icon: React.ReactNode, key?: string) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} aria-pressed={on} className={pod(on)} onClick={flip}>
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        {key && <kbd className="ml-1.5 rounded bg-secondary px-1 font-mono text-2xs">{key}</kbd>}
      </TooltipContent>
    </Tooltip>
  );
  return (
    <BarCapsule>
      <G>
        {toggle("Overlays", ui.overlays, () => ui.set({ overlays: !ui.overlays }), ui.overlays ? <Eye /> : <EyeOff />)}
        {toggle("Floor grid", ui.grid, () => ui.set({ grid: !ui.grid }), <Grid3x3 />)}
        {toggle("Motion paths", ui.motionPaths, () => ui.set({ motionPaths: !ui.motionPaths }), <Waypoints />)}
        {toggle("X-ray", ui.xray, () => ui.set({ xray: !ui.xray }), <SquareDashed />, "Alt Z")}
      </G>
      <G>
        <IconSeg value={ui.shading} onChange={act.shading} options={SHADING} />
      </G>
    </BarCapsule>
  );
}

// ── Tool rail ────────────────────────────────────────────────────────────────

/** A 3D command's key as the registry has it now — the hint follows the keymap and your edits. */
function useWorldKey(id: WorldCommandId | undefined): string {
  const combo = useCombo(id ?? "");
  return id ? formatCombo(combo.split(" ")[0] ?? "") : "";
}

/** A rail tool whose hint is a registry command's key. */
function KeyedRailTool({ cmd, shortcut, ...rest }: React.ComponentProps<typeof RailTool> & { cmd?: WorldCommandId }) {
  const key = useWorldKey(cmd);
  return <RailTool {...rest} shortcut={cmd ? key : shortcut} />;
}

const TRANSFORM_TOOLS: Array<{ id: WorldTool; label: string; cmd?: WorldCommandId; key?: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "select", label: "Select", cmd: "world.toolSelect", icon: MousePointer2 },
  { id: "cursor", label: "3D cursor", key: "⇧ right-click", icon: Crosshair },
  { id: "move", label: "Move", cmd: "world.grab", icon: Move },
  { id: "rotate", label: "Rotate", cmd: "world.rotate", icon: Rotate3d },
  { id: "scale", label: "Scale", cmd: "world.scale", icon: Scaling },
];

/**
 * THE RAIL IS THE MODE'S. Object: transform tools, then what a click places
 * and what you add. Edit: transform tools, then the polygon (or point)
 * verbs. Sculpt: the brushes, as the flat rail shows its two brushes — one
 * tool, a material each. Draw: the flat canvas's brush family.
 */
function WorldRail({ act }: { act: Actions }) {
  const mode = useWorldUi((s) => s.mode);
  return <RailCapsule>{mode === "sculpt" ? <SculptRail act={act} /> : mode === "draw" ? <DrawRail /> : <ModelRail act={act} />}</RailCapsule>;
}

function SculptRail({ act }: { act: Actions }) {
  const brush = useToolDefaults((s) => s.world.sculpt.brush);
  const setSculpt = useToolDefaults((s) => s.setSculpt);
  const set = useWorldUi((s) => s.set);
  const tool = useWorldUi((s) => s.tool);
  return (
    <>
      {SCULPT_BRUSHES.map((b) => {
        const Icon = SCULPT_ICON[b.id];
        return (
          <KeyedRailTool
            key={b.id}
            label={`${b.label} — ${b.detail}`}
            cmd={SCULPT_KEY[b.id]}
            active={tool === "sculpt" && brush === b.id}
            onClick={() => {
              setSculpt({ brush: b.id });
              set({ tool: "sculpt" });
            }}
          >
            <Icon />
          </KeyedRailTool>
        );
      })}
      <RailDivider />
      <KeyedRailTool label="Subdivide — four times the points" cmd="world.sculptDetail" onClick={() => act.sculptDetail()}>
        <Grid3x3 />
      </KeyedRailTool>
    </>
  );
}

const DRAW_RAIL: Array<{ id: WorldTool; label: string; cmd: WorldCommandId; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "draw", label: "Vector brush — strokes you can edit, fill and animate", cmd: "world.toolDraw", icon: Spline },
  { id: "paint", label: "Pixel brush — on surfaces and drawing layers", cmd: "world.toolPaint", icon: Brush },
  { id: "erase", label: "Eraser — removes the strokes it passes over", cmd: "world.toolErase", icon: Eraser },
  { id: "fill", label: "Fill — a closed drawing, or an object's colour", cmd: "world.toolFill", icon: PaintBucket },
];

function DrawRail() {
  const tool = useWorldUi((s) => s.tool);
  const set = useWorldUi((s) => s.set);
  return (
    <>
      {DRAW_RAIL.map((t) => (
        <KeyedRailTool key={t.id} label={t.label} cmd={t.cmd} active={tool === t.id} onClick={() => set({ tool: t.id })}>
          <t.icon />
        </KeyedRailTool>
      ))}
    </>
  );
}

function ModelRail({ act }: { act: Actions }) {
  const tool = useWorldUi((s) => s.tool);
  const boneXray = useWorldUi((s) => s.boneXray);
  const shape = useWorldUi((s) => s.shape);
  const mode = useWorldUi((s) => s.mode);
  const kind = useEditedKind();
  const editKind = kind ? editTargetKindOf(kind) : null;
  const set = useWorldUi((s) => s.set);
  const ShapeIcon = PRIM_ICON[shape] ?? Box;
  const shapeLabel = PRIMITIVES.find((p) => p.id === shape)?.label ?? "Shape";
  return (
    <>
      {/* Edit mode offers only what acts on its points: no 3D cursor, no adds. */}
      {TRANSFORM_TOOLS.filter((t) => mode === "object" || t.id !== "cursor").map((t) => (
        <KeyedRailTool key={t.id} label={t.label} cmd={t.cmd} shortcut={t.key} active={tool === t.id} onClick={() => set({ tool: t.id })}>
          <t.icon />
        </KeyedRailTool>
      ))}
      <RailDivider />
      {mode === "object" ? (
        <>
          <RailTool label={`${shapeLabel} — click to place`} active={tool === "shape"} onClick={() => set({ tool: "shape" })}>
            <ShapeIcon />
          </RailTool>
          <KeyedRailTool label="Text — click to place" cmd="world.toolText" active={tool === "text"} onClick={() => set({ tool: "text" })}>
            <Type />
          </KeyedRailTool>
          <RailTool
            label="Bone — draw a skeleton, extrude (E), move joints; X-ray while you build"
            active={tool === "bone"}
            onClick={() => set({ tool: tool === "bone" ? "select" : "bone" })}
            more={
              <div className="w-48 space-y-0.5 p-1 text-xs">
                <button type="button" className="flex w-full items-center justify-between rounded px-2 py-1 hover:bg-accent" onClick={() => set({ boneXray: !boneXray })}>
                  X-ray while rigging <span className="text-muted-foreground">{boneXray ? "On" : "Off"}</span>
                </button>
              </div>
            }
          >
            <Bone />
          </RailTool>
          <RailDivider />
          <RailTool
            label="Add a light"
            more={
              <div className="w-44 space-y-0.5">
                {LIGHTS.map((l) => (
                  <button key={l.type} type="button" onClick={() => act.add.light(l.type)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5">
                    <l.icon /> {l.label}
                  </button>
                ))}
              </div>
            }
          >
            <Lightbulb />
          </RailTool>
          <RailTool label="Camera from this view" onClick={act.add.camera}>
            <Camera />
          </RailTool>
          <RailTool label="Import a model (glTF, OBJ, FBX, STL, PLY)" onClick={act.add.importModel}>
            <Upload />
          </RailTool>
        </>
      ) : editKind === "path" ? (
        <>
          {/* The pen's own verbs (core node-verbs), on the nodes selected here. */}
          <KeyedRailTool label="Smooth / corner — or double-click a point" cmd="world.pointType" onClick={act.pathOps.toggleSmooth}>
            <Spline />
          </KeyedRailTool>
          <KeyedRailTool label="Extrude — a new point from each selected one" cmd="world.extrude" onClick={act.pathOps.extrude}>
            <ArrowUpFromLine />
          </KeyedRailTool>
          <RailTool label="Add points between the selected" onClick={act.pathOps.subdivide}>
            <GitCommitHorizontal />
          </RailTool>
          <KeyedRailTool label="Merge the selected into one" cmd="world.merge" onClick={act.pathOps.merge}>
            <Combine />
          </KeyedRailTool>
          <KeyedRailTool label="Join two ends — or close / open the line" cmd="world.fill" onClick={act.pathOps.makeSegment}>
            <Lasso />
          </KeyedRailTool>
          <KeyedRailTool label="Delete points" cmd="world.delete" onClick={act.pathOps.delete}>
            <Trash2 />
          </KeyedRailTool>
        </>
      ) : editKind === "crop" ? (
        <RailTool label="Reset crop" onClick={act.cropOps.reset}>
          <CropIcon />
        </RailTool>
      ) : (
        <>
          <KeyedRailTool label="Extrude" cmd="world.extrude" onClick={act.ops.extrude}>
            <ArrowUpFromLine />
          </KeyedRailTool>
          <KeyedRailTool label="Inset faces" cmd="world.inset" onClick={act.ops.inset}>
            <SquareDashed />
          </KeyedRailTool>
          <KeyedRailTool label="Loop cut" cmd="world.loopCut" onClick={act.ops.loopCut}>
            <Slice />
          </KeyedRailTool>
          <KeyedRailTool label="Knife — drag across the shape" cmd="world.toolKnife" active={tool === "knife"} onClick={() => set({ tool: "knife" })}>
            <Split />
          </KeyedRailTool>
        </>
      )}
    </>
  );
}

const SCULPT_KEY: Record<SculptBrush, WorldCommandId> = {
  draw: "world.sculptDraw",
  clay: "world.sculptClay",
  inflate: "world.sculptInflate",
  crease: "world.sculptCrease",
  smooth: "world.sculptSmooth",
  flatten: "world.sculptFlatten",
  pinch: "world.sculptPinch",
  grab: "world.sculptGrab",
};

// ── Navigation ───────────────────────────────────────────────────────────────

export const NAV_SIZE = 88;

/**
 * The gizmo, and under it the navigation buttons — each its own round glass
 * button, Blender's way, in a column that hugs the stage's right edge (the
 * band aligns its occupants to the edge they dock to, never to the middle of
 * the gizmo above them).
 */
function NavColumn({ act, vpRef, navRef }: { act: Actions; vpRef: React.RefObject<WorldViewport | null>; navRef: React.RefObject<HTMLCanvasElement | null> }) {
  const throughCamera = useWorldUi((s) => s.throughCamera);
  const lockCamera = useWorldUi((s) => s.lockCamera);
  return (
    <div className="flex min-h-0 flex-col items-end gap-2">
      <canvas
        ref={navRef}
        style={{ width: NAV_SIZE, height: NAV_SIZE }}
        className="shrink-0 cursor-pointer touch-none"
        onPointerDown={(e) => act.nav.down(e, "orbit")}
        onPointerMove={act.nav.move}
        onPointerUp={act.nav.up}
        onPointerCancel={act.nav.up}
        onPointerLeave={act.nav.leave}
        aria-label="Navigation gizmo — drag to orbit, click an axis to look along it"
      />
      {/* The buttons scroll, inside the column, when the stage is short. */}
      <div className="-mr-0.5 -my-1 flex min-h-0 flex-col items-end gap-1.5 overflow-y-auto py-1 pr-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <NavButton label="Drag to zoom" onPointerDown={(e) => act.nav.down(e, "zoom")} act={act}>
          <ZoomIn />
        </NavButton>
        <NavButton label="Drag to pan" onPointerDown={(e) => act.nav.down(e, "pan")} act={act}>
          <Hand />
        </NavButton>
        <NavButton label="Look through the camera" cmd="world.cameraView" active={throughCamera} onClick={() => vpRef.current?.toggleCameraView()} act={act}>
          <Camera />
        </NavButton>
        {throughCamera && (
          <NavButton label="Lock camera to view — navigating moves the camera" active={lockCamera} onClick={() => vpRef.current?.setCameraLock(!lockCamera)} act={act}>
            <LockViewIcon />
          </NavButton>
        )}
        <NavButton label="Perspective / orthographic" cmd="world.perspective" onClick={act.togglePerspective} act={act}>
          <Grid3x3 />
        </NavButton>
      </div>
    </div>
  );
}

/** One round navigation button: a click (camera, ortho) or a drag handle (zoom, pan). */
function NavButton({
  label,
  cmd,
  active,
  onClick,
  onPointerDown,
  act,
  children,
}: {
  label: string;
  cmd?: WorldCommandId;
  active?: boolean;
  onClick?: () => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  act: Actions;
  children: React.ReactNode;
}) {
  const side = useChromeFlyoutSide();
  const drag = !!onPointerDown;
  const shortcut = useWorldKey(cmd);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          onPointerDown={onPointerDown}
          onPointerMove={drag ? act.nav.move : undefined}
          onPointerUp={drag ? act.nav.up : undefined}
          onPointerCancel={drag ? act.nav.up : undefined}
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors [&_svg]:size-4",
            active ? "material-glass-raised text-primary" : "material-glass text-muted-foreground hover:text-foreground",
            drag && "cursor-grab touch-none active:cursor-grabbing",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} sideOffset={8} className="flex items-center gap-1.5">
        {label}
        {shortcut && <kbd className="rounded bg-secondary px-1 font-mono text-2xs">{shortcut}</kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

// ── Status ───────────────────────────────────────────────────────────────────

/** Which view, which object — Blender's corner text, as a quiet label on the stage. */
function ViewInfo({ info }: { info: ViewportInfo | null }) {
  const mode = useWorldUi((s) => s.mode);
  if (!info) return null;
  return (
    <div className="pointer-events-none select-none px-1 text-2xs text-muted-foreground">
      {info.label}
      {info.objectName && <span className="text-foreground/80"> · {info.objectName}</span>}
      {mode !== "object" && <span className="text-primary"> · {WORLD_MODES.find((m) => m.id === mode)?.label}</span>}
    </div>
  );
}

/** Counts only where they mean something: while editing polygons. */
function EditStats({ info }: { info: ViewportInfo | null }) {
  const mode = useWorldUi((s) => s.mode);
  if (mode !== "edit" || !info?.stats) return null;
  return <div className="pointer-events-none select-none px-1 text-2xs tabular-nums text-muted-foreground">{info.stats}</div>;
}

const TOOL_HINT: Partial<Record<WorldTool, string>> = {
  knife: "Drag a line across the shape · Esc for Select",
  text: "Click to place text · click a text to edit it",
  shape: "Click to place",
  cursor: "Click to place the 3D cursor",
  bone: "Drag to draw a bone on the 3D cursor's plane · drag a tip to extrude · E extrudes the active bone · G R S + X Y Z · Esc for Select",
  fill: "Tap inside a drawing, or on an object",
};

/** What the armed operator or tool is doing — one line, bottom centre, only while it matters. */
function ToolHint() {
  const hud = useWorldUi((s) => s.hud);
  const tool = useWorldUi((s) => s.tool);
  const text = hud ?? TOOL_HINT[tool];
  if (!text) return null;
  return <div className={cn("pointer-events-none select-none rounded-lg px-2.5 py-1 text-xs material-glass", hud && "font-mono")}>{text}</div>;
}
