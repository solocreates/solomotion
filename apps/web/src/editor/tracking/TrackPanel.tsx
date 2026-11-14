"use client";

import * as React from "react";
import {
  clipLocalTimeAtSource,
  compFps,
  isTrackAnchor,
  qualityOf,
  trackerConsumers,
  trackHealth,
  uncoveredSpans,
  type MotionDocument,
  type DocumentStore,
  type TrackChannel,
  type TrackMethod,
  type TrackQuality,
  type TrackShape,
  type Tracker,
  type RegionTracker,
  type VisualClip,
} from "@solomotion/core";
import {
  Box,
  Circle,
  Crosshair,
  Droplet,
  FastForward,
  Link2Off,
  Pause,
  PenTool,
  Pentagon,
  Play,
  Plus,
  Rewind,
  Scan,
  Spline,
  Square,
  SquareDashed,
  Trash2,
  Type,
  Video,
  Layers,
  Wind,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Range } from "@/components/ui/range";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { NumberInput } from "@/components/ui/number-input";
import { RenameInput } from "@/components/ui/rename-input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { beginEyedrop } from "@/lib/eyedropper";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { useParkedPlayhead, useSession } from "../state/session";
import { Disclosure, IconTrack, Note, Pair, PanelSection, PropRow } from "../inspector/controls";
import { ObjectField } from "../pick/ObjectField";
import { CoverageStrip } from "./CoverageStrip";
import { CameraTrackCard } from "./CameraTrackCard";
import { solveCameraOf } from "./camera-controller";
import { DepthTrackCard } from "./DepthTrackCard";
import { findDepthOf } from "./depth-controller";
import { useTrackRun } from "./track-runs";
import { clipSourceSpan } from "./frame-source";
import { beginTrackDraw } from "./track-draw";
import { useRegionDraw } from "../stage/region-draw";
import {
  TRACK_FOLLOWS,
  addTextOnTrack,
  addTrackColor,
  attachLayer,
  bakeClip,
  deleteTrack,
  detachClip,
  followsOf,
  makeTrackedRegionEffect,
  patchFollow,
  patchTrackRegion,
  patchTrackSolve,
  pauseTrack,
  removeTrackColor,
  renameTrack,
  resumeTrack,
  retrack,
  setTrackChannels,
  setTrackDetail,
  setTrackMethod,
  setTrackQuality,
  setTrackReferenceToPlayhead,
  sourceMsFor,
  stabilizeFootage,
  startTrack,
  stopTrack,
  type TrackFollows,
} from "./track-controller";

/**
 * THE TRACK TAB — tracking that reads like the job, not like the maths.
 *
 * AE and Resolve ask a person to learn their model before they can follow a
 * face: track points and attach points, Edit Target, a dimension dialog, a
 * window you then "track", a graph of pan/tilt/zoom. Here the order is the
 * order you think in:
 *
 *   1. DRAW over the thing (box, oval, polygon, or the pen). It starts
 *      tracking both ways at once — no Analyze button to find.
 *   2. WATCH it go: the outline rides the footage, the strip under the clip
 *      fills in, the transport pauses, stops, resumes where it was.
 *   3. FIX a frame by dragging the outline; the frames around it re-solve.
 *   4. USE it: stick a layer on it, put text on it, stabilize, blur it, grade
 *      it — or read it from any field (`track("Face").position`, a Track node,
 *      the pick-whip).
 *
 * What it follows is named by the job (Point · Object · Surface · Outline),
 * how hard it looks is ONE Speed ↔ Accuracy dial, and every knob those two
 * stand for is still there under Advanced.
 */

const SHAPES: ReadonlyArray<{ shape: TrackShape; icon: React.ComponentType<{ className?: string }>; label: string }> = [
  { shape: "rect", icon: Square, label: "Box" },
  { shape: "ellipse", icon: Circle, label: "Oval" },
  { shape: "polygon", icon: Pentagon, label: "Polygon" },
  { shape: "path", icon: PenTool, label: "Pen" },
];

