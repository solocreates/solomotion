"use client";

import * as React from "react";
import {
  Combine,
  CopyPlus,
  FilePlus2,
  Gauge,
  Lasso,
  Waves,
  Sparkles,
  Paintbrush2,
  PenTool,
  Scissors,
  FlaskConical,
  Settings2,
  SlidersHorizontal,
  Square,
  SquareDashed,
  SquareDashedMousePointer,
  SquareDot,
  SquareMinus,
  SquarePlus,
  Trash2,
  Waypoints,
  Fan,
} from "lucide-react";
import {
  DEFAULT_FREEHAND_FIDELITY,
  DEFAULT_PATH_FIDELITY,
  activeStageFrame,
  paintContextAt,
  resolveStrokeTargets,
  type CaptureSeed,
  type MaskCombine,
  type PathFidelity,
  type VectorEraseMode,
  type VectorLassoMode,
} from "@solomotion/core";
import { NumberInput } from "@/components/ui/number-input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { G, IconSeg, Opt, pod } from "../stage/tool-bar-kit";
import { PaintScopeStrip } from "./PaintScopePods";
import { DocColorInput } from "../inspector/DocColorInput";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { useHoldMenu } from "../state/use-hold-menu";
import { OnionPod } from "./OnionPod";
import { useBrushThumb } from "./brush-thumbs";
import { hasWetPaint, onSurfaceReady } from "./raster-store";
import { dryWetPaint } from "./wet-actions";
import { useBrushLibrary, useDrawing, type BrushSlot, type LayerScope } from "./drawing-store";
import { FidelityFields, SMOOTHING_ON } from "./FidelityFields";
import { PaintSettings, useOpenPaintSettings, usePaintSettings } from "./PaintSettings";
import { useHandleCarriesDials, usePaintDials } from "./paint-dials";

/**
 * The paint tools' colour slot — variable-safe, like every other colour in the
 * app.
 *
 * It was a bare `ColorInput`, which is the one colour control in the codebase
 * that cannot hold a `var:` token. So a brush loaded from a palette variable
 * painted a literal and the artwork stopped following the palette the moment it
 * was made — silently, and only for the paint tools. `DocColorInput` is the
 * app's one bound slot (`useColorVariableBinding`), so a vector stroke or fill
 * stores the TOKEN and retints with the variable forever. Pixels are pixels and
 * bake the resolved colour at the moment they are laid down; that is a property
 * of bitmaps, not a gap here.
 */
