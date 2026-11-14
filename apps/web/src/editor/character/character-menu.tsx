"use client";

import * as React from "react";
import {
  behaviorDef,
  characterOf,
  choosePose,
  connectBone,
  setBoneProps,
  locateClip,
  poseDrawingOf,
  poseEnvAt,
  poseSetMixAt,
  resetPose,
  updateBehavior,
  type MotionDocument,
  type Clip,
  type DocumentStore,
  type GroupClip,
} from "@solomotion/core";
import { Bone, Drama, Layers, Link2, MousePointer2, Network, PersonStanding, Pin, RotateCcw, Smile, Sparkles, Unlink, Wrench } from "lucide-react";
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { useSession } from "../state/session";
import { revealInInspector } from "../state/inspector-nav";
import { clipEditMode, EDIT_MODE_LABELS, openClipEditor } from "../state/focus-model";
import { useRigUi } from "../rig/state";
import { useMachineBoard } from "../machines/machine-store";
import { behaviorIcon, behaviorTint } from "./behavior-style";
import { characterArt, PoseThumb } from "./pose-art";
import { pickPoseNow } from "../timeline/pose-block-actions";
import { editPoseDrawing } from "./pose-drawing";

/**
 * A CHARACTER'S MENU — right-click a character, or any part of one, and
 * everything it is made of is one level away: its poses (pick one now), its
 * behaviors (on, off), its rig (pose it, edit its bones), its parts (each
 * edited the way that part edits — the SAME brain a double-click uses, so a
 * path edits in place, a nested comp opens, a text types) and the Character
 * tab for the rest.
 *
 * A right-click on a BONE picks it and lands here too — one menu, never a
 * second popup of its own: the picked bones' verbs (pin, IK or FK, parent,
 * connect) lead, the character follows.
 *
 * Each verb goes where its thing lives: a pose is chosen on the canvas at the
 * playhead (keyed when recording, an override over a behavior), bones are
 * posed or set up in place, a behavior's settings open in the Character tab.
 */

const reveal = (groupId: string, section: string, entry?: string) => {
  useSession.getState().select([groupId]);
  revealInInspector({ tab: "character", section, ...(entry ? { entry } : {}) });
};

/** The direct members of a group — its parts, top first, as the layers list shows them. */
function partsOf(doc: MotionDocument, g: GroupClip): Clip[] {
  return doc.tracks.filter((t) => t.groupId === g.id).flatMap((t) => t.clips.filter((c) => c.frameId === g.frameId));
}

