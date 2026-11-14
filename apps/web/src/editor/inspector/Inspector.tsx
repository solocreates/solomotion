"use client";

import { WorldRenderSection } from "./World3dSections";
import { SimulationSection } from "../physics/lazy";
import { FrameSoundSections } from "./mix/FrameSoundSections";
import { CategoryPanel } from "./mix/CategoryPanel";
import * as React from "react";
import {
  contentVariesInTime,
  deleteFrame,
  frameDurationMs,
  frameIndexToMs,
  msToFrameIndex,
  duplicateFrame,
  frameEffectClip,
  FRAME_SIZE_PRESETS,
  isComponentFrame,
  isInstanceClip,
  isVisualClip,
  locateClip,
  moveClip,
  reconcileFillClips,
  resizeFrame,
  STAGE_BACKGROUND_THEME,
  trimClip,
  type Clip,
  type Frame,
  type TextClip,
  frameFps,
  setFrameFps,
} from "@solomotion/core";
import {
  Box,
  ChevronRight,
  Component,
  Copy,
  Frame as FrameIcon,
  Link2,
  Link2Off,
  Maximize2,
  Palette,
  Plus,
  Trash2,
} from "lucide-react";
import { makeClips3d, makeFrame3d, openWorldFrame } from "../world/make-3d";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { DocColorInput } from "./DocColorInput";
import { FramePaintSections } from "./PaintList";
import { NumberInput } from "@/components/ui/number-input";
import { FpsControl } from "@/components/ui/fps-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useEditedDoc } from "../nodes/use-resolved";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { FrameModeControl } from "../frames/frame-modes";
import { useTheme } from "../theme/use-theme";
import { deleteFrames,
  createComponentFromFrame,
  createComponentFromSelection,
  deleteSelectedClips,
  duplicateSelectedClips,
  ensureFrameEffectClip,
} from "../state/clip-actions";
import { FramePresetsPanel } from "../ui/FramePresets";
import { ClipKindIcon } from "../ui/clip-icon";
import { ExportSection } from "../export/ExportSection";
import { FrameLookRow } from "./effect-stack/FrameLookRow";
import { LayerRateRow } from "./TimingSection";
import { LayerAnimateItems } from "./LayerAnimate";
import { AudioInspector } from "./AudioInspector";
import { CaptionCues } from "./CaptionCues";
import { inspectorSubject, inspectorTabs, type InspectorTab } from "./shared-inspector";
import { LayerEffectsSection } from "./LayerEffectsSection";
import {
  Half,
  IconToggle,
  Inline,
  PanelSection,
  Pair,
  PropRow,
} from "./controls";
import { MediaInspector } from "./MediaInspector";
import { NestedInspector } from "./NestedInspector";
import { ComponentControl } from "./ComponentControl";

// Component inputs load on first use: most selections are not instances.
const InstanceInputs = lazyComponent("InstanceInputs", () => import("./InputsSection").then((m) => ({ default: m.InstanceInputs })));
const FrameInputs = lazyComponent("FrameInputs", () => import("./InputsSection").then((m) => ({ default: m.FrameInputs })));
import { AdjustmentInspector } from "./AdjustmentInspector";
import { MotionBlurSection } from "./MotionBlurSection";
import { VectorInspector } from "./VectorInspector";
import { WaveformInspector } from "./WaveformInspector";
import { TextInspector } from "./TextInspector";
import { VariablesManager } from "./VariablesManager";
import { useClipUpdater } from "./use-clip-updater";
import { LayerSections } from "./layer-sections";

import { ScopeProvider, useScopeTarget } from "./scope";
import { lazyComponent } from "@/editor/lazy-component";

/**
 * Context-sensitive inspector, Figma-style: project settings when nothing is
 * selected, frame properties when an artboard is selected, and a tabbed
 * property stack per clip kind. Range selections re-target the text tabs.
 */
