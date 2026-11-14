"use client";

import * as React from "react";
import { depthTrackerFor, type MotionDocument, type DepthTracker, type DocumentStore, type VisualClip } from "@solomotion/core";
import { Aperture, CloudFog, Mountain, Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Note, PanelSection, PropRow } from "../inspector/controls";
import { ObjectField } from "../pick/ObjectField";
import { useTrackRun } from "./track-runs";
import { pauseTrack, resumeTrack, retrack, startTrack, stopTrack } from "./track-controller";
import { addDepthEffect, findDepthOf, makeRelief, patchDepthSolve, useDepthView } from "./depth-controller";
import { useDoc, useDocStore } from "../state/document-context";
import { hasDepthRun } from "./depth-store";

/**
 * DEPTH in the Track tab — find it, see it, use it. How far each pixel is,
 * from a model run on this machine; the maps live beside the project, so a
 * project opened elsewhere says so and offers to find them again.
 */

const MODELS = [
  { value: "auto", label: "Auto", hint: "The video model for footage, the still model for a picture" },
  { value: "video", label: "Video", hint: "Video Depth Anything — steady across a shot; no flicker in fog or a matte" },
  { value: "still", label: "Still", hint: "Depth Anything 3 — one picture at a time, the sharper edges" },
] as const;

export function DepthTrackCard({ store, tracker, clip }: { doc: MotionDocument; store: DocumentStore; tracker: DepthTracker; clip: VisualClip }) {
  const run = useTrackRun(tracker.id);
  const show = useDepthView((s) => s.show);
  const maps = tracker.maps;
  const [here, setHere] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    let live = true;
    if (maps) void hasDepthRun(maps.key).then((ok) => live && setHere(ok));
    return () => {
      live = false;
    };
  }, [maps]);

  return (
    <PanelSection id="track-active" title={tracker.name} hint="How far every pixel is from the lens — read by Fog, Lens blur, Behind and a grade window.">
      {run ? (
        <div className="flex h-7 items-center gap-1.5">
          <div className="relative h-7 min-w-0 flex-1 overflow-hidden rounded-md bg-input/45">
            <div className="absolute inset-y-0 left-0 bg-primary/25 transition-[width] duration-150" style={{ width: `${Math.round((run.done / Math.max(1, run.total)) * 100)}%` }} />
            <span className="relative flex h-full items-center truncate px-2 text-xs tabular-nums">{run.state === "paused" ? "Paused" : (run.note ?? "Finding depth")}</span>
          </div>
          <IconButton label={run.state === "paused" ? "Resume" : "Pause"} onClick={() => (run.state === "paused" ? resumeTrack(tracker.id) : pauseTrack(tracker.id))}>
            {run.state === "paused" ? <Play /> : <Pause />}
          </IconButton>
          <IconButton label="Stop" onClick={() => stopTrack(tracker.id)}>
            <Square className="fill-current" />
          </IconButton>
        </div>
      ) : (
        <Button
          size="sm"
          className="h-7 w-full gap-1.5 text-xs"
          disabled={!!maps && here !== false && !tracker.dirty}
          onClick={() => (maps ? retrack(store, tracker.id) : void startTrack(store, tracker.id))}
        >
          {maps && here !== false && !tracker.dirty ? null : <Play className="size-3" />}
          {!maps ? "Find depth" : here === false ? "Find again on this machine" : tracker.dirty ? "Run again" : "Found"}
        </Button>
      )}
      {maps && <Note tone={here === false ? "warn" : "muted"}>{here === false ? "The maps were made on another machine." : `${maps.model === "video" ? "Video" : "Still"} model · ${maps.times.length} ${maps.times.length === 1 ? "frame" : "frames"} · ${maps.width}×${maps.height}`}</Note>}
      <PropRow label="Model" hint="Video keeps a shot steady; Still is sharper on one picture.">
        <Segmented stretch aria-label="Depth model" value={tracker.solve.model} onChange={(model) => patchDepthSolve(store, tracker.id, { model })} options={MODELS} />
      </PropRow>
      {maps && (
        <>
          <PropRow label="Show depth" toggle hint="Draw the depth over the footage — near is light, far is dark.">
            <Switch checked={show} onCheckedChange={(on) => useDepthView.getState().set(on)} />
          </PropRow>
          <div className="grid grid-cols-3 gap-1 pt-1">
            <Quick icon={CloudFog} label="Fog" hint="Haze that thickens with distance" onClick={() => addDepthEffect(store, clip.id, "fog")} />
            <Quick icon={Aperture} label="Lens blur" hint="Focus at a depth" onClick={() => addDepthEffect(store, clip.id, "lensBlur")} />
            <Quick icon={Mountain} label="Relief" hint="Stand the picture up in 3D on its own depth" onClick={() => makeRelief(store, clip.id)} />
          </div>
          <PropRow label="Behind" hint="Pick a layer above the footage: it goes behind whatever stands in front of it here.">
            <ObjectField
              filter={{ kinds: ["layer"], frameId: clip.frameId, exclude: [clip.id] }}
              value={null}
              noun="layer to put behind"
              placeholder="Pick a layer…"
              onChange={(c) => addDepthEffect(store, c.id, "depthMatte", clip.id)}
            />
          </PropRow>
        </>
      )}
    </PanelSection>
  );
}

/**
 * What a depth CARD (Fog, Lens blur, Behind) says when it has nothing to read
 * — added from the Effects library to footage with no depth yet, or "Behind"
 * on a title with no footage named. Without it the card silently does
 * nothing; with it, depth is one click away from where you asked for it.
 */
export function DepthNeeded({ clip, source }: { clip: VisualClip; source: string }) {
  const doc = useDoc();
  const store = useDocStore();
  const footage = source ? doc.tracks.flatMap((t) => t.clips).find((c) => c.id === source) : clip;
  const tracker = footage && (footage.kind === "video" || footage.kind === "image") ? depthTrackerFor(doc, footage.assetId) : null;
  const run = useTrackRun(tracker?.id);
  if (!footage || (footage.kind !== "video" && footage.kind !== "image")) return <Note tone="warn">Pick the footage in Depth of.</Note>;
  if (tracker?.maps) return null;
  if (run) return <Note>{run.state === "paused" ? "Depth paused" : (run.note ?? "Finding depth…")}</Note>;
  return (
    <div className="flex items-center gap-2 pb-1">
      <Note tone="warn">No depth yet.</Note>
      <Button size="sm" variant="secondary" className="ml-auto h-6 gap-1 px-2 text-xs" onClick={() => (tracker ? void startTrack(store, tracker.id) : findDepthOf(store, footage.id))}>
        <Play className="size-3" /> Find depth
      </Button>
    </div>
  );
}

function Quick({ icon: Icon, label, hint, onClick }: { icon: React.ComponentType<{ className?: string }>; label: string; hint: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="flex h-7 items-center justify-center gap-1 rounded-md bg-input/35 text-[11px] text-muted-foreground transition-colors hover:bg-input/60 hover:text-foreground"
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

