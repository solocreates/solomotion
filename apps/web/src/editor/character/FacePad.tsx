"use client";

import * as React from "react";
import {
  addPose,
  addPoseFromLayer,
  bakePoseSet,
  choosePose,
  clipsUnderGroup,
  createPoseSet,
  duplicatePose,
  listVocabularies,
  locateClip,
  mirrorPoseInSet,
  poseSetFromSwitch,
  poseDrawingOf,
  poseSetFromLayer,
  switchOptions,
  poseEnvAt,
  poseMatchAt,
  removePose,
  removePoseSet,
  resetToPose,
  sideOf,
  updatePose,
  updatePoseSet,
  type MotionDocument,
  type GroupClip,
  type Pose,
  type PoseChoice,
  type PoseSet,
  type PoseTransition,
} from "@solomotion/core";
import { ArrowRight, MoreHorizontal, Plus, X } from "lucide-react";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { RenameInput } from "@/components/ui/rename-input";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { clipLocalClamped } from "../inspector/animatable";
import { PanelSection } from "../inspector/controls";
import { setPosePreview } from "./pose-preview";


import { characterArt, PoseThumb, type CharacterArt } from "./pose-art";
import { pickPoseNow } from "../timeline/pose-block-actions";
import { editPoseDrawing, newDrawingFromPose } from "./pose-drawing";

/**
 * THE FACE PAD — the Character tab's first section (docs/adr/characters/ux.md
 * §2.3). One row per pose set, one tile per pose: the character's own face in
 * that pose. Click keys the pose at the playhead (Record on) or sets it; hover
 * previews it on the stage; right-click edits the pose. The ring is the pose
 * showing at the playhead.
 *
 * Every write is one core op in one store update — the same ops the agent
 * verbs call (`rig/pose-ops.ts`).
 */

const BLEND_TIMES = [0, 60, 90, 120, 200, 300];

