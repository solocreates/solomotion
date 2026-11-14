"use client";

import * as React from "react";
import {
  addState,
  locateClip,
  removeStates,
  renameState,
  starterMachineFor,
  updateBehavior,
  type MotionDocument,
  type Behavior,
  type GroupClip,
  type Machine,
  type MachineLayer,
  type PoseSet,
} from "@solomotion/core";
import { Network, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RenameInput } from "@/components/ui/rename-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { useMachineBoard } from "./machine-store";
import { useLiveMachine } from "./use-live-machine";

/**
 * A STATE MACHINE CARD'S BODY — the machine itself, not a pointer to it.
 *
 * The card used to be one field (which machine) while the same machine was
 * listed again in a Machine section underneath: two places saying one thing,
 * and neither let you touch a state. Now the card is where the machine lives
 * for this character: its states as rows — rename, the pose each shows, the
 * one running now, add, remove — and the board one click away for the
 * transitions, which are a graph and belong on one.
 */

const NONE = "__none__";

function machineOf(doc: MotionDocument, frameId: string, ref: string): Machine | undefined {
  return doc.frames.find((f) => f.id === frameId)?.machines?.find((m) => m.id === ref || m.name === ref);
}

export function MachineStates({ character, behavior }: { character: GroupClip; behavior: Behavior }) {
  const doc = useDoc();
  const store = useDocStore();
  const g = (locateClip(doc, character.id)?.clip as GroupClip | undefined) ?? character;
  const machine = machineOf(doc, g.frameId, String(behavior.machine ?? ""));
  const setRef = String(behavior.set ?? "");

  if (!machine)
    return (
      <Button
        variant="outline"
        size="sm"
        className="mt-1 w-full"
        onClick={() =>
          store.update("New machine", (d) => {
            const gg = locateClip(d, g.id)?.clip;
            if (gg?.kind !== "group") return;
            const s = (gg.poses ?? []).find((x) => x.id === setRef || x.name === setRef) ?? null;
            updateBehavior(d, g.id, behavior.id, { machine: starterMachineFor(d, gg, s) });
          })
        }
      >
        <Plus /> New machine
      </Button>
    );

  return (
    <div className="flex flex-col gap-2 pt-1 pb-2">
      {machine.layers.map((layer) => (
        <LayerStates key={layer.id} frameId={g.frameId} machine={machine} layer={layer} sets={(g.poses ?? []).filter((x) => x.poses.length)} showName={machine.layers.length > 1} />
      ))}
      <Button variant="secondary" size="sm" className="w-full" onClick={() => useMachineBoard.getState().openBoard(g.frameId, machine.id)}>
        <Network /> Transitions on the board
      </Button>
    </div>
  );
}

function LayerStates({ frameId, machine, layer, sets, showName }: { frameId: string; machine: Machine; layer: MachineLayer; sets: readonly PoseSet[]; showName: boolean }) {
  const store = useDocStore();
  const live = useLiveMachine(frameId, machine.id);
  const now = live?.reading.layers.find((l) => l.layerId === layer.id)?.stateId ?? null;
  const [renaming, setRenaming] = React.useState<string | null>(null);

  /** Every write finds the layer again in the draft — the one it was handed is a snapshot. */
  const edit = (label: string, fn: (l: MachineLayer) => void) =>
    store.update(label, (d) => {
      const l = machineOf(d, frameId, machine.id)?.layers.find((x) => x.id === layer.id);
      if (l) fn(l);
    });

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {showName ? layer.name : "States"}
        <button
          type="button"
          className="flex items-center gap-0.5 normal-case tracking-normal hover:text-foreground [&_svg]:size-3"
          onClick={() => {
            const x = Math.max(0, ...layer.states.map((s) => s.x)) + 200;
            edit("Add state", (l) => void addState(l, { name: "State", x, y: 80 }));
          }}
        >
          <Plus /> State
        </button>
      </div>
      {layer.states.map((s) => {
        const running = s.id === now;
        // A state names its own set — a machine can pick the mouth in one
        // state and the eyes in another — so the choice is set AND pose.
        const out = s.output.kind === "pose" ? s.output : null;
        // Outputs may name their set by id or by name (agents write names).
        const outSet = out ? sets.find((x) => x.id === out.set || x.name === out.set) : undefined;
        const current = out && outSet ? `${outSet.id}|${out.pose}` : NONE;
        const many = sets.length > 1;
        return (
          <div key={s.id} className={cn("group/state flex h-7 items-center gap-1.5 rounded-md px-1", running && "bg-primary/10")}>
            <span className={cn("size-1.5 shrink-0 rounded-full", running ? "bg-primary" : "bg-border")} title={running ? "Running now" : s.id === layer.entry ? "Starts here" : undefined} />
            {renaming === s.id ? (
              <RenameInput
                initial={s.name}
                className="h-6 min-w-0 flex-1 rounded bg-background px-1 text-[12px]"
                onCommit={(name) => {
                  setRenaming(null);
                  if (name.trim() && name !== s.name) edit("Rename state", (l) => renameState(l, s.id, name));
                }}
              />
            ) : (
              <button type="button" className="min-w-0 flex-1 truncate text-left text-[12px]" onDoubleClick={() => setRenaming(s.id)} title="Double-click to rename">
                {s.name}
                {s.id === layer.entry && <span className="ml-1 text-2xs text-muted-foreground">start</span>}
              </button>
            )}
            {sets.length > 0 && (
              <Select
                value={current}
                onValueChange={(v) =>
                  edit("State pose", (l) => {
                    const st = l.states.find((x) => x.id === s.id);
                    if (!st) return;
                    const [setId, ...rest] = v.split("|");
                    st.output = v === NONE ? { kind: "none" } : { kind: "pose", set: setId!, pose: rest.join("|") };
                  })
                }
              >
                <SelectTrigger className="h-6 w-32 shrink-0 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE} className="text-[12px] text-muted-foreground">
                    No pose
                  </SelectItem>
                  {sets.flatMap((set) =>
                    set.poses.map((p) => (
                      <SelectItem key={`${set.id}|${p.id}`} value={`${set.id}|${p.name}`} className="text-[12px]">
                        {many ? `${set.name} · ${p.name}` : p.name}
                      </SelectItem>
                    )),
                  )}
                </SelectContent>
              </Select>
            )}
            <button
              type="button"
              title="Remove state"
              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover/state:opacity-100 hover:text-destructive [&_svg]:size-3"
              onClick={() => edit("Remove state", (l) => removeStates(l, [s.id]))}
            >
              <Trash2 />
            </button>
          </div>
        );
      })}
    </div>
  );
}
