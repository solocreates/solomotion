"use client";

import * as React from "react";
import {
  activeFlipbookCell,
  addFlipbookCellAt,
  addFlipbookRow,
  cellDrawing,
  onionGhosts,
  type OnionSettings,
  cellFrameCount,
  cellPaintTargetId,
  applyFlipbookDragPlan,
  coLocateFlipbookCells,
  healFlipbookSpan,
  duplicateFlipbookCell,
  flipbookInContext,
  flipbookLoopMode,
  flipbookRows,
  sheetStepMs,
  isClipLocked,
  mirrorSiblings,
  ownerNestedOf,
  pasteFlipbookCellsAt,
  planFlipbookCellDrag,
  planFlipbookCellResize,
  reconcileFillClips,
  removeAllFlipbookGaps,
  removeGapsBetweenSelected,
  rowCellAt,
  selectedCellOf,
  setCellHoldFrames,
  setFlipbookLoop,
  type Clip,
  type Frame,
  type FlipbookDragPlan,
  type FlipbookRow,
  type LoopMode,
  type MotionDocument,
  type DocumentStore,
  frameFps,
  setFrameFps,
} from "@solomotion/core";
import {
  ArrowRight,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  FoldHorizontal,
  Layers2,
  Plus,
  Scissors,
  Trash2,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { NumberInput } from "@/components/ui/number-input";
import { FpsControl } from "@/components/ui/fps-control";
import { RenameInput } from "@/components/ui/rename-input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { placeAssetClips } from "../assets/import";
import { importDroppedFiles } from "../io/slice-file";
import { useDoc, useDocStore } from "../state/document-context";
import { deleteFlipbookCells, deleteFlipbookRow } from "../state/clip-actions";
import { useSession, type LibraryDrag, useParkedPlayhead } from "../state/session";
import { clickSelect, type SelectionState } from "../state/selection-model";
import { useSweepSelect } from "../state/use-sweep-select";
import { beginScrubDrag } from "../timeline/scrub";
import { useTimeSurface } from "../timeline/use-time-surface";
import { HELD_DRAG_SURFACE } from "../input/use-multi-touch";
import { framePx, sheetAxisBounds, SHEET_FRAME_PX } from "../timeline/time-axes";
import { laneZoomNow, pxPerSecNow, useLaneZoom, usePxPerSec, zoomScrollerAt } from "../timeline/use-time-axes";
import { ZoomBar } from "../workspace/ZoomBar";
import { rowsAxis, scrollerTimeAxis } from "../timeline/view-axes";
import { TimeZoomMenu } from "../timeline/TimeZoomBar";
import { TIME_ZOOM } from "../workspace/view-zoom";
import { registerZoomTarget } from "../workspace/zoom-shortcuts";
import { LassoTools } from "../input/LassoTools";
import { CompTabs } from "../timeline/CompTabs";
import {
  EndBar,
  Playhead,
  RangeControl,
  SnapControl,
  TimeDisplay,
  TimelineDimOverlay,
  Transport,
  useCompDuration,
} from "../timeline/Timeline";
import { HeaderDivider, LOOP_LABEL, LoopToggle } from "../timeline/header-controls";
import { Button } from "@/components/ui/button";
import { copyFlipbookCells, cutFlipbookCells, pasteFlipbookClipboard, useFlipbookClipboard } from "./flipbook-clipboard";
import { rowFocusBox, useSurfaceTick, type FocusBox } from "./cell-focus";
import { focusFlipbookCell } from "./flipbook-focus";
import { OnionPod } from "./OnionPod";
import { useDrawing } from "./drawing-store";
import { useTheme } from "../theme/use-theme";
import { sceneInk } from "../stage/scene-chrome";
import { cloneSurfacePixels } from "./raster-store";
import { CompThumb } from "../preview/CompThumb";
import { capturePointer } from "../input/capture-pointer";
import { claimPointer } from "../input/pointer-gestures";
import { beginHeldDrag } from "../input/hold-to-drag";

/**
 * The flipbook SHEET — what the bottom panel shows instead of the raw
 * timeline while a flipbook (or one of its cell drawings) is open. Dreams'
 * flipbook, grown up: multiple ROWS (tracks), each row a strip of CELLS
 * (drawing comps) with per-cell hold counts, per-row loop modes with ghosted
 * repeat previews, live thumbnails (revision-keyed — never stale), a
 * scrubbable frame ruler, and one-gesture add/duplicate/hold/delete.
 *
 * Everything here is a VIEW over the same document the timeline shows —
 * rows are tracks, cells are nested clips — so undo, selection, export and
 * playback need no flipbook-specific code anywhere else.
 */

const BASE_ROW_H = 76; // px per row at laneZoom 1
/** The sticky row-header gutter — one constant, not four literal 160s. */
const ROW_HEADER_W = 160;
/** The sticky frame ruler at the top of the sheet's scroller (h-6). */
const SHEET_RULER_H = 24;
/** A cell's inset inside its row (`top-1.5`, height `ROW_H - 12`). */
const CELL_INSET = 6;

/**
 * A drag in flight. The PLAN is the whole of it — where every cell would land
 * if you let go now — plus the raw pixel offset the dragged cells ride so they
 * track the pointer exactly rather than snapping frame by frame.
 */
interface SheetDrag {
  /** MOVE rides the pointer un-quantised; RESIZE snaps to the frame grid. */
  kind: "move" | "resize";
  /** The cells the gesture ACTS on, as opposed to the ones it displaces. */
  ids: ReadonlySet<string>;
  /** Un-quantised pointer travel, for the cells in your hand only. */
  deltaPx: number;
  /** ⌥ held → this drag DUPLICATES (leaves the original, drops a copy). */
  copy: boolean;
  plan: FlipbookDragPlan;
}

/** How the displaced cells glide. Long enough to read as motion, short enough
 *  that the sheet still feels like it is under your finger. */
const REFLOW_TRANSITION = "left 140ms cubic-bezier(0.2, 0, 0, 1), width 140ms cubic-bezier(0.2, 0, 0, 1)";

/**
 * The sheet's grid, in px — the SAME two axes as the timeline, read through
 * the same hooks, with one honest conversion.
 *
 * A cell is `stepMs` of comp time wide, so its width in px is just the
 * horizontal axis applied to that: `pxPerSec * stepMs / 1000`. That replaced
 * `56 * pxPerSec / 90` — a fudge that existed only because the sheet was
 * sharing ONE global pxPerSec with a timeline measured in seconds, and that
 * made the two panels step at visibly different rates while claiming to share
 * an axis. Now that the axes are per-surface (`zoomBySurface`), the sheet's own
 * default IS "one frame is 56px" expressed in px/s, and the fudge is gone.
 *
 * The consequence worth noticing: every shared component below — the playhead,
 * the end bar, the dim overlay — takes plain `pxPerSec` now. The sheet used to
 * compute a SECOND px-per-second (`pxPerSecSheet`) for them, because its own
 * one was a lie.
 */
function useSheetGrid(stepMs: number): { FRAME_W: number; ROW_H: number; pxPerSec: number } {
  const pxPerSec = usePxPerSec();
  const laneZoom = useLaneZoom();
  return {
    pxPerSec,
    FRAME_W: Math.max(10, framePx(pxPerSec, stepMs)),
    ROW_H: Math.max(40, BASE_ROW_H * laneZoom),
  };
}

/** Focus follows creation: DRILL into a freshly-created cell (no tab, no
 *  jump) and select its paint layer, so the next stroke lands inside it —
 *  shared by the row-end "+" and every void slot's "Add frame here". */
function focusCreatedCell(store: DocumentStore, created: { clip: Clip } | null) {
  if (created?.clip) focusFlipbookCell(store.getState(), created.clip);
}

export function FlipbookPanel({ flipbook }: { flipbook: Frame }) {
  const doc = useDoc();
  const store = useDocStore();
  const playing = useSession((s) => s.playing);
  const playheadMs = useParkedPlayhead();
  const activeFrameId = useSession((s) => s.activeFrameId);
  const selectedClipIds = useSession((s) => s.selectedClipIds);

  // Play plays the WHOLE flipbook: pressing play while drilled into one cell's
  // drawing would loop that single frame forever — ascend to the flipbook at
  // the mapped time instead. Pause leaves you at the flipbook level, free to
  // refocus (the paint target follows the playhead anyway).
  React.useEffect(() => {
    if (!playing) return;
    const session = useSession.getState();
    const d = store.getState();
    const active = d.frames.find((f) => f.id === session.activeFrameId);
    if (!active || active.mode === "flipbook") return;
    const cell = ownerNestedOf(d, active.id);
    if (!cell || cell.frameId !== flipbook.id) return;
    // No mapped time to pass: `revealFrame` carries the instant up through the
    // cell's trim and speed itself. This used to add `cell.startMs` by hand —
    // a fourth private copy of the mapping, and the one that ran on a timer.
    session.revealFrame(flipbook.id);
  }, [playing, store, flipbook.id]);

  // NOTE: selection deliberately does NOT auto-follow the playhead anymore —
  // it used to (`flipbookSelectionSync`, kept in core for `activeFlipbookCell`
  // below), but re-selecting on every playhead tick raced explicit clicks
  // during a ruler drag/scrub and fought clicking a void to deselect. The
  // pen still lands on the right cell without it: `activeCellId` below
  // (via `activeFlipbookCell`) already falls back to "cell under the
  // playhead" whenever nothing is explicitly selected — that's a pure read,
  // not a stored-selection side effect, so nothing here needs to write
  // `selectedClipIds` just because the playhead moved. Selection changes
  // ONLY on an explicit click now.

  // Heal older flipbooks whose cell drawings were scattered across the nested
  // page: co-locate them ON the flipbook so focusing a frame needs no camera
  // move. Idempotent — only writes (one history entry) when something moved.
  React.useEffect(() => {
    const d = store.getState();
    const fb = d.frames.find((f) => f.id === flipbook.id);
    if (!fb) return;
    const needs = flipbookRows(d, flipbook.id).some((r) =>
      r.cells.some((c) => {
        const dr = c.kind === "nested" ? d.frames.find((f) => f.id === c.sourceFrameId) : null;
        return dr != null && (dr.x !== fb.x || dr.y !== fb.y);
      }),
    );
    if (needs) store.update("Tidy flipbook layout", (dd) => void coLocateFlipbookCells(dd, flipbook.id));
    // THE OWNER'S BOX IS A FLOOR OVER THE SHEET (see `healFlipbookSpan`). A
    // document whose sheet outgrew its clip has cells nothing can draw — right
    // in the thumbnails, invisible on the stage — so opening the sheet repairs
    // it. Idempotent, and `update` records nothing when the recipe changes
    // nothing, so a healthy flipbook costs no history entry.
    store.update("Fit flipbook to its frames", (dd) => void healFlipbookSpan(dd, flipbook.id));
  }, [flipbook.id, store]);

  const step = sheetStepMs(doc, flipbook);
  const { FRAME_W, ROW_H, pxPerSec } = useSheetGrid(step);
  const rows = flipbookRows(doc, flipbook.id);
  // Every cell across every row, flat — a cross-row multi-select drags as ONE
  // group (see `dragPreview` below), so origin lookups can't be scoped to a
  // single row's `row.cells` the way the old same-row-only dnd-kit sort was.
  const allCells = React.useMemo(() => rows.flatMap((r) => r.cells), [rows]);
  /*
   * THE LIVE DRAG — a PLAN, recomputed on every pointer move and RENDERED
   * rather than written.
   *
   * It used to be a bare pixel delta: the dragged cells rode a CSS transform
   * and nothing else on the sheet reacted, so the only way to learn what a drop
   * would do was to do it. Worse, the release then ran a SECOND, unrelated set
   * of rules — one cell swapped with whatever it landed on, a multi-selection
   * instead used a clamped move that refused to swap at all — so the preview
   * did not predict the commit, and "it only works when the cell already fits"
   * was the honest description of the result.
   *
   * `planFlipbookCellDrag` answers once and the sheet draws its answer: the
   * cells being displaced glide aside under your hand and a gap opens where the
   * drop will land. Release applies the same plan. Nothing is written to the
   * document until then, so a cancelled drag costs nothing and undo sees one
   * step. Lives at the SHEET level, not per row, because a selection spanning
   * several rows is one gesture.
   */
  const [dragPreview, setDragPreview] = React.useState<SheetDrag | null>(null);
  // The flipbook's PLAYABLE length — owner-clip-aware, auto-hugs content with
  // no override set — is the SAME brain the root timeline's end bar reads
  // (`useCompDuration`/`frameDurationMs`). The sheet still renders past it
  // (so trailing/overflow cells stay visible, just dimmed by the reused
  // `TimelineDimOverlay` below) rather than clipping them from the grid.
  const { effective, setDuration } = useCompDuration(doc, flipbook);
  // The sheet rides the SAME zoom axes and the SAME snapping flag as the
  // timeline (see `useSheetGrid`), so the header's controls need no sheet-local
  // copies of either.
  const laneZoom = useLaneZoom();
  const snapping = useSession((s) => s.snapping);
  const contentEndMs = Math.max(0, ...rows.map((r) => r.span?.endMs ?? 0));
  const endMs = Math.max(effective, contentEndMs);
  const totalFrames = Math.max(1, Math.round(endMs / step));

  // Inside a cell's drawing the sheet highlights it and maps the playhead
  // through the cell's start — the flipbook is the time authority.
  const inFlipbook = activeFrameId === flipbook.id;
  const drilledCell = !inFlipbook
    ? rows.flatMap((r) => r.cells).find((c) => c.kind === "nested" && c.sourceFrameId === activeFrameId)
    : null;
  // The ACTIVE cell — the one the pen draws on — is highlighted, so the sheet
  // shows exactly what a stroke will hit (same resolver as the paint target).
  const activeCellId = inFlipbook
    ? (activeFlipbookCell(doc, flipbook.id, playheadMs, selectedClipIds)?.id ?? null)
    : (drilledCell?.id ?? null);
  const onion = useDrawing((s) => s.onion);
  const themeKey = useTheme((s) => s.theme);
  const onionMarks = React.useMemo(
    () => onionMarksFor(doc, rows.flatMap((r) => r.cells).find((c) => c.id === activeCellId) ?? null, onion),
    // `themeKey`: the tints are the theme's (sceneInk), so a theme change re-derives them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, rows, activeCellId, onion, themeKey],
  );

  // ── Free multi-select (marquee + ⇧ range + ⌘/Ctrl toggle) ─────────────────
  // Cells ARE clips, so multi-selection rides the SAME `selectedClipIds` every
  // other surface (canvas, timeline) uses — no parallel selection model. A
  // selected id may be the cell itself (a fresh multi-pick) OR its child paint
  // layer (a single focused cell, see focusCell) — `selectedCellOf` resolves
  // either to the owning cell, so both flavors coexist in one array. The
  // anchor (shift-range pivot) is local UI state, same convention as
  // LayersPanel's own anchorRef.
  const sheetGridRef = React.useRef<HTMLDivElement>(null);
  // The current cell's row is kept whole in view (vertically only: the
  // playhead's own autoscroll owns x). Without this the last row sat half
  // under the zoom bar and its accent ring — 3px OUTSIDE the cell — was cut.
  // The row's 6px inset is the margin, so the ring always lands inside it.
  React.useLayoutEffect(() => {
    const el = sheetGridRef.current;
    if (!el || !activeCellId) return;
    const cell = el.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(activeCellId)}"]`);
    if (!cell) return;
    const box = el.getBoundingClientRect();
    const r = cell.getBoundingClientRect();
    const top = r.top - CELL_INSET - (box.top + SHEET_RULER_H);
    const bottom = r.bottom + CELL_INSET - (box.top + el.clientHeight);
    if (top < 0) el.scrollTop += top;
    else if (bottom > 0) el.scrollTop += Math.min(bottom, top);
  }, [activeCellId]);
  // The same hook the timeline lanes use, on the same two session axes — so
  // ⌘/pinch, ⌥, two-finger pan and the viewport's touch-action are one
  // implementation rather than a second one that drifts.
  const surface = useTimeSurface(sheetGridRef, {
    // The sheet's horizontal bound is px-per-FRAME, not px-per-second: a grid
    // of thumbnails stops being readable below ~10px and stops being a grid
    // above ~260px, and that is true whatever the sheet's rate happens to be.
    onZoomTime: (factor, centerX) => zoomSheetTo(pxPerSecNow() * factor, centerX),
    onZoomRows: (factor) => useSession.getState().setLaneZoom(laneZoomNow() * factor),
  });
  /**
   * ONE zoom writer for the sheet. Clamps to px-per-FRAME rather than
   * px-per-second — a grid of thumbnails stops being readable below ~10px and
   * stops being a grid above ~260px, and that is true whatever the sheet's rate
   * is — then keeps the frame under the anchor still.
   */
  const zoomSheetTo = React.useCallback(
    (target: number, centerX?: number) => {
      const el = sheetGridRef.current;
      const b = sheetAxisBounds(step);
      const from = pxPerSecNow();
      const to = Math.min(b.max, Math.max(b.min, target));
      if (to === from) return;
      useSession.getState().setPxPerSec(to);
      zoomScrollerAt(el, from, to, centerX ?? (el?.clientWidth ?? 0) / 2, ROW_HEADER_W);
    },
    [step],
  );

  // The D5 zoom keys while the SHEET is the focused region: ⌘± step the
  // cell width, ⌘0 fits the whole sheet, ⇧0 returns to the sheet's own size.
  const sheetZoomRef = React.useRef({ zoomSheetTo, spanMs: 0, natural: 0 });
  // The zoom bars. Read through a ref so the axes are made once and always see
  // the current span and step.
  const sheetAxRef = React.useRef({ spanMs: 0, step });
  const sheetTimeAx = React.useMemo(
    () => scrollerTimeAxis(() => sheetGridRef.current, ROW_HEADER_W, () => sheetAxRef.current.spanMs, () => sheetAxisBounds(sheetAxRef.current.step)),
    [],
  );
  const sheetRowsAx = React.useMemo(() => rowsAxis(() => sheetGridRef.current, SHEET_RULER_H), []);
  React.useEffect(
    () =>
      registerZoomTarget({
        focus: "sheet",
        run: (cmd) => {
          const { zoomSheetTo: z, spanMs, natural } = sheetZoomRef.current;
          const el = sheetGridRef.current;
          if (cmd === "fit") z(((Math.max(1, (el?.clientWidth ?? 0) - ROW_HEADER_W)) / Math.max(1, spanMs)) * 1000);
          else if (cmd === "actual") z(natural);
          else z(pxPerSecNow() * (cmd === "in" ? TIME_ZOOM.step : 1 / TIME_ZOOM.step));
        },
      }),
    [],
  );

  const cellAnchorRef = React.useRef<string | null>(null);
  const marqueeBaseRef = React.useRef<string[]>([]);
  const cellOrder = rows.flatMap((r) => r.cells.map((c) => c.id));
  const selectedCellIds = React.useMemo(() => {
    const out = new Set<string>();
    for (const id of selectedClipIds) {
      const cell = selectedCellOf(doc, rows, id);
      if (cell) out.add(cell.id);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClipIds, doc]);

  /** ⌘/Ctrl-toggle or ⇧-range a single cell into the selection — no drilling.
   *  Multi-select is a batch-frame gesture (cut/copy/delete/move-together), so
   *  it holds the CELL ids themselves — unlike focusCell's single-select,
   *  which points at the cell's paint-target child for the pen/Inspector. */
  const selectCellWithMods = (cellId: string, mods: { shift?: boolean; meta?: boolean }) => {
    const current: SelectionState = { selected: selectedCellIds, anchor: cellAnchorRef.current };
    const next = clickSelect(cellOrder, current, cellId, mods);
    cellAnchorRef.current = next.anchor;
    useSession.getState().select([...next.selected]);
  };

  const { onPointerDown: onGridPointerDown, marqueeNode, surfaceClassName: lassoClass } = useSweepSelect(sheetGridRef, "data-cell-id", {
    onDragStart: (additive) => {
      marqueeBaseRef.current = additive ? [...selectedCellIds] : [];
    },
    onSweep: (hits) => useSession.getState().select([...new Set([...marqueeBaseRef.current, ...hits])]),
    // Clicking empty sheet space deselects AND pops back out of whatever
    // cell was drilled into — the flipbook is the time authority, a click
    // on nothing shouldn't leave you stuck looking at one frame's drawing.
    // The instant is carried by `revealFrame`, never reset to the sheet's start.
    onClear: () => {
      const session = useSession.getState();
      session.clearSelection(); // already resets selectedFlipbookVoid too
      // Pop back out to the flipbook, keeping the instant — no arithmetic here
      // any more, because `revealFrame` maps it.
      if (!inFlipbook) session.revealFrame(flipbook.id);
    },
  });

  const runPaste = (afterCellId: string | null) => {
    const pasted = pasteFlipbookClipboard(store, flipbook.id, afterCellId ? { afterCellId } : null);
    if (pasted) useSession.getState().select(pasted);
  };

  /** Paste exactly onto a void slot — the sheet's "select an empty cell, hit
   *  paste" gesture. Never touches anything but the target row's ripple. */
  const runPasteAt = (trackId: string, atMs: number) => {
    const pasted = pasteFlipbookClipboard(store, flipbook.id, { trackId, atMs });
    if (pasted) {
      useSession.getState().select(pasted);
      useSession.getState().setSelectedFlipbookVoid(null);
    }
  };

  /**
   * FOCUS a cell — the ONE gesture behind clicking, double-clicking and adding.
   * A cell is not a standalone timeline: focusing it drills into its drawing so
   * the breadcrumb nests, the layers list ("This frame") shows that frame's
   * layers and the pen draws into it — WITHOUT pinning a tab (pinTabs:false) and
   * WITHOUT moving the camera (the frames are co-located inside the flipbook, so
   * there's nothing to move to). Selecting its child paint layer focuses that
   * child in the layers list, as the user asked.
   */
  const focusCell = (cell: Clip) => {
    focusFlipbookCell(doc, cell);
    cellAnchorRef.current = cell.id;
  };

  /**
   * SCRUBBING THE SHEET IS ALWAYS SHEET TIME.
   *
   * `seekIn` converts, and steps out of a drilled cell in the same decision
   * when the instant asked for is not one that cell can express — so the
   * coordinate system can never flip halfway through a drag, which is what the
   * three-branch version below this used to do at every cell boundary.
   *
   * `deselect` on the FIRST move is the gesture's meaning: a drag along the
   * ruler is "show me the sheet", so it lets go of the focused cell instead of
   * being pulled back into it on the next tick.
   */
  const scrubTo = (clientX: number, ruler: HTMLElement, opts?: { begin?: boolean }) => {
    const rect = ruler.getBoundingClientRect();
    const ms = Math.max(0, Math.min(((clientX - rect.left) / FRAME_W) * step, endMs - 1));
    useSession.getState().seekIn(flipbook.id, ms, opts?.begin ? { deselect: true } : undefined);
  };

  // ── Drop onto the sheet ─────────────────────────────────────────────────
  // Same two drop systems the root Timeline already listens on — a second
  // listener, not a new mechanism. Media always lands as a LAYER inside a
  // cell's drawing (never a raw clip on a row track — rows only ever hold
  // cells), creating a blank cell on the spot if the slot is void.

  /** Row + frame-quantized ms under a client point (mirrors the Timeline's
   *  own y→track / x→time hit test, adapted to the sheet's uniform ROW_H). */
  const rowAndMsAt = (clientX: number, clientY: number): { row: FlipbookRow; ms: number } | null => {
    const el = sheetGridRef.current;
    if (!el || rows.length === 0) return null;
    const rect = el.getBoundingClientRect();
    const relY = clientY - rect.top - SHEET_RULER_H; // below the sticky frame-ruler
    const idx = Math.min(rows.length - 1, Math.max(0, Math.floor(relY / ROW_H)));
    const x = clientX - rect.left + el.scrollLeft - ROW_HEADER_W;
    const ms = Math.max(0, Math.round(x / FRAME_W) * step);
    return { row: rows[idx]!, ms };
  };

  /** The comp a dropped asset should land in — the cell already covering that
   *  slot, or a fresh blank cell created there on the spot if it's void. */
  const targetCompForDrop = (row: FlipbookRow, ms: number): string | null => {
    const d = store.getState();
    const existing = rowCellAt(d, flipbook.id, row, ms);
    if (existing?.kind === "nested") return existing.sourceFrameId;
    let target: string | null = null;
    store.update("Add frame", (dd) => {
      const created = addFlipbookCellAt(dd, flipbook.id, row.track.id, ms);
      if (created) target = created.clip.sourceFrameId;
    });
    return target;
  };

  React.useEffect(() => {
    const el = sheetGridRef.current;
    if (!el) return;
    const onLibraryDrop = (e: Event) => {
      const { clientX, clientY, drag } = (
        e as CustomEvent<{ clientX: number; clientY: number; drag: LibraryDrag }>
      ).detail;
      if (!drag || drag.kind !== "media") return; // components have no cell home
      const hit = rowAndMsAt(clientX, clientY);
      if (!hit) return;
      const compId = targetCompForDrop(hit.row, hit.ms);
      if (!compId) return;
      const asset = store.getState().assets.find((a) => a.id === drag.id);
      if (!asset) return;
      void placeAssetClips(store, asset, { frameId: compId, startMs: 0 }, { width: flipbook.width, height: flipbook.height });
    };
    el.addEventListener("tm-library-drop", onLibraryDrop);
    return () => el.removeEventListener("tm-library-drop", onLibraryDrop);
  }, [store, rows, step, flipbook.id, flipbook.width, flipbook.height, ROW_H, FRAME_W]);

  sheetZoomRef.current = { zoomSheetTo, spanMs: effective, natural: SHEET_FRAME_PX * frameFps(doc, flipbook) };
  sheetAxRef.current = { spanMs: effective, step };

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-panel"
      // The sheet is its OWN keyboard surface: a selection here means FRAMES,
      // and the same ids on the canvas mean artwork (`flipbookCellsInSelection`).
      onPointerDownCapture={() => useSession.getState().setFocusedPanel("sheet")}
    >
      <CompTabs />
      {/*
        THE SHEET HEADER IS THE TIMELINE HEADER.

        It used to be a private row of bespoke controls: a 24px play button with
        its own hover treatment and no jump-to-start, a hand-rolled loop cycler,
        a duration field in frames, and no working range or zoom at all — four
        lines away from the timeline's versions of the same things and agreeing
        with none of them. Switching panels meant re-learning where transport
        lives and re-learning what each glyph means.

        So the controls are the timeline's, imported. Read left to right it is
        the SAME sentence: transport · time · sheet settings · tools · (spacer)
        · add · zoom. Only the middle group differs, because a sheet is measured
        in frames and a timeline in seconds — which is the one thing about it
        that genuinely is different.
      */}
      <div
        className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden border-b px-2 *:shrink-0"
        style={{ scrollbarWidth: "none" }}
      >
        <Transport />
        <HeaderDivider />
        <TimeDisplay fps={frameFps(doc, flipbook)} frameId={flipbook.id} />
        {/* Duration in FRAMES, not seconds — the sheet's native unit, and the
            same `setDuration` the end bar drags, so typing here and dragging
            the bar are one operation. */}
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span>/</span>
          <NumberInput
            value={Math.round(effective / step)}
            min={1}
            precision={0}
            unit="f"
            className="w-14"
            title="Flipbook length, in frames — or drag the sheet's end bar"
            onChange={(v) => setDuration(Math.max(1, Math.round(v)) * step, `flipbook-dur-${flipbook.id}`)}
          />
        </div>
        {/* The sheet's rate, through the ONE control and the ONE writer. The
            re-cut that keeps every cell's hold count lives in core
            (`setFrameFps` → `retimeFlipbookCells`). */}
        <FpsControl
          value={frameFps(doc, flipbook)}
          size="compact"
          menuTitle="Sheet rate"
          className="w-28"
          onChange={(v) =>
            store.update("Flipbook fps", (d) => setFrameFps(d, flipbook.id, v), {
              mergeKey: `flipbook-fps-${flipbook.id}`,
            })
          }
          onCommit={(v) => store.update("Flipbook fps", (d) => setFrameFps(d, flipbook.id, v))}
        />
        {/* The WHOLE flipbook's loop mode — the same knob as its clip in the
            parent frame, and now the same CONTROL as the timeline's frame loop
            (`LoopToggle`), so one glyph means one thing in both panels. */}
        <LoopToggle
          mode={flipbookLoopMode(doc, flipbook.id)}
          onChange={(next) =>
            store.update("Flipbook loop mode", (d) => setFlipbookLoop(d, flipbook.id, next))
          }
          label="Flipbook"
        />
        <HeaderDivider />
        <SnapControl snapping={snapping} />
        {/* Working range — loop and export just a section of the sheet. It was
            simply missing here; the flipbook is a comp like any other and the
            control is already comp-scoped. */}
        <RangeControl compId={flipbook.id} />
        <OnionPod />
        <div className="flex-1" />
        <LassoTools
          selectedCount={selectedCellIds.size}
          onDeselect={() => useSession.getState().clearSelection()}
        />
        <HeaderDivider />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => store.update("Add flipbook row", (d) => void addFlipbookRow(d, flipbook.id))}
            >
              <Plus /> Row
            </Button>
          </TooltipTrigger>
          <TooltipContent>New row — cells on separate rows play together</TooltipContent>
        </Tooltip>
      </div>

      {/* Identity strip: which sheet this is, and its layer count. The name sat
          in the toolbar competing with the controls for the eye; here it reads
          as a title and the toolbar reads as a toolbar. */}
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b px-2 text-[11px] text-muted-foreground">
        <Layers2 className="size-3 text-(--kind-drawing)" />
        <span className="font-medium text-foreground">{flipbook.name}</span>
        <span>·</span>
        <span>{rows.length === 1 ? "1 row" : `${rows.length} rows`}</span>
      </div>

      {/* The scroller is wrapped so the row-zoom dial can float OVER it: an
          absolutely positioned child of a scroll container scrolls away with
          the content, which is why the timeline wraps its own the same way. */}
      <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={sheetGridRef}
        data-timeline-drop
        // The sheet's gestures ARE the timeline's — same hook, same axes, same
        // touch-action. It used to carry a private `onWheel` that multiplied
        // `pxPerSec` by its own 1.12, so the two panels this doc comment calls
        // "the SAME zoom axes" actually stepped at different rates depending on
        // which one your pointer was over; and having no multi-touch or
        // touch-action meant every cell drag in here was taken by the browser
        // as a scroll.
        // `lassoClass` wins when the lasso is armed: the sheet must stop
        // scrolling while a shape is being drawn on it, and go straight back to
        // scrolling when it disarms. Order matters — it comes after the
        // surface's own `pan-x pan-y`.
        className={cn("tm-scroll-owned relative min-h-0 flex-1 overflow-auto", surface.className, lassoClass)}
        onPointerDown={onGridPointerDown}
        onDragOver={(e) => {
          if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          // Files dropped from the OS land the same way a library drag does —
          // into a cell's drawing at the dropped row/slot, through the one
          // shared import dispatcher (media as a layer, slice data merged).
          const files = Array.from(e.dataTransfer?.files ?? []);
          if (files.length === 0) return;
          e.preventDefault();
          const hit = rowAndMsAt(e.clientX, e.clientY);
          const compId = hit ? targetCompForDrop(hit.row, hit.ms) : null;
          if (!compId) return;
          void importDroppedFiles(store, files, { media: { frameId: compId, startMs: 0 } });
        }}
      >
        <div className="relative w-max min-w-full pb-2">
          {/* Frame ruler — scrub by click/drag (opts out of the marquee below). */}
          <div
            data-no-marquee
            className="sticky top-0 z-10 ml-40 flex h-6 cursor-ew-resize select-none border-b border-line bg-panel"
            style={{ width: totalFrames * FRAME_W + FRAME_W * 2 }}
            // THE shared scrub lifecycle. The hand-rolled one this replaces
            // listened for `pointerup` and nothing else, so — exactly like the
            // timeline ruler before it — a touch scrub that the browser
            // cancelled leaked its move listener and the playhead kept being
            // seeked by it long after the finger was gone. Only the mapping is
            // the sheet's own; the lifecycle is everyone's.
            onPointerDown={(e) => {
              const el = e.currentTarget;
              let first = true;
              beginScrubDrag(e, (clientX) => {
                scrubTo(clientX, el, { begin: first });
                first = false;
              });
            }}
          >
            {Array.from({ length: totalFrames + 1 }, (_, i) => (
              <div
                key={i}
                className="shrink-0 border-l border-line pl-1 font-mono text-[9px] leading-6 tabular-nums text-muted-foreground"
                style={{ width: FRAME_W }}
              >
                {i + 1}
              </div>
            ))}
          </div>

          {/* Rows — cells and row headers opt out of the marquee below via
              data-cell-id/data-no-marquee, so everything else here (between,
              beside and below rows) is free-select space. */}
          {rows.map((row) => (
            <SheetRow
              key={row.track.id}
              flipbook={flipbook}
              row={row}
              allCells={allCells}
              step={step}
              endMs={endMs}
              activeCellId={activeCellId}
              selectedCellIds={selectedCellIds}
              onionMarks={onionMarks}
              dragPreview={dragPreview}
              onDragPreview={setDragPreview}
              onSelect={focusCell}
              onOpen={focusCell}
              onSelectMods={selectCellWithMods}
              onPasteAfter={runPaste}
              onPasteAt={runPasteAt}
            />
          ))}

          {/* Everything past the flipbook's duration reads as dimmed/disabled
              — the SAME overlay + end bar the root timeline uses, not a sheet-
              specific reimplementation. Cells under the dim aren't deleted or
              blocked, just excluded from playback/export, exactly like an
              overflowing clip past the root timeline's end bar. */}
          <TimelineDimOverlay pxPerSec={pxPerSec} compId={flipbook.id} offsetPx={ROW_HEADER_W} />
          <EndBar pxPerSec={pxPerSec} frame={flipbook} offsetPx={ROW_HEADER_W} />

          {/* Playhead across the sheet — the SAME component the root timeline
              uses (autoscroll during playback included), not a static div. */}
          <Playhead
            pxPerSec={pxPerSec}
            spanMs={endMs}
            scrollRef={sheetGridRef}
            offsetPx={ROW_HEADER_W}
            frameId={flipbook.id}
          />
        </div>
        {marqueeNode}
      </div>
      </div>
      {/* Both axes are zoom bars, the same control the timeline wears: cell
          width along the bottom, cell height down the side. */}
      <ZoomBar
        axis={sheetRowsAx}
        orientation="y"
        label="Rows — scroll and cell height"
        className="w-3.5 shrink-0 border-l border-line"
        style={{ marginTop: SHEET_RULER_H }}
      />
      </div>
      <div className="flex h-6 shrink-0 items-center border-t border-line">
        <div className="flex shrink-0 items-center px-1" style={{ width: ROW_HEADER_W }}>
          <TimeZoomMenu time={sheetTimeAx} rows />
        </div>
        <ZoomBar axis={sheetTimeAx} orientation="x" label="Frames — scroll and cell width" playhead className="mx-2.5 h-full flex-1" />
        <div className="w-3.5 shrink-0" />
      </div>
      </div>
    </div>
  );
}


