"use client";

import { cursors } from "@solomotion/ui/cursors";
import * as React from "react";
import {
  bakePoseSet,
  behaviorDef,
  behaviorIn,
  blockEditable,
  changeBlockPose,
  compFps,
  characterLanes,
  deleteBlock,
  drivesSet,
  locateClip,
  poseEnvAt,
  poseSetLiveSource,
  resetBehaviorOverrides,
  slideBlock,
  slideTarget,
  snapTime,
  speechGeneration,
  splitBlock,
  trimBlock,
  trimTarget,
  updateBehavior,
  type MotionDocument,
  type BlockSpan,
  type GroupClip,
  type Pose,
  type PoseBlock,
  type PoseLane,
  type PoseSet,
} from "@solomotion/core";
import { Pin, Radio } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { useDocSelector, useDocStore, useDocWhen } from "../state/document-context";
import { useSession, type PoseBlockRef } from "../state/session";
import { revealInInspector } from "../state/inspector-nav";
import { onSpeechChange } from "../speech/speech-host";
import { characterArt, PoseThumb } from "../character/pose-art";
import { behaviorHatch, behaviorIcon, behaviorTint } from "../character/behavior-style";
import { useStripWindow } from "../preview/use-poster";
import { beginScrubDrag } from "./scrub";
import { collectSnapCandidates, pxToTime, timeToPx } from "./timeline-utils";
import { refOf, resolvePoseBlock } from "./pose-block-actions";

/**
 * A CHARACTER'S PERFORMANCE ON THE TIMELINE — one lane per pose set, a block
 * per stretch of one pose, and every block says who decided it
 * (ADR-characters-3, "Blocks"). The blocks are `characterLanes` (core),
 * drawn; every edit is a core block verb (`rig/block-edit`), so the dope
 * sheet, agents and undo see one truth.
 *
 * EVERY BLOCK IS A CLIP to the hand: click picks it (⇧ adds), its edges trim,
 * the edge it shares with its neighbour rolls (⌥ trims it alone), its body
 * slides, and the edit verbs reach it through the shortcut table — Split cuts
 * it at the playhead, Delete clears it, 1–9 change its pose. What it MEANS
 * depends on who decided it:
 *
 *  keyed       solid, neutral — yours: its key moves.
 *  base        faint — the set's resting pose.
 *  behavior    hatched in its behavior's colour — generated (a blink, a
 *              syllable, a cycle's step). Any edit is an OVERRIDE the behavior
 *              keeps when it regenerates.
 *  overridden  solid in the behavior's colour, with a pin — a person decided
 *              it. Right-click → Back to automatic.
 *  driver      hatched grey — an expression or the node board; Bake makes keys.
 *
 * A drag previews in the row alone (pure `trimTarget` / `slideTarget`) and
 * writes once, on release — nothing re-samples the character while you move.
 */

/** What a lane row reads, narrowly: what CHOOSES its pose, never a bone a drag is moving. */
function laneDeps(d: MotionDocument, groupId: string, setId: string): unknown[] {
  const g = locateClip(d, groupId)?.clip;
  if (g?.kind !== "group") return [null];
  const path = `pose.${setId}`;
  const token = g.drivers?.[path];
  const live = !!token || !!g.behaviors?.length;
  return [
    g.poses?.find((s) => s.id === setId),
    g.keyframes.find((k) => k.property === path),
    token,
    g.behaviors,
    g.startMs,
    g.durationMs,
    // A live set reads its world: expressions, inputs, machines, voices, keyed behavior fields.
    ...(live ? [d.expressions, d.frames, d.assets, g.keyframes, ...d.tracks.flatMap((t) => t.clips.filter((c) => c.kind === "audio" || c.kind === "nested" || c.kind === "video"))] : []),
  ];
}

