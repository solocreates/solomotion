"use client";

import * as React from "react";
import { locateClip, type Clip } from "@solomotion/core";
import { ChevronDown, ChevronRight, Eye, EyeOff, SlidersHorizontal, Spline } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { createPlayheadMover } from "./playhead-motion";
import { registerKeyframeSurface } from "../state/keyframe-surface";
import { usePanelFocus } from "../state/panel-focus";
import { timeToPx } from "./timeline-utils";
import { HeaderGroup, HeaderSegment } from "./header-controls";
import { useTimeSurface } from "./use-time-surface";
import { useGraphEditor } from "./graph-editor";
import { drawnTimeWidth, timelineView, useClientWidth } from "./timeline-view";
import { beginPlayheadScrub, SCRUB_SURFACE } from "./scrub";
import { CurvesSurface } from "./CurvesPanel";
import { buildDopeRows, DopeSurface, DOPE_ROW_H, type DopeRow } from "./DopeSheetPanel";
import { mergedPropertyGroups } from "./property-groups";
import { timelineSpanMs } from "./timeline-utils";
import { activeCompId } from "./time-axes";
import { timeAxis } from "./view-axes";
import { TimeZoomMenu } from "./TimeZoomBar";
import { ZoomBar } from "../workspace/ZoomBar";
import { scrollAxis } from "../workspace/view-axis";
import { capturePointer } from "../input/capture-pointer";
import { subscribePointerEnd } from "../input/pointer-gestures";

const MIN_VALUE_ZOOM = 0.25;
const MAX_VALUE_ZOOM = 3;

/**
 * The graph panel — curves + dope sheet living natively UNDER the timeline
 * (not floating over its lanes). Left column = the property tree, sharing the
 * exact width of the timeline's track headers (one resizable seam for both);
 * right viewport = the graph, scroll-X LOCKED to the timeline so time always
 * lines up, with its own scroll-Y. The playhead continues straight through.
 *
 * Curves mode: the tree toggles per-property visibility (eye) — groups named
 * like the inspector ("Shadow · X", not a bare "X"). Dope mode: the tree IS
 * the row list (clip → group → property), collapsible per group, aligned
 * 1:1 with the diamond lanes on the right.
 */

export type GraphTab = "curves" | "keys";

const HEADER_H = 32;
const SCRUB_H = 16;
/** The zoom row under the graph (magnifier + time bar). */
const ZOOM_ROW_H = 24;
const DEFAULT_PANEL_HEIGHT = 208;
const MIN_PANEL_HEIGHT = 120;
const MAX_PANEL_HEIGHT = 720;
const HEIGHT_KEY = "tm-curves-height";

function loadPanelHeight(): number {
  if (typeof window === "undefined") return DEFAULT_PANEL_HEIGHT;
  const v = Number(window.localStorage.getItem(HEIGHT_KEY));
  return Number.isFinite(v) && v >= MIN_PANEL_HEIGHT
    ? Math.min(MAX_PANEL_HEIGHT, v)
    : DEFAULT_PANEL_HEIGHT;
}

