"use client";

import * as React from "react";
import {
  adjustmentSourceMatters,
  frameLayerTree,
  resolveAdjustmentTargets,
  type AdjustmentClip,
  type AdjustmentScope,
  type LayerTreeNode,
} from "@solomotion/core";
import { ArrowDownWideNarrow, Check, Copy, Layers, Replace } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useDoc } from "../state/document-context";
import { ClipKindIcon } from "../ui/clip-icon";
import { IconTrack, PanelSection, PropRow, Seg } from "./controls";
import { useClipUpdater } from "./use-clip-updater";
import { mergeReads, trackValue } from "./merge";
import { ofKind, usePeers } from "./selection-scope";

const isAdjustment = ofKind("adjustment");

/**
 * The adjustment layer's ONE new surface: its scope. Everything else it needs
 * (the effect stack, opacity=mix, blend, timing) is the shared layer inspector,
 * reused untouched. Two axes — reach (below / all) and filter (all / only /
 * except) — plus a live target picker built from the SAME layer tree the
 * renderer walks, so what you tick is exactly what gets graded.
 */

/** One selectable row flattened from the frame's layer tree (clips + groups). */
interface TargetRow {
  id: string;
  name: string;
  depth: number;
  kind: "group" | AdjustmentClip["kind"] | string;
  isGroup: boolean;
}

function flattenTargets(nodes: LayerTreeNode[], depth: number, out: TargetRow[]): void {
  for (const node of nodes) {
    if (node.type === "group") {
      out.push({ id: node.clip.id, name: node.clip.name, depth, kind: "group", isGroup: true });
      flattenTargets(node.children, depth + 1, out);
    } else if (node.clip.kind !== "adjustment") {
      // A processor never mattes against another processor — hide it as a target.
      out.push({ id: node.clip.id, name: node.clip.name, depth, kind: node.clip.kind, isGroup: false });
    }
  }
}

export function AdjustmentInspector({ clip }: { clip: AdjustmentClip }) {
  const doc = useDoc();
  const update = useClipUpdater(clip.id);
  const peers = usePeers(clip, isAdjustment);
  const { reach, filter } = clip.scope;
  const reachF = mergeReads(peers, (c) => c.scope.reach);
  const modeF = mergeReads(peers, (c) => c.scope.filter.mode);
  const sourceF = mergeReads(peers, (c) => c.scope.source);

  const setScope = (label: string, fn: (s: AdjustmentScope) => void, mergeKey?: string) =>
    update(label, (c) => c.kind === "adjustment" && fn(c.scope), mergeKey);

  const rows = React.useMemo(() => {
    const out: TargetRow[] = [];
    flattenTargets(frameLayerTree(doc, clip.frameId), 0, out);
    return out;
  }, [doc, clip.frameId]);

  // What actually gets graded right now — drives the picker's inherited state so
  // ticking a group visibly lights up its members.
  const affected = React.useMemo(() => resolveAdjustmentTargets(doc, clip.frameId, clip), [doc, clip]);
  const listed = new Set(filter.targetIds);

  // Does this grade RELOCATE what it reads, or cut holes in it? Only then does
  // Source change the picture — a grade that lands back on its own pixels,
  // whole, covers them either way. Read off the same transform and cards the
  // renderer uses, keys included, so the row appears the instant either does.
  const moves = peers.some((c) => adjustmentSourceMatters(c));

  const toggle = (id: string) =>
    setScope("Adjustment targets", (s) => {
      const set = new Set(s.filter.targetIds);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      s.filter.targetIds = [...set];
    });

  const hint =
    filter.mode === "all"
      ? reach === "all"
        ? "Grades the whole frame, ignoring stack order."
        : "Grades the composite of every layer below this one."
      : filter.mode === "only"
        ? `Grades only the ${listed.size || "…"} picked layer${listed.size === 1 ? "" : "s"}.`
        : `Grades everything ${reach === "all" ? "" : "below "}except the picked layers.`;

  return (
    // The scope readout is derived state, not prose — it belongs on the header
    // as a tooltip, and the two segmented tracks say the rest by themselves.
    <PanelSection title="Scope" hint={hint}>
      <PropRow label="Reach">
        <IconTrack
          value={trackValue(reachF)}
          items={[
            { id: "below", label: "Grade the layers below this one", icon: <ArrowDownWideNarrow /> },
            { id: "all", label: "Grade the whole frame, any stack position", icon: <Layers /> },
          ]}
          onPick={(v) => setScope("Adjustment reach", (s) => void (s.reach = v as AdjustmentScope["reach"]))}
        />
      </PropRow>

      <PropRow label="Layers">
        <IconTrack
          value={trackValue(modeF)}
          items={[
            { id: "all", label: "Every reachable layer", icon: <Seg>All</Seg> },
            { id: "only", label: "Only the picked layers", icon: <Seg>Only</Seg> },
            { id: "except", label: "All but the picked layers", icon: <Seg>Except</Seg> },
          ]}
          onPick={(v) => setScope("Adjustment filter", (s) => void (s.filter.mode = v as "all" | "only" | "except"))}
        />
      </PropRow>

      {/* The third axis: what happens to the pixels it read. Only visible once
          the grade MOVES them — for a grade that stays put the two are the same
          picture, and a control that does nothing is a control that teaches
          people to distrust the panel. */}
      {moves && (
        <PropRow label="Source">
          <IconTrack
            value={trackValue(sourceF)}
            items={[
              { id: "replace", label: "Move the pixels — nothing left behind", icon: <Replace /> },
              { id: "over", label: "Keep the original underneath", icon: <Copy /> },
            ]}
            onPick={(v) =>
              setScope("Adjustment source", (s) => void (s.source = v as AdjustmentScope["source"]))
            }
          />
        </PropRow>
      )}

      {/* The picked layers are a list in ONE comp's layer tree — shown for one. */}
      {peers.length === 1 && filter.mode !== "all" && (
        <ScrollArea className="max-h-56 rounded-md border border-border/70">
          <div className="p-0.5">
            {rows.length === 0 && (
              <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">No other layers in this comp.</div>
            )}
            {rows.map((row) => {
              const picked = listed.has(row.id);
              // A clip that isn't picked directly but falls in the graded set
              // (its group is picked, or "except" leaves it in) reads as inherited.
              const inherited = !picked && !row.isGroup && affected.matteIds.has(row.id);
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => toggle(row.id)}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] transition-colors hover:bg-accent/60",
                    picked && "bg-accent/40",
                  )}
                  style={{ paddingLeft: 6 + row.depth * 12 }}
                >
                  <span
                    className={cn(
                      "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border",
                      picked
                        ? "border-(--kind-adjust) bg-(--kind-adjust) text-background"
                        : inherited
                          ? "border-(--kind-adjust)/50 bg-(--kind-adjust)/20"
                          : "border-border",
                    )}
                  >
                    {picked && <Check className="size-2.5" strokeWidth={3} />}
                  </span>
                  {row.isGroup ? (
                    <Layers className="size-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <ClipKindIcon kind={row.kind as AdjustmentClip["kind"]} className="text-muted-foreground" />
                  )}
                  <span className="truncate text-foreground/90">{row.name}</span>
                  {row.isGroup && <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">group</span>}
                </button>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </PanelSection>
  );
}