/** The lane for one set over the comp range on screen — that set alone. */
function usePoseLane(groupId: string, setId: string, range: { fromMs: number; toMs: number } | null): { lane: PoseLane | null; doc: MotionDocument } {
  const doc = useDocWhen((d) => laneDeps(d, groupId, setId));
  const speech = React.useSyncExternalStore(onSpeechChange, speechGeneration, speechGeneration);
  const lane = React.useMemo(() => {
    if (!range) return null;
    const g = locateClip(doc, groupId)?.clip;
    const fid = g?.frameId ?? null;
    return characterLanes(doc, groupId, range, (t) => poseEnvAt(doc, t, fid), setId)[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, groupId, setId, range?.fromMs, range?.toMs, speech]);
  return { lane, doc };
}

const revealSet = (groupId: string, setId: string) => {
  useSession.getState().select([groupId]);
  revealInInspector({ tab: "character", section: "character-face", entry: setId });
};
const revealBehavior = (groupId: string, behaviorId: string) => {
  useSession.getState().select([groupId]);
  revealInInspector({ tab: "character", section: "character-behaviors", entry: behaviorId });
};

/** Is this (visible, maybe clipped) block the one a ref names? */
const isRef = (r: PoseBlockRef, groupId: string, setId: string, b: PoseBlock) =>
  r.groupId === groupId && r.setId === setId && r.behaviorId === b.behaviorId && b.fromMs <= r.atMs && r.atMs < b.toMs;

/** Pick blocks: the character becomes the selection, the blocks its parts. ⇧ adds or removes. */
function pickBlock(ref: PoseBlockRef, additive: boolean) {
  const s = useSession.getState();
  if (!s.selectedClipIds.includes(ref.groupId) || s.selectedClipIds.length !== 1) s.select([ref.groupId]);
  const now = useSession.getState().selectedPoseBlocks;
  if (!additive) return s.setSelectedPoseBlocks([ref]);
  const same = (r: PoseBlockRef) => r.setId === ref.setId && r.behaviorId === ref.behaviorId && Math.abs(r.atMs - ref.atMs) < 0.5;
  s.setSelectedPoseBlocks(now.some(same) ? now.filter((r) => !same(r)) : [...now, ref]);
}

// ── The header ───────────────────────────────────────────────────────────────

export const PoseLaneHeader = React.memo(function PoseLaneHeader({ group, setId, height, indentPx }: { group: GroupClip; setId: string; height: number; indentPx: number }) {
  const store = useDocStore();
  const set = group.poses?.find((s) => s.id === setId);
  const keyed = group.keyframes.some((k) => k.property === `pose.${setId}` && k.keys.length > 0);
  // Core's rule, not a second one: a driver riding on the keys (`#value`) is not live.
  const driven = useDocSelector((d) => (set ? poseSetLiveSource(d, group, set) !== null : false));
  // Which behaviors speak for this set (a machine only for the sets its states name).
  const ids = useDocSelector((d) => (set ? (group.behaviors ?? []).filter((b) => drivesSet(b, set, d)).map((b) => b.id).join(",") : ""));
  if (!set) return null;
  const behaviors = (group.behaviors ?? []).filter((b) => ids.split(",").includes(b.id));
  return (
    <div
      className="flex cursor-pointer select-none items-center gap-1.5 border-b border-border/40 pr-2 text-xs hover:bg-accent/30"
      style={{ height, paddingLeft: 12 + indentPx }}
      onClick={() => revealSet(group.id, setId)}
      title={`${set.name} — open in the Face pad`}
    >
      <span className="min-w-0 flex-1 truncate text-foreground/80">{set.name}</span>
      {behaviors.map((b) => {
        const Icon = behaviorIcon(b.type);
        const on = b.enabled !== false;
        return (
          <button
            key={b.id}
            type="button"
            className={cn("flex size-5 shrink-0 items-center justify-center rounded-md transition-opacity hover:bg-foreground/10", !on && "opacity-35")}
            style={{ color: behaviorTint(b.type) }}
            title={`${behaviorDef(b.type)?.label ?? b.type}${on ? "" : " (off)"} — click to edit, ⌥-click to turn ${on ? "off" : "on"}`}
            onClick={(e) => {
              e.stopPropagation();
              if (e.altKey) store.update(`${on ? "Mute" : "Unmute"} ${behaviorDef(b.type)?.label ?? b.type}`, (d) => void updateBehavior(d, group.id, b.id, { enabled: !on }));
              else revealBehavior(group.id, b.id);
            }}
          >
            <Icon className="size-3" />
          </button>
        );
      })}
      {!behaviors.length && driven && (
        <span className="flex shrink-0 items-center gap-0.5 text-2xs text-muted-foreground" title="Chosen by an expression — right-click a block to bake it">
          <Radio className="size-3" /> Live
        </span>
      )}
      {!behaviors.length && !driven && <span className="shrink-0 text-2xs text-muted-foreground/70">{keyed ? "Keyed" : "Rest"}</span>}
    </div>
  );
});

// ── The lane ─────────────────────────────────────────────────────────────────

/**
 * Below this a block has no room for its picture — above it, a narrow block
 * shows the middle of it (the part the tile frames: the mouth, the eyes), so
 * a 12px syllable still reads as a shape. Past the picture, `LABEL_MIN_PX`
 * makes room for its name.
 */
const PICTURE_MIN_PX = 12;
const LABEL_MIN_PX = 30;
/** The grab zone at a block's edge — the clip's own width (`EDGE_GRIP_WIDTH` on a clip is 8). */
const EDGE_PX = 6;
/** A block narrower than this is all body: no edge would leave anything to grab. */
const EDGES_MIN_PX = 3 * EDGE_PX;

const DRIVER_HATCH = "repeating-linear-gradient(135deg, color-mix(in oklab, var(--foreground) 6%, transparent) 0 4px, transparent 4px 8px)";

/** Where the lane an element sits in starts, on screen. */
const laneLeft = (el: Element) => ((el.closest("[data-pose-lane]") as HTMLElement | null) ?? (el as HTMLElement)).getBoundingClientRect().left;

type DragMode = "move" | "start" | "end";

/** A drag in flight: the full-span block it holds, and where it (and a rolled neighbour) would land. */
interface DragPreview {
  behaviorId?: string;
  /** The held block's span when the drag began (the full one, not the on-screen clip of it). */
  from0: number;
  to0: number;
  mode: DragMode;
  span: BlockSpan;
  neighbor: { from0: number; to0: number; behaviorId?: string; span: BlockSpan } | null;
}

const fmt = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
};

