"use client";

import * as React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { create } from "zustand";
import {
  ANIMATION_PRESETS,
  LAYER_ANIMATION_PRESETS,
  TEXT_ANIMATION_PRESETS,
  TRANSITION_PRESETS,
  applyEdgeClipboard,
  edgeClipboardLabel,
  findEdgeDecor,
  readEdgeDecor,
  removeEdgeDecor,
  retargetEdgeDecor,
  sameEdgeRef,
  setEdgeDecorDuration,
  type DocumentStore,
  type EdgeClipboard,
  type EdgeDecor,
  type EdgeDecorKind,
  type EdgeRef,
} from "@solomotion/core";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { revealInInspector } from "../state/inspector-nav";
import { useSession } from "../state/session";
import { usePanels } from "../state/panels";
import { readMods, watchDragModifiers, type DragMods } from "../state/drag-modifiers";
import { capturePointer } from "../input/capture-pointer";
import { beginHeldDrag } from "../input/hold-to-drag";
import { subscribePointerEnd } from "../input/pointer-gestures";

/**
 * The ONE clip-edge decoration surface: layer animations, glyph animations and
 * cut transitions all draw, select, resize, rename-in-the-eye and menu through
 * this file. Three visual dialects of one component, not three components —
 * which is what makes their focus ring, their tooltip, their keyboard verbs and
 * their clipboard identical by construction rather than by discipline.
 *
 * The brain is core `timeline/clip-edges.ts`; nothing here knows what a preset
 * means, only how it looks.
 */

// ── Clipboard ────────────────────────────────────────────────────────────────

interface EdgeClipboardState {
  entry: EdgeClipboard | null;
  set: (entry: EdgeClipboard | null) => void;
}

/**
 * ONE clipboard for all three kinds — copying a transition and copying a text
 * animation land in the same slot, so ⌘V has a single meaning and the grain
 * adapts to whatever is selected (see `applyEdgeClipboard`).
 */
export const useEdgeClipboard = create<EdgeClipboardState>((set) => ({
  entry: null,
  set: (entry) => set({ entry }),
}));

// ── Commands ─────────────────────────────────────────────────────────────────

/**
 * Select a decoration — and REVEAL it. Picking the animation handle on a clip
 * edge takes the inspector to the Animate tab and opens the Properties panel if
 * it was collapsed, because the chip and the tab are two views of one object:
 * you grabbed the animation, so the animation's controls are what you want on
 * screen. The same law the rails already follow ("clicking a surface opens its
 * panel"); the timeline was the one surface still expecting you to go and find
 * the panel yourself.
 *
 * Transitions are excluded on purpose — they are not a clip property and have
 * no Animate tab to land on.
 */
export function selectEdgeDecor(ref: EdgeRef | null): void {
  const session = useSession.getState();
  if (!ref || ref.kind === "transition") {
    session.setSelectedEdgeDecor(ref);
    return;
  }
  // Picking a decoration also picks the layer it belongs to — unless that layer
  // is already inside a wider selection, which one chip has no business
  // narrowing. Order matters: `select` clears the decoration slot, so the clip
  // goes first. This used to live in the chip's click handler, which is why the
  // RESIZE grip (the other caller) selected a decoration whose clip was not
  // selected — an Animate tab opened on nothing.
  if (!session.selectedClipIds.includes(ref.clipId)) session.select([ref.clipId]);
  useSession.getState().setSelectedEdgeDecor(ref);
  // The tab AND the section the badge means — a reveal, not a tab switch, so
  // the in/out editor is open when you land rather than one click further.
  revealInInspector({ tab: "animate", section: `${ref.kind}-${ref.side}` });
  if (!usePanels.getState().isShown("inspector")) {
    usePanels.getState().setVisible("inspector", true);
  }
}

export function deleteEdgeDecor(store: DocumentStore, ref: EdgeRef): void {
  const label = findEdgeDecor(store.getState(), ref)?.label ?? "animation";
  store.update(`Remove ${label}`, (d) => {
    removeEdgeDecor(d, ref);
  });
  if (sameEdgeRef(useSession.getState().selectedEdgeDecor, ref)) selectEdgeDecor(null);
}

export function copyEdgeDecor(store: DocumentStore, ref: EdgeRef): string | null {
  const entry = readEdgeDecor(store.getState(), ref);
  if (!entry) return null;
  useEdgeClipboard.getState().set(entry);
  return edgeClipboardLabel(entry);
}