export function Inspector() {
  // The RESOLVED document: drivers baked into the clips' own slots, so every
  // field below shows the value the canvas is actually drawing rather than the
  // literal sitting underneath it. Writes still go to the raw store through
  // `useDocStore` — you edit the value under a driver, never the driven result.
  const doc = useEditedDoc();
  const tool = useSession((s) => s.tool);
  const selectedIds = useSession((s) => s.selectedClipIds);
  const selectedFrameIds = useSession((s) => s.selectedFrameIds);

  const selectedClips: Clip[] = [];
  for (const id of selectedIds) {
    const loc = locateClip(doc, id);
    if (loc) selectedClips.push(loc.clip);
  }
  // The frame inspector edits ONE frame; with several selected we show the
  // primary (last-picked) so the panel still has a subject.
  const primaryFrameId = selectedFrameIds[selectedFrameIds.length - 1];
  const frame = primaryFrameId ? doc.frames.find((f) => f.id === primaryFrameId) : undefined;

  // ONE precedence rule, resolved headlessly — see `inspectorSubject`. The
  // armed tool is not a subject: its settings are the stage's top bar.
  const inspectedBus = useSession((s) => s.inspectedSoundBus);
  const busOpen =
    inspectedBus && inspectedBus.clips === selectedIds && inspectedBus.frames === selectedFrameIds && doc.soundBuses.some((b) => b.id === inspectedBus.id)
      ? inspectedBus.id
      : null;
  const subject = inspectorSubject({
    clips: selectedClips,
    frameId: frame?.id ?? null,
    frameTool: tool === "frame",
    soundBusId: busOpen,
  });

  // Figma-style size presets — click to drop a frame. Returned OUTSIDE the
  // scroller below because it owns its own: a search field that stays put over
  // a scrolling list can only exist if the list is the thing that scrolls, and
  // a ScrollArea nested in a ScrollArea has no height to be full of.
  if (subject.kind === "framePresets") return <FramePresetsPanel />;

  return (
    // The arbitrary variant defeats Radix's inline `display: table` viewport
    // wrapper, which otherwise breaks position:sticky (the tab strip).
    <ScrollArea className="h-full [&_[data-radix-scroll-area-viewport]>div]:block!">
      {subject.kind === "soundBus" ? (
        <CategoryPanel busId={subject.busId} />
      ) : subject.kind === "frame" ? (
        <FramePanel frame={frame!} />
      ) : subject.kind === "project" ? (
        <ProjectPanel />
      ) : (
        <SelectionInspector clips={subject.clips} />
      )}
    </ScrollArea>
  );
}

// ── Selection inspector ──────────────────────────────────────────────────────

/**
 * ONE panel for any selection. Header + body; with several layers the body is
 * the same spine asked about all of them, and each layer's own panel stays one
 * click away in the list underneath. The Design/Effects/Animate switcher is the
 * RIGHT RAIL, so this reads as one stack.
 */
function SelectionInspector({ clips }: { clips: Clip[] }) {
  const store = useDocStore();
  const single = clips.length === 1 ? clips[0]! : null;
  return (
    <>
      {single ? (
        <ClipHeader clip={single} />
      ) : (
        <div className="flex h-10 items-center gap-1 border-b px-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="min-w-0 flex-1 cursor-default truncate px-1 text-[13px] font-semibold">
                {clips.length} layers
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{summarizeKinds(clips)}</TooltipContent>
          </Tooltip>
          <ComponentHeaderAction clips={clips} />
          <World3dHeaderAction clips={clips} />
          <HeaderAction label="Duplicate" onClick={() => duplicateSelectedClips(store)}>
            <Copy />
          </HeaderAction>
          <HeaderAction label="Delete" danger onClick={() => deleteSelectedClips(store)}>
            <Trash2 />
          </HeaderAction>
        </div>
      )}
      <SelectionBody clips={clips} />
      {!single && (
        <>
          <div className="flex h-8 items-center px-3 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/70">
            Layers
          </div>
          {clips.map((c) => (
            <LayerAccordionItem key={c.id} clip={c} />
          ))}
        </>
      )}
    </>
  );
}

/**
 * The property stack for a selection, WITHOUT the header — so a layer row in
 * the multi-select list can open the very same panel for itself.
 */
