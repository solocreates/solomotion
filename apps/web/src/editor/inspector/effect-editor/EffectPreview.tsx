"use client";

import * as React from "react";
import {
  adjacentKeyframe,
  clipRepresentativeTime,
  layerEffectPath,
  compFps,
  formatFps,
  type AABB,
  type Clip,
  type EffectPreviewScene,
  type EffectPreviewStack,
  type PreviewResolutionSetting,
} from "@solomotion/core";
import { Columns2, Eye, Maximize2, Pause, Play, Settings2, SquareDashed } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ZoomControl } from "@/components/ui/zoom-control";
import { cn } from "@/lib/utils";
import { useDoc } from "../../state/document-context";
import { useSession, useParkedPlayhead } from "../../state/session";
import { usePanZoomSurface } from "../../state/use-pan-zoom-surface";
import { stageHitRects } from "../../stage/stage-geometry";
import { capturePointer } from "../../input/capture-pointer";
import { EffectPreviewEngine, type PreviewMode } from "./preview-engine";
import { useEffectEditor } from "./store";

/**
 * THE live effect preview — one component that previews ANY effect, because it
 * doesn't know about effects at all: it renders the REAL frame through the REAL
 * renderer (`drawFrameContent`, the same call the stage and the exporter make),
 * framed on the layer being edited. Whatever the card does to the picture, this
 * shows, including effects that read their surroundings (glass refracts the
 * layers behind it) which a swatch-style thumbnail could never fake.
 *
 * Three modes, one gesture: After, a draggable Split, and Before — so you can
 * always answer "is this actually better?". The Before pass renders a
 * structurally-shared copy of the document with just this card disabled.
 *
 * Three things make it more than a thumbnail:
 *
 * · THE SUBJECT IS ALWAYS THERE. The preview renders at a time CLAMPED into the
 *   clip's own span, so a playhead parked before or after the layer still shows
 *   the layer instead of an empty checkerboard. Clamping (rather than trusting
 *   the playhead) is what makes this work identically for an image, a video, a
 *   vector, a nested comp or a text layer — it never has to know the kind.
 *
 * · ONLY THE EFFECT MOVES, AND IT IS CHEAP. A card that changes with time
 *   plays a short loop with the picture frozen on the playhead. Everything
 *   about how that stays light — the baked scene, the kept prefix beneath the
 *   card, the loop in memory, the pacing and the heavy pause — lives in
 *   `preview-engine.ts`; this file is the view.
 *
 * · IT ZOOMS. Grain, dust and a scanline pitch are pixel-scale decisions you
 *   cannot make in a 170px box. The camera is the shared `usePanZoomSurface` —
 *   the same trackpad/pinch/space-drag grammar as the stage and the node board
 *   — so nobody has to zoom the whole browser to look closely.
 */

