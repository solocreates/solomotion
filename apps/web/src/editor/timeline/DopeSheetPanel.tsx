"use client";

import * as React from "react";
import {
  locateClip,
  mergeCoincidentKeyframes,
  moveKeyframe,
  setKeyframe,
  type Clip,
  type Easing,
  type Keyframe,
  frameStepMs,
} from "@solomotion/core";
import { EasingCurve } from "@/components/ui/easing-editor";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { KeyframeMenuItems } from "./keyframe-menu";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { useSweepSelect, rectSweepAllowed } from "../state/use-sweep-select";
import { useEditingFps } from "../state/use-fps";
import { timeToPx, pxToTime } from "./timeline-utils";
import { createKeyframeSnapper } from "./keyframe-snap";
import { KeyframeAnimBar } from "./KeyframeAnimBar";
import { propertyGroupsFor, type PropGroup, type PropItem } from "./property-groups";
import { capturePointer } from "../input/capture-pointer";
import { beginHeldDrag } from "../input/hold-to-drag";
import { subscribePointerEnd } from "../input/pointer-gestures";

/**
 * The dope-sheet SURFACE — diamond rows on the shared timeline scale, fed the
 * SAME row list the GraphPanel's left column renders, so labels and lanes
 * align by construction. Selection is session.selectedKeyframeIds (shared
 * with the curves surface and clip lanes): E, copy/cut/paste, ⌫ and ⌘A all
 * behave identically everywhere.
 *
 *   click        select · ⇧click adds · marquee on empty space
 *   drag         move keys (never merges mid-drag; collapses once on drop)
 *   ⌥drag        duplicate the selection, then drag the copies
 *   clip/group ◆ a MEGA key — drags every property's key at that instant
 *   ⟋ chip       the easing between two keys — click opens the easing editor
 *   ←→           nudge one frame (⇧ ×10) · ⌫ delete · Esc clear
 */

export const DOPE_ROW_H = 22;

export type DopeRow =
  | { kind: "clip"; clip: Clip; id: string }
  | { kind: "group"; clip: Clip; group: PropGroup; id: string; collapsed: boolean }
  | { kind: "prop"; clip: Clip; item: PropItem; id: string };

/** Flatten selected clips into aligned rows (shared by left tree + surface). */
export function buildDopeRows(clips: Clip[], collapsed: Set<string>): DopeRow[] {
  const rows: DopeRow[] = [];
  for (const clip of clips) {
    const groups = propertyGroupsFor(clip);
    if (groups.length === 0) continue;
    rows.push({ kind: "clip", clip, id: clip.id });
    for (const group of groups) {
      const gid = `${clip.id}/${group.id}`;
      const isCollapsed = collapsed.has(gid);
      rows.push({ kind: "group", clip, group, id: gid, collapsed: isCollapsed });
      if (!isCollapsed) {
        for (const item of group.items) {
          rows.push({ kind: "prop", clip, item, id: `${gid}/${item.property}` });
        }
      }
    }
  }
  return rows;
}

/** Unique key times (±0.5ms buckets) across a set of tracks — mega keys. */
function clusterTimes(items: Array<{ track: { keys: Keyframe[] } }>): Array<{ timeMs: number; keyIds: string[] }> {
  const clusters: Array<{ timeMs: number; keyIds: string[] }> = [];
  for (const it of items) {
    for (const k of it.track.keys) {
      const hit = clusters.find((c) => Math.abs(c.timeMs - k.timeMs) < 0.5);
      if (hit) hit.keyIds.push(k.id);
      else clusters.push({ timeMs: k.timeMs, keyIds: [k.id] });
    }
  }
  return clusters.sort((a, b) => a.timeMs - b.timeMs);
}