function SelectionBody({ clips }: { clips: Clip[] }) {
  const doc = useDoc();
  const primary = clips[0]!;
  const tabs = inspectorTabs(clips, doc);

  // The tab lives in the session so the RIGHT RAIL can drive it from outside
  // this panel. Falling back to the first available tab keeps a selection whose
  // kinds have no Sound tab from rendering an empty panel.
  const stored = useSession((s) => s.inspectorTab);
  const tab: InspectorTab = tabs.includes(stored as InspectorTab) ? (stored as InspectorTab) : (tabs[0] ?? "design");

  const body = (
    <>
      {/* An actual component (instance or definition) gets its variant switcher
          above the spine; the plain "Create component" offer is a tail section,
          where it isn't in the way of every layer's properties. */}
      {clips.length === 1 && <ComponentControl clip={primary} />}
      {/* An instance's inputs sit at the top of Design — Figma's properties spot. */}
      {clips.length === 1 && tab === "design" && primary.kind === "nested" && doc.frames.some((f) => f.id === primary.sourceFrameId && f.inputs?.length) && (
        <React.Suspense fallback={null}>
          <InstanceInputs clip={primary} />
        </React.Suspense>
      )}
      <LayerSections
        clips={clips}
        clip={primary}
        doc={doc}
        tab={tab}
        tabs={tabs}
        multi={clips.length > 1}
        visual={clips.filter(isVisualClip)}
      />
    </>
  );

  // The SCOPE wraps the whole panel, not one tab. It has to: the bug people
  // hit was an Effects tab that said "Focus" and wrote the layer, because the
  // scope only existed inside the text panel. Above the tab body it also means
  // switching Design → Effects keeps the target you picked.
  return primary.kind === "text" && clips.every((c) => c.kind === "text") ? (
    <TextScopeShell clip={primary}>{body}</TextScopeShell>
  ) : (
    body
  );
}

/**
 * Provides the scope for a text layer. It renders NO strip of its own.
 *
 * The strip used to hang here, above every tab, which is why half the tabs
 * offered a switch that changed nothing in them and why it sat above sections
 * (Transform, Timing) that are true of the layer whatever you pick. It is
 * placed by `LayerSections` now, at the boundary between a tab's shared and
 * scoped sections — so it means the same thing in every panel, and appears
 * only in the panels where it means anything.
 */
function TextScopeShell({ clip, children }: { clip: TextClip; children: React.ReactNode }) {
  return <ScopeProvider value={useScopeTarget(clip)}>{children}</ScopeProvider>;
}

/**
 * The one header shape — a kind icon, an inline-editable name, and the two
 * destructive-ish actions as icons. The frame header below wears the same
 * geometry so switching selection doesn't shift the panel under your cursor.
 */
function ClipHeader({ clip }: { clip: Clip }) {
  const store = useDocStore();
  const update = useClipUpdater(clip.id);
  return (
    <div className="flex h-10 items-center gap-1 border-b px-2">
      <ClipKindIcon clip={clip} className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        value={clip.name}
        onChange={(e) =>
          update("Rename layer", (c) => void (c.name = e.target.value), "rename-clip")
        }
        className="min-w-0 flex-1 truncate rounded bg-transparent px-1 text-[13px] font-semibold outline-none transition-colors hover:bg-input/30 focus:bg-input/45"
        spellCheck={false}
        aria-label="Layer name"
      />
      <ComponentHeaderAction clips={[clip]} />
      <World3dHeaderAction clips={[clip]} />
      <HeaderAction label="Duplicate" onClick={() => duplicateSelectedClips(store)}>
        <Copy />
      </HeaderAction>
      <HeaderAction label="Delete" danger onClick={() => deleteSelectedClips(store)}>
        <Trash2 />
      </HeaderAction>
    </div>
  );
}

/**
 * THE COMPONENT BUTTON — always beside Duplicate, for any subject: a frame, a
 * layer, several layers. Not a component yet → "Create component". Already one
 * (or an instance of one) → the component mark, which says so instead of
 * offering to do it again. The variant switcher for a real component stays in
 * the panel below; this is only the way in.
 */
function ComponentHeaderAction({ frame, clips }: { frame?: Frame; clips?: Clip[] }) {
  const doc = useDoc();
  const store = useDocStore();
  let mark: string | null = null;
  if (frame) {
    if (frame.instanceOf) mark = "Instance of a component";
    else if (isComponentFrame(frame)) mark = "This frame is a component";
  } else {
    const visual = (clips ?? []).filter(isVisualClip);
    if (visual.length === 0) return null;
    if (visual.length === 1 && isInstanceClip(doc, visual[0]!)) mark = "Instance of a component";
  }
  if (mark) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="flex size-6 shrink-0 items-center justify-center text-[#B79BFF] [&_svg]:size-3.5"
            aria-label={mark}
          >
            <Component />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{mark}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <HeaderAction
      label="Create component"
      onClick={() => (frame ? createComponentFromFrame(store, frame.id) : createComponentFromSelection(store))}
    >
      <Component />
    </HeaderAction>
  );
}