const FOLLOW_OPTIONS = [
  { value: "point", label: "Point", icon: Crosshair, hint: "Where it is — a dot, a corner, an eye" },
  { value: "object", label: "Object", icon: Scan, hint: "Where, how big and how turned — a face, a ball, a car" },
  { value: "surface", label: "Surface", icon: SquareDashed, hint: "A flat thing in perspective — a screen, a sign, a wall. Its four corners pin a layer on." },
  { value: "outline", label: "Outline", icon: Spline, hint: "The silhouette bends with it — a hand, a cloth, a moving shape" },
] as const;

const METHOD_OPTIONS = [
  { value: "auto", label: "Auto", hint: "Points when there is texture to hold, pattern when there isn't" },
  { value: "features", label: "Points", hint: "Many corners, outliers voted out — survives a hand passing in front. The only one that sees perspective well." },
  { value: "luma", label: "Pattern", hint: "Matches the patch itself — small or low-texture targets; survives lighting changes" },
  { value: "color", label: "Colour", hint: "Follows a colour — flat, saturated subjects that deform or leave the frame" },
] as const satisfies ReadonlyArray<{ value: TrackMethod; label: string; hint: string }>;

const QUALITY_STOPS: TrackQuality[] = ["fast", "balanced", "precise", "exact"];
const QUALITY_NAME: Record<TrackQuality, string> = { fast: "Fast", balanced: "Balanced", precise: "Precise", exact: "Every frame" };

const CHANNEL_ITEMS: ReadonlyArray<{ id: TrackChannel; label: string; icon: React.ReactNode }> = [
  { id: "position", label: "Position", icon: <Crosshair /> },
  { id: "scale", label: "Scale", icon: <Box /> },
  { id: "rotation", label: "Rotation", icon: <Spline className="rotate-45" /> },
  { id: "perspective", label: "Pin to the surface — corner pin", icon: <SquareDashed /> },
];

const isFootage = (clip: VisualClip): boolean => clip.kind === "video" || clip.kind === "image";

// ── Footage: its trackers ────────────────────────────────────────────────────

export function FootageTrackers({ clip }: { clip: VisualClip }) {
  const doc = useDoc();
  const store = useDocStore();
  const activeId = useSession((s) => s.activeTrackerId);
  const setActive = useSession((s) => s.setActiveTracker);
  const assetId = clip.kind === "video" || clip.kind === "image" ? clip.assetId : null;
  const trackers = React.useMemo(() => doc.trackers.filter((t) => t.source.assetId === assetId), [doc.trackers, assetId]);
  const active = trackers.find((t) => t.id === activeId) ?? null;

  // Opening the tab on footage with trackers focuses one — a tab whose first
  // job is "which one?" when there is only one answer is a wasted click.
  React.useEffect(() => {
    if (!active && trackers.length) setActive(trackers[0]!.id);
  }, [active, trackers, setActive]);

  return (
    <>
      <PanelSection
        id="track-list"
        title="Trackers"
        count={trackers.length || undefined}
        hint="Everything tracked in this footage. Trackers belong to the footage, so a split or retimed clip keeps them."
        actions={<NewTrackMenu clip={clip} />}
      >
        {trackers.length === 0 ? (
          <DrawToTrack clip={clip} />
        ) : (
          <div className="-mx-1 flex flex-col">
            {trackers.map((t) => (
              <TrackerRow key={t.id} doc={doc} store={store} tracker={t} clip={clip} active={t.id === active?.id} onActivate={() => setActive(t.id)} />
            ))}
          </div>
        )}
      </PanelSection>
      {active?.kind === "camera" ? (
        <CameraTrackCard key={active.id} doc={doc} store={store} tracker={active} clip={clip} />
      ) : active?.kind === "depth" ? (
        <DepthTrackCard key={active.id} doc={doc} store={store} tracker={active} clip={clip} />
      ) : active ? (
        <TrackerCard key={active.id} doc={doc} store={store} tracker={active} clip={clip} />
      ) : null}
    </>
  );
}