function PaintColorInput({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  // A BADGE, like every other colour on a tool bar. It was a 128px field
  // printing `F4F2ED  100 %` — sixty pixels of hex nobody reads at 11px over
  // artwork, on the one strip in the app where width is the scarce resource.
  // Same picker, same variable binding, same alpha (in the picker's own track).
  return <DocColorInput variant="badge" value={value} onChange={onChange} />;
}

/**
 * THE PAINT TOOLS' SECTIONS of the stage tool bar.
 *
 * The bar itself, and the registry that decides which section an armed tool
 * gets, live in `stage/ToolOptionsBar.tsx` — it is stage chrome, and it serves
 * the pen, the shapes and the type tool too. This file is only the paint
 * family's contribution to it, which is why it sits beside the drawing store
 * it reads.
 *
 * Every section here is a sequence of `<G>` zones and nothing else. A zone that
 * renders no controls disappears and takes its separator with it — see the
 * separator law in `globals.css`. No section may emit a divider of its own; the
 * hand-placed `<Divider />` this file used to be full of is what produced the
 * doubled hairlines and the lines against nothing.
 */

/** "This layer / All layers" — the one scope switch every multi-layer tool shares. */
function ScopeSwitch({ value, onChange }: { value: LayerScope; onChange: (v: LayerScope) => void }) {
  return (
    <div className="flex h-7 overflow-hidden rounded-md border">
      {(["current", "all"] as const).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          className={cn(
            "px-2 text-[10px] transition-colors",
            value === s ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {s === "current" ? "This layer" : "All layers"}
        </button>
      ))}
    </div>
  );
}

/** One pressure-response editor row (shared by the size and opacity blocks). */
/**
 * The pressure pod — click toggles sensitivity on and off (the everyday move),
 * hold or right-click jumps to the Pen tab of the settings sheet. It carries no
 * popover of its own any more: the response curves belong beside the other
 * advanced settings, behind the one visible door, rather than in a third place
 * only a hold gesture could reach.
 */
/**
 * WHAT THE BRUSH HANDLE HAS TAKEN OVER — shown here only while the handle is
 * not up.
 *
 * Smoothing and pen pressure are the armed tool's two everyday switches, and
 * they now sit together in the handle's mode row, under the hand that is
 * already drawing. Repeating them across the top of the screen bought a slower
 * route to the same fact and cost the bar two of the slots its actual job — the
 * MODES you arm once — had been squeezed out of.
 *
 * Not deleted, because the handle can be hidden. `useHandleCarriesDials` is the
 * one question both surfaces ask, so the two can never both show or both hide.
 */
function HandOff({ children }: { children: React.ReactNode }) {
  return useHandleCarriesDials() ? null : <>{children}</>;
}

function PressurePod() {
  const enabled = useDrawing((s) => s.pressure.enabled);
  const setPressure = useDrawing((s) => s.setPressure);
  const openSettings = useOpenPaintSettings();
  const hold = useHoldMenu(() => openSettings?.("pressure"));

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Pen pressure — click to toggle, hold for settings"
          aria-pressed={enabled}
          {...hold.bind}
          onClick={() => {
            if (hold.guard()) return; // a hold opened the sheet — skip the toggle
            setPressure({ enabled: !enabled });
          }}
          className={pod(enabled)}
        >
          <Gauge />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Pen pressure {enabled ? "on" : "off"}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The only two choices recording a drawing actually needs, in the bar that is
 * already there: what a NEW frame starts from, and whether you can see the
 * frames around it.
 *
 * Shown only while Record is armed, because that is the only time a new frame
 * can be born — with record off there is no choice to present, and a control
 * that is always visible to say nothing is how a toolbar turns into noise.
 * Vector layers skip the seed switch: their frames are `geometry` keys, and a
 * new key always starts from the outline on screen.
 */
function FrameOptions() {
  const recording = useSession((s) => s.recording);
  const engine = useDrawing((s) => s.brush.engine);
  const tool = useSession((s) => s.tool);
  const seed = useDrawing((s) => s.capture.seed);
  const setCapture = useDrawing((s) => s.setCapture);
  if (!recording) return null;
  const vector = tool === "brush" && engine === "vector";
  return (
    <G>
      {!vector && (
        <IconSeg
          value={seed}
          onChange={(s2: CaptureSeed) => setCapture({ seed: s2 })}
          options={[
            { v: "continue", icon: CopyPlus, label: "New frames continue the one before" },
            { v: "blank", icon: FilePlus2, label: "New frames start empty" },
          ]}
        />
      )}
      <OnionPod />
    </G>
  );
}

// ── Brush options ───────────────────────────────────────────────────────────

/**
 * The brush trigger — a live mini preview of what this tool will paint,
 * opening THE brush library window.
 *
 * The picker used to be a popover of two-across cards, which was right for
 * eight brushes and wrong for ninety: a 56px tile cannot show you a taper, and
 * a popover that dismisses on an outside click cannot survive you opening the
 * studio to look closer. Both of those are the library window's job now, and
 * this is what is left — the smallest honest answer to "what am I holding".
 */
function BrushPicker({ slot }: { slot: BrushSlot }) {
  const lib = useBrushLibrary();
  const pressure = useDrawing((s) => s.pressure);
  const activeId = lib.activeBrushId(slot);
  const active = lib.brushById(activeId);
  const eff = lib.effective(activeId);
  const open = lib.librarySlot === slot;
  const thumb = useBrushThumb(
    active ? { brush: active, width: 84, height: 28, size: eff.size, opacity: eff.opacity, pressure } : null,
  );

  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => lib.openLibrary(open ? null : slot)}
      onDoubleClick={() => active && lib.openStudio(active.id)}
      title={active ? `${active.name} — click to browse, double-click to edit` : "Choose a brush"}
      className={cn(
        "flex h-7 items-center gap-1.5 overflow-hidden rounded-md border pr-2 text-xs transition-colors",
        open ? "material-glass-raised" : "hover:bg-accent",
      )}
    >
      {/* The tile is the theme's own field well, never a fixed near-black: the
          thumbnail is drawn in the theme's FOREGROUND (`brush-thumbs`), so on a
          light theme a dark tile put a dark stroke on a dark square. */}
      <span className="h-6 w-9 shrink-0 bg-input">
        {thumb && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" draggable={false} className="h-6 w-9 object-cover" />
        )}
      </span>
      <span className="max-w-24 truncate">{active?.name ?? "Brush"}</span>
      {lib.isCustomized(activeId) && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
    </button>
  );
}