/**
 * THE 3D BUTTON — beside the Component button, for any subject, the one way
 * in to 3D (`world/make-3d.ts`):
 *
 *   a flat layer, group or several  → "Make 3D": into a world where they were
 *   a flat frame (the main one too) → "Make frame 3D": its content into a
 *                                     world nested in it, the frame kept
 *   a world (frame, or its layer)   → "Open in 3D"
 *   something already in a world    → the 3D mark, saying so
 */
function World3dHeaderAction({ frame, clips }: { frame?: Frame; clips?: Clip[] }) {
  const doc = useDoc();
  const store = useDocStore();
  if (frame) {
    if (frame.world) {
      return (
        <HeaderAction label="Open in 3D" onClick={() => openWorldFrame(store, frame.id)}>
          <Box className="text-[#FF9F43]" />
        </HeaderAction>
      );
    }
    return (
      <HeaderAction label="Make frame 3D — its content moves into a 3D world inside it" onClick={() => makeFrame3d(store, frame.id)}>
        <Box />
      </HeaderAction>
    );
  }
  const visual = (clips ?? []).filter(isVisualClip);
  if (visual.length === 0) return null;
  const inWorld = visual.every((c) => doc.frames.find((f) => f.id === c.frameId)?.world);
  if (inWorld) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex size-6 shrink-0 items-center justify-center text-[#FF9F43] [&_svg]:size-3.5" aria-label="In a 3D world">
            <Box />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">In a 3D world</TooltipContent>
      </Tooltip>
    );
  }
  const only = visual.length === 1 ? visual[0]! : null;
  const world = only?.kind === "nested" ? doc.frames.find((f) => f.id === only.sourceFrameId && f.world) : undefined;
  if (world) {
    return (
      <HeaderAction label="Open in 3D" onClick={() => openWorldFrame(store, world.id)}>
        <Box className="text-[#FF9F43]" />
      </HeaderAction>
    );
  }
  return (
    <HeaderAction label="Make 3D — into a 3D world, same picture" onClick={() => makeClips3d(store, visual.map((c) => c.id))}>
      <Box />
    </HeaderAction>
  );
}

/** A 24px tooltip-labelled header button. Every panel header uses this one. */
function HeaderAction({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors [&_svg]:size-3.5",
            danger ? "hover:bg-destructive/10 hover:text-destructive" : "hover:bg-accent hover:text-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** A summary like "2 Text · 1 Shape" for the multi-select header. */
function summarizeKinds(clips: Clip[]): string {
  const counts = new Map<Clip["kind"], number>();
  for (const c of clips) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([kind, n]) => `${n} ${kind}`)
    .join(" · ");
}

/**
 * One collapsible layer in the multi-select accordion. Header = icon + name;
 * expanding reveals that layer's full inspector; "isolate" focuses just it.
 */
function LayerAccordionItem({ clip }: { clip: Clip }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="border-b border-border/70">
      <div className="group/layer flex h-9 items-center gap-1.5 px-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRight
            className={cn("size-3 shrink-0 text-muted-foreground/60 transition-transform", open && "rotate-90")}
          />
          <ClipKindIcon clip={clip} className="size-3.5 text-muted-foreground" />
          <span className="truncate text-[11px] font-medium text-foreground/90">{clip.name}</span>
        </button>
        <button
          type="button"
          title="Edit only this layer"
          aria-label="Isolate layer"
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/layer:opacity-100"
          onClick={() => useSession.getState().select([clip.id])}
        >
          <Maximize2 className="size-3" />
        </button>
      </div>
      {open && (
        <div className="border-t border-border/40 pb-1">
          <SelectionBody clips={[clip]} />
        </div>
      )}
    </div>
  );
}

// ── Frame (artboard) panel ───────────────────────────────────────────────────

/**
 * A toggle that modifiers flip momentarily: holding the key inverts the
 * manual state while held (Figma's ⇧-for-aspect / ⌘-for-scale behavior),
 * clicking flips the manual state for good.
 */