/** Ghosted cells by DRAWING id: the tint the stage ghosts it in, and its
 *  strength (1 = the nearest ghost). Empty while the onion skin is off. */
type OnionMarks = ReadonlyMap<string, { color: string; strength: number }>;
const NO_MARKS: OnionMarks = new Map();

/**
 * The SAME plan the stage draws (`onionGhosts`), read for the sheet, so the
 * cells that light up are exactly the drawings ghosted on the canvas.
 */
function onionMarksFor(doc: MotionDocument, current: Clip | null, onion: OnionSettings): OnionMarks {
  if (!onion.enabled || !current || onion.opacity <= 0) return NO_MARKS;
  const drawing = cellDrawing(doc, current);
  if (!drawing) return NO_MARKS;
  const ink = sceneInk();
  const marks = new Map<string, { color: string; strength: number }>();
  for (const g of onionGhosts(doc, drawing.id, onion)) {
    if (g.source !== "drawing" || g.drawingFrameId === drawing.id) continue;
    const prev = marks.get(g.drawingFrameId);
    const strength = g.alpha / onion.opacity;
    if (prev && prev.strength >= strength) continue;
    marks.set(g.drawingFrameId, { color: g.color ?? (g.offset < 0 ? ink.onionBehind : ink.onionAhead), strength });
  }
  return marks;
}