export function characterSection(store: DocumentStore, doc: MotionDocument, single: Clip | undefined): React.ReactElement[] {
  if (!single) return [];
  const g = characterOf(doc, single.id) ?? (single.kind === "group" && (single.rig?.bones.length || single.behaviors?.length) ? single : null);
  if (!g) return [];
  const onPart = g.id !== single.id;
  const at = useSession.getState().playheadMs;
  const env = poseEnvAt(doc, at, g.frameId);
  const sets = (g.poses ?? []).filter((s) => s.poses.length);
  const art = sets.length ? characterArt(doc, g.id) : null;
  const behaviors = g.behaviors ?? [];
  const bones = g.rig?.bones.length ?? 0;
  const parts = partsOf(doc, g);
  // Bones picked on THIS rig (a right-click on a bone picks it): their verbs lead.
  const ui = useRigUi.getState();
  const picked = ui.rigId === g.id ? ui.bones.filter((id) => g.rig?.bones.some((b) => b.id === id)) : [];
  const setup = ui.mode === "setup";
  // The machine its Machine behavior runs (machines live on the comp).
  const machineRef = behaviors.find((b) => b.type === "machine" && typeof b.machine === "string")?.machine as string | undefined;
  const machine = machineRef ? doc.frames.find((f) => f.id === g.frameId)?.machines?.find((m) => m.id === machineRef || m.name === machineRef) : undefined;

  const boneBlock: React.ReactElement[] = [];
  if (picked.length) {
    const all = g.rig!.bones;
    const active = picked[picked.length - 1]!;
    const activeName = all.find((b) => b.id === active)?.name ?? "";
    const children = picked.filter((id) => id !== active);
    const pinned = (ui.pins[g.id] ?? []).includes(active);
    const parented = all.some((b) => picked.includes(b.id) && b.parent);
    const needsSetup = setup ? undefined : "Parenting is setup — Rig ▸ Edit bones";
    boneBlock.push(
      <ContextMenuItem key="bone-pin" onClick={() => ui.togglePins(g.id, picked)}>
        <Pin /> {pinned ? "Unpin" : "Pin"} {picked.length > 1 ? `${picked.length} bones` : activeName}
      </ContextMenuItem>,
      <ContextMenuItem key="bone-grammar" onClick={() => ui.setGrammar(ui.grammar === "reach" ? "rotate" : "reach")}>
        <PersonStanding /> {ui.grammar === "reach" ? "Pose by rotating (FK)" : "Pose by reaching (IK)"}
      </ContextMenuItem>,
      <ContextMenuItem key="bone-parent" disabled={!children.length || !setup} title={needsSetup} onClick={() => store.update("Parent bones", (d) => children.forEach((id) => void setBoneProps(d, g.id, id, { parent: active })))}>
        <Link2 /> {children.length ? `Parent to ${activeName}` : "Parent to… (pick it last)"}
        <ContextMenuShortcut>⌘P</ContextMenuShortcut>
      </ContextMenuItem>,
      <ContextMenuItem key="bone-connect" disabled={!setup || !parented} title={needsSetup} onClick={() => store.update("Connect bones", (d) => picked.forEach((id) => void connectBone(d, g.id, id)))}>
        <Link2 /> Connect to parent
        <ContextMenuShortcut>⌘⇧P</ContextMenuShortcut>
      </ContextMenuItem>,
      <ContextMenuItem key="bone-clear" disabled={!setup || !parented} title={needsSetup} onClick={() => store.update("Clear parent", (d) => picked.forEach((id) => void setBoneProps(d, g.id, id, { parent: null })))}>
        <Unlink /> Clear parent
        <ContextMenuShortcut>⌥P</ContextMenuShortcut>
      </ContextMenuItem>,
      <ContextMenuItem key="bone-reset" onClick={() => store.update("Reset pose", (d) => void resetPose(d, g.id, picked))}>
        <RotateCcw /> Reset {picked.length > 1 ? "their" : "its"} pose
      </ContextMenuItem>,
      <ContextMenuSeparator key="bone-sep" />,
    );
  }

  const body = (
    <>
      <ContextMenuItem onClick={() => reveal(g.id, "character-face")}>
        <Smile /> Edit {g.name}…
      </ContextMenuItem>
      {!!sets.length && <ContextMenuSeparator />}
      {sets.map((set) => {
        const now = poseSetMixAt(doc, g, set, at, env)?.target;
        return (
          <ContextMenuSub key={set.id}>
            <ContextMenuSubTrigger>
              <Drama /> {set.name}
              <span className="ml-auto pl-3 text-2xs text-muted-foreground">{set.poses.find((p) => p.id === now)?.name}</span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="max-h-80 w-48 overflow-y-auto">
              {set.poses.map((p) => (
                <ContextMenuCheckboxItem
                  key={p.id}
                  checked={p.id === now}
                  onClick={() => {
                    if (pickPoseNow(store, g.id, set.id, p.id, `Pose ${p.name}`)) return;
                    store.update(`Pose ${p.name}`, (d) => {
                      const gg = locateClip(d, g.id)?.clip;
                      const ss = gg?.kind === "group" ? gg.poses?.find((x) => x.id === set.id) : undefined;
                      if (gg?.kind === "group" && ss) choosePose(d, gg, ss, p.id, at, { record: useSession.getState().recording, env });
                    });
                  }}
                >
                  {art && <PoseThumb art={art} character={g} set={set} pose={p} className="size-6 rounded-[4px]" />}
                  {p.name}
                </ContextMenuCheckboxItem>
              ))}
              <ContextMenuSeparator />
              {now && poseDrawingOf(doc, g.id, set.id, now) && (
                <ContextMenuItem onClick={() => editPoseDrawing(store, g.id, set.id, now)}>
                  Edit the {set.poses.find((p) => p.id === now)?.name} drawing
                </ContextMenuItem>
              )}
              <ContextMenuItem onClick={() => reveal(g.id, "character-face", set.id)}>Edit poses…</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        );
      })}
      {!!behaviors.length && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Sparkles /> Behaviors
            <span className="ml-auto pl-3 text-2xs text-muted-foreground">{behaviors.filter((b) => b.enabled !== false).length}</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-52">
            {behaviors.map((b) => {
              const Icon = behaviorIcon(b.type);
              const on = b.enabled !== false;
              const label = behaviorDef(b.type)?.label ?? b.type;
              return (
                <ContextMenuCheckboxItem key={b.id} checked={on} onClick={() => store.update(`${on ? "Mute" : "Unmute"} ${label}`, (d) => void updateBehavior(d, g.id, b.id, { enabled: !on }))}>
                  <Icon className="size-3.5" style={{ color: behaviorTint(b.type) }} /> {label}
                </ContextMenuCheckboxItem>
              );
            })}
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => reveal(g.id, "character-behaviors")}>Edit behaviors…</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {machine && (
        <ContextMenuItem onClick={() => useMachineBoard.getState().openBoard(g.frameId, machine.id)}>
          <Network /> Open {machine.name}
        </ContextMenuItem>
      )}
      {bones > 0 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Bone /> Rig
            <span className="ml-auto pl-3 text-2xs text-muted-foreground">{bones} bones</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-52">
            <ContextMenuItem
              onClick={() => {
                useSession.getState().select([g.id]);
                useRigUi.getState().setMode("pose");
              }}
            >
              <PersonStanding /> Pose its bones
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                useSession.getState().select([g.id]);
                useRigUi.getState().setMode("setup");
              }}
            >
              <Wrench /> Edit bones (Setup)
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                useSession.getState().select([g.id]);
                useSession.getState().setTool("bone");
              }}
            >
              <Bone /> Draw bones
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => store.update("Reset pose", (d) => void resetPose(d, g.id))}>
              <RotateCcw /> Reset pose
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {!!parts.length && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Layers /> Parts
            <span className="ml-auto pl-3 text-2xs text-muted-foreground">{parts.length}</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-96 w-56 overflow-y-auto">
            {parts.map((part) => {
              const mode = clipEditMode(doc, part);
              return (
                <ContextMenuSub key={part.id}>
                  <ContextMenuSubTrigger>{part.name || part.kind}</ContextMenuSubTrigger>
                  <ContextMenuSubContent className="w-48">
                    <ContextMenuItem
                      onClick={() => {
                        const s = useSession.getState();
                        s.setEnteredGroup(g.id);
                        s.select([part.id]);
                      }}
                    >
                      <MousePointer2 /> Select
                    </ContextMenuItem>
                    {mode && (
                      <ContextMenuItem onClick={() => openClipEditor(store, locateClip(store.getState(), part.id)?.clip ?? part, mode)}>
                        <Wrench /> {EDIT_MODE_LABELS[mode]}
                      </ContextMenuItem>
                    )}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              );
            })}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
    </>
  );

  // On a part, the character is one row away (the part's own menu leads); on
  // the character, its structure is the menu's head.
  if (onPart)
    return [
      ...boneBlock,
      <ContextMenuSub key="character">
        <ContextMenuSubTrigger>
          <Smile /> {g.name}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-56">{body}</ContextMenuSubContent>
      </ContextMenuSub>,
    ];
  return [...boneBlock, <React.Fragment key="character">{body}</React.Fragment>];
}
