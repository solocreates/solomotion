"use client";

import { cursors } from "@solomotion/ui/cursors";
import * as React from "react";
import {
  FAMILY_LABEL,
  setStrokeScalar,
  solidPaint,
  StrokeEngine,
  strokeFromSet,
  strokeScalar,
  strokeSetFrom,
  type BrushPreset,
  type Contour,
  type PenSample,
  type StrokeStyle,
} from "@solomotion/core";
import {
  Blend,
  Copy,
  Droplets,
  Layers,
  Paintbrush,
  RotateCcw,
  Ruler,
  Shapes,
  Sparkles,
  Spline,
  Star,
  Trash2,
  Waves,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FloatingWindow, type WindowBounds } from "@/components/ui/floating-window";
import { RenameInput } from "@/components/ui/rename-input";
import { RailItem, RailSection } from "@/components/ui/rail-list";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { StrokeStackEditor } from "../inspector/StrokeStack";
import type { StrokeHost } from "../inspector/stroke-host";
import { useSession } from "../state/session";
import { useWorkspace } from "../state/workspace";
import { demoSamples, renderBrushStroke, vectorPreviewStroke } from "./brush-preview";
import { invalidateBrushThumbs } from "./brush-thumbs";
import { invalidateBrushSprites, stampDabs } from "./dab-painter";
import { useBrushLibrary, useDrawing } from "./drawing-store";
import { Dial, Group, Row, Seg, type StudioProps } from "./brush-studio/controls";
import { DynamicsEditor } from "./brush-studio/DynamicsEditor";
import { GrainEditor, RenderingEditor, TipEditor, WetEditor } from "./brush-studio/TipEditor";
import { capturePointer } from "../input/capture-pointer";

/**
 * THE BRUSH STUDIO.
 *
 * A floating window with a live playground across the top and vertical tabs
 * down the side — the same chrome as every other tool window in the app, on the
 * same radius and the same glass, because a brush editor is a tool and not a
 * dialog. It used to be a modal with every section stacked in one scroll, which
 * is fine for six controls and unreadable at eighty: you could not compare the
 * tip you were shaping against the dynamics driving it without scrolling past
 * the thing you were trying to see.
 *
 * A WINDOW, not a modal, for a reason that is not decoration: you tune a brush
 * BY DRAWING WITH IT. A modal seals off the canvas, so every judgement has to be
 * made against a demo sweep. Floating means the stage is still there.
 *
 * TABS BY ENGINE. A pixel brush and a vector brush share a schema and almost no
 * controls — hardness and grain mean nothing to a Bézier, and caps and anchor
 * counts mean nothing to a dab. So the tabs come from `brush.engine`, and each
 * engine gets the knobs that are TRUE for it, rather than one list where half
 * the rows quietly do nothing.
 *
 * FACTORY BRUSHES EDIT IN PLACE. There is no "duplicate to unlock" gate any
 * more; the library keeps an override beside the original, so the only thing
 * that changes when you touch a factory brush is that Reset lights up.
 */