export const PoseLaneRow = React.memo(function PoseLaneRow({
  group,
  setId,
  height,
  pxPerSec,
  style,
}: {
  group: GroupClip;
  setId: string;
  height: number;
  pxPerSec: number;
  /** The nesting rails, painted by the timeline (one look for every row in a band). */
  style?: React.CSSProperties;
}) {
  const store = useDocStore();
  const win = useStripWindow(group.startMs, group.durationMs, pxPerSec);
  const range = React.useMemo(() => (win ? { fromMs: group.startMs + (win.fromPx / pxPerSec) * 1000, toMs: group.startMs + (win.toPx / pxPerSec) * 1000 } : null), [win, group.startMs, pxPerSec]);
  const { lane, doc } = usePoseLane(group.id, setId, range);
  const picked = useSession((s) => s.selectedPoseBlocks);
  const mine = React.useMemo(() => picked.filter((r) => r.groupId === group.id && r.setId === setId), [picked, group.id, setId]);
  const [drag, setDrag] = React.useState<DragPreview | null>(null);
  const act = React.useRef<LaneActs | null>(null);
  const character = locateClip(doc, group.id)?.clip;
  const set = character?.kind === "group" ? character.poses?.find((s) => s.id === setId) : undefined;
  const art = character?.kind === "group" ? characterArt(doc, group.id) : null;

  if (!lane || !set || character?.kind !== "group" || !art) return <div data-pose-lane={setId} className="relative border-b border-border/40" style={{ height, ...style }} />;

  /** Snap targets: the comp's (clips, playhead, markers) and this lane's other edges. */
  const snapper = (exclude: number[]) => {
    const s = useSession.getState();
    const candidates = collectSnapCandidates(store.getState(), group.frameId, new Set(), s.playheadMs, s.snapSettings);
    for (const b of lane.blocks) for (const t of [b.fromMs, b.toMs]) if (!exclude.some((x) => Math.abs(x - t) < 0.5)) candidates.push(t);
    const threshold = pxToTime(s.snapSettings.thresholdPx, pxPerSec);
    return (abs: number): { at: number; snapped: number | null } => {
      if (!useSession.getState().snapping) return { at: abs, snapped: null };
      const to = snapTime(abs, candidates, threshold);
      return Math.abs(to - abs) > 0.001 ? { at: to, snapped: to } : { at: abs, snapped: null };
    };
  };

  /**
   * A press on a block: it is picked at once (the focus ring shows before you
   * move), then the drag trims, rolls or slides it — previewed here, written
   * once on release as one undo step.
   */
  const onBlockDown = (e: React.PointerEvent, block: PoseBlock, edge: "start" | "end" | null) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const ref = refOf(group.id, setId, block);
    const already = mine.some((r) => isRef(r, group.id, setId, block));
    if (!(already && !e.shiftKey)) pickBlock(ref, e.shiftKey);
    if (!blockEditable(block) || e.shiftKey) return;
    const mode: DragMode = edge ?? "move";
    const roll = !e.altKey;
    const startX = e.clientX;
    const left = laneLeft(e.currentTarget as HTMLElement);
    const grabbedAt = pxToTime(startX - left, pxPerSec);
    // The verbs need the block's true edges, not the on-screen clip of it —
    // read once the press becomes a drag, so a click is only a pick.
    let full: { blocks: PoseBlock[]; index: number } | null = null;
    let b = block;
    let snap: ReturnType<typeof snapper> = (t) => ({ at: t, snapped: null });
    let moved = false;
    let last: DragPreview | null = null;
    beginScrubDrag(
      e,
      (clientX) => {
        if (!moved && Math.abs(clientX - startX) < 3) return;
        if (!full) {
          full = resolvePoseBlock(store.getState(), ref);
          if (!full) return;
          b = full.blocks[full.index]!;
          snap = snapper(mode === "move" ? [b.fromMs, b.toMs] : [mode === "start" ? b.fromMs : b.toMs]);
        }
        moved = true;
        const held = full;
        const t = pxToTime(clientX - left, pxPerSec);
        const d = store.getState();
        let next: DragPreview | null = null;
        if (mode === "move") {
          // Snap whichever edge lands nearer something.
          const delta = t - grabbedAt;
          const a = snap(b.fromMs + delta);
          const z = snap(b.toMs + delta);
          const use = a.snapped !== null && (z.snapped === null || Math.abs(a.at - (b.fromMs + delta)) <= Math.abs(z.at - (b.toMs + delta))) ? a.at - b.fromMs : z.snapped !== null ? z.at - b.toMs : delta;
          useSession.getState().setSnapIndicator(a.snapped ?? z.snapped);
          const span = slideTarget(d, group.id, setId, held.blocks, held.index, use);
          if (span) next = { behaviorId: b.behaviorId, from0: b.fromMs, to0: b.toMs, mode, span, neighbor: null };
        } else {
          const s = snap(t);
          useSession.getState().setSnapIndicator(s.snapped);
          const target = trimTarget(d, group.id, setId, held.blocks, held.index, mode, s.at, { roll });
          if (target) {
            const n = target.neighbor ? held.blocks[target.neighbor.index]! : null;
            next = {
              behaviorId: b.behaviorId,
              from0: b.fromMs,
              to0: b.toMs,
              mode,
              span: target.block,
              neighbor: n && target.neighbor ? { from0: n.fromMs, to0: n.toMs, behaviorId: n.behaviorId, span: { fromMs: target.neighbor.fromMs, toMs: target.neighbor.toMs } } : null,
            };
          }
        }
        last = next;
        setDrag(next);
      },
      () => {
        useSession.getState().setSnapIndicator(null);
        setDrag(null);
        const p = last;
        const held = full;
        if (!moved || !p || !held) {
          if (!moved && !e.shiftKey && !block.behaviorId) revealSet(group.id, setId);
          return;
        }
        const label = mode === "move" ? "Move block" : roll && p.neighbor ? "Roll blocks" : "Trim block";
        store.update(label, (d) => {
          if (mode === "move") slideBlock(d, group.id, setId, held.blocks, held.index, p.span.fromMs - b.fromMs);
          else trimBlock(d, group.id, setId, held.blocks, held.index, mode, mode === "start" ? p.span.fromMs : p.span.toMs, { roll });
        });
        useSession.getState().setSelectedPoseBlocks([refOf(group.id, setId, { ...p.span, behaviorId: b.behaviorId })]);
      },
    );
  };

  const changeTo = (block: PoseBlock, pose: Pose) => {
    const full = resolvePoseBlock(store.getState(), refOf(group.id, setId, block));
    if (full) store.update(`Pose ${pose.name}`, (d) => void changeBlockPose(d, group.id, setId, full.blocks[full.index]!, pose.id));
  };
  const splitAt = (block: PoseBlock, atMs: number) => {
    const full = resolvePoseBlock(store.getState(), refOf(group.id, setId, block));
    if (!full) return;
    let ok = false;
    store.update("Split block", (d) => void (ok = splitBlock(d, group.id, setId, full.blocks[full.index]!, atMs)));
    if (ok) pickBlock({ groupId: group.id, setId, atMs: (atMs + full.blocks[full.index]!.toMs) / 2, ...(block.behaviorId ? { behaviorId: block.behaviorId } : {}) }, false);
  };
  const remove = (block: PoseBlock) => {
    const full = resolvePoseBlock(store.getState(), refOf(group.id, setId, block));
    if (full) store.update("Delete block", (d) => void deleteBlock(d, group.id, setId, full.blocks[full.index]!));
  };

  /** Where a visible block draws now: a drag moves the held block (and a rolled neighbour). */
  const placed = (b: PoseBlock): { span: BlockSpan; held: boolean } => {
    if (drag) {
      const within = (from0: number, to0: number, id?: string) => b.behaviorId === id && b.fromMs >= from0 - 0.5 && b.toMs <= to0 + 0.5;
      if (within(drag.from0, drag.to0, drag.behaviorId)) return { span: drag.span, held: true };
      if (drag.neighbor && within(drag.neighbor.from0, drag.neighbor.to0, drag.neighbor.behaviorId)) return { span: drag.neighbor.span, held: false };
    }
    return { span: b, held: false };
  };

  act.current = { onBlockDown, changeTo, splitAt, remove };

  return (
    <div data-pose-lane={setId} className="relative border-b border-border/40" style={{ height, ...style }}>
      {lane.blocks.map((block, i) => {
        const { span, held } = placed(block);
        // The edge it shares with the block beside it rolls; ⌥ trims it alone.
        const prev = lane.blocks[i - 1];
        const next = lane.blocks[i + 1];
        return (
          <LaneBlock
            key={`${block.fromMs}-${block.poseId}-${block.behaviorId ?? ""}-${block.overrideId ?? ""}`}
            act={act}
            block={block}
            span={span}
            held={held}
            selected={mine.some((r) => isRef(r, group.id, setId, block))}
            sharesStart={!!prev && Math.abs(prev.toMs - block.fromMs) < 0.5}
            sharesEnd={!!next && Math.abs(next.fromMs - block.toMs) < 0.5}
            pxPerSec={pxPerSec}
            height={height}
            group={group}
            character={character}
            art={art}
            set={set}
            laneMode={lane.mode}
          />
        );
      })}
      {drag && (
        <span
          className="pointer-events-none absolute top-0.5 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-popover/95 px-1.5 py-0.5 font-mono text-[10px] text-popover-foreground shadow-md ring-1 ring-border"
          style={{ left: timeToPx((drag.span.fromMs + drag.span.toMs) / 2, pxPerSec) }}
        >
          {fmt(drag.span.fromMs)} → {fmt(drag.span.toMs)} · {Math.round(((drag.span.toMs - drag.span.fromMs) * compFps(doc, group.frameId)) / 1000) || "<1"}f
        </span>
      )}
    </div>
  );
});