/**
 * BRUSH — what you are holding, what colour, and where it may go.
 *
 * Size and opacity are deliberately NOT here. They live on the brush handle at
 * the canvas edge, under the hand that is already drawing (`StageBrushHandle`),
 * which is the whole reason that control exists; duplicating them up here cost
 * the bar its width and bought a slower way to do the same thing. The bar's job
 * is the MODES — armed once, then forgotten — and until now it had no room for
 * a single one of them.
 */
export function BrushSection() {
  const brush = useDrawing((s) => s.brush);
  const setBrush = useDrawing((s) => s.setBrushOptions);

  return (
    <>
      <G>
        <DryPod />
      </G>
      <G>
        <BrushPicker slot={brush.engine} />
        <PaintColorInput value={brush.color} onChange={(color) => setBrush({ color })} />
      </G>
      <G>
        <HandOff>
          <FidelityPod
            value={brush.fidelity}
            onChange={(f) => setBrush({ fidelity: { ...brush.fidelity, ...f } })}
            geometry={brush.engine === "vector"}
            fallback={DEFAULT_FREEHAND_FIDELITY}
          />
          <PressurePod />
        </HandOff>
      </G>
      <PaintScopeStrip merge={brush.engine === "vector"} />
      <FrameOptions />
    </>
  );
}

/**
 * THE VECTOR BRUSH WHERE THERE ARE NO PIXELS — a 3D world's Draw. The brush
 * bar's own pods (which brush, its colour, its smoothing and point density, its
 * pressure), without the flat canvas's: there is no pixel layer to scope to and
 * no flipbook to hold, and a world always draws vector lines.
 */
export function VectorDrawSection() {
  const brush = useDrawing((s) => s.brush);
  const setBrush = useDrawing((s) => s.setBrushOptions);
  return (
    <>
      <G>
        <BrushPicker slot="vector" />
        <PaintColorInput value={brush.color} onChange={(color) => setBrush({ color })} />
      </G>
      <G>
        <HandOff>
          <FidelityPod
            value={brush.fidelity}
            onChange={(f) => setBrush({ fidelity: { ...brush.fidelity, ...f } })}
            geometry
            fallback={DEFAULT_FREEHAND_FIDELITY}
          />
          <PressurePod />
        </HandOff>
      </G>
    </>
  );
}

/**
 * The pixel brush's bar for a 3D world's Paint — the flat brush bar's pods for
 * the raster slot, without the frame and scope pods (a stroke in space lands
 * on the drawing layer it is aimed at).
 */
export function PixelPaintSection() {
  const brush = useDrawing((s) => s.brush);
  const setBrush = useDrawing((s) => s.setBrushOptions);
  return (
    <>
      <G>
        <BrushPicker slot="raster" />
        <PaintColorInput value={brush.color} onChange={(color) => setBrush({ color })} />
      </G>
      <G>
        <HandOff>
          <FidelityPod
            value={brush.fidelity}
            onChange={(f) => setBrush({ fidelity: { ...brush.fidelity, ...f } })}
            geometry={false}
            fallback={DEFAULT_FREEHAND_FIDELITY}
          />
          <PressurePod />
        </HandOff>
      </G>
    </>
  );
}

// ── Fidelity: one control, every tool that makes vector geometry ────────────

/**
 * The FIDELITY pod — hand stabilising and point density, in one place, for
 * every tool that turns a gesture into vector geometry.
 *
 * It is one component over one `PathFidelity` value because the three tools ask
 * the same question and used to answer it three ways (or not at all): the
 * eraser handed a boolean's raw vertices to the document, the lasso did the
 * same, and the vector brush's density was buried in the Brush Studio. Each
 * section owns WHERE its value is stored; the control, the ranges and the
 * warning are written once.
 */
