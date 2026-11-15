"use client";

import { useHoverLink, useLayerHoveredOnStage } from "../stage/hover-link";
import * as React from "react";
import {
  componentFrameOfClip,
  describeLayerDrop,
  frameLayerTree,
  hasLayerChildren,
  isClipInScope,
  isClipLocked,
  isComponentFrame,
  locateClip,
  modeUsesStencil,
  resolveLayerGap,
  resolveLayerInto,
  setClipStencilRole,
  setSwitch,
  documentHasSwitches,
  swapGroupRoles,
  switchShownIds,
  pageOfFrame,
  restackUnits,
  scopeSourceFrameId,
  selectionTopUnits,
  type Clip,
  type Frame,
  type GroupMode,
  type LayerDropPlan,
  type LayerDropRow,
  type LayerTreeNode,
  type LayerUnit,
  type MotionDocument,
} from "@solomotion/core";
import {
  AudioLines,
  Captions,
  ChevronDown,
  ArrowLeftRight,
  ChevronRight,
  Clapperboard,
  Component,
  Contrast,
  CornerDownRight,
  Eye,
  EyeOff,
  Film,
  Frame as FrameIcon,
  Image as ImageIcon,
  Layers2,
  Lock,
  LockOpen,
  PenTool,
  Shapes,
  Type,
} from "lucide-react";
import { createPortal } from "react-dom";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useRevealRow } from "../state/use-reveal-row";
import { useSelectionReveal } from "../state/selection-reveal";
import { cn } from "@/lib/utils";
import { isForeignEvent } from "@/lib/portal-events";
import { RenameInput } from "@/components/ui/rename-input";
import { useDoc, useDocStore } from "../state/document-context";
import { ClipMenuItems, EmptyAreaMenuItems, FrameMenuItems } from "../menus/selection-menu";
import { ReferenceBadge, useIsReferenced } from "../drawing/reference-menu";
import { COMPOSITE_ICONS } from "../ui/composite-icons";
import { clipIcon } from "../ui/clip-icon";
import { PagesSection } from "./PagesSection";
import { audioCollapseId, useSession, type LibraryDrag, useParkedPlayhead } from "../state/session";
import { goToPage } from "../state/frame-nav";
import { toast } from "@/lib/toast";
import { applyLibraryItemToClip, libraryDropTargets } from "../library/apply-to-clip";
import { DRAG_OUT_SURFACE } from "./drag-out";
import { beginHeldDrag } from "../input/hold-to-drag";
import { createSpringLoad, keyUnderPoint } from "../input/spring-load";
import { layerRowDropTarget, useLayersDropTarget } from "./use-layers-drop";
import { revealCompForClip } from "../timeline/timeline-utils";
import { capturePointer } from "../input/capture-pointer";
import { clipLocalClamped } from "../inspector/animatable";

/**
 * The layers list, Figma-style: frames own their layers, groups nest inside,
 * audio sits at the bottom. One pointer-drag moves anything anywhere —
 * reorder z within a frame, drop into another frame or group, restack audio,
 * reorder whole frames. Double-click renames; right-click gets the shared menu.
 *
 * Z-order ↔ tracks: the list drives `restackClips` (core), which gives the
 * moved clip its own carrier track at the exact stack position — so the
 * timeline always mirrors what the list shows.
 */

type Row =
  | { type: "frame"; key: string; frame: Frame; depth: 0 }
  | {
      type: "group";
      key: string;
      groupId: string;
      /** The enclosing group (null at the frame's top level) — drop-exit math. */
      parentId: string | null;
      name: string;
      mode: GroupMode;
      frameId: string;
      memberIds: string[];
      /** The group's own lane (its z in the parent scope). */
      trackIdx: number;
      /** Where a new row becomes the first of its interior — see `GroupLayerNode`. */
      interiorTop: number;
      depth: number;
      /**
       * This group's own composite ROLE inside its parent — true = stencil,
       * false = content, null = its parent has no sides. A nested group is a
       * perfectly good cutter, so it wears the badge like any other member.
       */
      stencil: boolean | null;
      /** True when peeked inside an expanded nested clip (navigate, don't drag). */
      inert: boolean;
    }
  | {
      type: "clip";
      key: string;
      clip: Clip;
      trackIdx: number;
      frameId: string | null;
      groupId: string | null;
      /**
       * COMPOSITE ROLE within the enclosing group — true = stencil (it does the
       * cutting), false = content, null = no sides at this level.
       *
       * A BADGE on the row, never a reordering of the list. The panel used to
       * bucket a composite group's members into "Stencil" and "Content"
       * sections, and that quietly broke everything downstream: rows are the
       * z-order, so sorting them by role made every index in the drop
       * arithmetic point at the wrong lane — which is why dragging a layer out
       * of a mask group did nothing, and why a nested group inside one appeared
       * twice. Figma, Rive and After Effects all keep the mask in the stack and
       * mark it; so do we.
       */
      stencil: boolean | null;
      depth: number;
      /**
       * A layer peeked INSIDE an expanded nested comp. It belongs to that comp's
       * own timeline, so it is not a drag/drop subject here — but it IS an
       * ordinary selection subject (see the click handler): looking at a piece
       * of artwork must not cost you the timeline you are working in.
       */
      inert: boolean;
      /**
       * Does this row open? Derived ONCE from the scope registry
       * (`hasLayerChildren`) rather than re-asked as `kind === "nested"` in the
       * three places that need it — a `flat` comp is one opaque layer here for
       * the same reason it is one everywhere else, and a future enterable kind
       * gets its triangle without touching this file.
       */
      expandable: boolean;
    }
  /** A comp's sound, listed under that comp — audio belongs to a frame like
   *  every other layer, it just has no place in the picture's stack. */
  | { type: "audio-header"; key: string; frameId: string; depth: number };

/** A peeked nested-comp descendant: it is never a drag SUBJECT (it belongs to
 *  another comp's list), but it is a perfectly good drop DESTINATION. */
function rowInert(row: Row): boolean {
  return (row.type === "clip" || row.type === "group") && row.inert;
}

interface EmitCtx {
  doc: MotionDocument;
  collapsed: Set<string>;
  expandedNested: Set<string>;
  rows: Row[];
  /** Frame ids in the current ancestry — a nesting cycle guard. */
  visited: Set<string>;
}

/**
 * Emit one comp's layers (groups, mask sections, clips) into `ctx.rows` by
 * walking the SAME core layer tree the renderer paints (`frameLayerTree`) —
 * what nests here is, by construction, what composites on the canvas. Shared
 * by the top-level page frames AND — recursively — by any EXPANDED nested clip,
 * whose source comp's layers appear as peek children right beneath it (Figma:
 * see inside an instance without leaving the page). `inert` marks those
 * descendants: they belong to the nested comp's OWN timeline, so they can't be
 * dragged/reordered from here — clicking one reveals that comp instead. A
 * `keyPrefix` keeps React keys unique when the same source comp shows under
 * several instances; `visited` guards a comp that (transitively) nests itself.
 */