export function DopeSurface({
  rows,
  pxPerSec,
}: {
  rows: DopeRow[];
  pxPerSec: number;
}) {
  const doc = useDoc();
  const store = useDocStore();
  // The sheet's frame grid belongs to the comp being edited (see use-fps).
  const fps = useEditingFps();
  const selectedKfIds = useSession((s) => s.selectedKeyframeIds);
  const selected = React.useMemo(() => new Set(selectedKfIds), [selectedKfIds]);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = React.useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  /*
   * The Keyframes sheet's lasso — the panel this was missed on entirely first
   * time round, because "Curves" and "Keyframes" are both surfaces of
   * `GraphPanel` and only the curve half got wired.
   *
   * Same shape as the lanes and the board: the model-based rect sweep below
   * stays the mouse gesture, the lasso is the touch/pen route, and
   * `lasso.armed` decides between them before either can start.
   */
  const lassoBase = React.useRef<string[]>([]);
  const lasso = useSweepSelect(wrapRef, "data-kf-id", {
    onDragStart: (additive) => {
      lassoBase.current = additive ? useSession.getState().selectedKeyframeIds : [];
    },
    onSweep: (ids) =>
      useSession.getState().setSelectedKeyframes([...new Set([...lassoBase.current, ...ids])]),
    onClear: () => useSession.getState().setSelectedKeyframes([]),
  });

  const clips = React.useMemo(() => {
    const seen = new Set<string>();
    const out: Clip[] = [];
    for (const r of rows) {
      if (!seen.has(r.clip.id)) {
        seen.add(r.clip.id);
        out.push(r.clip);
      }
    }
    return out;
  }, [rows]);

  const frameMs = frameStepMs(fps);
  const xOf = (clip: Clip, timeMs: number) => timeToPx(clip.startMs + timeMs, pxPerSec);

  /** Origin map for a drag: keyId → { clipId, t }. */
  const originsFor = (ids: Iterable<string>): Map<string, { clipId: string; t: number }> => {
    const idSet = new Set(ids);
    const origins = new Map<string, { clipId: string; t: number }>();
    const dNow = store.getState();
    for (const cl of clips) {
      const live = locateClip(dNow, cl.id);
      if (!live) continue;
      for (const tr of live.clip.keyframes) {
        for (const k of tr.keys) if (idSet.has(k.id)) origins.set(k.id, { clipId: cl.id, t: k.timeMs });
      }
    }
    return origins;
  };

  const moveBy = (
    origins: Map<string, { clipId: string; t: number }>,
    dMs: number,
    mergeKey: string,
    merge: boolean,
  ) =>
    store.update(
      "Move keyframes",
      (d) => {
        for (const [id, o] of origins) {
          const loc = locateClip(d, o.clipId);
          if (!loc) continue;
          moveKeyframe(loc.clip.keyframes, id, Math.max(0, Math.min(loc.clip.durationMs, o.t + dMs)), {
            merge,
          });
        }
      },
      { mergeKey },
    );

  /** Drop-commit: collapse coincident keys once, inside the same undo step. */
  const commitMerge = (origins: Map<string, { clipId: string; t: number }>, mergeKey: string) => {
    const byClip = new Map<string, Set<string>>();
    for (const [id, o] of origins) {
      let s = byClip.get(o.clipId);
      if (!s) byClip.set(o.clipId, (s = new Set()));
      s.add(id);
    }
    store.update(
      "Move keyframes",
      (d) => {
        for (const [clipId, ids] of byClip) {
          const loc = locateClip(d, clipId);
          if (loc) mergeCoincidentKeyframes(loc.clip.keyframes, ids);
        }
      },
      { mergeKey },
    );
  };

  const clipStartOf = (clipId: string) => clips.find((c) => c.id === clipId)?.startMs ?? 0;

  /** Pointer-drag a set of key ids (diamond or mega-key gesture). */
  const startDrag = (e: React.PointerEvent, ids: string[], anchorAbsMs: number) => {
    capturePointer((e.currentTarget as Element), e.pointerId);
    const origins = originsFor(ids);
    if (origins.size === 0) return;
    const selfAbs = [...origins.values()].map((o) => clipStartOf(o.clipId) + o.t);
    const snapper = createKeyframeSnapper(store, pxPerSec, selfAbs);
    /*
     * The sheet scrolls sideways and a key drags sideways, so the scope decides
     * — a swipe moves through the sheet, a brief hold takes the key — instead of
     * this private 3px threshold, which handed a keyframe to any finger that
     * brushed past. It is also what makes the drag abandon the instant a second
     * finger lands, so pinching to zoom no longer retimes whatever key was
     * under the anchoring finger.
     */
    const arm = beginHeldDrag(e, { axis: "x" });
    let base = e.clientX;
    const mergeKey = `dope-drag-${e.pointerId}`;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!arm.update(ev.clientX, ev.clientY)) return;
      if (!moved) {
        moved = true;
        // Rebase, so the travel spent earning the gesture is not also retimed.
        base = ev.clientX;
      }
      const raw = pxToTime(ev.clientX - base, pxPerSec);
      const dMs = snapper.snapDelta(anchorAbsMs, raw, ev.metaKey || ev.ctrlKey);
      moveBy(origins, dMs, mergeKey, false);
    };
    const off = subscribePointerEnd((id, reason) => {
      if (id !== e.pointerId) return;
      arm.end();
      snapper.end();
      off();
      window.removeEventListener("pointermove", onMove);
      // A drag the sheet took, or a pointer that never came back, commits
      // nothing: the merge is dropped rather than written.
      if (moved && reason === "up" && !arm.abandoned()) commitMerge(origins, mergeKey);
    });
    window.addEventListener("pointermove", onMove);
  };

  const onDiamondDown = (e: React.PointerEvent, clip: Clip, key: Keyframe) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    wrapRef.current?.focus();
    const anchorAbsMs = clip.startMs + key.timeMs;
    const session = useSession.getState();
    let ids: string[];
    if (e.shiftKey) {
      const next = new Set(session.selectedKeyframeIds);
      if (next.has(key.id)) next.delete(key.id);
      else next.add(key.id);
      ids = [...next];
    } else if (selected.has(key.id)) {
      ids = session.selectedKeyframeIds;
    } else {
      ids = [key.id];
    }
    session.setSelectedKeyframes(ids);

    // ⌥ duplicates the selection first, then the drag moves the copies.
    if (e.altKey) {
      const dupIds: string[] = [];
      store.update("Duplicate keyframes", (d) => {
        const idSet = new Set(ids);
        for (const cl of clips) {
          const live = locateClip(d, cl.id);
          if (!live) continue;
          for (const tr of live.clip.keyframes) {
            for (const k of [...tr.keys]) {
              if (!idSet.has(k.id)) continue;
              const nk = setKeyframe(live.clip.keyframes, tr.property, k.timeMs, k.value, k.easing, tr.range);
              dupIds.push(nk.id);
            }
          }
        }
      });
      if (dupIds.length === 0) return;
      useSession.getState().setSelectedKeyframes(dupIds);
      ids = dupIds;
    }
    startDrag(e, ids, anchorAbsMs);
  };

  /** Mega key: select + drag every key of the cluster together. */
  const onClusterDown = (e: React.PointerEvent, clip: Clip, timeMs: number, keyIds: string[]) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    wrapRef.current?.focus();
    const session = useSession.getState();
    const ids = e.shiftKey ? [...new Set([...session.selectedKeyframeIds, ...keyIds])] : keyIds;
    session.setSelectedKeyframes(ids);
    startDrag(e, ids, clip.startMs + timeMs);
  };

  /** Marquee on empty space — hit-tests prop-row diamonds by geometry. */
  const onBodyDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // One predicate, shared with every other marquee in the app: a finger and a
    // pen scroll, and an armed lasso owns the pointer outright.
    if (!rectSweepAllowed(e)) return;
    if (!(e.target as HTMLElement).dataset.dopeRows) return;
    wrapRef.current?.focus();
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const x0 = e.clientX - rect.left;
    const y0 = e.clientY - rect.top;
    if (!e.shiftKey) useSession.getState().setSelectedKeyframes([]);
    setMarquee({ x0, y0, x1: x0, y1: y0 });
    capturePointer(el, e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const x1 = ev.clientX - rect.left;
      const y1 = ev.clientY - rect.top;
      setMarquee({ x0, y0, x1, y1 });
      const [ly, hy] = [Math.min(y0, y1), Math.max(y0, y1)];
      const [lx, hx] = [Math.min(x0, x1), Math.max(x0, x1)];
      const ids: string[] = [];
      rows.forEach((row, i) => {
        if (row.kind !== "prop") return;
        const cy = i * DOPE_ROW_H + DOPE_ROW_H / 2;
        if (cy < ly || cy > hy) return;
        for (const k of row.item.track.keys) {
          const kx = xOf(row.clip, k.timeMs);
          if (kx >= lx && kx <= hx) ids.push(k.id);
        }
      });
      useSession.getState().setSelectedKeyframes(ids);
    };
    // Release, cancel, a lost pointer, and the second finger of a pinch — the
    // marquee had none of them but the first.
    const off = subscribePointerEnd((id) => {
      if (id !== e.pointerId) return;
      off();
      setMarquee(null);
      window.removeEventListener("pointermove", onMove);
    });
    window.addEventListener("pointermove", onMove);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && selectedKfIds.length) {
      useSession.getState().setSelectedKeyframes([]);
      e.stopPropagation();
      return;
    }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && selectedKfIds.length) {
      e.preventDefault();
      e.stopPropagation();
      const step = (e.key === "ArrowLeft" ? -1 : 1) * frameMs * (e.shiftKey ? 10 : 1);
      moveBy(originsFor(selectedKfIds), step, "dope-nudge", true);
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* minHeight fills the viewport so marquee works in the empty space
            BELOW the rows too, not just on the row lanes themselves. */}
        <div
          ref={wrapRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          className={cn("relative outline-none", lasso.surfaceClassName)}
          data-dope-rows="1"
          onPointerDown={(e) => {
            lasso.onPointerDown(e);
            onBodyDown(e);
          }}
          style={{ height: rows.length * DOPE_ROW_H, minHeight: "100%" }}
        >
          {lasso.marqueeNode}
      {rows.map((row, i) => {
        const clipX = timeToPx(row.clip.startMs, pxPerSec);
        const clipW = timeToPx(row.clip.durationMs, pxPerSec);
        const isHeader = row.kind !== "prop";
        return (
          <div
            key={row.id}
            data-dope-rows="1"
            className={cn(
              "absolute inset-x-0 border-b border-border/40",
              row.kind === "clip" && "bg-muted/40",
              row.kind === "group" && "bg-muted/15",
            )}
            style={{ top: i * DOPE_ROW_H, height: DOPE_ROW_H }}
          >
            {/* The clip's span, so keys read against their home range. */}
            <div
              className="pointer-events-none absolute inset-y-0 bg-primary/5"
              style={{ left: clipX, width: clipW }}
            />

            {/* Animation clip bar — move / scale the whole layer's keyframes. */}
            {row.kind === "clip" && (
              <KeyframeAnimBar clips={clips} clip={row.clip} pxPerSec={pxPerSec} top={3} height={DOPE_ROW_H - 6} />
            )}

            {row.kind === "prop" && (
              <PropRowKeys
                row={row}
                selected={selected}
                xOf={xOf}
                onDiamondDown={onDiamondDown}
              />
            )}

            {isHeader &&
              clusterTimes(row.kind === "clip" ? propertyGroupsFor(row.clip).flatMap((g) => g.items) : row.group.items).map(
                (c) => {
                  const allSel = c.keyIds.every((id) => selected.has(id));
                  return (
                    <div
                      key={`${row.id}-${Math.round(c.timeMs)}`}
                      onPointerDown={(e) => onClusterDown(e, row.clip, c.timeMs, c.keyIds)}
                      onContextMenu={() => {
                        const session = useSession.getState();
                        if (!c.keyIds.every((id) => session.selectedKeyframeIds.includes(id))) {
                          session.setSelectedKeyframes(c.keyIds);
                        }
                      }}
                      title={`${c.keyIds.length} keyframes — drag to move together`}
                      className={cn(
                        "absolute top-1/2 size-2.25 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-ew-resize border",
                        allSel
                          ? "border-primary bg-primary"
                          : "border-foreground/60 bg-panel hover:border-primary hover:bg-primary/30",
                      )}
                      style={{ left: xOf(row.clip, c.timeMs) }}
                    />
                  );
                },
              )}
          </div>
        );
      })}

          {marquee && (
            <div
              className="pointer-events-none absolute z-30 border border-primary/70 bg-primary/10"
              style={{
                left: Math.min(marquee.x0, marquee.x1),
                top: Math.min(marquee.y0, marquee.y1),
                width: Math.abs(marquee.x1 - marquee.x0),
                height: Math.abs(marquee.y1 - marquee.y0),
              }}
            />
          )}
        </div>
      </ContextMenuTrigger>
      {/* The shared keyframe vocabulary — smart about the current selection:
          right-click a key to target it, or empty space to act on the set. */}
      <ContextMenuContent className="w-52">
        <KeyframeMenuItems store={store} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** One property row: connector lines with easing chips between keys, then diamonds. */
function PropRowKeys({
  row,
  selected,
  xOf,
  onDiamondDown,
}: {
  row: Extract<DopeRow, { kind: "prop" }>;
  selected: Set<string>;
  xOf: (clip: Clip, timeMs: number) => number;
  onDiamondDown: (e: React.PointerEvent, clip: Clip, key: Keyframe) => void;
}) {
  const keys = React.useMemo(
    () => [...row.item.track.keys].sort((a, b) => a.timeMs - b.timeMs),
    [row.item.track.keys],
  );
  const color = row.item.color;
  return (
    <>
      {/* Interpolation connectors — a line per segment, its easing as a chip. */}
      {keys.slice(0, -1).map((k0, i) => {
        const k1 = keys[i + 1]!;
        const x0 = xOf(row.clip, k0.timeMs);
        const x1 = xOf(row.clip, k1.timeMs);
        const w = x1 - x0;
        if (w < 6) return null;
        return (
          <React.Fragment key={`seg-${k0.id}`}>
            <div
              className="pointer-events-none absolute top-1/2 h-px -translate-y-1/2 opacity-40"
              style={{ left: x0 + 4, width: Math.max(0, w - 8), backgroundColor: color }}
            />
            {w >= 34 && (
              <EasingChip
                x={(x0 + x1) / 2}
                easing={k0.easing}
                onOpen={(sx, sy) => {
                  // Same dialog as the E shortcut, anchored at the chip — the
                  // segment's key becomes the selection it applies to.
                  useSession.getState().setSelectedKeyframes([k0.id]);
                  useSession.getState().setEasingPopoverAt({ x: sx, y: sy });
                }}
              />
            )}
          </React.Fragment>
        );
      })}
      {keys.map((k) => {
        const sel = selected.has(k.id);
        return (
          <div
            key={k.id}
            // The lasso finds keyframes through the DOM, same as every other
            // surface. This attribute is the whole integration.
            data-kf-id={k.id}
            onPointerDown={(e) => onDiamondDown(e, row.clip, k)}
            onContextMenu={() => {
              const session = useSession.getState();
              if (!session.selectedKeyframeIds.includes(k.id)) session.setSelectedKeyframes([k.id]);
            }}
            className={cn(
              "absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-ew-resize",
              sel ? "bg-primary ring-1 ring-primary/50" : "hover:bg-primary/80",
            )}
            style={{ left: xOf(row.clip, k.timeMs), backgroundColor: sel ? undefined : color }}
          />
        );
      })}
    </>
  );
}

/** The segment's easing as a tiny glassy chip — click opens the easing editor. */
function EasingChip({ x, easing, onOpen }: { x: number; easing: Easing; onOpen: (x: number, y: number) => void }) {
  return (
    <button
      type="button"
      title="Edit easing"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(e.clientX, e.clientY);
      }}
      className="absolute top-1/2 z-10 flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[5px] border border-border/70 bg-panel/95 text-muted-foreground shadow-sm transition-colors hover:border-primary/60 hover:text-primary"
      style={{ left: x }}
    >
      <EasingCurve easing={easing} className="size-3" />
    </button>
  );
}
