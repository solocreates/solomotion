"use client";

import * as React from "react";
import {
  autoLayoutVerb,
  canUngroup,
  clipsInGroup,
  groupClipById,
  groupModeOf,
  groupOfClip,
  locateClip,
  modeUsesStencil,
  selectionCompositeInfo,
  setClipStencilRole,
  swapGroupRoles,
  type GroupMode,
  type VisualClip,
} from "@solomotion/core";
import { ArrowLeftRight, LayoutGrid, Ungroup } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { applyCompositeToSelection, toggleAutoLayout, ungroupSelection } from "../state/clip-actions";
import { ShortcutHint } from "../state/ShortcutHint";
import { COMPOSITE_ICONS } from "../ui/composite-icons";
import { PanelSection } from "./controls";

/**
 * COMBINE — the one place a group says what operation it is, who is doing the
 * cutting, and how to stop.
 *
 * It used to be the mode row alone: six icons, the active one tinted, and a
 * two-button Content/Stencil toggle that appeared only when a MEMBER was
 * selected. Three things were missing and all three are the same complaint —
 * *you cannot experiment with it*:
 *
 *  • **No way back that reads as a way back.** "Plain group" is the first icon
 *    in the row and nothing about an icon says "off", so the only exit anyone
 *    found was undo. The active button now wears its LABEL, so the row always
 *    states which mode you are in, `Group` included — and Release / Ungroup sit
 *    under it as words.
 *  • **No way to say "no, the other one".** Swapping a two-layer mask meant
 *    finding each layer and flipping it. `swapGroupRoles` inverts every member
 *    at once, which is the answer that stays right at two members and at ten.
 *  • **Nothing shows who is on which side** unless you go to the Layers panel.
 *    The role list below is the group's own members, in paint order, each a
 *    click away from changing sides — and clicking the NAME selects that layer,
 *    so the panel you are already in becomes the way into it.
 *
 * Every write is a headless core call the right-click menu and the shortcuts
 * share. Nesting needs no special case anywhere here: a nested composite is one
 * member of this group and one operation of its own, so it appears as a row
 * with a role and edits its own members when you select it.
 */

const MODE_HINTS: Array<{ mode: GroupMode; label: string; hint: string }> = [
  { mode: "pass", label: "Group", hint: "Layers paint independently" },
  { mode: "union", label: "Union", hint: "Layers composite as one unit" },
  { mode: "subtract", label: "Subtract", hint: "The stencil is cut out of the content" },
  { mode: "intersect", label: "Intersect", hint: "Only where stencil and content overlap" },
  { mode: "exclude", label: "Exclude", hint: "Everything except where they overlap" },
  { mode: "mask", label: "Mask", hint: "Content shows only inside the stencil — video, text, anything (⌘⌥M)" },
];