function emitComp(
  ctx: EmitCtx,
  frameId: string,
  baseDepth: number,
  keyPrefix: string,
  inert: boolean,
): void {
  const { doc, collapsed, rows } = ctx;

  /*
   * ONE WALK, IN PAINT ORDER. Every row is emitted exactly where the layer
   * tree puts it, which is exactly where the renderer composites it — so row
   * index IS z index, at every depth and in every group mode, and the drop
   * arithmetic in `layer-drop.ts` can trust it.
   *
   * `sides` says whether the group we are inside has a stencil/content split,
   * which is all a member needs to know to wear its badge.
   */
  const walk = (nodes: LayerTreeNode[], depth: number, sides: boolean, parentId: string | null): void => {
    for (const node of nodes) {
      const stencil = sides ? !!node.clip.isStencil : null;
      if (node.type === "clip") {
        emitClip(ctx, node.clip, node.trackIndex, frameId, parentId, stencil, depth, keyPrefix, inert);
        continue;
      }
      const g = node.clip;
      rows.push({
        type: "group",
        key: `${keyPrefix}g-${g.id}-${frameId}`,
        groupId: g.id,
        parentId,
        name: g.name,
        mode: g.mode,
        frameId,
        memberIds: node.clipIds,
        trackIdx: node.trackIndex,
        interiorTop: node.interiorTop,
        depth,
        stencil,
        inert,
      });
      if (collapsed.has(g.id)) continue;
      walk(node.children, depth + 1, modeUsesStencil(g.mode), g.id);
    }
  };

  walk(frameLayerTree(doc, frameId), baseDepth, false, null);
}

/** One clip row, plus (for an EXPANDED nested clip) its source comp's children. */
function emitClip(
  ctx: EmitCtx,
  clip: Clip,
  trackIdx: number,
  frameId: string | null,
  groupId: string | null,
  stencil: boolean | null,
  depth: number,
  keyPrefix: string,
  inert: boolean,
): void {
  const key = `${keyPrefix}${clip.id}`;
  const expandable = hasLayerChildren(ctx.doc, clip);
  ctx.rows.push({ type: "clip", key, clip, trackIdx, frameId, groupId, stencil, depth, inert, expandable });
  // A comp with an inside stays ONE row; its layers show only while expanded —
  // which is also what keeps a 200-layer icon pack cheap, since nothing recurses
  // until the user opens it. Cycle- and existence-guarded so a missing or
  // self-referential source never loops or renders a dead subtree.
  if (!expandable || !ctx.expandedNested.has(clip.id)) return;
  const src = scopeSourceFrameId(ctx.doc, clip);
  if (!src || ctx.visited.has(src) || !ctx.doc.frames.some((f) => f.id === src)) return;
  ctx.visited.add(src);
  emitComp(ctx, src, depth + 1, `${key}/`, true);
  ctx.visited.delete(src);
}

function buildRows(
  doc: MotionDocument,
  collapsed: Set<string>,
  expandedNested: Set<string>,
  pageId: string,
): Row[] {
  const ctx: EmitCtx = { doc, collapsed, expandedNested, rows: [], visited: new Set() };
  const { rows } = ctx;

  for (const frame of doc.frames) {
    if (pageOfFrame(doc, frame) !== pageId) continue;
    rows.push({ type: "frame", key: `f-${frame.id}`, frame, depth: 0 });
    if (collapsed.has(frame.id)) continue;
    ctx.visited.add(frame.id);
    emitComp(ctx, frame.id, 1, "", false);
    emitAudio(ctx, frame.id, 1);
    ctx.visited.delete(frame.id);
  }

  return rows;
}

/**
 * One comp's SOUND, as an "Audio" section closing that comp's list. Audio has
 * no place in the picture's stack, but it belongs to a comp exactly as a
 * picture layer does — it plays when that comp plays and moves when it is
 * nested — so it is listed there, not in a document-wide bin. Nested comps'
 * audio shows under the nested comp, the same as its pictures.
 */
function emitAudio(ctx: EmitCtx, frameId: string, depth: number): void {
  const audio: Array<{ clip: Clip; trackIdx: number }> = [];
  ctx.doc.tracks.forEach((track, trackIdx) => {
    for (const clip of track.clips) if (clip.kind === "audio" && clip.frameId === frameId) audio.push({ clip, trackIdx });
  });
  if (audio.length === 0) return;
  ctx.rows.push({ type: "audio-header", key: `a-${frameId}`, frameId, depth });
  if (ctx.collapsed.has(audioCollapseId(frameId))) return;
  for (const a of audio) {
    ctx.rows.push({
      type: "clip",
      key: a.clip.id,
      clip: a.clip,
      trackIdx: a.trackIdx,
      frameId,
      groupId: null,
      stencil: null,
      depth: depth + 1,
      inert: false,
      expandable: false,
    });
  }
}

/**
 * Rows rooted at ONE comp — the layers panel's "This frame" scope. The exact
 * same emit machinery as the full tree (groups, mask sections, expandable
 * nested peeks), just rooted at the navigation context instead of the page:
 * a drawing shows its paint layers, a flipbook shows its cells (expand any
 * cell to peek its layers), a nested comp shows its content. Breadcrumb and
 * list stay ONE system because the root IS the breadcrumb tail.
 */
function buildContextRows(
  doc: MotionDocument,
  collapsed: Set<string>,
  expandedNested: Set<string>,
  rootFrameId: string,
): Row[] {
  const ctx: EmitCtx = { doc, collapsed, expandedNested, rows: [], visited: new Set() };
  ctx.visited.add(rootFrameId);
  emitComp(ctx, rootFrameId, 0, "", false);
  emitAudio(ctx, rootFrameId, 0);
  return ctx.rows;
}

/** The layers panel's scope: the whole document, or the open comp only. */
export type LayersScope = "all" | "context";

const LAYERS_SCOPE_KEY = "tm-layers-scope";

/** Remembered scope per context flavor (FBF comps default to "This frame"). */
function loadScope(mode: string | undefined): LayersScope {
  const bucket = mode === "static" || mode === "flipbook" ? "fbf" : "std";
  try {
    const raw = window.localStorage.getItem(`${LAYERS_SCOPE_KEY}-${bucket}`);
    if (raw === "all" || raw === "context") return raw;
  } catch {
    // Private mode etc.
  }
  return bucket === "fbf" ? "context" : "all";
}

function saveScope(mode: string | undefined, scope: LayersScope): void {
  const bucket = mode === "static" || mode === "flipbook" ? "fbf" : "std";
  try {
    window.localStorage.setItem(`${LAYERS_SCOPE_KEY}-${bucket}`, scope);
  } catch {
    // Private mode etc.
  }
}

interface DragState {
  kind: "clips" | "frame";
  /**
   * What actually moves, in list z-order: loose clips and WHOLE groups. A
   * group unit travels intact — subgroups, composite mode, mask roles — via
   * the one structure-preserving core op (`restackUnits`); dragging a union
   * out of its parent can never dissolve anything.
   */
  units: LayerUnit[];
  /** Every clip id riding the drag (ghost label, audio routing). */
  clipIds: string[];
  audio: boolean;
  frameId?: string;
  label: string;
}

/**
 * A resolved drop, ready to draw and ready to commit. The `plan` is core's —
 * the preview and the edit are the SAME object, so the insertion line can never
 * promise a placement the drop does not make.
 */