/** Copy then delete in ONE history step, so undo restores the decoration intact. */
export function cutEdgeDecor(store: DocumentStore, ref: EdgeRef): string | null {
  const label = copyEdgeDecor(store, ref);
  if (!label) return null;
  store.update(`Cut ${label}`, (d) => {
    removeEdgeDecor(d, ref);
  });
  if (sameEdgeRef(useSession.getState().selectedEdgeDecor, ref)) selectEdgeDecor(null);
  return label;
}

/** Paste the copied decoration onto every given clip. Returns how many took it. */
export function pasteEdgeDecor(store: DocumentStore, clipIds: readonly string[]): number {
  const entry = useEdgeClipboard.getState().entry;
  if (!entry || !clipIds.length) return 0;
  let applied = 0;
  store.update(`Paste ${edgeClipboardLabel(entry)}`, (d) => {
    applied = applyEdgeClipboard(d, entry, clipIds);
  });
  return applied;
}

// ── Presentation ─────────────────────────────────────────────────────────────

/** ms + frames, the way editors read duration. */
export function durationLabel(ms: number, fps: number): string {
  return `${Math.round(ms)} ms · ${Math.max(1, Math.round((ms / 1000) * fps))}f`;
}

const TONE: Record<EdgeDecorKind, { accent: string; what: string }> = {
  layer: { accent: "var(--edge-layer)", what: "Layer animation" },
  text: { accent: "var(--edge-text)", what: "Text animation" },
  transition: { accent: "var(--edge-transition)", what: "Transition" },
};

/** Direction mark — one character that says which way time runs through the span. */
function DirectionMark({ side }: { side: EdgeDecor["side"] }) {
  // Drawn rather than typed: a glyph would inherit the font's own metrics and
  // never sit on the label's baseline at 9px.
  return (
    <svg viewBox="0 0 8 8" className="size-2 shrink-0 opacity-80" aria-hidden>
      {side === "cut" ? (
        <path d="M1 1 L4 4 L1 7 M7 1 L4 4 L7 7" fill="none" stroke="currentColor" strokeWidth="1.2" />
      ) : side === "in" ? (
        <path d="M0.5 4 H6 M3.5 1.5 L6 4 L3.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      ) : (
        <path d="M2 4 H7.5 M5 1.5 L7.5 4 L5 6.5" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.55" />
      )}
    </svg>
  );
}

export interface EdgeChipProps {
  decor: EdgeDecor;
  /** Lane px. */
  left: number;
  width: number;
  fps: number;
  /** Transitions ride above the clips and get the taller, more solid treatment. */
  emphasis?: "band" | "raised";
  /**
   * Vertical slot, when a clip carries two GRAINS on the same edge (a text clip
   * animating its glyphs AND its whole layer). Stacking them beats overlapping
   * them: two spans on one edge are two different animations, and the reader has
   * to be able to grab either.
   */
  row?: { index: number; count: number };
  /** Which outer handles the caller supports. */
  handles: readonly ("start" | "end")[];
  /** Signed pointer travel in ms since the gesture began. */
  onResize: (edge: "start" | "end", deltaMs: number, mods: DragMods) => void;
  /** Live read-back while dragging (duration + whether it is one-sided). */
  resizeHint?: string | null;
  presets: readonly { id: string; label: string }[];
  onRetarget: (presetId: string) => void;
  onSetDuration: (ms: number) => void;
  /** Extra menu rows a kind wants (alignment, "set as default", …). */
  extraMenu?: React.ReactNode;
  store: DocumentStore;
  /** Clips a paste from this chip's menu should land on. */
  pasteTargets: readonly string[];
}

/**
 * One decoration on the timeline.
 *
 * The design brief it answers: every marker SAYS WHAT IT IS (the preset name,
 * not a mystery gradient), takes focus, answers Delete, and offers the same
 * right-click verbs — with only enough dialect between the kinds to tell the
 * grains apart at a glance.
 *
 *   • a WASH that falls off toward the clip's interior — the direction of the
 *     gradient is the direction of the motion;
 *   • a 1px accent hairline on the OUTER edge (where the clip begins or ends)
 *     and a grip at the INNER boundary, which is the thing you drag;
 *   • the label, shown whenever it fits and replaced by the direction mark
 *     alone when it doesn't — never truncated to noise.
 */
