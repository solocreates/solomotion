"use client";

import * as React from "react";
import { Check, RotateCcw, Save, X } from "lucide-react";
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { PRESETS } from "./presets";
import { useLayout } from "./store";

/**
 * THE WORKSPACES MENU (README D3): the presets, your saved ones, Reset and
 * Save as. A preset is a tree plus visibility; picking one is one click and
 * one undo-free layout change — and Reset brings back the factory version of
 * whichever workspace is current, split sizes included.
 */
export function WorkspaceMenuItems() {
  const current = useLayout((s) => s.current);
  const saved = useLayout((s) => s.saved);
  const L = useLayout.getState;
  return (
    <>
      <DropdownMenuLabel>Workspace</DropdownMenuLabel>
      {PRESETS.map((p) => (
        <DropdownMenuItem key={p.id} onClick={() => L().applyPreset(p.id)}>
          <Check className={current === p.id ? "opacity-100" : "opacity-0"} />
          {p.name}
        </DropdownMenuItem>
      ))}
      {saved.length > 0 && <DropdownMenuSeparator />}
      {saved.map((s) => (
        <DropdownMenuItem key={s.id} onClick={() => L().applyPreset(s.id)} className="group/saved">
          <Check className={current === s.id ? "opacity-100" : "opacity-0"} />
          <span className="min-w-0 flex-1 truncate">{s.name}</span>
          <button
            type="button"
            aria-label={`Delete ${s.name}`}
            className="ml-auto flex size-5 items-center justify-center rounded opacity-0 hover:bg-accent group-hover/saved:opacity-100 [&_svg]:size-3"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              L().removeSaved(s.id);
            }}
          >
            <X />
          </button>
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => L().reset()}>
        <RotateCcw /> Reset this workspace
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => L().saveAs(`Workspace ${saved.length + 1}`)}>
        <Save /> Save as new workspace
      </DropdownMenuItem>
    </>
  );
}