export function GraphPanel({
  tab,
  onTabChange,
  pxPerSec,
  spanMs,
  headerW,
  fill,
}: {
  tab: GraphTab;
  onTabChange: (tab: GraphTab) => void;
  pxPerSec: number;
  spanMs: number;
  /** Width of the timeline's track-header column — ours matches exactly. */
  headerW: number;
  /** True when this is the ONLY surface in the bottom slot (the lanes are
   *  hidden), in which case it takes the whole slot instead of its own
   *  remembered height and a drag handle for a sibling that isn't there. */
  fill?: boolean;
}) {
  const doc = useDoc();
  const selectedIds = useSession((s) => s.selectedClipIds);
  const { bind: focusBind } = usePanelFocus("curves");
  const [panelH, setPanelH] = React.useState(loadPanelHeight);
  const [hiddenProps, setHiddenProps] = React.useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set());
  const [valueZoom, setValueZoom] = React.useState(1);
  const leftRef = React.useRef<HTMLDivElement>(null);
  const viewRef = React.useRef<HTMLDivElement>(null);
  // Same rule as the lanes (`drawnTimeWidth`), against this viewport.
  const contentWidth = drawnTimeWidth(spanMs, pxPerSec, useClientWidth(viewRef));
  const scrollAreaRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const bandRef = React.useRef<HTMLDivElement>(null);

  // Clips in the selection, in document (track) order.
  const clips = React.useMemo(() => {
    const out: Clip[] = [];
    for (const track of doc.tracks) {
      for (const c of track.clips) if (selectedIds.includes(c.id)) out.push(c);
    }
    return out;
  }, [doc, selectedIds]);
  const primary = clips[0] ?? null;

  // The zoom bars: time is the timeline's own axis (one position for every
  // time surface); the dope sheet's rows are a plain scroll.
  const activeFrameId = useSession((s) => s.activeFrameId);
  const spanRef = React.useRef(0);
  spanRef.current = timelineSpanMs(doc, activeCompId(doc, activeFrameId));
  const timeAx = React.useMemo(() => timeAxis(() => spanRef.current), []);
  const rowsAx = React.useMemo(() => scrollAxis(() => scrollAreaRef.current, "y"), []);
  const xMarkers = React.useMemo(() => clips.map((c) => ({ start: c.startMs, size: c.durationMs })), [clips]);

  // Curves tree lists the UNION of every selected clip's properties — "Opacity"
  // once, even when several layers animate it — so the whole selection is
  // editable together, mirroring the dope sheet's multi-clip rows.
  const groups = React.useMemo(() => mergedPropertyGroups(clips), [clips]);
  const dopeRows = React.useMemo(
    () => (tab === "keys" ? buildDopeRows(clips, collapsed) : []),
    [tab, clips, collapsed],
  );

  // Filling the slot means the height comes from the parent, not from the
  // remembered panel height — measured so the graph body still knows its size.
  const bodyH = panelH - HEADER_H - ZOOM_ROW_H;
  const hasContent = tab === "curves" ? groups.length > 0 : dopeRows.length > 0;

  // Publish what's VISIBLE so ⌘A honours the same hide/collapse filters the eye
  // sees. Curves shows only the primary clip (filtered by the hidden props);
  // the dope sheet shows every selected clip's uncollapsed rows.
  React.useEffect(() => {
    return registerKeyframeSurface({
      visibleKeyIds(scope) {
        if (!primary) return [];
        if (tab === "curves") {
          // Curves now span every selected clip; ⌘A honours the same hide
          // filter the eyes toggle. "primary" scope stays on the lead layer.
          const ids: string[] = [];
          for (const c of clips) {
            if (scope === "primary" && c.id !== primary.id) continue;
            for (const tr of c.keyframes) {
              if (tr.range || tr.keys.length === 0 || hiddenProps.has(tr.property)) continue;
              for (const k of tr.keys) ids.push(k.id);
            }
          }
          return ids;
        }
        const ids: string[] = [];
        for (const row of dopeRows) {
          if (row.kind !== "prop") continue;
          if (scope === "primary" && row.clip.id !== primary.id) continue;
          for (const k of row.item.track.keys) ids.push(k.id);
        }
        return ids;
      },
    });
  }, [tab, primary, clips, hiddenProps, dopeRows]);

  // The graph never scrolls horizontally — it MIRRORS the timeline's single
  // scroll position by transform, so the two playheads can't drift out of one
  // line. This follower slides the content + scrub band as the shared S moves.
  const applyFollow = React.useCallback((s: number) => {
    const t = `translateX(${-s}px)`;
    if (contentRef.current) contentRef.current.style.transform = t;
    if (bandRef.current) bandRef.current.style.transform = t;
  }, []);
  React.useEffect(() => timelineView.registerFollower(applyFollow), [applyFollow]);

  // Re-sync the freshly-mounted content/band to the LIVE scroll position. The
  // follower only fires on scroll CHANGES; when the graph body first mounts
  // (focusing a clip that finally has keyframes) its refs were null at
  // registration, so without this the curves sit at translateX(0) — stuck at
  // time 0 — until the next pan/zoom nudges them into place.
  React.useLayoutEffect(() => {
    applyFollow(timelineView.scrollLeft());
  }, [applyFollow, primary?.id, hasContent, tab]);

  // Zoom clamps to the SELECTED CLIP's span (+10% breathing room), so the view
  // stays on the clip instead of drifting into empty time.
  const clipRangeMs = React.useMemo(() => {
    if (!primary) return { startMs: 0, endMs: 1 };
    const pad = primary.durationMs * 0.1;
    return { startMs: primary.startMs - pad, endMs: primary.startMs + primary.durationMs + pad };
  }, [primary]);
  // The curve editor is a time surface like the lanes and the sheet, so it gets
  // its gestures from the same hook: ⌘/pinch zooms time, ⌥ zooms the value
  // axis, two fingers pinch and pan. It had the wheel half only, which meant
  // the one panel where you most need to zoom in on a single keyframe was the
  // one you could not zoom with your fingers.
  const surface = useTimeSurface(viewRef, {
    onZoomTime: (factor, centerX) => timelineView.zoom(centerX, factor, clipRangeMs),
    onZoomRows: (factor) =>
      setValueZoom((z) => Math.min(MAX_VALUE_ZOOM, Math.max(MIN_VALUE_ZOOM, z * factor))),
    // The curve view is a transformed world, not a scroller: `timelineView`
    // owns the horizontal position and the graph reads it, so the pan drives
    // that axis directly. Scrolling this element instead would move nothing
    // horizontally and desync the playhead from the lanes.
    onPan: (dx, dy) => {
      timelineView.panBy(dx);
      if (viewRef.current) viewRef.current.scrollTop -= dy;
    },
    surface: "canvas",
  });

  return (
    <div
      {...focusBind}
      className={cn("relative flex flex-col border-t bg-panel", fill ? "h-full" : "shrink-0")}
      style={fill ? undefined : { height: panelH }}
    >
      {/* The handle resizes this against the LANES. With no lanes there is
          nothing to resize against — the slot's own divider does that job. */}
      {!fill && <HeightHandle height={panelH} onResize={setPanelH} />}

      {/* Header strip — tabs always live top-left, never vertically centered. */}
      <div className="flex shrink-0 items-center gap-2 border-b px-2" style={{ height: HEADER_H }}>
        <div className="flex-1" />
      </div>

      {!primary || !hasContent ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4">
          <p className="text-xs text-muted-foreground/70">
            {!primary ? "No layer selected" : "No keyframes yet"}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Property tree — same width as the timeline's track headers. */}
          <div
            ref={leftRef}
            className="shrink-0 overflow-hidden border-r bg-panel"
            style={{ width: headerW }}
            onWheel={(e) => {
              // Dope mode: the tree mirrors the graph's vertical scroll.
              if (tab === "keys" && scrollAreaRef.current) scrollAreaRef.current.scrollTop += e.deltaY;
            }}
          >
            {tab === "curves" ? (
              <CurvesTree groups={groups} hiddenProps={hiddenProps} onToggle={setHiddenProps} />
            ) : (
              <DopeTree rows={dopeRows} collapsed={collapsed} onCollapse={setCollapsed} />
            )}
          </div>

          {/* Graph viewport — NO horizontal scroll of its own: its content is
              positioned by transform from the timeline's single scroll value,
              so its playhead is always in one line with the timeline's. Own
              vertical scroll; a horizontal wheel is forwarded to the timeline. */}
          <div
            ref={viewRef}
            className={cn("relative min-w-0 flex-1 overflow-hidden", surface.className)}
            onWheel={(e) => {
              if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
                timelineView.panBy(e.deltaX);
              }
            }}
          >
            {/* Vertical scroll area; content slides horizontally by transform. */}
            <ScrollArea
              viewportRef={scrollAreaRef}
              // `scroll` does not bubble, so the lane list on the left can only
              // be kept in step from the viewport itself.
              viewportProps={{
                onScroll: () => {
                  if (leftRef.current && scrollAreaRef.current)
                    leftRef.current.scrollTop = scrollAreaRef.current.scrollTop;
                },
              }}
              className="absolute inset-x-0"
              bars={false}
              style={{ top: SCRUB_H, bottom: 0 }}
            >
              <div
                ref={contentRef}
                className="relative will-change-transform"
                style={{
                  width: contentWidth,
                  height:
                    tab === "keys"
                      ? Math.max(dopeRows.length * DOPE_ROW_H, bodyH - 2 - SCRUB_H)
                      : bodyH - 2 - SCRUB_H,
                }}
              >
                {tab === "curves" ? (
                  <CurvesSurface
                    clip={primary}
                    clips={clips}
                    pxPerSec={pxPerSec}
                    height={bodyH - 2 - SCRUB_H}
                    valueZoom={valueZoom}
                    hiddenProps={hiddenProps}
                  />
                ) : (
                  <DopeSurface rows={dopeRows} pxPerSec={pxPerSec} />
                )}
              </div>
            </ScrollArea>

            {/* Scrub band — pinned at the top (never scrolls vertically),
                slides horizontally with the content. A timeline handle just
                like the ruler up top. */}
            <div className="absolute inset-x-0 top-0 overflow-hidden" style={{ height: SCRUB_H }}>
              <GraphScrubBand ref={bandRef} pxPerSec={pxPerSec} width={contentWidth} />
            </div>

            {/* Playhead — a viewport overlay at (playheadPx − S), spanning the
                band + graph, exactly under the timeline's playhead. */}
            <GraphPlayhead pxPerSec={pxPerSec} contentRef={contentRef} />

          </div>
          {tab === "keys" && (
            <ZoomBar
              axis={rowsAx}
              orientation="y"
              label="Rows — scroll"
              className="w-3.5 shrink-0 border-l border-line"
              style={{ marginTop: SCRUB_H }}
            />
          )}
        </div>
      )}
      {primary && hasContent && (
        <div className="flex shrink-0 items-center border-t border-line" style={{ height: ZOOM_ROW_H }}>
          <div className="flex shrink-0 items-center px-1" style={{ width: headerW }}>
            <TimeZoomMenu
              time={timeAx}
              values={
                tab === "curves"
                  ? { value: valueZoom, min: MIN_VALUE_ZOOM, max: MAX_VALUE_ZOOM, onChange: setValueZoom }
                  : undefined
              }
            />
          </div>
          <ZoomBar axis={timeAx} orientation="x" label="Time — scroll and zoom" markers={xMarkers} playhead className="mx-2.5 h-full flex-1" />
          {tab === "keys" && <div className="w-3.5 shrink-0" />}
        </div>
      )}
    </div>
  );
}