export function BrushStudio() {
  const studioBrushId = useBrushLibrary((s) => s.studioBrushId);
  const openStudio = useBrushLibrary((s) => s.openStudio);
  const brush = useBrushLibrary((s) => (s.studioBrushId ? s.brushById(s.studioBrushId) : null));
  const [bounds, setBounds] = React.useState<WindowBounds | null>(null);

  // While the studio is open it owns ⌘Z, so undo means "undo the slider I just
  // moved" rather than silently rewinding the document behind the window.
  React.useEffect(() => {
    if (!studioBrushId) return;
    const { setUndoScope } = useSession.getState();
    setUndoScope({ undo: useBrushLibrary.getState().undo, redo: useBrushLibrary.getState().redo });
    return () => setUndoScope(null);
  }, [studioBrushId]);

  React.useEffect(() => {
    if (studioBrushId && !bounds) {
      const width = Math.min(860, window.innerWidth - 80);
      const height = Math.min(660, window.innerHeight - 100);
      setBounds({
        x: Math.max(24, (window.innerWidth - width) / 2),
        y: Math.max(24, (window.innerHeight - height) / 2),
        width,
        height,
        minimized: false,
      });
    }
  }, [studioBrushId, bounds]);

  if (!brush || !bounds) return null;

  return (
    <FloatingWindow
      title="Brush Studio"
      icon={<Paintbrush className="size-3.5" />}
      bounds={bounds}
      windowId="brush-studio"
      minWidth={620}
      minHeight={460}
      onBoundsChange={(patch) => setBounds((b) => (b ? { ...b, ...patch } : b))}
      onToggleMinimize={() => setBounds((b) => (b ? { ...b, minimized: !b.minimized } : b))}
      onClose={() => openStudio(null)}
      // A playground pinned over the tabs' own scroller.
      body="fill"
    >
      <StudioBody brush={brush} />
    </FloatingWindow>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────────

interface StudioTab {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  render: (props: StudioProps) => React.ReactNode;
}

/**
 * Engine → its tabs, in order. Adding a control is one row inside a tab; adding
 * a whole new facet is one entry; adding a third engine is one key.
 */
const TABS: Record<BrushPreset["engine"], StudioTab[]> = {
  raster: [
    { id: "tip", label: "Tip", icon: Shapes, render: (p) => <TipEditor {...p} /> },
    { id: "stroke", label: "Stroke", icon: Waves, render: (p) => <StrokePathEditor {...p} /> },
    { id: "dynamics", label: "Dynamics", icon: Zap, render: (p) => <DynamicsEditor {...p} /> },
    { id: "grain", label: "Grain", icon: Layers, render: (p) => <GrainEditor {...p} /> },
    { id: "wet", label: "Wet", icon: Droplets, render: (p) => <WetEditor {...p} /> },
    { id: "render", label: "Render", icon: Blend, render: (p) => <RenderingEditor {...p} /> },
    { id: "about", label: "About", icon: Sparkles, render: (p) => <AboutEditor {...p} /> },
  ],
  vector: [
    { id: "line", label: "Line", icon: Ruler, render: (p) => <VectorLineEditor {...p} /> },
    { id: "pressure", label: "Pressure", icon: Zap, render: (p) => <VectorPressureEditor {...p} /> },
    { id: "strokes", label: "Strokes", icon: Spline, render: (p) => <BrushStrokeStack {...p} /> },
    { id: "about", label: "About", icon: Sparkles, render: (p) => <AboutEditor {...p} /> },
  ],
};

function StudioBody({ brush }: { brush: BrushPreset }) {
  const lib = useBrushLibrary();
  const { isFavorite, toggleFavorite } = useWorkspace();
  const tabs = TABS[brush.engine];
  const [tabId, setTabId] = React.useState(tabs[0]!.id);
  const customised = lib.isCustomized(brush.id);

  const tab = tabs.find((t) => t.id === tabId) ?? tabs[0]!;

  /**
   * Write a deep patch into the brush.
   *
   * Every control in the studio goes through here, and the two invalidations
   * are why: the painter caches a baked sprite per tip and the library caches a
   * rendered thumbnail per preset, and both are stale the instant a slider
   * moves. Dropping them HERE — rather than at each of eighty call sites — is
   * what keeps "edit a brush" from being something a control can get wrong.
   */
  const patch = React.useCallback(
    (fn: (draft: BrushPreset) => void) => {
      const draft = structuredClone(brush);
      fn(draft);
      lib.updateBrush(brush.id, draft);
      invalidateBrushSprites();
      invalidateBrushThumbs();
    },
    [brush, lib],
  );

  const props: StudioProps = { brush, patch };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <Playground brush={brush} />

      {/* ── Identity ─────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/50 px-2 py-2">
        <RenameInput
          initial={brush.name}
          className="h-(--control-h) min-w-0 flex-1 rounded-md border border-transparent bg-input/45 px-2 text-xs outline-none transition-colors hover:border-border focus:border-primary/60"
          onCommit={(name) => name.trim() && lib.updateBrush(brush.id, { name: name.trim() })}
        />
        <span className="shrink-0 text-[10px] text-muted-foreground">{FAMILY_LABEL[brush.family]}</span>
        {customised && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0 rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                Edited
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">Changed from the factory brush</TooltipContent>
          </Tooltip>
        )}
        <button
          type="button"
          aria-label={isFavorite(brush.id) ? "Unstar" : "Star"}
          onClick={() => toggleFavorite(brush.id)}
          className={cn(
            "flex size-(--control-h) shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted/50",
            isFavorite(brush.id) ? "text-warning" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Star className={cn("size-4", isFavorite(brush.id) && "fill-current")} />
        </button>
      </div>

      {/* ── Tabs + panel ─────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 gap-2 bg-background p-2">
        {/* The tabs ARE a rail — the same object as the Variables rail and the
            brush library's sets, so the app has one idea of "a list of places
            beside the thing it changes" rather than three that look alike. */}
        <aside className="flex min-h-0 w-[124px] shrink-0 flex-col shell-card">
          <ScrollArea className="min-h-0 flex-1" viewportClassName="p-2">
            <RailSection label={brush.engine === "vector" ? "Vector brush" : "Pixel brush"} />
            {tabs.map((t) => (
              <RailItem
                key={t.id}
                icon={<t.icon />}
                label={t.label}
                active={t.id === tab.id}
                onClick={() => setTabId(t.id)}
              />
            ))}
          </ScrollArea>
          <footer className="flex shrink-0 flex-col gap-0.5 border-t border-border/50 p-1.5">
            {customised && (
              <Button
                size="xs"
                variant="ghost"
                className="justify-start gap-1.5 text-[11px]"
                onClick={() => {
                  lib.resetBrush(brush.id);
                  invalidateBrushSprites();
                  invalidateBrushThumbs();
                }}
              >
                <RotateCcw className="size-3" /> Reset
              </Button>
            )}
            <Button
              size="xs"
              variant="ghost"
              className="justify-start gap-1.5 text-[11px]"
              onClick={() => {
                const copy = lib.duplicateBrush(brush.id);
                if (copy) lib.openStudio(copy.id);
              }}
            >
              <Copy className="size-3" /> Duplicate
            </Button>
            {!brush.builtIn && (
              <Button
                size="xs"
                variant="ghost"
                className="justify-start gap-1.5 text-[11px] text-destructive hover:text-destructive"
                onClick={() => lib.deleteBrush(brush.id)}
              >
                <Trash2 className="size-3" /> Delete
              </Button>
            )}
          </footer>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col shell-card">
          <ScrollArea className="min-h-0 flex-1" viewportClassName="px-3 py-3">
            {tab.render(props)}
          </ScrollArea>
        </section>
      </div>
    </div>
  );
}

// ── Raster sections ─────────────────────────────────────────────────────────

function StrokePathEditor({ brush, patch }: StudioProps) {
  const sp = brush.strokePath;
  return (
    <>
      <Group title="Path" hint="How the samples your hand produced become a chain of stamps.">
        <Dial
          label="Spacing"
          hint="Distance between stamps, as a fraction of the tip. Below 0.06 the stamps merge into a line; above 0.8 they read as separate marks."
          value={sp.spacing}
          min={0.01}
          max={4}
          step={0.005}
          precision={3}
          ticks={[0.06, 1]}
          defaultValue={0.12}
          onChange={(v) => patch((b) => void (b.strokePath.spacing = v))}
        />
        <Dial
          label="Streamline"
          hint="Smooths the pen as you draw. High values calm a shaky line — and a constant-width line needs more of it, because there is no width variation to hide the tremor."
          percent
          value={sp.streamline}
          defaultValue={0.35}
          onChange={(v) => patch((b) => void (b.strokePath.streamline = v))}
        />
      </Group>

      <Group title="Spread">
        <Dial
          label="Jitter"
          hint="Random offset per stamp, in tip widths — scatters the mark in every direction."
          value={sp.jitter}
          max={4}
          step={0.01}
          precision={2}
          defaultValue={0}
          onChange={(v) => patch((b) => void (b.strokePath.jitter = v))}
        />
        <Dial
          label="Scatter"
          hint="Offset ACROSS the stroke only — spray widens, the line still reads as a line."
          value={sp.scatter}
          max={4}
          step={0.01}
          precision={2}
          defaultValue={0}
          onChange={(v) => patch((b) => void (b.strokePath.scatter = v))}
        />
      </Group>

      <Group title="Ends" hint="Pulls size and opacity to nothing over the first and last stretch of the stroke.">
        <Dial
          label="Taper in"
          value={sp.taperStartPx}
          max={400}
          step={1}
          precision={0}
          unit="px"
          defaultValue={0}
          onChange={(v) => patch((b) => void (b.strokePath.taperStartPx = v))}
        />
        <Dial
          label="Taper out"
          value={sp.taperEndPx}
          max={400}
          step={1}
          precision={0}
          unit="px"
          defaultValue={0}
          onChange={(v) => patch((b) => void (b.strokePath.taperEndPx = v))}
        />
      </Group>
    </>
  );
}

// ── Vector sections ─────────────────────────────────────────────────────────

function VectorLineEditor({ brush, patch }: StudioProps) {
  return (
    <>
      <Group title="Hand">
        <Dial
          label="Streamline"
          hint="How much of your hand's tremor never reaches the page."
          percent
          value={brush.strokePath.streamline}
          defaultValue={0.35}
          onChange={(v) => patch((b) => void (b.strokePath.streamline = v))}
        />
      </Group>

      <Group title="Fit" hint="What the gesture becomes: a path you can edit, or a path you can only redraw.">
        <Dial
          label="Smoothing"
          hint="How far the curve may stray from your line. Higher means fewer anchors and a cleaner shape to edit."
          value={brush.vector.fitTolerance}
          min={0.5}
          max={20}
          step={0.1}
          precision={1}
          unit="px"
          defaultValue={2.5}
          onChange={(v) => patch((b) => void (b.vector.fitTolerance = v))}
        />
        <Dial
          label="Straighten"
          hint="Snaps near-straight runs to true straight segments. Zero keeps every wobble."
          value={brush.vector.straightenPx}
          max={40}
          step={0.5}
          precision={1}
          unit="px"
          defaultValue={0}
          onChange={(v) => patch((b) => void (b.vector.straightenPx = v))}
        />
        <Dial
          label="Close loops"
          hint="End within this distance of the start and the path closes into a real, fillable shape."
          value={brush.vector.autoClosePx}
          max={120}
          step={1}
          precision={0}
          unit="px"
          defaultValue={0}
          onChange={(v) => patch((b) => void (b.vector.autoClosePx = v))}
        />
      </Group>
    </>
  );
}

function VectorPressureEditor({ brush, patch }: StudioProps) {
  const variable = brush.vector.variableWidth;
  return (
    <>
      <Group title="Width">
        <Row
          label="Response"
          hint="The single choice that decides what kind of vector brush this is."
        >
          <Seg
            className="w-48"
            value={variable ? "variable" : "mono"}
            options={[
              { v: "mono", label: "Constant", hint: "Pressure is discarded and the result stays a STROKED path — the cleanest thing to edit afterwards. This is what makes a monoline a monoline." },
              { v: "variable", label: "Pressure", hint: "Pressure is recorded as the line's width curve. Expressive, and still a path you can edit." },
            ]}
            onChange={(v) => patch((b) => void (b.vector.variableWidth = v === "variable"))}
          />
        </Row>
        <Dial
          label="Depth"
          hint="How much pressure moves the width."
          percent
          disabled={!variable}
          value={brush.vector.widthPressure}
          defaultValue={0.8}
          onChange={(v) => patch((b) => void (b.vector.widthPressure = v))}
        />
        <Dial
          label="Min width"
          hint="Keeps a feather-light pass from collapsing the outline to nothing."
          percent
          disabled={!variable}
          value={brush.vector.minWidth}
          defaultValue={0.15}
          onChange={(v) => patch((b) => void (b.vector.minWidth = v))}
        />
      </Group>

      <Group title="Ends">
        <Dial
          label="Taper in"
          value={brush.strokePath.taperStartPx}
          max={400}
          step={1}
          precision={0}
          unit="px"
          defaultValue={0}
          onChange={(v) => patch((b) => void (b.strokePath.taperStartPx = v))}
        />
        <Dial
          label="Taper out"
          value={brush.strokePath.taperEndPx}
          max={400}
          step={1}
          precision={0}
          unit="px"
          defaultValue={0}
          onChange={(v) => patch((b) => void (b.strokePath.taperEndPx = v))}
        />
      </Group>
    </>
  );
}

function AboutEditor({ brush, patch }: StudioProps) {
  return (
    <>
      <Group title="Base" hint="Where the brush starts. The options bar tweaks size and opacity per brush without touching these.">
        <Dial
          label="Size"
          value={brush.size}
          min={1}
          max={600}
          step={0.5}
          precision={1}
          unit="px"
          onChange={(v) => patch((b) => void (b.size = v))}
        />
        <Dial
          label="Opacity"
          hint="The ceiling a stroke builds toward. Flow decides how fast it gets there."
          percent
          min={0.01}
          value={brush.opacity}
          defaultValue={1}
          onChange={(v) => patch((b) => void (b.opacity = v))}
        />
      </Group>

      <Group title="Library" hint="Where this brush files itself in the picker's sidebar.">
        <Row label="Set">
          <span className="text-[11px] text-muted-foreground">{FAMILY_LABEL[brush.family]}</span>
        </Row>
        <Row label="Shelf">
          <input
            value={brush.group ?? ""}
            placeholder={FAMILY_LABEL[brush.family]}
            onChange={(e) => patch((b) => void (b.group = e.target.value || undefined))}
            className="h-7 w-40 rounded-[--radius] border border-border/70 bg-transparent px-2 text-[11px] outline-none focus:border-primary/60"
          />
        </Row>
      </Group>
    </>
  );
}

/**
 * The brush's line stack, through the SAME editor the inspector mounts.
 *
 * The host is the whole adapter: `lines` are `StrokeSet`s and a stroke needs a
 * paint, so this lends each line a neutral colour on the way in and keeps only
 * the set on the way out. A brush has no clip, so there is no `keyframeClip`
 * and the rows render without the keyframe gutter — which is exactly what "a
 * brush is a design, not an animation" means.
 */
function BrushStrokeStack({ brush, patch }: StudioProps) {
  const strokes = React.useMemo(
    () => brush.vector.lines.map((l) => strokeFromSet(l, solidPaint("#FFFFFF"))),
    [brush.vector.lines],
  );
  const host: StrokeHost = {
    key: brush.id,
    strokes,
    update: (_label, fn) => {
      const draft: { strokes: StrokeStyle[] } = { strokes: strokes.map((s) => ({ ...s })) };
      fn(draft);
      patch((b) => void (b.vector.lines = draft.strokes.map(strokeSetFrom)));
    },
    commit: (path, value) => {
      if (typeof value !== "number") return;
      const [, id, ...rest] = path.split(".");
      const draft = strokes.map((s) => ({ ...s }));
      const target = draft.find((s) => s.id === id);
      if (!target) return;
      setStrokeScalar(target, rest.join("."), value);
      patch((b) => void (b.vector.lines = draft.map(strokeSetFrom)));
    },
    read: (path) => {
      const [, id, ...rest] = path.split(".");
      const s = strokes.find((x) => x.id === id);
      return s ? strokeScalar(s, rest.join(".")) : undefined;
    },
  };
  return <StrokeStackEditor host={host} scope="brush" />;
}

/**
 * The live pad — the studio's whole point. A demo stroke with sweeping pressure
 * re-renders on every change, and anything you draw runs through the SAME
 * painter the stage uses, so what you tune is what you paint.
 *
 * The two engines diverge here for a real reason. A pixel stroke is incremental
 * — dabs land as you move and are never re-stamped, which is how the stage stays
 * fast. A vector stroke has no meaning until the whole line is fitted, so the
 * pad refits live and draws the ANCHORS it produced: the number and placement of
 * anchors is what "smoothing" actually does, and it is invisible in a picture of
 * a line.
 */
function Playground({ brush }: { brush: BrushPreset }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const pressure = useDrawing((s) => s.pressure);
  const vector = brush.engine === "vector";
  const [anchors, setAnchors] = React.useState<number | null>(null);

  const rasterRef = React.useRef<{ engine: StrokeEngine; pointerId: number } | null>(null);
  const vectorRef = React.useRef<{ samples: PenSample[]; pointerId: number } | null>(null);
  /** Strokes already drawn in the pad — repainted whenever the pad redraws. */
  const doodlesRef = React.useRef<PenSample[][]>([]);

  const INK = "#F4F2ED";
  const CSS_H = 150;

  const repaint = React.useCallback(
    (live: PenSample[] | null) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const cssW = canvas.offsetWidth || 640;
      canvas.width = cssW * 2;
      canvas.height = CSS_H * 2;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(2, 2);
      // The demo sweep occupies the left half; the rest is yours to draw in.
      renderBrushStroke(ctx, brush, pressure, demoSamples(cssW / 2, CSS_H), INK);
      let count: number | null = null;
      for (const samples of [...doodlesRef.current, ...(live ? [live] : [])]) {
        renderBrushStroke(ctx, brush, pressure, samples, INK);
        if (vector) {
          const stroke = vectorPreviewStroke(brush, pressure, samples);
          if (stroke) {
            drawAnchors(ctx, stroke.subpaths);
            count = (count ?? 0) + stroke.subpaths.reduce((n, sp) => n + sp.points.length, 0);
          }
        }
      }
      ctx.restore();
      if (vector) {
        const demo = vectorPreviewStroke(brush, pressure, demoSamples(cssW / 2, CSS_H));
        setAnchors((count ?? 0) + (demo?.subpaths.reduce((n, sp) => n + sp.points.length, 0) ?? 0));
      } else {
        setAnchors(null);
      }
    },
    [brush, pressure, vector],
  );

  React.useEffect(() => repaint(null), [repaint]);

  const localSamples = (e: React.PointerEvent): PenSample[] => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const native = e.nativeEvent;
    const events =
      typeof native.getCoalescedEvents === "function" && native.getCoalescedEvents().length > 0
        ? native.getCoalescedEvents()
        : [native];
    return events.map((ev) => ({
      x: ev.clientX - rect.left,
      y: ev.clientY - rect.top,
      pressure: e.pointerType === "pen" ? ev.pressure : 0.8,
      tiltX: ev.tiltX ?? 0,
      tiltY: ev.tiltY ?? 0,
      timeMs: ev.timeStamp,
    }));
  };

  /** Raster only: stamp the dabs this move produced, nothing more. */
  const stampLive = (samples: PenSample[], engine: StrokeEngine) => {
    const ctx = canvasRef.current!.getContext("2d")!;
    ctx.save();
    ctx.scale(2, 2);
    ctx.globalAlpha = brush.opacity;
    stampDabs({ ctx }, samples.flatMap((s) => engine.feed(s)), brush, INK);
    ctx.restore();
  };

  const onDown = (e: React.PointerEvent) => {
    capturePointer((e.currentTarget as HTMLElement), e.pointerId);
    const samples = localSamples(e);
    if (vector) {
      vectorRef.current = { samples, pointerId: e.pointerId };
      repaint(samples);
      return;
    }
    const engine = new StrokeEngine(brush, pressure, brush.size, 1, Date.now() & 0xffff);
    rasterRef.current = { engine, pointerId: e.pointerId };
    stampLive(samples, engine);
  };

  const onMove = (e: React.PointerEvent) => {
    if (vector) {
      const v = vectorRef.current;
      if (!v || v.pointerId !== e.pointerId) return;
      v.samples.push(...localSamples(e));
      repaint(v.samples);
      return;
    }
    const r = rasterRef.current;
    if (!r || r.pointerId !== e.pointerId) return;
    stampLive(localSamples(e), r.engine);
  };

  const onUp = () => {
    const v = vectorRef.current;
    if (v && v.samples.length > 1) doodlesRef.current.push(v.samples);
    vectorRef.current = null;
    rasterRef.current = null;
  };

  return (
    <div className="shrink-0 border-b border-border/60 bg-[#101014]">
      <canvas
        ref={canvasRef}
        className="w-full touch-none"
        style={{ height: CSS_H, cursor: cursors.crosshair }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={() => {
          doodlesRef.current = [];
          repaint(null);
        }}
      />
      <div className="flex items-center justify-between px-3 pb-1.5 text-[10px] text-muted-foreground">
        <span>Draw here to try it — pen pressure applies. Double-click to clear.</span>
        {anchors !== null && <span className="tabular-nums">{anchors} anchors</span>}
      </div>
    </div>
  );
}

/** The fitted anchors, so "smoothing" stops being a number you guess at. */
function drawAnchors(ctx: CanvasRenderingContext2D, subpaths: ReadonlyArray<Contour>): void {
  ctx.save();
  ctx.fillStyle = "#7B8AF0";
  for (const sp of subpaths) {
    for (const pt of sp.points) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