type DropTarget =
  | { type: "gap"; index: number; y: number; indent: number; plan?: LayerDropPlan }
  | { type: "into"; rowKey: string; plan: LayerDropPlan };

type MenuTarget = { type: "empty" } | { type: "clip" } | { type: "frame"; frameId: string };

export function LayersPanel() {
  const doc = useDoc();
  const store = useDocStore();
  // SESSION state, shared with the timeline — see `collapsedIds`. A group you
  // open in one view is open in the other, because there is only one answer.
  const collapsedList = useSession((s) => s.collapsedIds);
  const collapsed = React.useMemo(() => new Set(collapsedList), [collapsedList]);
  // Which nested comps are peeked open. SESSION state, not the panel's: other
  // surfaces ask for a comp to be revealed (opening an SVG for editing expands
  // it instead of navigating into it), and a triangle only this component could
  // flip made that impossible. Absent = collapsed, so peeking stays opt-in.
  const expandedIds = useSession((s) => s.expandedNested);
  const expandedNested = React.useMemo(() => new Set(expandedIds), [expandedIds]);
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [ghost, setGhost] = React.useState<{
    x: number;
    y: number;
    label: string;
    /** Where it will land, in words — `describeLayerDrop`. Null = nowhere. */
    dest: string | null;
  } | null>(null);
  const [target, setTarget] = React.useState<DropTarget | null>(null);
  const [menuTarget, setMenuTarget] = React.useState<MenuTarget>({ type: "empty" });
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const selectedClipIds = useSession((s) => s.selectedClipIds);
  const selectedFrameIds = useSession((s) => s.selectedFrameIds);
  const contentRef = React.useRef<HTMLDivElement>(null);
  // Anchor for ⇧-range selection (Finder/Figma: ⇧-click fills every clip
  // between the anchor and the clicked row).
  const anchorRef = React.useRef<string | null>(null);
  const [marquee, setMarquee] = React.useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // The row a library drag would land on right now — same resolver the drop
  // below runs, so the ring and the edit can never disagree.
  const libraryDropId = useLayersDropTarget();

  const activePageId = useSession((s) => s.activePageId);
  const activeFrameId = useSession((s) => s.activeFrameId);
  const contextFrame = doc.frames.find((f) => f.id === activeFrameId) ?? null;
  // Scope: the whole document vs the open comp only ("This frame" — the
  // breadcrumb-linked view drawing/flipbook work lives in). Remembered per
  // context flavor; FBF comps open scoped by default.
  const [scope, setScopeState] = React.useState<LayersScope>(() => loadScope(contextFrame?.mode));
  const roleBucket = contextFrame?.mode === "static" || contextFrame?.mode === "flipbook" ? "fbf" : "std";
  React.useEffect(() => {
    setScopeState(loadScope(contextFrame?.mode));
    // Re-resolve the remembered scope whenever the context flavor flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleBucket]);
  const setScope = (v: LayersScope) => {
    setScopeState(v);
    saveScope(contextFrame?.mode, v);
  };
  const scoped = scope === "context" && contextFrame != null;
  const rows = scoped
    ? buildContextRows(doc, collapsed, expandedNested, contextFrame.id)
    : buildRows(doc, collapsed, expandedNested, activePageId ?? doc.pages[0]!.id);

  /*
   * REVEAL WHAT IS FOCUSED. The panel is a list of a hundred rows in a column
   * six of them tall, and everything else in the editor can change which one
   * matters: clicking a layer on the canvas, drilling into a flipbook cell,
   * an undo, a keyboard step. Opening the panel afterwards showed whatever
   * scroll position an older selection had left behind.
   *
   * The PRIMARY selection (the last id — the same "primary is last" rule the
   * frame selection and the inspector already use) is the row to be looking at.
   */
  const primaryKey =
    rows.find((r) => r.type === "clip" && r.clip.id === selectedClipIds[selectedClipIds.length - 1])?.key ??
    rows.find((r) => r.type === "frame" && r.frame.id === selectedFrameIds[selectedFrameIds.length - 1])?.key ??
    null;
  // The settled reveal re-asks even when the key is unchanged — a link to the
  // layer that is already selected, with the list scrolled away from it.
  const revealSeq = useSelectionReveal((s) => s.reveal.seq);
  useRevealRow(scrollRef, primaryKey, { seq: revealSeq });

  // Combined lock (track OR clip), same brain as the timeline/stage — a
  // locked layer's row can't be selected or dragged, only unlocked via
  // right-click (which still targets it, same as everywhere else).
  const isRowLocked = (clipId: string): boolean => {
    const loc = locateClip(doc, clipId);
    return !!loc && isClipLocked(loc.track, loc.clip);
  };

  const toggleCollapse = (id: string) => useSession.getState().toggleCollapsed(id);

  const toggleNestedExpanded = (id: string) => useSession.getState().toggleNestedExpanded(id);

  // ── Drop-target math (over the captured rows; the doc is static mid-drag) ──

  const rowEls = () =>
    contentRef.current
      ? [...contentRef.current.querySelectorAll<HTMLElement>("[data-row-idx]")]
      : [];

  /**
   * The rows, as the DROP ENGINE sees them — a straight projection, no logic.
   *
   * Everything about what a gap MEANS lives in core (`layer-drop.ts`): which
   * comp, which group, which composite side, which lane. This panel measures
   * (which gap is nearest, how far right is the pointer) and draws. That split
   * is why dragging out of a mask group works at all — the arithmetic used to
   * be interleaved with DOM measurement here and was re-derived, differently,
   * for each kind of row.
   */
  const dropRows: LayerDropRow[] = React.useMemo(
    () =>
      rows.map((row) => ({
        key: row.key,
        kind:
          row.type === "frame"
            ? ("frame" as const)
            : row.type === "group"
              ? ("group" as const)
              : row.type === "audio-header"
                ? ("audio-header" as const)
                : ("clip" as const),
        frameId: row.type === "frame" ? row.frame.id : row.frameId,
        parentGroupId:
          row.type === "group" ? row.parentId : row.type === "clip" ? row.groupId : null,
        groupId: row.type === "group" ? row.groupId : null,
        depth: row.depth,
        trackIndex: row.type === "clip" || row.type === "group" ? row.trackIdx : 0,
        interiorTop: row.type === "group" ? row.interiorTop : row.type === "clip" ? row.trackIdx : 0,
        collapsed:
          row.type === "group"
            ? collapsed.has(row.groupId)
            : row.type === "frame"
              ? collapsed.has(row.frame.id)
              : row.type === "audio-header"
                ? collapsed.has(audioCollapseId(row.frameId))
                : false,
        inert: rowInert(row),
        audio: row.type === "clip" && row.clip.kind === "audio",
      })),
    [rows, collapsed],
  );

  /** A row's composite side, for the "land beside what you dropped next to" rule. */
  const stencilFor = React.useCallback(
    (key: string) => {
      const row = rows.find((r) => r.key === key);
      if (!row) return null;
      return row.type === "clip" || row.type === "group" ? row.stencil : null;
    },
    [rows],
  );

  /** Is this gap in the same MEDIUM as the drag? Audio and picture never mix. */
  const gapAllowed = (gapIdx: number, drag: DragState): boolean => {
    if (drag.kind === "frame") {
      const below = rows[gapIdx];
      return below === undefined || below.type === "frame";
    }
    for (let i = gapIdx - 1; i >= 0; i--) {
      const r = rows[i]!;
      if (r.type === "audio-header") return drag.audio;
      if (r.type === "frame") return !drag.audio;
    }
    return false;
  };

  const computeTarget = (clientX: number, clientY: number, drag: DragState): DropTarget | null => {
    const els = rowEls();
    if (els.length === 0) return null;

    // "Into" a container row (middle band) beats gap placement — the one
    // reading that needs no aiming.
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      if (clientY < rect.top || clientY > rect.bottom) continue;
      const idx = Number(el.dataset.rowIdx);
      const row = rows[idx];
      if (!row) break;
      const band = clientY > rect.top + rect.height * 0.3 && clientY < rect.bottom - rect.height * 0.3;
      if (band && drag.kind === "clips") {
        const plan = resolveLayerInto(doc, dropRows, row.key, drag.units, drag.audio);
        if (plan) return { type: "into", rowKey: row.key, plan };
      }
      break;
    }

    // …otherwise the nearest gap, and the pointer's X decides what it means.
    let bestIdx = -1;
    let bestY = 0;
    let bestDist = Infinity;
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      const idx = Number(el.dataset.rowIdx);
      if (!rows[idx]) continue;
      const consider = (gapIdx: number, y: number, top: number) => {
        if (!gapAllowed(gapIdx, drag)) return;
        const dist = Math.abs(clientY - y);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = gapIdx;
          bestY = top;
        }
      };
      consider(idx, rect.top, el.offsetTop);
      if (idx === els.length - 1) consider(idx + 1, rect.bottom, el.offsetTop + el.offsetHeight);
    }
    if (bestIdx === -1) return null;

    if (drag.kind === "frame") {
      const below = rows[bestIdx];
      return { type: "gap", index: bestIdx, y: bestY, indent: (below?.depth ?? 0) * INDENT_PX + 8 };
    }

    const contentLeft = contentRef.current?.getBoundingClientRect().left ?? 0;
    const plan = resolveLayerGap(
      doc,
      dropRows,
      {
        gapIndex: bestIdx,
        pointerDepth: (clientX - contentLeft - 10) / 12,
        units: drag.units,
        audio: drag.audio,
      },
      stencilFor,
    );
    if (!plan) return null;
    return { type: "gap", index: bestIdx, y: bestY, indent: plan.depth * INDENT_PX + 8, plan };
  };

  /** Commit a resolved drop through the one structure-preserving core op. */
  const applyDrop = (drag: DragState, t: DropTarget) => {
    if (drag.kind === "frame") {
      if (t.type !== "gap") return;
      const below = rows[t.index];
      const beforeFrameId = below?.type === "frame" ? below.frame.id : null;
      store.update("Reorder frames", (d) => {
        const from = d.frames.findIndex((f) => f.id === drag.frameId);
        if (from === -1) return;
        const [frame] = d.frames.splice(from, 1);
        const to = beforeFrameId ? d.frames.findIndex((f) => f.id === beforeFrameId) : d.frames.length;
        d.frames.splice(to === -1 ? d.frames.length : to, 0, frame!);
      });
      return;
    }
    if (!t.plan) return;
    const target = t.plan.target;
    store.update("Move layer", (d) => restackUnits(d, drag.units, target));
  };

  /**
   * WHAT A HELD DRAG OPENS — the spring-load dispatcher.
   *
   * One vocabulary of keys, so any surface can join by tagging a row with
   * `data-spring-load` and nothing here has to learn about it twice. A page
   * NAVIGATES rather than expanding, which is the same promise in that row's
   * own terms: hold over it and you end up looking at what is inside.
   */
  const openSpringTarget = React.useCallback((key: string) => {
    const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    const session = useSession.getState();
    if (kind === "page") {
      if (session.activePageId !== id) goToPage(store.getState(), id);
      return;
    }
    if (kind === "nested") {
      session.setNestedExpanded(id, true);
      return;
    }
    // frame / group / audio: a collapse id, all in the one shared set.
    if (session.collapsedIds.includes(id)) session.toggleCollapsed(id);
  }, []);

  // ── The one drag controller ────────────────────────────────────────────────

  const startDrag = (e: React.PointerEvent, row: Row) => {
    if (e.button !== 0 || renaming) return;
    // Same idiom as every other drag surface in the editor (toolbar dock,
    // stage, timeline, flipbook sheet): preventDefault kills iOS's long-press
    // → contextmenu/callout synthesis, which otherwise races this row's
    // ContextMenuTrigger ancestor and wins before a touch drag ever starts.
    // setPointerCapture keeps the drag alive no matter what's physically
    // under the finger mid-drag.
    e.preventDefault();
    capturePointer((e.currentTarget as HTMLElement), e.pointerId);
    /*
     * A row reorders, and the list it sits in scrolls. Both want a one-finger
     * drag, so the scope decides: a swipe belongs to the list, a brief hold
     * hands the row over. The rows used to wear `touch-none`, which answered
     * the question the other way at hit-test time and left the layers panel
     * with no touch scroll at all — the controls ARE the panel.
     */
    const arm = beginHeldDrag(e, { axis: "both" });
    const spring = createSpringLoad(openSpringTarget);
    let drag: DragState | null = null;

    const makeDragState = (): DragState | null => {
      // Peeked nested children live in another comp's timeline — never drag them
      // from the parent tree; a plain click enters their comp instead.
      if (rowInert(row)) return null;
      if (row.type === "frame") {
        return { kind: "frame", units: [], clipIds: [], audio: false, frameId: row.frame.id, label: row.frame.name };
      }
      if (row.type === "group") {
        // The GROUP is the unit — it moves whole, structure intact.
        return {
          kind: "clips",
          units: [{ kind: "group", id: row.groupId }],
          clipIds: row.memberIds,
          audio: false,
          label: row.name,
        };
      }
      if (row.type === "clip") {
        if (isRowLocked(row.clip.id)) return null;
        const selected = useSession.getState().selectedClipIds;
        const isAudio = row.clip.kind === "audio";
        if (selected.includes(row.clip.id) && selected.length > 1) {
          // Move the whole selection (same medium only), in list z-order —
          // locked members never join the drag, same as any other surface.
          const ordered = rows
            .filter(
              (r): r is Extract<Row, { type: "clip" }> =>
                r.type === "clip" &&
                selected.includes(r.clip.id) &&
                (r.clip.kind === "audio") === isAudio &&
                !isRowLocked(r.clip.id) &&
                !r.inert,
            )
            .map((r) => r.clip.id);
          if (isAudio) {
            return {
              kind: "clips",
              units: ordered.map((id) => ({ kind: "clip" as const, id })),
              clipIds: ordered,
              audio: true,
              label: `${ordered.length} layers`,
            };
          }
          // Whole groups inside the selection travel as GROUP units (subgroups,
          // modes and mask roles ride along); the rest go as loose clips —
          // ONE partition rule, shared with ⌘G (core selectionTopUnits).
          const parts = selectionTopUnits(doc, ordered);
          const unitGroups = new Set(parts.groups);
          const unitClips = new Set(parts.clips);
          const units: LayerUnit[] = [];
          for (const r of rows) {
            if (r.type === "group" && !r.inert && unitGroups.has(r.groupId)) units.push({ kind: "group", id: r.groupId });
            else if (r.type === "clip" && !r.inert && unitClips.has(r.clip.id)) units.push({ kind: "clip", id: r.clip.id });
          }
          return {
            kind: "clips",
            units,
            clipIds: ordered,
            audio: false,
            label: `${units.length === 1 ? "1 layer" : `${units.length} layers`}`,
          };
        }
        return {
          kind: "clips",
          units: [{ kind: "clip", id: row.clip.id }],
          clipIds: [row.clip.id],
          audio: isAudio,
          label: row.clip.name,
        };
      }
      return null;
    };

    const onMove = (ev: PointerEvent) => {
      if (!drag) {
        if (!arm.update(ev.clientX, ev.clientY)) return;
        drag = makeDragState();
        if (!drag) return;
      }
      const t = computeTarget(ev.clientX, ev.clientY, drag);
      setTarget(t);
      setGhost({
        x: ev.clientX,
        y: ev.clientY,
        label: drag.label,
        // The destination in words, from the SAME plan that will commit — so
        // the caption can never describe a drop the release does not make.
        dest: t?.plan ? describeLayerDrop(doc, t.plan) : t?.type === "gap" ? "Reorder" : null,
      });
      // HOLD OVER SOMETHING SHUT AND IT OPENS — see `spring-load.ts`. Reads the
      // DOM, so it reaches the Pages list above this panel too without either
      // component knowing about the other.
      spring.hover(keyUnderPoint(ev.clientX, ev.clientY));
      // Auto-scroll near the edges.
      const sc = scrollRef.current;
      if (sc) {
        const rect = sc.getBoundingClientRect();
        if (ev.clientY < rect.top + 24) sc.scrollTop -= 10;
        else if (ev.clientY > rect.bottom - 24) sc.scrollTop += 10;
      }
    };
    const cleanup = () => {
      arm.end();
      spring.end();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      setGhost(null);
      setTarget(null);
    };
    const onCancel = () => cleanup();
    const onUp = (ev: PointerEvent) => {
      cleanup();
      if (!drag) {
        // A swipe the list took is not a click, so it selects nothing.
        if (arm.abandoned()) return;
        // Plain click — select.
        const session = useSession.getState();
        if (rowInert(row)) {
          // A layer peeked inside an expanded comp. Clicking it used to ENTER
          // that comp — which re-scoped the timeline, moved the playhead and
          // dropped the breadcrumb, so glancing at a piece of artwork cost you
          // your place. It is now an ordinary selection: the inspector, the
          // gizmo and the colours all resolve a clip's frame FROM THE CLIP
          // (`resolveClipContext`), so nothing has to move for it to be
          // understood. Drilling stays the explicit gesture it always was.
          // A GROUP row selects the group CLIP — one layer, one id, exactly what
          // clicking its bar on the timeline does. It used to select every
          // member instead, which was the only thing it could do back when a
          // group had no id you could point at; the cost was that the inspector
          // showed "N layers" for a thing that is one layer, and a fill you set
          // on it went to the children. A role SECTION is not a layer, so it
          // still stands for the clips it buckets.
          const ids = row.type === "clip" ? [row.clip.id] : row.type === "group" ? [row.groupId] : [];
          if (ids.length === 0 || (row.type === "clip" && isRowLocked(row.clip.id))) return;
          // The one case that still reveals: a subtree the open timeline cannot
          // see at all (another page frame's peek in "Page" scope). Selecting
          // something invisible would be a selection you cannot act on.
          if (!isClipInScope(doc, session.nav.path, ids[0]!)) revealCompForClip(doc, ids[0]!);
          session.select(ids, ev.metaKey || ev.ctrlKey);
          if (row.type === "clip") anchorRef.current = row.clip.id;
          return;
        }
        if (row.type === "frame") session.selectFrames([row.frame.id], ev.shiftKey);
        else if (row.type === "group") session.select([row.groupId]);
        else if (row.type === "clip") {
          if (isRowLocked(row.clip.id)) return;
          const clipRows = rows.filter((r): r is Extract<Row, { type: "clip" }> => r.type === "clip");
          const clicked = clipRows.findIndex((r) => r.clip.id === row.clip.id);
          const anchorIdx = anchorRef.current
            ? clipRows.findIndex((r) => r.clip.id === anchorRef.current)
            : -1;
          if (ev.shiftKey && anchorIdx >= 0) {
            // Range: every clip between the anchor and the click (anchor kept).
            const [lo, hi] = anchorIdx < clicked ? [anchorIdx, clicked] : [clicked, anchorIdx];
            session.select(clipRows.slice(lo, hi + 1).map((r) => r.clip.id));
          } else if (ev.metaKey || ev.ctrlKey) {
            session.select([row.clip.id], true); // ⌘/Ctrl toggles one
            anchorRef.current = row.clip.id;
          } else {
            session.select([row.clip.id]);
            anchorRef.current = row.clip.id;
          }
        }
        return;
      }
      const t = computeTarget(ev.clientX, ev.clientY, drag);
      if (t) applyDrop(drag, t);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  // ── Marquee: drag a rectangle over empty list space to multi-select ─────────
  const startMarquee = (e: React.PointerEvent) => {
    if (e.button !== 0 || renaming) return;
    // Only from empty space — a press on a row starts a drag/select instead.
    if ((e.target as HTMLElement).closest("[data-row-idx]")) return;
    const sc = scrollRef.current;
    if (!sc) return;
    const base = e.shiftKey ? useSession.getState().selectedClipIds : [];
    if (!e.shiftKey) useSession.getState().clearSelection();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dragging = false;
    const onMove = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      dragging = true;
      setMarquee({ x0, y0, x1: ev.clientX, y1: ev.clientY });
      const lo = Math.min(y0, ev.clientY);
      const hi = Math.max(y0, ev.clientY);
      const hits: string[] = [];
      for (const el of sc.querySelectorAll<HTMLElement>("[data-row-idx]")) {
        const r = rows[Number(el.dataset.rowIdx)];
        if (r?.type !== "clip" || r.inert || isRowLocked(r.clip.id)) continue;
        const b = el.getBoundingClientRect();
        if (b.bottom >= lo && b.top <= hi) hits.push(r.clip.id);
      }
      useSession.getState().select([...new Set([...base, ...hits])]);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setMarquee(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ── Library drops ──────────────────────────────────────────────────────────

  const listRef = React.useRef<HTMLDivElement | null>(null);

  /**
   * A preset released over the tree applies to the row under the cursor. The
   * tree has no time axis, so an animation lands on the layer as a whole (its
   * in-edge) — the timeline is where you choose in vs out, and it says so by
   * previewing the half you are aiming at.
   */
  React.useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onDrop = (e: Event) => {
      const { clientX, clientY, drag } = (
        e as CustomEvent<{ clientX: number; clientY: number; drag: LibraryDrag }>
      ).detail;
      if (!drag) return;
      const clipId = layerRowDropTarget(store.getState(), drag, clientX, clientY);
      if (!clipId) {
        toast(
          drag.kind === "transition"
            ? "Transitions drop on a cut in the timeline"
            : `${drag.label} can't apply to that layer`,
        );
        return;
      }
      const targets = libraryDropTargets(clipId, useSession.getState().selectedClipIds);
      applyLibraryItemToClip(store, drag, targets);
      useSession.getState().select([...targets]);
      toast(`${drag.label} applied`);
    };
    el.addEventListener("tm-library-drop", onDrop);
    return () => el.removeEventListener("tm-library-drop", onDrop);
  }, [store]);

  // ── Right-click targeting ──────────────────────────────────────────────────

  const onContextMenuCapture = (e: React.MouseEvent) => {
    // Portalled floating layers are React descendants of this list — a
    // right-click in a popover must not re-target the SELECTION (see
    // lib/portal-events).
    if (isForeignEvent(listRef.current, e)) return;
    const el = (e.target as HTMLElement).closest("[data-row-idx]");
    const row = el ? rows[Number((el as HTMLElement).dataset.rowIdx)] : undefined;
    const session = useSession.getState();
    if (!row) {
      setMenuTarget({ type: "empty" });
      return;
    }
    if (row.type === "frame") {
      session.selectFrame(row.frame.id);
      setMenuTarget({ type: "frame", frameId: row.frame.id });
    } else if (row.type === "group") {
      session.select([row.groupId]);
      setMenuTarget({ type: "clip" });
    } else if (row.type === "clip") {
      if (!session.selectedClipIds.includes(row.clip.id)) session.select([row.clip.id]);
      setMenuTarget({ type: "clip" });
    } else {
      setMenuTarget({ type: "empty" });
    }
  };

  const rename = (row: Row, name: string) => {
    const trimmed = name.trim();
    setRenaming(null);
    if (!trimmed) return;
    store.update("Rename", (d) => {
      if (row.type === "frame") {
        const f = d.frames.find((x) => x.id === row.frame.id);
        if (f) f.name = trimmed;
      } else if (row.type === "group") {
        // A group is a clip, so renaming one is renaming a clip.
        const g = locateClip(d, row.groupId)?.clip;
        if (g) g.name = trimmed;
      } else if (row.type === "clip") {
        for (const track of d.tracks) {
          const c = track.clips.find((x) => x.id === row.clip.id);
          if (c) c.name = trimmed;
        }
      }
    });
  };

  return (
    <div data-layers-panel className="flex h-full min-h-0 flex-col">
      {/* Pages are always reachable — never hidden by the layer SCOPE (a
          flipbook/drawing opens scoped to "This frame", which used to swallow
          the whole Pages section). */}
      <PagesSection doc={doc} />
      {contextFrame && (
        <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
          <div className="flex overflow-hidden rounded-md border">
            {(["all", "context"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setScope(v)}
                className={cn(
                  "px-2 py-0.5 text-[10px] transition-colors",
                  scope === v ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {v === "all" ? "All" : "This frame"}
              </button>
            ))}
          </div>
          {scoped && (
            <span className="min-w-0 flex-1 truncate text-right text-[10px] text-muted-foreground">
              {contextFrame.name}
            </span>
          )}
        </div>
      )}
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* The trigger keeps the pointer handlers; the ScrollArea inside owns
            the scrolling. Making the ScrollArea itself the trigger would put
            the marquee's pointerdown on the Root rather than the viewport, so
            a drag would start from the wrong coordinate space. */}
        <div
          ref={listRef}
          data-layers-drop
          className="flex min-h-0 flex-1 flex-col"
          onContextMenuCapture={onContextMenuCapture}
          onPointerDown={startMarquee}
        >
          {/* `touch-action` belongs on the VIEWPORT, not on each row: it
              resolves up the ancestor chain, so one declaration covers every
              row and the next one nobody has written yet. */}
          <ScrollArea
            viewportRef={scrollRef}
            className="min-h-0 flex-1"
            viewportClassName={DRAG_OUT_SURFACE}
          >
          <div ref={contentRef} className="relative p-1.5">
            {rows.length === 0 && (
              <p className="px-2 py-3 text-[10px] leading-relaxed text-muted-foreground">
                {scoped
                  ? "Nothing here yet — pick the brush (B) and paint."
                  : "No layers yet — draw a frame (F) and add text (T)."}
              </p>
            )}
            {rows.map((row, i) => (
              <LayerNodeRow
                key={row.key}
                row={row}
                index={i}
                dropInto={
                  (target?.type === "into" && target.rowKey === row.key) ||
                  (row.type === "clip" && row.clip.id === libraryDropId)
                }
                collapsed={
                  row.type === "frame"
                    ? collapsed.has(row.frame.id)
                    : row.type === "group"
                      ? collapsed.has(row.groupId)
                      : row.type === "clip" && row.expandable
                        ? !expandedNested.has(row.clip.id)
                        : row.type === "audio-header"
                          ? collapsed.has(audioCollapseId(row.frameId))
                          : false
                }
                renaming={renaming === row.key}
                onToggleCollapse={() =>
                  row.type === "clip" && row.expandable
                    ? toggleNestedExpanded(row.clip.id)
                    : toggleCollapse(
                        row.type === "frame"
                          ? row.frame.id
                          : row.type === "group"
                            ? row.groupId
                            : row.type === "audio-header"
                              ? audioCollapseId(row.frameId)
                              : "",
                      )
                }
                onStartDrag={(e) => startDrag(e, row)}
                onStartRename={() => setRenaming(row.key)}
                onRename={(name) => rename(row, name)}
              />
            ))}
            {/* WHERE IT LANDS. The line starts at the indent of the resolved
                placement, not of the row above — so sliding the pointer left
                and right visibly steps the layer out through each enclosing
                group before you commit to one. The cap marks the depth the
                line is claiming, which is the part a bare rule cannot say. */}
            {target?.type === "gap" && (
              <div
                className="pointer-events-none absolute right-1 z-10 flex h-0 items-center"
                style={{ top: target.y - 1, left: target.indent }}
              >
                <span className="size-1.5 shrink-0 rounded-full bg-primary ring-2 ring-primary/25" />
                <span className="h-0.5 flex-1 rounded-full bg-primary" />
              </div>
            )}
          </div>
          </ScrollArea>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menuTarget.type === "clip" && <ClipMenuItems store={store} />}
        {menuTarget.type === "frame" && <FrameMenuItems store={store} frameId={menuTarget.frameId} />}
        {menuTarget.type === "empty" && <EmptyAreaMenuItems store={store} />}
      </ContextMenuContent>
      {ghost &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 flex items-center gap-1.5 rounded-md border bg-popover px-2 py-1 text-xs shadow-md"
            style={{ left: ghost.x + 10, top: ghost.y + 6 }}
          >
            <span className="max-w-40 truncate">{ghost.label}</span>
            {/* The destination, said plainly. A drag across a deep list is the
                one moment the app knows something the user cannot see, and a
                line on its own does not say "inside the Union". */}
            {ghost.dest ? (
              <>
                <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="max-w-40 truncate text-muted-foreground">{ghost.dest}</span>
              </>
            ) : (
              <span className="text-muted-foreground/70">—</span>
            )}
          </div>,
          document.body,
        )}
      {marquee &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 rounded-sm border border-primary/70 bg-primary/15"
            style={{
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0),
            }}
          />,
          document.body,
        )}
    </ContextMenu>
    </div>
  );
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function LayerNodeRow({
  row,
  index,
  dropInto,
  collapsed,
  renaming,
  onToggleCollapse,
  onStartDrag,
  onStartRename,
  onRename,
}: {
  row: Row;
  index: number;
  dropInto: boolean;
  collapsed: boolean;
  renaming: boolean;
  onToggleCollapse: () => void;
  onStartDrag: (e: React.PointerEvent) => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
}) {
  const store = useDocStore();
  const doc = useDoc();
  const selectedClipIds = useSession((s) => s.selectedClipIds);
  const selectedFrameIds = useSession((s) => s.selectedFrameIds);

  // Combined lock/hidden (track OR clip) drives whether the row can be
  // selected/dragged at all; the icon buttons themselves toggle only the
  // CLIP's own flag (a track-locked/hidden row stays that way regardless —
  // same "track wins" rule as everywhere else).
  const loc = row.type === "clip" ? locateClip(doc, row.clip.id) : null;
  const rowLocked = !!loc && isClipLocked(loc.track, loc.clip);
  const rowHidden = !!loc && (loc.track.hidden || loc.clip.hidden);
  // Peeked nested-comp children: shown to navigate, not to edit in place.
  const inert = rowInert(row);
  // The composite side this row is on, when its parent group has sides.
  const stencil = row.type === "clip" || row.type === "group" ? row.stencil : null;

  // What a held drag over this row opens — see `openSpringTarget`.
  const springKey =
    row.type === "frame"
      ? `frame:${row.frame.id}`
      : row.type === "group"
        ? `group:${row.groupId}`
        : row.type === "audio-header"
          ? `audio:${audioCollapseId(row.frameId)}`
          : row.type === "clip" && row.expandable
            ? `nested:${row.clip.id}`
            : null;

  const toggleClipLocked = () => {
    if (row.type !== "clip") return;
    store.update(row.clip.locked ? "Unlock layer" : "Lock layer", (d) => {
      const l = locateClip(d, row.clip.id);
      if (l) l.clip.locked = !l.clip.locked;
    });
  };
  const toggleClipHidden = () => {
    if (row.type !== "clip") return;
    store.update(row.clip.hidden ? "Show layer" : "Hide layer", (d) => {
      const l = locateClip(d, row.clip.id);
      if (l) l.clip.hidden = !l.clip.hidden;
    });
  };

  // The paint tools' reference. Selected as a boolean (see `useIsReferenced`)
  // so a panel of a hundred rows does not re-render for a badge on one of them.
  const referenced = useIsReferenced(row.type === "clip" ? { kind: "clip", id: row.clip.id } : null);
  // Shared hover (D20): this row's layer, hovered on the stage, lights the row;
  // hovering the row outlines the layer there. One boolean per row.
  const hoverId = row.type === "clip" ? row.clip.id : row.type === "group" ? row.groupId : null;
  const stageHovered = useLayerHoveredOnStage(hoverId);

  const selected =
    row.type === "frame"
      ? selectedFrameIds.includes(row.frame.id)
      : row.type === "group"
        ? selectedClipIds.includes(row.groupId)
        : row.type === "clip"
          ? selectedClipIds.includes(row.clip.id)
          : false;

  const name =
    row.type === "frame"
      ? row.frame.name
      : row.type === "group"
        ? row.name
        : row.type === "clip"
          ? row.clip.name
          : "Audio";

  const chevron =
    row.type === "frame" ||
    row.type === "group" ||
    row.type === "audio-header" ||
    (row.type === "clip" && row.expandable);

  return (
    <div
      data-row-idx={index}
      data-row-key={row.key}
      {...(row.type === "clip" ? { "data-clip-drop-id": row.clip.id } : {})}
      /* Frames and groups are pick targets too (the pick mode reads this). */
      {...(row.type === "frame" ? { "data-pick-key": `frame:${row.frame.id}` } : row.type === "group" ? { "data-pick-key": `clip:${row.groupId}` } : {})}
      /* HOLD A DRAG HERE AND IT OPENS. One attribute; the drag controller reads
         it off the DOM (`spring-load.ts`) so a row opts in without the drag
         needing to know that its kind exists. Only shut things are offered —
         an already-open row has nothing to spring. */
      {...(collapsed && springKey ? { "data-spring-load": springKey } : {})}
      className={cn(
        // Height is the theme's density, so Compact/Cozy/Roomy reach the
        // layer list the way they reach every control.
        "group/row flex h-(--control-h) cursor-pointer select-none items-center gap-1 rounded-md pr-1.5 text-body text-fg transition-colors",
        // Selected is the ONE selection wash (it hovers a step deeper);
        // a stage hover is a plain hover, so the two never read alike.
        selected ? "bg-selection hover:bg-selection-hover" : "hover:bg-hover",
        stageHovered && !selected && "bg-hover",
        dropInto && "bg-selection ring-1 ring-primary ring-inset",
        row.type === "frame" && index > 0 && "mt-1",
        rowLocked && "cursor-not-allowed",
        rowHidden && "opacity-50",
        inert && !rowHidden && "opacity-75",
      )}
      style={{ paddingLeft: row.depth * INDENT_PX + 4, ...nestRails(row.depth) }}
      onPointerEnter={hoverId ? () => useHoverLink.getState().set(hoverId, "layers") : undefined}
      onPointerLeave={hoverId ? () => useHoverLink.getState().clear("layers", hoverId) : undefined}
      onPointerDown={onStartDrag}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (row.type !== "audio-header") onStartRename();
      }}
    >
      {chevron ? (
        <button
          type="button"
          aria-label={collapsed ? "Expand" : "Collapse"}
          className="rounded p-0.5 text-fg-faint hover:text-fg"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onToggleCollapse}
        >
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
        </button>
      ) : (
        <span className="w-4" />
      )}

      <RowIcon row={row} />

      {renaming ? (
        <RenameInput
          initial={name}
          onCommit={onRename}
          className="h-5 min-w-0 flex-1 rounded border border-primary/60 bg-input/45 px-1 text-body"
        />
      ) : (
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            row.type === "frame" && "font-heading font-semibold",
            row.type === "audio-header" && "font-semibold text-fg-muted",
          )}
        >
          {name}
        </span>
      )}

      {/* THE COMPOSITE ROLE, on the layer that has one. A chip rather than a
          section: the row keeps its z-position (which is what the drop
          arithmetic reads) and still says which side it is on. Click flips
          just this layer; the group's own row flips them all. */}
      {stencil !== null && !renaming && !inert && (
        <button
          type="button"
          title={
            stencil
              ? "Stencil — this layer does the cutting. Click to make it content."
              : "Content — this layer is what gets cut. Click to make it a stencil."
          }
          className={cn(
            "shrink-0 rounded-sm px-1 py-px text-[8px] font-semibold uppercase tracking-wide transition-colors",
            stencil
              ? "bg-(--kind-composite)/20 text-(--kind-composite) hover:bg-(--kind-composite)/30"
              : "text-muted-foreground/70 opacity-0 hover:text-foreground group-hover/row:opacity-100",
          )}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            const id = row.type === "group" ? row.groupId : row.type === "clip" ? row.clip.id : null;
            if (!id) return;
            store.update(stencil ? "Make content" : "Make stencil", (d) =>
              setClipStencilRole(d, id, !stencil),
            );
          }}
        >
          {stencil ? "stencil" : "content"}
        </button>
      )}

      {/* A SWITCH's member: the dot says whether it is the one showing now; click shows it (keyed with Record on). */}
      {!renaming && !inert && <SwitchDot row={row} />}

      {/* SWAP SIDES — "no, the OTHER one", the question every mask provokes.
          It lives on the GROUP row now, beside the mode glyph that explains
          what the sides are for; the chips above move one layer at a time. */}
      {row.type === "group" && modeUsesStencil(row.mode) && !inert && (
        <button
          type="button"
          aria-label="Swap stencil and content"
          title="Swap stencil and content"
          className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/row:opacity-100"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            store.update("Swap roles", (d) => void swapGroupRoles(d, row.groupId));
          }}
        >
          <ArrowLeftRight className="size-3" />
        </button>
      )}

      {row.type === "frame" && !renaming && (
        <span className="font-numeric text-meta text-fg-faint tabular-nums">
          {row.frame.width}×{row.frame.height}
        </span>
      )}
      {row.type === "clip" && !renaming && (
        <span className="font-numeric text-meta text-fg-faint tabular-nums opacity-0 transition-opacity group-hover/row:opacity-100">
          {(row.clip.startMs / 1000).toFixed(1)}s
        </span>
      )}
      {row.type === "clip" && !renaming && !inert && (
        <>
          <button
            type="button"
            aria-label={row.clip.hidden ? "Show layer" : "Hide layer"}
            title={row.clip.hidden ? "Show layer" : "Hide layer"}
            className={cn(
              "rounded p-0.5 text-muted-foreground transition-opacity hover:text-foreground",
              !row.clip.hidden && "opacity-0 group-hover/row:opacity-100",
            )}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              toggleClipHidden();
            }}
          >
            {row.clip.hidden ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
          </button>
          <ReferenceBadge on={referenced} />
          <button
            type="button"
            aria-label={row.clip.locked ? "Unlock layer" : "Lock layer"}
            title={row.clip.locked ? "Unlock layer" : "Lock layer"}
            className={cn(
              "rounded p-0.5 text-muted-foreground transition-opacity hover:text-foreground",
              !row.clip.locked && "opacity-0 group-hover/row:opacity-100",
            )}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              toggleClipLocked();
            }}
          >
            {row.clip.locked ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
          </button>
        </>
      )}
    </div>
  );
}