export function EffectPreview({ clip, effectId }: { clip: Clip; effectId: string }) {
  const doc = useDoc();
  const playheadMs = useParkedPlayhead();
  const [mode, setMode] = React.useState<PreviewMode>("split");
  const settings = useEffectEditor((s) => s.previewSettings);
  const [split, setSplit] = React.useState(0.5);
  const [fitWhole, setFitWhole] = React.useState(false);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = React.useState({ w: 320, h: 180 });

  // The camera lives in FRAME coordinates, so zooming the preview is the same
  // maths the stage does and `fit` can take a plain world box.
  const surface = usePanZoomSurface(
    { scale: 1, tx: 0, ty: 0 },
    { minScale: 0.05, maxScale: 32, fitPaddingPx: 8, dragToPan: true },
  );
  const [zoom, setZoom] = React.useState(1);
  React.useEffect(() => setZoom(surface.camera.scale), [surface.camera.scale]);

  const frame = React.useMemo(
    () => doc.frames.find((f) => f.id === (clip.kind === "audio" ? null : clip.frameId)) ?? null,
    [doc.frames, clip],
  );

  /**
   * Document time for the preview: the playhead, pulled into the clip's own
   * span, so a card opened on a clip that starts later (or has already ended)
   * never previews an empty transparent frame. Works for every clip kind
   * because it only reasons about the span — image, video, vector, text, nested.
   */
  // The clip's OWN comp sets the rate here — an effect card opened on a layer
  // in a 12fps sheet must preview the gate that sheet will actually export.
  const fps = compFps(doc, clip.frameId);
  const previewTimeMs = React.useMemo(
    () => clipRepresentativeTime(clip, playheadMs, fps),
    [clip, playheadMs, fps],
  );

  // Track the container so the preview stays crisp as the window is resized.
  React.useEffect(() => {
    const el = surface.containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      setSize({ w: Math.max(80, Math.round(r.width)), h: Math.max(60, Math.round(r.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [surface.containerRef]);

  /** The world box the preview frames: the layer plus breathing room, or the comp. */
  const targetBounds = React.useCallback((): AABB | null => {
    if (!frame) return null;
    if (fitWhole) return { minX: 0, minY: 0, maxX: frame.width, maxY: frame.height };
    // The layer's painted box, published by the renderer itself — so rotation,
    // nesting and instancing are already accounted for.
    const hit = stageHitRects.current.find((r) => r.clipId === clip.id);
    if (!hit) return { minX: 0, minY: 0, maxX: frame.width, maxY: frame.height };
    const pad = Math.max(hit.width, hit.height) * 0.45 + 24;
    return {
      minX: hit.cx - frame.x - hit.width / 2 - pad,
      minY: hit.cy - frame.y - hit.height / 2 - pad,
      maxX: hit.cx - frame.x + hit.width / 2 + pad,
      maxY: hit.cy - frame.y + hit.height / 2 + pad,
    };
  }, [frame, fitWhole, clip.id]);

  const fitNow = React.useCallback(() => {
    const b = targetBounds();
    if (b) surface.fit(b);
  }, [targetBounds, surface]);

  // Re-frame when the subject changes, never while the user is looking around:
  // an auto-fit that fought your zoom would make close inspection impossible.
  React.useEffect(() => {
    fitNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, effectId, fitWhole, size.w, size.h]);

  // THE ENGINE owns the canvas, the clock and every kept pixel; React only
  // tells it what is on screen. Its loop repaints without a React render —
  // the performance contract forbids playback re-rendering React.
  const engineRef = React.useRef<EffectPreviewEngine | null>(null);
  engineRef.current ??= new EffectPreviewEngine();
  const engine = engineRef.current;
  // Attached in an effect as well as by the ref, so a StrictMode remount —
  // which disposes and re-runs this — comes back with a live canvas.
  React.useEffect(() => {
    engine.attach(canvasRef.current);
    return () => engine.dispose();
  }, [engine]);
  const attachCanvas = React.useCallback((el: HTMLCanvasElement | null) => {
    canvasRef.current = el;
    engine.attach(el);
  }, [engine]);
  React.useLayoutEffect(() => {
    engine.update({
      doc,
      clip,
      effectId,
      frame,
      timeMs: previewTimeMs,
      fps,
      width: size.w,
      height: size.h,
      camera: surface.camera,
      mode,
      split,
      settings,
    });
  });
  const status = React.useSyncExternalStore(engine.subscribe, engine.getStatus, engine.getStatus);

  const onSplitDrag = (e: React.PointerEvent) => {
    if (mode !== "split") return;
    const host = surface.containerRef.current;
    if (!host) return;
    e.stopPropagation(); // the divider owns this drag, not the camera
    capturePointer(e.currentTarget, e.pointerId);
    const r = host.getBoundingClientRect();
    setSplit(Math.min(0.98, Math.max(0.02, (e.clientX - r.left) / r.width)));
  };

  return (
    <div className="space-y-1.5">
      <div
        ref={surface.containerRef}
        onPointerDown={surface.onPanPointerDown}
        onDoubleClick={fitNow}
        title="Scroll to pan · ⌘-scroll or pinch to zoom · drag to move · double-click to fit"
        className={cn(
          "relative h-[168px] w-full touch-none overflow-hidden rounded-lg border border-border/70 bg-[conic-gradient(#00000014_90deg,transparent_90deg_180deg,#00000014_180deg_270deg,transparent_270deg)] bg-[length:16px_16px]",
          surface.panning ? "cursor-grabbing" : "cursor-grab",
        )}
      >
        <canvas ref={attachCanvas} className="absolute inset-0 size-full" />
        {mode === "split" && (
          <div
            onPointerDown={onSplitDrag}
            onPointerMove={(e) => e.buttons === 1 && onSplitDrag(e)}
            style={{ left: `${split * 100}%` }}
            className="absolute inset-y-0 z-10 -ml-2 w-4 cursor-ew-resize"
          >
            <div className="absolute inset-y-0 left-2 w-px bg-white/70 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]" />
            <div className="absolute left-2 top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/30 bg-white/90 shadow" />
          </div>
        )}
        {mode === "split" && (
          <>
            <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-black/45 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-white/90">
              BEFORE
            </span>
            <span className="pointer-events-none absolute right-1.5 top-1.5 rounded bg-black/45 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-white/90">
              AFTER
            </span>
          </>
        )}
        {status.alive && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => (status.playing ? engine.pause() : engine.play())}
            title={
              status.hold === "heavy"
                ? `Paused — a frame takes ${status.costMs} ms. Play builds the loop, then it runs from memory.`
                : status.hold === "stage"
                  ? "Paused while the timeline plays"
                  : status.playing
                    ? "Pause the preview"
                    : "Play the preview"
            }
            className="absolute bottom-1.5 left-1.5 z-20 flex h-5 items-center gap-1 rounded bg-black/55 px-1.5 text-[10px] font-medium tracking-wide text-white/90 transition-colors hover:bg-black/75 [&_svg]:size-2.5"
          >
            {status.playing ? <Pause /> : <Play />}
            {status.hold === "heavy" ? "Heavy" : `${formatFps(fps)} FPS`}
          </button>
        )}
        {status.silent && (
          <SilentNotice clip={clip} effectId={effectId} atMs={previewTimeMs} />
        )}
        {status.alive && status.playing && status.cached < 1 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-white/10">
            <div className="h-full bg-success/80 transition-[width]" style={{ width: `${status.cached * 100}%` }} />
          </div>
        )}
        {/* Zoom lives INSIDE the frame, vertical, in the corner: the preview is
            already short, and a dial stacked below it stole height from the one
            thing you are trying to look at. */}
        <div className="absolute left-1.5 top-1.5 z-20" data-wheel-scroll>
          <ZoomControl
            value={zoom}
            min={surface.minScale}
            max={surface.maxScale}
            scale="log"
            orientation="vertical"
            size="xs"
            length={56}
            caps={false}
            wheel
            onChange={(v) => surface.zoomTo(v)}
            onReset={fitNow}
            // No "%" sign: in a vertical control the readout sets the whole
            // width, and the unit is never in doubt on a zoom dial.
            format={(v) => (v >= 10 ? String(Math.round(v)) + "×" : String(Math.round(v * 100)))}
            aria-label="Preview zoom"
            title="Preview zoom — double-click the preview to fit"
            className="border-white/10 bg-black/45"
          />
        </div>
      </div>
      <div className="flex items-center gap-1">
        <SegButton active={mode === "before"} onClick={() => setMode("before")} icon={<Eye />} label="Before" />
        <SegButton active={mode === "split"} onClick={() => setMode("split")} icon={<Columns2 />} label="Split" />
        <SegButton active={mode === "after"} onClick={() => setMode("after")} icon={<Eye />} label="After" />
        <div className="flex-1" />
        <PreviewSettings />
        <SegButton
          active={fitWhole}
          onClick={() => setFitWhole((v) => !v)}
          icon={fitWhole ? <Maximize2 /> : <SquareDashed />}
          label={fitWhole ? "Frame" : "Layer"}
          title={fitWhole ? "Showing the whole frame" : "Framed on the layer"}
        />
      </div>
    </div>
  );
}

function SegButton({
  active,
  onClick,
  icon,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      className={cn(
        "flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors [&_svg]:size-3",
        active ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

const STACK_OPTIONS: ReadonlyArray<{ value: EffectPreviewStack; label: string; hint: string }> = [
  { value: "solo", label: "This card", hint: "Only this card, on the untouched layer" },
  { value: "through", label: "Up to here", hint: "This card and the cards beneath it" },
  { value: "all", label: "Whole stack", hint: "Every card, as the stage shows it" },
];
const SCENE_OPTIONS: ReadonlyArray<{ value: EffectPreviewScene; label: string; hint: string }> = [
  { value: "scene", label: "Scene", hint: "The layer in its comp" },
  { value: "beneath", label: "Beneath", hint: "Hide the layers above it" },
  { value: "alone", label: "Alone", hint: "The layer by itself" },
];
const RESOLUTION_OPTIONS: ReadonlyArray<{ value: PreviewResolutionSetting; label: string; hint: string }> = [
  { value: "auto", label: "Auto", hint: "As sharp as the preview can show — rises as you zoom in" },
  { value: "full", label: "Full", hint: "Full resolution" },
  { value: "half", label: "½", hint: "Half resolution" },
  { value: "quarter", label: "¼", hint: "Quarter resolution" },
];

/** What the preview runs, what surrounds it, and how sharp — one popover, remembered. */
function PreviewSettings() {
  const settings = useEffectEditor((s) => s.previewSettings);
  const set = useEffectEditor((s) => s.setPreviewSettings);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Preview settings"
          aria-label="Preview settings"
          className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground data-[state=open]:bg-secondary data-[state=open]:text-foreground [&_svg]:size-3.5"
        >
          <Settings2 />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-64 space-y-3 p-3">
        <SettingRow label="Cards">
          <Choice value={settings.stack} options={STACK_OPTIONS} onChange={(stack) => set({ stack })} />
        </SettingRow>
        <SettingRow label="Context">
          <Choice value={settings.scene} options={SCENE_OPTIONS} onChange={(scene) => set({ scene })} />
        </SettingRow>
        <SettingRow label="Resolution">
          <Choice value={settings.resolution} options={RESOLUTION_OPTIONS} onChange={(resolution) => set({ resolution })} />
        </SettingRow>
        <label className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground" title="A moving card that cannot keep up waits for you to press play">
          Pause when heavy
          <Switch checked={settings.pauseWhenHeavy} onCheckedChange={(pauseWhenHeavy) => set({ pauseWhenHeavy })} />
        </label>
      </PopoverContent>
    </Popover>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string; hint: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={value}
      onValueChange={(v) => {
        const picked = options.find((o) => o.value === v);
        if (picked) onChange(picked.value);
      }}
      className="track w-full flex-nowrap gap-0.5 bg-secondary/50"
    >
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value} title={o.hint} className="h-6 flex-1 px-1 text-[11px]">
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/**
 * The card changes nothing at the playhead — say so, and when it is keyed,
 * offer the way to where it does something. The jump is the card header's own
 * rule (`GroupKeyButton`): stop the transport, land on the key.
 */
function SilentNotice({ clip, effectId, atMs }: { clip: Clip; effectId: string; atMs: number }) {
  const prefix = layerEffectPath(effectId, "");
  const tracks = clip.keyframes.filter((t) => t.property.startsWith(prefix));
  const local = atMs - clip.startMs;
  const key = tracks.length ? (adjacentKeyframe(tracks, local, "next") ?? adjacentKeyframe(tracks, local, "prev")) : null;
  const jump = () => {
    if (!key) return;
    const session = useSession.getState();
    session.setPlaying(false);
    session.setPlayhead(clip.startMs + key.timeMs);
  };
  return (
    <div className="pointer-events-none absolute inset-x-0 top-1/2 z-20 flex -translate-y-1/2 justify-center">
      <div
        className="pointer-events-auto flex items-center gap-2 rounded-md bg-black/70 px-2.5 py-1.5 text-[11px] text-white/90 shadow"
        title={tracks.length ? "This card is keyed, and at the playhead it changes nothing" : "At the playhead this card changes nothing"}
      >
        No change here
        {key && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={jump}
            className="rounded bg-white/15 px-1.5 py-0.5 font-medium transition-colors hover:bg-white/25"
          >
            {key.timeMs > local ? "Next key" : "Previous key"}
          </button>
        )}
      </div>
    </div>
  );
}
