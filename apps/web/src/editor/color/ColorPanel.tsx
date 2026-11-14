"use client";

import * as React from "react";
import { clipGrades, effectPresetKind, findVisualClip, gradeIsIdentity, type GradeGraph, type VisualClip } from "@solomotion/core";
import { ChevronDown, Layers, Palette, SlidersHorizontal, Workflow } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { useIsCompact } from "../state/use-shell-density";
import { GradeBoard } from "./GradeBoard";
import { Scopes } from "./Scopes";
import { Corrector } from "./Corrector";
import { useColorStore } from "./color-store";
import { applyGradeLook, openColorFor } from "./grade-actions";
import { PresetPicker } from "../inspector/effect-editor/PresetPicker";
import { setGradePreview } from "../stage/render/grade-stage";

/**
 * THE COLOR PAGE — board, corrector, scopes, in one bottom surface beside the
 * timeline, the dope sheet, the curves and the node board.
 *
 * THREE COLUMNS. Scopes on the LEFT, the corrector in the middle, the node
 * board on the RIGHT.
 *
 * The first arrangement had the board on the left, reading structure → act →
 * measure. It reads better as a sentence than as a workspace, for one reason:
 * the thing you look at while you drag is the scopes, and the thing you drag is
 * in the middle — so the two that must be in one glance were at opposite ends
 * of the panel. Measurement beside the control, structure out at the edge where
 * you visit it, is how a grading suite is actually laid out.
 *
 * It also gives the board a header corner of its own, which is where a LOOK
 * belongs: a look is the whole graph, so its control sits over the graph rather
 * than over the node you happen to have selected.
 *
 * Narrow windows fold to ONE column with a switch, not to a different panel:
 * the same three components, chosen between rather than redesigned. The bottom
 * region stays docked at every width for the reason the timeline does — it is
 * the thing you are editing, and it has to be visible beside the canvas.
 */
