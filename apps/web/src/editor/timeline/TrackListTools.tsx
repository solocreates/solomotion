"use client";

import * as React from "react";
import {
  LAYER_SORT_KEYS,
  cleanupEmptyTracks,
  emptyTrackCount,
  groupsInFrame,
  reverseLayers,
  sortLayers,
  type LayerSortKey,
  type SortDirection,
} from "@solomotion/core";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronsDownUp, ChevronsUpDown, Eraser, FlipVertical2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";

/**
 * THE TRACK-LIST CORNER — the blank square above the lane headers, which was
 * blank because nothing had claimed it, not because nothing belonged there.
 *
 * It holds the operations that are about the LIST rather than about any
 * lane in it, and that is the whole rule for what may go here: a control that
 * needs a lane selected belongs on the lane.
 *
 *   SORT     reorder the stack by name, type or timing — see `layer-sort.ts`,
 *            which sorts the layer TREE so groups travel whole and their
 *            members sort inside them.
 *   TIDY UP  sweep the empty lanes this comp is showing.
 *   FOLD     close every group, or — when all are closed — open them all.
 *
 * Sort and tidy write lane order, which IS z-order, so the layers panel follows without
 * being told. There is no "sorted view" to keep in sync and nothing to turn
 * off — a sort is an edit you can undo, not a mode you can forget you are in.
 */

/** A 20px ghost button: quiet at rest, legible on hover, same as a lane's own. */
const CORNER_BTN =
  "inline-flex size-5 items-center justify-center rounded text-muted-foreground/70 " +
  "transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 " +
  "focus-visible:ring-ring outline-none disabled:pointer-events-none disabled:opacity-30 " +
  "[&_svg]:size-3.5";

export function TrackListTools({ compId, className }: { compId: string; className?: string }) {
  const doc = useDoc();
  const store = useDocStore();
  const [dir, setDir] = React.useState<SortDirection>("asc");

  // Live, so the button can be honest about having nothing to do rather than
  // firing and reporting "removed 0".
  const empties = emptyTrackCount(doc, compId);

  const runSort = (key: LayerSortKey, direction: SortDirection) =>
    store.update("Sort layers", (d) => void sortLayers(d, compId, key, direction));

  const tidy = () => {
    if (empties === 0) return;
    store.update("Clean up empty tracks", (d) => void cleanupEmptyTracks(d, compId));
    toast(`${empties} empty ${empties === 1 ? "track" : "tracks"} removed`);
  };

  // FOLD ALL / OPEN ALL — one button that says what it will do. Any group open
  // means the next press closes them all (tidying is the common wish); only
  // when every one is shut does it open them. `collapsedIds` is the ONE set the
  // layers panel shares, so both views fold together.
  const groupIds = groupsInFrame(doc, compId).map((g) => g.id);
  const collapsedIds = useSession((s) => s.collapsedIds);
  const anyOpen = groupIds.some((id) => !collapsedIds.includes(id));
  const fold = () => {
    const s = useSession.getState();
    // Folding the group you are INSIDE steps you out of it, as folding its row does.
    if (anyOpen && s.enteredGroupId) s.retreatToGroup(null, []);
    for (const id of groupIds) s.setCollapsed(id, anyOpen);
  };

  return (
    <div className={cn("flex items-center gap-0.5 px-1.5", className)}>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger className={CORNER_BTN} aria-label="Sort layers">
              <ArrowUpDown />
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">Sort layers</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="w-56">
          {/* DIRECTION FIRST, and it stays put while you try keys. Sorting is a
              thing you do two or three times in a row to see which reading of
              the stack you wanted, so the menu does not close on a key and the
              direction is set once rather than chosen again in every row. */}
          <div className="flex items-center gap-1 px-1 pb-1">
            {(["asc", "desc"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDir(d)}
                className={cn(
                  "flex h-6 flex-1 items-center justify-center gap-1 rounded text-xs transition-colors",
                  dir === d ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  "[&_svg]:size-3",
                )}
              >
                {d === "asc" ? <ArrowDown /> : <ArrowUp />}
                {d === "asc" ? "Ascending" : "Descending"}
              </button>
            ))}
          </div>
          <DropdownMenuSeparator />
          {LAYER_SORT_KEYS.map(({ key, label, ascLabel, descLabel }) => (
            <DropdownMenuItem
              key={key}
              className="justify-between gap-2"
              onSelect={(e) => {
                e.preventDefault(); // stay open — try another key straight away
                runSort(key, dir);
              }}
            >
              {label}
              <span className="text-2xs text-muted-foreground">{dir === "asc" ? ascLabel : descLabel}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => store.update("Reverse layer order", (d) => void reverseLayers(d, compId))}
          >
            <FlipVertical2 /> Reverse the stack
          </DropdownMenuItem>
          <DropdownMenuLabel className="pt-1 text-2xs font-normal text-muted-foreground">
            Groups travel whole and sort inside.
          </DropdownMenuLabel>
        </DropdownMenuContent>
      </DropdownMenu>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={CORNER_BTN}
            onClick={fold}
            disabled={groupIds.length === 0}
            aria-label={anyOpen ? "Collapse all groups" : "Expand all groups"}
          >
            {anyOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {groupIds.length === 0 ? "No groups" : anyOpen ? "Collapse all groups" : "Expand all groups"}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className={CORNER_BTN} onClick={tidy} disabled={empties === 0} aria-label="Clean up empty tracks">
            <Eraser />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {empties === 0
            ? "No empty tracks"
            : `Clean up ${empties} empty ${empties === 1 ? "track" : "tracks"}`}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