/** Drag handle on the panel's top edge — grow the graph as big as you like. */
function HeightHandle({ height, onResize }: { height: number; onResize: (h: number) => void }) {
  const latest = React.useRef(height);
  latest.current = height;
  return (
    <div
      className="absolute inset-x-0 top-0 z-30 h-1.5 -translate-y-1/2 cursor-ns-resize transition-colors hover:bg-primary/40"
      onPointerDown={(e) => {
        e.preventDefault();
        capturePointer((e.currentTarget as Element), e.pointerId);
        const startY = e.clientY;
        const startH = latest.current;
        const onMove = (ev: PointerEvent) => {
          onResize(Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, startH + (startY - ev.clientY))));
        };
        // One subscription covers release, cancel, a lost pointer and the
        // second finger of a pinch — this listened for `pointerup` alone.
        const off = subscribePointerEnd((id) => {
          if (id !== e.pointerId) return;
          off();
          window.removeEventListener("pointermove", onMove);
          try {
            window.localStorage.setItem(HEIGHT_KEY, String(latest.current));
          } catch {
            // Persistence is best-effort.
          }
        });
        window.addEventListener("pointermove", onMove);
      }}
    />
  );
}

/** The playhead's continuation through the graph — same transform-subscription
 *  pattern as the timeline's Playhead (no React re-render per frame). */