interface LaneActs {
  onBlockDown: (e: React.PointerEvent, block: PoseBlock, edge: "start" | "end" | null) => void;
  changeTo: (block: PoseBlock, pose: Pose) => void;
  splitAt: (block: PoseBlock, atMs: number) => void;
  remove: (block: PoseBlock) => void;
}

/**
 * ONE BLOCK — memoised, its handlers read through a ref, so a drag re-renders
 * the block it holds (and a rolled neighbour), not the thirty around it with
 * their pictures and menus.
 */
const LaneBlock = React.memo(function LaneBlock({
  act,
  block,
  span,
  held,
  selected,
  sharesStart,
  sharesEnd,
  pxPerSec,
  height,
  group,
  character,
  art,
  set,
  laneMode,
}: {
  act: React.RefObject<LaneActs | null>;
  block: PoseBlock;
  span: BlockSpan;
  held: boolean;
  selected: boolean;
  sharesStart: boolean;
  sharesEnd: boolean;
  pxPerSec: number;
  height: number;
  group: GroupClip;
  character: GroupClip;
  art: NonNullable<ReturnType<typeof characterArt>>;
  set: PoseSet;
  laneMode: PoseLane["mode"];
}) {
  const store = useDocStore();
  const setId = set.id;
  const left = timeToPx(span.fromMs, pxPerSec);
  const width = Math.max(2, timeToPx(span.toMs - span.fromMs, pxPerSec) - 1);
  const pose = set.poses.find((p) => p.id === block.poseId);
  const behavior = block.behaviorId ? behaviorIn(character, block.behaviorId) : null;
  const def = behavior ? behaviorDef(behavior.type) : undefined;
  const tint = behavior ? behaviorTint(behavior.type) : null;
  const editable = blockEditable(block);
  const picH = Math.max(12, height - 8);
  const showPic = !!pose && width >= PICTURE_MIN_PX && picH >= 14;
  const showName = width >= (showPic ? picH + LABEL_MIN_PX : LABEL_MIN_PX);
  const who = behavior ? `${def?.label ?? behavior.type}${block.overridden ? " · your override" : ""}` : block.source === "live" ? "live" : block.source === "base" ? "resting pose" : "your key";
  const blockStyle: React.CSSProperties = { left, width, height: height - 8, zIndex: held ? 3 : selected ? 2 : undefined };
  if (behavior && tint) {
    if (block.overridden) {
      blockStyle.background = `color-mix(in oklab, ${tint} 34%, transparent)`;
      blockStyle.boxShadow = `inset 0 0 0 1px color-mix(in oklab, ${tint} 75%, transparent)`;
    } else {
      blockStyle.backgroundImage = behaviorHatch(behavior.type);
      blockStyle.boxShadow = `inset 0 0 0 1px color-mix(in oklab, ${tint} 40%, transparent)`;
    }
  } else if (block.source === "live") blockStyle.backgroundImage = DRIVER_HATCH;
  const edge = (side: "start" | "end", shared: boolean) =>
    editable &&
    width >= EDGES_MIN_PX && (
      <div
        aria-hidden
        title={shared ? "Roll — trim both blocks at the seam (⌥: this one alone)" : "Trim"}
        className={cn("group/edge absolute inset-y-0 z-[1] touch-none", side === "start" ? "left-0" : "right-0")}
        style={{ width: EDGE_PX, cursor: shared ? cursors.colResize : side === "start" ? cursors.trimStart : cursors.trimEnd }}
        onPointerDown={(e) => act.current!.onBlockDown(e, block, side)}
      >
        <div className={cn("absolute inset-y-1 w-[3px] rounded-full transition-colors group-hover/edge:bg-primary", side === "start" ? "left-px" : "right-px", selected ? "bg-primary" : "bg-transparent")} />
      </div>
    );
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-pose-block
          data-pose-behavior={behavior?.type}
          data-overridden={block.overridden ? "" : undefined}
          data-selected={selected ? "" : undefined}
          className={cn(
            "absolute top-1 flex items-center gap-1 overflow-hidden rounded-md px-0.5 text-2xs",
            !held && "transition-[background-color,opacity]",
            block.source === "keyed" && "bg-foreground/[0.08] text-foreground/85 ring-1 ring-inset ring-foreground/15 hover:bg-foreground/[0.12]",
            block.source === "base" && "bg-foreground/[0.03] text-muted-foreground ring-1 ring-inset ring-foreground/[0.08] hover:bg-foreground/[0.06]",
            block.source === "live" && !behavior && "text-muted-foreground ring-1 ring-inset ring-foreground/10",
            behavior && "text-foreground/85",
            editable ? "cursor-grab active:cursor-grabbing" : "cursor-default",
            held && "shadow-lg",
          )}
          style={blockStyle}
          title={`${block.name} · ${fmt(block.fromMs)}–${fmt(block.toMs)} · ${who}`}
          onPointerDown={(e) => act.current!.onBlockDown(e, block, null)}
          // Right-click picks it too: the menu is about the block you see ringed.
          onContextMenu={() => !selected && pickBlock(refOf(group.id, setId, block), false)}
          // Double-click opens what decided it — a split is always at the playhead (Split), never under the mouse.
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (behavior) revealBehavior(group.id, behavior.id);
            else revealSet(group.id, setId);
          }}
        >
          {showPic && (
            <PoseThumb
              art={art}
              character={character}
              set={set}
              pose={pose!}
              className="h-full shrink-0 rounded-[4px] bg-background/40"
              style={width - 4 < picH ? { width: Math.max(8, width - 4) } : undefined}
            />
          )}
          {showName && <span className="min-w-0 truncate">{block.name}</span>}
          {block.overridden && width >= 14 && <Pin aria-label="Your override" className="absolute right-1 top-0.5 size-2.5" style={{ color: tint ?? undefined }} />}
          {/* The focus state: a ring OVER the block's own look (an inline
              shadow would hide a ring class), never a slab over its art. */}
          {selected && <span aria-hidden className="pointer-events-none absolute inset-0 rounded-md bg-primary/[0.14] ring-2 ring-inset ring-primary" />}
          {edge("start", sharesStart)}
          {edge("end", sharesEnd)}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuSub>
          <ContextMenuSubTrigger className="text-[12px]">{behavior ? "Override with" : "Change to"}</ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-80 w-48 overflow-y-auto">
            {set.poses.map((p, n) => (
              <ContextMenuItem key={p.id} className="gap-2 text-[12px]" onSelect={() => act.current!.changeTo(block, p)}>
                <PoseThumb art={art} character={character} set={set} pose={p} className="size-6 rounded-[4px]" />
                <span className="flex-1 truncate">{p.name}</span>
                {n < 9 && <ContextMenuShortcut>{n + 1}</ContextMenuShortcut>}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        {(editable || block.source === "base") && (
          <ContextMenuItem className="text-[12px]" onSelect={() => act.current!.splitAt(block, useSession.getState().playheadMs)}>
            Split at playhead
          </ContextMenuItem>
        )}
        {editable && (
          <ContextMenuItem className="text-[12px]" onSelect={() => act.current!.remove(block)}>
            {behavior ? `No ${(def?.label ?? "behavior").toLowerCase()} here` : "Delete"} <ContextMenuShortcut>⌫</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        {behavior && (
          <>
            <ContextMenuSeparator />
            {block.overridden && (
              <ContextMenuItem
                className="text-[12px]"
                onSelect={() => store.update("Back to automatic", (d) => void resetBehaviorOverrides(d, group.id, behavior.id, { fromMs: block.fromMs - group.startMs, toMs: block.toMs - group.startMs }))}
              >
                Back to automatic
              </ContextMenuItem>
            )}
            {!!behavior.overrides?.length && (
              <ContextMenuItem className="text-[12px]" onSelect={() => store.update(`Reset ${def?.label ?? "behavior"}`, (d) => void resetBehaviorOverrides(d, group.id, behavior.id))}>
                Reset every override ({behavior.overrides.length})
              </ContextMenuItem>
            )}
            <ContextMenuItem className="text-[12px]" onSelect={() => revealBehavior(group.id, behavior.id)}>
              Edit {def?.label ?? "behavior"}…
            </ContextMenuItem>
            <ContextMenuItem className="text-[12px]" onSelect={() => store.update(`Mute ${def?.label ?? "behavior"}`, (d) => void updateBehavior(d, group.id, behavior.id, { enabled: false }))}>
              Turn {def?.label ?? "behavior"} off
            </ContextMenuItem>
          </>
        )}
        {laneMode === "live" && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              className="text-[12px]"
              onSelect={() => {
                const env = poseEnvAt(store.getState(), group.startMs, group.frameId);
                store.update(`Bake ${set.name}`, (d) => void bakePoseSet(d, group.id, setId, { fromMs: group.startMs, toMs: group.startMs + group.durationMs }, env));
              }}
            >
              Bake to keys
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem className="text-[12px]" onSelect={() => revealSet(group.id, setId)}>
          Show in Face pad
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