function useModifierToggle(keys: string[]): [boolean, () => void] {
  const [manual, setManual] = React.useState(false);
  const [held, setHeld] = React.useState(false);
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => keys.includes(e.key) && setHeld(true);
    const up = (e: KeyboardEvent) => keys.includes(e.key) && setHeld(false);
    const blur = () => setHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [held ? !manual : manual, () => setManual((v) => !v)];
}

function FramePanel({ frame }: { frame: Frame }) {
  const doc = useDoc();
  const store = useDocStore();
  // The rail's Sound tab on a frame: the comp's mix master, alone.
  const frameTab = useSession((s) => s.inspectorTab);
  // Several frames picked: Export takes all of them, in pick order.
  const selectedFrameIds = useSession((s) => s.selectedFrameIds);

  // ⇧ links the aspect ratio while held; ⌘/Ctrl scales contents while held.
  const [linked, toggleLinked] = useModifierToggle(["Shift"]);
  const [scaleContents, toggleScaleContents] = useModifierToggle(["Meta", "Control"]);

  const updateFrame = (label: string, fn: (f: Frame) => void, mergeKey?: string) =>
    store.update(
      label,
      (d) => {
        const f = d.frames.find((x) => x.id === frame.id);
        if (f) fn(f);
      },
      mergeKey ? { mergeKey: `${mergeKey}-${frame.id}` } : undefined,
    );

  /** One resize path for W/H fields and presets: honors link + scale toggles. */
  const applySize = (axis: "w" | "h", value: number, mergeKey: string) => {
    const keepAspect = linked || scaleContents; // content scaling is uniform by definition
    const ratio = frame.height / Math.max(1, frame.width);
    let w = frame.width;
    let h = frame.height;
    if (axis === "w") {
      w = Math.round(value);
      if (keepAspect) h = Math.round(w * ratio);
    } else {
      h = Math.round(value);
      if (keepAspect) w = Math.round(h / ratio);
    }
    store.update(
      scaleContents ? "Scale frame" : "Resize frame",
      (d) => resizeFrame(d, frame.id, w, h, { scaleContents }),
      { mergeKey: `${mergeKey}-${frame.id}` },
    );
  };

  const preset = FRAME_SIZE_PRESETS.find((p) => p.width === frame.width && p.height === frame.height);

  return (
    <>
      <div className="flex h-10 items-center gap-1 border-b px-2">
        <FrameIcon className="size-3.5 shrink-0 text-[#B18CFF]" />
        <input
          value={frame.name}
          onChange={(e) => updateFrame("Rename frame", (f) => void (f.name = e.target.value), "rename-frame")}
          className="min-w-0 flex-1 truncate rounded bg-transparent px-1 text-[13px] font-semibold outline-none transition-colors hover:bg-input/30 focus:bg-input/45"
          spellCheck={false}
          aria-label="Frame name"
        />
        <ComponentHeaderAction frame={frame} />
        <World3dHeaderAction frame={frame} />
        <HeaderAction
          label="Duplicate"
          onClick={() => {
            let newId: string | null = null;
            store.update("Duplicate frame", (d) => void (newId = duplicateFrame(d, frame.id)));
            if (newId) useSession.getState().selectFrame(newId);
          }}
        >
          <Copy />
        </HeaderAction>
        <HeaderAction
          label="Delete"
          danger
          onClick={() => deleteFrames(store, [frame.id])}
        >
          <Trash2 />
        </HeaderAction>
      </div>

      {frameTab === "sound" ? (
        <FrameSoundSections frame={frame} />
      ) : (
        <>
      {/* THE MODE — first, because it decides what every section below means:
          a timeline, a flipbook sheet, or one still picture. */}
      <div className="border-b px-2 py-2">
        <FrameModeControl store={store} frame={frame} />
      </div>

      {/* A 3D world: how its picture is developed, and the door into it. */}
      {frame.world && <WorldRenderSection frame={frame} />}
      {/* A flat comp's simulation, once something in it has a body or a field. */}
      {!frame.world && doc.tracks.some((t) => t.clips.some((c) => c.frameId === frame.id && c.kind !== "audio" && (c.physics || c.forces?.length || c.emitters?.length))) && <SimulationSection frame={frame} />}

      {/* Component + variants for the frame: create / switch variant / detach —
          same unified control the layer inspector uses. */}
      <ComponentControl frame={frame} />
      {(frame.component != null || frame.inputs?.length || frame.instanceOf) && (
        <React.Suspense fallback={null}>
          <FrameInputs frame={frame} />
        </React.Suspense>
      )}

      <PanelSection title="Size" collapsible={false}>
        <PropRow label="Preset">
          <Select
            value={preset ? preset.name : "__custom__"}
            onValueChange={(name) => {
              const p = FRAME_SIZE_PRESETS.find((x) => x.name === name);
              if (p) {
                store.update(scaleContents ? "Scale frame" : "Resize frame", (d) =>
                  resizeFrame(d, frame.id, p.width, p.height, { scaleContents }),
                );
              }
            }}
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue placeholder="Custom" />
            </SelectTrigger>
            <SelectContent>
              {!preset && <SelectItem value="__custom__">Custom</SelectItem>}
              {FRAME_SIZE_PRESETS.map((p) => (
                <SelectItem key={p.name} value={p.name}>
                  <span className="flex w-full items-center justify-between gap-3">
                    {p.name}
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {p.width}×{p.height}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PropRow>
        <PropRow label="Size">
          <Inline
            trailing={
              <IconToggle
                label="Scale contents with the frame — hold ⌘ to flip"
                pressed={scaleContents}
                onClick={toggleScaleContents}
              >
                <Maximize2 />
              </IconToggle>
            }
          >
            <Pair
              link={
                <IconToggle
                  label="Link aspect ratio — hold ⇧ to flip"
                  pressed={linked}
                  onClick={toggleLinked}
                >
                  {linked ? <Link2 /> : <Link2Off />}
                </IconToggle>
              }
            >
              <NumberInput
                label="W"
                value={frame.width}
                min={16}
                max={8192}
                precision={0}
                onChange={(v) => applySize("w", v, "frame-w")}
              />
              <NumberInput
                label="H"
                value={frame.height}
                min={16}
                max={8192}
                precision={0}
                onChange={(v) => applySize("h", v, "frame-h")}
              />
            </Pair>
          </Inline>
        </PropRow>
        <PropRow label="Position">
          <Pair>
            <NumberInput
              label="X"
              value={frame.x}
              precision={0}
              onChange={(v) => updateFrame("Move frame", (f) => void (f.x = Math.round(v)), "frame-x")}
            />
            <NumberInput
              label="Y"
              value={frame.y}
              precision={0}
              onChange={(v) => updateFrame("Move frame", (f) => void (f.y = Math.round(v)), "frame-y")}
            />
          </Pair>
        </PropRow>
        {/* Short labels are a hard constraint: the label column is 56px so the
            fields keep their width. Anything longer than "Background" fits in a
            hint instead. */}
        <PropRow label="Base" hint="Frame background — shows through wherever there are no fills.">
          <DocColorInput
            value={frame.background}
            onChange={(c) => updateFrame("Frame background", (f) => void (f.background = c), "frame-bg")}
          />
        </PropRow>
        {/* One number, not a switch plus a hidden second decision: 0 is "clip",
            and everything above it is how loudly the spill shows. It is a VIEW
            setting — the export rectangle is the frame either way — and it only
            ever paints on the frame you are working in. */}
        <PropRow
          label="Spill"
          hint="How visible artwork past the frame edge is while you work here. 0 hides it. Export always renders the frame."
        >
          <NumberInput
            value={Math.round(frame.overflow * 100)}
            min={0}
            max={100}
            precision={0}
            unit="%"
            onChange={(v) =>
              updateFrame(v <= 0 ? "Clip content" : "Show spill", (f) => void (f.overflow = v / 100))
            }
          />
        </PropRow>
      </PanelSection>

      {/* The same unified Fill / Stroke sections every layer carries — gradients,
          several fills, a border. Empty fills fall back to the Base colour. */}
      <FramePaintSections frame={frame} />

      {frame.mode === "static" && <StillMomentSection frame={frame} />}

      {/* Timing is open by default now: a comp's rate is its own property, not
          a rarely-touched override of a project setting, and hiding it behind a
          closed section was what made the old model feel like a global. A
          still has no clock, so it has no Timing at all. */}
      {frame.mode !== "static" && (
      <PanelSection title="Timing">
        <PropRow label="Rate">
          <FpsControl
            value={frameFps(doc, frame)}
            // Scrub is live and coalesced into one undo entry per drag; the
            // commit is what re-cuts a flipbook's holds (see core setFrameFps).
            onChange={(fps) =>
              store.update("Frame rate", (d) => setFrameFps(d, frame.id, fps), {
                mergeKey: `fps-${frame.id}`,
              })
            }
            onCommit={(fps) => store.update("Frame rate", (d) => setFrameFps(d, frame.id, fps))}
          />
        </PropRow>

        {/* The comp's SHUTTER lives under its rate because it is a fraction of
            one: 180° in a 12fps sheet is a five-times-longer exposure than 180°
            at 60. This is the master switch — the middle level of motion blur's
            three (layer × comp × render), and the one the v56 migration turns
            off on existing projects so nothing you already made restyles. */}
        <PropRow toggle
          label="Shutter"
          hint="Motion blur for this comp. Each layer still has its own switch; this turns the whole comp off."
        >
          <div className="flex h-7 items-center gap-2">
            <Switch
              checked={frame.motionBlur.enabled}
              onCheckedChange={(on) =>
                store.update("Comp motion blur", (d) => {
                  const f = d.frames.find((x) => x.id === frame.id);
                  if (f) f.motionBlur.enabled = on;
                })
              }
              aria-label="Motion blur for this comp"
            />
            {frame.motionBlur.enabled && (
              <NumberInput
                value={Math.round(frame.motionBlur.shutterAngle)}
                min={0}
                max={720}
                precision={0}
                unit="°"
                className="w-20"
                onChange={(v) =>
                  store.update(
                    "Comp shutter angle",
                    (d) => {
                      const f = d.frames.find((x) => x.id === frame.id);
                      if (f) {
                        f.motionBlur.shutterAngle = v;
                        // Keep the exposure CENTRED on the frame as the angle
                        // changes — the phase convention (−½ the angle) is the
                        // reason blur reads as motion rather than as lag, and
                        // making people re-derive it by hand every time is how
                        // you end up with a comp that lags by a quarter frame.
                        f.motionBlur.shutterPhase = -v / 2;
                      }
                    },
                    { mergeKey: `shutter-${frame.id}` },
                  )
                }
              />
            )}
          </div>
        </PropRow>
      </PanelSection>
      )}

      {/* The frame's OWN effects — see `FrameEffectsSection`. */}
      <FrameEffectsSection frame={frame} />

      {/* Export — the frame itself, through the one panel. */}
      <ExportSection frameId={frame.id} frameIds={selectedFrameIds.includes(frame.id) ? selectedFrameIds : undefined} />
        </>
      )}
    </>
  );
}

/**
 * WHICH MOMENT A STILL SHOWS — only when that is a real question. A still made
 * from a timeline (or holding a moving comp) has an instant to choose; a still
 * drawn from scratch shows the same picture at every instant, and a picker
 * there would be a control that does nothing.
 */
function StillMomentSection({ frame }: { frame: Frame }) {
  const doc = useDoc();
  const store = useDocStore();
  if (!contentVariesInTime(doc, frame.id)) return null;
  const fps = frameFps(doc, frame);
  const frames = Math.max(1, Math.round(frameDurationMs(doc, frame) / (1000 / fps)));
  return (
    <PanelSection title="Still" collapsible={false}>
      <PropRow label="Moment" hint="The frame of its animation this still shows">
        <NumberInput
          value={msToFrameIndex(frame.stillMs ?? 0, fps)}
          min={0}
          max={frames - 1}
          precision={0}
          unit="f"
          onChange={(v) =>
            store.update(
              "Move still",
              (d) => {
                const f = d.frames.find((x) => x.id === frame.id);
                if (f) f.stillMs = frameIndexToMs(Math.max(0, Math.round(v)), fps);
              },
              { mergeKey: `still-${frame.id}` },
            )
          }
        />
      </PropRow>
    </PanelSection>
  );
}

/**
 * THE FRAME'S OWN EFFECTS — grain over the whole comp, a grade on everything,
 * a vignette that no layer owns.
 *
 * This section owns no state and stores nothing. A frame effect IS an
 * adjustment layer with whole reach (`frameEffectClip`), which already grades
 * the finished composite as a final pass and already exports, because the
 * exporter draws through the same function the preview does. So the panel is a
 * VIEW onto that clip: the same `LayerEffectsSection` every layer uses, bound
 * to it, with the same palette, presets, keyframes, reordering and mute.
 *
 * That is why there is no `frame.effects`, no migration and no second renderer
 * path. It also means the stack stays a real clip on the timeline — you can
 * see it, trim it, animate it, and give it a matte to grade only some layers —
 * instead of a hidden property with a worse version of all four.
 */
function FrameEffectsSection({ frame }: { frame: Frame }) {
  const doc = useDoc();
  const store = useDocStore();
  const clip = frameEffectClip(doc, frame.id);

  // The Look row first: it is the one-click answer to "this looks flat", and
  // it stays in view whether or not the frame has effects yet.
  return (
    <PanelSection title="Effects">
      <div className="space-y-3">
        <FrameLookRow frame={frame} />
        {clip ? (
          <>
            {clip.kind === "adjustment" && (
              <LayerRateRow clip={clip} label="Animate on" hint="Holds the whole frame at this rate — stop motion. The comp still exports at its own." />
            )}
            <LayerEffectsSection clips={[clip]} flush looks={false} />
          </>
        ) : (
          <Button
            variant="ghost"
            className="h-8 w-full justify-center border border-dashed border-border/60 text-muted-foreground"
            onClick={() => ensureFrameEffectClip(store, frame.id)}
          >
            <Plus /> Add frame effect
          </Button>
        )}
      </div>
    </PanelSection>
  );
}

// ── Project panel (nothing selected) ─────────────────────────────────────────

function ProjectPanel() {
  const doc = useDoc();
  const store = useDocStore();
  // The theme's own stage tone — what "follow the theme" resolves to right now,
  // and therefore the colour the picker starts from the moment you opt out.
  const themeStageColor = useTheme((t) => t.colors.stage);
  const followsTheme = doc.stageBackground === STAGE_BACKGROUND_THEME;

  return (
    <>
      <PanelSection title="Project" collapsible={false}>
        <PropRow label="Name">
          <input
            value={doc.name}
            onChange={(e) =>
              store.update("Rename project", (d) => void (d.name = e.target.value), {
                mergeKey: "rename-project",
              })
            }
            className="h-7 w-full rounded-md border border-transparent bg-input/45 px-1.5 text-xs outline-none transition-colors hover:border-border focus:border-primary/60"
            spellCheck={false}
          />
        </PropRow>
        {/* The infinite-canvas colour behind every frame (Figma's page
            background) — the reusable, variable-aware colour selector. Labelled
            "Canvas" so it fits the 64px column without truncating.

            The trailing toggle is the DEFAULT state, not an extra: a project
            follows the app's theme until it says otherwise, so switching to
            Porcelain re-lights the biggest surface on screen instead of leaving
            a near-black hole in a pale room. Picking a colour is the opt-out —
            and it is a real one, because "this artwork is judged against 18%
            grey" is a fact about the project that has to survive a theme
            change, an export and someone else's machine. */}
        <PropRow label="Canvas">
          <Inline
            trailing={
              <IconToggle
                label={
                  followsTheme
                    ? "Following the theme — click to pick a fixed colour"
                    : "Follow the app's theme"
                }
                pressed={followsTheme}
                onClick={() =>
                  store.update("Stage background", (d) => {
                    d.stageBackground = followsTheme ? themeStageColor : STAGE_BACKGROUND_THEME;
                  })
                }
              >
                <Palette />
              </IconToggle>
            }
          >
            <DocColorInput
              value={followsTheme ? themeStageColor : doc.stageBackground}
              onChange={(c) =>
                store.update("Stage background", (d) => void (d.stageBackground = c), {
                  mergeKey: "stage-bg",
                })
              }
            />
          </Inline>
        </PropRow>
        {/* No frame rate here (v48). A rate belongs to a COMP, not a project —
            every frame carries its own, and it is edited on the frame. A
            project-wide control could only ever be a second opinion about the
            same fact, which is precisely how the two used to disagree. */}
      </PanelSection>
      <VariablesManager />
    </>
  );
}