function SheetRow({
  flipbook,
  row,
  allCells,
  step,
  endMs,
  activeCellId,
  selectedCellIds,
  onionMarks,
  dragPreview,
  onDragPreview,
  onSelect,
  onOpen,
  onSelectMods,
  onPasteAfter,
  onPasteAt,
}: {
  flipbook: Frame;
  row: FlipbookRow;
  /** Every cell across every row — a multi-select group-drag can span rows,
   *  so a mover's ORIGIN position may live outside this row's own cells. */
  allCells: readonly Clip[];
  step: number;
  endMs: number;
  /** The cell the pen is aimed at — the one to highlight (paint target). */
  activeCellId: string | null;
  /** The sheet's free multi-selection (marquee/⇧/⌘), resolved to CELL ids. */
  selectedCellIds: ReadonlySet<string>;
  /** Cells the onion skin ghosts, by drawing id (see `onionMarksFor`). */
  onionMarks: OnionMarks;
  /** The sheet-wide live drag (see FlipbookPanel) — shared across rows so a
   *  cross-row multi-select still rides one plan. */
  dragPreview: SheetDrag | null;
  onDragPreview: (preview: SheetDrag | null) => void;
  onSelect: (cell: Clip) => void;
  onOpen: (cell: Clip) => void;
  onSelectMods: (cellId: string, mods: { shift?: boolean; meta?: boolean }) => void;
  onPasteAfter: (afterCellId: string) => void;
  onPasteAt: (trackId: string, atMs: number) => void;
}) {
  const doc = useDoc();
  const store = useDocStore();
  const { FRAME_W, ROW_H } = useSheetGrid(step);
  const [renaming, setRenaming] = React.useState(false);
  /*
   * ONE framing for the whole row. A row of cells is an ANIMATION — you read it
   * by seeing the same subject move — so framing each cell on its own content
   * would destroy the one thing the strip exists to show. Memoised on the row's
   * cell ids and the doc, because it reads pixels (`surfaceInk`).
   */
  const surfaceTick = useSurfaceTick();
  const focus = React.useMemo(
    () => rowFocusBox(doc, row, flipbook),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, row.track.id, row.cells.map((c) => c.id).join(), flipbook.id, surfaceTick],
  );

  const addCellAt = (ms: number) => {
    let created: { clip: Clip } | null = null;
    store.update("Add frame", (d) => {
      created = addFlipbookCellAt(d, flipbook.id, row.track.id, ms);
    });
    focusCreatedCell(store, created);
  };

  // Void slots — every frame index across the sheet's allocated length that
  // this row doesn't already cover (`rowCellAt` already accounts for the
  // row's own loop mode, so a looping row's ghost-covered positions never
  // register as void). Always-visible, addressable empty canvas, Dreams-style.
  const totalFrames = Math.max(1, Math.round(endMs / step));
  const voidSlots: number[] = [];
  for (let i = 0; i < totalFrames; i++) {
    const ms = i * step;
    if (!rowCellAt(doc, flipbook.id, row, ms)) voidSlots.push(ms);
  }

  // Ghost repeats: exactly how the row's loop plays out across the sheet —
  // downed-opacity previews in a virtual container, so a 3-frame loop READS
  // as filling the whole flipbook. Ping-pong mirrors odd cycles.
  const ghosts: Array<{ cell: Clip; leftMs: number }> = [];
  const span = row.span;
  if (span && row.track.loop !== "none") {
    const len = span.endMs - span.startMs;
    if (len > 0) {
      let cursor = span.endMs;
      let cycle = 1;
      while (cursor < endMs && cycle < 40) {
        const reversed = row.track.loop === "pingpong" && cycle % 2 === 1;
        for (const cell of row.cells) {
          const relStart = cell.startMs - span.startMs;
          const relEnd = relStart + cell.durationMs;
          const leftMs = cursor + (reversed ? len - relEnd : relStart);
          if (leftMs < endMs) ghosts.push({ cell, leftMs });
        }
        cursor += len;
        cycle++;
      }
    }
  }

  return (
    <div className="flex border-b border-line" style={{ height: ROW_H }}>
      {/* Row header (sticky left). */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            data-no-marquee
            className="sticky left-0 z-10 flex w-40 shrink-0 items-center gap-1.5 border-r bg-panel px-2"
            style={row.track.color ? { boxShadow: `inset 3px 0 0 ${row.track.color}` } : undefined}
          >
            {renaming ? (
              <RenameInput
                initial={row.track.name}
                className="h-5 w-full rounded border bg-background px-1 text-xs"
                onCommit={(name) => {
                  setRenaming(false);
                  if (name.trim()) {
                    store.update("Rename row", (d) => {
                      const t = d.tracks.find((x) => x.id === row.track.id);
                      if (t) t.name = name.trim();
                    });
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-xs text-foreground"
                onDoubleClick={() => setRenaming(true)}
              >
                {row.track.name}
              </button>
            )}
            {/* The SAME loop control as the sheet's and the timeline's. Three
                copies of this button had drifted to three different ideas of
                what "play once" looks like. */}
            <LoopToggle
              label="Row"
              mode={row.track.loop}
              onChange={(next) =>
                store.update("Row loop mode", (d) => {
                  const t = d.tracks.find((x) => x.id === row.track.id);
                  if (t) t.loop = next;
                })
              }
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem onClick={() => setRenaming(true)}>Rename row</ContextMenuItem>
          {(["none", "loop", "pingpong"] as const).map((mode) => (
            <ContextMenuItem
              key={mode}
              onClick={() =>
                store.update("Row loop mode", (d) => {
                  const t = d.tracks.find((x) => x.id === row.track.id);
                  if (t) t.loop = mode;
                })
              }
            >
              {LOOP_LABEL[mode]}
              {row.track.loop === mode && <span className="ml-auto text-[10px]">✓</span>}
            </ContextMenuItem>
          ))}
          <ContextMenuSeparator />
          {["#E5484D", "#F5B843", "#30A46C", "#5B9CF6", "#B18CFF"].map((c) => (
            <ContextMenuItem
              key={c}
              onClick={() =>
                store.update("Row color", (d) => {
                  const t = d.tracks.find((x) => x.id === row.track.id);
                  if (t) t.color = t.color === c ? null : c;
                })
              }
            >
              <span className="size-3 rounded-full" style={{ backgroundColor: c }} /> Color
            </ContextMenuItem>
          ))}
          <ContextMenuSeparator />
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => deleteFlipbookRow(store, row.track.id, flipbook.id)}
          >
            <Trash2 /> Delete row
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Cells */}
      <div className="relative" style={{ width: (endMs / step) * FRAME_W + FRAME_W * 2 }}>
        {/* Void slots — background layer, addressable-but-empty frame slots.
            One primitive replaces the old single trailing "+" button: every
            gap AND the run of slots past the last cell render the same way. */}
        {/* Void slots describe the RESTING grid. While a drag is live the cells
            are mid-glide and a dashed placeholder under a moving one reads as a
            second, contradictory answer about where things are — so the sheet
            shows one answer at a time. */}
        {!dragPreview && voidSlots.map((ms) => (
          <VoidSlot
            key={ms}
            flipbook={flipbook}
            trackId={row.track.id}
            ms={ms}
            step={step}
            selectedCellIds={selectedCellIds}
            onAdd={() => addCellAt(ms)}
            onPaste={() => onPasteAt(row.track.id, ms)}
          />
        ))}
        {ghosts.map((g, i) => (
          <GhostCell key={`${g.cell.id}:${i}`} cell={g.cell} doc={doc} leftMs={g.leftMs} step={step} focus={focus} />
        ))}
        {row.cells.map((cell) => (
          <SheetCell
            key={cell.id}
            flipbook={flipbook}
            allCells={allCells}
            cell={cell}
            step={step}
            selected={cell.id === activeCellId || selectedCellIds.has(cell.id)}
            selectedCellIds={selectedCellIds}
            current={cell.id === activeCellId}
            onionMarks={onionMarks}
            locked={isClipLocked(row.track, cell)}
            dragPreviewPx={
              dragPreview?.kind === "move" && dragPreview.ids.has(cell.id) ? dragPreview.deltaPx : null
            }
            gestureTarget={dragPreview?.ids.has(cell.id) ?? false}
            copyPreview={(dragPreview?.ids.has(cell.id) && dragPreview.copy) ?? false}
            plannedStartMs={dragPreview?.plan.starts.get(cell.id) ?? null}
            plannedDurationMs={dragPreview?.plan.durations.get(cell.id) ?? null}
            onDragPreview={onDragPreview}
            onSelect={() => onSelect(cell)}
            onOpen={() => onOpen(cell)}
            onSelectMods={(mods) => onSelectMods(cell.id, mods)}
            onPasteAfter={() => onPasteAfter(cell.id)}
            focus={focus}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One empty, addressable frame slot — Dreams' "the sheet is always there"
 * canvas. Near-invisible dashed outline at rest (reads as "nothing here yet"
 * without competing with real cells), a "+" fades in on hover. Click scrubs
 * the playhead here (focusable — arrows/scrub land on empty time with no
 * special-casing, exactly like a real frame); right-click adds a frame.
 */
function VoidSlot({
  flipbook,
  trackId,
  ms,
  step,
  selectedCellIds,
  onAdd,
  onPaste,
}: {
  flipbook: Frame;
  trackId: string;
  ms: number;
  step: number;
  /** The sheet's current multi-selection — right-clicking a void (or
   *  anywhere else empty) shows the SAME batch actions as right-clicking one
   *  of the selected cells, without disturbing the selection. */
  selectedCellIds: ReadonlySet<string>;
  onAdd: () => void;
  onPaste: () => void;
}) {
  const store = useDocStore();
  const { FRAME_W, ROW_H } = useSheetGrid(step);
  const clipboardMode = useFlipbookClipboard((s) => s.mode);
  const selected = useSession(
    (s) =>
      s.selectedFlipbookVoid?.flipbookId === flipbook.id &&
      s.selectedFlipbookVoid?.trackId === trackId &&
      s.selectedFlipbookVoid?.ms === ms,
  );
  const select = () => {
    const session = useSession.getState();
    // ONE verb: seek to this slot in sheet time, dropping whatever cell was
    // drilled (a void has no cell of its own to stay focused on) — then mark
    // the slot, which must come after the deselect that clears it.
    session.seekIn(flipbook.id, ms, { deselect: true });
    session.setSelectedFlipbookVoid({ flipbookId: flipbook.id, trackId, ms });
  };
  // Click once to select/focus this slot (and scrub there); click it AGAIN
  // (already selected) to commit — adds a frame right on the spot, same
  // gesture as "Add frame here" without leaving the keyboard/mouse flow.
  const onClick = () => (selected ? onAdd() : select());

  const selectionIds = [...selectedCellIds];
  // Void space has no cell of its own to scope to — nothing selected means
  // "tidy the whole sheet"; a real selection still only closes gaps between
  // those cells (same as right-clicking one of them).
  const removeGaps = () =>
    store.update("Remove gaps", (d) => {
      if (selectionIds.length === 0) void removeAllFlipbookGaps(d, flipbook.id);
      else void removeGapsBetweenSelected(d, flipbook.id, selectionIds);
    });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Empty frame ${Math.round(ms / step) + 1}`}
          data-marquee-click-through
          onClick={onClick}
          className={cn(
            "group absolute top-1.5 flex items-center justify-center rounded-(--r-sm) border border-dashed transition-colors hover:border-foreground/40 hover:bg-hover",
            selected ? "border-primary bg-selection" : "border-line",
          )}
          style={{ left: (ms / step) * FRAME_W + 1, width: FRAME_W - 2, height: ROW_H - 12 }}
        >
          <Plus className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={onAdd}>
          <Plus /> Add frame here
        </ContextMenuItem>
        <ContextMenuItem disabled={!clipboardMode} onClick={onPaste}>
          <ClipboardPaste /> Paste here
        </ContextMenuItem>
        {selectionIds.length > 0 && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => copyFlipbookCells(selectionIds)}>
              <ClipboardCopy /> Copy {selectionIds.length > 1 ? `${selectionIds.length} frames` : "frame"}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => cutFlipbookCells(selectionIds)}>
              <Scissors /> Cut {selectionIds.length > 1 ? `${selectionIds.length} frames` : "frame"}
            </ContextMenuItem>
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => deleteFlipbookCells(store, selectionIds)}
            >
              <Trash2 /> Delete {selectionIds.length > 1 ? `${selectionIds.length} frames` : "frame"}
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={removeGaps}>
          <FoldHorizontal /> Remove gaps
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function GhostCell({
  cell,
  doc,
  leftMs,
  step,
  focus,
}: {
  cell: Clip;
  doc: MotionDocument;
  leftMs: number;
  step: number;
  focus: FocusBox | null;
}) {
  const { FRAME_W, ROW_H } = useSheetGrid(step);
  const source = cellDrawing(doc, cell);
  if (!source) return null;
  return (
    <div
      className="pointer-events-none absolute top-1.5 overflow-hidden rounded-(--r-sm) border border-line opacity-30"
      style={{ left: (leftMs / step) * FRAME_W + 1, width: (cell.durationMs / step) * FRAME_W - 2, height: ROW_H - 12 }}
    >
      <CompThumb frameId={source.id} className="h-full w-full object-contain" focus={focus} />
    </div>
  );
}

function SheetCell({
  flipbook,
  allCells,
  cell,
  step,
  selected,
  selectedCellIds,
  current,
  onionMarks,
  locked,
  dragPreviewPx,
  copyPreview,
  plannedStartMs,
  plannedDurationMs,
  gestureTarget,
  onDragPreview,
  onSelect,
  onOpen,
  onSelectMods,
  onPasteAfter,
  focus,
}: {
  flipbook: Frame;
  /** Every cell across every row — a selected GROUP drag can span rows, so a
   *  mover's origin position may live outside this cell's own row. */
  allCells: readonly Clip[];
  cell: Clip;
  step: number;
  selected: boolean;
  /** The sheet's free multi-selection (resolved to cell ids) — drives the
   *  context menu's "act on the whole selection" and its count label. */
  selectedCellIds: ReadonlySet<string>;
  /** THE cell a stroke lands on (drilled into, or under the playhead). */
  current: boolean;
  onionMarks: OnionMarks;
  locked: boolean;
  /** Non-null while THIS cell is one of the ones in your hand — its
   *  un-quantised translateX in px (no document write yet). */
  dragPreviewPx: number | null;
  /** ⌥ held during this drag → show the duplicate affordance on the ghost. */
  copyPreview: boolean;
  /** Where the live plan puts this cell — null when nothing is being dragged.
   *  A DISPLACED cell (one the plan pushes aside) glides here; a cell in your
   *  hand ignores it and rides `dragPreviewPx` instead. */
  plannedStartMs: number | null;
  /** Where the live plan puts this cell's LENGTH — a trim grip in flight. */
  plannedDurationMs: number | null;
  /**
   * This cell is one the live gesture ACTS on, rather than one it displaces.
   * The distinction is what decides whether it eases: a displaced cell gliding
   * out of the way is the whole point, and a cell whose own edge you are
   * holding must track the cursor with no lag at all.
   */
  gestureTarget: boolean;
  onDragPreview: (preview: SheetDrag | null) => void;
  onSelect: () => void;
  onOpen: () => void;
  onSelectMods: (mods: { shift?: boolean; meta?: boolean }) => void;
  onPasteAfter: () => void;
  /** The ROW's framing — shared by every cell so the strip reads as motion. */
  focus: FocusBox | null;
}) {
  const doc = useDoc();
  const store = useDocStore();
  const { FRAME_W, ROW_H } = useSheetGrid(step);
  const source = cellDrawing(doc, cell);
  const onionMark = source ? onionMarks.get(source.id) : undefined;
  const hold = cellFrameCount(doc, flipbook, cell);
  const cutPending = useFlipbookClipboard((s) => s.mode === "cut" && s.cellIds.includes(cell.id));
  const clipboardMode = useFlipbookClipboard((s) => s.mode);

  /** The ids a copy/cut act on: the whole multi-selection when this cell is
   *  part of one, else just this cell — Figma's "right-click inside a
   *  selection keeps it" convention. */
  const menuCellIds = selectedCellIds.size > 1 && selectedCellIds.has(cell.id) ? [...selectedCellIds] : [cell.id];

  const duplicate = () => {
    let copyClip: Clip | null = null;
    store.update("Duplicate frame", (d) => {
      const result = duplicateFlipbookCell(d, cell.id);
      if (result) {
        copyClip = result.clip;
        for (const copy of result.surfaceCopies) {
          const src = d.tracks
            .flatMap((t) => t.clips)
            .find((c) => c.kind === "raster" && c.surfaceId === copy.to);
          if (src?.kind === "raster") cloneSurfacePixels(copy.from, copy.to, src.width, src.height);
        }
      }
    });
    // The copy takes the spotlight — select it and park the playhead on it.
    if (copyClip) {
      const c = copyClip as Clip;
      const session = useSession.getState();
      session.select([c.id]);
      session.setPlayhead(c.startMs);
    }
  };

  const remove = () => deleteFlipbookCells(store, menuCellIds);

  const selectMirrors = () => {
    const twins = mirrorSiblings(store.getState(), cell.id).map((c) => c.id);
    if (twins.length > 0) useSession.getState().select(twins);
  };

  const copyCells = () => copyFlipbookCells(menuCellIds);
  const cutCells = () => cutFlipbookCells(menuCellIds);

  /**
   * BODY DRAG. A click selects; a real drag re-plans on every move and the
   * sheet renders that plan — the cells you are pushing glide aside and a gap
   * opens under your hand — then release applies the same plan.
   *
   * One implementation, so the preview cannot promise something the drop does
   * not do. What was here instead: a pure-visual ghost that nothing else
   * reacted to, and then a release that chose between two unrelated placement
   * rules depending on how many cells were selected.
   *
   * A group may span ANY rows: `planFlipbookCellDrag` plans each row on its
   * own, because a mover in row A can never collide with one in row B.
   */
  const onBodyPointerDown = (e: React.PointerEvent) => {
    if (locked || e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const groupIds =
      selectedCellIds.size > 1 && selectedCellIds.has(cell.id) ? [...selectedCellIds] : [cell.id];
    const groupIdSet = new Set(groupIds);
    const origins = new Map(groupIds.map((id) => [id, allCells.find((c) => c.id === id)?.startMs ?? cell.startMs]));
    capturePointer(el, e.pointerId);
    /*
     * A FINGER MUST MEAN IT. The threshold used to be a flat 4px for every
     * pointer, which is right for a mouse and far too eager for a finger: any
     * touch that brushed the sheet came away holding a frame, and moving
     * through the sheet rearranged the animation. `beginHeldDrag` gives a
     * finger a brief pause plus a wider slop and leaves mouse and pen exactly
     * as they were — the same rule, in one place, for every surface that grows
     * a draggable next.
     */
    /*
     * A FINGER MUST MEAN IT, and it must mean THIS.
     *
     * `axis: "x"` is what tells the gesture scope which way this drag reads, so
     * a vertical swipe across the sheet is handed straight back to the scroller
     * instead of being spent arming a cell move. The sheet scrolls both ways,
     * so a horizontal drag still `defer`s behind a brief pause — which is the
     * rule that keeps "I was moving through the timeline" from coming away
     * holding a frame. Mouse and pen are untouched.
     */
    const arm = beginHeldDrag(e, { axis: "x" });
    let dragging = false;
    let clonedIds: string[] | null = null;
    const move = (ev: PointerEvent) => {
      if (!arm.update(ev.clientX, ev.clientY)) return;
      // Travel since the drag ARMED. Measuring from the press point instead
      // hands the gesture its whole recognition slop on the first move, and
      // the cell leaps that far the instant it is picked up.
      const deltaX = arm.delta(ev.clientX, ev.clientY).x;
      dragging = true;
      // ⌥ is read LIVE on every move (and again at release) — the Figma feel:
      // hold ⌥ → duplicate mode, let go → plain move, press again → duplicate.
      // The decision is never latched, so it always matches the current finger.
      const copy = ev.altKey;
      onDragPreview({
        kind: "move",
        ids: groupIdSet,
        deltaPx: deltaX,
        copy,
        // The SAME call the release makes. Recomputing it per move is what lets
        // the sheet show the answer instead of promising one.
        plan: planFlipbookCellDrag(store.getState(), flipbook.id, groupIds, (deltaX / FRAME_W) * step, {
          copy,
        }),
      });
    };
    const commit = (ev: PointerEvent) => {
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        /* the pointer was already retired */
      }
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      // `pointercancel` is not optional: touch cancels constantly, and a
      // teardown that only listens for `pointerup` leaks its move listener for
      // the rest of the session — which on this sheet meant cells that kept
      // following a finger that had long since left the glass.
      el.removeEventListener("pointercancel", up);
      onDragPreview(null);
      // A cancel, or a gesture a second finger took over (a pinch-zoom of the
      // sheet), commits nothing — the cell goes back where it was.
      if (ev.type === "pointercancel" || arm.abandoned()) return;
      if (!dragging) {
        if (ev.shiftKey || ev.metaKey || ev.ctrlKey) onSelectMods({ shift: ev.shiftKey, meta: ev.metaKey || ev.ctrlKey });
        else onSelect();
        return;
      }
      const copy = ev.altKey;
      const deltaMs = (arm.delta(ev.clientX, ev.clientY).x / FRAME_W) * step;

      /*
       * THE DROP IS THE PLAN. Re-planned once here against the live document
       * (a stroke or an undo may have landed mid-drag) and then simply applied
       * — every rule about pushing, gaps and clamping already ran when the
       * sheet drew it. There is no second placement algorithm to disagree with
       * the one you have been watching for the last half second.
       */
      store.update(
        copy ? (groupIds.length > 1 ? "Duplicate frames" : "Duplicate frame") : groupIds.length > 1 ? "Move frames" : "Move frame",
        (d) => {
          const plan = planFlipbookCellDrag(d, flipbook.id, groupIds, deltaMs, { copy });
          applyFlipbookDragPlan(d, plan);
          if (!copy) return;
          // ⌥-DROP = duplicate-and-place (Figma): the plan has already opened
          // the room, so the clones land in it through the SAME clipboard
          // primitive as copy/paste (own layers + pixel copies) — a cell is
          // only ever cloned one way.
          const trackId = d.tracks.find((t) => t.clips.some((c) => c.id === cell.id))?.id;
          if (!trackId) return;
          const dropMs = Math.max(0, origins.get(cell.id)! + plan.deltaMs);
          const placed = pasteFlipbookCellsAt(d, flipbook.id, groupIds, trackId, dropMs, "copy");
          if (!placed) return;
          for (const c of placed.surfaceCopies) {
            const src = d.tracks.flatMap((t) => t.clips).find((x) => x.kind === "raster" && x.surfaceId === c.to);
            if (src?.kind === "raster") cloneSurfacePixels(c.from, c.to, src.width, src.height);
          }
          clonedIds = placed.clipIds;
        },
      );
      if (clonedIds) useSession.getState().select(clonedIds);
    };
    // Last, not first: the release still has to ask the arm where the gesture
    // began, and `end` retires it.
    const up = (ev: PointerEvent) => {
      try {
        commit(ev);
      } finally {
        arm.end();
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  /**
   * MAY THIS POINTER TRIM AN UNSELECTED CELL?
   *
   * The rule is about VISIBILITY, not about touch. The grips are revealed by
   * selection OR by hover — so a mouse and a pen can always see the edge they
   * are about to grab, and refusing them was making a desktop user select a
   * cell before they could trim it while the grip sat lit under the cursor.
   *
   * A finger has no hover. On an unselected cell its grips are invisible, and a
   * gesture you cannot see is a gesture you trigger by accident — which is
   * exactly the "I was scrolling and it retimed my animation" report. So touch
   * still trims only what is selected, and every pointer that can see the grip
   * may pull it.
   */
  const mayTrim = (e: React.PointerEvent) => !locked && (selected || e.pointerType !== "touch");

  /**
   * THE TRIM GRIPS — both edges, through the same plan-then-commit the body
   * drag uses.
   *
   * They used to write the DOCUMENT on every pointer move, through
   * `trimFlipbookCellStart` / `setCellHoldFrames` with a history merge key.
   * That is an immer patch, a history entry and a re-render of the sheet, the
   * stage and the inspector PER POINTER EVENT — at 120Hz on a laptop it is the
   * whole of why trimming felt like it was lagging behind the cursor and
   * fighting itself. Now the drag is arithmetic and the write happens once.
   *
   * `edge` is the only difference between the two grips, so there is one
   * handler rather than two that drift.
   */
  const onTrimDown = (edge: "start" | "hold") => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (!mayTrim(e)) return;
    const el = e.currentTarget as HTMLElement;
    capturePointer(el, e.pointerId);
    // A trim is meaningful while stationary — finger on the edge, then push —
    // so it owns the hold and the long-press menu stands down. A cell's BODY
    // drag deliberately does not (see `beginHeldDrag`): holding a cell still
    // opens its menu.
    claimPointer(e.pointerId, "hold");
    const startX = e.clientX;
    // A selected GROUP resizes together by the same frame delta, each in its
    // own row — "works the same whether it's one cell or several".
    const ids =
      edge === "hold" && selectedCellIds.size > 1 && selectedCellIds.has(cell.id)
        ? [...selectedCellIds]
        : [cell.id];
    const idSet = new Set(ids);
    const move = (ev: PointerEvent) => {
      const deltaMs = ((ev.clientX - startX) / FRAME_W) * step;
      onDragPreview({
        kind: "resize",
        ids: idSet,
        deltaPx: 0,
        copy: false,
        plan: planFlipbookCellResize(store.getState(), flipbook.id, ids, edge, deltaMs),
      });
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      onDragPreview(null);
      if (ev.type === "pointercancel") return; // abort, never commit
      const deltaMs = ((ev.clientX - startX) / FRAME_W) * step;
      store.update(edge === "start" ? "Trim frame" : ids.length > 1 ? "Frame holds" : "Frame hold", (d) =>
        void applyFlipbookDragPlan(d, planFlipbookCellResize(d, flipbook.id, ids, edge, deltaMs)),
      );
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const onStartEdgeDown = onTrimDown("start");

  /** The right grip: the hold, in frames. Same handler, same plan, same one
   *  write on release — see `onTrimDown`. */
  const onEdgeDown = onTrimDown("hold");

  // ⌥-drag = DUPLICATE: the original holds its slot and a translucent GHOST
  // rides the pointer (so both are visible, live), which means no cell is "in
  // hand" during a copy — the originals are ordinary push candidates like
  // everyone else, and the plan may well displace them.
  const inHand = dragPreviewPx != null && !copyPreview;
  const displaced = (plannedStartMs != null || plannedDurationMs != null) && !gestureTarget;
  /*
   * A CELL MOVES ONCE. It is laid out at its PLANNED slot and stays still, or
   * it is laid out at its OWN slot and rides the pointer — never both.
   *
   * It used to do both: a cell in your hand is also a mover in the plan, so it
   * was positioned at the quantised place the drop would put it AND then
   * translated by the raw pointer travel on top of that. Drag it one frame
   * right and it went two. Between frames it slid at some fraction of twice
   * your hand's speed, which is the whole of "the cells jump and it feels
   * unpredictable" — the sheet was showing the pointer's answer and the plan's
   * answer added together.
   */
  const cellLeft = (((inHand ? null : plannedStartMs) ?? cell.startMs) / step) * FRAME_W + 1;
  const cellWidth = ((plannedDurationMs ?? cell.durationMs) / step) * FRAME_W - 2;
  const cellHeight = ROW_H - 12;
  const moveTranslate = inHand ? `translateX(${dragPreviewPx}px)` : undefined;

  return (
    <>
      {copyPreview && dragPreviewPx != null && (
        <div
          className="pointer-events-none absolute top-1.5 z-20 overflow-hidden rounded-(--r-sm) border border-primary/70 bg-background/70 opacity-85 shadow-lg ring-2 ring-primary/40"
          style={{
            // The ghost hangs off the cell's OWN slot, never its planned one —
            // during a ⌥-drag the original stays put and it is the copy that
            // travels, so anchoring to a plan that may have pushed the original
            // aside would send the ghost somewhere nobody pointed at.
            left: (cell.startMs / step) * FRAME_W + 1,
            width: cellWidth,
            height: cellHeight,
            transform: `translateX(${dragPreviewPx}px)`,
          }}
        >
          {source && <CompThumb frameId={source.id} className="h-full w-full object-contain" focus={focus} />}
          <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[11px] font-bold leading-none text-primary-foreground shadow">
            +
          </span>
        </div>
      )}
      <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-cell-id={cell.id}
          title={cell.name}
          onPointerDown={onBodyPointerDown}
          onDoubleClick={onOpen}
          onContextMenu={() => {
            // Figma convention: right-clicking a cell already IN the current
            // multi-selection keeps it; right-clicking outside it replaces the
            // selection with just this cell (no drilling — a right-click never
            // navigates).
            if (!selected) useSession.getState().select([cell.id]);
          }}
          className={cn(
            // Same rule as a timeline clip, and for the same reason: a swipe
            // across the sheet scrolls it, a brief hold then drags the cell.
            // That is `beginHeldDrag` below, and it only works if the browser
            // still has a scroll to be handed back — so no `touch-action` here.
            //
            // Three states, one grammar with the clips: the CURRENT cell (the
            // one the pen hits) wears the accent ring, the selection is an
            // accent EDGE on the selection wash, the rest sit on `--line`.
            "group absolute top-1.5 overflow-hidden rounded-(--r-sm) border transition-[box-shadow,border-color]",
            HELD_DRAG_SURFACE,
            locked ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing",
            current
              ? "border-primary bg-background/60 ring-2 ring-primary ring-offset-1 ring-offset-panel"
              : selected
                ? "border-primary bg-selection"
                : "border-line bg-background/60 hover:border-foreground/30",
            locked && "opacity-60",
            cutPending && "opacity-40",
            // Only the MOVE drag lifts/dims the cell; a duplicate-drag leaves the
            // original crisp in place (the ghost is what moves).
            inHand && "z-10 opacity-80 shadow-lg",
          )}
          style={{
            left: cellLeft,
            width: cellWidth,
            height: cellHeight,
            transform: moveTranslate,
            transition: displaced ? REFLOW_TRANSITION : undefined,
          }}
        >
          {source && <CompThumb frameId={source.id} className="h-full w-full object-contain" focus={focus} />}
          {onionMark && (
            // The onion skin, shown where you plan it: a ghosted neighbour
            // carries its ghost's tint as a foot bar and a faint wash, fading
            // with distance exactly as the ghost does on the stage.
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background: `linear-gradient(to top, ${onionMark.color} 0 3px, color-mix(in oklab, ${onionMark.color} 16%, transparent) 3px)`,
                opacity: 0.3 + 0.7 * onionMark.strength,
              }}
            />
          )}
          <span className="absolute bottom-0.5 left-1 rounded bg-background/70 px-1 text-[9px] text-muted-foreground">
            {hold > 1 ? `×${hold}` : ""}
          </span>
          {/*
            TRIM GRIPS — start (left) and hold (right), and deliberately the
            SAME object as a timeline clip's: shown when the cell is SELECTED,
            hover for a mouse, grab zone from `--hit-grip` so it is finger-sized
            on a tablet while the mark stays small. A control revealed only by
            hover does not exist on a touch device, which is why trimming a cell
            was reachable there only by guessing where an invisible 6px strip
            was. Two panels, one grammar — learn it once.
          */}
          {!locked && (
            <>
              <div
                title="Trim start"
                onPointerDown={onStartEdgeDown}
                className={cn(
                  "group/edge absolute inset-y-0 left-0 cursor-ew-resize touch-none transition-opacity",
                  "w-(--hit-grip)",
                  selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
              >
                <div
                  className={cn(
                    "absolute inset-y-2 left-0.5 w-1 rounded-full transition-colors group-hover/edge:bg-primary",
                    selected ? "bg-primary" : "bg-foreground/50",
                  )}
                />
              </div>
              <div
                title="Hold — drag to add or remove frames"
                onPointerDown={onEdgeDown}
                className={cn(
                  "group/edge absolute inset-y-0 right-0 cursor-ew-resize touch-none transition-opacity",
                  "w-(--hit-grip)",
                  selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
              >
                <div
                  className={cn(
                    "absolute inset-y-2 right-0.5 w-1 rounded-full transition-colors group-hover/edge:bg-primary",
                    selected ? "bg-primary" : "bg-foreground/50",
                  )}
                />
              </div>
            </>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={onOpen}>Open drawing</ContextMenuItem>
        <ContextMenuItem onClick={duplicate}>
          <Copy /> Duplicate frame
        </ContextMenuItem>
        <ContextMenuItem onClick={selectMirrors}>Select matching layers</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={copyCells}>
          <ClipboardCopy /> Copy {menuCellIds.length > 1 ? `${menuCellIds.length} frames` : "frame"}
        </ContextMenuItem>
        <ContextMenuItem onClick={cutCells}>
          <Scissors /> Cut {menuCellIds.length > 1 ? `${menuCellIds.length} frames` : "frame"}
        </ContextMenuItem>
        <ContextMenuItem disabled={!clipboardMode} onClick={onPasteAfter}>
          <ClipboardPaste /> Paste after
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() =>
            store.update("Remove gaps", (d) => void removeGapsBetweenSelected(d, flipbook.id, menuCellIds))
          }
        >
          <FoldHorizontal /> Remove gaps
        </ContextMenuItem>
        <ContextMenuSeparator />
        <div className="flex items-center justify-between px-2 py-1 text-xs">
          <span className="text-muted-foreground">Hold</span>
          <NumberInput
            value={hold}
            min={1}
            max={999}
            precision={0}
            unit="f"
            className="w-16"
            onChange={(v) => store.update("Frame hold", (d) => void setCellHoldFrames(d, cell.id, v))}
          />
        </div>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-destructive focus:text-destructive" onClick={remove}>
          <Trash2 /> Delete frame
        </ContextMenuItem>
      </ContextMenuContent>
      </ContextMenu>
    </>
  );
}