export function CombineSection() {
  const doc = useDoc();
  const store = useDocStore();
  const ids = useSession((s) => s.selectedClipIds);
  const info = selectionCompositeInfo(doc, ids);
  // Members of a composite group get the role toggle even when the group itself
  // isn't what's selected — that is the case you are in when you have drilled
  // into a group to fix which layer is doing the cutting.
  const members = ids
    .map((id) => locateClip(doc, id)?.clip)
    .filter((c): c is VisualClip => !!c && c.kind !== "audio" && modeUsesStencil(groupModeOf(doc, groupOfClip(doc, c.id))));
  // Auto layout sits under the modes: the other thing a group can BE. Only
  // offered where it arranges something (see `autoLayoutVerb`); a group that
  // already has one gets its own Auto layout section instead.
  const offerLayout = autoLayoutVerb(doc, ids) === "add";
  if (!info.eligible && members.length === 0 && !offerLayout) return null;

  const group = groupClipById(doc, info.groupId);
  const current = MODE_HINTS.find((m) => m.mode === info.mode);

  return (
    <PanelSection title="Combine" id="combine">
      {info.eligible && (
        <div className="track flex items-center gap-0.5 bg-input/30">
          {MODE_HINTS.map(({ mode, label, hint }) => {
            const Icon = COMPOSITE_ICONS[mode];
            const active = group !== null && info.mode === mode;
            return (
              <Tooltip key={mode}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={label}
                    aria-pressed={active}
                    className={cn(
                      "flex h-7 items-center justify-center gap-1.5 rounded-md px-1.5 transition-colors",
                      // The active mode carries its name; the rest stay glyphs.
                      // One row, and it can never be silently in a mode you
                      // cannot see the name of.
                      active
                        ? "flex-none bg-primary/15 text-primary shadow-sm"
                        : "flex-1 text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                    onClick={() => applyCompositeToSelection(store, mode)}
                  >
                    <Icon className="size-3.5" />
                    {active && <span className="text-[11px] font-medium">{label}</span>}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="font-medium">{label}</p>
                  <p className="text-muted-foreground">{hint}</p>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      )}

      {group && modeUsesStencil(group.mode) && <RoleList groupId={group.id} />}

      {/* Selected a MEMBER rather than the group — the one-layer answer, kept
          because that is where you are when you have drilled in to fix a role. */}
      {!group && members.length > 0 && <RoleToggle members={members} />}

      {(group !== null || canUngroup(doc, ids) || offerLayout) && (
        <div className="mt-1.5 flex items-center gap-1">
          {offerLayout && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="xs" className="flex-1" onClick={() => toggleAutoLayout(store)}>
                  <LayoutGrid /> Auto layout
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>
                  Arrange as a row, column or grid <ShortcutHint id="edit.auto-layout" />
                </p>
              </TooltipContent>
            </Tooltip>
          )}
          {group && group.mode !== "pass" && (
            <Button
              variant="ghost"
              size="xs"
              className="flex-1"
              onClick={() => applyCompositeToSelection(store, "pass")}
            >
              Release
            </Button>
          )}
          {canUngroup(doc, ids) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="xs" className="flex-1" onClick={() => ungroupSelection(store)}>
                  <Ungroup /> Ungroup
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>Dissolve the group. Its own fill, stroke and effects go with it.</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
    </PanelSection>
  );
}

/**
 * The group's direct members, in paint order, each on its side of the
 * operation. Any number on either side — which is what the model has always
 * allowed and what nothing on screen said.
 */
function RoleList({ groupId }: { groupId: string }) {
  const doc = useDoc();
  const store = useDocStore();
  const selected = useSession((s) => s.selectedClipIds);
  const members = clipsInGroup(doc, groupId)
    .map((id) => locateClip(doc, id)?.clip)
    .filter((c): c is VisualClip => !!c && c.kind !== "audio");
  if (members.length === 0) return null;

  return (
    <div className="mt-1.5 rounded-lg bg-input/30 p-0.5">
      <div className="flex items-center justify-between pl-2 pr-0.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Roles
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6"
              aria-label="Swap roles"
              disabled={members.length < 2}
              onClick={() => store.update("Swap roles", (d) => void swapGroupRoles(d, groupId))}
            >
              <ArrowLeftRight className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Swap roles — every member changes sides</p>
          </TooltipContent>
        </Tooltip>
      </div>
      {members.map((clip) => (
        <div
          key={clip.id}
          className={cn(
            "flex items-center gap-1 rounded-md px-1 py-0.5",
            selected.includes(clip.id) && "bg-accent/60",
          )}
        >
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-[11px] text-foreground/90 hover:text-foreground"
            onClick={() => useSession.getState().select([clip.id])}
          >
            {clip.name}
          </button>
          <div className="flex shrink-0 items-center gap-0.5">
            {[
              { on: false, label: "Content" },
              { on: true, label: "Stencil" },
            ].map(({ on, label }) => (
              <button
                key={label}
                type="button"
                aria-pressed={clip.isStencil === on}
                className={cn(
                  "h-5 rounded px-1.5 text-[10px] font-medium transition-colors",
                  clip.isStencil === on
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
                onClick={() =>
                  store.update(on ? "Make stencil" : "Make content", (d) =>
                    setClipStencilRole(d, clip.id, on),
                  )
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Which side of the operation these layers are on. */
function RoleToggle({ members }: { members: VisualClip[] }) {
  const store = useDocStore();
  const allStencil = members.every((c) => c.isStencil);
  const allContent = members.every((c) => !c.isStencil);
  const set = (isStencil: boolean) =>
    store.update(isStencil ? "Make stencil" : "Make content", (d) => {
      for (const c of members) setClipStencilRole(d, c.id, isStencil);
    });
  return (
    <div className="track mt-1 flex items-center gap-0.5 bg-input/30">
      {[
        { on: false, label: "Content", active: allContent },
        { on: true, label: "Stencil", active: allStencil },
      ].map(({ on, label, active }) => (
        <button
          key={label}
          type="button"
          aria-pressed={active}
          className={cn(
            "h-7 flex-1 rounded-md text-[11px] font-medium transition-colors",
            active ? "bg-primary/15 text-primary shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
          onClick={() => set(on)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