export function FacePad({ character }: { character: GroupClip }) {
  const store = useDocStore();
  const doc = useDoc();
  const sets = character.poses ?? [];
  const switches = React.useMemo(() => switchesUnder(doc, character.id), [doc, character.id]);
  const art = characterArt(doc, character.id);
  React.useEffect(() => () => setPosePreview(null), []);

  const newSet = (label: string, fn: (d: MotionDocument) => string | null) => store.update(label, (d) => void fn(d));

  // Any direct member can become a part of its own; the ones already a set's part are not offered again.
  const partLayers = switchOptions(doc, character.id).filter((c) => !(character.poses ?? []).some((p) => p.part === c.id));
  return (
    <PanelSection
      id="character-face"
      title="Parts"
      count={sets.length || undefined}
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" title="Capture what it looks like now">
              <Plus /> New set
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {switches.length > 0 && (
              <>
                <DropdownMenuLabel className="text-[11px] text-muted-foreground">From a switch</DropdownMenuLabel>
                {switches.map((s) => (
                  <DropdownMenuItem key={s.id} className="text-[12px]" onSelect={() => newSet("New pose set", (d) => poseSetFromSwitch(d, character.id, s.id))}>
                    {s.name}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            )}
            {partLayers.length > 0 && (
              <>
                <DropdownMenuLabel className="text-[11px] text-muted-foreground">From a layer — any part (a tail, ears…)</DropdownMenuLabel>
                {partLayers.map((c) => (
                  <DropdownMenuItem key={c.id} className="text-[12px]" onSelect={() => newSet("New part", (d) => poseSetFromLayer(d, character.id, c.id))}>
                    {c.name || c.kind}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            )}
            {listVocabularies().map((v) => (
              <DropdownMenuItem key={v.id} className="text-[12px]" onSelect={() => newSet("New pose set", (d) => createPoseSet(d, character.id, { name: v.label.split(" ")[0], vocabulary: v.id }))}>
                {v.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem className="text-[12px]" onSelect={() => newSet("New pose set", (d) => createPoseSet(d, character.id, { name: "Poses", vocabulary: null }))}>
              Empty
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      {sets.length === 0 ? null : (
        <div className="flex flex-col gap-2.5">
          {sets.map((set) => (
            <PoseSetRow key={set.id} character={character} set={set} art={art} />
          ))}
        </div>
      )}
    </PanelSection>
  );
}

function switchesUnder(doc: MotionDocument, groupId: string): GroupClip[] {
  const ids = [groupId, ...clipsUnderGroup(doc, groupId)];
  return ids.map((id) => locateClip(doc, id)?.clip).filter((c): c is GroupClip => c?.kind === "group" && !!c.switch);
}

function PoseSetRow({ character, set, art }: { character: GroupClip; set: PoseSet; art: CharacterArt }) {
  const store = useDocStore();
  const doc = useDoc();
  const [renaming, setRenaming] = React.useState<string | null>(null);
  // The ring follows the playhead while parked; playback never re-renders React.
  const parkedMs = useSession((s) => (s.playing ? null : s.playheadMs));
  const lastMs = React.useRef(0);
  if (parkedMs !== null) lastMs.current = parkedMs;
  // Which pose shows is COMPUTED: the chosen one rings; a hand change on top marks it modified.
  const match = React.useMemo(() => poseMatchAt(doc, character, set, lastMs.current, poseEnvAt(doc, lastMs.current, character.frameId)), [doc, character, set, parkedMs]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = match.chosen;
  const [editTransitions, setEditTransitions] = React.useState(false);
  const layers = React.useMemo(() => clipsUnderGroup(doc, character.id).map((id) => locateClip(doc, id)?.clip).filter((c): c is NonNullable<typeof c> => !!c && c.kind !== "audio"), [doc, character.id]);
  const edit = (label: string, fn: (d: MotionDocument) => unknown) => store.update(label, (d) => void fn(d));
  const localNow = () => clipLocalClamped(character, useSession.getState().playheadMs);
  /** The bake's pose reader at the playhead — a capture counts live sets as they show. */
  // Read through the document as it was before the edit (a draft is revoked when the write ends).
  const envNow = (_d: MotionDocument) => poseEnvAt(store.getState(), character.startMs + localNow(), character.frameId);
  const sided = set.poses.some((p) => sideOf(p.name) === "L");

  /** Show this pose now — `choosePose` decides what that means (core, shared with agents). */
  const choose = (pose: Pose) => {
    // Like a clip: the picked blocks, else the one under the playhead (recording: from the playhead on).
    if (pickPoseNow(store, character.id, set.id, pose.id, `Pose ${pose.name}`)) return;
    let result = null as PoseChoice | null;
    edit(`Pose ${pose.name}`, (d) => {
      const g = locateClip(d, character.id)?.clip;
      const s2 = g?.kind === "group" ? g.poses?.find((x) => x.id === set.id) : undefined;
      if (g?.kind === "group" && s2) result = choosePose(d, g, s2, pose.id, useSession.getState().playheadMs, { record: useSession.getState().recording });
    });
    if (result?.kind === "refused") toast.info(result.why);
    else if (result?.kind === "live")
      toast.info(`${set.name} is live — ${result.source.length > 40 ? "driven by an expression" : result.source}.`, {
        action: {
          label: "Bake to keys",
          onClick: () => edit(`Bake ${set.name}`, (d) => void bakePoseSet(d, character.id, set.id, { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }, poseEnvAt(d, 0, character.frameId))),
        },
      });
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-6 items-center gap-1">
        {renaming === set.id ? (
          <RenameInput
            initial={set.name}
            className="h-5 min-w-0 flex-1 rounded bg-background px-1 text-[12px]"
            onCommit={(name) => {
              setRenaming(null);
              if (name.trim() && name !== set.name) edit("Rename pose set", (d) => updatePoseSet(d, character.id, set.id, { name }));
            }}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground" onDoubleClick={() => setRenaming(set.id)}>
            {set.name}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`${set.name} options`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem className="text-[12px]" onSelect={() => setRenaming(set.id)}>
              Rename
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="text-[12px]">Blend time…</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={String(set.blend.ms)} onValueChange={(v) => edit("Blend time", (d) => updatePoseSet(d, character.id, set.id, { blend: { ms: Number(v) } }))}>
                  {BLEND_TIMES.map((ms) => (
                    <DropdownMenuRadioItem key={ms} value={String(ms)} className="text-[12px]">
                      {ms} ms
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="text-[12px]">Between poses</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup value={set.blend.mode ?? "morph"} onValueChange={(v) => edit("Blend mode", (d) => updatePoseSet(d, character.id, set.id, { blend: { mode: v as "morph" | "swap" } }))}>
                  <DropdownMenuRadioItem value="morph" className="text-[12px]">
                    Morph — ease what can ease
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="swap" className="text-[12px]">
                    Swap — change at once
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-[12px]" onSelect={() => setEditTransitions(true)}>
                  Per-pose transitions…
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="text-[12px]">Part</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 w-48 overflow-y-auto">
                <DropdownMenuRadioGroup value={set.part ?? ""} onValueChange={(v) => edit("Set part", (d) => updatePoseSet(d, character.id, set.id, { part: v || null }))}>
                  <DropdownMenuRadioItem value="" className="text-[12px]">
                    Automatic — what its poses change
                  </DropdownMenuRadioItem>
                  {layers.map((c) => (
                    <DropdownMenuRadioItem key={c.id} value={c.id} className="text-[12px]">
                      {c.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem
              className="text-[12px]"
              disabled={!sided}
              onSelect={() => edit("Mirror L ↔ R", (d) => set.poses.filter((p) => sideOf(p.name) === "L").forEach((p) => mirrorPoseInSet(d, character.id, set.id, p.id)))}
            >
              Mirror L ↔ R
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-[12px]" onSelect={() => edit("Delete pose set", (d) => removePoseSet(d, character.id, set.id))}>
              Delete set
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className={cn("grid gap-1.5", art.world ? "grid-cols-[repeat(auto-fill,minmax(92px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(64px,1fr))]")}>
        {set.poses.map((pose) => (
          <ContextMenu key={pose.id}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                aria-pressed={pose.id === current}
                data-pose-tile={pose.name}
                data-modified={pose.id === current && match.modified ? "" : undefined}
                title={pose.id === current && match.modified ? `${pose.name} — changed by hand. Right-click: Update from current, or Reset to pose.` : pose.name}
                className={cn(
                  "group/tile relative flex min-w-0 flex-col items-center gap-0.5 rounded-md bg-input/35 p-1 text-[10px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  pose.id === current && "bg-background text-foreground shadow-sm ring-1 ring-foreground/50",
                  pose.id !== current && match.showing.includes(pose.id) && "ring-1 ring-dashed ring-foreground/30",
                )}
                onClick={() => choose(pose)}
                onPointerEnter={() => setPosePreview({ groupId: character.id, setId: set.id, poseId: pose.id })}
                onPointerLeave={() => setPosePreview(null)}
                onDoubleClick={() => setRenaming(pose.id)}
              >
                <PoseThumb art={art} character={character} set={set} pose={pose} className="w-full rounded-[5px]" />
                {pose.id === current && match.modified && <span aria-label="Changed by hand" className="absolute right-1 top-1 size-1.5 rounded-full bg-warning shadow-[0_0_0_2px_var(--background)]" />}
                {renaming === pose.id ? (
                  <RenameInput
                    initial={pose.name}
                    className="h-4 w-full min-w-0 rounded bg-background px-0.5 text-center text-[10px]"
                    onCommit={(name) => {
                      setRenaming(null);
                      if (name.trim() && name !== pose.name) edit("Rename pose", (d) => updatePose(d, character.id, set.id, pose.id, { name }));
                    }}
                  />
                ) : (
                  <span className="w-full truncate text-center">{pose.name}</span>
                )}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-44">
              <ContextMenuItem className="text-[12px]" onSelect={() => edit("Update pose", (d) => updatePose(d, character.id, set.id, pose.id, { capture: { atMs: localNow() }, env: envNow(d) }))}>
                Update from current
              </ContextMenuItem>
              {pose.id === current && match.modified && (
                <ContextMenuItem
                  className="text-[12px]"
                  onSelect={() =>
                    edit("Reset to pose", (d) => {
                      const g = locateClip(d, character.id)?.clip;
                      const s2 = g?.kind === "group" ? g.poses?.find((x) => x.id === set.id) : undefined;
                      if (g?.kind === "group" && s2) resetToPose(d, g, s2, localNow());
                    })
                  }
                >
                  Reset to pose
                </ContextMenuItem>
              )}
              <ContextMenuItem className="text-[12px]" onSelect={() => edit("Resting pose", (d) => updatePoseSetShow(d, character.id, set.id, pose.name))}>
                Make it the resting pose
              </ContextMenuItem>
              <ContextMenuItem className="text-[12px]" onSelect={() => setRenaming(pose.id)}>
                Rename
              </ContextMenuItem>
              {poseDrawingOf(doc, character.id, set.id, pose.id) && (
                <>
                  <ContextMenuItem className="text-[12px]" onSelect={() => editPoseDrawing(store, character.id, set.id, pose.id)}>
                    Edit drawing
                  </ContextMenuItem>
                  <ContextMenuItem className="text-[12px]" onSelect={() => newDrawingFromPose(store, character.id, set.id, pose.id)}>
                    New drawing from this
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
              <ContextMenuItem className="text-[12px]" onSelect={() => edit("Duplicate pose", (d) => duplicatePose(d, character.id, set.id, pose.id))}>
                Duplicate
              </ContextMenuItem>
              <ContextMenuItem className="text-[12px]" onSelect={() => edit("Mirror pose", (d) => mirrorPoseInSet(d, character.id, set.id, pose.id))}>
                Mirror
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem className="text-[12px]" onSelect={() => edit("Delete pose", (d) => removePose(d, character.id, set.id, pose.id))}>
                Delete
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title="Add a pose — what it shows now, or any layer"
              className="flex min-h-16 flex-col items-center justify-center gap-0.5 rounded-md border border-dashed border-border text-[10px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              <Plus className="size-3.5" />
              Pose
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem className="text-[12px]" onSelect={() => edit("Add pose", (d) => addPose(d, character.id, set.id, { name: "Pose", capture: { atMs: localNow() }, env: envNow(d) }))}>
              From what it shows now
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="text-[12px]">From a layer</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 w-52 overflow-y-auto">
                <DropdownMenuLabel className="text-[11px] text-muted-foreground">Shows in this pose, instead of the part</DropdownMenuLabel>
                {layers.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    className="text-[12px]"
                    onSelect={() => {
                      let made: string | null = null;
                      edit(`Pose from ${c.name}`, (d) => void (made = addPoseFromLayer(d, character.id, set.id, c.id)));
                      if (!made) toast.info(`${c.name} is not inside ${character.name} — move it in first.`);
                    }}
                  >
                    {c.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {editTransitions && <TransitionsEditor character={character} set={set} onClose={() => setEditTransitions(false)} />}
    </div>
  );
}


/** The set's resting pose — what shows when nothing keys or drives it. */
function updatePoseSetShow(d: MotionDocument, groupId: string, setId: string, name: string): void {
  const g = locateClip(d, groupId)?.clip;
  const s = g?.kind === "group" ? g.poses?.find((x) => x.id === setId) : undefined;
  if (s) s.show = name;
}

/** Radix reserves "" — "any pose" rides a sentinel. */
const ANY = "*";

/**
 * PER-POSE TRANSITIONS — a blend for one pair over the set's own: Open → Closed
 * snaps, Closed → Open eases back. The most specific row wins (core
 * `poseBlendFor`).
 */
function TransitionsEditor({ character, set, onClose }: { character: GroupClip; set: PoseSet; onClose: () => void }) {
  const store = useDocStore();
  const rows: PoseTransition[] = set.transitions ?? [];
  const write = (next: PoseTransition[], label: string) =>
    store.update(label, (d) => void updatePoseSet(d, character.id, set.id, { transitions: next }), { mergeKey: `transitions-${set.id}-${label}` });
  const pick = (value: string, onChange: (v: string) => void) => (
    <Select value={value || ANY} onValueChange={onChange}>
      <SelectTrigger className="h-7 min-w-0 flex-1 text-[12px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY} className="text-[12px]">
          Any pose
        </SelectItem>
        {set.poses.map((p) => (
          <SelectItem key={p.id} value={p.name} className="text-[12px]">
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  return (
    <div className="mt-1 flex flex-col gap-1 rounded-md border border-border/70 p-2">
      <div className="flex items-center">
        <span className="flex-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">Transitions · default {set.blend.ms} ms</span>
        <Button variant="ghost" size="icon-sm" aria-label="Close transitions" onClick={onClose}>
          <X />
        </Button>
      </div>
      {rows.map((t, i) => (
        <div key={i} className="flex items-center gap-1">
          {pick(t.from, (v) => write(rows.map((x, j) => (j === i ? { ...x, from: v } : x)), "Transition from"))}
          <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
          {pick(t.to, (v) => write(rows.map((x, j) => (j === i ? { ...x, to: v } : x)), "Transition to"))}
          <div className="w-20 shrink-0">
            <NumberInput value={t.ms} min={0} max={2000} step={10} unit="ms" onChange={(v) => write(rows.map((x, j) => (j === i ? { ...x, ms: Math.max(0, v) } : x)), "Transition time")} />
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Remove transition" onClick={() => write(rows.filter((_, j) => j !== i), "Remove transition")}>
            <X />
          </Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" className="self-start" onClick={() => write([...rows, { from: "*", to: set.poses[0]?.name ?? "*", ms: 40 }], "Add transition")}>
        <Plus /> Add transition
      </Button>
    </div>
  );
}