function GraphPlayhead({
  pxPerSec,
  contentRef,
}: {
  pxPerSec: number;
  contentRef: React.RefObject<HTMLDivElement | null>;
}) {
  const store = useDocStore();
  const ref = React.useRef<HTMLDivElement>(null);
  // Position at (playheadPx − S) so it sits under the timeline's playhead, and
  // re-apply on BOTH playhead changes and scroll (the shared S moving).
  React.useEffect(() => {
    // Running, the compositor carries it (see `playhead-motion.ts`).
    const mover = createPlayheadMover();
    const apply = () => {
      const el = ref.current;
      if (!el) return;
      const s = useSession.getState();
      mover.place(el, timeToPx(s.playheadMs, pxPerSec) - timelineView.scrollLeft(), s.playing);
    };
    apply();
    const offSession = useSession.subscribe(apply);
    const offView = timelineView.registerFollower(() => apply());
    return () => {
      offSession();
      offView();
      mover.dispose();
    };
  }, [pxPerSec]);
  return (
    <div ref={ref} className="pointer-events-none absolute inset-y-0 z-20 will-change-transform" style={{ left: 0 }}>
      <div className="absolute inset-y-0 w-px bg-primary/80" />
      {/* Draggable head — scrubs the shared playhead. Anchored to the content
          origin (which carries the −S transform) so the time mapping is right. */}
      <div
        className={cn(
          "pointer-events-auto absolute -left-1.25 top-0 h-3 w-2.75 cursor-col-resize rounded-b-sm bg-primary",
          SCRUB_SURFACE,
        )}
        onPointerDown={(e) => {
          e.stopPropagation();
          if (contentRef.current) beginPlayheadScrub(e, store, pxPerSec, contentRef.current);
        }}
      />
    </div>
  );
}