/** The radio on a switch member's row: filled when it is the member showing at the playhead. */
function SwitchDot({ row }: { row: Row }) {
  const doc = useDoc();
  const store = useDocStore();
  const playheadMs = useParkedPlayhead();
  const parentId = row.type === "clip" ? row.groupId : row.type === "group" ? row.parentId : null;
  const id = row.type === "clip" ? row.clip.id : row.type === "group" ? row.groupId : null;
  // The common project has no switch: one memoised answer, no lookup per row.
  if (!parentId || !id || !documentHasSwitches(doc)) return null;
  const parent = locateClip(doc, parentId)?.clip;
  if (parent?.kind !== "group" || !parent.switch) return null;
  const on = switchShownIds(doc, parent, clipLocalClamped(parent, playheadMs, doc)).has(id);
  return (
    <button
      type="button"
      aria-label={on ? "Showing" : "Show this one"}
      title={on ? "This one shows now" : "Show this one (keys it with Record on)"}
      className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (on) return;
        const { recording, playheadMs: at } = useSession.getState();
        store.update("Show", (d) => void setSwitch(d, parentId, id, clipLocalClamped(parent, at), { key: recording }));
      }}
    >
      <span className={cn("block size-2 rounded-full border border-current", on && "border-foreground bg-foreground")} />
    </button>
  );
}