export function ColorPanel() {
  const doc = useDoc();
  const store = useDocStore();
  const compact = useIsCompact();
  const selectedClipIds = useSession((s) => s.selectedClipIds);
  const { clipId, cardId, selectedNodeId, setTarget, selectNode } = useColorStore();
  const [pane, setPane] = React.useState<"board" | "grade" | "scopes">("grade");

  // WHICH CLIP. The page follows the selection, but only while it has nothing
  // of its own — once you are grading a clip, clicking a mask or a text layer
  // on the canvas must not silently move your grade somewhere else.
  const selected = React.useMemo(() => {
    for (const id of selectedClipIds) {
      // ANY visual layer, not just footage. A grade is an effect card, and text,
      // shapes and drawings carry the same stack — restricting the page to video
      // would be a rule about what colour is FOR rather than about what it can
      // do, and people grade titles to match a shot constantly.
      const c = findVisualClip(doc, id);
      if (c) return c;
    }
    return null;
  }, [doc, selectedClipIds]);

  const clip: VisualClip | null = React.useMemo(
    () => (clipId ? findVisualClip(doc, clipId) : null) ?? selected,
    [doc, clipId, selected],
  );

  const grades = clip ? clipGrades(clip) : [];
  const active = grades.find((g) => g.cardId === cardId) ?? grades[0] ?? null;

  React.useEffect(() => {
    if (clip && active && (clipId !== clip.id || cardId !== active.cardId)) setTarget(clip.id, active.cardId);
  }, [clip, active, clipId, cardId, setTarget]);

  // WHAT THE CANVAS SHOWS while this page is open. Published to the renderer
  // rather than read from this store by it, so the dependency runs one way —
  // and cleared on unmount, because leaving the stage painting a matte after
  // you close the page is the kind of stuck mode nobody finds their way out of.
  const showMatte = useColorStore((s) => s.showMatte);
  React.useEffect(() => {
    setGradePreview({ matteOf: showMatte ? selectedNodeId : null });
    return () => setGradePreview({ matteOf: null });
  }, [showMatte, selectedNodeId]);

  if (!clip) {
    return (
      <Empty>
        <Palette className="size-5 opacity-50" />
        Select a clip to grade it.
      </Empty>
    );
  }

  if (!active) {
    return (
      <Empty>
        <Palette className="size-5 opacity-50" />
        <span>No grade on “{clip.name}” yet.</span>
        <Button size="sm" className="mt-1 h-7 text-[11px]" onClick={() => openColorFor(store, clip.id)}>
          Start grading
        </Button>
      </Empty>
    );
  }

  const graph = active.graph;
  const node = graph.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const hasKeyInput = node != null && graph.edges.some((e) => e.to.node === node.id && e.to.port === "key");

  // Select the first corrector on open, so the middle column is never an empty
  // prompt the moment the page appears.
  if (!node && graph.nodes.some((n) => n.kind === "corrector")) {
    const first = graph.nodes.find((n) => n.kind === "corrector")!;
    queueMicrotask(() => selectNode(first.id));
  }

  const header = <Header clip={clip} grades={grades} active={active} graph={graph} />;

  if (compact) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <div className="flex shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5 py-1">
          {(
            [
              { id: "scopes", label: "Scopes", Icon: Layers },
              { id: "grade", label: "Correct", Icon: SlidersHorizontal },
              { id: "board", label: "Nodes", Icon: Workflow },
            ] as const
          ).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPane(p.id)}
              className={cn(
                "flex h-7 flex-1 items-center justify-center gap-1 rounded text-[11px] transition-colors",
                pane === p.id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted",
              )}
            >
              <p.Icon className="size-3.5" />
              {p.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1">
          {pane === "board" && <GradeBoard graph={graph} clipId={clip.id} cardId={active.cardId} />}
          {pane === "grade" && <Corrector clip={clip} cardId={active.cardId} node={node} hasKeyInput={hasKeyInput} />}
          {pane === "scopes" && <Scopes className="h-full" />}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <ResizablePanelGroup direction="horizontal" autoSaveId="tm-color-v2" className="min-h-0 flex-1">
        <ResizablePanel id="color-scopes" order={1} defaultSize={26} minSize={14}>
          <Scopes className="h-full" />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="color-corrector" order={2} defaultSize={36} minSize={20}>
          <Corrector clip={clip} cardId={active.cardId} node={node} hasKeyInput={hasKeyInput} />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="color-board" order={3} defaultSize={38} minSize={20}>
          <GradeBoard graph={graph} clipId={clip.id} cardId={active.cardId} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function Header({
  clip,
  grades,
  active,
  graph,
}: {
  clip: VisualClip;
  grades: Array<{ cardId: string; graph: GradeGraph }>;
  active: { cardId: string; graph: GradeGraph };
  graph: GradeGraph;
}) {
  const store = useDocStore();
  const setTarget = useColorStore((s) => s.setTarget);
  const idle = gradeIsIdentity(graph);
  const card = clip.effects.find((e): e is Extract<typeof e, { type: "grade" }> => e.id === active.cardId && e.type === "grade");

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-2">
      <Palette className="size-3.5 text-muted-foreground" />
      <span className="truncate text-[11px] font-medium">{clip.name}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground">·</span>
      {/* The GRAPH's name. Applying a look renames it, which is how the header
          answers "what am I looking at" — a whole-graph preset cannot be
          identity-matched after its ids are reissued, so the name is the only
          honest record of where this grade came from. */}
      <span className="truncate text-[11px] text-muted-foreground">{active.graph.name}</span>

      {/* A clip may carry several grade cards — one before a glow, one after.
          The picker names them by their position in the stack, because that is
          the only thing that distinguishes them and it is the thing that
          matters. */}
      {grades.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[11px]">
              {active.graph.name}
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel className="text-[11px]">Grades on this layer</DropdownMenuLabel>
            {grades.map((g, i) => (
              <DropdownMenuItem key={g.cardId} onSelect={() => setTarget(clip.id, g.cardId)}>
                {i + 1}. {g.graph.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* THE WHOLE GRADE, AS A PRESET. Two preset scales live on this page and
          they answer different questions: a node's stack is a CORRECTION you
          reuse (the section's own picker, inside the node), and this is a LOOK
          — every node, every key, every window, the wiring included. Resolve
          calls the second one a still, and it is what people actually trade. */}
      <div className="ml-auto flex items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground">
          {idle ? "Neutral" : `${graph.nodes.filter((n) => n.kind === "corrector").length} nodes`}
        </span>
        <PresetPicker
          kind={effectPresetKind("grade")}
          label="Look"
          showLabel
          defaultName={clip.name}
          capture={() => ({ graph: structuredClone(graph), mix: card?.mix ?? 1 })}
          saveLabel="Save this grade as a look"
          saveTitle="Save look"
          saveDescription="The whole graph — nodes, keys, windows and wiring — reusable on any layer."
          onApply={(data, preset) => applyGradeLook(store, clip.id, active.cardId, data, preset.name)}
        />
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
      {children}
    </div>
  );
}
