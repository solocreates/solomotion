"use client";

import * as React from "react";
import {
  addShapeKey,
  canHoldShapeKeys,
  currentMix,
  duplicateShapeKey,
  keyPath,
  locateClip,
  mirrorShapeKey,
  removeShapeKey,
  renameShapeKey,
  setShapeKeyMute,
  setShapeKeyRelativeTo,
  type MotionDocument,
  type MeshClip,
  type PathClip,
  type ShapeKey,
} from "@solomotion/core";
import { Copy, Eye, EyeOff, FlipHorizontal2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RenameInput } from "@/components/ui/rename-input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { commitProperty } from "../inspector/animatable";
import { PanelSection } from "../inspector/controls";
import { ValueField } from "../inspector/value-field";
import { useShapeKeyUi } from "./state";

/**
 * SHAPE KEYS — the inspector's list for a path or an editable mesh: each key a
 * keyable weight (the ordinary `key.<id>` channel, so ◆, drivers, modulators
 * and the dope sheet are the field's own), plus its menu. Every write is core
 * `shape-keys/ops`; "Edit" arms the key on the stage (`useShapeKeyUi`).
 */
export function ShapeKeysSection({ clip }: { clip: PathClip | MeshClip }) {
  const store = useDocStore();
  const editing = useShapeKeyUi((s) => (s.session?.clipId === clip.id ? s.session.keyId : null));
  const keys = clip.shapeKeys ?? [];
  const edit = (label: string, fn: (c: PathClip | MeshClip, d: MotionDocument) => void) =>
    store.update(label, (d) => {
      const c = locateClip(d, clip.id)?.clip;
      if (c && (c.kind === "path" || c.kind === "mesh")) fn(c, d);
    });
  const holds = canHoldShapeKeys(clip);
  if (!holds && keys.length === 0) return null;

  return (
    <PanelSection
      id="shape-keys"
      title="Shape keys"
      hint="Drawn shapes this layer morphs to. Each weight keys and drives like any value; keys morph before bones and modifiers."
      actions={
        holds && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-6 px-1.5 [&_svg]:size-3.5" title="Add a shape key">
                <Plus />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48 text-[12px]">
              <DropdownMenuItem onSelect={() => edit("Add shape key", (c) => void addShapeKey(c))}>New key</DropdownMenuItem>
              <DropdownMenuItem
                disabled={keys.length === 0}
                onSelect={() => edit("New key from mix", (c) => canHoldShapeKeys(c) && void addShapeKey(c, { name: "Mix", shape: currentMix(c) }))}
              >
                New key from mix
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )
      }
    >
      {keys.map((k) => (
        <KeyRow key={k.id} clip={clip} k={k} keys={keys} editing={editing === k.id} edit={edit} />
      ))}
    </PanelSection>
  );
}

function KeyRow({
  clip,
  k,
  keys,
  editing,
  edit,
}: {
  clip: PathClip | MeshClip;
  k: ShapeKey;
  keys: ShapeKey[];
  editing: boolean;
  edit: (label: string, fn: (c: PathClip | MeshClip, d: MotionDocument) => void) => void;
}) {
  const store = useDocStore();
  const [renaming, setRenaming] = React.useState(false);
  const path = keyPath(k.id);
  const ref = keys.find((x) => x.id === k.relativeTo);
  const isDelta = k.source.kind === "delta";
  return (
    <div className={cn("group/key flex items-center gap-1", k.mute && "opacity-50", editing && "rounded-md ring-1 ring-primary/60")}>
      <div className="min-w-0 flex-1">
        {renaming ? (
          <RenameInput
            initial={k.name}
            onCommit={(v) => {
              setRenaming(false);
              if (v.trim()) edit("Rename shape key", (c) => void renameShapeKey(c, k.id, v));
            }}
          />
        ) : (
          <ValueField
            clip={clip}
            canKey
            layout="inspector"
            path={path}
            kind="number"
            label={k.name}
            hint={ref ? `Drawn on ${ref.name}` : undefined}
            base={k.value ?? 0}
            min={0}
            max={1}
            step={0.01}
            defaultValue={0}
            onChange={(v) => {
              if (typeof v !== "number") return;
              store.update(
                `${k.name} weight`,
                (d) => {
                  const c = locateClip(d, clip.id)?.clip;
                  if (c) commitProperty(c, path, v, useSession.getState().playheadMs);
                },
                { mergeKey: `sk-${k.id}` },
              );
            }}
          />
        )}
      </div>
      {isDelta && (
        <button
          type="button"
          title={editing ? "Done editing (Esc)" : "Edit this key on the canvas"}
          className={cn("flex size-6 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5", editing ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}
          onClick={() => (editing ? useShapeKeyUi.getState().done(store) : useShapeKeyUi.getState().arm(store, clip.id, k.id, k.name))}
        >
          <Pencil />
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" title="Key options" className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground [&_svg]:size-3.5">
            <MoreHorizontal />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48 text-[12px]">
          <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => edit(k.mute ? "Unmute key" : "Mute key", (c) => void setShapeKeyMute(c, k.id, !k.mute))}>
            {k.mute ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
            {k.mute ? "Unmute" : "Mute"}
          </DropdownMenuItem>
          {isDelta && (
            <>
              <DropdownMenuItem onSelect={() => edit("Duplicate key", (c) => void duplicateShapeKey(c, k.id))}>
                <Copy className="size-3.5" /> Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => edit("Mirror key", (c) => void mirrorShapeKey(c, k.id))}>
                <FlipHorizontal2 className="size-3.5" /> Mirror L↔R
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Drawn on</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="text-[12px]">
                  <DropdownMenuItem onSelect={() => edit("Key reference", (c) => void setShapeKeyRelativeTo(c, k.id, undefined))}>
                    {!k.relativeTo ? "✓ " : ""}Base
                  </DropdownMenuItem>
                  {keys
                    .filter((x) => x.id !== k.id && x.source.kind === "delta")
                    .map((x) => (
                      <DropdownMenuItem key={x.id} onSelect={() => edit("Key reference", (c) => void setShapeKeyRelativeTo(c, k.id, x.id))}>
                        {k.relativeTo === x.id ? "✓ " : ""}
                        {x.name}
                      </DropdownMenuItem>
                    ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive" onSelect={() => edit("Remove shape key", (c) => void removeShapeKey(c, k.id))}>
            <Trash2 className="size-3.5" /> Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
