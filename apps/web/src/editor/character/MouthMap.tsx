"use client";

import * as React from "react";
import {
  lipSyncPoseFor,
  lipSyncVisemeAt,
  locateClip,
  resolvePose,
  updateBehavior,
  visemeMapped,
  VISEME_MAP_PREFIX,
  type Behavior,
  type GroupClip,
  type Pose,
  type PoseSet,
} from "@solomotion/core";
import { VISEME_ORDER, VISEMES, type VisemeId } from "@solomotion/lipsync";
import { Check, RotateCcw } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { characterArt, PoseThumb, type CharacterArt } from "./pose-art";
import { setPosePreview } from "./pose-preview";

/**
 * THE MOUTH MAP — every sound a voice makes, and the drawing it shows.
 *
 * Lip sync used to map visemes to poses invisibly (by name, alias, fallback)
 * and the only way to learn that "MBP" was showing your "Smile" was to scrub
 * and squint. Here each of the nine shapes is a tile with the pose it lands on;
 * the one sounding at the playhead is lit; hovering a tile previews it on the
 * canvas; clicking it re-points it to any pose of the set, or back to
 * Automatic. The map IS the evaluator's (`lipSyncPoseFor`), so what a tile
 * shows is what the mouth will do. Rest is the card's "In pauses".
 */
export function MouthMap({ character, behavior }: { character: GroupClip; behavior: Behavior }) {
  const doc = useDoc();
  const g = (locateClip(doc, character.id)?.clip as GroupClip | undefined) ?? character;
  const setRef = String(behavior.set ?? "");
  const set = (g.poses ?? []).find((s) => s.id === setRef || s.name === setRef);
  // Lit only while you are LOOKING at an instant — paused or scrubbing. A
  // playing transport must never re-render React; it reads -1 throughout.
  const at = useSession((s) => (s.playing ? -1 : s.playheadMs));
  const art = React.useMemo(() => characterArt(doc, g.id), [doc, g.id]);
  if (!set || !set.poses.length) return null;
  const sounding = at >= 0 ? lipSyncVisemeAt(doc, g, set, behavior, at) : null;

  return (
    <div className="pt-1 pb-2">
      <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Mouth map
        {VISEME_ORDER.some((v) => visemeMapped(behavior, v)) && <ResetMap character={g} behavior={behavior} />}
      </div>
      <div className="grid grid-cols-5 gap-1 @[620px]:grid-cols-9">
        {VISEME_ORDER.map((v) => (
          <VisemeTile key={v} viseme={v} character={g} set={set} behavior={behavior} art={art} lit={sounding === v} />
        ))}
      </div>
    </div>
  );
}

function ResetMap({ character, behavior }: { character: GroupClip; behavior: Behavior }) {
  const store = useDocStore();
  const clear = () =>
    store.update("Reset mouth map", (d) => void updateBehavior(d, character.id, behavior.id, Object.fromEntries(VISEME_ORDER.map((v) => [`${VISEME_MAP_PREFIX}${v}`, null]))));
  return (
    <button type="button" onClick={clear} title="Every shape back to Automatic" className="flex items-center gap-1 normal-case tracking-normal hover:text-foreground [&_svg]:size-3">
      <RotateCcw /> Automatic
    </button>
  );
}

function VisemeTile({ viseme, character, set, behavior, art, lit }: { viseme: VisemeId; character: GroupClip; set: PoseSet; behavior: Behavior; art: CharacterArt; lit: boolean }) {
  const store = useDocStore();
  const [open, setOpen] = React.useState(false);
  const info = VISEMES[viseme];
  // Rest is "In pauses" — the card's own field, so the map and the row agree.
  const key = viseme === "X" ? "rest" : `${VISEME_MAP_PREFIX}${viseme}`;
  const chosen = viseme === "X" ? String(behavior.rest ?? "") : visemeMapped(behavior, viseme);
  const pose = resolvePose(set, lipSyncPoseFor(behavior, viseme));
  const assign = (name: string) => {
    store.update(`${info.name} → ${name || "Automatic"}`, (d) => void updateBehavior(d, character.id, behavior.id, { [key]: name || (viseme === "X" ? "" : null) }));
    setOpen(false);
  };
  const preview = (p: Pose | null) => setPosePreview(p ? { groupId: character.id, setId: set.id, poseId: p.id } : null);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onPointerEnter={() => preview(pose)}
          onPointerLeave={() => preview(null)}
          title={`${info.sounds} — as in “${info.example}”`}
          className={cn(
            "group relative flex flex-col items-center gap-0.5 rounded-md border p-1 transition-colors",
            lit ? "border-primary bg-primary/10" : "border-border/60 hover:border-border hover:bg-accent/40",
            open && "border-primary/70",
          )}
        >
          {pose ? <PoseThumb art={art} character={character} set={set} pose={pose} className="w-full rounded-[4px]" /> : <span className="aspect-square w-full rounded-[4px] bg-muted/40" />}
          <span className="text-2xs font-semibold leading-none">{info.name}</span>
          <span className={cn("max-w-full truncate text-[10px] leading-none", chosen ? "text-primary" : "text-muted-foreground")}>{pose?.name ?? "—"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <div className="mb-1.5 flex items-baseline justify-between px-0.5">
          <span className="text-[12px] font-semibold">{info.name}</span>
          <span className="text-2xs text-muted-foreground">{info.sounds}</span>
        </div>
        <button
          type="button"
          onClick={() => assign("")}
          className="mb-1.5 flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[12px] hover:bg-accent"
        >
          Automatic
          {!chosen && <Check className="size-3.5" />}
        </button>
        <div className="grid grid-cols-4 gap-1">
          {set.poses.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => assign(p.name)}
              onPointerEnter={() => preview(p)}
              onPointerLeave={() => preview(null)}
              className={cn("flex flex-col items-center gap-0.5 rounded-md border p-0.5", chosen === p.name ? "border-primary" : "border-transparent hover:border-border")}
            >
              <PoseThumb art={art} character={character} set={set} pose={p} className="w-full rounded-[3px]" />
              <span className="max-w-full truncate text-[10px] text-muted-foreground">{p.name}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