/** One nesting level's indent, px. The drop line and the rails read it too. */
const INDENT_PX = 12;

/**
 * INDENT GUIDES: one `--nest-rail` hairline per enclosing level, under that
 * level's chevron, drawn as the row's own backgrounds. Rows sit edge to edge,
 * so the hairlines join into a rail down each open group with no extra
 * element per level (a thousand rows stay a thousand nodes).
 */
function nestRails(depth: number): React.CSSProperties | undefined {
  if (depth <= 0) return undefined;
  const line = "linear-gradient(var(--nest-rail), var(--nest-rail))";
  const xs = Array.from({ length: depth }, (_, k) => `${k * INDENT_PX + 11.5}px 0`);
  return {
    backgroundImage: Array(depth).fill(line).join(", "),
    backgroundPosition: xs.join(", "),
    backgroundSize: "1px 100%",
    backgroundRepeat: "no-repeat",
  };
}

function RowIcon({ row }: { row: Row }) {
  const doc = useDoc();
  // Component definitions and instances read as a purple ◈ (Figma
  // recognizability) — distinct from a plain frame / nested comp.
  if (row.type === "frame") {
    if (row.frame.mode === "flipbook") return <Layers2 className="size-3.5 shrink-0 text-(--kind-drawing)" />;
    if (row.frame.mode === "static") return <ImageIcon className="size-3.5 shrink-0 text-(--kind-drawing)" />;
    return isComponentFrame(row.frame) ? (
      <Component className="size-3.5 shrink-0 text-(--kind-component)" />
    ) : (
      <FrameIcon className="size-3.5 shrink-0 text-(--tool-frame,#B18CFF)" />
    );
  }
  if (row.type === "group") {
    // A rig and a switch read as what they are; composite groups wear their mode's glyph.
    const g = locateClip(doc, row.groupId)?.clip;
    if (g?.kind === "group" && (g.rig || g.switch)) {
      const Own = clipIcon(g);
      return <Own className="size-3.5 shrink-0 text-(--kind-rig)" />;
    }
    const Icon = COMPOSITE_ICONS[row.mode];
    return (
      <Icon
        className={cn("size-3.5 shrink-0", row.mode === "pass" ? "text-muted-foreground" : "text-(--kind-composite)")}
      />
    );
  }
  if (row.type === "audio-header") return <AudioLines className="size-3.5 shrink-0 text-muted-foreground" />;
  if (row.clip.kind === "nested") {
    // A nested clip WEARS its source's mode: flipbooks and stills read as
    // themselves everywhere, not as anonymous "nested" films.
    const source = doc.frames.find((f) => f.id === (row.clip as { sourceFrameId: string }).sourceFrameId);
    if (source?.mode === "flipbook") return <Layers2 className="size-3.5 shrink-0 text-(--kind-drawing)" />;
    if (source?.mode === "static") return <ImageIcon className="size-3.5 shrink-0 text-(--kind-drawing)" />;
    if (componentFrameOfClip(doc, row.clip)) {
      return <Component className="size-3.5 shrink-0 text-(--kind-component)" />;
    }
  }
  const Icon = clipIcon(row.clip);
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" />;
}

