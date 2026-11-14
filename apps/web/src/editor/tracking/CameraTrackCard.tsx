"use client";

import * as React from "react";
import { compFps, SENSOR_MM, uncoveredSpans, type MotionDocument, type CameraTracker, type DocumentStore, type VisualClip } from "@solomotion/core";
import { Box, LandPlot, MapPin, Pause, Play, Ruler, Square, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Range } from "@/components/ui/range";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { NumberInput } from "@/components/ui/number-input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Disclosure, Note, PanelSection, PropRow } from "../inspector/controls";
import { useTrackRun } from "./track-runs";
import { clipSourceSpan } from "./frame-source";
import { pauseTrack, resumeTrack, retrack, startTrack, stopTrack } from "./track-controller";
import { groundFromPicked, makeSceneFrom, originFromPicked, patchCameraSolve, resetScene, scaleFromPicked, sceneOf, textOnPicked } from "./camera-controller";
import { openWorldFrame } from "../world/make-3d";
import { useCameraPoints } from "./camera-points";

/**
 * A CAMERA SOLVE in the Track tab — one button to solve, two choices that
 * matter (what kind of shot, whether the lens is known), how good it is, and
 * the scene tools. Everything else is Advanced.
 *
 * The scene tools work ON THE PLATE, After Effects' way: the solve's points
 * are drawn over the footage; click the ones on the floor and set the
 * ground, one for the origin, two a known distance apart for the scale.
 */

const MODES = [
  { value: "auto", label: "Auto", hint: "Moving camera when the shot has depth; tripod when it only turns" },
  { value: "free", label: "Moving", hint: "A camera that travels — a dolly, a handheld walk, a drone" },
  { value: "tripod", label: "Tripod", hint: "A camera that only turns — pans, tilts, zooms on a fixed head" },
] as const;

const EDGES = [
  { value: "720", label: "720" },
  { value: "960", label: "960" },
  { value: "1280", label: "1280" },
  { value: "0", label: "Full" },
] as const;

const NONE: number[] = [];

const errorTone = (px: number) => (px <= 0.7 ? "good" : px <= 1.5 ? "muted" : "warn") as "good" | "muted" | "warn";

export function CameraTrackCard({ doc, store, tracker, clip }: { doc: MotionDocument; store: DocumentStore; tracker: CameraTracker; clip: VisualClip }) {
  const [advanced, setAdvanced] = React.useState(false);
  const s = tracker.solution;
  const lens = s ? (s.focalPx * SENSOR_MM) / Math.max(s.width, s.height) : null;
  const id = tracker.id;
  return (
    <PanelSection id="track-active" title={tracker.name} hint="The shot's camera, solved in 3D: where it was, where it looked, through what lens — and the points it saw.">
      <CameraTransport doc={doc} store={store} tracker={tracker} clip={clip} />
      {s && (
        <Note tone={errorTone(s.error)}>
          {s.mode === "tripod" ? "Tripod" : "Moving"} · {s.error.toFixed(2)} px · {Math.round(lens!)} mm · {s.points.length / 3} points
        </Note>
      )}
      <PropRow label="Shot" hint="Auto tells a travelling camera from one that only turns. Choose when you know.">
        <Segmented stretch aria-label="Kind of shot" value={tracker.solve.mode} onChange={(mode) => patchCameraSolve(store, id, { mode })} options={MODES} />
      </PropRow>
      <PropRow label="Find lens" toggle hint="Off: the lens you shot with, in mm on a full-frame sensor. A known lens makes a short or shallow shot solve better.">
        <Switch checked={tracker.solve.focalLength == null} onCheckedChange={(find) => patchCameraSolve(store, id, { focalLength: find ? null : Math.round(lens ?? 35) })} />
      </PropRow>
      {tracker.solve.focalLength != null && (
        <PropRow label="Lens">
          <NumberInput value={tracker.solve.focalLength} min={4} max={600} step={1} precision={1} unit=" mm" onChange={(focalLength) => patchCameraSolve(store, id, { focalLength })} />
        </PropRow>
      )}
      <Disclosure open={advanced} onToggle={() => setAdvanced((o) => !o)} />
      {advanced && (
        <>
          <PropRow label="Features" hint="Corners followed at once. More is steadier on a busy shot and slower.">
            <Range value={tracker.solve.features} min={100} max={1200} step={50} onChange={(v) => patchCameraSolve(store, id, { features: Math.round(v) })} />
          </PropRow>
          <PropRow label="Analyse at" hint="The picture size features are followed at. A solve needs corners, not pixels.">
            <Segmented stretch aria-label="Analysis size" value={String(tracker.solve.analysisEdge)} onChange={(v) => patchCameraSolve(store, id, { analysisEdge: Number(v) })} options={EDGES} />
          </PropRow>
        </>
      )}
      {s && <SceneTools doc={doc} store={store} tracker={tracker} />}
    </PanelSection>
  );
}