/** The graph's scrub band — a content-width strip (slid horizontally with the
 *  content) you click/drag to move the playhead, the curve-panel equivalent of
 *  the timeline ruler. */
const GraphScrubBand = React.forwardRef<HTMLDivElement, { pxPerSec: number; width: number }>(
  function GraphScrubBand({ pxPerSec, width }, ref) {
    const store = useDocStore();
    return (
      <div
        ref={ref}
        className={cn(
          "h-full cursor-col-resize border-b border-border/40 bg-panel/70 will-change-transform",
          SCRUB_SURFACE,
        )}
        style={{ width }}
        onPointerDown={(e) => beginPlayheadScrub(e, store, pxPerSec)}
      />
    );
  },
);

// ── Left trees ────────────────────────────────────────────────────────────────

function CurvesTree({
  groups,
  hiddenProps,
  onToggle,
}: {
  groups: ReturnType<typeof mergedPropertyGroups>;
  hiddenProps: Set<string>;
  onToggle: (next: Set<string>) => void;
}) {
  const toggle = (props: string[], hide: boolean) => {
    const next = new Set(hiddenProps);
    for (const p of props) {
      if (hide) next.add(p);
      else next.delete(p);
    }
    onToggle(next);
  };
  return (
    <ScrollArea className="h-full" viewportClassName="py-1">
      {groups.map((g) => {
        const allHidden = g.items.every((i) => hiddenProps.has(i.property));
        return (
          <div key={g.id}>
            <button
              type="button"
              onClick={() => toggle(g.items.map((i) => i.property), !allHidden)}
              className="flex h-5 w-full items-center gap-1 px-2 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/80 hover:text-foreground"
              title={allHidden ? "Show group" : "Hide group"}
            >
              {g.label}
            </button>
            {g.items.map((it) => {
              const off = hiddenProps.has(it.property);
              return (
                <button
                  key={it.property}
                  type="button"
                  onClick={() => toggle([it.property], !off)}
                  className={cn(
                    "flex h-5.5 w-full items-center gap-1.5 px-2 pl-3.5 text-[10px] transition-colors hover:bg-muted/40",
                    off ? "text-muted-foreground/50" : "text-foreground/90",
                  )}
                >
                  <span
                    className={cn("size-2 shrink-0 rounded-full", off && "opacity-30")}
                    style={{ backgroundColor: it.color }}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">{it.label}</span>
                  {off ? (
                    <EyeOff className="size-2.5 shrink-0 opacity-50" />
                  ) : (
                    <Eye className="size-2.5 shrink-0 opacity-50" />
                  )}
                </button>
              );
            })}
          </div>
        );
      })}
    </ScrollArea>
  );
}

function DopeTree({
  rows,
  collapsed,
  onCollapse,
}: {
  rows: DopeRow[];
  collapsed: Set<string>;
  onCollapse: (next: Set<string>) => void;
}) {
  return (
    <div className="relative">
      {rows.map((row, i) => (
          <div
            key={row.id}
            className={cn(
              "absolute inset-x-0 flex items-center gap-1 border-b border-border/40 px-2 text-[10px]",
              row.kind === "clip" && "bg-muted/40 font-semibold",
              row.kind === "group" && "bg-muted/15 text-muted-foreground",
              row.kind === "prop" && "pl-6 text-muted-foreground",
            )}
            style={{ top: i * DOPE_ROW_H, height: DOPE_ROW_H }}
          >
            {row.kind === "clip" && <span className="truncate">{row.clip.name}</span>}
            {row.kind === "group" && (
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1 pl-2 hover:text-foreground"
                onClick={() => {
                  const next = new Set(collapsed);
                  if (next.has(row.id)) next.delete(row.id);
                  else next.add(row.id);
                  onCollapse(next);
                }}
              >
                {row.collapsed ? <ChevronRight className="size-2.5" /> : <ChevronDown className="size-2.5" />}
                <span className="truncate">{row.group.label}</span>
              </button>
            )}
            {row.kind === "prop" && (
              <>
                <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: row.item.color }} />
                <span className="truncate">{row.item.label}</span>
              </>
            )}
        </div>
      ))}
      {/* Spacer so absolute rows own their height. */}
      <div style={{ height: rows.length * DOPE_ROW_H }} />
    </div>
  );
}