function NewTrackMenu({ clip }: { clip: VisualClip }) {
  const clipId = clip.id;
  const store = useDocStore();
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="New tracker" className="grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <Plus className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>New tracker — draw it on the canvas</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-40">
        {SHAPES.map(({ shape, icon: Icon, label }) => (
          <DropdownMenuItem key={shape} onSelect={() => beginTrackDraw(clipId, shape)}>
            <Icon className="size-3.5" /> {label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {clip.kind === "video" && (
          <DropdownMenuItem onSelect={() => solveCameraOf(store, clipId)}>
            <Video className="size-3.5" /> Camera
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => findDepthOf(store, clipId)}>
          <Layers className="size-3.5" /> Depth
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The empty state IS the tool: four ways to draw, the camera, one sentence. */
function DrawToTrack({ clip }: { clip: VisualClip }) {
  const clipId = clip.id;
  const store = useDocStore();
  const arming = useRegionDraw((s) => (s.target?.kind === "tracker" && s.target.clipId === clipId ? s.target.shape : null));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-4 gap-1">
        {SHAPES.map(({ shape, icon: Icon, label }) => (
          <button
            key={shape}
            type="button"
            onClick={() => beginTrackDraw(clipId, shape)}
            aria-pressed={arming === shape}
            className={cn(
              "flex h-12 flex-col items-center justify-center gap-1 rounded-md text-[10px] transition-colors",
              arming === shape ? "material-glass-raised text-primary" : "bg-input/35 text-muted-foreground hover:bg-input/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </div>
      <Note>{arming ? "Now draw over it on the canvas." : "Draw over what should be followed — it starts tracking both ways."}</Note>
      <div className={cn("grid gap-1", clip.kind === "video" ? "grid-cols-2" : "grid-cols-1")}>
        {clip.kind === "video" && (
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => solveCameraOf(store, clipId)}>
            <Video className="size-3.5" /> Camera
          </Button>
        )}
        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => findDepthOf(store, clipId)}>
          <Layers className="size-3.5" /> Depth
        </Button>
      </div>
    </div>
  );
}

function TrackerRow({
  doc,
  store,
  tracker,
  clip,
  active,
  onActivate,
}: {
  doc: MotionDocument;
  store: DocumentStore;
  tracker: Tracker;
  clip: VisualClip;
  active: boolean;
  onActivate: () => void;
}) {
  const [renaming, setRenaming] = React.useState(false);
  const run = useTrackRun(tracker.id);
  // How it is doing, as one number: a region's confidence, a camera solve's reprojection error.
  const health = tracker.kind === "region" ? (tracker.samples.some((s) => !isTrackAnchor(s)) ? trackHealth(tracker).average : null) : null;
  const errorPx = tracker.kind === "camera" ? (tracker.solution?.error ?? null) : null;
  return (
    <div
      role="button"
      tabIndex={0}
      data-pick-key={`tracker:${tracker.id}`}
      onClick={onActivate}
      onKeyDown={(e) => e.key === "Enter" && onActivate()}
      onDoubleClick={() => setRenaming(true)}
      className={cn(
        "group/tr flex cursor-default flex-col gap-1 rounded-md px-2 py-1.5 outline-none transition-colors",
        active ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.04]",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="size-2 shrink-0 rounded-full" style={{ background: tracker.color }} />
        {renaming ? (
          <RenameInput
            initial={tracker.name}
            onCommit={(name) => {
              setRenaming(false);
              renameTrack(store, tracker.id, name);
            }}
            className="h-5 min-w-0 flex-1 rounded bg-input/60 px-1 text-xs outline-none"
          />
        ) : (
          <span className={cn("min-w-0 flex-1 truncate text-xs", active && "font-medium")}>{tracker.name}</span>
        )}
        {run ? (
          <span className="shrink-0 tabular-nums text-2xs text-primary">{run.state === "paused" ? "Paused" : `${pct(run.done, run.total)}%`}</span>
        ) : health !== null ? (
          <span className="shrink-0 tabular-nums text-2xs" style={{ color: healthTone(health) }}>
            {Math.round(health * 100)}%
          </span>
        ) : errorPx !== null ? (
          <span className="shrink-0 tabular-nums text-2xs" style={{ color: healthTone(errorPx <= 0.7 ? 1 : errorPx <= 1.5 ? 0.5 : 0) }}>
            {errorPx.toFixed(2)} px
          </span>
        ) : null}
        <button
          type="button"
          aria-label={`Delete ${tracker.name}`}
          onClick={(e) => {
            e.stopPropagation();
            deleteTrack(store, tracker.id);
          }}
          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/tr:opacity-100 focus-visible:opacity-100"
        >
          <Trash2 className="size-3" />
        </button>
      </div>
      <CoverageStrip doc={doc} tracker={tracker} clip={clip} className="text-foreground" />
    </div>
  );
}

const pct = (done: number, total: number) => Math.round((done / Math.max(1, total)) * 100);
const healthTone = (h: number) => (h >= 0.7 ? "#34D399" : h >= 0.45 ? "#FBBF24" : "#F87171");

// ── One tracker ──────────────────────────────────────────────────────────────

function TrackerCard({ doc, store, tracker, clip }: { doc: MotionDocument; store: DocumentStore; tracker: RegionTracker; clip: VisualClip }) {
  const playheadMs = useParkedPlayhead();
  const [advanced, setAdvanced] = React.useState(false);
  const follows = followsOf(tracker.solve.channels);
  const quality = qualityOf(tracker.solve);

  return (
    <PanelSection id="track-active" title={tracker.name} hint="Drag the outline on the canvas to fix a frame — the frames around it re-solve.">
      <Transport store={store} tracker={tracker} clip={clip} doc={doc} playheadMs={playheadMs} />

      <PropRow label="Follows" hint="What to measure. Each adds work — follow only what the shot needs.">
        <Segmented<TrackFollows | "custom">
          stretch
          aria-label="What it follows"
          value={follows}
          onChange={(v) => v !== "custom" && setTrackChannels(store, tracker.id, TRACK_FOLLOWS[v])}
          options={FOLLOW_OPTIONS}
        />
      </PropRow>

      <PropRow label="Method" hint="Auto picks Points when there is texture, Pattern when there isn't. Points survives occlusion and sees perspective; Pattern suits small, plain targets; Colour follows a colour that may leave the frame.">
        {/* A list, not a strip: four words do not fit a 200px column, and the
            method is a choice made once — Auto is right nearly always. */}
        <Select value={tracker.solve.method} onValueChange={(m) => setTrackMethod(store, tracker.id, m as TrackMethod, "#ff2e88")}>
          <SelectTrigger className="h-7 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {METHOD_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value} title={o.hint} className="text-xs">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PropRow>

      {tracker.solve.method === "color" && <ColorTargets store={store} tracker={tracker} />}

      <PropRow label="Speed" hint="Fast skips calm frames and looks at a smaller picture; Every frame measures all of them at full size. Auto steps back to single frames wherever it doubts itself.">
        <Range
          value={quality === "custom" ? 1 : QUALITY_STOPS.indexOf(quality)}
          min={0}
          max={3}
          step={1}
          ticks={[0, 1, 2, 3]}
          format={(v) => (quality === "custom" ? "Custom" : QUALITY_NAME[QUALITY_STOPS[Math.round(v)]!])}
          onChange={(v) => setTrackQuality(store, tracker.id, QUALITY_STOPS[Math.round(v)]!)}
        />
      </PropRow>

      <Health doc={doc} tracker={tracker} clip={clip} playheadMs={playheadMs} />

      <Disclosure open={advanced} onToggle={() => setAdvanced((o) => !o)} />
      {advanced && <Advanced store={store} tracker={tracker} playheadMs={playheadMs} />}

      <UseIt store={store} tracker={tracker} clip={clip} />
      <UsedBy doc={doc} tracker={tracker} />
    </PanelSection>
  );
}

/**
 * ◀◀ backward from here · Track (whatever is missing, both ways) · forward ▶▶.
 * While running the same row is the run: progress, pause/resume, stop. Stop
 * keeps everything solved; pressing Track again carries on from the gaps.
 */
function Transport({ doc, store, tracker, clip, playheadMs }: { doc: MotionDocument; store: DocumentStore; tracker: RegionTracker; clip: VisualClip; playheadMs: number }) {
  const run = useTrackRun(tracker.id);
  if (run) {
    const p = pct(run.done, run.total);
    return (
      <div className="flex h-7 items-center gap-1.5">
        <div className="relative h-7 min-w-0 flex-1 overflow-hidden rounded-md bg-input/45">
          <div className="absolute inset-y-0 left-0 bg-primary/25 transition-[width] duration-150" style={{ width: `${p}%` }} />
          <span className="relative flex h-full items-center px-2 text-xs tabular-nums">
            {run.state === "paused" ? "Paused" : "Tracking"} · {run.done}/{run.total}
          </span>
        </div>
        <TransportButton label={run.state === "paused" ? "Resume" : "Pause"} onClick={() => (run.state === "paused" ? resumeTrack(tracker.id) : pauseTrack(tracker.id))}>
          {run.state === "paused" ? <Play /> : <Pause />}
        </TransportButton>
        <TransportButton label="Stop — keeps what's tracked" onClick={() => stopTrack(tracker.id)}>
          <Square className="fill-current" />
        </TransportButton>
      </div>
    );
  }
  const here = sourceMsFor(doc, clip, playheadMs);
  const [from, to] = clipSourceSpan(doc, clip);
  // A sliver under a frame and a half is the grid's rounding at the clip's
  // edges, not footage left to track.
  const frameMs = 1000 / compFps(doc, clip.frameId);
  const missing = uncoveredSpans(tracker.analysis?.coverage ?? [], from, to).filter(([a, b]) => b - a > frameMs * 1.5);
  const complete = missing.length === 0;
  const primary = complete ? (tracker.dirty ? "Re-solve" : "Tracked") : tracker.analysis?.coverage.length ? "Continue" : "Track";
  return (
    <div className="flex h-7 items-center gap-1">
      <TransportButton label="Track backward from here" onClick={() => void startTrack(store, tracker.id, { kind: "backward", fromMs: here })}>
        <Rewind />
      </TransportButton>
      <Button
        size="sm"
        className="h-7 flex-1 gap-1.5 text-xs"
        disabled={complete && !tracker.dirty}
        onClick={() => (complete ? retrack(store, tracker.id) : void startTrack(store, tracker.id, { kind: "all" }))}
      >
        {primary === "Tracked" ? null : <Play className="size-3" />}
        {primary}
      </Button>
      <TransportButton label="Track forward from here" onClick={() => void startTrack(store, tracker.id, { kind: "forward", fromMs: here })}>
        <FastForward />
      </TransportButton>
    </div>
  );
}

function TransportButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className="grid size-7 shrink-0 place-items-center rounded-md bg-input/45 text-muted-foreground transition-colors hover:bg-input/80 hover:text-foreground [&_svg]:size-3.5"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ColorTargets({ store, tracker }: { store: DocumentStore; tracker: RegionTracker }) {
  return (
    <PropRow label="Colours">
      <div className="flex flex-wrap items-center gap-1">
        {tracker.solve.colors.map((c, i) => (
          <button
            key={i}
            type="button"
            onClick={() => removeTrackColor(store, tracker.id, i)}
            className="group relative size-5 rounded border border-border/70"
            style={{ background: c.color }}
            aria-label={`${c.color} — remove`}
          >
            {tracker.solve.colors.length > 1 && <X className="absolute inset-0 m-auto size-3 text-white opacity-0 mix-blend-difference group-hover:opacity-100" />}
          </button>
        ))}
        <button
          type="button"
          aria-label="Sample a colour from the canvas"
          onClick={async () => {
            const color = await beginEyedrop();
            if (color) addTrackColor(store, tracker.id, color);
          }}
          className="grid size-5 place-items-center rounded border border-dashed border-border text-muted-foreground hover:text-foreground"
        >
          <Droplet className="size-3" />
        </button>
      </div>
    </PropRow>
  );
}

/** How the track is doing, and the way to the part that needs you. */
function Health({ doc, tracker, clip, playheadMs }: { doc: MotionDocument; tracker: RegionTracker; clip: VisualClip; playheadMs: number }) {
  if (!tracker.samples.some((s) => !isTrackAnchor(s))) return null;
  const h = trackHealth(tracker);
  const nextWeak = () => {
    const times = h.weakSpans.map((s) => clip.startMs + clipLocalTimeAtSource(doc, clip, s.fromMs)).sort((a, b) => a - b);
    const next = times.find((t) => t > playheadMs + 1) ?? times[0];
    if (next !== undefined) useSession.getState().setPlayhead(next);
  };
  if (h.weakSpans.length === 0)
    return <Note tone="good">{h.anchors ? `Holding · ${h.anchors} ${h.anchors === 1 ? "fix" : "fixes"} kept` : "Holding"}</Note>;
  return (
    <div className="flex items-center gap-2">
      <Note tone="warn">
        {h.weakSpans.length} shaky {h.weakSpans.length === 1 ? "span" : "spans"}
      </Note>
      <button type="button" onClick={nextWeak} className="ml-auto rounded px-1.5 py-0.5 text-2xs text-primary transition-colors hover:bg-primary/10">
        Go to next
      </button>
    </div>
  );
}

const EDGES = [
  { value: "720", label: "720" },
  { value: "1280", label: "1280" },
  { value: "1920", label: "1920" },
  { value: "0", label: "Full" },
] as const;

function Advanced({ store, tracker, playheadMs }: { store: DocumentStore; tracker: RegionTracker; playheadMs: number }) {
  const s = tracker.solve;
  const id = tracker.id;
  return (
    <div className="flex flex-col gap-1.5">
      <PropRow label="Channels" hint="Exactly which motions are measured — what the Follows presets set.">
        <IconTrack
          items={[...CHANNEL_ITEMS.slice(0, 3), { id: "skew", label: "Skew", icon: <Box className="-skew-x-12" /> }, CHANNEL_ITEMS[3]!, { id: "shape", label: "Outline bends", icon: <Spline /> }]}
          value={s.channels}
          onPick={(c) => setTrackChannels(store, id, s.channels.includes(c) ? s.channels.filter((x) => x !== c) : [...s.channels, c])}
        />
      </PropRow>
      <PropRow label="Every frame" toggle hint="Measure every frame instead of skipping calm ones.">
        <Switch checked={s.cadence.mode === "every"} onCheckedChange={(on) => patchTrackSolve(store, id, { cadence: { ...s.cadence, mode: on ? "every" : "auto" } })} />
      </PropRow>
      {s.cadence.mode === "auto" && (
        <>
          <PropRow label="Max skip" hint="The most frames Auto steps over at once on calm footage.">
            <Range value={s.cadence.maxStride} min={1} max={16} step={1} unit=" fr" onChange={(v) => patchTrackSolve(store, id, { cadence: { ...s.cadence, maxStride: Math.round(v) } })} />
          </PropRow>
          <PropRow label="Doubt at" hint="How far a there-and-back check may miss before Auto steps back to single frames. Lower is stricter.">
            <Range value={s.cadence.doubtPx} min={0.1} max={4} step={0.05} unit=" px" onChange={(v) => patchTrackSolve(store, id, { cadence: { ...s.cadence, doubtPx: v } })} />
          </PropRow>
        </>
      )}
      <PropRow label="Analyse at" hint="The picture size frames are measured at. Smaller is faster and, for anything bigger than a few pixels, just as accurate.">
        <Segmented stretch aria-label="Analysis size" value={String(s.analysisEdge)} onChange={(v) => patchTrackSolve(store, id, { analysisEdge: Number(v) })} options={EDGES} />
      </PropRow>
      <PropRow label="Care" hint="Patch size, search reach and refinement together — slower and more careful to the right.">
        <Range value={s.accuracy} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patchTrackSolve(store, id, { accuracy: v })} />
      </PropRow>
      <PropRow label="Adapt" toggle hint="Refresh what it looks for from well-matched frames, so a subject that turns or changes light keeps lock.">
        <Switch checked={s.adaptive} onCheckedChange={(adaptive) => patchTrackSolve(store, id, { adaptive })} />
      </PropRow>
      {s.channels.includes("shape") && (
        <PropRow label="Points" hint="How many points the outline bends with. Re-derived from the same curve — you never redraw it.">
          <NumberInput value={s.detail} min={4} max={64} step={1} precision={0} onChange={(v) => setTrackDetail(store, id, Math.round(v))} />
        </PropRow>
      )}
      <PropRow label="Edge" hint="The matte a grade window or region effect gets — softness and grow/shrink, in footage pixels.">
        <Pair>
          <NumberInput label="F" value={tracker.region.feather} min={0} max={400} step={1} precision={0} onChange={(feather) => patchTrackRegion(store, id, { feather })} />
          <NumberInput label="E" value={tracker.region.expand} min={-200} max={200} step={1} precision={0} onChange={(expand) => patchTrackRegion(store, id, { expand })} />
        </Pair>
      </PropRow>
      <PropRow label="Invert" toggle hint="The matte covers everything outside the outline.">
        <Switch checked={tracker.region.invert} onCheckedChange={(invert) => patchTrackRegion(store, id, { invert })} />
      </PropRow>
      <PropRow label="Start" hint="The frame the solve radiates from. Move it to a frame where the subject is clearest.">
        <Button variant="outline" size="sm" className="h-7 w-full text-xs" onClick={() => setTrackReferenceToPlayhead(store, id, playheadMs)}>
          Use this frame
        </Button>
      </PropRow>
    </div>
  );
}

/** Put the track to work — each one gesture, each one undo step. */
function UseIt({ store, tracker, clip }: { store: DocumentStore; tracker: RegionTracker; clip: VisualClip }) {
  const solved = tracker.samples.some((s) => !isTrackAnchor(s));
  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <PropRow label="Attach" hint="Pick a layer — on the canvas, the timeline or the layers list — and it rides this track.">
        <ObjectField
          filter={{ kinds: ["layer"], frameId: clip.frameId, exclude: [clip.id] }}
          value={null}
          noun="layer to attach"
          placeholder="Pick a layer…"
          onChange={(c) => attachLayer(store, c.id, tracker.id, { snap: true, channels: tracker.solve.channels.filter((ch) => ch !== "shape") })}
        />
      </PropRow>
      <div className="grid grid-cols-3 gap-1">
        <QuickAction icon={Type} label="Text" hint="A text layer stuck to it" disabled={!solved} onClick={() => addTextOnTrack(store, tracker.id)} />
        <QuickAction icon={Crosshair} label="Stabilize" hint="Hold it still — the footage counter-moves" disabled={!solved} onClick={() => stabilizeFootage(store, tracker.id)} />
        <QuickAction icon={Wind} label="Blur" hint="Blur it, everywhere it goes" disabled={!solved} onClick={() => makeTrackedRegionEffect(store, tracker.id, "blur")} />
      </div>
    </div>
  );
}

function QuickAction({ icon: Icon, label, hint, disabled, onClick }: { icon: React.ComponentType<{ className?: string }>; label: string; hint: string; disabled?: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          onClick={onClick}
          className="flex h-7 items-center justify-center gap-1 rounded-md bg-input/35 text-[11px] text-muted-foreground transition-colors hover:bg-input/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <Icon className="size-3" />
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent>{disabled ? "Track it first" : hint}</TooltipContent>
    </Tooltip>
  );
}

/** Every reader of this tracker — what a re-solve moves, what a delete breaks. */
function UsedBy({ doc, tracker }: { doc: MotionDocument; tracker: Tracker }) {
  const consumers = React.useMemo(() => trackerConsumers(doc, tracker.id), [doc, tracker.id]);
  if (!consumers.length) return null;
  const nameOf = (id: string) => doc.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.name || "Layer";
  return (
    <div className="flex flex-col pt-1">
      <span className="px-0.5 pb-0.5 text-2xs text-muted-foreground">Used by</span>
      {consumers.map((c, i) => {
        const clipId = c.kind === "node" ? c.ownerId : c.clipId;
        const what = c.kind === "follow" ? "follows" : c.kind === "window" ? "grade window" : c.kind === "expression" ? c.path : "Track node";
        return (
          <button
            key={i}
            type="button"
            disabled={!clipId}
            onClick={() => clipId && useSession.getState().select([clipId])}
            className="flex h-6 min-w-0 items-center gap-1.5 rounded px-1 text-left text-xs transition-colors hover:bg-foreground/[0.05] disabled:pointer-events-none"
          >
            <span className="min-w-0 truncate">{clipId ? nameOf(clipId) : "Board"}</span>
            <span className="shrink-0 text-2xs text-muted-foreground">{what}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Any layer: follow a tracker ──────────────────────────────────────────────

/**
 * FOLLOW — this layer rides a tracker. The same object field as everywhere:
 * pick from the list, or aim and point at the tracker's outline on the canvas
 * or its row in a Track tab. It keeps its place when it starts following.
 */
export function FollowSection({ clip }: { clip: VisualClip }) {
  const doc = useDoc();
  const store = useDocStore();
  const b = clip.trackBinding;
  const tracker = b ? (doc.trackers.find((t) => t.id === b.trackerId) ?? null) : null;
  const own = !!tracker && (clip.kind === "video" || clip.kind === "image") && tracker.source.assetId === clip.assetId;
  if (!b && doc.trackers.length === 0) return null;
  return (
    <PanelSection id="track-follow" title={own && b?.invert ? "Stabilize" : "Follow"} defaultOpen={!!b || !isFootage(clip)} hint="Ride a tracker: position, and as much of its turn, size and perspective as you want.">
      <PropRow label="Tracker">
        <ObjectField
          filter={{ kinds: ["tracker"], frameId: clip.frameId }}
          value={b ? `tracker:${b.trackerId}` : null}
          noun="tracker to follow"
          placeholder="None"
          missing="Tracker deleted"
          extras={b ? [{ value: "", label: "Stop following" }] : []}
          onExtra={() => detachClip(store, clip.id)}
          onChange={(c) => (b ? patchFollow(store, clip.id, { trackerId: c.id }) : attachLayer(store, clip.id, c.id))}
        />
      </PropRow>
      {b && tracker && (
        <>
          <PropRow label="Takes">
            <IconTrack
              items={CHANNEL_ITEMS}
              value={b.channels}
              onPick={(ch) => {
                const next = b.channels.includes(ch) ? b.channels.filter((c) => c !== ch) : [...b.channels, ch];
                patchFollow(store, clip.id, { channels: next.length ? next : ["position"] });
              }}
            />
          </PropRow>
          <PropRow label="Offset" hint="Added after the follow, in comp pixels — text above a head.">
            <Pair>
              <NumberInput label="X" value={b.offset.x} step={1} precision={1} onChange={(x) => patchFollow(store, clip.id, { offset: { ...b.offset, x } })} />
              <NumberInput label="Y" value={b.offset.y} step={1} precision={1} onChange={(y) => patchFollow(store, clip.id, { offset: { ...b.offset, y } })} />
            </Pair>
          </PropRow>
          <PropRow label="Smooth" hint="Calms jitter in the track. 0 is the raw measurement.">
            <Range value={b.smooth} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(smooth) => patchFollow(store, clip.id, { smooth })} />
          </PropRow>
          <PropRow label={own ? "Stabilize" : "Counter"} toggle hint="Move against the track instead of with it — on the footage itself, this holds the tracked thing still.">
            <Switch checked={b.invert} onCheckedChange={(invert) => patchFollow(store, clip.id, { invert })} />
          </PropRow>
          <div className="flex gap-1 pt-0.5">
            <Button variant="outline" size="sm" className="h-7 flex-1 gap-1 text-xs" onClick={() => bakeClip(store, clip.id)}>
              <Zap className="size-3" /> Bake to keys
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" className="size-7" aria-label="Stop following" onClick={() => detachClip(store, clip.id)}>
                  <Link2Off className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Stop following</TooltipContent>
            </Tooltip>
          </div>
        </>
      )}
      {b && !tracker && <Note tone="warn">Its tracker was deleted.</Note>}
    </PanelSection>
  );
}