function CameraTransport({ doc, store, tracker, clip }: { doc: MotionDocument; store: DocumentStore; tracker: CameraTracker; clip: VisualClip }) {
  const run = useTrackRun(tracker.id);
  if (run) {
    const p = Math.round((run.done / Math.max(1, run.total)) * 100);
    return (
      <div className="flex h-7 items-center gap-1.5">
        <div className="relative h-7 min-w-0 flex-1 overflow-hidden rounded-md bg-input/45">
          <div className="absolute inset-y-0 left-0 bg-primary/25 transition-[width] duration-150" style={{ width: `${p}%` }} />
          <span className="relative flex h-full items-center truncate px-2 text-xs tabular-nums">{run.state === "paused" ? "Paused" : (run.note ?? "Solving")}</span>
        </div>
        <IconButton label={run.state === "paused" ? "Resume" : "Pause"} onClick={() => (run.state === "paused" ? resumeTrack(tracker.id) : pauseTrack(tracker.id))}>
          {run.state === "paused" ? <Play /> : <Pause />}
        </IconButton>
        <IconButton label="Stop" onClick={() => stopTrack(tracker.id)}>
          <Square className="fill-current" />
        </IconButton>
      </div>
    );
  }
  const [from, to] = clipSourceSpan(doc, clip);
  const frameMs = 1000 / compFps(doc, clip.frameId);
  const missing = uncoveredSpans(tracker.analysis?.coverage ?? [], from, to).filter(([a, b]) => b - a > frameMs * 1.5);
  const solved = !!tracker.solution;
  const label = !solved ? "Solve camera" : tracker.dirty || missing.length ? "Re-solve" : "Solved";
  return (
    <Button size="sm" className="h-7 w-full gap-1.5 text-xs" disabled={label === "Solved"} onClick={() => (solved ? retrack(store, tracker.id) : void startTrack(store, tracker.id))}>
      {label === "Solved" ? null : <Play className="size-3" />}
      {label}
    </Button>
  );
}

function SceneTools({ doc, store, tracker }: { doc: MotionDocument; store: DocumentStore; tracker: CameraTracker }) {
  const pick = useCameraPoints((s) => (s.trackerId === tracker.id ? s.points : NONE));
  const [distance, setDistance] = React.useState(100);
  const n = pick.length;
  const world = sceneOf(doc, tracker.id);
  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        onClick={() => {
          const id = world ?? makeSceneFrom(store, tracker.id);
          if (id && world) openWorldFrame(store, id);
        }}
      >
        <Box className="size-3.5" /> {world ? "Open in 3D" : "Make 3D scene"}
      </Button>
      <div className="flex items-center justify-between px-0.5">
        <span className="text-2xs text-muted-foreground">{n ? `${n} ${n === 1 ? "point" : "points"} picked` : "Click points on the canvas · ⇧ adds"}</span>
        {(tracker.scene || n > 0) && (
          <button
            type="button"
            className="rounded px-1 text-2xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => (n ? useCameraPoints.getState().clear() : resetScene(store, tracker.id))}
          >
            {n ? "Clear" : "Reset scene"}
          </button>
        )}
      </div>
      <div className="grid grid-cols-4 gap-1">
        <Tool icon={LandPlot} label="Ground" hint="The picked points are the floor (three or more)" disabled={n < 3} onClick={() => groundFromPicked(store, tracker.id)} />
        <Tool icon={MapPin} label="Origin" hint="The picked point is the world's centre" disabled={n !== 1} onClick={() => originFromPicked(store, tracker.id)} />
        <Tool icon={Ruler} label="Scale" hint="The two picked points are this far apart" disabled={n !== 2} onClick={() => scaleFromPicked(store, tracker.id, distance)} />
        <Tool icon={Type} label="Text" hint="Text standing on the picked points, in the shot" disabled={n === 0} onClick={() => textOnPicked(store, tracker.id)} />
      </div>
      {n === 2 && (
        <PropRow label="Apart" hint="World units are centimetres.">
          <NumberInput value={distance} min={0.1} step={1} precision={1} unit=" cm" onChange={setDistance} />
        </PropRow>
      )}
    </div>
  );
}

function Tool({ icon: Icon, label, hint, disabled, onClick }: { icon: React.ComponentType<{ className?: string }>; label: string; hint: string; disabled?: boolean; onClick: () => void }) {
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
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
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