function FidelityPod({
  value,
  onChange,
  geometry = true,
  fallback = DEFAULT_PATH_FIDELITY,
}: {
  value: PathFidelity;
  onChange: (patch: Partial<PathFidelity>) => void;
  /** False for the pixel brush: it stabilises, but it makes no anchors. */
  geometry?: boolean;
  /** This tool's shipped default — the notch, and what double-click restores. */
  fallback?: PathFidelity;
}) {
  // A paint tool has a settings sheet and the smoothing fields live in it; the
  // lasso and the pen have no sheet, so the pod shows the SAME fields itself.
  // One body, two hosts — the alternative was a second copy for the tools that
  // are not brushes, and it is the copy that would have gone stale.
  const openSettings = useOpenPaintSettings();
  const [own, setOwn] = React.useState(false);
  const hold = useHoldMenu(() => (openSettings ? openSettings("smoothing") : setOwn(true)));
  const on = value.smoothing > 0;

  const trigger = (
    <button
      type="button"
      aria-label="Smoothing — click to toggle, hold for settings"
      aria-pressed={on}
      {...hold.bind}
      onClick={() => {
        if (hold.guard()) return;
        onChange({ smoothing: on ? 0 : SMOOTHING_ON });
      }}
      className={pod(on)}
    >
      <Waves />
    </button>
  );

  const tip = (
    <TooltipContent side="bottom">
      Smoothing {on ? `${Math.round(value.smoothing * 100)}%` : "off"} — ⇧ reverses it
    </TooltipContent>
  );

  if (openSettings) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        {tip}
      </Tooltip>
    );
  }

  return (
    <Popover open={own} onOpenChange={setOwn}>
      <Tooltip>
        <PopoverAnchor asChild>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        </PopoverAnchor>
        {tip}
      </Tooltip>
      <PopoverContent side="bottom" align="center" sideOffset={8} className="w-72 p-3">
        <FidelityFields value={value} onChange={onChange} geometry={geometry} fallback={fallback} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * THE TWO DOORS at the end of the bar, and the difference between them.
 *
 * SETTINGS is the tweak icon: the knobs of the tool you are holding — size,
 * opacity, the stabiliser, the pen curve. It hosts the one sheet, so every
 * pod's hold gesture opens THIS on its own tab (see `PaintSettings`).
 *
 * STUDIO is labelled, because it is a place you go rather than a knob you
 * turn: the brush itself, opened for editing. It used to be an anonymous gear
 * inside the brush section while the labelled button said "Settings" and did
 * not go to the studio at all — two doors whose signs were swapped, and the
 * gear was reachable only when the brush tool was armed even though the eraser
 * carries a brush of its own.
 */
export function PaintSettingsButton({ settings }: { settings: ReturnType<typeof usePaintSettings> }) {
  return (
    <PaintSettings {...settings.props} side="bottom" align="end">
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Brush settings"
              aria-expanded={settings.open}
              className={pod(settings.open)}
            >
              <SlidersHorizontal />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Brush settings</TooltipContent>
      </Tooltip>
    </PaintSettings>
  );
}

/** The way into the armed tool's OWN brush — the eraser's included. */
export function StudioButton() {
  const lib = useBrushLibrary();
  const dials = usePaintDials();
  if (!dials) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => lib.openStudio(lib.activeBrushId(dials.slot))}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
        >
          <FlaskConical />
          Studio
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Brush Studio — edit this brush</TooltipContent>
    </Tooltip>
  );
}

// ── Eraser / fill / lasso sections ──────────────────────────────────────────

/**
 * What the armed tool would ACTUALLY reach at this scope — the same headless
 * rule (`resolveStrokeTargets`) the stroke itself uses, asked by the bar so it
 * can disclose exactly what is about to happen. A vector control appears when
 * there is vector art under the tool, and not as a permanent guess.
 */
function useTargetMedia(scope: LayerScope): { vector: boolean; raster: boolean } {
  const doc = useDoc();
  const activeFrameId = useSession((s) => s.activeFrameId);
  const selected = useSession((s) => s.selectedClipIds);
  // Parked time only: subscribing to a running playhead would re-render this
  // bar on every played frame to answer a question nobody is asking mid-play.
  const parkedMs = useSession((s) => (s.playing ? null : s.playheadMs));
  return React.useMemo(() => {
    const stage = activeStageFrame(doc, activeFrameId);
    const ctx = stage ? paintContextAt(doc, stage.id, parkedMs ?? 0, selected) : null;
    if (!ctx) return { vector: false, raster: false };
    const targets = resolveStrokeTargets(doc, ctx.frameId, selected, scope, ctx.cell ? null : parkedMs);
    return {
      vector: targets.some((t) => t.medium === "vector"),
      raster: targets.some((t) => t.medium === "raster"),
    };
  }, [doc, activeFrameId, parkedMs, selected, scope]);
}