export function EdgeChip({
  decor,
  left,
  width,
  fps,
  emphasis = "band",
  row,
  handles,
  onResize,
  resizeHint,
  presets,
  onRetarget,
  onSetDuration,
  extraMenu,
  store,
  pasteTargets,
}: EdgeChipProps) {
  const selected = useSession((s) => sameEdgeRef(s.selectedEdgeDecor, decor.ref));
  const clipboardLabel = useEdgeClipboard((s) => (s.entry ? edgeClipboardLabel(s.entry) : null));
  const tone = TONE[decor.kind];
  const raised = emphasis === "raised";
  const showLabel = width >= (raised ? 62 : 46);
  const outerSide = decor.side === "out" ? "right" : "left";

  /**
   * Pick the decoration — and deliberately let the press CARRY ON to the clip
   * underneath, which is what turns the chip back into part of the clip's
   * draggable surface. See the note on the body below.
   */
  const select = () => selectEdgeDecor(decor.ref);

  const beginResize = (edge: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    capturePointer((e.currentTarget as Element), e.pointerId);
    selectEdgeDecor(decor.ref);
    // Same rule as the clip this sits on: the lanes scroll sideways and so does
    // this grip, so a swipe belongs to the lanes and a brief hold to the edge.
    const arm = beginHeldDrag(e, { axis: "x" });
    const startX = e.clientX;
    const pxPerMs = width > 0 && decor.durationMs > 0 ? width / decor.durationMs : 0;
    let mods = readMods(e.nativeEvent);
    let lastX = startX;
    const apply = () => onResize(edge, pxPerMs > 0 ? (lastX - startX) / pxPerMs : 0, mods);
    // Modifiers are read LIVE: alt can break a transition's symmetry mid-drag.
    const stopMods = watchDragModifiers(mods, (next) => {
      mods = next;
      apply();
    });
    const onMove = (ev: PointerEvent) => {
      if (!arm.update(ev.clientX, ev.clientY)) return;
      lastX = ev.clientX;
      apply();
    };
    // `pointerup` alone leaked this handler on every cancelled touch, which is
    // the same fault the ruler and the flipbook each shipped once.
    const off = subscribePointerEnd((pid) => {
      if (pid !== e.pointerId) return;
      arm.end();
      stopMods();
      off();
      window.removeEventListener("pointermove", onMove);
    });
    window.addEventListener("pointermove", onMove);
  };

  const durations = [150, 300, 500, 800, 1200].filter((ms) => ms <= decor.maxDurationMs + 1);

  // Where a clip's own trim handle sits inside this chip: at the outer end for
  // a lone decoration, at the real cut for a seam transition. `w-2` in ClipView.
  const TRIM_PX = 8;
  const guardPx = (decor.side === "cut" ? decor.cutFraction : decor.side === "in" ? 0 : 1) * width;
  const hitSegments = [
    { left: 0, width: Math.max(0, guardPx - TRIM_PX) },
    { left: guardPx + TRIM_PX, width: Math.max(0, width - guardPx - TRIM_PX) },
  ].filter((seg) => seg.width > 1);

  const body = (
    <div
      role="button"
      tabIndex={-1}
      aria-label={`${decor.label} ${tone.what}`}
      data-selected={selected || undefined}
      className={cn(
        "group/edge absolute z-20 overflow-hidden",
        raised ? "top-0.5 bottom-0.5 rounded-md border" : row && row.count > 1 ? "" : "inset-y-0",
        // The chip rounds only on its OUTER corners for a band — it is part of
        // the clip's own silhouette there, not a floating object on top of it.
        !raised && (decor.side === "out" ? "rounded-r-[inherit]" : "rounded-l-[inherit]"),
        "pointer-events-none transition-[box-shadow,background-color] duration-150",
        selected && (raised ? "ring-1" : "ring-1 ring-inset"),
      )}
      style={{
        left,
        width,
        ...(row && row.count > 1 && !raised
          ? { top: `${(row.index / row.count) * 100}%`, height: `${100 / row.count}%` }
          : null),
        // color-mix keeps ONE hue per kind and derives every shade from it, so
        // a theme restating `--edge-*` restates the whole chip.
        ["--edge" as string]: tone.accent,
        background: raised
          ? "color-mix(in srgb, var(--edge) 16%, var(--background))"
          : decor.side === "out"
            ? "linear-gradient(to left, color-mix(in srgb, var(--edge) 42%, transparent), transparent)"
            : "linear-gradient(to right, color-mix(in srgb, var(--edge) 42%, transparent), transparent)",
        borderColor: raised ? "color-mix(in srgb, var(--edge) 55%, transparent)" : undefined,
        boxShadow: selected
          ? "0 0 0 1px color-mix(in srgb, var(--edge) 90%, transparent) inset, 0 0 0 1px color-mix(in srgb, var(--edge) 45%, transparent)"
          : undefined,
        color: "color-mix(in srgb, var(--edge) 78%, var(--foreground))",
      }}
      /*
       * A CHIP IS A MARK ON THE CLIP, NOT AN OBJECT ON TOP OF IT.
       *
       * The press used to stop here. That made the whole animate-in / animate-
       * out band a dead zone for the everyday gesture: on a short clip the two
       * chips ARE most of the clip, so picking it up and moving it was simply
       * not possible — the same failure `clip-chrome.tsx` was written to end,
       * arriving through the one surface that sits outside its layer.
       *
       * So the press SELECTS the decoration and then keeps going. It reaches
       * the clip's own `startGesture`, which is the one move/trim/duplicate
       * gesture in the timeline — nothing about dragging is reimplemented here,
       * and dragging a clip by its chip is dragging the clip. The decoration's
       * own retime lives on its two grips below, which have their own edges and
       * do stop the press, so both gestures are reachable and neither guesses.
       *
       * Selecting on the PRESS rather than the click is what makes the order
       * work: `select` in the session keeps a decoration whose clip is still
       * selected (`decorStays`), so the clip's press-selection running a
       * moment later no longer wipes it.
       */
      onPointerDown={(e) => {
        // A RAISED chip is a transition: it straddles two clips and belongs to
        // the LANE, so there is nothing underneath it that the press should
        // reach — letting it through would hand the lane a press that means
        // "nothing here", clearing the selection this just made. A BAND is
        // part of one clip's silhouette, and its press belongs to that clip.
        if (raised) e.stopPropagation();
        select();
      }}
    >
      {/* The chip is INERT; only the segments below take the pointer. A clip's
          own trim handle lives under one of these spans — under the outer edge
          for a lone decoration, under the CUT for a seam transition — and
          swallowing it meant dragging a clip's end resized (and then deleted)
          the transition instead of the clip. Events from the segments still
          bubble to this element, so the context menu and the clip's own move
          gesture both keep working. */}
      {hitSegments.map((seg, i) => (
        <span
          key={i}
          className="absolute inset-y-0 cursor-pointer"
          style={{ left: seg.left, width: seg.width, pointerEvents: "auto" }}
        />
      ))}
      {/* The outer hairline: where the clip itself starts or ends. */}
      {!raised && (
        <span
          className="pointer-events-none absolute inset-y-0 w-px"
          style={{
            [outerSide]: 0,
            background: "color-mix(in srgb, var(--edge) 85%, transparent)",
          }}
        />
      )}

      {/* A transition's real cut, wherever the split actually puts it. */}
      {raised && (
        <span
          className="pointer-events-none absolute inset-y-1 w-px"
          style={{
            left: `${decor.cutFraction * 100}%`,
            background: "color-mix(in srgb, var(--edge) 70%, transparent)",
          }}
        />
      )}

      {/* Glyph-grain tell: a per-unit tick rhythm only a text animation has. */}
      {decor.kind === "text" && (
        <span
          className="pointer-events-none absolute inset-x-0 top-0 h-[3px] opacity-70"
          style={{
            backgroundImage:
              "repeating-linear-gradient(90deg, color-mix(in srgb, var(--edge) 80%, transparent) 0 2px, transparent 2px 6px)",
            maskImage:
              decor.side === "out"
                ? "linear-gradient(to left, black, transparent)"
                : "linear-gradient(to right, black, transparent)",
          }}
        />
      )}

      {/* The name sits along the BOTTOM of a band, because the clip's own name
          owns the middle of the lane — two labels on one baseline is how the
          old chrome managed to be both loud and unreadable. */}
      <span
        className={cn(
          "pointer-events-none absolute inset-x-0 flex gap-1 px-1.5 text-[9px] font-medium tracking-tight",
          raised
            ? "inset-y-0 items-center justify-center"
            : cn("bottom-0 items-end pb-[3px]", decor.side === "out" ? "justify-end" : "justify-start"),
        )}
      >
        <DirectionMark side={decor.side} />
        {showLabel && <span className="truncate">{decor.label}</span>}
      </span>

      {handles.map((edge) => (
        <span
          key={edge}
          className={cn(
            "pointer-events-auto absolute inset-y-0 w-2.5 cursor-ew-resize",
            edge === "start" ? "left-0" : "right-0",
            // The grip only materialises on hover or focus — a permanent bar on
            // every animated clip is the visual noise this redesign removes.
            "after:absolute after:inset-y-1 after:w-[3px] after:rounded-full",
            "after:bg-[color-mix(in_srgb,var(--edge)_95%,transparent)]",
            "after:opacity-0 group-hover/edge:after:opacity-100 after:transition-opacity",
            selected && "after:opacity-90",
            edge === "start" ? "after:left-0.5" : "after:right-0.5",
          )}
          onPointerDown={beginResize(edge)}
          onClick={(e) => e.stopPropagation()}
        />
      ))}

      {resizeHint && (
        <span className="pointer-events-none absolute -top-6 left-1/2 z-30 -translate-x-1/2 rounded bg-popover px-1.5 py-0.5 text-[10px] whitespace-nowrap text-popover-foreground shadow-md ring-1 ring-border">
          {resizeHint}
        </span>
      )}
    </div>
  );

  return (
    <ContextMenu>
      <Tooltip delayDuration={550}>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>{body}</TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent side="top" className="max-w-56">
          <span className="font-medium">{decor.label}</span>
          <span className="text-muted-foreground">
            {" · "}
            {tone.what}
            {decor.side !== "cut" && (decor.side === "in" ? " in" : " out")}
          </span>
          <div className="text-muted-foreground">{durationLabel(decor.durationMs, fps)}</div>
          {decor.tagline && <div className="text-muted-foreground">{decor.tagline}</div>}
          {decor.warning && <div className="text-amber-400">{decor.warning}</div>}
          <div className="mt-1 text-[10px] text-muted-foreground">
            Drag the edge to retime · ⌫ removes it
          </div>
        </TooltipContent>
      </Tooltip>

      <ContextMenuContent className="w-52">
        <ContextMenuSub>
          <ContextMenuSubTrigger>Preset</ContextMenuSubTrigger>
          <ContextMenuSubContent>
<ScrollArea className="max-h-80">
            {presets.map((p) => (
              <ContextMenuItem key={p.id} onClick={() => onRetarget(p.id)}>
                {p.label}
                {decor.presetId === p.id && <span className="ml-auto text-primary">•</span>}
              </ContextMenuItem>
            ))}
          </ScrollArea>
        </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Duration</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {durations.map((ms) => (
              <ContextMenuItem key={ms} onClick={() => onSetDuration(ms)}>
                {durationLabel(ms, fps)}
                {Math.abs(decor.durationMs - ms) < 1 && <span className="ml-auto text-primary">•</span>}
              </ContextMenuItem>
            ))}
            {!durations.length && <ContextMenuItem disabled>No room on this clip</ContextMenuItem>}
          </ContextMenuSubContent>
        </ContextMenuSub>
        {extraMenu}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => copyEdgeDecor(store, decor.ref)}>Copy</ContextMenuItem>
        <ContextMenuItem onClick={() => cutEdgeDecor(store, decor.ref)}>Cut</ContextMenuItem>
        <ContextMenuItem
          disabled={!clipboardLabel || !pasteTargets.length}
          onClick={() => pasteEdgeDecor(store, pasteTargets)}
        >
          {clipboardLabel ? `Paste “${clipboardLabel}”` : "Paste"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => deleteEdgeDecor(store, decor.ref)}
        >
          Delete
        </ContextMenuItem>
        {decor.warning && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem disabled className="text-amber-400">
              {decor.warning}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The preset vocabulary a decoration may be retargeted to. */
export function presetsFor(kind: EdgeDecorKind, clipIsText: boolean): readonly { id: string; label: string }[] {
  if (kind === "transition") return TRANSITION_PRESETS;
  if (kind === "text") return TEXT_ANIMATION_PRESETS;
  return clipIsText ? ANIMATION_PRESETS : LAYER_ANIMATION_PRESETS;
}

export { findEdgeDecor, retargetEdgeDecor, setEdgeDecorDuration };