const ERASER_VECTOR_MODES: Array<{ v: VectorEraseMode; icon: React.ComponentType<{ className?: string }>; label: string }> = [
  { v: "split", icon: Scissors, label: "Cut the outline — filled art is carved" },
  { v: "points", icon: Waypoints, label: "Dissolve the nodes under the brush" },
  { v: "whole", icon: Trash2, label: "Erase the whole path on any touch" },
];

/**
 * Eraser behaviour, per kind of layer — the settings the bar itself has no
 * room for. Pixels take a brush (its tip is a choice, like every other brush);
 * outlines take a meaning. "All layers" then runs each layer by its own rule in
 * one gesture, which is the only way a mixed drawing erases the way it looks.
 */
function EraserBehaviorPod() {
  const eraser = useDrawing((s) => s.eraser);
  const set = useDrawing((s) => s.setEraserOptions);
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Eraser behaviour"
              className={pod()}
            >
              <Settings2 />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Eraser behaviour</TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="center" sideOffset={8} className="w-72 space-y-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Pixel layers</span>
          <BrushPicker slot="eraser" />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Vector layers</span>
          <IconSeg
            value={eraser.vectorMode}
            onChange={(vectorMode: VectorEraseMode) => set({ vectorMode })}
            options={ERASER_VECTOR_MODES}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * ERASER — its targets, its meaning on vector art, and the same scope strip.
 *
 * `eraser.scope` ("this layer / all layers") stays its own control and is NOT
 * the paint reference: one says which layers the eraser TOUCHES, the other says
 * which artwork defines a region. Folding them together would mean referencing
 * a layer in order to protect it, which is the opposite of what it does.
 */
export function EraserSection() {
  const eraser = useDrawing((s) => s.eraser);
  const set = useDrawing((s) => s.setEraserOptions);
  const media = useTargetMedia(eraser.scope);
  return (
    <>
      <G>
        <ScopeSwitch value={eraser.scope} onChange={(scope) => set({ scope })} />
        {/* Vector art in range → its mode comes up to the bar, where the gesture is. */}
        {media.vector && (
          <IconSeg
            value={eraser.vectorMode}
            onChange={(vectorMode: VectorEraseMode) => set({ vectorMode })}
            options={ERASER_VECTOR_MODES}
          />
        )}
      </G>
      <G>
        <EraserBehaviorPod />
        <HandOff>
          <FidelityPod value={eraser.fidelity} onChange={(f) => set({ fidelity: { ...eraser.fidelity, ...f } })} geometry={media.vector} />
          <PressurePod />
        </HandOff>
      </G>
      <PaintScopeStrip />
      <FrameOptions />
    </>
  );
}

/**
 * THE BUCKET — a colour, and whether the pour is connected.
 *
 * Everything else it used to own (tolerance, "gap", behind, sample-all-layers)
 * moved into the paint scope, because a confined brush stroke asks exactly the
 * same questions and had no answer for any of them. The bucket is a confined
 * mark with a flood instead of a nib, so it renders the identical strip the
 * brush does — same controls, same positions, one thing to learn.
 */
export function FillSection() {
  const fill = useDrawing((s) => s.fill);
  const set = useDrawing((s) => s.setFillOptions);
  return (
    <>
      <G>
        <PaintColorInput value={fill.color} onChange={(color) => set({ color })} />
      </G>
      <G>
        <IconSeg
          value={fill.global ? "global" : "contiguous"}
          onChange={(v) => set({ global: v === "global" })}
          options={[
            { v: "contiguous", icon: SquareDot, label: "Fill the region you clicked" },
            { v: "global", icon: Sparkles, label: "Fill every matching area at once" },
          ]}
        />
      </G>
      {/* `region` — the bucket ALWAYS computes a region, confined or not, so its
          accuracy and margin controls are always live. */}
      <PaintScopeStrip region />
      <FrameOptions />
    </>
  );
}

/** The fill tool where there are no pixels to flood — a 3D world's: the colour it pours. */
export function FillColorSection() {
  const fill = useDrawing((s) => s.fill);
  const set = useDrawing((s) => s.setFillOptions);
  return (
    <G>
      <PaintColorInput value={fill.color} onChange={(color) => set({ color })} />
    </G>
  );
}

export function LassoSection() {
  const lasso = useDrawing((s) => s.lasso);
  const set = useDrawing((s) => s.setLassoOptions);
  const tool = useSession((s) => s.tool);
  const media = useTargetMedia(lasso.scope);
  return (
    <>
      {/* Sub-tool: how you DRAW the selection (free / rectangle / polygon). Wand
          has no shape — it flood-picks by color instead. */}
      <G>
        {tool === "lasso" && (
          <IconSeg
            value={lasso.shape}
            onChange={(shape) => set({ shape })}
            options={[
              { v: "free", icon: Lasso, label: "Free lasso" },
              { v: "rect", icon: SquareDashed, label: "Rectangle select" },
              { v: "poly", icon: PenTool, label: "Polygon lasso — click points, ⏎ or double-click to close" },
            ]}
          />
        )}
        {tool === "wand" && (
          <>
            <Opt label="Tolerance">
              <NumberInput
                value={Math.round(lasso.tolerance * 100)}
                min={0}
                max={100}
                precision={0}
                unit="%"
                className="w-16"
                onChange={(v) => set({ tolerance: v / 100 })}
              />
            </Opt>
            <Opt label="Contiguous">
              <Switch checked={lasso.contiguous} onCheckedChange={(contiguous) => set({ contiguous })} />
            </Opt>
          </>
        )}
      </G>
      {/* Combine mode — belongs to the whole lasso family, shared by every
          sub-tool AND the wand, so a rect-select + free-lasso-add merge as one. */}
      <G>
        <IconSeg
          value={lasso.combine}
          onChange={(combine: MaskCombine) => set({ combine })}
          options={[
            { v: "new", icon: Square, label: "New selection" },
            { v: "add", icon: SquarePlus, label: "Add to selection" },
            { v: "subtract", icon: SquareMinus, label: "Subtract from selection" },
            { v: "intersect", icon: SquareDot, label: "Intersect with selection" },
          ]}
        />
      </G>
      <G>
        <ScopeSwitch value={lasso.scope} onChange={(scope) => set({ scope })} />
        {/* Vector art in range: a loop can either carve it or pick it. Pixels have
            no such question, so the control only exists when the answer matters. */}
        {media.vector && (
          <IconSeg
            value={lasso.vectorMode}
            onChange={(vectorMode: VectorLassoMode) => set({ vectorMode })}
            options={[
              { v: "cut", icon: Scissors, label: "Cut vectors into pieces along the loop" },
              { v: "whole", icon: SquareDashedMousePointer, label: "Select whole vector layers, uncut" },
            ]}
          />
        )}
        {/* The free lasso is drawn by hand, so it stabilises like a brush; every
            shape's cut hands geometry back, so the density knob is always live. */}
        <FidelityPod
          value={lasso.fidelity}
          onChange={(f) => set({ fidelity: { ...lasso.fidelity, ...f } })}
          geometry={media.vector}
        />
      </G>
    </>
  );
}

/**
 * WET PAINT, and the one control it needs.
 *
 * A FAN ICON at the head of the brush section, appearing only while something
 * on the canvas is still wet. At the far end behind the colour and the fidelity
 * pod it was a labelled button nobody could find — and the whole point of this
 * control is that you reach for it WITHOUT stopping, because a wash bleeding
 * the wrong way has to be caught now.
 *
 * The pulsing ring is the honest signal that the picture has not finished
 * settling; when it goes, the paint is pixels.
 */
function DryPod() {
  const store = useDocStore();
  const doc = useDoc();
  const [wet, setWet] = React.useState(false);

  // The surface store is pixels, not state, so this rides the same repaint
  // notification the stage does rather than inventing a subscription.
  React.useEffect(() => {
    setWet(hasWetPaint());
    return onSurfaceReady(() => setWet(hasWetPaint()));
  }, []);

  if (!wet) return null;
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Dry the wet paint"
            onClick={() => {
              dryWetPaint(store, doc);
              setWet(hasWetPaint());
            }}
            className="relative flex size-7 items-center justify-center rounded-md text-primary transition-colors hover:bg-primary/15"
          >
            <Fan className="size-4" />
            <span className="absolute inset-0 animate-pulse rounded-md ring-1 ring-primary/50" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-56">
          Paint is still wet — it is flowing and bleeding. Click to dry it into the layer.
        </TooltipContent>
      </Tooltip>
    </>
  );
}
